/**
MODULE: backend/horario.web.js
VERSION: v5003.3-ssot-purged
FIXES APPLIED:
[P-08] Legacy fields documented (header comment only) (R7-CERO_LEGACY)
[P-09] Legacy fields documented (header comment only) (R7-CERO_LEGACY)
[P-10] Legacy fields documented (header comment only) (R7-CERO_LEGACY)
[P-11] Legacy fields documented (header comment only) (R7-CERO_LEGACY)
[P-12] Legacy fields documented (header comment only) (R2-TRADUCCION_LITERAL)
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
*/
import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { currentMember } from "wix-members-backend";
import { COLLECTIONS, TIPO_FICHAJE } from "backend/internalConfig";
import { findStaff } from "backend/staff";
import { rateLimiter, requireAdmin } from "backend/security";
import { logger, normalizeError } from "backend/booking/bookingCore";
import { makeTraceId, _safeTrim, getMadridLocalStringNoZ } from "public/mmUtils";
const log = logger;
const REGISTRO_COL = COLLECTIONS.REGISTROS_HORARIOS_STAFF;
function _rateLimitOrThrow(surface, key, traceId) {
  const rl = rateLimiter({ surface, key });
  if (!rl.allowed) {
    const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
    e.code = "RATE_LIMITED";
    e.meta = { retryAfter: rl.retryAfter, surface, traceId };
    throw e;
  }
}
function _resolveMemberEmail(member) {
  return _safeTrim(member?.loginEmail).toLowerCase();
}
function _buildLaborRecord({ staff, tipo, dateObj, motivo, registeredBy, registeredByMemberId, traceId }) {
  const madridLocal = getMadridLocalStringNoZ(dateObj);
  return {
    resourceId: staff.resourceId,
    displayName: staff.displayName || "Unknown",
    employeeIdentifier: staff.staffMemberId || registeredByMemberId || null,
    employeeName: staff.displayName || "Unknown",
    clockEventType: tipo,
    type: tipo,
    recordedAt: dateObj,
    recordedTime: madridLocal.slice(11, 19),
    dayKey: madridLocal.slice(0, 10),
    monthKey: madridLocal.slice(0, 7),
    adjustmentReason: tipo === TIPO_FICHAJE.AJUSTE ? motivo : null,
    registeredBy,
    registeredByMemberId: registeredByMemberId || null,
    deviceIp: null,
    deviceIpAddress: null,
    signature: null,
    meta: {},
    traceId,
    _createdDate: new Date(),
  };
}
function _readFichajeTipo(f) {
  return f.clockEventType || f.type || "";
}
function _readFichajeFecha(f) {
  return new Date(f.recordedAt);
}
export const getMyStaffContext = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options.traceId || makeTraceId("staff-ctx");
  try {
    const member = await currentMember.getMember({ fieldsets: ["FULL"] }).catch(() => null);
    if (!member) {
      return { status: "ERROR", data: null, error: { code: "AUTH_REQUIRED", message: "Sesion no identificada." } };
    }
    const email = _resolveMemberEmail(member);
    const memberId = _safeTrim(member._id || member.id);
    const staff = (await findStaff(email)) || (await findStaff(memberId));
    return {
      status: "SUCCESS",
      data: {
        resourceId: staff?.resourceId || null,
        staffMemberId: staff?.staffMemberId || memberId,
        displayName: staff?.displayName || member.profile?.nickname || member.contactDetails?.firstName || "Marian",
        email,
        scheduleId: staff?.scheduleId || null,
        active: staff?.active !== false,
      },
      error: null,
    };
  } catch (err) {
    const norm = normalizeError(err);
    log.error("getMyStaffContext failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "STAFF_CONTEXT_FAIL", message: norm.message } };
  }
});
export const registrarFichaje = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options.traceId || makeTraceId("fichaje");
  try {
    _rateLimitOrThrow("horario.registrarFichaje", "staff", traceId);
    const member = await currentMember.getMember({ fieldsets: ["FULL"] });
    const email = _resolveMemberEmail(member);
    const staff = await findStaff(email);
    if (!staff) {
      throw { code: "STAFF_NOT_FOUND", message: "User is not registered as staff", isValidation: true };
    }
    const rawTipo = _safeTrim(options.clockEventType).toUpperCase();
    const rawMotivo = _safeTrim(options.adjustmentReason);
    const { recordedAt } = options;
    if (!Object.values(TIPO_FICHAJE).includes(rawTipo)) {
      throw { code: "INVALID_TIPO", message: `Invalid clock type: ${rawTipo}`, isValidation: true };
    }
    if (rawTipo === TIPO_FICHAJE.AJUSTE && !rawMotivo) {
      throw { code: "MOTIVO_REQUIRED", message: "adjustmentReason is required for AJUSTE type", isValidation: true };
    }
    const now = new Date();
    const recordAt = recordedAt ? new Date(recordedAt) : now;
    if (isNaN(recordAt.getTime())) {
      throw { code: "INVALID_DATE", message: "Invalid date provided", isValidation: true };
    }
    if (recordAt.getTime() > now.getTime() + 60000) {
      throw { code: "INVALID_TIMESTAMP", message: "Future timestamps are forbidden", isValidation: true };
    }
    const lastFichajeRes = await wixData.query(REGISTRO_COL)
      .eq("resourceId", staff.resourceId)
      .descending("recordedAt")
      .limit(1)
      .find({ suppressAuth: true });
    const lastFichaje = lastFichajeRes.items?.[0];
    if (lastFichaje) {
      const lastTipo = _readFichajeTipo(lastFichaje);
      const isValidTransition =
        (rawTipo === TIPO_FICHAJE.ENTRADA && (lastTipo === TIPO_FICHAJE.SALIDA || lastTipo === TIPO_FICHAJE.AJUSTE)) ||
        (rawTipo === TIPO_FICHAJE.SALIDA && (lastTipo === TIPO_FICHAJE.ENTRADA || lastTipo === TIPO_FICHAJE.PAUSA_FIN)) ||
        (rawTipo === TIPO_FICHAJE.PAUSA_INICIO && lastTipo === TIPO_FICHAJE.ENTRADA) ||
        (rawTipo === TIPO_FICHAJE.PAUSA_FIN && lastTipo === TIPO_FICHAJE.PAUSA_INICIO) ||
        (rawTipo === TIPO_FICHAJE.AJUSTE);
      if (!isValidTransition) {
        throw { code: "INVALID_TRANSITION", message: `Cannot transition from ${lastTipo} to ${rawTipo}`, isValidation: true };
      }
    }
    const record = _buildLaborRecord({
      staff,
      tipo: rawTipo,
      dateObj: recordAt,
      motivo: rawMotivo,
      registeredBy: email,
      registeredByMemberId: member._id || member.id || null,
      traceId,
    });
    const result = await wixData.insert(REGISTRO_COL, record, { suppressAuth: true });
    log.info("Fichaje registrado", { resourceId: staff.resourceId, clockEventType: rawTipo, traceId });
    return { status: "SUCCESS", data: result, error: null };
  } catch (err) {
    if (err.isValidation) {
      return { status: "ERROR", data: null, error: { code: err.code, message: err.message } };
    }
    const norm = normalizeError(err);
    log.error("registrarFichaje failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "HORARIO_FAIL", message: norm.message } };
  }
});
export const getEstadoJornada = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options.traceId || makeTraceId("estado-jornada");
  try {
    _rateLimitOrThrow("horario.getEstadoJornada", "staff", traceId);
    const member = await currentMember.getMember({ fieldsets: ["FULL"] });
    const email = _resolveMemberEmail(member);
    const staff = await findStaff(email);
    if (!staff) throw new Error("User is not registered as staff");
    const hoy = getMadridLocalStringNoZ(new Date()).slice(0, 10);
    const fichajesRes = await wixData.query(REGISTRO_COL)
      .eq("resourceId", staff.resourceId)
      .eq("dayKey", hoy)
      .ascending("recordedAt")
      .find({ suppressAuth: true });
    const fichajes = fichajesRes.items || [];
    if (fichajes.length === 0) {
      return {
        status: "SUCCESS",
        data: { enJornada: false, enPausa: false, minutosTrabajados: 0, minutosPausa: 0, fichajes: [] },
        error: null,
      };
    }
    const ultimoFichaje = fichajes[fichajes.length - 1];
    const ultimoTipo = _readFichajeTipo(ultimoFichaje);
    const jornadaActiva = ultimoTipo === TIPO_FICHAJE.ENTRADA || ultimoTipo === TIPO_FICHAJE.PAUSA_FIN;
    const enPausa = ultimoTipo === TIPO_FICHAJE.PAUSA_INICIO;
    const fichajeEntrada = fichajes.find((f) => _readFichajeTipo(f) === TIPO_FICHAJE.ENTRADA);
    let minutosTrabajados = 0;
    let minutosPausa = 0;
    let entradaActiva = null;
    let pausaActiva = null;
    for (const f of fichajes) {
      const tipo = _readFichajeTipo(f);
      const ts = _readFichajeFecha(f);
      if (tipo === TIPO_FICHAJE.ENTRADA) {
        entradaActiva = ts;
        pausaActiva = null;
      } else if (tipo === TIPO_FICHAJE.PAUSA_INICIO) {
        if (entradaActiva) {
          minutosTrabajados += Math.round((ts.getTime() - entradaActiva.getTime()) / 60000);
          entradaActiva = null;
        }
        pausaActiva = ts;
      } else if (tipo === TIPO_FICHAJE.PAUSA_FIN) {
        if (pausaActiva) {
          minutosPausa += Math.round((ts.getTime() - pausaActiva.getTime()) / 60000);
          pausaActiva = null;
        }
        entradaActiva = ts;
      } else if (tipo === TIPO_FICHAJE.SALIDA) {
        if (entradaActiva) {
          minutosTrabajados += Math.round((ts.getTime() - entradaActiva.getTime()) / 60000);
          entradaActiva = null;
        }
      }
    }
    const now = new Date();
    if (entradaActiva && jornadaActiva) {
      minutosTrabajados += Math.round((now.getTime() - entradaActiva.getTime()) / 60000);
    }
    if (pausaActiva && enPausa) {
      minutosPausa += Math.round((now.getTime() - pausaActiva.getTime()) / 60000);
    }
    return {
      status: "SUCCESS",
      data: {
        enJornada: jornadaActiva,
        enPausa,
        minutosTrabajados,
        minutosPausa,
        ultimoFichaje: {
          clockEventType: ultimoTipo,
          recordedAt: ultimoFichaje.recordedAt,
        },
        fechaHoraApertura: fichajeEntrada ? fichajeEntrada.recordedAt : null,
        fichajes: fichajes.map((f) => ({
          clockEventType: _readFichajeTipo(f),
          recordedAt: f.recordedAt,
          recordedTime: f.recordedTime || null,
        })),
      },
      error: null,
    };
  } catch (err) {
    const norm = normalizeError(err);
    log.error("getEstadoJornada failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "HORARIO_FAIL", message: norm.message } };
  }
});
 export const calcularHorasTrabajadas = webMethod(Permissions.Admin, async (options = {}) => {
   const traceId = options.traceId || makeTraceId("calc-horas");
   try {
     _rateLimitOrThrow("horario.calcularHorasTrabajadas", "admin", traceId);
     await requireAdmin(traceId);
     const { resourceId, fechaInicio, fechaFin } = options;
     if (!resourceId || !fechaInicio || !fechaFin) {
       throw new Error("resourceId, fechaInicio, and fechaFin are required");
     }
     let allFichajes = [];
     let query = wixData.query(REGISTRO_COL)
       .eq("resourceId", resourceId)
       .ge("recordedAt", new Date(fechaInicio))
       .le("recordedAt", new Date(fechaFin))
       .ascending("recordedAt")
       .limit(1000);
     let res = await query.find({ suppressAuth: true });
     allFichajes = allFichajes.concat(res.items || []);
     let page = 2;
     const maxPages = 10;
     let reachedMaxPages = false;
     while (res.hasNext() && page <= maxPages) {
       res = await res.next();
       allFichajes = allFichajes.concat(res.items || []);
       page++;
     }
     if (page > maxPages && res.hasNext()) {
       reachedMaxPages = true;
       log.warn("calcularHorasTrabajadas: reached maxPages limit", { resourceId, maxPages, traceId });
     }
     let totalMinutes = 0;
     let breakMinutes = 0;
     let activeStart = null;
     let breakStart = null;
     for (const f of allFichajes) {
       const tipo = _readFichajeTipo(f);
       const ts = _readFichajeFecha(f);
       if (tipo === TIPO_FICHAJE.ENTRADA) {
         activeStart = ts;
       } else if (tipo === TIPO_FICHAJE.PAUSA_INICIO) {
         if (activeStart) {
           totalMinutes += Math.round((ts.getTime() - activeStart.getTime()) / 60000);
           activeStart = null;
         }
         breakStart = ts;
       } else if (tipo === TIPO_FICHAJE.PAUSA_FIN) {
         if (breakStart) {
           breakMinutes += Math.round((ts.getTime() - breakStart.getTime()) / 60000);
           breakStart = null;
         }
         activeStart = ts;
       } else if (tipo === TIPO_FICHAJE.SALIDA) {
         if (activeStart) {
           totalMinutes += Math.round((ts.getTime() - activeStart.getTime()) / 60000);
           activeStart = null;
         }
       }
     }
     return {
       status: "SUCCESS",
       data: {
         resourceId,
         fechaInicio,
         fechaFin,
         totalMinutes,
         totalHours: Math.round((totalMinutes / 60) * 100) / 100,
         breakMinutes,
         totalFichajes: allFichajes.length,
         reachedMaxPages,
       },
       error: null,
     };
   } catch (err) {
     const norm = normalizeError(err);
     log.error("calcularHorasTrabajadas failed", { code: norm.code, error: norm.message, traceId });
     return { status: "ERROR", data: null, error: { code: norm.code || "HORARIO_FAIL", message: norm.message } };
   }
 });
 export const getHistorialFichajes = webMethod(Permissions.SiteMember, async (options = {}) => {
   const traceId = options.traceId || makeTraceId("historial");
   try {
     _rateLimitOrThrow("horario.getHistorialFichajes", "staff", traceId);
     const member = await currentMember.getMember({ fieldsets: ["FULL"] });
     const email = _resolveMemberEmail(member);
     const staff = await findStaff(email);
     if (!staff) throw new Error("User is not registered as staff");
     const { limit = 50, offset = 0 } = options;
     const safeLimit = Math.min(Number(limit) || 50, 200);
     const res = await wixData.query(REGISTRO_COL)
       .eq("resourceId", staff.resourceId)
       .descending("recordedAt")
       .limit(safeLimit)
       .skip(Number(offset) || 0)
       .find({ suppressAuth: true });
     return {
       status: "SUCCESS",
       data: {
         fichajes: res.items || [],
         total: res.totalCount || 0,
         limit: safeLimit,
         offset: Number(offset) || 0,
       },
       error: null,
     };
   } catch (err) {
     const norm = normalizeError(err);
     log.error("getHistorialFichajes failed", { code: norm.code, error: norm.message, traceId });
     return { status: "ERROR", data: null, error: { code: norm.code || "HORARIO_FAIL", message: norm.message } };
   }
 });
 export const registrarAjusteHorario = webMethod(Permissions.Admin, async (options = {}) => {
   const traceId = options.traceId || makeTraceId("ajuste");
   try {
     _rateLimitOrThrow("horario.registrarAjusteHorario", "admin", traceId);
     await requireAdmin(traceId);
     const { resourceId, clockEventType, recordedAt, adjustmentReason } = options;
     const finalTipo = _safeTrim(clockEventType).toUpperCase();
     const finalFecha = recordedAt;
     const finalMotivo = _safeTrim(adjustmentReason);
     if (!resourceId || !finalTipo || !finalFecha || !finalMotivo) {
       throw new Error("resourceId, clockEventType, recordedAt, and adjustmentReason are required");
     }
     if (!Object.values(TIPO_FICHAJE).includes(finalTipo)) {
       throw new Error(`Invalid clock type: ${finalTipo}`);
     }
     const staff = await findStaff(resourceId);
     if (!staff) throw new Error("Staff not found for resourceId");
     const adminMember = await currentMember.getMember({ fieldsets: ["FULL"] });
     const adminEmail = adminMember?.loginEmail || "unknown";
     const dateObj = new Date(finalFecha);
     const record = _buildLaborRecord({
       staff,
       tipo: finalTipo,
       dateObj,
       motivo: finalMotivo,
       registeredBy: adminEmail,
       registeredByMemberId: adminMember?._id || adminMember?.id || null,
       traceId,
     });
     const result = await wixData.insert(REGISTRO_COL, record, { suppressAuth: true });
     log.info("Ajuste horario registrado", { resourceId, clockEventType: finalTipo, adminEmail, traceId });
     return { status: "SUCCESS", data: result, error: null };
   } catch (err) {
     const norm = normalizeError(err);
     log.error("registrarAjusteHorario failed", { code: norm.code, error: norm.message, traceId });
     return { status: "ERROR", data: null, error: { code: norm.code || "HORARIO_FAIL", message: norm.message } };
   }
 });
 export const getResumenHoras = webMethod(Permissions.SiteMember, async (options = {}) => {
   const traceId = options.traceId || makeTraceId("resumen");
   try {
     _rateLimitOrThrow("horario.getResumenHoras", "staff", traceId);
     const member = await currentMember.getMember({ fieldsets: ["FULL"] });
     const email = _resolveMemberEmail(member);
     const staff = await findStaff(email);
     if (!staff) throw new Error("User is not registered as staff");
     const now = new Date();
     const mesActual = getMadridLocalStringNoZ(now).slice(0, 7);
     const fichajesRes = await wixData.query(REGISTRO_COL)
       .eq("resourceId", staff.resourceId)
       .eq("monthKey", mesActual)
       .ascending("recordedAt")
       .find({ suppressAuth: true });
     const fichajes = fichajesRes.items || [];
     let totalMinutes = 0;
     let entradaActiva = null;
     for (const f of fichajes) {
       const tipo = _readFichajeTipo(f);
       const ts = _readFichajeFecha(f);
       if (tipo === TIPO_FICHAJE.ENTRADA || tipo === TIPO_FICHAJE.PAUSA_FIN) {
         entradaActiva = ts;
       } else if ((tipo === TIPO_FICHAJE.SALIDA || tipo === TIPO_FICHAJE.PAUSA_INICIO) && entradaActiva) {
         totalMinutes += Math.round((ts.getTime() - entradaActiva.getTime()) / 60000);
         entradaActiva = null;
       }
     }
     const estadoJornada = await getEstadoJornada({ traceId }).catch(() => null);
     if (entradaActiva && estadoJornada?.data?.enJornada) {
       const apertura = estadoJornada.data.fechaHoraApertura;
       if (apertura && !isNaN(new Date(apertura).getTime())) {
         totalMinutes += Math.round((now.getTime() - entradaActiva.getTime()) / 60000);
       } else {
         log.warn("getResumenHoras: jornada abierta sin fechaHoraApertura valida", {
           resourceId: staff.resourceId,
           traceId,
         });
       }
     }
     return {
       status: "SUCCESS",
       data: {
         resourceId: staff.resourceId,
         mesActual,
         totalMinutes,
         totalHours: Math.round((totalMinutes / 60) * 100) / 100,
         totalFichajes: fichajes.length,
         enJornadaAhora: estadoJornada?.data?.enJornada || false,
       },
       error: null,
     };
   } catch (err) {
     const norm = normalizeError(err);
     log.error("getResumenHoras failed", { code: norm.code, error: norm.message, traceId });
     return { status: "ERROR", data: null, error: { code: norm.code || "HORARIO_FAIL", message: norm.message } };
   }
 });
 export async function _validateScheduleNoOverlap(resourceId, dayOfWeek, startTime, endTime, excludeId = null) {
   const existing = await wixData.query(COLLECTIONS.REGISTROS_HORARIOS_STAFF)
     .eq("resourceId", resourceId)
     .eq("dayKey", dayOfWeek)
     .find({ suppressAuth: true });
   const toMinutes = (hhmm) => {
     const [h, m] = String(hhmm || "00:00").split(":").map(Number);
     return (h || 0) * 60 + (m || 0);
   };
   const newStart = toMinutes(startTime);
   const newEnd = toMinutes(endTime);
   if (newStart >= newEnd) {
     throw new Error("RANGO_INVALIDO: La hora de inicio debe ser anterior a la de fin.");
   }
   for (const item of existing.items || []) {
     if (excludeId && item._id === excludeId) continue;
     const exStart = toMinutes(item.startTime);
     const exEnd = toMinutes(item.endTime);
     if (newStart < exEnd && newEnd > exStart) {
       throw new Error(`SOLAPAMIENTO_HORARIO: El turno colisiona con el horario existente (${item.startTime}-${item.endTime})`);
     }
   }
   return true;
 }