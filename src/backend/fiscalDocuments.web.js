/*
 =============================================================================
 MODULE: backend/fiscalDocuments.web.js
 VERSION: v5002.2-canonical-fiscal-documents
 RESPONSIBILITY: Generates tax package previews, CSV/PDF structured documents,
                 maintains version history, and dispatches via Resend API.
                 Aligned with Mission 4 (InventarioStockVentaCierre) and
                 Mission 6 (Fiscal/Accounting) canonical collections.
 STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 =============================================================================
 */
 import { webMethod, Permissions } from "wix-web-module";
 import wixData from "wix-data";
 import { getSecret } from "wix-secrets-backend";
 import { makeTraceId, _safeTrim, withTimeout, _roundMoney } from "public/mmUtils";
 import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
 import { SECRETS } from "backend/mmSecrets";
 import { requireMarianManager } from "backend/security";
 import { _toPublicError } from "backend/responseUtils";
 import {
   getQuarterlyTaxSummary,
   getLibroRegistroFacturasExpedidasInternal,
 } from "backend/fiscalAggregator.web";

 const CMS_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.CMS_MS) || 15000;
 const DOCS_COL = COLLECTIONS.INVENTARIO_STOCK_VENTA_CIERRE;
 const MAX_EMAIL_ATTACHMENT_BYTES = SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_ATTACHMENT_BYTES || 3145728;
 const MAX_EMAIL_SEND_ATTEMPTS = SDK_CONFIG?.DOCUMENTS?.MAX_EMAIL_SEND_ATTEMPTS || 3;
 const DEFAULT_MANAGER_EMAIL = SDK_CONFIG?.DOCUMENTS?.DEFAULT_MANAGER_EMAIL || "gestion@marianmadrid.es";

 function _formatDocumentId(year, quarter, version = 1) {
   const vStr = String(version).padStart(4, "0");
   return `DOC_GESTORIA_${year}_T${quarter}_PAQUETE_GESTORIA_V${vStr}`;
 }

 function _buildCsvFromInvoices(invoices) {
   if (!Array.isArray(invoices) || invoices.length === 0) return "";
   const header = "Numero;Fecha;Tipo;Base;Cuota;Total;FormaPago;Hash\n";
   const rows = invoices.map((inv) =>
     `"${_safeTrim(inv.invoiceNumber || inv.numTicketFactura)}";` +
     `"${_safeTrim(inv.issueDate || inv.fechaExpedicion || inv.diaKey)}";` +
     `"${_safeTrim(inv.movementType || inv.tipoMovimiento)}";` +
     `${_roundMoney(inv.taxableAmount || inv.baseImponible || 0)};` +
     `${_roundMoney(inv.taxAmount || inv.cuotaIva || 0)};` +
     `${_roundMoney(inv.totalAmount || inv.totalAmount || 0)};` +
     `"${_safeTrim(inv.paymentMethod || inv.formaPago)}";` +
     `"${_safeTrim(inv.currentRecordHash || inv.hashCadena)}"`
   ).join("\n");
   return header + rows;
 }

 function _buildSummaryText(summary) {
   if (!summary) return "Sin datos de resumen.";
   const lines = [];
   lines.push(`Ejercicio: ${summary.ejercicio || "N/A"}`);
   lines.push(`Trimestre: ${summary.trimestre || "N/A"}`);
   lines.push(`Total Operaciones: ${summary.totalOperaciones || 0}`);
   lines.push(`Total Operaciones Fiscales: ${summary.totalOperacionesFiscales || 0}`);
   if (summary.totales) {
     lines.push(`Total Ventas Brutas: ${_roundMoney(summary.totales.totalVentasBrutas || 0)} EUR`);
     lines.push(`Total Reembolsos: ${_roundMoney(summary.totales.totalReembolsos || 0)} EUR`);
     lines.push(`Total Facturado Neto: ${_roundMoney(summary.totales.totalFacturadoNeto || 0)} EUR`);
   }
   if (summary.borradorIva) {
     lines.push(`Borrador IVA - Base Imponible: ${_roundMoney(summary.borradorIva.baseImponibleRegistrada || 0)} EUR`);
     lines.push(`Borrador IVA - Cuota IVA: ${_roundMoney(summary.borradorIva.cuotaIvaRegistrada || 0)} EUR`);
   }
   return lines.join("\n");
 }

 export const previewManagerPackage = webMethod(Permissions.SiteMember, async (period = {}) => {
   const traceId = makeTraceId("doc-preview");
   try {
     await requireMarianManager(traceId);
     const year = Number(period.year);
     const quarter = Number(period.quarter);
     if (!year || !quarter || quarter < 1 || quarter > 4) {
       return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
     }
     const [summaryRes, bookRes] = await Promise.all([
       getQuarterlyTaxSummary(year, quarter, { traceId }),
       getLibroRegistroFacturasExpedidasInternal(year, quarter, { traceId, rateLimitKey: "manager" }),
     ]);
     const summary = summaryRes?.data || null;
     const invoices = bookRes?.data?.filas || [];
     return {
       status: "SUCCESS",
       data: {
         period: { year, quarter },
         documentIdDraft: _formatDocumentId(year, quarter, 1),
         summary,
         invoiceCount: invoices.length,
         previewGeneratedAt: new Date(),
       },
       error: null,
     };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_PREVIEW_FAIL") };
   }
 });

 export const createManagerPackageVersion = webMethod(Permissions.SiteMember, async (period = {}) => {
   const traceId = makeTraceId("doc-create");
   try {
     await requireMarianManager(traceId);
     const year = Number(period.year);
     const quarter = Number(period.quarter);
     if (!year || !quarter || quarter < 1 || quarter > 4) {
       return { status: "ERROR", data: null, error: { code: "INVALID_PERIOD", message: "year and quarter (1-4) are required" } };
     }
     const historyRes = await getManagerPackageHistory({ year, quarter });
     const nextVersion = (historyRes?.data?.length || 0) + 1;
     const documentId = _formatDocumentId(year, quarter, nextVersion);
     const [summaryRes, bookRes] = await Promise.all([
       getQuarterlyTaxSummary(year, quarter, { traceId }),
       getLibroRegistroFacturasExpedidasInternal(year, quarter, { traceId, rateLimitKey: "manager" }),
     ]);
     const record = {
       _id: documentId,
       inventoryClosingId: documentId,
       fiscalYear: year,
       closingDate: new Date(),
       closingType: "PAQUETE_GESTORIA",
       summaryData: summaryRes?.data || {},
       invoiceData: bookRes?.data?.filas || [],
       status: "PREPARED",
       traceId,
       _createdDate: new Date(),
     };
     await withTimeout(
       wixData.save(DOCS_COL, record, { suppressAuth: true }),
       CMS_TIMEOUT_MS,
       "saveManagerPackage"
     );
     return {
       status: "SUCCESS",
       data: { documentId, version: nextVersion, createdAt: record._createdDate },
       error: null,
     };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_CREATE_FAIL") };
   }
 });

 export const getManagerPackageHistory = webMethod(Permissions.SiteMember, async (period = {}) => {
   const traceId = makeTraceId("doc-hist");
   try {
     await requireMarianManager(traceId);
     const year = Number(period.year);
     const quarter = Number(period.quarter);
     let q = wixData.query(DOCS_COL).eq("closingType", "PAQUETE_GESTORIA");
     if (year && Number.isFinite(year)) q = q.eq("fiscalYear", year);
     if (quarter && Number.isFinite(quarter) && quarter >= 1 && quarter <= 4) {
       q = q.startsWith("inventoryClosingId", `DOC_GESTORIA_${year}_T${quarter}`);
     }
     const res = await withTimeout(
       q.descending("_createdDate").limit(50).find({ suppressAuth: true }),
       CMS_TIMEOUT_MS,
       "docHistory"
     );
     return { status: "SUCCESS", data: res?.items || [], error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_HIST_FAIL") };
   }
 });

 export const getPreparedManagerPackages = webMethod(Permissions.SiteMember, async () => {
   const traceId = makeTraceId("doc-prep");
   try {
     await requireMarianManager(traceId);
     const res = await withTimeout(
       wixData.query(DOCS_COL)
         .eq("closingType", "PAQUETE_GESTORIA")
         .descending("_createdDate")
         .limit(20)
         .find({ suppressAuth: true }),
       CMS_TIMEOUT_MS,
       "preparedPackages"
     );
     return { status: "SUCCESS", data: { items: res?.items || [] }, error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_PREP_FAIL") };
   }
 });

 export const downloadManagerPackageVersion = webMethod(Permissions.SiteMember, async (params = {}) => {
   const traceId = makeTraceId("doc-download");
   try {
     await requireMarianManager(traceId);
     const documentId = _safeTrim(params.documentId);
     if (!documentId) {
       return { status: "ERROR", data: null, error: { code: "DOC_ID_REQUIRED", message: "documentId required" } };
     }
     const doc = await withTimeout(
       wixData.get(DOCS_COL, documentId, { suppressAuth: true }),
       CMS_TIMEOUT_MS,
       "getDocPackage"
     );
     if (!doc) {
       return { status: "ERROR", data: null, error: { code: "DOC_NOT_FOUND", message: "Document version not found" } };
     }
     const invoices = Array.isArray(doc.invoiceData) ? doc.invoiceData : [];
     const csvContent = _buildCsvFromInvoices(invoices);
     const summaryText = _buildSummaryText(doc.summaryData);
     return {
       status: "SUCCESS",
       data: {
         documentId,
         csvContent,
         summaryText,
         summary: doc.summaryData || {},
         invoiceCount: invoices.length,
         createdAt: doc._createdDate || doc.closingDate,
       },
       error: null,
     };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_DOWNLOAD_FAIL") };
   }
 });

 export const emailManagerPackageVersion = webMethod(Permissions.SiteMember, async (params = {}) => {
   const traceId = makeTraceId("doc-email");
   try {
     await requireMarianManager(traceId);
     const documentId = _safeTrim(params.documentId);
     const recipient = _safeTrim(params.recipient);
     if (!documentId || !recipient || params.confirmed !== true) {
       return {
         status: "ERROR",
         data: null,
         error: { code: "CONFIRMATION_REQUIRED", message: "Confirmation, documentId, and recipient required" },
       };
     }
     const downloadRes = await downloadManagerPackageVersion({ documentId });
     if (downloadRes.status !== "SUCCESS" || !downloadRes.data) {
       return {
         status: "ERROR",
         data: null,
         error: { code: "DOC_PACKAGE_FAILED", message: "Could not package document data" },
       };
     }
     const apiKey = await getSecret(SECRETS.RESEND_API_KEY).catch(() => "");
     const fromEmail = (await getSecret(SECRETS.RESEND_FROM_EMAIL).catch(() => "")) || DEFAULT_MANAGER_EMAIL;
     if (!apiKey) {
       return {
         status: "SUCCESS",
         data: {
           sent: false,
           note: "Resend API key not configured in Secrets Manager. Package stored in CMS history.",
         },
         error: null,
       };
     }
     const csvBase64 = Buffer.from(downloadRes.data.csvContent, "utf8").toString("base64");
     if (csvBase64.length > MAX_EMAIL_ATTACHMENT_BYTES) {
       return {
         status: "ERROR",
         data: null,
         error: { code: "ATTACHMENT_TOO_LARGE", message: "CSV attachment exceeds maximum allowed size" },
       };
     }
     const resendPayload = {
       from: `Marian Madrid <${fromEmail}>`,
       to: [recipient],
       subject: `[Gestoria] Paquete Fiscal ${documentId}`,
       text: `Adjunto resumen fiscal y extracto del libro diario para el paquete ${documentId}.\n\n${downloadRes.data.summaryText}\n\nGenerado: ${new Date().toISOString()}`,
       attachments: [
         {
           filename: `${documentId}.csv`,
           content: csvBase64,
         },
       ],
     };
     let sent = false;
     for (let attempt = 1; attempt <= MAX_EMAIL_SEND_ATTEMPTS; attempt++) {
       try {
         const response = await withTimeout(
           fetch("https://api.resend.com/emails", {
             method: "POST",
             headers: {
               Authorization: `Bearer ${apiKey}`,
               "Content-Type": "application/json",
             },
             body: JSON.stringify(resendPayload),
           }),
           CMS_TIMEOUT_MS,
           `resend_email_attempt_${attempt}`
         );
         if (response.ok) {
           sent = true;
           break;
         }
       } catch (emailErr) {
         if (attempt === MAX_EMAIL_SEND_ATTEMPTS) throw emailErr;
       }
     }
     return { status: "SUCCESS", data: { sent, recipient, documentId }, error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_EMAIL_FAIL") };
   }
 });

 export async function prepareScheduledManagerPackages(options = {}) {
   const traceId = options.traceId || makeTraceId("cron-packages");
   try {
     const now = new Date();
     const year = now.getFullYear();
     const quarter = Math.floor((now.getMonth() + 3) / 3);
     const created = await createManagerPackageVersion({ year, quarter });
     return { status: "SUCCESS", data: created?.data || null, error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "SCHEDULED_PACKAGES_FAIL") };
   }
 }