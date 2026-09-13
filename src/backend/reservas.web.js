/**
MODULE: backend/reservas.web.js
VERSION: v5005-2
FIXES APPLIED:
  [R-01] service?.slug -> service?.slugUrl
  [R-02] _resolvePrimaryServiceIdInternal -> _resolveServiceIdInternal
  [R-03] Eliminado slug en queries, usa slugUrl
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
*/
import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { availabilityTimeSlots } from "wix-bookings.v2";
import {
  COLLECTIONS,
  SDK_CONFIG,
  SLOT_SEARCH,
  API,
} from "backend/internalConfig";
import {
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid,
  _normalizeLocalIsoStr,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  _executeWithRetry,
  _hashKey,
  _generateUUID,
  withTimeout,
  BOOKINGS_ADDON_CONFIG,
  STAFF_DEFAULT_NAME,
  MONEY,
} from "public/mmUtils";
import { logger } from "backend/booking/bookingCore";
import { findStaff } from "backend/staff";
import { requireAdmin, rateLimiter } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { hashSHA256 } from "backend/securityEngine";

const log = logger;
const SERVICIOS_COL = COLLECTIONS.SERVICIOS_CATALOGO;
const DUAL_CACHE_COL = COLLECTIONS.DUAL_SLOT_CACHE;
const DAYS_CACHE_COL = COLLECTIONS.AVAILABILITY_DAYS_CACHE;
const CITAS_COL = COLLECTIONS.CITAS_F2;
const WATCHDOG_TIMEOUT_MS = SDK_CONFIG?.TIMEOUTS?.WATCHDOG_MS || 30000;
const SERVICE_CACHE_TTL_MS = SDK_CONFIG?.CACHE?.SERVICES_TTL_MS || 600000;
const SLOTS_CACHE_TTL_MS = SDK_CONFIG?.CACHE?.SLOTS_CACHE_TTL_MS || 120000;
const DUAL_CACHE_TTL_MS = SDK_CONFIG?.CACHE?.DUAL_CACHE_TTL_MS || 900000;
const STAFF_CACHE_TTL_MS = SDK_CONFIG?.CACHE?.STAFF_TTL_MS || 300000;
const CACHE_MAX_SIZE = SDK_CONFIG?.CACHE?.MAX_ENTRIES || 100;
const DAYS_CACHE_VERSION = SDK_CONFIG?.CACHE?.DAYS_CACHE_VERSION || 1;
const DIAS_LIMITE = SLOT_SEARCH?.DIAS_LIMITE || 14;
const STAFF_RESOURCE_TYPE_ID = API?.STAFF_RESOURCE_TYPE_ID || "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155";

function _getTimeSlotsLocation() {
  const id = _safeTrim(SDK_CONFIG.LOCATION_ID);
  const locationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.TIME_SLOTS) || "BUSINESS";
  return { id, locationType };
}
const LOCATION_TS = Object.freeze(_getTimeSlotsLocation());
const availabilityCache = new Map();
const inflightRequests = new Map();
const serviceCatalogRAM = new Map();
const staffDisplayCache = new Map();

function _cacheSetBounded(mapInstance, key, value, maxSize = CACHE_MAX_SIZE) {
  if (!mapInstance || !key) return;
  if (mapInstance.size >= maxSize && !mapInstance.has(key)) {
    const oldestKey = mapInstance.keys().next().value;
    if (oldestKey) mapInstance.delete(oldestKey);
  }
  mapInstance.set(key, value);
}

export function purgeExpiredRamCaches() {
  const now = Date.now();
  for (const [k, v] of availabilityCache) {
    if (now - (v.timestamp || 0) > SLOTS_CACHE_TTL_MS) availabilityCache.delete(k);
  }
  for (const [k, v] of serviceCatalogRAM) {
    if (now - (v.timestamp || 0) > SERVICE_CACHE_TTL_MS) serviceCatalogRAM.delete(k);
  }
  for (const [k, v] of staffDisplayCache) {
    if (now - (v.ts || 0) > STAFF_CACHE_TTL_MS) staffDisplayCache.delete(k);
  }
  inflightRequests.clear();
}

async function _getStaffDisplayName(resourceId) {
  const resourceIdClean = _safeTrim(resourceId);
  if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return "";
  const cached = staffDisplayCache.get(resourceIdClean);
  if (cached && Date.now() - cached.ts < STAFF_CACHE_TTL_MS) return cached.name || "";
  const staff = await findStaff(resourceIdClean).catch(() => null);
  const name = _safeTrim(staff?.displayName || staff?.displayName || "");
  _cacheSetBounded(staffDisplayCache, resourceIdClean, { name, ts: Date.now() }, CACHE_MAX_SIZE);
  return name;
}

function _rateLimitOrThrow(surface, key, traceId) {
  const rl = rateLimiter({ surface, key });
  if (!rl.allowed) {
    const e = new Error("RATE_LIMITED");
    e.code = "RATE_LIMITED";
    e.meta = { retryAfter: rl.retryAfter, surface, traceId };
    throw e;
  }
}

