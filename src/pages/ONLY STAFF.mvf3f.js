/*
 =============================================================================
 MODULE: pages/only-staff.js
 VERSION: v5002.2-canonical-only-staff
 RESPONSIBILITY: Staff-only panel page controller for TPV operations.
 STANDARDS: G10 ASCII Strict (0 non-ASCII characters), Velo V3 SDK.
 CORRECTIONS:
   - wix-location -> wix-location-frontend (Velo V3)
 =============================================================================
 */
 import wixLocation from "wix-location-frontend";
 import {
   MESSAGE_TYPES,
   URLS,
   UI,
   makeTraceId,
   _safeTrim,
   withTimeout,
 } from "public/mmUtils";
 import { createWidgetBridge } from "public/widgetBridge";
 import { checkStaffCollaboratorAccess } from "backend/security.web";
 let bridge = null;
 let isAuthorized = false;
 $w.onReady(async function () {
   const traceId = makeTraceId("only-staff");
   const accessRes = await withTimeout(
     checkStaffCollaboratorAccess({ traceId }),
     UI.FRONTEND_API_TIMEOUT_MS,
     "checkStaffCollaboratorAccess"
   ).catch(() => null);
   if (!accessRes || accessRes.status !== "SUCCESS" || !accessRes.data?.isStaffCollaborator) {
     console.warn("[only-staff] Access denied", { traceId });
     const accessDeniedEl = $w("#textAccessDenied");
     if (accessDeniedEl && "text" in accessDeniedEl) {
       accessDeniedEl.text = "Acceso restringido. Solo personal autorizado.";
       if (typeof accessDeniedEl.show === "function") accessDeniedEl.show();
     }
     const widgetEl = $w("#htmlOnlyStaffPanel");
     if (widgetEl && typeof widgetEl.hide === "function") widgetEl.hide();
     return;
   }
   isAuthorized = true;
   const widget = $w("#htmlOnlyStaffPanel");
   if (!widget || typeof widget.postMessage !== "function") {
     console.error("[only-staff] HTML widget not found or incompatible", { traceId });
     return;
   }
   bridge = createWidgetBridge(widget, {
     slugUrl: "only-staff",
     traceId,
     handshakeTimeoutMs: UI.HANDSHAKE_TIMEOUT_MS,
     contextTimeoutMs: UI.CONTEXT_TIMEOUT_MS,
     onContextReady: async () => {
       return {
         isAuthorized: true,
         panelType: "TPV",
       };
     },
     onWidgetMessage: async (message, reply) => {
       const type = String(message?.type || "").toUpperCase();
       const payload = message?.payload || {};
       if (type === MESSAGE_TYPES.NAV) {
         const target = _safeTrim(payload.target || "");
         if (target === "ADMIN_PANEL") {
           wixLocation.to("/administracion");
         } else if (target === "HOME") {
           wixLocation.to(URLS.SERVICIOS);
         }
         return;
       }
     },
     onError: (error) => {
       console.error("[only-staff] Widget bridge error", { traceId, error: error?.message });
     },
   });
 });