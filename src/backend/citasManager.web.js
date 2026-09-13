/**
MODULE: backend/citasManager.web.js
VERSION: v5003.0-canonical-clean
FIXES APPLIED:
  [M-01] Eliminado uso de CITA_FIELDS.STATUS_PAGO_LEGACY
  [M-02] Usa solo CITA_FIELDS.STATUS_PAGO
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
*/
import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { orders } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import {
  makeTraceId,
  _safeTrim,
  _safeEmail,
  _looksLikeGuid,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  withTimeout,
  _executeWithRetry,
  _roundMoney,
  _extractRelationalId,
} from "public/mmUtils";
import {
  COLLECTIONS,
  APP_IDS,
  SDK_CONFIG,
  CONCURRENCY,
  CITA_FIELDS,
  ESTADO_CITA,
  ESTADO_PAGO,
} from "backend/internalConfig";
import {
  rescheduleBookingElevated,
  _projectWriterSlotFromAvailability,
  _lockSlotKeyOrFail,
  _unlockSlotKey,
  _renewLock,
  _generateSlotKey,
  _handleError,
  _updateCitaSafe,
  logger,
  _bestEffortUnlockAll,
} from "backend/booking/bookingCore";
import { executeBookingSaga } from "backend/booking/bookingSaga";
import { registerBookingPayment, queueFiscalRecovery } from "backend/cajas.web";
import { requireAdmin, isAdmin, rateLimiter } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { getServiceForBookingInternal, _invalidateCachesInternal, revalidateExactAvailabilitySlot } from "backend/reservas.web";

const log = logger;
const CITAS_COLLECTION = COLLECTIONS.CITAS_F2;
const AUDIT_LOG_COL = COLLECTIONS.MM_AUDIT_LOG;
const API_TIMEOUT_MS = SDK_CONFIG?.TIMEOUTS?.API_MS || 15000;
const getOrderElevated = elevate(orders.getOrder);

function _getCitaMeta(cita) {
  const meta = cita?.meta;
  if (meta && typeof meta === "object") return meta;
  if (typeof meta === "string") {
    try {
      return JSON.parse(meta) || {};
    } catch (_) {}
  }
  return {};
}

function _getNativeAddonIdsForRevalidation(cita) {
  if (String(cita?.bookingType || "") === "dual_fase2") return [];
  const bookedAddOns = Array.isArray(_getCitaMeta(cita).nativeBookedAddOns) ? _getCitaMeta(cita).nativeBookedAddOns : [];
  return Array.from(new Set(
    bookedAddOns
      .map((addon) => _safeTrim(addon?._id || addon))
      .filter((addonId) => _looksLikeGuid(addonId))
  )).sort();
}

async function _findCitaByBookingId(bookingId) {
  const clean = String(bookingId || "").trim();
  if (!clean) return null;
  try {
    const q = await withTimeout(
      wixData.query(CITAS_COLLECTION).eq("bookingId", clean).limit(1).find({ suppressAuth: true, consistentRead: true, skipCache: true }),
      API_TIMEOUT_MS,
      "findCitaByBookingIdQuery"
    ).catch(() => null);
    if (q?.items?.length) return q.items[0];
    const byId = await withTimeout(
      wixData.get(CITAS_COLLECTION, clean, { suppressAuth: true, consistentRead: true, skipCache: true }),
      API_TIMEOUT_MS,
      "findCitaByBookingIdGet"
    ).catch(() => null);
    return byId || null;
  } catch (_) {
    return null;
  }
}

