/*
 =============================================================================
 MODULE: backend/cajas.web.js
 VERSION: v5002.3-cajas-verifactu-canonical
 RESPONSIBILITY: TPV cashier ledger, daily closures (Arqueo X / Cierre Z),
                 Veri*factu SHA-256 chain integrity, fiscal persistence,
                 accounting projection, and M365 sync enqueue.
 STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 =============================================================================
 */
 import { webMethod, Permissions } from "wix-web-module";
 import wixData from "wix-data";
 import { getSecret } from "wix-secrets-backend";
 import {
   COLLECTIONS,
   SINGLETONS,
   SDK_CONFIG,
   TIPO_MOVIMIENTO,
   FORMA_PAGO,
   IVA_RATES,
   CAJA_STATUS,
 } from "backend/internalConfig";
 import { SECRETS } from "backend/mmSecrets";
 import { requireCajero, requireAdmin, rateLimiter } from "backend/security";
 import {
   hashSHA256,
   hashChain,
   hmacSha256Hex,
   timingSafeEqual,
 } from "backend/securityEngine";
 import {
   makeTraceId,
   _roundMoney,
   _safeTrim,
   _cleanText,
   _stableSerialize,
   _normalizeIdPart,
   _readDate,
   _readPositiveAmount,
   _readNonNegativeAmount,
 } from "public/mmUtils";
 import { logger, normalizeError } from "backend/booking/bookingCore";
 import { _toPublicError } from "backend/responseUtils";
 const log = logger;
 // ============================================================================
 // CONSTANTS
 // ============================================================================
 const CAJA_ACTUAL_ID = SINGLETONS?.CAJA || "CAJA_PRINCIPAL";
 const LEDGER_SCHEMA_VERSION = "LEDGER_V2";
 const INTEGRITY_ALGORITHM_VERSION = "HMAC_SHA256_V1";
 const GENESIS_HASH = "0".repeat(64);
 const MAX_LEDGER_BATCH_PAGES = 50;
 const LEDGER_PAGE_SIZE = 200;
 // ============================================================================
 // VALIDATION: FISCAL CONFIG
 // ============================================================================
 export async function validateFiscalConfig(traceId = "init") {
   const key = await getSecret(SECRETS.FISCAL_KEY).catch(() => "");
   const nif = await getSecret(SECRETS.FISCAL_NIF_EMISOR).catch(() => "");
   if (!key || key.length < 32) {
     log.error("CONFIGURACION_FISCAL_INVALIDA: Clave fiscal ausente o demasiado corta", { traceId });
     throw new Error("CONFIGURACION_FISCAL_INVALIDA");
   }
   if (!nif || nif.length < 9) {
     log.error("CONFIGURACION_FISCAL_INVALIDA: NIF emisor ausente o invalido", { traceId });
     throw new Error("CONFIGURACION_FISCAL_INVALIDA");
   }
   return true;
 }
 async function _getFiscalKeys(traceId) {
   const [key, nif] = await Promise.all([
     getSecret(SECRETS.FISCAL_KEY).catch(() => ""),
     getSecret(SECRETS.FISCAL_NIF_EMISOR).catch(() => ""),
   ]);
   if (!key || !nif) {
     throw new Error("CONFIGURACION_FISCAL_INVALIDA");
   }
   return { fiscalKey: key, businessTaxId: _safeTrim(nif).toUpperCase() };
 }
 // ============================================================================
 // RETRY WITH EXPONENTIAL BACKOFF
 // ============================================================================
 export async function executeLedgerWithBackoff(operationFn, maxWallTimeMs = 15000) {
   const start = Date.now();
   let attempt = 0;
   let lastErr;
   while (Date.now() - start < maxWallTimeMs && attempt < 5) {
     try {
       return await operationFn();
     } catch (err) {
       lastErr = err;
       attempt++;
       const wait = Math.min(200 * Math.pow(2, attempt), 2000) + Math.random() * 100;
       await new Promise((r) => setTimeout(r, wait));
     }
   }
   throw new Error(`LEDGER_TIMEOUT: Operacion supero el tiempo limite de ${maxWallTimeMs}ms (${lastErr?.message})`);
 }
 // ============================================================================
 // HASH CHAIN UTILITIES
 // ============================================================================
 function _buildLedgerPayload(mov) {
   return _stableSerialize({
     previousRecordHash: mov.previousRecordHash || GENESIS_HASH,
     sequenceNumber: mov.sequenceNumber || 0,
     invoiceNumber: mov.invoiceNumber || "",
     operationDate: mov.operationDate || "",
     movementType: mov.movementType || "",
     paymentMethod: mov.paymentMethod || "",
     totalAmount: Number(mov.totalAmount) || 0,
     taxableAmount: Number(mov.taxableAmount) || 0,
     taxAmount: Number(mov.taxAmount) || 0,
     taxRate: Number(mov.taxRate) || 0,
   });
 }
 function _computeCurrentHash(prevHash, payloadStr) {
   return hashChain(prevHash, payloadStr);
 }
 function _computeSignature(fiscalKey, currentHash, payloadStr) {
   const hmac = hmacSha256Hex(fiscalKey, currentHash);
   const payloadHash = hashSHA256(payloadStr);
   return `${hmac}|${payloadHash}`;
 }
 // ============================================================================
 // SEQUENCE COUNTER (ATOMIC)
 // ============================================================================
 async function _getNextSequence(traceId) {
   const seqCol = COLLECTIONS.SECUENCIA_TICKETS;
   return await executeLedgerWithBackoff(async () => {
     let seqDoc = await wixData.get(seqCol, "GLOBAL", { suppressAuth: true }).catch(() => null);
     if (!seqDoc) {
       seqDoc = {
         _id: "GLOBAL",
         sequenceCounters: { seqGlobal: 0 },
         _createdDate: new Date(),
         _updatedDate: new Date(),
       };
       await wixData.insert(seqCol, seqDoc, { suppressAuth: true });
     }
     const counters = seqDoc.sequenceCounters || {};
     const nextGlobal = Number(counters.seqGlobal || 0) + 1;
     const yearKey = String(new Date().getFullYear());
     const nextYear = Number(counters[yearKey] || 0) + 1;
     counters.seqGlobal = nextGlobal;
     counters[yearKey] = nextYear;
     seqDoc.sequenceCounters = counters;
     seqDoc._updatedDate = new Date();
     await wixData.update(seqCol, seqDoc, { suppressAuth: true });
     return {
       sequenceNumber: nextGlobal,
       yearSequence: nextYear,
       invoiceNumber: `FAC-${yearKey}-${String(nextYear).padStart(5, "0")}`,
     };
   });
 }
 // ============================================================================
 // GET LAST MOVEMENT (FOR HASH CHAIN)
 // ============================================================================
 async function _getLastMovement(traceId) {
   const res = await wixData
     .query(COLLECTIONS.MOVIMIENTOS_CAJA)
     .descending("registeredAt")
     .limit(1)
     .find({ suppressAuth: true });
   return res?.items?.[0] || null;
 }
 // ============================================================================
 // CORE: REGISTER MANUAL TRANSACTION
 // ============================================================================
 export const registerManualTransaction = webMethod(Permissions.SiteMember, async (payload) => {
   const traceId = payload?.traceId || makeTraceId("manual-tx");
   try {
     await requireCajero(traceId);
     await validateFiscalConfig(traceId);
     const { fiscalKey, businessTaxId } = await _getFiscalKeys(traceId);
     const amount = _readPositiveAmount(payload?.amount);
     if (!amount) {
       return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
     }
     const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase();
     if (!Object.values(FORMA_PAGO).includes(paymentMethod)) {
       return { status: "ERROR", data: null, error: { code: "INVALID_PAYMENT_METHOD", message: "Forma de pago invalida" } };
     }
     const movementType = _safeTrim(payload?.tipoMovimiento || payload?.movementType || "VENTA").toUpperCase();
     const concept = _cleanText(payload?.concept || payload?.description || "Venta mostrador", 500);
     const resourceId = _safeTrim(payload?.resourceId || "CAJA_LOCAL");
     return await executeLedgerWithBackoff(async () => {
       // 1. Get sequence
       const seq = await _getNextSequence(traceId);
       // 2. Get previous hash
       const lastMov = await _getLastMovement(traceId);
       const previousRecordHash = lastMov?.currentRecordHash || GENESIS_HASH;
       // 3. Calculate tax
       const taxRate = Number(payload?.taxRate) || IVA_RATES.GENERAL;
       const taxableAmount = _roundMoney(amount / (1 + taxRate));
       const taxAmount = _roundMoney(amount - taxableAmount);
       // 4. Build canonical payload
       const movBase = {
         sequenceNumber: seq.sequenceNumber,
         invoiceNumber: seq.invoiceNumber,
         operationDate: new Date().toISOString().slice(0, 10),
         fiscalPeriod: new Date().toISOString().slice(0, 7),
         movementType,
         operationNature: movementType === TIPO_MOVIMIENTO.REEMBOLSO ? "DEVOLUCION" : movementType === TIPO_MOVIMIENTO.PROPINA ? "PROPINA" : movementType === TIPO_MOVIMIENTO.AJUSTE ? "AJUSTE" : "VENTA",
         paymentMethod,
         totalAmount: amount,
         taxableAmount,
         taxAmount,
         taxRate,
         taxTreatment: movementType === TIPO_MOVIMIENTO.PROPINA ? "PROPINA_PENDIENTE_GESTORIA" : "IVA_GENERAL",
         accountingSign: movementType === TIPO_MOVIMIENTO.REEMBOLSO ? -1 : 1,
         accountingAmount: movementType === TIPO_MOVIMIENTO.REEMBOLSO ? -amount : amount,
         description: concept,
         lineItems: payload?.lineItems || [],
         rectifiedInvoiceReference: payload?.rectifiedInvoiceReference || null,
         businessTaxId,
         schemaIntegrityVersion: LEDGER_SCHEMA_VERSION,
         recordSource: payload?.origen || payload?.recordSource || "INTERNAL",
         resourceId,
         reservationIdLinked: payload?.reservationIdLinked || null,
         transactionId: payload?.transactionId || `TX_${seq.sequenceNumber}`,
         orderId: payload?.orderId || null,
         refundId: payload?.refundId || null,
       };
       // 5. Compute hash chain
       const payloadStr = _buildLedgerPayload(movBase);
       const currentRecordHash = _computeCurrentHash(previousRecordHash, payloadStr);
       const digitalSignature = _computeSignature(fiscalKey, currentRecordHash, payloadStr);
       // 6. Build final movement record
       const movimiento = {
         ...movBase,
         previousRecordHash,
         currentRecordHash,
         digitalSignature,
         registeredAt: new Date(),
         traceId,
         _createdDate: new Date(),
       };
       // 7. Insert movement
       const saved = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, movimiento, { suppressAuth: true });
       // 8. Update CajaActual singleton
       await _updateCajaActual(movimiento, traceId);
       // 9. Register system event (Veri*factu)
       await _registerSystemEvent(saved, traceId);
       // 10. Project to accounting (if enabled)
       if (SDK_CONFIG?.ACCOUNTING?.ENABLED) {
         await _projectToAccounting(saved, traceId).catch((e) => {
           log.error("Accounting projection failed (non-blocking)", { traceId, error: e?.message });
         });
       }
       // 11. Enqueue M365 sync (if enabled)
       if (SDK_CONFIG?.M365?.ENABLED) {
         await _enqueueM365Sync(saved, traceId).catch((e) => {
           log.error("M365 sync enqueue failed (non-blocking)", { traceId, error: e?.message });
         });
       }
       return { status: "SUCCESS", data: saved, error: null };
     });
   } catch (err) {
     const norm = normalizeError(err);
     log.error("registerManualTransaction failed", { code: norm.code, error: norm.message, traceId });
     return { status: "ERROR", data: null, error: { code: norm.code || "LEDGER_FAIL", message: norm.message } };
   }
 });
 // ============================================================================
 // UPDATE CAJA ACTUAL SINGLETON
 // ============================================================================
 async function _updateCajaActual(movimiento, traceId) {
   try {
     const cajaCol = COLLECTIONS.CAJA_ACTUAL;
     let caja = await wixData.get(cajaCol, CAJA_ACTUAL_ID, { suppressAuth: true }).catch(() => null);
     if (!caja) {
       caja = {
         _id: CAJA_ACTUAL_ID,
         operationDate: movimiento.operationDate,
         cashRegisterStatus: CAJA_STATUS.OPEN,
         totalBalance: 0,
         cashBalance: 0,
         cardBalance: 0,
         bizumBalance: 0,
         onlineBalance: 0,
         totalOperations: 0,
         openedAt: new Date(),
         closedAt: null,
         lastActivityAt: new Date(),
         _createdDate: new Date(),
         _updatedDate: new Date(),
       };
     }
     const amount = Number(movimiento.accountingAmount) || 0;
     const method = _safeTrim(movimiento.paymentMethod).toUpperCase();
     if (method === FORMA_PAGO.EFECTIVO) caja.cashBalance = _roundMoney((caja.cashBalance || 0) + amount);
     else if (method === FORMA_PAGO.TARJETA) caja.cardBalance = _roundMoney((caja.cardBalance || 0) + amount);
     else if (method === FORMA_PAGO.BIZUM) caja.bizumBalance = _roundMoney((caja.bizumBalance || 0) + amount);
     else if (method === FORMA_PAGO.ONLINE) caja.onlineBalance = _roundMoney((caja.onlineBalance || 0) + amount);
     caja.totalBalance = _roundMoney((caja.cashBalance || 0) + (caja.cardBalance || 0) + (caja.bizumBalance || 0) + (caja.onlineBalance || 0));
     caja.totalOperations = Number(caja.totalOperations || 0) + 1;
     caja.lastActivityAt = new Date();
     caja._updatedDate = new Date();
     await wixData.save(cajaCol, caja, { suppressAuth: true });
   } catch (err) {
     log.error("_updateCajaActual failed", { traceId, error: err?.message });
   }
 }
 // ============================================================================
 // REGISTER SYSTEM EVENT (Veri*factu)
 // ============================================================================
 async function _registerSystemEvent(movimiento, traceId) {
   try {
     const eventCol = COLLECTIONS.EVENTOS_SISTEMA_FACTURACION;
     const eventRecord = {
       _id: `EV_${movimiento.invoiceNumber}_${Date.now()}`,
       systemEventId: `EV_${movimiento.invoiceNumber}`,
       eventDateTime: new Date(),
       eventType: "LEDGER_MOVEMENT_REGISTERED",
       severity: "INFO",
       result: "SUCCESS",
       eventSource: "backend/cajas.web.js",
       responsibleUserId: null,
       responsibleMemberId: null,
       journalEntryId: null,
       transactionId: movimiento.transactionId || null,
       referenceId: movimiento.invoiceNumber,
       secureDetail: {
         previousRecordHash: movimiento.previousRecordHash,
         currentRecordHash: movimiento.currentRecordHash,
         digitalSignature: movimiento.digitalSignature,
         schemaIntegrityVersion: movimiento.schemaIntegrityVersion,
       },
       previousEventHash: null,
       eventHash: hashSHA256(`${movimiento.invoiceNumber}|${movimiento.currentRecordHash}`),
       eventSignature: null,
       systemVersion: LEDGER_SCHEMA_VERSION,
       schemaVersion: INTEGRITY_ALGORITHM_VERSION,
       traceId,
       _createdDate: new Date(),
     };
     await wixData.insert(eventCol, eventRecord, { suppressAuth: true });
   } catch (err) {
     log.error("_registerSystemEvent failed", { traceId, error: err?.message });
   }
 }
 // ============================================================================
 // PROJECT TO ACCOUNTING
 // ============================================================================
 async function _projectToAccounting(movimiento, traceId) {
   try {
     const asientosCol = COLLECTIONS.ASIENTOS_CONTABLES;
     const lineasCol = COLLECTIONS.LINEAS_ASIENTO_CONTABLE;
     const planCol = COLLECTIONS.PLAN_CUENTAS_CONTABLES;
     // Find account map for this movement type
     const mapRes = await wixData.query(planCol)
       .eq("operationCategory", movimiento.movementType)
       .eq("active", true)
       .limit(1)
       .find({ suppressAuth: true });
     const map = mapRes?.items?.[0];
     if (!map) {
       log.warn("No account map found for movement type", { movementType: movimiento.movementType, traceId });
       return;
     }
     const journalEntryId = `ASIENTO_${movimiento.invoiceNumber}`;
     const totalDebit = Math.abs(Number(movimiento.accountingAmount) || 0);
     const totalCredit = totalDebit;
     // Build accounting entry header
     const asiento = {
       _id: journalEntryId,
       journalEntryId,
       sequenceNumber: Number(movimiento.sequenceNumber) || 0,
       fiscalYear: Number(movimiento.fiscalPeriod?.slice(0, 4)) || new Date().getFullYear(),
       fiscalPeriod: movimiento.fiscalPeriod || "",
       operationDate: new Date(movimiento.operationDate),
       fiscalOperationDate: new Date(movimiento.operationDate),
       description: movimiento.description || "",
       totalDebit: _roundMoney(totalDebit),
       totalCredit: _roundMoney(totalCredit),
       totalDocumentAmount: _roundMoney(Number(movimiento.totalAmount) || 0),
       entryType: movimiento.movementType,
       entryStatus: "CONFIRMADO",
       operationCategory: movimiento.movementType,
       operationSubcategory: null,
       currency: "EUR",
       paymentMethod: movimiento.paymentMethod,
       wixOrderId: movimiento.orderId || null,
       wixRefundId: movimiento.refundId || null,
       wixBookingId: movimiento.reservationIdLinked || null,
       transactionId: movimiento.transactionId || null,
       invoiceSeries: null,
       invoiceNumber: movimiento.invoiceNumber,
       invoiceIssueDate: new Date(movimiento.operationDate),
       invoiceType: movimiento.operationNature === "DEVOLUCION" ? "R1" : "F1",
       externalReference: null,
       rectifiedEntryId: null,
       rectificationReason: null,
       operationalManagerId: movimiento.resourceId || null,
       recordingMemberId: "SYSTEM_FISCAL_LEDGER",
       recordingName: "SISTEMA_FISCAL",
       costCenterId: null,
       iaeActivityCode: null,
       recordSource: movimiento.recordSource || "MOVIMIENTO_CAJA",
       sourceId: movimiento._id || null,
       schemaVersion: LEDGER_SCHEMA_VERSION,
       integrityAlgorithmVersion: INTEGRITY_ALGORITHM_VERSION,
       previousHash: movimiento.previousRecordHash,
       entryHash: movimiento.currentRecordHash,
       entrySignature: movimiento.digitalSignature,
       traceId,
       registeredAt: new Date(),
       operationTimeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
       _createdDate: new Date(),
     };
     await wixData.insert(asientosCol, asiento, { suppressAuth: true });
     // Build accounting lines
     const isRefund = Number(movimiento.accountingSign) === -1;
     const lines = [];
     let lineNum = 1;
     if (!isRefund) {
       // Debit: Treasury/Client
       lines.push({
         _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         journalEntryId,
         lineNumber: lineNum++,
         accountCode: map.defaultDebitAccountCode || map.codigoCuentaDebePredeterminada || "570000",
         accountName: map.defaultDebitAccountName || map.nombreCuentaDebePredeterminada || "Caja",
         accountGroup: null,
         debitAmount: _roundMoney(totalDebit),
         creditAmount: 0,
         netAmount: _roundMoney(totalDebit),
         lineDescription: movimiento.description || "",
         taxableAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
         taxRate: Number(movimiento.taxRate) || 0,
         taxAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
         vatOperationKey: null,
         counterpartyTaxId: null,
         counterpartyName: null,
         operationCategory: movimiento.movementType,
         productServiceCode: null,
         costCenterId: null,
         operationalManagerId: movimiento.resourceId || null,
         externalReference: null,
         traceId,
         operationDate: new Date(movimiento.operationDate),
         registeredAt: new Date(),
         _createdDate: new Date(),
       });
       // Credit: Sales
       lines.push({
         _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         journalEntryId,
         lineNumber: lineNum++,
         accountCode: map.defaultCreditAccountCode || map.codigoCuentaHaberPredeterminada || "705000",
         accountName: map.defaultCreditAccountName || map.nombreCuentaHaberPredeterminada || "Prestaciones de servicios",
         accountGroup: null,
         debitAmount: 0,
         creditAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
         netAmount: -_roundMoney(Number(movimiento.taxableAmount) || 0),
         lineDescription: movimiento.description || "",
         taxableAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
         taxRate: Number(movimiento.taxRate) || 0,
         taxAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
         vatOperationKey: null,
         counterpartyTaxId: null,
         counterpartyName: null,
         operationCategory: movimiento.movementType,
         productServiceCode: null,
         costCenterId: null,
         operationalManagerId: movimiento.resourceId || null,
         externalReference: null,
         lineHash: `${journalEntryId}_L${String(lineNum - 1).padStart(3, "0")}`,
         traceId,
         operationDate: new Date(movimiento.operationDate),
         registeredAt: new Date(),
         _createdDate: new Date(),
       });
       // Credit: VAT
       if (Number(movimiento.taxAmount) > 0) {
         lines.push({
           _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
           lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
           journalEntryId,
           lineNumber: lineNum++,
           accountCode: map.outputTaxAccountCode || map.codigoCuentaIvaRepercutido || "477000",
           accountName: map.outputTaxAccountName || map.nombreCuentaIvaRepercutido || "Hacienda Publica IVA Repercutido",
           accountGroup: null,
           debitAmount: 0,
           creditAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
           netAmount: -_roundMoney(Number(movimiento.taxAmount) || 0),
           lineDescription: "IVA Repercutido",
           taxableAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
           taxRate: Number(movimiento.taxRate) || 0,
           taxAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
           vatOperationKey: null,
           counterpartyTaxId: null,
           counterpartyName: null,
           operationCategory: movimiento.movementType,
           productServiceCode: null,
           costCenterId: null,
           operationalManagerId: movimiento.resourceId || null,
           externalReference: null,
           traceId,
           operationDate: new Date(movimiento.operationDate),
           registeredAt: new Date(),
           _createdDate: new Date(),
         });
       }
     } else {
       // Refund: reverse entries
       lines.push({
         _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         journalEntryId,
         lineNumber: lineNum++,
         accountCode: map.defaultCreditAccountCode || map.codigoCuentaHaberPredeterminada || "705000",
         accountName: map.defaultCreditAccountName || map.nombreCuentaHaberPredeterminada || "Prestaciones de servicios",
         accountGroup: null,
         debitAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
         creditAmount: 0,
         netAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
         lineDescription: movimiento.description || "",
         taxableAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
         taxRate: Number(movimiento.taxRate) || 0,
         taxAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
         vatOperationKey: null,
         counterpartyTaxId: null,
         counterpartyName: null,
         operationCategory: movimiento.movementType,
         productServiceCode: null,
         costCenterId: null,
         operationalManagerId: movimiento.resourceId || null,
         externalReference: null,
         traceId,
         operationDate: new Date(movimiento.operationDate),
         registeredAt: new Date(),
         _createdDate: new Date(),
       });
       if (Number(movimiento.taxAmount) > 0) {
         lines.push({
           _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
           lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
           journalEntryId,
           lineNumber: lineNum++,
           accountCode: map.outputTaxAccountCode || map.codigoCuentaIvaRepercutido || "477000",
           accountName: map.outputTaxAccountName || map.nombreCuentaIvaRepercutido || "Hacienda Publica IVA Repercutido",
           accountGroup: null,
           debitAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
           creditAmount: 0,
           netAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
           lineDescription: "IVA Repercutido (devolucion)",
           taxableAmount: _roundMoney(Number(movimiento.taxableAmount) || 0),
           taxRate: Number(movimiento.taxRate) || 0,
           taxAmount: _roundMoney(Number(movimiento.taxAmount) || 0),
           vatOperationKey: null,
           counterpartyTaxId: null,
           counterpartyName: null,
           operationCategory: movimiento.movementType,
           productServiceCode: null,
           costCenterId: null,
           operationalManagerId: movimiento.resourceId || null,
           externalReference: null,
           traceId,
           operationDate: new Date(movimiento.operationDate),
           registeredAt: new Date(),
           _createdDate: new Date(),
         });
       }
       lines.push({
         _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
         journalEntryId,
         lineNumber: lineNum++,
         accountCode: map.defaultDebitAccountCode || map.codigoCuentaDebePredeterminada || "570000",
         accountName: map.defaultDebitAccountName || map.nombreCuentaDebePredeterminada || "Caja",
         accountGroup: null,
         debitAmount: 0,
         creditAmount: _roundMoney(totalCredit),
         netAmount: -_roundMoney(totalCredit),
         lineDescription: movimiento.description || "",
         taxableAmount: null,
         taxRate: null,
         taxAmount: null,
         vatOperationKey: null,
         counterpartyTaxId: null,
         counterpartyName: null,
         operationCategory: movimiento.movementType,
         productServiceCode: null,
         costCenterId: null,
         operationalManagerId: movimiento.resourceId || null,
         externalReference: null,
         traceId,
         operationDate: new Date(movimiento.operationDate),
         registeredAt: new Date(),
         _createdDate: new Date(),
       });
     }
     for (const line of lines) {
       await wixData.insert(lineasCol, line, { suppressAuth: true });
     }
   } catch (err) {
     log.error("_projectToAccounting failed", { traceId, error: err?.message });
   }
 }
 // ============================================================================
 // ENQUEUE M365 SYNC
 // ============================================================================
 async function _enqueueM365Sync(movimiento, traceId) {
   try {
     const queueCol = COLLECTIONS.M365_GRAPH_SYNC_QUEUE;
     const payload = {
       eventType: "LEDGER_MOVEMENT",
       correlationId: traceId,
       transactionId: movimiento.transactionId,
       bookingReference: movimiento.reservationIdLinked || movimiento._id,
       amount: movimiento.totalAmount,
       currency: "EUR",
       occurredAt: movimiento.registeredAt,
     };
     payload.title = `LEDGER_MOVEMENT ${movimiento.transactionId || movimiento.invoiceNumber}`;
     payload.integrityHash = hashSHA256(_stableSerialize(payload));
     const queueId = `m365-graph-${hashSHA256(_stableSerialize(payload)).slice(0, 56)}`;
     const queueRecord = {
       _id: queueId,
       payload,
       payloadHash: payload.integrityHash,
       status: "PENDING",
       attempts: 0,
       nextAttemptAt: new Date(),
       traceId,
       _createdDate: new Date(),
       _updatedDate: new Date(),
     };
     await wixData.insert(queueCol, queueRecord, { suppressAuth: true });
   } catch (err) {
     log.error("_enqueueM365Sync failed", { traceId, error: err?.message });
   }
 }
 // ============================================================================
 // REGISTER BOOKING PAYMENT (called from citasManager)
 // ============================================================================
 export async function registerBookingPayment(bookingIds, amount, method, meta = {}) {
   const traceId = meta.traceId || makeTraceId("bkg-pay");
   return await registerManualTransaction({
     amount,
     paymentMethod: method,
     tipoMovimiento: meta.tipoMovimiento || "VENTA_ONLINE",
     concept: meta.concept || `Cobro reserva ${bookingIds}`,
     resourceId: meta.resourceId || "ONLINE",
     reservationIdLinked: bookingIds,
     transactionId: meta.transactionId || null,
     orderId: meta.orderId || null,
     traceId,
   });
 }
 // ============================================================================
 // QUEUE FISCAL RECOVERY
 // ============================================================================
 export async function queueFiscalRecovery(recoveryData) {
   const traceId = recoveryData.traceId || makeTraceId("fiscal-rec");
   try {
     const compCol = COLLECTIONS.COMPENSACIONES_PENDIENTES;
     await wixData.insert(compCol, {
       _id: `REC_${recoveryData.transactionId || Date.now()}`,
       bookingIds: recoveryData.bookingIds || null,
       orderId: recoveryData.orderId || null,
       refundId: recoveryData.refundId || null,
       transactionId: recoveryData.transactionId || null,
       status: "PENDING_RECOVERY",
       amount: Number(recoveryData.amount) || 0,
       concept: recoveryData.concept || "Fiscal recovery",
       paymentMethod: recoveryData.paymentMethod || null,
       movementType: recoveryData.tipoMovimiento || recoveryData.movementType || null,
       kind: "FISCAL_LEDGER",
       phase: recoveryData.phase || null,
       origin: recoveryData.origin || "FISCAL_RECOVERY",
       alertRequired: false,
       attempts: 0,
       lastError: recoveryData.lastError || null,
       traceId,
       _createdDate: new Date(),
       _updatedDate: new Date(),
     }, { suppressAuth: true });
   } catch (err) {
     log.error("queueFiscalRecovery failed", { traceId, error: err?.message });
   }
 }
 // ============================================================================
 // GET CASHIER STATE
 // ============================================================================
 export const getCashierState = webMethod(Permissions.SiteMember, async ({ traceId, diaKey }) => {
   try {
     await requireCajero(traceId);
     const cajaCol = COLLECTIONS.CAJA_ACTUAL;
     const caja = await wixData.get(cajaCol, CAJA_ACTUAL_ID, { suppressAuth: true }).catch(() => null);
     return {
       status: "SUCCESS",
       data: caja || {
         _id: CAJA_ACTUAL_ID,
         cashRegisterStatus: CAJA_STATUS.CLOSED,
         totalBalance: 0,
         cashBalance: 0,
         cardBalance: 0,
         bizumBalance: 0,
         onlineBalance: 0,
         totalOperations: 0,
       },
       error: null,
     };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "CASHIER_STATE_FAIL") };
   }
 });
 // ============================================================================
 // REGISTER X COUNT (ARQUEO PARCIAL)
 // ============================================================================
 export const registerXCount = webMethod(Permissions.SiteMember, async (diaKey, { metalicoCaja, traceId }) => {
   try {
     await requireCajero(traceId);
     const cleanDiaKey = _readDate(diaKey);
     if (!cleanDiaKey) {
       return { status: "ERROR", data: null, error: { code: "INVALID_DATE", message: "Fecha invalida" } };
     }
     const countedCash = _readNonNegativeAmount(metalicoCaja);
     if (countedCash === null) {
       return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe de efectivo contado invalido" } };
     }
     // Get theoretical cash from ledger
     const cajaCol = COLLECTIONS.CAJA_ACTUAL;
     const caja = await wixData.get(cajaCol, CAJA_ACTUAL_ID, { suppressAuth: true }).catch(() => null);
     const expectedCash = _roundMoney(caja?.cashBalance || 0);
     const discrepancyAmount = _roundMoney(countedCash - expectedCash);
     const reconciliationStatus = Math.abs(discrepancyAmount) < 0.01 ? "CUADRADO" : "DESCUADRE";
     const res = await wixData.insert(COLLECTIONS.CONTROL_PARCIAL_X, {
       operationDate: cleanDiaKey,
       countedCash,
       expectedCash,
       discrepancyAmount,
       reconciliationStatus,
       countedAt: new Date(),
       reconciledAt: new Date(),
       traceId,
       _createdDate: new Date(),
     }, { suppressAuth: true });
     return { status: "SUCCESS", data: res, error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "X_COUNT_FAIL") };
   }
 });
 // ============================================================================
 // REGISTER Z CLOSING (CIERRE FISCAL DIARIO)
 // ============================================================================
 export const registerZClosing = webMethod(Permissions.SiteMember, async (diaKey, { traceId }) => {
   try {
     await requireCajero(traceId);
     await validateFiscalConfig(traceId);
     const { fiscalKey, businessTaxId } = await _getFiscalKeys(traceId);
     const cleanDiaKey = _readDate(diaKey);
     if (!cleanDiaKey) {
       return { status: "ERROR", data: null, error: { code: "INVALID_DATE", message: "Fecha invalida" } };
     }
     // Fetch all movements for the day
     let allMovements = [];
     let query = wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
       .eq("operationDate", cleanDiaKey)
       .ascending("registeredAt")
       .limit(LEDGER_PAGE_SIZE);
     let res = await query.find({ suppressAuth: true });
     allMovements = allMovements.concat(res.items || []);
     let page = 2;
     while (res.hasNext() && page <= MAX_LEDGER_BATCH_PAGES) {
       res = await res.next();
       allMovements = allMovements.concat(res.items || []);
       page++;
     }
     if (allMovements.length === 0) {
       return { status: "ERROR", data: null, error: { code: "NO_MOVEMENTS", message: "No hay movimientos para cerrar" } };
     }
     // Calculate totals
     const totalCash = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.EFECTIVO).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const totalCard = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.TARJETA).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const totalBizum = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.BIZUM).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const totalOnline = allMovements.filter(m => m.paymentMethod === FORMA_PAGO.ONLINE).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const totalRefunds = allMovements.filter(m => m.movementType === TIPO_MOVIMIENTO.REEMBOLSO).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const totalTips = allMovements.filter(m => m.movementType === TIPO_MOVIMIENTO.PROPINA).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const totalAdjustments = allMovements.filter(m => m.movementType === TIPO_MOVIMIENTO.AJUSTE).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const grossSalesTotal = allMovements.filter(m => m.operationNature === "VENTA").reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
     const netTaxableAmount = allMovements.reduce((s, m) => s + Number(m.taxableAmount || 0), 0);
     const netTaxAmount = allMovements.reduce((s, m) => s + Number(m.taxAmount || 0), 0);
     const consolidatedTotalAmount = _roundMoney(totalCash + totalCard + totalBizum + totalOnline);
     // Movement type breakdown
     const movementTypeBreakdown = {};
     for (const m of allMovements) {
       const mt = m.movementType || "UNKNOWN";
       movementTypeBreakdown[mt] = _roundMoney((movementTypeBreakdown[mt] || 0) + Number(m.accountingAmount || 0));
     }
     // Tax type breakdown
     const taxTypeBreakdown = {};
     for (const m of allMovements) {
       const rate = String(Number(m.taxRate) || 0);
       if (!taxTypeBreakdown[rate]) taxTypeBreakdown[rate] = { taxableAmount: 0, taxAmount: 0, total: 0, operations: 0 };
       taxTypeBreakdown[rate].taxableAmount = _roundMoney(taxTypeBreakdown[rate].taxableAmount + Number(m.taxableAmount || 0));
       taxTypeBreakdown[rate].taxAmount = _roundMoney(taxTypeBreakdown[rate].taxAmount + Number(m.taxAmount || 0));
       taxTypeBreakdown[rate].total = _roundMoney(taxTypeBreakdown[rate].total + Number(m.accountingAmount || 0));
       taxTypeBreakdown[rate].operations++;
     }
     // Verify hash chain integrity before closing
     let expectedPrev = GENESIS_HASH;
     let integrityVerified = true;
     for (const mov of allMovements) {
       if (mov.previousRecordHash && mov.previousRecordHash !== expectedPrev) {
         integrityVerified = false;
         log.error("Hash chain integrity violation detected", {
           traceId,
           movementId: mov._id,
           expected: expectedPrev,
           actual: mov.previousRecordHash,
         });
         break;
       }
       expectedPrev = mov.currentRecordHash || expectedPrev;
     }
     if (!integrityVerified) {
       return { status: "ERROR", data: null, error: { code: "INTEGRITY_VIOLATION", message: "Hash chain integrity violation detected. Cannot close." } };
     }
     // Hash chain for closing
     const firstMov = allMovements[0];
     const lastMov = allMovements[allMovements.length - 1];
     const closingPayload = _stableSerialize({
       operationDate: cleanDiaKey,
       consolidatedTotalAmount,
       grossSalesTotal: _roundMoney(grossSalesTotal),
       netTaxableAmount: _roundMoney(netTaxableAmount),
       netTaxAmount: _roundMoney(netTaxAmount),
       totalOperations: allMovements.length,
       startSequence: Number(firstMov?.sequenceNumber) || 0,
       endSequence: Number(lastMov?.sequenceNumber) || 0,
     });
     const closingHash = hashSHA256(closingPayload);
     const closingSignature = hmacSha256Hex(fiscalKey, closingHash);
     // Build Z closing record
     const zRecord = {
       _id: `Z_${cleanDiaKey}`,
       operationDate: cleanDiaKey,
       closingStatus: "CERRADO",
       consolidatedTotalAmount,
       grossSalesTotal: _roundMoney(grossSalesTotal),
       netTaxableAmount: _roundMoney(netTaxableAmount),
       netTaxAmount: _roundMoney(netTaxAmount),
       totalCash: _roundMoney(totalCash),
       totalCard: _roundMoney(totalCard),
       totalBizum: _roundMoney(totalBizum),
       totalOnline: _roundMoney(totalOnline),
       totalRefunds: _roundMoney(totalRefunds),
       totalTips: _roundMoney(totalTips),
       totalAdjustments: _roundMoney(totalAdjustments),
       totalOperations: allMovements.length,
       startSequence: Number(firstMov?.sequenceNumber) || 0,
       endSequence: Number(lastMov?.sequenceNumber) || 0,
       startTicketNumber: firstMov?.invoiceNumber || "",
       endTicketNumber: lastMov?.invoiceNumber || "",
       startRecordHash: firstMov?.previousRecordHash || GENESIS_HASH,
       endRecordHash: lastMov?.currentRecordHash || GENESIS_HASH,
       movementTypeBreakdown,
       taxTypeBreakdown,
       isIntegrityVerified: true,
       auditedRecordsCount: allMovements.length,
       closingHash,
       closingSignature,
       closingSource: "CRON",
       closingSchemaVersion: LEDGER_SCHEMA_VERSION,
       timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
       closedAt: new Date(),
       verifiedAt: new Date(),
       traceId,
       _createdDate: new Date(),
     };
     const saved = await wixData.insert(COLLECTIONS.HISTORICO_CIERRES_Z, zRecord, { suppressAuth: true });
     // Update CajaActual to closed
     const cajaCol = COLLECTIONS.CAJA_ACTUAL;
     const caja = await wixData.get(cajaCol, CAJA_ACTUAL_ID, { suppressAuth: true }).catch(() => null);
     if (caja) {
       caja.cashRegisterStatus = CAJA_STATUS.CLOSED;
       caja.closedAt = new Date();
       caja._updatedDate = new Date();
       await wixData.save(cajaCol, caja, { suppressAuth: true });
     }
     return { status: "SUCCESS", data: saved, error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "Z_CLOSING_FAIL") };
   }
 });
 // ============================================================================
 // VERIFY FISCAL HASH CHAIN INTEGRITY
 // ============================================================================
 export async function verifyFiscalHashChainIntegrity(options = {}) {
   const traceId = options.traceId || makeTraceId("hash-audit");
   const batchSize = Number(options.limit) || LEDGER_PAGE_SIZE;
   const breaks = [];
   try {
     const movements = await wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
       .ascending("registeredAt")
       .limit(batchSize)
       .find({ suppressAuth: true });
     let expectedPrev = GENESIS_HASH;
     for (const mov of movements.items || []) {
       if (mov.previousRecordHash && mov.previousRecordHash !== expectedPrev) {
         breaks.push({
           movementId: mov._id,
           invoiceNumber: mov.invoiceNumber,
           expected: expectedPrev,
           actual: mov.previousRecordHash,
         });
       }
       expectedPrev = mov.currentRecordHash;
     }
     if (breaks.length > 0) {
       await wixData.insert(COLLECTIONS.MM_AUDIT_LOG, {
         _id: `AUDIT_HASH_${Date.now()}`,
         eventType: "FISCAL_CHAIN_CORRUPTED",
         level: "CRITICAL",
         message: `Detectadas ${breaks.length} rupturas en la cadena de facturas`,
         data: { breaksCount: breaks.length, details: breaks.slice(0, 5) },
         loggedAt: new Date(),
         traceId,
       }, { suppressAuth: true });
     }
     return {
       status: breaks.length === 0 ? "SUCCESS" : "INTEGRITY_COMPROMISED",
       data: { checked: movements.items.length, breaksCount: breaks.length, breaks },
       error: null,
     };
   } catch (err) {
     return { status: "ERROR", data: null, error: { code: "AUDIT_FAIL", message: err.message } };
   }
 }