function _isValidMadridYmd(value) {
  const ymd = _safeTrim(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function _addDaysYMDLocal(ymd, days) {
  if (!_isValidMadridYmd(ymd)) return "";
  const parts = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
}

function _filterDaysByLimit(daysArray) {
  if (!Array.isArray(daysArray) || daysArray.length === 0) return [];
  const tz = SDK_CONFIG?.TZ || "Europe/Madrid";
  const now = new Date();
  const todayStr = now.toLocaleDateString("sv-SE", { timeZone: tz });
  const tomorrowStr = _addDaysYMDLocal(todayStr, 1);
  const maxDateStr = _addDaysYMDLocal(todayStr, DIAS_LIMITE);
  if (!tomorrowStr || !maxDateStr) return [];
  return daysArray.filter((date) => date >= tomorrowStr && date <= maxDateStr);
}

function _normalizeResourceIds(resourceId, traceId) {
  if (!resourceId) return [];
  const normalized = _safeTrim(resourceId);
  if (!normalized || ["all", "any"].includes(normalized.toLowerCase())) return [];
  if (_looksLikeGuid(normalized)) return [normalized];
  log.warn("_normalizeResourceIds: non-guid identifier treated as ANY", { resourceId: normalized, traceId });
  return [];
}

function _minutesBetweenUtcDates(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return 0;
  const ms = b.getTime() - a.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60000);
}

function _parseServiceAddons(rawAddons) {
  if (Array.isArray(rawAddons)) return rawAddons;
  if (typeof rawAddons !== "string" || !rawAddons.trim()) return [];
  try {
    const parsed = JSON.parse(rawAddons);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _normalizeServiceAddon(addon, fallbackId) {
  const id = _safeTrim(addon?.id || addon?._id || addon?.addOnId || fallbackId);
  if (!id) return null;
  // [C.1] Solo bookingsAddonId / bookingsAddonGroupId (cero legacy)
  const bookingsAddonId = _safeTrim(addon?.bookingsAddonId || "");
  const bookingsAddonGroupId = _safeTrim(addon?.bookingsAddonGroupId || "");
  const rawQuantity = addon?.bookingsAddonQuantity ?? addon?.cantidadMaximaAddon;
  const bookingsAddonQuantity = Number.isFinite(Number(rawQuantity)) && Number(rawQuantity) > 0 ? Number(rawQuantity) : 1;
  return {
    addonId: id,
    id,
    nombre: String(addon?.nombre || addon?.name || "Complemento"),
    precio: Number(addon?.precio || addon?.price || 0),
    bookingsAddonId: bookingsAddonId || null,
    bookingsAddonGroupId: bookingsAddonGroupId || null,
    cantidadMaximaAddon: bookingsAddonQuantity,
  };
}

function _resolveAddonContext(service, requestedAddonIds) {
  const requestedIds = Array.from(new Set(
    (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
      .map((id) => _safeTrim(id))
      .filter(Boolean)
  ));
  if (requestedIds.length > BOOKINGS_ADDON_CONFIG.MAX_PER_BOOKING) {
    throw new Error("ADDON_LIMIT_EXCEEDED");
  }
  const catalog = Array.isArray(service?.metadata?.addons) ? service.metadata.addons : [];
  const catalogById = new Map(catalog.map((addon) => [_safeTrim(addon?.addOnId || addon?.id), addon]).filter(([id]) => Boolean(id)));
  const unknownAddonId = requestedIds.find((id) => !catalogById.has(id));
  if (unknownAddonId) throw new Error("ADDON_INVALID");
  const selectedAddons = requestedIds.map((id) => catalogById.get(id));
  const nativeAddonIds = [];
  for (const addon of selectedAddons) {
    const nativeId = _safeTrim(addon?.bookingsAddonId);
    if (nativeId && _looksLikeGuid(nativeId)) {
      nativeAddonIds.push(nativeId);
    }
  }
  return {
    selectedAddons,
    nativeAddonIds: Array.from(new Set(nativeAddonIds)).sort(),
  };
}

async function _mapServiceToPresentation(service, traceId) {
  const serviceId = _safeTrim(service?.serviceId || service?._id);
  if (!_looksLikeGuid(serviceId)) {
    throw new Error("SERVICIOS_CATALOGO invalid: serviceId missing or not a GUID");
  }
  const isHidden = service?.hidden === true;
  const linkedPhases = _safeTrim(service?.linkedPhases);
  const secondaryServiceId = linkedPhases && _looksLikeGuid(linkedPhases) ? linkedPhases : null;
  const allowCombine = !isHidden && service?.allowCombine === true && Boolean(secondaryServiceId);
  const phase1Duration = Number(service?.phase1Duration) || 0;
  const exposureDuration = Number(service?.exposureDuration) || 0;
  const phase2Duration = Number(service?.phase2Duration) || 0;
  const totalDuration = Number(service?.totalDuration) || (phase1Duration + exposureDuration + phase2Duration) || 30;
  const title = _safeTrim(service?.title || "Servicio");
  const price = Number(service?.price || 0);
  // [R-01] slugUrl en lugar de slug
  const slugUrl = _safeTrim(service?.slugUrl) || null;
  const imageUrl = _safeTrim(service?.mainMedia || service?.imageUrl) || "";
  const location = _safeTrim(service?.location) || "Marian Madrid";
  const tagLine = _safeTrim(service?.tagLine) || null;
  const description = _safeTrim(service?.description) || null;
  let addons = [];
  const rawAddons = _parseServiceAddons(service?.addOnOptions || service?.addOns);
  if (rawAddons.length > 0) {
    addons = rawAddons.map((addon, index) => _normalizeServiceAddon(addon, `addon${index + 1}`)).filter(Boolean);
  }
  let staffIds = [];
  try {
    const rawStaff = service?.availableStaff;
    const parsed = typeof rawStaff === "string" ? JSON.parse(rawStaff) : rawStaff;
    if (parsed && Array.isArray(parsed.staffIds)) staffIds.push(...parsed.staffIds);
    else if (Array.isArray(service?.availableStaff)) staffIds.push(...service.availableStaff);
  } catch (_) {}
  const cleanStaffIds = Array.from(new Set(staffIds.map(_safeTrim).filter((id) => _looksLikeGuid(id))));
  const staffOptions = await Promise.all(
    cleanStaffIds.map(async (resourceId) => {
      const displayName = (await _getStaffDisplayName(resourceId).catch(() => "")) || STAFF_DEFAULT_NAME;
      return { id: resourceId, value: resourceId, name: displayName, label: displayName };
    })
  );
  return {
    serviceId,
    slugUrl,
    linkedPhases: secondaryServiceId,
    allowCombine,
    phase1Duration,
    exposureDuration,
    phase2Duration,
    totalDuration,
    availableStaff: cleanStaffIds,
    staffOptions,
    metadata: {
      title,
      price,
      totalDuration,
      location,
      tagLine,
      description,
      addons,
      addonsPrice: addons.map((addon) => Number(addon?.precio || 0)),
      imageUrl,
      pricing: { base: price, currency: MONEY?.DISPLAY_CURRENCY || "EUR" },
      timing: { estimatedTotal: totalDuration, totalDuration: totalDuration },
    },
  };
}

export async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null) {
  const traceId = externalTraceId || makeTraceId("service");
  const raw = _safeTrim(slugOrId);
  const isGuid = _looksLikeGuid(raw);
  const clean = isGuid ? raw : _safeSlugOrId(raw);
  if (!clean) {
    return { status: "ERROR", data: null, error: { code: "SLUG_MISSING", message: "Slug o ID de servicio requerido." } };
  }
  const cached = serviceCatalogRAM.get(clean);
  if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
    return { status: "SUCCESS", data: cached.data, error: null };
  }
  try {
    let service = null;
    if (isGuid) {
      let res = await withTimeout(
        wixData.query(SERVICIOS_COL).limit(1).eq("serviceId", clean).find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "getServiceBySlugOrId:serviceId"
      );
      service = res?.items?.[0] || null;
      if (!service) {
        res = await withTimeout(
          wixData.query(SERVICIOS_COL).limit(1).eq("_id", clean).find({ suppressAuth: true }),
          WATCHDOG_TIMEOUT_MS,
          "getServiceBySlugOrId:_id"
        );
        service = res?.items?.[0] || null;
      }
    } else {
      // [R-03] Usa slugUrl en la query
      let res = await withTimeout(
        wixData.query(SERVICIOS_COL).limit(1).eq("slugUrl", clean).find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "getServiceBySlugOrId:slugUrl"
      );
      service = res?.items?.[0] || null;
    }
    if (!service) {
      log.error("Service not found in SERVICIOS_CATALOGO", { key: clean, traceId });
      return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: `Servicio "${slugOrId}" no encontrado.` } };
    }
    const mapped = await _mapServiceToPresentation(service, traceId);
    _cacheSetBounded(serviceCatalogRAM, clean, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
    if (mapped.serviceId) _cacheSetBounded(serviceCatalogRAM, mapped.serviceId, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
    if (mapped.slugUrl) _cacheSetBounded(serviceCatalogRAM, mapped.slugUrl, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
    return { status: "SUCCESS", data: mapped, error: null };
  } catch (e) {
    log.error("Error in getServiceBySlugOrId", { error: e?.message, traceId });
    return { status: "ERROR", data: null, error: { code: "DATABASE_ERROR", message: e?.message || "Error al consultar la base de datos." } };
  }
}

export async function resolveServiceId(serviceIdReq) {
  const raw = _safeTrim(serviceIdReq);
  if (!raw) return { status: "ERROR", data: null, error: { code: "INVALID_ID", message: "serviceId required" } };
  if (_looksLikeGuid(raw)) return { status: "SUCCESS", data: raw, error: null };
  const clean = _safeSlugOrId(raw);
  const res = await _getServiceBySlugOrIdInternal(clean);
  if (res?.status === "SUCCESS" && res?.data?.serviceId) {
    return { status: "SUCCESS", data: String(res.data.serviceId), error: null };
  }
  return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service could not be resolved." } };
}

export async function getServiceForBookingInternal(serviceId, traceId) {
  return await _getServiceBySlugOrIdInternal(serviceId, traceId);
}

// [R-02] Renombrado a _resolveServiceIdInternal
export async function _resolveServiceIdInternal(serviceIdReq) {
  const resolved = await resolveServiceId(serviceIdReq);
  return resolved?.status === "SUCCESS" ? resolved.data : null;
}

export async function _resolveStaffForSlotInternal(serviceId, start1, end1, start2, end2, resourceId) {
  return resolveStaffForSlot(
    serviceId,
    start1,
    resourceId,
    [],
    start2 ? { start2, end2 } : null
  );
}

function _extractResourceIdsFromSlot(slot) {
  if (!slot || typeof slot !== "object") return [];
  const direct = slot.resourceId || slot.resource?.id || slot.resource?._id;
  if (direct && _looksLikeGuid(direct)) return [String(direct)];
  const resourceList = Array.isArray(slot.resources) ? slot.resources : (Array.isArray(slot.resourceIds) ? slot.resourceIds : []);
  const extracted = resourceList.map((r) => typeof r === "object" ? (r?.id || r?._id) : r).filter((id) => _looksLikeGuid(id));
  return Array.from(new Set(extracted));
}

export async function revalidateExactAvailabilitySlot({ serviceId, localStartDate, localEndDate, resourceId, nativeAddonIds = [], traceId }) {
  const activeTraceId = traceId || makeTraceId("exact-slot");
  const resolvedService = await resolveServiceId(serviceId);
  const canonicalServiceId = resolvedService?.data;
  const start = _normalizeLocalIsoStr(localStartDate);
  const end = _normalizeLocalIsoStr(localEndDate);
  const requiredResourceId = _safeTrim(resourceId);
  if (!canonicalServiceId || !start || !end) {
    return { status: "ERROR", data: null, error: { code: "INVALID_SLOT_RECHECK", message: "Selected slot data is invalid." } };
  }
  try {
    const payload = {
      serviceId: String(canonicalServiceId),
      localStartDate: start,
      localEndDate: end,
      location: LOCATION_TS,
      timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
      includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
    };
    if (Array.isArray(nativeAddonIds) && nativeAddonIds.length > 0) {
      payload.customerChoices = { addOnIds: nativeAddonIds.filter((id) => _looksLikeGuid(id)) };
    }
    const result = await _executeWithRetry(
      () => withTimeout(
        availabilityTimeSlots.getAvailabilityTimeSlot(payload),
        WATCHDOG_TIMEOUT_MS,
        "getAvailabilityTimeSlot"
      ),
      2,
      300
    );
    const rawSlot = result?.timeSlot || null;
    if (!rawSlot || rawSlot.bookable !== true) {
      return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "Selected slot is no longer available." } };
    }
    const availableResourceIds = _extractResourceIdsFromSlot(rawSlot);
    if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
      return { status: "ERROR", data: null, error: { code: "STAFF_UNAVAILABLE", message: "Selected staff is no longer available for this slot." } };
    }
    return {
      status: "SUCCESS",
      data: {
        slot: {
          ...rawSlot,
          serviceId: canonicalServiceId,
          localStartDate: start,
          localEndDate: end,
        },
        resourceId: requiredResourceId || (availableResourceIds.length === 1 ? availableResourceIds[0] : null),
        candidateResourceIds: availableResourceIds,
      },
      error: null,
    };
  } catch (error) {
    log.warn("Exact slot recheck failed", { traceId: activeTraceId, message: error?.message || String(error) });
    return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "Selected slot could not be revalidated." } };
  }
}

