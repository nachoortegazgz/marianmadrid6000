/**
MODULE: backend/booking/bookingSaga.js
VERSION: v5003.2-ssot-aligned
FIXES APPLIED:
  [S-01] serviceData.linkedPhases
  [S-02] metaCita.secondaryServiceId resuelve desde linkedPhases
  [S-03] _resolvePrimaryServiceIdInternal -> _resolveServiceIdInternal
  [S-04] _forceStaffInPristineSlot: firma de 4 args con serviceId
  [S-05] _buildLockKeys_DEPRECATED -> _buildLockKeys
  [R7-01] Eliminado comentario legacy
  [BE-01] Import elevate from wix-auth for SSOT compliance
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
*/
import wixData from "wix-data";
import { elevate } from "wix-auth";
import {
  COLLECTIONS,
  APP_IDS,
  SDK_CONFIG,
  STAFF,
  CONCURRENCY,
} from "backend/internalConfig";
import { findStaff } from "backend/staff";
import {
  MONEY,
  STAFF_DEFAULT_NAME,
  makeTraceId,
  _safeTrim,
  _safeEmail,
  _safePhone,
  _looksLikeGuid,
  _normalizeLocalIsoStr,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  _executeWithRetry,
  withTimeout,
  _isValidEmail,
} from "public/mmUtils";
import {
  createBookingElevated,
  cancelBookingElevated,
  createCheckoutElevated,
  getCheckoutUrlElevated,
  confirmOrDeclineBookingElevated,
  _forceStaffInPristineSlot,
  _lockSlotKeyOrFail,
  _unlockSlotKey,
  _renewLock,
  _persistBooking,
  _normalizeAddons,
  _sumAddons,
  _handleError,
  createBookingError,
  logger,
  _getDualPairFromCache,
  _buildLockKeys, // [S-05]
  _initTransaction,
  _completeTransaction,
  _failTransaction,
} from "backend/booking/bookingCore";
import { hashSHA256 } from "backend/securityEngine";
// [S-03] Import renombrado
import {
  _getServiceBySlugOrIdInternal,
  _resolveStaffForSlotInternal,
  _resolveServiceIdInternal,
  _invalidateCachesInternal,
} from "backend/reservas.web";

const log = logger;
const CITAS_COLLECTION = COLLECTIONS?.CITAS_F2 || "CitasF2";
const COMPENSATIONS_COLLECTION = COLLECTIONS?.COMPENSACIONES_PENDIENTES || "CompensacionesPendientes";
const API_TIMEOUT_MS = SDK_CONFIG?.TIMEOUTS?.API_MS || 15000;
const HEARTBEAT_MS = CONCURRENCY?.HEARTBEAT_MS || 15000;
const LOCK_TTL_MS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000;

