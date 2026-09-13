/*
 =============================================================================
 MODULE: backend/inventario.web.js
 VERSION: v5002.3-inventario-canonical-aligned
 RESPONSIBILITY: Inventory stock dashboard, reconciliation queue, online order
                 stock deduction, refund restock, and safety guards against
                 negative stock (Mission 4).
 CORRECTIONS APPLIED (Matriz Correspondencia):
   - INVENTARIO_PRODUCTO -> INVENTARIO_STOCK_VENTA -> "InventarioStockVenta"
   - MOVIMIENTO_INVENTARIO -> MOVIMIENTOS_INVENTARIO -> "MovimientosInventario"
   - Legacy stock reconciliation collection was removed (absorbed by
     MovimientosInventario)
     con .eq("requiresWixReconciliation", true))
   - stockActual / existenciasEsperadasUnidades -> stockExpected
   - nombreProducto -> productName
   - stockMinimo -> lowStockAlert
   - Movement fields: movementToken, movementId, locationCode, appliedByNote,
     nativeCommercialMovement, actorEmail, actorMemberId
 STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 =============================================================================
 */
 import { webMethod, Permissions } from "wix-web-module";
 import wixData from "wix-data";
 import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
 import { makeTraceId, _safeTrim, _roundMoney, _cleanText } from "public/mmUtils";
 import { requireCajero, rateLimiter } from "backend/security";
 import { _toPublicError } from "backend/responseUtils";
 import { logger } from "backend/booking/bookingCore";

 const log = logger;
 const INVENTARIO_COL = COLLECTIONS.INVENTARIO_STOCK_VENTA;
 const MOVIMIENTOS_COL = COLLECTIONS.MOVIMIENTOS_INVENTARIO;
 const API_TIMEOUT_MS = SDK_CONFIG?.TIMEOUTS?.API_MS || 15000;

 function _rateLimitOrThrow(surface, key, traceId) {
   const rl = rateLimiter({ surface, key });
   if (!rl.allowed) {
     const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
     e.code = "RATE_LIMITED";
     e.meta = { retryAfter: rl.retryAfter, surface, traceId };
     throw e;
   }
 }

 function _generateMovementToken() {
   return `MOV_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
 }

 // ============================================================================
 // GET INVENTORY DASHBOARD
 // ============================================================================
 export const getInventoryDashboard = webMethod(Permissions.SiteMember, async (options = {}) => {
   const traceId = options.traceId || makeTraceId("inv-dash");
   try {
     _rateLimitOrThrow("inventario.getInventoryDashboard", "staff", traceId);
     await requireCajero(traceId);
     const res = await wixData
       .query(INVENTARIO_COL)
       .eq("active", true)
       .limit(100)
       .find({ suppressAuth: true });
     const items = res?.items || [];
     const lowStock = items.filter((i) => Number(i.stockExpected ?? 0) <= Number(i.lowStockAlert || 0));
     return {
       status: "SUCCESS",
       data: {
         totalProducts: items.length,
         lowStockCount: lowStock.length,
         products: items.map((i) => ({
           _id: i._id,
           sku: i.sku || "",
           productName: i.productName || "",
           stockExpected: Number(i.stockExpected ?? 0),
           lowStockAlert: Number(i.lowStockAlert || 0),
           category: i.category || "",
           supplier: i.supplier || "",
           active: i.active !== false,
         })),
         lowStockItems: lowStock.map((i) => ({
           sku: i.sku || "",
           productName: i.productName || "",
           stockExpected: Number(i.stockExpected ?? 0),
           lowStockAlert: Number(i.lowStockAlert || 0),
         })),
       },
       error: null,
     };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "INVENTORY_DASH_FAIL") };
   }
 });

 // ============================================================================
 // GET INVENTORY RECONCILIATION QUEUE (absorbed from the legacy stock reconciliation collection)
 // ============================================================================
 export const getInventoryReconciliationQueue = webMethod(Permissions.SiteMember, async (options = {}) => {
   const traceId = options.traceId || makeTraceId("inv-queue");
   try {
     _rateLimitOrThrow("inventario.getInventoryReconciliationQueue", "staff", traceId);
     await requireCajero(traceId);
     const res = await wixData
       .query(MOVIMIENTOS_COL)
       .eq("requiresWixReconciliation", true)
       .descending("appliedAt")
       .limit(100)
       .find({ suppressAuth: true });
     const items = res?.items || [];
     return {
       status: "SUCCESS",
       data: { items, total: items.length },
       error: null,
     };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "INVENTORY_QUEUE_FAIL") };
   }
 });

 // ============================================================================
 // RECORD ONLINE INVENTORY ORDER (Wix eCommerce order placed)
 // ============================================================================
 export async function recordOnlineInventoryOrderInternal(order, traceId) {
   const orderId = _safeTrim(order?._id || order?.id || "");
   if (!orderId) return { status: "SKIPPED", reason: "NO_ORDER_ID" };
   const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
   if (lineItems.length === 0) return { status: "SKIPPED", reason: "NO_LINE_ITEMS" };
   let recorded = 0;
   for (const item of lineItems) {
     const sku = _safeTrim(item.sku || "");
     const quantity = Number(item.quantity || 1);
     if (!sku || quantity <= 0) continue;
     const productRes = await wixData
       .query(INVENTARIO_COL)
       .eq("sku", sku)
       .limit(1)
       .find({ suppressAuth: true })
       .catch(() => null);
     const product = productRes?.items?.[0];
     if (!product) continue;
     const currentStock = Number(product.stockExpected ?? 0);
     const newStock = Math.max(0, currentStock - quantity);
     const movementToken = _generateMovementToken();
     const movement = {
       _id: movementToken,
       movementToken,
       movementId: movementToken,
       sku,
       productId: product.wixProductId || null,
       variantId: product.wixVariantId || null,
       wixProductId: product.wixProductId || null,
       wixVariantId: product.wixVariantId || null,
       movementType: "VENTA_ONLINE",
       quantity: quantity,
       quantityDelta: -quantity,
       stockBefore: currentStock,
       stockAfter: newStock,
       stockExpected: newStock,
       locationCode: product.location || null,
       status: "APPLIED",
       appliedAt: new Date(),
       appliedByNote: "Wix eCommerce Order",
       requiresWixReconciliation: false,
       nativeCommercialMovement: true,
       orderId,
       refundId: null,
       referenceId: orderId,
       reason: null,
       note: `Online order ${orderId}`,
       source: "WIX_ECOM_ORDER",
       productName: product.productName || "",
       actorEmail: null,
       actorMemberId: null,
       traceId,
       _createdDate: new Date(),
     };
     await wixData.insert(MOVIMIENTOS_COL, movement, { suppressAuth: true });
     const { _createdDate, _updatedDate, _owner, ...safeProduct } = product;
     await wixData.update(INVENTARIO_COL, {
       ...safeProduct,
       stockExpected: newStock,
       lastInventoryMovementId: movementToken,
       lastInventoryMovementAt: new Date(),
       _updatedDate: new Date(),
     }, { suppressAuth: true });
     recorded++;
   }
   return { status: "SUCCESS", data: { recorded }, error: null };
 }

 // ============================================================================
 // RECORD ONLINE INVENTORY REFUND (Wix eCommerce refund with restock)
 // ============================================================================
 export async function recordOnlineInventoryRefundInternal(order, refundObj, restockInfo, traceId) {
   const orderId = _safeTrim(order?._id || order?.id || "");
   const refundId = _safeTrim(refundObj?._id || refundObj?.id || "");
   if (!orderId || !refundId) return { status: "SKIPPED", reason: "NO_ORDER_OR_REFUND_ID" };
   const hasRestock = restockInfo && Object.keys(restockInfo).length > 0;
   if (!hasRestock) return { status: "SKIPPED", reason: "NO_CONFIRMED_RESTOCK" };
   let recorded = 0;
   const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
   for (const item of lineItems) {
     const sku = _safeTrim(item.sku || "");
     const quantity = Number(item.quantity || 1);
     if (!sku || quantity <= 0) continue;
     const restockQty = Number(restockInfo?.[sku] || 0);
     if (restockQty <= 0) continue;
     const productRes = await wixData
       .query(INVENTARIO_COL)
       .eq("sku", sku)
       .limit(1)
       .find({ suppressAuth: true })
       .catch(() => null);
     const product = productRes?.items?.[0];
     if (!product) continue;
     const currentStock = Number(product.stockExpected ?? 0);
     const newStock = currentStock + restockQty;
     const movementToken = _generateMovementToken();
     const movement = {
       _id: movementToken,
       movementToken,
       movementId: movementToken,
       sku,
       productId: product.wixProductId || null,
       variantId: product.wixVariantId || null,
       wixProductId: product.wixProductId || null,
       wixVariantId: product.wixVariantId || null,
       movementType: "REEMBOLSO_RESTOCK",
       quantity: restockQty,
       quantityDelta: restockQty,
       stockBefore: currentStock,
       stockAfter: newStock,
       stockExpected: newStock,
       locationCode: product.location || null,
       status: "APPLIED",
       appliedAt: new Date(),
       appliedByNote: "Wix eCommerce Refund Restock",
       requiresWixReconciliation: false,
       nativeCommercialMovement: true,
       orderId,
       refundId,
       referenceId: refundId,
       reason: null,
       note: `Refund ${refundId} restock`,
       source: "WIX_ECOM_REFUND",
       productName: product.productName || "",
       actorEmail: null,
       actorMemberId: null,
       traceId,
       _createdDate: new Date(),
     };
     await wixData.insert(MOVIMIENTOS_COL, movement, { suppressAuth: true });
     const { _createdDate, _updatedDate, _owner, ...safeProduct } = product;
     await wixData.update(INVENTARIO_COL, {
       ...safeProduct,
       stockExpected: newStock,
       lastInventoryMovementId: movementToken,
       lastInventoryMovementAt: new Date(),
       _updatedDate: new Date(),
     }, { suppressAuth: true });
     recorded++;
   }
   return { status: "SUCCESS", data: { recorded }, error: null };
 }

 // ============================================================================
 // RECORD INVENTORY MOVEMENT SAFE (manual adjustment with stock guard)
 // ============================================================================
 export async function recordInventoryMovementSafe(sku, type, quantity, meta = {}) {
   const traceId = meta.traceId || makeTraceId("inv-mov");
   const cleanSku = _safeTrim(sku);
   const qty = Number(quantity || 0);
   if (!cleanSku || qty <= 0) {
     throw new Error("INVALID_PARAMS: sku and positive quantity required");
   }
   const productRes = await wixData
     .query(INVENTARIO_COL)
     .eq("sku", cleanSku)
     .limit(1)
     .find({ suppressAuth: true })
     .catch(() => null);
   const product = productRes?.items?.[0];
   if (!product) {
     throw new Error(`PRODUCT_NOT_FOUND: SKU ${cleanSku} not in inventory`);
   }
   const currentStock = Number(product.stockExpected ?? 0);
   if (type === "SALIDA" && qty > currentStock) {
     const movementToken = _generateMovementToken();
     await wixData.insert(MOVIMIENTOS_COL, {
       _id: movementToken,
       movementToken,
       movementId: movementToken,
       sku: cleanSku,
       productId: product.wixProductId || null,
       variantId: product.wixVariantId || null,
       wixProductId: product.wixProductId || null,
       wixVariantId: product.wixVariantId || null,
       movementType: "DISCREPANCIA_STOCK_INSUFICIENTE",
       quantity: qty,
       quantityDelta: 0,
       stockBefore: currentStock,
       stockAfter: currentStock,
       stockExpected: currentStock,
       locationCode: product.location || null,
       status: "REJECTED",
       appliedAt: new Date(),
       appliedByNote: meta.actorEmail || "SYSTEM",
       requiresWixReconciliation: true,
       nativeCommercialMovement: false,
       orderId: null,
       refundId: null,
       referenceId: null,
       reason: "Intento de salida superior a existencias disponibles",
       note: meta.note || null,
       source: meta.source || "MANUAL_ADJUSTMENT",
       productName: product.productName || "",
       actorEmail: meta.actorEmail || null,
       actorMemberId: meta.actorMemberId || null,
       traceId,
       _createdDate: new Date(),
     }, { suppressAuth: true });
     throw new Error(`STOCK_INSUFICIENTE: Stock actual (${currentStock}) inferior a salida (${qty})`);
   }
   const newStock = type === "SALIDA" ? currentStock - qty : currentStock + qty;
   const movementToken = _generateMovementToken();
   await wixData.update(INVENTARIO_COL, {
     ...product,
     stockExpected: newStock,
     lastInventoryMovementId: movementToken,
     lastInventoryMovementAt: new Date(),
     _updatedDate: new Date(),
   }, { suppressAuth: true });
   await wixData.insert(MOVIMIENTOS_COL, {
     _id: movementToken,
     movementToken,
     movementId: movementToken,
     sku: cleanSku,
     productId: product.wixProductId || null,
     variantId: product.wixVariantId || null,
     wixProductId: product.wixProductId || null,
     wixVariantId: product.wixVariantId || null,
     movementType: type,
     quantity: qty,
     quantityDelta: type === "SALIDA" ? -qty : qty,
     stockBefore: currentStock,
     stockAfter: newStock,
     stockExpected: newStock,
     locationCode: product.location || null,
     status: "APPLIED",
     appliedAt: new Date(),
     appliedByNote: meta.actorEmail || "SYSTEM",
     requiresWixReconciliation: false,
     nativeCommercialMovement: false,
     orderId: null,
     refundId: null,
     referenceId: meta.referenceId || null,
     reason: meta.reason || null,
     note: meta.note || null,
     source: meta.source || "MANUAL_ADJUSTMENT",
     productName: product.productName || "",
     actorEmail: meta.actorEmail || null,
     actorMemberId: meta.actorMemberId || null,
     traceId,
     _createdDate: new Date(),
   }, { suppressAuth: true });
   return { ok: true, sku: cleanSku, stockBefore: currentStock, stockAfter: newStock };
 }

 // ============================================================================
 // GET PREPARED MANAGER PACKAGES (inventory closing records)
 // ============================================================================
 export const getPreparedManagerPackages = webMethod(Permissions.SiteMember, async (options = {}) => {
   const traceId = options.traceId || makeTraceId("doc-prep");
   try {
     _rateLimitOrThrow("inventario.getPreparedManagerPackages", "staff", traceId);
     await requireCajero(traceId);
     const res = await wixData
       .query(COLLECTIONS.INVENTARIO_STOCK_VENTA_CIERRE)
       .descending("_createdDate")
       .limit(20)
       .find({ suppressAuth: true });
     return { status: "SUCCESS", data: { items: res?.items || [] }, error: null };
   } catch (err) {
     return { status: "ERROR", data: null, error: _toPublicError(err, "DOC_PREP_FAIL") };
   }
 });