async function _listTimeSlotsV2({ serviceId, fromLocalDate, toLocalDate, resourceIds, nativeAddonIds = [] }, options = {}) {
  const { skipCache = false, timeSlotsPerDay } = options;
  const fromKey = _normalizeLocalIsoStr(fromLocalDate);
  const toKey = _normalizeLocalIsoStr(toLocalDate);
  if (!fromKey || !toKey) return [];
  const resolved = await resolveServiceId(serviceId);
  const canonicalServiceId = resolved?.data;
  if (!canonicalServiceId) return [];
  const normalizedResourceIds = Array.isArray(resourceIds) ? resourceIds.map(String).filter(_looksLikeGuid) : [];
  const normalizedNativeAddonIds = Array.isArray(nativeAddonIds) ? nativeAddonIds.map(String).filter(_looksLikeGuid) : [];
  const resourceKey = normalizedResourceIds.slice().sort().join(",");
  const addonKey = normalizedNativeAddonIds.slice().sort().join(",");
  const cacheKey = `${String(canonicalServiceId)}__${resourceKey}__${addonKey}__${fromKey}__${toKey}__ts:${timeSlotsPerDay || 0}`;
  if (!skipCache) {
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SLOTS_CACHE_TTL_MS) return cached.data;
    const inflight = inflightRequests.get(cacheKey);
    if (inflight) return inflight;
  }
  const p = (async () => {
    try {
      const resourceTypes = normalizedResourceIds.length ?
        [{ resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: normalizedResourceIds }] :
        [];
      const payload = {
        serviceId: String(canonicalServiceId),
        fromLocalDate: String(fromKey),
        toLocalDate: String(toKey),
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        bookable: true,
        locations: [LOCATION_TS],
        includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
      };
      if (resourceTypes.length) payload.resourceTypes = resourceTypes;
      if (normalizedNativeAddonIds.length > 0) payload.customerChoices = { addOnIds: normalizedNativeAddonIds };
      if (Number.isFinite(timeSlotsPerDay) && Number(timeSlotsPerDay) > 0) payload.timeSlotsPerDay = Number(timeSlotsPerDay);
      const data = await _executeWithRetry(
        () => withTimeout(
          availabilityTimeSlots.listAvailabilityTimeSlots(payload),
          WATCHDOG_TIMEOUT_MS,
          "listAvailabilityTimeSlots"
        ),
        3,
        500
      );
      const rawSlots = Array.isArray(data?.timeSlots) ? data.timeSlots : [];
      const slots = rawSlots
        .map((s) => {
          if (!s) return null;
          const start = s.localStartDate || s.startDate || "";
          const end = s.localEndDate || s.endDate || "";
          return { ...s, serviceId: canonicalServiceId, localStartDate: String(start), localEndDate: String(end) };
        })
        .filter((s) => s && s.localStartDate);
      if (!skipCache) _cacheSetBounded(availabilityCache, cacheKey, { data: slots, timestamp: Date.now() }, CACHE_MAX_SIZE);
      return slots;
    } catch (e) {
      log.error("_listTimeSlotsV2 failed", { serviceId: canonicalServiceId, message: e?.message });
      return [];
    }
  })();
  if (!skipCache) {
    inflightRequests.set(cacheKey, p);
    try {
      return await p;
    } finally {
      inflightRequests.delete(cacheKey);
    }
  }
  return await p;
}

