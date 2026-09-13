/*
 =============================================================================
 MODULE: pages/ADMINISTRACION.gn7mx.js
 VERSION: v5002.2-canonical-admin-page
 RESPONSIBILITY: Canonical Velo page controller for Marian Administration.
                 Declarative Command Dispatch pattern for widget actions.
 STANDARDS: G10 ASCII Strict (0 non-ASCII characters), Velo V3 SDK.
 CORRECTIONS:
   - wix-location -> wix-location-frontend (Velo V3)
   - slugUrl maintained as canonical field (user correction)
 =============================================================================
 */
 import wixMembersFrontend from "wix-members-frontend";
 import wixLocation from "wix-location-frontend";
 import { checkStaffCollaboratorAccess } from "backend/security.web";
 import { getCashierState, registerManualTransaction, registerXCount, registerZClosing } from "backend/cajas.web";
 import { getInventoryDashboard, getInventoryReconciliationQueue } from "backend/inventario.web";
 import { getQuarterlyTaxSummary, getLibroRegistroFacturasExpedidas } from "backend/fiscalAggregator.web";
 import {
   previewManagerPackage,
   createManagerPackageVersion,
   getManagerPackageHistory,
   getPreparedManagerPackages,
   downloadManagerPackageVersion,
   emailManagerPackageVersion,
 } from "backend/fiscalDocuments.web";
 import { askMarianAssistant } from "backend/marianAssistant.web";
 import { makeTraceId, URLS } from "public/mmUtils";
 import { createWidgetBridge } from "public/widgetBridge";
 const ACTIONS = {
   CASHIER_STATE: ({ payload, traceId }) => getCashierState({ traceId, diaKey: payload?.diaKey || null }),
   INVENTORY_DASH: () => getInventoryDashboard(),
   INVENTORY_QUEUE: () => getInventoryReconciliationQueue(),
   TPV_TX: ({ payload, traceId }) => registerManualTransaction({ ...payload, traceId }),
   X_COUNT: ({ payload, traceId }) => registerXCount(payload?.diaKey, { ...payload, traceId }),
   Z_CLOSING: ({ payload, traceId }) => registerZClosing(payload?.diaKey, { traceId }),
   FISCAL_SUMMARY: ({ payload, traceId }) => getQuarterlyTaxSummary(payload?.year, payload?.quarter, { traceId }),
   FISCAL_BOOK: ({ payload, traceId }) => getLibroRegistroFacturasExpedidas(payload?.year, payload?.quarter, { traceId }),
   DOCUMENT_PREVIEW: ({ payload }) => previewManagerPackage(payload),
   DOCUMENT_CREATE: ({ payload }) => createManagerPackageVersion(payload),
   DOCUMENT_HISTORY: ({ payload }) => getManagerPackageHistory(payload),
   DOCUMENT_PREPARED: () => getPreparedManagerPackages(),
   DOCUMENT_DOWNLOAD: ({ payload }) => downloadManagerPackageVersion(payload),
   DOCUMENT_EMAIL: ({ payload }) => emailManagerPackageVersion(payload),
   AI_CHAT: ({ payload, traceId }) => askMarianAssistant({ ...payload, traceId }),
 };
 $w.onReady(async function () {
   const traceId = makeTraceId("admin-page");
   const widget = $w("#htmlAdmin") || $w("#htmlAdministracion");
   if (!widget || typeof widget.postMessage !== "function") return;
   const member = await wixMembersFrontend.currentMember.getMember().catch(() => null);
   if (!member) {
     await wixMembersFrontend.authentication.promptLogin();
     return;
   }
   const accessRes = await checkStaffCollaboratorAccess(traceId).catch(() => null);
   const access = accessRes?.status === "SUCCESS" ? accessRes.data : null;
   if (!access || !access.isMarianManager) {
     wixLocation.to(URLS.SERVICIOS || "/reserva-online");
     return;
   }
   createWidgetBridge(widget, {
     slugUrl: "administracion",
     traceId,
     onContextReady: async () => {
       const [cashierRes, invRes, queueRes] = await Promise.all([
         getCashierState({ traceId }).catch(() => null),
         getInventoryDashboard().catch(() => null),
         getInventoryReconciliationQueue().catch(() => null),
       ]);
       return {
         isMarianManager: true,
         isAdmin: access.isAdmin === true,
         isCajero: access.isCajero === true,
         memberName: member.profile?.nickname || member.contactDetails?.firstName || "Marian",
         timeZone: "Europe/Madrid",
         currencyCode: "EUR",
         today: new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" }),
         cashierState: cashierRes?.status === "SUCCESS" ? cashierRes.data : null,
         inventory: invRes?.status === "SUCCESS" ? invRes.data : null,
         inventoryQueue: queueRes?.status === "SUCCESS" ? (queueRes.data?.items || []) : [],
       };
     },
     onWidgetMessage: async (msg, reply) => {
       const type = String(msg?.type || "").trim().toUpperCase();
       const handler = ACTIONS[type];
       if (!handler) {
         reply(`${type}_RES`, { status: "ERROR", error: { code: "UNKNOWN_ACTION", message: "Accion no reconocida" } });
         return;
       }
       try {
         const result = await handler({ payload: msg?.payload, traceId });
         reply(`${type}_RES`, result);
       } catch (err) {
         reply(`${type}_RES`, { status: "ERROR", error: { code: "ACTION_FAILED", message: err?.message || String(err) } });
       }
     }
   });
 });