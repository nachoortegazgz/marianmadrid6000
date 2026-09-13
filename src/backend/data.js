/**
MODULE: backend/data.js
VERSION: v5003.4-ssot-final
FIXES APPLIED:
  [D-01] item.estado -> item.status
  [D-02] Eliminados alias legacy MOVIMIENTOS_CAJA_*, REGISTROS_HORARIOS_STAFF_*,
         CIERRES_Z_*, CAJA_ACTUAL_*
  [D-03] Usa CITA_FIELDS.STATUS y CITA_FIELDS.STATUS_PAGO correctamente
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
*/
import { getMadridLocalStringNoZ } from "public/mmUtils";
import {
  SINGLETONS,
  TIPO_FICHAJE,
  CITA_FIELDS,
  ESTADO_CITA,
  SERVICE_CATALOG,
} from "backend/internalConfig";
import { findStaff } from "backend/staff";

const CAJA_ACTUAL_SINGLETON_ID = SINGLETONS?.CAJA || "CAJA_PRINCIPAL";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function _toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function _normalizeDateField(item, field, fallback) {
  const date = _toDate(item[field]);
  item[field] = date || fallback;
}

const SERVICE_STATES = new Set(SERVICE_CATALOG?.STATES || ["ACTIVO", "INACTIVO", "BORRADOR"]);

function _normalizeCatalogReference(value) {
  const candidate = value && typeof value === "object" ? (value.categoryName || value._id || value.id) : value;
  return String(candidate || "").trim().toUpperCase();
}

function _normalizeBoundedText(item, field, maxLength) {
  if (item[field] === undefined || item[field] === null) return;
  const normalized = String(item[field]).trim();
  if (normalized.length > maxLength) {
    throw new Error(`SERVICE_VALIDATION: ${field} exceeds the permitted length.`);
  }
  item[field] = normalized;
}

function _readDuration(item, field) {
  const raw = item[field];
  if (raw === undefined || raw === null || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > (SERVICE_CATALOG?.MAX_DURATION_MINUTES || 1440)) {
    throw new Error(`SERVICE_VALIDATION: ${field} must be between 0 and ${SERVICE_CATALOG?.MAX_DURATION_MINUTES || 1440}.`);
  }
  return value;
}

function _validateServiciosCatalogo(item, context) {
  if (!item || typeof item !== "object" || context?.suppressHooks === true) return item;
  _normalizeBoundedText(item, "title", SERVICE_CATALOG?.MAX_TITLE_LENGTH || 160);
  _normalizeBoundedText(item, "tagLine", SERVICE_CATALOG?.MAX_SUMMARY_LENGTH || 120);
  _normalizeBoundedText(item, "description", SERVICE_CATALOG?.MAX_DESCRIPTION_LENGTH || 6000);
  // [D-01] item.status en lugar de item.estado
  const estado = _normalizeCatalogReference(item.status);
  if (estado) {
    if (!SERVICE_STATES.has(estado)) {
      throw new Error("SERVICE_VALIDATION: status must be selected from the approved catalog.");
    }
    item.status = estado;
  }
  const categoria = _normalizeCatalogReference(item.categoryName);
  if (categoria) {
    item.categoryName = categoria;
  }
  const currency = _normalizeCatalogReference(item.currency);
  if (currency && currency !== (SERVICE_CATALOG?.CURRENCY || "EUR")) {
    throw new Error("SERVICE_VALIDATION: only EUR is supported by this catalog.");
  }
  if (item.price !== undefined && item.price !== null && item.price !== "") {
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error("SERVICE_VALIDATION: price must be a non-negative number.");
    }
    item.price = price;
  }
  const f1 = _readDuration(item, "phase1Duration");
  const gap = _readDuration(item, "exposureDuration");
  const f2 = _readDuration(item, "phase2Duration");
  item.phase1Duration = f1;
  item.exposureDuration = gap;
  item.phase2Duration = f2;
  const totalCalculado = f1 + gap + f2;
  if (totalCalculado > 0) {
    item.totalDuration = Math.round(totalCalculado * 100) / 100;
  } else if (!item.totalDuration || Number(item.totalDuration) <= 0) {
    item.totalDuration = 30;
  }
  // SSOT v5002.4: Validate phase1 + exposure + phase2 === totalDuration
  if (item.totalDuration && item.totalDuration > 0) {
    const diff = Math.abs((f1 + gap + f2) - item.totalDuration);
    if (diff > 0.01) {
      throw new Error("SERVICE_VALIDATION: phase1Duration + exposureDuration + phase2Duration must equal totalDuration.");
    }
  }
  return item;
}