async function _getBookedMinutesByResourceForDay(dateYMD, resourceIds, traceId) {
  const ymd = String(dateYMD || "").slice(0, 10);
  const ids = Array.isArray(resourceIds) ? resourceIds.map(String).filter(Boolean) : [];
  if (!ymd || ids.length === 0) return {};
  const q = wixData
    .query(CITAS_COL)
    .eq("dateYmd", ymd)
    .in("status", ["CONFIRMED", "PENDING_PAYMENT"])
    .in("resourceId", ids)
    .limit(1000);
  const res = await withTimeout(q.find({ suppressAuth: true }), WATCHDOG_TIMEOUT_MS, "balance:queryCitas").catch(() => null);
  const items = Array.isArray(res?.items) ? res.items : [];
  const minutes = {};
  ids.forEach((rid) => (minutes[rid] = 0));
  for (const it of items) {
    const rid = String(it?.resourceId || "").trim();
    if (!rid || minutes[rid] === undefined) continue;
    const start = it?.startDate ? new Date(it.startDate) : null;
    const end = it?.endDate ? new Date(it.endDate) : null;
    if (!(start instanceof Date) || isNaN(start.getTime())) continue;
    if (!(end instanceof Date) || isNaN(end.getTime())) continue;
    minutes[rid] += _minutesBetweenUtcDates(start, end);
  }
  return minutes;
}