async function _logAuditEvent(tipoEvento, level, message, data = {}, traceId) {
  try {
    await withTimeout(
      wixData.insert(
        AUDIT_LOG_COL, {
          _id: `AUDIT-${tipoEvento}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          tipoEvento,
          level,
          message,
          data,
          resourceId: "SYSTEM",
          source: "backend/citasManager.web.js",
          loggedAt: new Date(),
          traceId,
        }, { suppressAuth: true }
      ),
      API_TIMEOUT_MS,
      "logAuditEvent"
    );
  } catch (err) {
    log.error("Failed to write to AUDIT_LOG", { error: err?.message || String(err), traceId });
  }
}

export const processDualBooking = webMethod(Permissions.Anyone, async (unsafePayload) => {
  const traceId = makeTraceId("booking-wrapper");
  try {
    if (!unsafePayload || typeof unsafePayload !== "object") throw new Error("Invalid booking payload");
    if (!unsafePayload.cliente || typeof unsafePayload.cliente !== "object") throw new Error("Client information required");
    if (!unsafePayload.metaCita || typeof unsafePayload.metaCita !== "object") throw new Error("Booking metadata required");
    const slotF1 = unsafePayload.slotF1 || {};
    const slotF2 = unsafePayload.slotF2 || null;
    const metaCita = unsafePayload.metaCita;
    const serviceId = _extractRelationalId(
      slotF1.serviceId ||
      metaCita.serviceId ||
      metaCita.primaryServiceId ||
      unsafePayload.primaryServiceId ||
      ""
    );
    if (!_looksLikeGuid(serviceId)) {
      return { status: "ERROR", data: null, error: { code: "SERVICE_ID_INVALID", message: "The first booking phase requires a valid serviceId." } };
    }
    if (Object.prototype.hasOwnProperty.call(metaCita, "resourceId")) {
      return { status: "ERROR", data: null, error: { code: "RESOURCE_CONTRACT_INVALID", message: "Booking metadata must use resourceFilterId." } };
    }
    unsafePayload.slotF1 = { ...slotF1, serviceId };
    unsafePayload.slotF2 = slotF2 ? { ...slotF2 } : null;
    unsafePayload.metaCita = { ...metaCita, serviceId };
    const requestedStart = _safeTrim(slotF1.localStartDate || slotF1.startDate || "");
    const requestedResourceId = _safeTrim(slotF1.resourceId || slotF1.resource?.id || "");
    const rateKey = `${serviceId}:${requestedStart || "no-start"}:${requestedResourceId || "any-resource"}`;
    const rate = rateLimiter(
      { surface: "public-booking", key: rateKey },
      Number(SDK_CONFIG?.RATE_LIMIT?.BOOKING_MAX_REQUESTS),
      Number(SDK_CONFIG?.RATE_LIMIT?.BOOKING_WINDOW_MS)
    );
    if (!rate.allowed) {
      return {
        status: "ERROR",
        data: { retryAfterMs: rate.retryAfter },
        error: { code: "RATE_LIMITED", message: "Too many booking requests. Retry later." },
      };
    }
    return await executeBookingSaga({ ...unsafePayload, traceId });
  } catch (error) {
    return _handleError(error, { surface: "processDualBooking(wrapper)", traceId });
  }
});

function _isPaidOrderStatus(value) {
  const status = String(value || "").toUpperCase();
  return ["PAID", "FULLY_PAID", "PAID_FULL"].includes(status);
}

function _getOrderBookingLineItems(order) {
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  return lineItems.filter((item) => item?.catalogReference?.appId === APP_IDS.BOOKINGS);
}

function _getBookingLineItemsTotal(lineItems) {
  return (lineItems || []).reduce((sum, item) => {
    const itemPrice = Number(item?.price?.amount ?? item?.price ?? item?.totalPrice?.amount ?? 0) || 0;
    const quantity = Number(item?.quantity) || 1;
    return sum + (itemPrice * quantity);
  }, 0);
}

async function _getValidatedPaidOrder(orderId, bookingIds, requestedTotalAmount) {
  const order = await withTimeout(getOrderElevated(orderId), API_TIMEOUT_MS, "orders.getOrder");
  if (!order || !_isPaidOrderStatus(order.paymentStatus)) {
    throw new Error("ORDER_NOT_PAID");
  }
  const bookingLineItems = _getOrderBookingLineItems(order);
  const orderBookingIds = new Set(
    bookingLineItems.map((item) => _safeTrim(item?.catalogReference?.catalogItemId)).filter(Boolean)
  );
  const requestedIds = Array.from(new Set((bookingIds || []).map((id) => _safeTrim(id)).filter(Boolean)));
  if (!requestedIds.length || requestedIds.some((bookingId) => !orderBookingIds.has(bookingId))) {
    throw new Error("ORDER_BOOKING_MISMATCH");
  }
  const verifiedAmount = _getBookingLineItemsTotal(bookingLineItems);
  if (!(verifiedAmount > 0)) throw new Error("ORDER_BOOKING_AMOUNT_INVALID");
  const requestedAmount = Number(requestedTotalAmount);
  if (Number.isFinite(requestedAmount) && requestedAmount > 0 && Math.abs(requestedAmount - verifiedAmount) > 0.009) {
    throw new Error("ORDER_AMOUNT_MISMATCH");
  }
  return { order, verifiedAmount: _roundMoney(verifiedAmount) };
}

function _validatePaymentCitaSet(citas, orderId) {
  const items = Array.isArray(citas) ? citas : [];
  const isDual = items.some((cita) => Boolean(_getCitaMeta(cita).esCombinado) || String(cita?.bookingType || "").startsWith("dual"));
  const pairTokens = Array.from(new Set(items.map((cita) => _safeTrim(cita?.pairToken || _getCitaMeta(cita).pairToken)).filter(Boolean)));
  if (isDual && (items.length !== 2 || pairTokens.length !== 1)) throw new Error("DUAL_PAYMENT_PAIR_INVALID");
  if (!isDual && items.length !== 1) throw new Error("PAYMENT_BOOKING_SET_INVALID");
  // [M-01] [M-02] Usa solo CITA_FIELDS.STATUS_PAGO
  const paidStates = items.map((cita) => String(cita[CITA_FIELDS.STATUS_PAGO] || _getCitaMeta(cita)[CITA_FIELDS.STATUS_PAGO] || "").toUpperCase());
  const allPaid = paidStates.length > 0 && paidStates.every((state) => state === ESTADO_PAGO.PAID);
  const storedOrderIds = Array.from(new Set(items.map((cita) => _safeTrim(_getCitaMeta(cita).orderId)).filter(Boolean)));
  if (allPaid && storedOrderIds.length > 0 && (storedOrderIds.length !== 1 || storedOrderIds[0] !== orderId)) {
    throw new Error("ORDER_IDEMPOTENCY_CONFLICT");
  }
  return { isDual, allPaid };
}

async function _setCitasPaymentState(citas, paymentState, orderId, traceId) {
  for (const cita of citas) {
    await _updateCitaSafe(cita.bookingId, (item) => {
      const meta = item.meta || {};
      return {
        ...item,
        ...(paymentState === ESTADO_PAGO.PAID ? { [CITA_FIELDS.STATUS]: ESTADO_CITA.CONFIRMED } : {}),
        [CITA_FIELDS.STATUS_PAGO]: paymentState,
        meta: {
          ...meta,
          [CITA_FIELDS.STATUS_PAGO]: paymentState,
          orderId,
          ...(paymentState === ESTADO_PAGO.PAID ? { fechaConfirmacionPago: new Date() } : { fechaPagoRecibido: new Date() }),
        },
      };
    }, traceId, "setCitasPaymentState");
  }
}

export const confirmPayment = webMethod(Permissions.Admin, async (payload = {}) => {
  const traceId = makeTraceId("payment");
  try {
    await requireAdmin(traceId);
    const bookingIds = Array.from(new Set(
      Array.isArray(payload.bookingIds)
        ? payload.bookingIds.map((id) => _safeTrim(id)).filter(Boolean)
        : [_safeTrim(payload.bookingIdF1), _safeTrim(payload.bookingIdF2)].filter(Boolean)
    ));
    if (!bookingIds.length) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PAYLOAD", message: "No booking IDs provided" } };
    }
    const orderId = _safeTrim(payload.orderId);
    if (!orderId) {
      return { status: "ERROR", data: null, error: { code: "ORDER_ID_REQUIRED", message: "A Wix orderId is required" } };
    }
    const citas = [];
    for (const bookingId of bookingIds) {
      const cita = await _findCitaByBookingId(bookingId);
      if (!cita) {
        return { status: "ERROR", data: null, error: { code: "BOOKING_NOT_FOUND", message: "Booking is not registered in CitasF2" } };
      }
      citas.push(cita);
    }
    const { verifiedAmount } = await _getValidatedPaidOrder(orderId, bookingIds, payload.totalAmount);
    const paymentSet = _validatePaymentCitaSet(citas, orderId);
    if (paymentSet.allPaid) {
      return { status: "SUCCESS", data: { ok: true, bookingIds, verifiedAmount, idempotent: true }, error: null };
    }
    const linkedBookingIds = bookingIds.join(",");
    await _setCitasPaymentState(citas, ESTADO_PAGO.PENDING_LEDGER, orderId, traceId);
    const ledgerRes = await registerBookingPayment(linkedBookingIds, verifiedAmount, "ONLINE", {
      concept: `Online payment - Order ${orderId}`,
      resourceId: "online",
      traceId,
      transactionId: `ORDER-${orderId}`,
      orderId,
      origen: "ADMIN_ORDER_CONFIRMATION",
      tipoMovimiento: "VENTA_ONLINE",
    });
    if (ledgerRes?.status !== "SUCCESS") {
      await queueFiscalRecovery({
        bookingIds: linkedBookingIds,
        amount: verifiedAmount,
        paymentMethod: "ONLINE",
        transactionId: `ORDER-${orderId}`,
        orderId,
        origin: "ADMIN_ORDER_CONFIRMATION",
        concept: `Online payment - Order ${orderId}`,
        resourceId: "online",
        tipoMovimiento: "VENTA_ONLINE",
        traceId,
        lastError: ledgerRes?.error?.message || "LEDGER_REGISTRATION_FAILED",
      });
      await _logAuditEvent(
        "LEDGER_REGISTRATION_FAILED",
        "ERROR",
        `Ledger registration queued for order ${orderId}`,
        { orderId, bookingIds, ledgerError: ledgerRes?.error || "Unknown ledger error", traceId },
        traceId
      );
      return {
        status: "PARTIAL",
        data: { ok: false, bookingIds, paymentState: ESTADO_PAGO.PENDING_LEDGER, verifiedAmount },
        error: { code: "LEDGER_PENDING_RECOVERY", message: "Fiscal registration is pending recovery" },
      };
    }
    await _setCitasPaymentState(citas, ESTADO_PAGO.PAID, orderId, traceId);
    return { status: "SUCCESS", data: { ok: true, bookingIds, verifiedAmount }, error: null };
  } catch (error) {
    log.error("Error in confirmPayment(wrapper)", { error: error?.message, traceId });
    return { status: "ERROR", data: null, error: _toPublicError(error, "CONFIRM_PAYMENT_FAIL", "No se pudo confirmar el pago.") };
  }
});

export const rescheduleExistingBooking = webMethod(Permissions.SiteMember, async (bookingId, newSlot, revision) => {
  const traceId = makeTraceId("reschedule");
  try {
    const cleanBookingId = _safeTrim(bookingId);
    if (!cleanBookingId || !newSlot) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PAYLOAD", message: "bookingId and newSlot are required" } };
    }
    const citaExistente = await _findCitaByBookingId(cleanBookingId);
    if (!citaExistente) {
      return { status: "ERROR", data: null, error: { code: "BOOKING_NOT_FOUND", message: "Booking not found" } };
    }
    if (Boolean(citaExistente.meta?.esCombinado) || String(citaExistente.bookingType || "").startsWith("dual")) {
      return {
        status: "ERROR",
        data: null,
        error: { code: "DUAL_RESCHEDULE_REQUIRES_PAIRED_SLOTS", message: "Use rescheduleDualBookings with both phase slots." },
      };
    }
    const memberIsAdmin = await isAdmin(traceId).catch(() => false);
    if (!memberIsAdmin) {
      const { currentMember } = await import("wix-members-backend");
      const member = await currentMember.getMember({ fieldsets: ["FULL"] }).catch(() => null);
      if (!member) {
        return { status: "ERROR", data: null, error: { code: "AUTH_REQUIRED", message: "Could not identify logged-in user" } };
      }
      const memberId = _safeTrim(member._id || member.id);
      const memberEmail = member?.loginEmail ? _safeEmail(member.loginEmail) : "";
      const citaMemberId = _safeTrim(citaExistente?.contactDetails?.contactId || citaExistente?.contactDetails?.memberId || citaExistente?._owner || "");
      const contactEmail = _safeEmail(citaExistente.contactDetails?.email || "");
      const isMemberMatch = Boolean(memberId && citaMemberId && memberId === citaMemberId);
      const isEmailMatch = Boolean(memberEmail && contactEmail && memberEmail === contactEmail);
      if (!isMemberMatch && !isEmailMatch) {
        return {
          status: "ERROR",
          data: null,
          error: { code: "ACCESS_DENIED", message: "You do not own this booking or do not have permission to modify it." },
        };
      }
    }
    let rev = Number(revision) || 0;
    if (!rev) rev = Number(citaExistente?.revision || 1) || 1;
    const slotObj = newSlot?.slot || newSlot;
    const serviceId = _extractRelationalId(citaExistente.serviceId);
    const requestedServiceId = _extractRelationalId(slotObj.serviceId || slotObj?.slot?.serviceId || "");
    const resourceIdForReschedule = _safeTrim(slotObj.resourceId || slotObj.resource?.id || slotObj.resource?._id || "");
    if (!_looksLikeGuid(serviceId)) {
      return { status: "ERROR", data: null, error: { code: "STORED_SERVICE_INVALID", message: "The stored serviceId is invalid." } };
    }
    if (requestedServiceId && requestedServiceId !== serviceId) {
      return { status: "ERROR", data: null, error: { code: "SERVICE_MISMATCH", message: "The requested slot does not match the stored service." } };
    }
    if (!resourceIdForReschedule) {
      return { status: "ERROR", data: null, error: { code: "INVALID_SLOT", message: "Missing resourceId for reschedule" } };
    }
    const pristineSlot = await _projectWriterSlotFromAvailability(slotObj, resourceIdForReschedule, serviceId);
    if (!pristineSlot) {
      return { status: "ERROR", data: null, error: { code: "INVALID_SLOT", message: "Slot format invalid for V2 engine" } };
    }
    const exactSlot = await revalidateExactAvailabilitySlot({
      serviceId,
      localStartDate: getMadridLocalStringNoZ(pristineSlot.startDate),
      localEndDate: getMadridLocalStringNoZ(pristineSlot.endDate),
      resourceId: resourceIdForReschedule,
      nativeAddonIds: _getNativeAddonIdsForRevalidation(citaExistente),
      traceId,
    });
    if (exactSlot?.status !== "SUCCESS" || !exactSlot?.data?.slot) {
      return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: exactSlot?.error?.message || "The selected slot is no longer available." } };
    }
    const res = await _executeWithRetry(
      () => withTimeout(
        rescheduleBookingElevated(cleanBookingId, pristineSlot, {
          revision: String(rev),
          flowControlSettings: { ignoreReschedulePolicy: false },
        }),
        API_TIMEOUT_MS,
        "rescheduleBooking"
      ),
      3,
      500
    );
    const updatedBooking = res?.booking || res;
    const newRevision = Number(updatedBooking?.revision || rev || 1) || 1;
    const startUtc = getUtcDateFromMadridLocal(pristineSlot.startDate);
    const endUtc = getUtcDateFromMadridLocal(pristineSlot.endDate);
    const startDateLocal = getMadridLocalStringNoZ(startUtc);
    const endDateLocal = getMadridLocalStringNoZ(endUtc);
    if (!startUtc || !endUtc || !startDateLocal || !endDateLocal) {
      return { status: "ERROR", data: null, error: { code: "INVALID_SLOT", message: "The reschedule slot has invalid Madrid dates." } };
    }
    await _updateCitaSafe(cleanBookingId, (item) => ({
      ...item,
      startDate: startUtc,
      endDate: endUtc,
      startDateLocal,
      endDateLocal,
      dateYmd: startDateLocal.slice(0, 10),
      resourceId: resourceIdForReschedule,
      revision: newRevision,
    }), traceId, "rescheduleExistingBooking");
    const oldDateYMD = String(citaExistente.startDateLocal || citaExistente.dateYmd || "").slice(0, 10);
    const oldResourceId = _safeTrim(citaExistente.resourceId);
    const newDateYMD = startDateLocal.slice(0, 10);
    try {
      await _invalidateCachesInternal(serviceId, oldDateYMD, oldResourceId || resourceIdForReschedule, traceId);
      if (newDateYMD && (newDateYMD !== oldDateYMD || oldResourceId !== resourceIdForReschedule)) {
        await _invalidateCachesInternal(serviceId, newDateYMD, resourceIdForReschedule, traceId);
      }
    } catch (cacheErr) {
      log.warn("rescheduleExistingBooking: Cache invalidation failed (best-effort)", { traceId, error: cacheErr?.message });
    }
    return {
      status: "SUCCESS",
      data: {
        bookingId: cleanBookingId,
        revision: newRevision,
        startDate: pristineSlot.startDate,
        endDate: pristineSlot.endDate,
        resourceId: resourceIdForReschedule,
      },
      error: null,
    };
  } catch (error) {
    log.error("Error in rescheduleExistingBooking(wrapper)", { error: error?.message, traceId });
    return _handleError(error, { surface: "rescheduleExistingBooking(wrapper)", traceId });
  }
});

function _getDualSlotInput(payload, key) {
  const slot = key === "F1" ? payload?.slotF1 : payload?.slotF2;
  if (!slot || typeof slot !== "object") return null;
  return slot.slotRef || slot.slot || slot;
}

function _matchesCitaPairIdentifier(cita, token) {
  const expected = _safeTrim(token);
  if (!expected) return false;
  return [
    cita?.pairToken,
    cita?.uiPairToken,
    cita?.meta?.pairToken,
    cita?.meta?.uiPairToken,
  ].some((value) => _safeTrim(value) === expected);
}

function _getBookingSlotFromCita(cita) {
  const serviceId = _extractRelationalId(cita?.serviceId);
  const resourceId = _safeTrim(cita?.resourceId);
  const startDate = cita?.startDate;
  const endDate = cita?.endDate;
  if (!serviceId || !resourceId || !startDate || !endDate) return null;
  return {
    serviceId: serviceId,
    scheduleId: _safeTrim(cita?.scheduleId),
    startDate,
    endDate,
    timezone: SDK_CONFIG?.TZ,
    resource: { _id: resourceId },
    location: { _id: SDK_CONFIG?.LOCATION_ID, locationType: SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER },
  };
}

async function _buildDualRescheduleSlot(cita, inputSlot, expectedServiceId) {
  const rawSlot = inputSlot?.slot || inputSlot;
  const resourceId = _safeTrim(rawSlot?.resourceId || rawSlot?.resource?._id || rawSlot?.resource?.id || "");
  const canonicalServiceId = _extractRelationalId(expectedServiceId || "");
  if (!resourceId || !_looksLikeGuid(canonicalServiceId)) throw new Error("DUAL_RESCHEDULE_SLOT_ID_INVALID");
  const pristine = await _projectWriterSlotFromAvailability(rawSlot, resourceId, canonicalServiceId);
  if (!pristine) throw new Error("DUAL_RESCHEDULE_SLOT_INVALID");
  return pristine;
}

async function _assertBookingOwner(cita, traceId) {
  const memberIsAdmin = await isAdmin(traceId).catch(() => false);
  if (memberIsAdmin) return;
  const { currentMember } = await import("wix-members-backend");
  const member = await currentMember.getMember({ fieldsets: ["FULL"] }).catch(() => null);
  if (!member) throw new Error("ACCESS_DENIED_DUAL_RESCHEDULE");
  const memberId = _safeTrim(member._id || member.id);
  const memberEmail = member?.loginEmail ? _safeEmail(member.loginEmail) : "";
  const citaMemberId = _safeTrim(cita?.contactDetails?.contactId || cita?.contactDetails?.memberId || cita?._owner || "");
  const contactEmail = _safeEmail(cita?.contactDetails?.email || "");
  const isMemberMatch = Boolean(memberId && citaMemberId && memberId === citaMemberId);
  const isEmailMatch = Boolean(memberEmail && contactEmail && memberEmail === contactEmail);
  if (!isMemberMatch && !isEmailMatch) {
    throw new Error("ACCESS_DENIED_DUAL_RESCHEDULE");
  }
}

export const rescheduleDualBookings = webMethod(Permissions.SiteMember, async (payload = {}) => {
  const traceId = makeTraceId("reschedule-dual");
  const lockOwnerId = `${traceId}:${_safeTrim(payload.pairToken)}`;
  const lockKeys = [];
  let heartbeatInterval = null;
  let lockLeaseLost = false;
  try {
    const pairToken = _safeTrim(payload.pairToken);
    const slotF1Input = _getDualSlotInput(payload, "F1");
    const slotF2Input = _getDualSlotInput(payload, "F2");
    if (!pairToken || !slotF1Input || !slotF2Input) {
      return { status: "ERROR", data: null, error: { code: "DUAL_RESCHEDULE_PAYLOAD_INVALID", message: "pairToken, slotF1, and slotF2 are required." } };
    }
    const queryPair = async (field) => await wixData
      .query(CITAS_COLLECTION)
      .eq(field, pairToken)
      .limit(10)
      .find({ suppressAuth: true, consistentRead: true });
    let pairItems = (await queryPair("pairToken"))?.items || [];
    if (pairItems.length !== 2) {
      pairItems = (await queryPair("uiPairToken"))?.items || [];
    }
    if (pairItems.length !== 2) {
      return { status: "ERROR", data: null, error: { code: "DUAL_PAIR_NOT_FOUND", message: "Expected exactly two linked bookings." } };
    }
    const citaF1 = pairItems.find((item) => String(item.bookingType || "") !== "dual_fase2") || pairItems[0];
    const citaF2 = pairItems.find((item) => String(item.bookingType || "") === "dual_fase2");
    if (!citaF1 || !citaF2 || !_matchesCitaPairIdentifier(citaF1, pairToken) || !_matchesCitaPairIdentifier(citaF2, pairToken)) {
      return { status: "ERROR", data: null, error: { code: "DUAL_PAIR_INTEGRITY_INVALID", message: "Linked phase records are inconsistent." } };
    }
    await _assertBookingOwner(citaF1, traceId);
    const serviceId = _extractRelationalId(citaF1?.serviceId || "");
    if (!_looksLikeGuid(serviceId)) {
      return { status: "ERROR", data: null, error: { code: "DUAL_RESCHEDULE_SERVICE_INVALID", message: "The stored serviceId is invalid." } };
    }
    const serviceInfo = await getServiceForBookingInternal(serviceId, traceId);
    const serviceConfig = serviceInfo?.status === "SUCCESS" ? serviceInfo.data : null;
    const linkedServiceId = _extractRelationalId(serviceConfig?.linkedPhases || "");
    if (!serviceConfig?.allowCombine || !_looksLikeGuid(linkedServiceId)) {
      return { status: "ERROR", data: null, error: { code: "DUAL_RESCHEDULE_CONFIG_INVALID", message: "SERVICIOS_CATALOGO does not define a valid dual service configuration." } };
    }
    const f1DurationMinutes = Number(serviceConfig.phase1Duration) || 0;
    const f2DurationMinutes = Number(serviceConfig.phase2Duration) || 0;
    const expectedGapMs = Math.max(0, Number(serviceConfig.exposureDuration) || 0) * 60 * 1000;
    if (!f1DurationMinutes || !f2DurationMinutes) {
      return { status: "ERROR", data: null, error: { code: "DUAL_RESCHEDULE_DURATION_INVALID", message: "Dual phase durations are invalid." } };
    }
    const pristineF1 = await _buildDualRescheduleSlot(citaF1, slotF1Input, serviceId);
    const pristineF2 = await _buildDualRescheduleSlot(citaF2, slotF2Input, linkedServiceId);
    const newF1Start = getUtcDateFromMadridLocal(pristineF1.startDate);
    const newF1End = getUtcDateFromMadridLocal(pristineF1.endDate);
    const newF2Start = getUtcDateFromMadridLocal(pristineF2.startDate);
    const newF2End = getUtcDateFromMadridLocal(pristineF2.endDate);
    const newGapMs = newF2Start && newF1End ? newF2Start.getTime() - newF1End.getTime() : NaN;
    const f2DurationMs = newF2End && newF2Start ? newF2End.getTime() - newF2Start.getTime() : NaN;
    if (!newF1Start || !newF1End || !newF2Start || !newF2End || !Number.isFinite(newGapMs) || newGapMs < expectedGapMs) {
      return { status: "ERROR", data: null, error: { code: "DUAL_GAP_MISMATCH", message: "The new slots must respect the minimum phase gap." } };
    }
    if (!Number.isFinite(f2DurationMs) || Math.abs(f2DurationMs - (f2DurationMinutes * 60 * 1000)) > 1000) {
      return { status: "ERROR", data: null, error: { code: "DUAL_DURATION_MISMATCH", message: "The second phase duration must match configuration." } };
    }
    const resIdF1 = _safeTrim(pristineF1.resource?._id || pristineF1.resource?.id || "");
    const resIdF2 = _safeTrim(pristineF2.resource?._id || pristineF2.resource?.id || "");
    const [exactF1, exactF2] = await Promise.all([
      revalidateExactAvailabilitySlot({
        serviceId,
        localStartDate: getMadridLocalStringNoZ(newF1Start),
        localEndDate: getMadridLocalStringNoZ(newF1End),
        resourceId: resIdF1,
        nativeAddonIds: _getNativeAddonIdsForRevalidation(citaF1),
        traceId,
      }),
      revalidateExactAvailabilitySlot({
        serviceId: linkedServiceId,
        localStartDate: getMadridLocalStringNoZ(newF2Start),
        localEndDate: getMadridLocalStringNoZ(newF2End),
        resourceId: resIdF2,
        traceId,
      }),
    ]);
    if (exactF1?.status !== "SUCCESS" || exactF2?.status !== "SUCCESS") {
      return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "One of the selected slots is no longer available." } };
    }
    lockKeys.push(
      _generateSlotKey(serviceId, resIdF1, pristineF1.startDate, pristineF1.endDate),
      _generateSlotKey(linkedServiceId, resIdF2, pristineF2.startDate, pristineF2.endDate)
    );
    const uniqueKeys = Array.from(new Set(lockKeys)).sort();
    for (const key of uniqueKeys) {
      const lock = await _lockSlotKeyOrFail(key, lockOwnerId, Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000);
      if (!lock?.ok) throw new Error(lock?.message || "DUAL_RESCHEDULE_LOCK_BUSY");
    }
    heartbeatInterval = setInterval(() => {
      Promise.all(uniqueKeys.map((key) => _renewLock(key, lockOwnerId, Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000)))
        .then((results) => {
          if (results.some((result) => !result?.ok)) lockLeaseLost = true;
        })
        .catch(() => {
          lockLeaseLost = true;
        });
    }, Number(CONCURRENCY?.HEARTBEAT_MS) || 15000);
    const revisionF1 = Number(citaF1.revision || 1) || 1;
    const revisionF2 = Number(citaF2.revision || 1) || 1;
    if (lockLeaseLost) throw new Error("DUAL_RESCHEDULE_LOCK_LEASE_LOST");
    const resultF1 = await _executeWithRetry(
      () => withTimeout(
        rescheduleBookingElevated(citaF1.bookingId, pristineF1, {
          revision: String(revisionF1),
          flowControlSettings: { ignoreReschedulePolicy: false },
        }),
        API_TIMEOUT_MS,
        "rescheduleDualF1"
      ),
      3,
      500
    );
    const revisedF1 = Number(resultF1?.booking?.revision || resultF1?.revision || revisionF1) || revisionF1;
    let resultF2;
    try {
      if (lockLeaseLost) throw new Error("DUAL_RESCHEDULE_LOCK_LEASE_LOST");
      resultF2 = await _executeWithRetry(
        () => withTimeout(
          rescheduleBookingElevated(citaF2.bookingId, pristineF2, {
            revision: String(revisionF2),
            flowControlSettings: { ignoreReschedulePolicy: false },
          }),
          API_TIMEOUT_MS,
          "rescheduleDualF2"
        ),
        3,
        500
      );
    } catch (error) {
      const originalF1 = _getBookingSlotFromCita(citaF1);
      if (originalF1) {
        await rescheduleBookingElevated(citaF1.bookingId, originalF1, {
          revision: String(revisedF1),
          flowControlSettings: { ignoreReschedulePolicy: true },
        }).catch((rollbackError) => {
          log.error("Dual reschedule F1 rollback failed", { traceId, message: rollbackError?.message });
        });
      }
      throw error;
    }
    const revisedF2 = Number(resultF2?.booking?.revision || resultF2?.revision || revisionF2) || revisionF2;
    const updates = [
      { cita: citaF1, pristine: pristineF1, revision: revisedF1 },
      { cita: citaF2, pristine: pristineF2, revision: revisedF2 },
    ];
    for (const { cita, pristine, revision } of updates) {
      const startUtc = getUtcDateFromMadridLocal(pristine.startDate);
      const endUtc = getUtcDateFromMadridLocal(pristine.endDate);
      const targetResourceId = _safeTrim(pristine.resource?._id || pristine.resource?.id || "");
      await _updateCitaSafe(cita.bookingId, (item) => ({
        ...item,
        startDate: startUtc,
        endDate: endUtc,
        startDateLocal: getMadridLocalStringNoZ(startUtc),
        endDateLocal: getMadridLocalStringNoZ(endUtc),
        dateYmd: getMadridLocalStringNoZ(startUtc).slice(0, 10),
        resourceId: targetResourceId,
        scheduleId: pristine.scheduleId || null,
        revision,
      }), traceId, "rescheduleDualBookings");
    }
    const oldDateF1 = String(citaF1.startDateLocal || citaF1.dateYmd || "").slice(0, 10);
    const newDateF1 = getMadridLocalStringNoZ(newF1Start).slice(0, 10);
    const oldDateF2 = String(citaF2.startDateLocal || citaF2.dateYmd || "").slice(0, 10);
    const newDateF2 = getMadridLocalStringNoZ(newF2Start).slice(0, 10);
    const resourceIdF1 = resIdF1;
    const resourceIdF2 = resIdF2;
    try {
      await _invalidateCachesInternal(serviceId, oldDateF1, citaF1.resourceId || resourceIdF1, traceId);
      if (newDateF1 && (newDateF1 !== oldDateF1 || citaF1.resourceId !== resourceIdF1)) {
        await _invalidateCachesInternal(serviceId, newDateF1, resourceIdF1, traceId);
      }
      await _invalidateCachesInternal(linkedServiceId, oldDateF2, citaF2.resourceId || resourceIdF2, traceId);
      if (newDateF2 && (newDateF2 !== oldDateF2 || citaF2.resourceId !== resourceIdF2)) {
        await _invalidateCachesInternal(linkedServiceId, newDateF2, resourceIdF2, traceId);
      }
    } catch (cacheErr) {
      log.warn("rescheduleDualBookings: Cache invalidation failed (best-effort)", { traceId, error: cacheErr?.message });
    }
    await Promise.all(uniqueKeys.map((key) => _unlockSlotKey(key, lockOwnerId).catch(() => null)));
    return {
      status: "SUCCESS",
      data: { pairToken, bookingIdF1: citaF1.bookingId, bookingIdF2: citaF2.bookingId, revisionF1: revisedF1, revisionF2: revisedF2 },
      error: null,
    };
  } catch (error) {
    await Promise.all(lockKeys.map((key) => _unlockSlotKey(key, lockOwnerId).catch(() => null)));
    log.error("rescheduleDualBookings failed", { traceId, message: error?.message });
    return _handleError(error, { surface: "rescheduleDualBookings", traceId });
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    // SSOT v5002.4: _bestEffortUnlockAll in finally block for guaranteed cleanup
    if (lockKeys && lockKeys.length > 0) {
      await _bestEffortUnlockAll(lockKeys, lockOwnerId).catch(() => {});
    }
  }
});