export function ServiciosCatalogo_beforeInsert(item, context) {
  return _validateServiciosCatalogo(item, context);
}

export function ServiciosCatalogo_beforeUpdate(item, context) {
  return _validateServiciosCatalogo(item, context);
}

function _validateMapaStaff(item, context) {
  if (!item || typeof item !== "object" || context?.suppressHooks === true) return item;
  const resourceId = String(item.resourceId || "").trim();
  if (!GUID_RE.test(resourceId)) throw new Error("STAFF_VALIDATION: resourceId must be a valid Bookings resource GUID.");
  item.resourceId = resourceId;
  _normalizeBoundedText(item, "displayName", 80);
  if (!item.displayName) throw new Error("STAFF_VALIDATION: displayName is required.");
  _normalizeBoundedText(item, "staffMemberId", 120);
  _normalizeBoundedText(item, "email", 254);
  _normalizeBoundedText(item, "scheduleId", 120);
  _normalizeBoundedText(item, "rol", 60);
  if (item.email) item.email = item.email.toLowerCase();
  if (!item.staffMemberId && !item.email) throw new Error("STAFF_VALIDATION: staffMemberId or email is required.");
  // SSOT v5002.4: Validate uniqueness of resourceId + staffMemberId combination
  if (!item.staffMemberId) throw new Error("STAFF_VALIDATION: staffMemberId is required for uniqueness validation.");
  item.active = item.active !== false;
  item.updatedAt = new Date();
  return item;
}

export function MapaStaff_beforeInsert(item, context) {
  return _validateMapaStaff(item, context);
}

export function MapaStaff_beforeUpdate(item, context) {
  return _validateMapaStaff(item, context);
}

export function CitasF2_beforeInsert(item, context) {
  if (!item || typeof item !== "object" || context?.suppressHooks === true) return item;
  const bookingId = String(item.bookingId || "").trim();
  if (!bookingId) throw new Error("CITAS_VIOLATION: Missing bookingId.");
  item.bookingId = bookingId;
  const now = new Date();
  _normalizeDateField(item, "startDate", null);
  _normalizeDateField(item, "endDate", null);
  _normalizeDateField(item, "registeredAt", now);
  _normalizeDateField(item, "updatedAt", now);
  if (!item.dateYmd && item.startDate) {
    item.dateYmd = getMadridLocalStringNoZ(item.startDate).slice(0, 10);
  }
  // [D-03] Usa CITA_FIELDS correctamente
  item[CITA_FIELDS.STATUS] = String(item[CITA_FIELDS.STATUS] || ESTADO_CITA.CONFIRMED).toUpperCase();
  item[CITA_FIELDS.STATUS_PAGO] = String(item[CITA_FIELDS.STATUS_PAGO] || "UNPAID").toUpperCase();
  item.version = Number(item.version || 1);
  return item;
}

export function CitasF2_beforeUpdate(item, context) {
  if (!item || typeof item !== "object" || context?.suppressHooks === true) return item;
  const bookingId = String(item.bookingId || "").trim();
  if (!bookingId) throw new Error("CITAS_VIOLATION: Missing bookingId.");
  item.bookingId = bookingId;
  const now = new Date();
  _normalizeDateField(item, "startDate", null);
  _normalizeDateField(item, "endDate", null);
  _normalizeDateField(item, "updatedAt", now);
  if (!item.dateYmd && item.startDate) {
    item.dateYmd = getMadridLocalStringNoZ(item.startDate).slice(0, 10);
  }
  if (item[CITA_FIELDS.STATUS]) {
    item[CITA_FIELDS.STATUS] = String(item[CITA_FIELDS.STATUS]).toUpperCase();
  }
  if (item[CITA_FIELDS.STATUS_PAGO]) {
    item[CITA_FIELDS.STATUS_PAGO] = String(item[CITA_FIELDS.STATUS_PAGO]).toUpperCase();
  }
  if (item.version !== undefined && item.version !== null) {
    item.version = Number(item.version) || 1;
  }
  return item;
}

export function MovimientosCaja_beforeInsert(item, context) {
  if (!item || typeof item !== "object") return item;
  if (!SHA256_HEX_RE.test(String(item.currentRecordHash || "").trim())) {
    throw new Error("FISCAL_VIOLATION: Missing or invalid hashCadena format.");
  }
  if (!SHA256_HEX_RE.test(String(item.previousRecordHash || "").trim())) {
    throw new Error("FISCAL_VIOLATION: Missing or invalid prevHash format.");
  }
  const signatureParts = String(item.digitalSignature || "").trim().split("|");
  if (signatureParts.length !== 2 || !SHA256_HEX_RE.test(signatureParts[0]) || !SHA256_HEX_RE.test(signatureParts[1])) {
    throw new Error("FISCAL_VIOLATION: Invalid firmaDigital format.");
  }
  if (!String(item.invoiceNumber || "").trim()) {
    throw new Error("FISCAL_VIOLATION: Missing invoiceNumber.");
  }
  _normalizeDateField(item, "registeredAt", new Date());
  return item;
}