async function _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId) {
  const ids = Array.from(new Set(Array.isArray(candidateResourceIds) ? candidateResourceIds.map(String).filter(Boolean) : []));
  if (ids.length <= 1) return ids;
  const minutesMap = await _getBookedMinutesByResourceForDay(dateYMD, ids, traceId).catch(() => ({}));
  const names = {};
  await Promise.allSettled(
    ids.map(async (rid) => {
      names[rid] = (await _getStaffDisplayName(rid).catch(() => "")) || "";
    })
  );
  return ids.sort((a, b) => {
    const ma = Number(minutesMap[a] || 0);
    const mb = Number(minutesMap[b] || 0);
    if (ma !== mb) return ma - mb;
    const na = String(names[a] || a);
    const nb = String(names[b] || b);
    return na.localeCompare(nb);
  });
}

async function _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId) {
  const ranked = await _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId);
  return ranked[0] || null;
}

async function _findNextSlotForServiceInternal(serviceId, fromLocalDateTime, requiredResourceId, traceId) {
  const resolved = await resolveServiceId(serviceId);
  const canonicalServiceId = resolved?.data;
  if (!canonicalServiceId) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };
  const fromLocal = _normalizeLocalIsoStr(fromLocalDateTime);
  if (!fromLocal) return { status: "ERROR", data: null, error: { code: "INVALID_DATES", message: "fromLocalDateTime invalid" } };
  const startYMD = fromLocal.slice(0, 10);
  const mustHaveStaff = _looksLikeGuid(requiredResourceId);
  const resourceIds = mustHaveStaff ? [String(requiredResourceId)] : [];
  for (let i = 0; i <= DIAS_LIMITE; i++) {
    const ymd = _addDaysYMDLocal(startYMD, i);
    const dayFrom = i === 0 ? fromLocal : `${ymd}T00:00:00`;
    const dayTo = `${ymd}T23:59:59`;
    const slots = await _listTimeSlotsV2({ serviceId: canonicalServiceId, fromLocalDate: dayFrom, toLocalDate: dayTo, resourceIds }, { skipCache: true });
    const normFrom = _normalizeLocalIsoStr(dayFrom);
    const candidates = (slots || [])
      .filter((s) => _normalizeLocalIsoStr(s.localStartDate) >= normFrom)
      .sort((a, b) => String(a.localStartDate).localeCompare(String(b.localStartDate)));
    if (!candidates.length) continue;
    if (mustHaveStaff) {
      const required = String(requiredResourceId);
      const match = candidates.find((s) => _extractResourceIdsFromSlot(s).includes(required));
      if (match) return { status: "SUCCESS", data: { slot: match, dayYMD: ymd }, error: null };
      continue;
    }
    return { status: "SUCCESS", data: { slot: candidates[0], dayYMD: ymd }, error: null };
  }
  return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "No available slot found in search window." } };
}

