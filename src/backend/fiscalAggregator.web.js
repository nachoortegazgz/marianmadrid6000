/*
 =============================================================================
 MODULE: backend/fiscalAggregator.web.js
 VERSION: v5002.2-fiscal-aggregator-canonical
 RESPONSIBILITY: Memory-efficient tax review summaries and internal ledger
                 extracts for quarterly fiscal reporting (Spanish tax system).
                 Uses Stream Accumulator Pattern with bounded pagination.
 STANDARDS: G10 ASCII Strict (0 non-ASCII characters), Velo Native Optimized.
 =============================================================================
 */
 import { webMethod, Permissions } from "wix-web-module";
 import wixData from "wix-data";
 import { COLLECTIONS, SDK_CONFIG, TIPO_MOVIMIENTO } from "backend/internalConfig";
 import { makeTraceId, _safeTrim, _roundMoney, withTimeout } from "public/mmUtils";
 import { requireCajero, requireAdmin, requireMarianManager, rateLimiter } from "backend/security";
 import { logger } from "backend/booking/bookingCore";
 import { _toPublicError } from "backend/responseUtils";
 const log = logger;
 const CHUNK_PAGE_SIZE = 100;
 const MAX_PAGES = SDK_CONFIG?.JOBS?.FISCAL_DAILY_MAX_PAGES || 50;
 const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;
 function _rateLimitOrThrow(surface, key, traceId) {
   const rl = rateLimiter({ surface, key });
   if (!rl.allowed) {
     const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
     e.code = "RATE_LIMITED";
     e.meta = { retryAfter: rl.retryAfter, surface, traceId };
     throw e;
   }
 }
 function _getQuarterMonths(year, quarter) {
   const y = Number(year);
   const q = Number(quarter);
   if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) return [];
   const monthMap = {
     1: ["01", "02", "03"],
     2: ["04", "05", "06"],
     3: ["07", "08", "09"],
     4: ["10", "11", "12"],
   };
   return monthMap[q].map((m) => `${y}-${m}`);
 }
 function _initTaxAccumulator(months) {
   const breakdownByMonth = {};
   months.forEach((m) => {
     breakdownByMonth[m] = { taxableAmount: 0, taxAmount: 0, total: 0, count: 0 };
   });
   return {
     totalTaxableAmount: 0,
     totalTaxAmount: 0,
     totalInvoiced: 0,
     totalGrossSales: 0,
     totalRefunds: 0,
     totalTips: 0,
     totalAdjustments: 0,
     countSales: 0,
     countRefunds: 0,
     countTips: 0,
     countAdjustments: 0,
     countFiscal: 0,
     totalOperations: 0,
     breakdownByPaymentMethod: { efectivo: 0, tarjeta: 0, bizum: 0, online: 0 },
     breakdownByMonth,
     breakdownByVatRate: {},
   };
 }
 function _accumulatePage(items, state) {
   for (const m of items) {
     state.totalOperations++;
     const accountingAmount = Number(m.accountingAmount || 0);
     const taxableAmount = Number(m.taxableAmount || 0);
     const taxAmount = Number(m.taxAmount || 0);
     const mes = _safeTrim(m.fiscalPeriod || m.mesKey);
     const paymentMethod = _safeTrim(m.paymentMethod || m.medioPago || "").toLowerCase();
     const taxRate = Number(m.taxRate || m.tasaIva || 0);
     const taxRateKey = String(taxRate);
     const movementType = _safeTrim(m.movementType || m.tipoMovimiento || "").toUpperCase();
     const operationNature = _safeTrim(m.operationNature || m.naturalezaOperacion || "").toUpperCase() || (
       movementType === TIPO_MOVIMIENTO.PROPINA ? "PROPINA" :
       movementType === TIPO_MOVIMIENTO.REEMBOLSO || accountingAmount < 0 ? "DEVOLUCION" :
       movementType === TIPO_MOVIMIENTO.AJUSTE ? "AJUSTE" : "VENTA"
     );
     if (state.breakdownByPaymentMethod[paymentMethod] !== undefined) {
       state.breakdownByPaymentMethod[paymentMethod] += accountingAmount;
     }
     if (operationNature === "PROPINA") {
       state.totalTips += accountingAmount;
       state.countTips++;
       continue;
     }
     if (operationNature === "AJUSTE") {
       state.totalAdjustments += accountingAmount;
       state.countAdjustments++;
       continue;
     }
     state.countFiscal++;
     state.totalTaxableAmount += taxableAmount;
     state.totalTaxAmount += taxAmount;
     state.totalInvoiced += accountingAmount;
     if (operationNature === "VENTA") {
       state.totalGrossSales += accountingAmount;
       state.countSales++;
     } else {
       state.totalRefunds += accountingAmount;
       state.countRefunds++;
     }
     if (state.breakdownByMonth[mes]) {
       state.breakdownByMonth[mes].taxableAmount += taxableAmount;
       state.breakdownByMonth[mes].taxAmount += taxAmount;
       state.breakdownByMonth[mes].total += accountingAmount;
       state.breakdownByMonth[mes].count++;
     }
     if (!state.breakdownByVatRate[taxRateKey]) {
       state.breakdownByVatRate[taxRateKey] = { taxRate, taxableAmount: 0, taxAmount: 0, total: 0, operations: 0 };
     }
     state.breakdownByVatRate[taxRateKey].taxableAmount += taxableAmount;
     state.breakdownByVatRate[taxRateKey].taxAmount += taxAmount;
     state.breakdownByVatRate[taxRateKey].total += accountingAmount;
     state.breakdownByVatRate[taxRateKey].operations++;
   }
 }
 async function _fetchQuarterMovements(months, options = {}) {
   const { traceId = makeTraceId("fiscal-fetch"), limit = MAX_PAGES, pageSize = CHUNK_PAGE_SIZE } = options;
   let allItems = [];
   let query = wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
     .hasSome("fiscalPeriod", months)
     .ascending("sequenceNumber")
     .limit(pageSize);
   let res = await withTimeout(
     query.find({ suppressAuth: true, consistentRead: false }),
     CMS_TIMEOUT_MS,
     "fetchQuarterMovements:p1"
   );
   if (res?.items) allItems = allItems.concat(res.items);
   let page = 2;
   let reachedMaxPages = false;
   while (res && res.hasNext() && page <= limit) {
     res = await withTimeout(
       res.next({ suppressAuth: true, consistentRead: false }),
       CMS_TIMEOUT_MS,
       `fetchQuarterMovements:p${page}`
     );
     if (res?.items) allItems = allItems.concat(res.items);
     page++;
   }
   if (page > limit && res && res.hasNext()) {
     reachedMaxPages = true;
     log.warn("_fetchQuarterMovements: reached maxPages limit", { months, limit, traceId });
   }
   return { items: allItems, reachedMaxPages, totalPages: page - 1 };
 }
 export async function getQuarterlyTaxSummaryInternal(year, quarter, options = {}) {
   const traceId = options.traceId || makeTraceId("tax-summary");
   const y = Number(year);
   const q = Number(quarter);
   if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) {
     return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "year and quarter (1-4) are required." } };
   }
   const months = _getQuarterMonths(y, q);
   if (!months.length) {
     return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Could not resolve quarter months." } };
   }
   const fetchResult = await _fetchQuarterMovements(months, { traceId });
   const state = _initTaxAccumulator(months);
   _accumulatePage(fetchResult.items, state);
   const nifEmisor = await _getBusinessTaxId(traceId).catch(() => "BXXXXXXXX");
   return {
     status: "SUCCESS",
     data: {
       ejercicio: y,
       trimestre: q,
       periodoMeses: months,
       nifEmisor,
       totalOperaciones: state.totalOperations,
       totalOperacionesFiscales: state.countFiscal,
       conteo: {
         ventas: state.countSales,
         reembolsos: state.countRefunds,
         propinas: state.countTips,
         ajustes: state.countAdjustments,
       },
       borradorIva: {
         estado: "REVISION_PROFESIONAL_REQUERIDA",
         baseImponibleRegistrada: _roundMoney(state.totalTaxableAmount),
         cuotaIvaRegistrada: _roundMoney(state.totalTaxAmount),
         nota: "No es un Modelo 303 oficial. Requiere validacion previa por gestoria.",
       },
       borradorIngresos: {
         estado: "REVISION_PROFESIONAL_REQUERIDA",
         ingresosRegistrados: _roundMoney(state.totalTaxableAmount),
         nota: "No es un Modelo 130 oficial. Requiere validacion previa por gestoria.",
       },
       totales: {
         totalVentasBrutas: _roundMoney(state.totalGrossSales),
         totalReembolsos: _roundMoney(state.totalRefunds),
         totalFacturadoNeto: _roundMoney(state.totalInvoiced),
         totalPropinasSeparadas: _roundMoney(state.totalTips),
         totalAjustesSeparados: _roundMoney(state.totalAdjustments),
       },
       desgloseFormaPago: {
         efectivo: _roundMoney(state.breakdownByPaymentMethod.efectivo),
         tarjeta: _roundMoney(state.breakdownByPaymentMethod.tarjeta),
         bizum: _roundMoney(state.breakdownByPaymentMethod.bizum),
         online: _roundMoney(state.breakdownByPaymentMethod.online),
       },
       desgloseMensual: Object.keys(state.breakdownByMonth).map((mesKey) => ({
         mesKey,
         baseImponible: _roundMoney(state.breakdownByMonth[mesKey].taxableAmount),
         cuotaIva: _roundMoney(state.breakdownByMonth[mesKey].taxAmount),
         total: _roundMoney(state.breakdownByMonth[mesKey].total),
         operaciones: state.breakdownByMonth[mesKey].count,
       })),
       desgloseTipoIva: Object.values(state.breakdownByVatRate).map((item) => ({
         tasaIva: item.taxRate,
         baseImponible: _roundMoney(item.taxableAmount),
         cuotaIva: _roundMoney(item.taxAmount),
         total: _roundMoney(item.total),
         operaciones: item.operations,
       })),
       reachedMaxPages: fetchResult.reachedMaxPages,
       totalPagesFetched: fetchResult.totalPages,
     },
     error: null,
   };
 }
 export async function getLibroRegistroFacturasExpedidasInternal(year, quarter, options = {}) {
   const traceId = options.traceId || makeTraceId("libro-registro");
   const y = Number(year);
   const q = Number(quarter);
   if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) {
     return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "year and quarter (1-4) are required." } };
   }
   const months = _getQuarterMonths(y, q);
   if (!months.length) {
     return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Could not resolve quarter months." } };
   }
   const fetchResult = await _fetchQuarterMovements(months, { traceId });
   let libroFilas = [];
   let orderIndex = 1;
   for (const m of fetchResult.items) {
     const accountingAmount = Number(m.accountingAmount || 0);
     const movementType = _safeTrim(m.movementType || m.tipoMovimiento || "").toUpperCase();
     const operationNature = _safeTrim(m.operationNature || m.naturalezaOperacion || "").toUpperCase();
     const isTip = operationNature === "PROPINA" || movementType === TIPO_MOVIMIENTO.PROPINA;
     const isAdjustment = operationNature === "AJUSTE" || movementType === TIPO_MOVIMIENTO.AJUSTE;
     const isRefund = operationNature === "DEVOLUCION" || movementType === TIPO_MOVIMIENTO.REEMBOLSO || accountingAmount < 0;
     libroFilas.push({
       orden: orderIndex++,
       invoiceNumber: _safeTrim(m.invoiceNumber || m.numTicketFactura),
       fechaExpedicion: _safeTrim(m.operationDate || m.operationDate || m.diaKey),
       tipoFactura: isRefund ? "R1" : (isTip || isAdjustment ? "BORRADOR_INTERNO" : "BORRADOR_INTERNO"),
       movementType: _safeTrim(m.movementType || m.tipoMovimiento),
       operationNature: operationNature || "VENTA",
       taxTreatment: _safeTrim(m.taxTreatment || m.taxTreatment) || "PENDIENTE_VALIDACION",
       incluidoEnBorradorIva: !isTip && !isAdjustment,
       referenciaRectificativa: _safeTrim(m.rectifiedInvoiceReference || m.referenciaRectificativa) || null,
       paymentMethod: _safeTrim(m.paymentMethod || m.medioPago),
       taxableAmount: _roundMoney(m.taxableAmount || m.baseImponible || 0),
       taxRate: `${Math.round((Number(m.taxRate || m.tasaIva || 0)) * 100)}%`,
       taxAmount: _roundMoney(m.taxAmount || m.cuotaIva || 0),
       totalAmount: _roundMoney(accountingAmount),
       concepto: _safeTrim(m.description || m.description || m.concepto),
       origen: _safeTrim(m.recordSource || m.origenRegistro || m.origen),
       orderId: _safeTrim(m.orderId) || null,
       refundId: _safeTrim(m.refundId) || null,
       fechaHoraRegistro: m.registeredAt || m.registeredAt || null,
       huellaSha256: _safeTrim(m.currentRecordHash || m.currentRecordHash || "").slice(0, 8).toUpperCase(),
       hashCompleto: _safeTrim(m.currentRecordHash || m.currentRecordHash || ""),
       reservaVinculada: _safeTrim(m.reservaIdVinculada) || null,
       transactionId: _safeTrim(m.transactionId),
     });
   }
   return {
     status: "SUCCESS",
     data: {
       ejercicio: y,
       trimestre: q,
       totalRegistros: libroFilas.length,
       filas: libroFilas,
       reachedMaxPages: fetchResult.reachedMaxPages,
       totalPagesFetched: fetchResult.totalPages,
     },
     error: null,
   };
 }
 async function _getBusinessTaxId(traceId) {
   try {
     const config = await withTimeout(
       wixData.query(COLLECTIONS.CONFIGURACION_FISCAL)
         .eq("active", true)
         .limit(1)
         .find({ suppressAuth: true }),
       CMS_TIMEOUT_MS,
       "getBusinessTaxId"
     );
     const item = config?.items?.[0];
     return item?.businessTaxId || item?.taxId || item?.nifEmisor || "BXXXXXXXX";
   } catch (err) {
     log.warn("_getBusinessTaxId failed, using fallback", { traceId, error: err?.message });
     return "BXXXXXXXX";
   }
 }
 export const getQuarterlyTaxSummary = webMethod(Permissions.SiteMember, async (year, quarter, options = {}) => {
   const traceId = options.traceId || makeTraceId("tax-303");
   try {
     _rateLimitOrThrow("fiscal.getQuarterlyTaxSummary", "staff", traceId);
     await requireCajero(traceId);
     return await getQuarterlyTaxSummaryInternal(year, quarter, { ...options, traceId });
   } catch (err) {
     log.error("getQuarterlyTaxSummary failed", { error: err?.message, traceId });
     return { status: "ERROR", data: null, error: _toPublicError(err, "TAX_SUMMARY_FAIL") };
   }
 });
 export const getLibroRegistroFacturasExpedidas = webMethod(Permissions.Admin, async (year, quarter, options = {}) => {
   const traceId = options.traceId || makeTraceId("libro-registro");
   try {
     _rateLimitOrThrow("fiscal.getLibroRegistroFacturasExpedidas", "admin", traceId);
     await requireAdmin(traceId);
     return await getLibroRegistroFacturasExpedidasInternal(year, quarter, { ...options, traceId, rateLimitKey: "admin" });
   } catch (err) {
     log.error("getLibroRegistroFacturasExpedidas authorization failed", { error: err?.message, traceId });
     return { status: "ERROR", data: null, error: _toPublicError(err, "LIBRO_REGISTRO_FAIL") };
   }
 });
 export async function prepareScheduledManagerPackages(options = {}) {
   const traceId = options.traceId || makeTraceId("cron-packages");
   try {
     const now = new Date();
     const year = now.getFullYear();
     const quarter = Math.floor((now.getMonth() + 3) / 3);
     const summary = await getQuarterlyTaxSummaryInternal(year, quarter, { traceId });
     return { status: "SUCCESS", data: summary?.data || null, error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "SCHEDULED_PACKAGES_FAIL") };
   }
 }