export function _normalizePersistedMeta(meta) {
  if (!meta) return {};
  if (typeof meta === "object") return meta;
  if (typeof meta !== "string") return {};
  try {
    const parsed = JSON.parse(meta);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function _resolveStablePairToken({ metaCita, unsafePayload, email, phaseOneServiceId, slotF1, slotF2, resourceId }) {
  const fromMetaPair = _safeTrim(metaCita?.pairToken);
  const fromMetaUi = _safeTrim(metaCita?.uiPairToken);
  const fromPayload = _safeTrim(unsafePayload?.uiPairToken || unsafePayload?.pairToken);
  if (fromMetaPair || fromMetaUi || fromPayload) {
    return fromMetaPair || fromMetaUi || fromPayload;
  }
  const emailHash = hashSHA256(email || "").substring(0, 8);
  const f1Start = _safeTrim(slotF1?.localStartDate || slotF1?.startDate || "");
  const f2Start = slotF2 ? _safeTrim(slotF2.localStartDate || slotF2.startDate || "") : "";
  const srvId = _safeTrim(phaseOneServiceId || "");
  const resId = _safeTrim(resourceId || slotF1?.resourceId || "");
  const hashInput = f2Start ? `${srvId}_${resId}_${f1Start}_${f2Start}` : `${srvId}_${resId}_${f1Start}`;
  return `pt_${hashSHA256(hashInput).substring(0, 16)}_${emailHash}`;
}

export function _extractCheckoutId(checkoutSession) {
  return (
    checkoutSession?.data?.checkout?._id ||
    checkoutSession?.data?.checkout?.id ||
    checkoutSession?.data?.checkoutId ||
    checkoutSession?.data?._id ||
    checkoutSession?.data?.id ||
    checkoutSession?.checkout?._id ||
    checkoutSession?.checkout?.id ||
    checkoutSession?._id ||
    checkoutSession?.id ||
    null
  );
}

export async function _compensateCreatedBookings(createdBookings, traceId) {
  for (const b of createdBookings) {
    let cancelled = false;
    try {
      const cancelRes = await cancelBookingElevated(b.bookingId, {
        revision: b.revision,
        flowControlSettings: { ignoreCancellationPolicy: true },
      });
      cancelled = !!cancelRes?.ok;
    } catch (_cancelError) {
      cancelled = false;
    }
    if (!cancelled) {
      try {
        await withTimeout(
          wixData.insert(
            COMPENSATIONS_COLLECTION,
            { bookingId: b.bookingId, phase: b.phase.key, status: "PENDING", attempts: 0, traceId },
            { suppressAuth: true }
          ),
          API_TIMEOUT_MS,
          "insertCompensationPending"
        );
      } catch (_insertError) {
        log.error("insertCompensationPending failed", { bookingId: b.bookingId, traceId });
      }
    }
  }
}

async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
  for (const key of lockKeys) {
    await _unlockSlotKey(key, lockOwnerId).catch(() => {});
  }
}

class SagaStep {
  constructor(name, executeFn, compensateFn = null) {
    this.name = name;
    this.executeFn = executeFn;
    this.compensateFn = compensateFn;
  }
}

export class BookingSagaOrchestrator {
  constructor(traceId) {
    this.traceId = traceId || makeTraceId("saga");
    this.executedSteps = [];
  }
  async execute(steps) {
    for (const step of steps) {
      try {
        const stepResult = await step.executeFn();
        if (stepResult && stepResult.ok === false) {
          throw createBookingError(
            stepResult.code || "SAGA_STEP_FAILED",
            stepResult.message || `Fallo en el paso de la saga: ${step.name}`
          );
        }
        this.executedSteps.push(step);
      } catch (error) {
        log.error(`[SagaOrchestrator] Step '${step.name}' failed. Initiating rollback...`, {
          error: error?.message,
          traceId: this.traceId,
        });
        await this._rollback();
        throw error;
      }
    }
  }
  async _rollback() {
    const reversedSteps = [...this.executedSteps].reverse();
    for (const step of reversedSteps) {
      if (typeof step.compensateFn === "function") {
        try {
          log.info(`[SagaOrchestrator] Executing compensation for step: '${step.name}'`, { traceId: this.traceId });
          await step.compensateFn();
        } catch (compError) {
          log.error(`[SagaOrchestrator] Compensation for step '${step.name}' failed`, {
            error: compError?.message,
            traceId: this.traceId,
          });
        }
      }
    }
  }
}

export async function executeBookingSaga(unsafePayload) {
  const traceId = unsafePayload?.traceId || makeTraceId("saga-book");
  let pairToken = null;
  let heartbeatInterval = null;
  let lockKeys = [];
  let lockOwnerId = null;
  let transactionId = null;
  let sagaSteps = [];
  let createdBookings = [];
  let sagaCompleted = false;
  try {
    if (!unsafePayload || typeof unsafePayload !== "object") {
      throw createBookingError("INVALID_PAYLOAD", "Payload transaccional no valido.");
    }
    if (!unsafePayload.cliente || typeof unsafePayload.cliente !== "object") {
      throw createBookingError("INVALID_PAYLOAD", "Informacion del cliente obligatoria.");
    }
    if (!unsafePayload.metaCita || typeof unsafePayload.metaCita !== "object") {
      throw createBookingError("INVALID_PAYLOAD", "Metadatos de la cita obligatorios.");
    }
    const email = _safeEmail(unsafePayload.cliente.email);
    if (!email || email.length === 0 || !_isValidEmail(email)) {
      throw createBookingError("INVALID_EMAIL", "Correo electronico no valido.");
    }
    const { slotF1, slotF2, cliente, metaCita } = unsafePayload;
    if (!slotF1) throw createBookingError("INVALID_PAYLOAD", "La primera fase (slotF1) es obligatoria.");
    const slotResourceId = slotF1.resourceId || null;
    const rawResourceId = metaCita.resourceId || null;
    const primaryServiceIdRaw = _safeTrim(
      metaCita?.primaryServiceId ||
      unsafePayload?.primaryServiceId ||
      slotF1?.serviceId
    );
    // [S-03] Usa _resolveServiceIdInternal
    const phaseOneServiceId = await _resolveServiceIdInternal(primaryServiceIdRaw);
    if (!phaseOneServiceId || STAFF?.IDS?.includes(phaseOneServiceId)) {
      return { status: "ERROR", error: { code: "SERVICE_NOT_FOUND", message: "Identificador del servicio principal no valido." } };
    }
    const f1LocalStart = _normalizeLocalIsoStr(slotF1.localStartDate);
    if (!f1LocalStart) throw createBookingError("INVALID_DATES", "La hora de inicio de la Fase 1 es obligatoria.");
    const isDualRequested = !!slotF2;
    const rawFilter = metaCita?.resourceFilterId ?? unsafePayload?.resourceFilterId ?? null;
    const isAnyResourceRequested = !rawFilter ||
      String(rawFilter).trim() === "" ||
      String(rawFilter).toLowerCase() === "all" ||
      String(rawFilter).toLowerCase() === "any";
    const staffForRequestedResource = rawResourceId ? await findStaff(rawResourceId) : null;
    const assignedResource =
      (staffForRequestedResource?.resourceId ? String(staffForRequestedResource.resourceId) : null) ||
      (_looksLikeGuid(rawResourceId) ? rawResourceId : null) ||
      (_looksLikeGuid(slotResourceId) ? slotResourceId : null);
    if (!isAnyResourceRequested && !assignedResource) {
      return {
        status: "ERROR",
        error: { code: "RESOURCE_NOT_AVAILABLE", message: "No se pudo resolver la profesional solicitada." },
      };
    }
    const resourceIdForResolve = isAnyResourceRequested ? null : assignedResource;
    const svc = await _getServiceBySlugOrIdInternal(phaseOneServiceId, traceId);
    if (!svc || svc.status !== "SUCCESS" || !svc.data) {
      return { status: "ERROR", error: { code: "SERVICE_NOT_FOUND", message: "No se pudo cargar el servicio desde el catalogo." } };
    }
    const serviceData = svc.data;
    if (isDualRequested && !serviceData.allowCombine) {
      return { status: "ERROR", error: { code: "DUAL_NOT_ALLOWED", message: "Este servicio no permite combinacion en dos fases." } };
    }
    const phase1DurationMs = (Number(serviceData.phase1Duration) || 0) * 60 * 1000;
    const exposureMs = (Number(serviceData.exposureDuration) || 0) * 60 * 1000;
    const phase2DurationMs = (Number(serviceData.phase2Duration) || 0) * 60 * 1000;
    const f1StartUtc = getUtcDateFromMadridLocal(f1LocalStart);
    if (!f1StartUtc) throw createBookingError("INVALID_DATES", "Error al convertir la fecha local de la Fase 1.");
    const f1LocalEndSSOT = _normalizeLocalIsoStr(slotF1.localEndDate) ||
      getMadridLocalStringNoZ(new Date(f1StartUtc.getTime() + phase1DurationMs));
    const isDual = !!(
      isDualRequested &&
      serviceData.allowCombine &&
      serviceData.linkedPhases
    );
    let phaseTwoServiceId = null;
    let f2LocalStart = null;
    let f2LocalEnd = null;
    if (isDual) {
      const secondaryCandidate = serviceData.linkedPhases || metaCita?.secondaryServiceId || null;
      phaseTwoServiceId = await _resolveServiceIdInternal(secondaryCandidate);
      if (!phaseTwoServiceId || STAFF?.IDS?.includes(phaseTwoServiceId)) {
        return { status: "ERROR", error: { code: "SERVICE_NOT_FOUND", message: "Identificador de la segunda fase no valido." } };
      }
      f2LocalStart = _normalizeLocalIsoStr(slotF2?.localStartDate);
      f2LocalEnd = _normalizeLocalIsoStr(slotF2?.localEndDate);
      if (!f2LocalStart || !f2LocalEnd) {
        const f2StartUtcSSOT = new Date(f1StartUtc.getTime() + phase1DurationMs + exposureMs);
        const f2EndUtcSSOT = new Date(f2StartUtcSSOT.getTime() + phase2DurationMs);
        f2LocalStart = getMadridLocalStringNoZ(f2StartUtcSSOT);
        f2LocalEnd = getMadridLocalStringNoZ(f2EndUtcSSOT);
      }
      if (!f2LocalStart || !f2LocalEnd) {
        return { status: "ERROR", error: { code: "INVALID_F2_TIMING", message: "Tiempos de la segunda fase no validos." } };
      }
    }
    const resourceValidation = await _resolveStaffForSlotInternal(
      String(phaseOneServiceId),
      f1LocalStart,
      f1LocalEndSSOT,
      f2LocalStart,
      f2LocalEnd,
      resourceIdForResolve
    );
    if (resourceValidation?.status !== "SUCCESS" || !resourceValidation?.data?.slotF1) {
      return {
        status: "ERROR",
        error: {
          code: "SLOT_UNAVAILABLE",
          message: resourceValidation?.error?.message || "El horario seleccionado ya no esta disponible. Por favor, elige otro horario.",
        },
      };
    }
    const resolvedId = resourceValidation?.data?.resourceId ?? null;
    const finalResourceId = isAnyResourceRequested ? resolvedId : resolvedId || assignedResource || null;
    if (!finalResourceId) {
      return { status: "ERROR", error: { code: "SLOT_UNAVAILABLE", message: "No se pudo asignar una profesional para este horario." } };
    }
    const resourceObj = await findStaff(finalResourceId);
    const finalResourceName =
      resourceObj?.displayName ||
      resourceObj?.name ||
      resourceValidation?.data?.displayName ||
      STAFF?.RESOURCE_TO_DISPLAY?.[finalResourceId] ||
      STAFF_DEFAULT_NAME;
    if (isDual && !resourceValidation?.data?.slotF2) {
      return { status: "ERROR", error: { code: "SLOT_UNAVAILABLE", message: "La segunda fase no esta disponible. Por favor, elige otro horario." } };
    }
    const slotF1ForLocks = { ...resourceValidation.data.slotF1 };
    const slotF2ForLocks = isDual && resourceValidation.data.slotF2 ? { ...resourceValidation.data.slotF2 } : null;
    const stableToken = _resolveStablePairToken({
      metaCita,
      unsafePayload,
      email,
      phaseOneServiceId,
      slotF1,
      slotF2: isDual ? slotF2 : null,
      resourceId: finalResourceId,
    });
    pairToken = stableToken;
    metaCita.uiPairToken = stableToken;
    metaCita.pairToken = stableToken;
    const phases = [{
      key: "F1",
      serviceId: String(phaseOneServiceId),
      rawSlot: slotF1ForLocks,
      validatedSlot: slotF1ForLocks,
      localStart: f1LocalStart,
      localEnd: f1LocalEndSSOT,
      tipo: isDual ? "dual_fase1" : "simple",
      isDual,
    },
    ...(isDual && slotF2ForLocks ? [{
      key: "F2",
      serviceId: String(phaseTwoServiceId),
      rawSlot: slotF2ForLocks,
      validatedSlot: slotF2ForLocks,
      localStart: f2LocalStart,
      localEnd: f2LocalEnd,
      tipo: "dual_fase2",
      isDual: true,
    }] : [])];
    const lockResourceKey = finalResourceId ? String(finalResourceId) : "ANY_RESOURCE";
    // [S-05] Usa _buildLockKeys
    lockKeys = _buildLockKeys(phases, lockResourceKey);
    lockOwnerId = stableToken;
    for (const key of lockKeys) {
      const lockResult = await _lockSlotKeyOrFail(key, lockOwnerId, LOCK_TTL_MS);
      if (!lockResult?.ok) {
        await _bestEffortUnlockAll(lockKeys, lockOwnerId);
        lockKeys = [];
        return {
          status: "ERROR",
          error: { code: "TOKEN_BUSY", message: lockResult?.message || "El horario esta ocupado." },
        };
      }
    }
    heartbeatInterval = setInterval(() => {
      lockKeys.forEach((key) => _renewLock(key, lockOwnerId, LOCK_TTL_MS).catch(() => {}));
    }, HEARTBEAT_MS);
    const payloadHash = hashSHA256(
      JSON.stringify({
        slotF1: { serviceId: String(phaseOneServiceId), start: f1LocalStart, end: f1LocalEndSSOT },
        slotF2: isDual ? { serviceId: String(phaseTwoServiceId), start: f2LocalStart, end: f2LocalEnd } : null,
        pairToken: stableToken,
      })
    );
    const txResult = await _initTransaction(stableToken, payloadHash, traceId);
    transactionId = txResult?.transactionId || null;
    if (!txResult.success) {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      await _bestEffortUnlockAll(lockKeys, lockOwnerId);
      return {
        status: "ERROR",
        error: {
          code: "TRANSACTION_BUSY",
          message: "Ya hay una reserva en proceso para este horario. Por favor, espera unos segundos.",
        },
      };
    }
    if (!txResult.isNew) {
      if (txResult.existing && txResult.existing.status === "COMPLETED") {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        await _bestEffortUnlockAll(lockKeys, lockOwnerId);
        return { status: "SUCCESS", data: txResult.existing.result, idempotent: true, error: null };
      }
      if (txResult.reclaimed) {
        log.info("Transaccion huerfana reclamada en bookingSaga", { pairToken: stableToken, traceId });
      } else if (txResult.timeout) {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        await _bestEffortUnlockAll(lockKeys, lockOwnerId);
        return {
          status: "PROCESSING",
          data: { retryAfter: 2, message: "La reserva esta siendo procesada. Reintentando en 2 segundos." },
          error: null,
        };
      }
    }
    const saga = new BookingSagaOrchestrator(traceId);
    createdBookings = [];
    let checkoutSession = null;
    let checkoutUrl = null;
    let existingCita = null;
    try {
      const existingRes = await withTimeout(
        wixData
          .query(CITAS_COLLECTION)
          .eq("pairToken", stableToken)
          .limit(1)
          .find({ suppressAuth: true, skipCache: true }),
        API_TIMEOUT_MS,
        "queryExistingCitaByPairToken"
      );
      existingCita = existingRes?.items?.[0] || null;
    } catch (_) {
      existingCita = null;
    }
    if (existingCita) {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      await _bestEffortUnlockAll(lockKeys, lockOwnerId);
      const meta = _normalizePersistedMeta(existingCita.meta);
      if (meta.paymentStatus === "PENDING_PAYMENT" && meta.checkoutId) {
        const urlRes = await _executeWithRetry(
          () => withTimeout(getCheckoutUrlElevated(meta.checkoutId), API_TIMEOUT_MS, "getCheckoutUrl"),
          3,
          500
        );
        const resultData = {
          bookingIdF1: existingCita.bookingId,
          bookingIdF2: meta.bookingIdF2 || null,
          isCombined: meta.esCombinado || false,
          checkoutUrl: urlRes?.data?.url || urlRes?.checkoutUrl || urlRes?.url || null,
          requiresPayment: true,
          idempotent: true,
        };
        await _completeTransaction(transactionId, resultData);
        return { status: "SUCCESS", data: resultData, error: null };
      }
      const resultData = {
        bookingIdF1: existingCita.bookingId,
        bookingIdF2: meta.bookingIdF2 || null,
        isCombined: meta.esCombinado || false,
        requiresPayment: false,
        idempotent: true,
      };
      await _completeTransaction(transactionId, resultData);
      return { status: "SUCCESS", data: resultData, error: null };
    }
    const rawName = cliente.nombre || cliente.firstName || "Cliente";
    const nameParts = String(rawName).trim().split(/\s+/);
    const contactDetails = {
      firstName: nameParts[0] || "Cliente",
      lastName: nameParts.slice(1).join(" ") || "",
      email,
      phone: _safePhone(cliente.phone || cliente.phone),
    };
    const addonsNorm = _normalizeAddons(metaCita?.addons || []);
    const addonsTotal = _sumAddons(addonsNorm);
    const serviceName = metaCita?.serviceName || serviceData?.metadata?.title || "Servicio";
    const basePrice = Number(metaCita?.basePrice || serviceData?.metadata?.pricing?.base || 0);
    const totalBilled = basePrice + addonsTotal;
    const madridDateYMD = f1LocalStart.slice(0, 10);
    for (const p of phases) {
      const durationMinutes = p.key === "F2"
        ? Number(serviceData.phase2Duration) || 30
        : Number(serviceData.phase1Duration) || 30;
      // [S-04] Firma de 4 args con serviceId
      p.validatedSlot = {
        ...p.validatedSlot,
        serviceId: p.serviceId,
      };
      p.pristineSlot = await _forceStaffInPristineSlot(
        p.validatedSlot,
        finalResourceId,
        p.serviceId,
        durationMinutes
      );
      if (!p.pristineSlot) {
        throw createBookingError("INVALID_SLOT", `Formato de slot invalido para el motor V2 (${p.key})`);
      }
      if (!p.pristineSlot.scheduleId) {
        const resourceObj2 = await findStaff(finalResourceId);
        if (resourceObj2?.scheduleId) p.pristineSlot.scheduleId = resourceObj2.scheduleId;
      }
    }
    sagaSteps = [
      new SagaStep(
        "LockSlots",
        async () => {
          return { ok: true };
        },
        async () => {
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
          }
          await _bestEffortUnlockAll(lockKeys, lockOwnerId);
        }
      ),
    ];
    sagaSteps.push(
      new SagaStep(
        "CreateBookings",
        async () => {
          const createF1 = async () => {
            const p = phases.find((ph) => ph.key === "F1");
            if (!p) return;
            const res = await _executeWithRetry(
              () => withTimeout(
                createBookingElevated({
                  serviceId: String(phaseOneServiceId),
                  bookedEntity: { slot: p.pristineSlot },
                  contactDetails,
                  totalParticipants: 1,
                  options: { flowControlSettings: { skipAvailabilityValidation: false, skipBusinessConfirmation: false } },
                }),
                API_TIMEOUT_MS,
                "createBooking_F1"
              ),
              5,
              500
            );
            const bId = res?.data?.bookingId || res?.booking?._id || res?._id;
            const rev = Number(res?.data?.revision || res?.booking?.revision || res?.revision || 1);
            if (!bId) throw new Error("Falta bookingId para la Fase 1");
            createdBookings.push({ bookingId: bId, revision: rev, phase: p });
          };
          const createF2 = async () => {
            const p = phases.find((ph) => ph.key === "F2");
            if (!p) return;
            await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 600)));
            const res = await _executeWithRetry(
              () => withTimeout(
                createBookingElevated({
                  serviceId: String(phaseTwoServiceId),
                  bookedEntity: { slot: p.pristineSlot },
                  contactDetails,
                  totalParticipants: 1,
                  options: { flowControlSettings: { skipAvailabilityValidation: false, skipBusinessConfirmation: false } },
                }),
                API_TIMEOUT_MS,
                "createBooking_F2"
              ),
              5,
              500
            );
            const bId = res?.data?.bookingId || res?.booking?._id || res?._id;
            const rev = Number(res?.data?.revision || res?.booking?.revision || res?.revision || 1);
            if (!bId) throw new Error("Falta bookingId para la Fase 2");
            createdBookings.push({ bookingId: bId, revision: rev, phase: p });
          };
          if (isDual) {
            await Promise.all([createF1(), createF2()]);
          } else {
            await createF1();
          }
          return { ok: true };
        },
        async () => {
          await _compensateCreatedBookings(createdBookings, traceId);
        }
      )
    );
    const isOnlinePayment = metaCita?.paymentMethod === "ONLINE";
    const needsCheckout = !!isOnlinePayment;
    const f1Booking = createdBookings.find((b) => b.phase?.key === "F1");
    if (!f1Booking && createdBookings.length > 0) {
      throw createBookingError("BOOKING_CREATION_FAILED", "Fallo al verificar la reserva de la Fase 1.");
    }
    const f2Booking = createdBookings.find((b) => b.phase?.key === "F2");
    if (needsCheckout) {
      sagaSteps.push(
        new SagaStep("CreateCheckout", async () => {
          const lineItems = createdBookings.map((b) => ({
            quantity: 1,
            catalogReference: { appId: APP_IDS.BOOKINGS, catalogItemId: String(b.bookingId) },
          }));
          checkoutSession = await _executeWithRetry(
            () => withTimeout(createCheckoutElevated({ lineItems, channelType: "WEB" }), API_TIMEOUT_MS, "createCheckout"),
            3,
            500
          );
          const checkoutId = _extractCheckoutId(checkoutSession);
          if (!checkoutId) throw new Error("CHECKOUT_ID_MISSING");
          const urlRes = await _executeWithRetry(
            () => withTimeout(getCheckoutUrlElevated(checkoutId), API_TIMEOUT_MS, "getCheckoutUrl"),
            3,
            500
          );
          checkoutUrl = urlRes?.data?.url || urlRes?.checkoutUrl || urlRes?.url || null;
          return { ok: true };
        })
      );
    } else {
      sagaSteps.push(
        new SagaStep("ConfirmPresencial", async () => {
          for (const b of createdBookings) {
            await _executeWithRetry(
              () => withTimeout(
                confirmOrDeclineBookingElevated(b.bookingId, { paymentStatus: "NOT_PAID", revision: b.revision }),
                API_TIMEOUT_MS,
                `confirm_${b.phase.key}`
              ),
              3,
              500
            );
          }
          return { ok: true };
        })
      );
    }
    await saga.execute(sagaSteps);
    sagaCompleted = true;
    const paymentPlan = {
      isOnline: needsCheckout,
      paymentMethod: needsCheckout ? "ONLINE" : "PRESENCIAL",
      paymentStatus: needsCheckout ? "PENDING_PAYMENT" : "CONFIRMED_UNPAID",
      checkoutId: _extractCheckoutId(checkoutSession),
    };
    const baseMeta = {
      pairToken: stableToken,
      addons: addonsNorm,
      addonsTotal,
      resourceId: finalResourceId || null,
      resourceFilterId: rawFilter || null,
      resourceFilterName: isAnyResourceRequested ? "PROFESIONAL SEGUN HORARIO" : finalResourceName,
      primaryServiceId: phaseOneServiceId,
      secondaryServiceId: phaseTwoServiceId || null,
      traceId,
      esCombinado: isDual,
      dateYmd: madridDateYMD,
      servicioNombre: serviceName,
      uiPairToken: stableToken,
      bookingIdF2: isDual ? f2Booking?.bookingId || null : null,
      ...(paymentPlan.checkoutId ? { checkoutId: paymentPlan.checkoutId } : {}),
    };
    const persistPromises = createdBookings.map((b) => {
      const phase = b.phase;
      const startUtc = getUtcDateFromMadridLocal(phase.localStart);
      const endUtc = getUtcDateFromMadridLocal(phase.localEnd);
      if (!startUtc || !endUtc) throw createBookingError("INVALID_DATES", `Fechas no validas para guardar (${phase.key})`);
      const persistedServiceId = phase.key === "F2" ? phaseTwoServiceId : phaseOneServiceId;
      return _persistBooking({
        bookingId: b.bookingId,
        revision: b.revision,
        serviceId: persistedServiceId,
        scheduleId: phase.pristineSlot?.scheduleId || "",
        resourceId: finalResourceId,
        startDate: startUtc,
        endDate: endUtc,
        contactDetails,
        tipo: phase.tipo,
        meta: {
          ...baseMeta,
          paymentStatus: paymentPlan.paymentStatus,
          paymentMethod: paymentPlan.paymentMethod,
          auditedPrice: totalBilled,
        },
      }, traceId);
    });
    await Promise.all(persistPromises);
    const f1StartUtcFinal = getUtcDateFromMadridLocal(phases[0].localStart);
    const f2StartUtcFinal = isDual && phases[1]?.localStart ? getUtcDateFromMadridLocal(phases[1].localStart) : null;
    const resultData = {
      requiresPayment: needsCheckout,
      checkoutUrl,
      bookingIdF1: f1Booking?.bookingId || null,
      bookingIdF2: f2Booking?.bookingId || null,
      isCombined: isDual,
      confirmation: !needsCheckout ? {
        cliente: contactDetails.firstName,
        servicio: serviceName,
        fecha: madridDateYMD,
        hora: f1StartUtcFinal ? (getMadridLocalStringNoZ(f1StartUtcFinal).split("T")[1] || "").slice(0, 5) : null,
        horaF2: isDual && f2StartUtcFinal ? (getMadridLocalStringNoZ(f2StartUtcFinal).split("T")[1] || "").slice(0, 5) : null,
        estilista: finalResourceName,
        total: totalBilled,
        currency: MONEY?.DISPLAY_CURRENCY || "EUR",
      } : null,
    };
    await _completeTransaction(txResult.transactionId, resultData);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    await _bestEffortUnlockAll(lockKeys, lockOwnerId);
    try {
      await _invalidateCachesInternal(String(phaseOneServiceId), madridDateYMD, finalResourceId, traceId);
    } catch (e) {
      log.warn("invalidateCachesInternal failed (best-effort)", { traceId, message: e?.message });
    }
    return { status: "SUCCESS", data: resultData, error: null };
  } catch (error) {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (sagaCompleted && createdBookings.length > 0) {
      await _compensateCreatedBookings(createdBookings, traceId);
    }
    if (pairToken) {
      await _failTransaction(transactionId, error?.message || String(error)).catch(() => {});
    }
    return _handleError(error, { surface: "executeBookingSaga", traceId });
  } finally {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    // [BE-02] _bestEffortUnlockAll in finally block for SSOT compliance
    if (lockKeys.length > 0 && lockOwnerId) {
      await _bestEffortUnlockAll(lockKeys, lockOwnerId).catch(() => {});
    }
  }
}