export async function _cleanExpiredDualSlotsInternal({ limit = 100, traceId = null } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const now = new Date();
  const result = await withTimeout(
    wixData.query(DUAL_CACHE_COL).lt("expiresAt", now).limit(safeLimit).find({ suppressAuth: true }),
    WATCHDOG_TIMEOUT_MS,
    "cleanExpiredDualSlotsQuery"
  );
  let removed = 0;
  for (const item of result?.items || []) {
    await withTimeout(
      wixData.remove(DUAL_CACHE_COL, item._id, { suppressAuth: true }),
      WATCHDOG_TIMEOUT_MS,
      "cleanExpiredDualSlotsRemove"
    );
    removed += 1;
  }
  log.info("Expired dual cache entries cleaned", { removed, traceId });
  return { status: "SUCCESS", data: { removed }, error: null };
}

export async function getCertifiedDualSlots(serviceId, resourceId, dateYMD, requestedAddonIds = []) {
  const traceId = makeTraceId("dual");
  if (!serviceId || !_isValidMadridYmd(dateYMD)) {
    return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "serviceId and valid Madrid dateYMD are required" } };
  }
  const resolved = await resolveServiceId(serviceId);
  const canonicalServiceId = resolved?.data;
  if (!canonicalServiceId) {
    return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service not found" } };
  }
  const serviceRes = await _getServiceBySlugOrIdInternal(canonicalServiceId, traceId);
  if (!serviceRes || serviceRes.status !== "SUCCESS" || !serviceRes.data) {
    return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service catalog missing" } };
  }
  const service = serviceRes.data;
  const addonContext = _resolveAddonContext(service, requestedAddonIds);
  const linkedPhases = _safeTrim(service?.linkedPhases);
  const secondaryServiceId = linkedPhases && _looksLikeGuid(linkedPhases) ? linkedPhases : null;
  const isDual = service.allowCombine && !!secondaryServiceId;
  const resourceIdsFilter = _normalizeResourceIds(resourceId, traceId);
  const fromLocalDate = `${dateYMD}T00:00:00`;
  const toLocalDate = `${dateYMD}T23:59:59`;
  const slotsF1 = await _listTimeSlotsV2({
    serviceId: canonicalServiceId,
    fromLocalDate,
    toLocalDate,
    resourceIds: resourceIdsFilter,
    nativeAddonIds: addonContext.nativeAddonIds,
  }, { skipCache: true });
  if (!isDual) {
    const out = [];
    for (const s1 of slotsF1 || []) {
      const candidateResourceIds = _extractResourceIdsFromSlot(s1);
      const chosen = (await _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId))[0] || null;
      // [BE-03] SHA256 deterministic pairToken generation for SSOT compliance
      const emailHash = hashSHA256(traceId || "").substring(0, 8);
      const f1Start = _safeTrim(s1.localStartDate || s1.startDate || "");
      const srvId = _safeTrim(canonicalServiceId || "");
      const resId = _safeTrim(chosen || s1.resourceId || "");
      const hashInput = `${srvId}_${resId}_${f1Start}`;
      const pairToken = `pt_${hashSHA256(hashInput).substring(0, 16)}_${emailHash}`;
      out.push({
        fase1: { slotRef: { ...s1, serviceId: canonicalServiceId }, resourceId: chosen || null },
        fase2: null,
        uiPairToken: pairToken,
        pairToken,
        candidateResourceIds,
        serviceId: canonicalServiceId,
        secondaryServiceId: null,
        dateYMD,
      });
    }
    return { status: "SUCCESS", data: out, error: null };
  }
  const exposureMs = Math.max(0, Number(service.exposureDuration || 0)) * 60 * 1000;
  const pairs = [];
  for (const s1 of slotsF1 || []) {
    const s1EndLocal = _normalizeLocalIsoStr(s1.localEndDate);
    if (!s1EndLocal) continue;
    const s1EndUtc = getUtcDateFromMadridLocal(s1EndLocal);
    if (!s1EndUtc) continue;
    const earliestF2Utc = new Date(s1EndUtc.getTime() + exposureMs);
    const earliestF2Local = getMadridLocalStringNoZ(earliestF2Utc);
    const candidateResourceIds = _extractResourceIdsFromSlot(s1);
    if (!candidateResourceIds.length) continue;
    const rankedCandidates = await _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId);
    let chosenResourceId = null;
    let s2 = null;
    for (const candidateResourceId of rankedCandidates) {
      const nextF2 = await _findNextSlotForServiceInternal(
        secondaryServiceId,
        earliestF2Local,
        candidateResourceId,
        traceId
      );
      if (nextF2?.status !== "SUCCESS" || !nextF2?.data?.slot) continue;
      const candidateF2 = nextF2.data.slot;
      const s2Staff = _extractResourceIdsFromSlot(candidateF2);
      if (s2Staff.length > 0 && !s2Staff.includes(String(candidateResourceId))) continue;
      chosenResourceId = candidateResourceId;
      s2 = candidateF2;
      break;
    }
    if (!chosenResourceId || !s2) continue;
    // [BE-03] SHA256 deterministic pairToken generation for SSOT compliance
    const emailHash = hashSHA256(traceId || "").substring(0, 8);
    const f1Start = _safeTrim(s1.localStartDate || s1.startDate || "");
    const f2Start = _safeTrim(s2.localStartDate || s2.startDate || "");
    const srvId = _safeTrim(canonicalServiceId || "");
    const resId = _safeTrim(chosenResourceId || s1.resourceId || "");
    const hashInput = `${srvId}_${resId}_${f1Start}_${f2Start}`;
    const pairToken = `pt_${hashSHA256(hashInput).substring(0, 16)}_${emailHash}`;
    pairs.push({
      fase1: { slotRef: { ...s1, serviceId: canonicalServiceId }, resourceId: chosenResourceId },
      fase2: { slotRef: { ...s2, serviceId: secondaryServiceId }, resourceId: chosenResourceId },
      uiPairToken: pairToken,
      pairToken,
      candidateResourceIds,
      serviceId: canonicalServiceId,
      secondaryServiceId,
      dateYMD,
      earliestF2Local,
    });
  }
  if (pairs.length > 0) {
    const cachePromises = pairs.map((slotPair) => {
      const pairToken = slotPair.uiPairToken;
      const expiresAt = new Date(Date.now() + DUAL_CACHE_TTL_MS);
      const record = {
        _id: pairToken,
        pairToken,
        slotF1: slotPair.fase1?.slotRef || null,
        slotF2: slotPair.fase2?.slotRef || null,
        resourceId: slotPair.fase1?.resourceId || null,
        candidateResourceIds: slotPair.candidateResourceIds || [],
        serviceId: String(slotPair.serviceId),
        secondaryServiceId: String(slotPair.secondaryServiceId),
        dateYMD: String(dateYMD),
        expiresAt,
        _createdDate: new Date(),
        status: "ACTIVE",
      };
      return wixData.save(DUAL_CACHE_COL, record, { suppressAuth: true }).catch(() => null);
    });
    await Promise.allSettled(cachePromises);
  }
  return { status: "SUCCESS", data: pairs, error: null };
}