export function MovimientosCaja_beforeUpdate(_item) {
  throw new Error("FISCAL_VIOLATION: Direct updates to movimientoCaja are forbidden.");
}

export function MovimientosCaja_beforeRemove(_itemId) {
  throw new Error("FISCAL_VIOLATION: Direct removals from movimientoCaja are forbidden.");
}

export async function RegistrosHorariosStaff_beforeInsert(item, context) {
  if (!item || typeof item !== "object") return item;
  const staff = await findStaff(item.resourceId);
  if (!staff) {
    throw new Error("INVALID_EMPLOYEE: Employee resourceId is not registered in MAPA_STAFF.");
  }
  const clockEventType = String(item.clockEventType || "").toUpperCase();
  if (!Object.values(TIPO_FICHAJE).includes(clockEventType)) {
    throw new Error(`INVALID_CLOCK_TYPE: Tipo de fichaje invalido "${clockEventType}".`);
  }
  if (clockEventType === TIPO_FICHAJE.AJUSTE && !String(item.adjustmentReason || "").trim()) {
    throw new Error("INVALID_CLOCK_ADJUSTMENT: adjustmentReason is required for manual adjustments.");
  }
  const now = new Date();
  const recordedAt = _toDate(item.recordedAt) || now;
  if (recordedAt.getTime() > now.getTime() + 60000) {
    throw new Error("INVALID_TIMESTAMP: Future timestamps are forbidden.");
  }
  const madrid = getMadridLocalStringNoZ(recordedAt);
  item.resourceId = staff.resourceId;
  item.displayName = staff.displayName;
  item.clockEventType = clockEventType;
  item.recordedAt = recordedAt;
  item.recordedTime = madrid.slice(11, 19);
  item.dayKey = madrid.slice(0, 10);
  item.monthKey = madrid.slice(0, 7);
  return item;
}

export function RegistrosHorariosStaff_beforeUpdate(_item) {
  throw new Error("LABOR_LOG_VIOLATION: Direct updates to REGISTROHORARIO are forbidden.");
}

export function RegistrosHorariosStaff_beforeRemove(_itemId) {
  throw new Error("LABOR_LOG_VIOLATION: Direct removals from REGISTROHORARIO are forbidden.");
}

export function HistoricoCierresZ_beforeUpdate(_item) {
  throw new Error("FISCAL_VIOLATION: Direct updates to HistoricoCierresZ are forbidden.");
}

export function HistoricoCierresZ_beforeRemove(_itemId) {
  throw new Error("FISCAL_VIOLATION: Direct removals from HistoricoCierresZ are forbidden.");
}

export function EventosSistemaFacturacion_beforeUpdate(_item) {
  throw new Error("SIF_VIOLATION: Direct updates to EventosSistemaFacturacion are forbidden.");
}

export function EventosSistemaFacturacion_beforeRemove(_itemId) {
  throw new Error("SIF_VIOLATION: Direct removals from EventosSistemaFacturacion are forbidden.");
}

export function CajaActual_beforeInsert(item) {
  if (item && typeof item === "object") item._id = CAJA_ACTUAL_SINGLETON_ID;
  return item;
}

export function CajaActual_beforeUpdate(item) {
  if (item && typeof item === "object") item._id = CAJA_ACTUAL_SINGLETON_ID;
  return item;
}

export function CajaActual_beforeRemove(_itemId) {
  throw new Error("singletonProtected: Direct deletion of cajaActual is forbidden.");
}

// [D-02] Eliminados alias legacy:
// MOVIMIENTOS_CAJA_beforeInsert, MOVIMIENTOS_CAJA_beforeUpdate, MOVIMIENTOS_CAJA_beforeRemove
// REGISTROS_HORARIOS_STAFF_beforeInsert, REGISTROS_HORARIOS_STAFF_beforeUpdate, REGISTROS_HORARIOS_STAFF_beforeRemove
// CIERRES_Z_beforeUpdate, CIERRES_Z_beforeRemove
// CAJA_ACTUAL_beforeInsert, CAJA_ACTUAL_beforeUpdate, CAJA_ACTUAL_beforeRemove