export async function _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId = null) {
  const tId = traceId || makeTraceId("invalidate");
  const resolved = await resolveServiceId(serviceId);
  const canonicalServiceId = resolved?.data || _safeTrim(serviceId);
  const ymd = _safeTrim(dateYMD);
  if (!canonicalServiceId || !_isValidMadridYmd(ymd)) return { ok: true, traceId: tId, skipped: true };
  const prefix = `${String(canonicalServiceId)}__`;
  for (const k of availabilityCache.keys()) {
    if (String(k).startsWith(prefix)) availabilityCache.delete(k);
  }
  const yearMonth = String(ymd).slice(0, 7);
  const resourceIds = _normalizeResourceIds(resourceId, tId).sort().join(",");
  const daysCacheId = `${DAYS_CACHE_VERSION}__${String(canonicalServiceId)}__${_hashKey(resourceIds)}__${String(yearMonth)}`;
  try {
    await withTimeout(
      wixData.remove(DAYS_CACHE_COL, daysCacheId, { suppressAuth: true }),
      WATCHDOG_TIMEOUT_MS,
      "invalidateDaysCache"
    );
  } catch (e) {
    const msg = String(e?.message || "");
    if (!msg.includes("WDE0073") && !msg.includes("does not exist") && !msg.includes("WD_ITEM_DOES_NOT_EXIST")) {
      throw e;
    }
  }
  try {
    const res = await withTimeout(
      wixData.query(DUAL_CACHE_COL).eq("serviceId", String(canonicalServiceId)).eq("dateYMD", String(ymd)).limit(100).find({ suppressAuth: true }),
      WATCHDOG_TIMEOUT_MS,
      "invalidateDualCacheQuery"
    );
    await Promise.allSettled(
      (res?.items || []).map((it) => withTimeout(
        wixData.remove(DUAL_CACHE_COL, it._id, { suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "invalidateDualCacheRemove"
      ).catch(() => null))
    );
  } catch (e) {
    log.warn("_invalidateCachesInternal: dual cache cleanup failed (best-effort)", { traceId: tId, message: e?.message });
  }
  return { ok: true, traceId: tId };
}

export const invalidateCachesInternal = webMethod(Permissions.Admin, async (serviceId, dateYMD, resourceId) => {
  const traceId = makeTraceId("wm-invalidate-internal");
  try {
    _rateLimitOrThrow("reservas.invalidateCachesInternal", "admin", traceId);
    await requireAdmin(traceId);
    const res = await _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId);
    return { status: "SUCCESS", data: res, error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "INVALIDATE_FAILED") };
  }
});

export const getServiceBySlugOrId = webMethod(Permissions.Anyone, async (slugOrId) => {
  const traceId = makeTraceId("wm-svc");
  try {
    _rateLimitOrThrow("reservas.getServiceBySlugOrId", _safeTrim(slugOrId) || "anon", traceId);
    return await _getServiceBySlugOrIdInternal(slugOrId, traceId);
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "SERVICE_LOOKUP_FAILED") };
  }
});

export const getAvailableDays = webMethod(Permissions.Anyone, async (serviceId, resourceId, year, month, addonIds = []) => {
  const traceId = makeTraceId("wm-days");
  try {
    _rateLimitOrThrow("reservas.getAvailableDays", `${_safeTrim(serviceId)}|${String(year)}|${String(month)}`, traceId);
    const resolved = await resolveServiceId(serviceId);
    const canonicalServiceId = resolved?.data;
    if (!canonicalServiceId) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };
    const svcRes = await _getServiceBySlugOrIdInternal(canonicalServiceId, traceId);
    const service = svcRes?.data;
    if (!service) return { status: "ERROR", data: null, error: { code: "SERVICE_CONFIG_MISSING", message: "Service configuration missing" } };
    const addonContext = _resolveAddonContext(service, addonIds);
    const resourceIds = _normalizeResourceIds(resourceId, traceId);
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Invalid year/month" } };
    }
    const yearMonth = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    const tz = SDK_CONFIG?.TZ || "Europe/Madrid";
    const now = new Date();
    const todayStr = now.toLocaleDateString("sv-SE", { timeZone: tz });
    const tomorrowStr = _addDaysYMDLocal(todayStr, 1);
    const maxDateStr = _addDaysYMDLocal(todayStr, DIAS_LIMITE);
    const firstDay = `${yearMonth}-01`;
    const lastDayNum = new Date(y, m, 0).getDate();
    const lastDay = `${yearMonth}-${String(lastDayNum).padStart(2, "0")}`;
    const fromLocal = tomorrowStr > firstDay ? tomorrowStr : firstDay;
    const toLocal = maxDateStr < lastDay ? maxDateStr : lastDay;
    if (fromLocal > toLocal) return { status: "SUCCESS", data: [], error: null };
    const slots = await _listTimeSlotsV2({
      serviceId: canonicalServiceId,
      fromLocalDate: `${fromLocal}T00:00:00`,
      toLocalDate: `${toLocal}T23:59:59`,
      resourceIds,
      nativeAddonIds: addonContext.nativeAddonIds,
    }, { skipCache: true, timeSlotsPerDay: 1 });
    const dateSet = new Set();
    slots.forEach((s) => {
      if (s.localStartDate) dateSet.add(String(s.localStartDate).slice(0, 10));
    });
    return { status: "SUCCESS", data: _filterDaysByLimit(Array.from(dateSet).sort()), error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DAYS_QUERY_FAILED") };
  }
});

export const resolveStaffForSlot = webMethod(Permissions.Anyone, async (serviceId, start1, rId, addonIds = [], dualContext = null) => {
  const traceId = makeTraceId("wm-staff");
  try {
    _rateLimitOrThrow("reservas.resolveStaffForSlot", `${_safeTrim(serviceId)}|${_safeTrim(start1)}`, traceId);
    const resolved = await resolveServiceId(serviceId);
    const canonicalServiceId = resolved?.data;
    if (!canonicalServiceId) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service ID not found" } };
    const svcRes = await _getServiceBySlugOrIdInternal(canonicalServiceId, traceId);
    const serviceCfg = svcRes?.data;
    if (!serviceCfg) return { status: "ERROR", data: null, error: { code: "SERVICE_CONFIG_MISSING", message: "Service not in catalog" } };
    const addonContext = _resolveAddonContext(serviceCfg, addonIds);
    const dateYMD = String(start1).slice(0, 10);
    const isAnyStaff = !rId || ["all", "any"].includes(String(rId).trim().toLowerCase());
    const slotsF1 = await _listTimeSlotsV2({
      serviceId: canonicalServiceId,
      fromLocalDate: `${dateYMD}T00:00:00`,
      toLocalDate: `${dateYMD}T23:59:59`,
      resourceIds: isAnyStaff ? [] : _normalizeResourceIds(rId, traceId),
      nativeAddonIds: addonContext.nativeAddonIds,
    }, { skipCache: true });
    const slotF1 = (slotsF1 || []).find(
      (s) => _normalizeLocalIsoStr(s.localStartDate) === _normalizeLocalIsoStr(start1)
    );
    if (!slotF1) return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "F1 slot is no longer available." } };
    let candidateResourceIds = _extractResourceIdsFromSlot(slotF1);
    let slotF2 = null;
    if (dualContext && dualContext.start2) {
      const resolvedSecondary = await resolveServiceId(serviceCfg.linkedPhases);
      const secondaryId = resolvedSecondary?.data;
      if (secondaryId) {
        const nextF2 = await _findNextSlotForServiceInternal(
          secondaryId,
          dualContext.start2,
          isAnyStaff ? null : _safeTrim(rId),
          traceId
        );
        if (nextF2?.status !== "SUCCESS" || !nextF2?.data?.slot) {
          return { status: "ERROR", data: null, error: { code: "F2_UNAVAILABLE", message: "F2 slot is no longer available." } };
        }
        slotF2 = nextF2.data.slot;
        const candidatesF2 = _extractResourceIdsFromSlot(slotF2);
        candidateResourceIds = candidateResourceIds.filter((id) => candidatesF2.includes(id));
      }
    }
    if (!candidateResourceIds.length) {
      return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "No staff available for this combined slot." } };
    }
    const requestedResourceId = isAnyStaff ? "" : _safeTrim(rId);
    if (requestedResourceId && !candidateResourceIds.includes(requestedResourceId)) {
      return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "Selected staff is not available for this combined slot." } };
    }
    const finalResourceId = isAnyStaff ?
      await _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId) :
      requestedResourceId;
    if (!finalResourceId) return { status: "ERROR", data: null, error: { code: "STAFF_NOT_AVAILABLE", message: "No staff could be assigned." } };
    const finalResourceName = (await _getStaffDisplayName(finalResourceId)) || STAFF_DEFAULT_NAME;
    return {
      status: "SUCCESS",
      data: {
        slotF1: { ...slotF1, serviceId: canonicalServiceId },
        slotF2: slotF2 ? { ...slotF2, serviceId: serviceCfg.linkedPhases } : null,
        resourceId: finalResourceId,
        displayName: finalResourceName,
        dayYMD: dateYMD,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "STAFF_RESOLVE_FAILED") };
  }
});