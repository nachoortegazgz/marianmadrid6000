/*
=============================================================================
MODULE: backend/crons.js
VERSION: v5005-2
RESPONSIBILITY: Scheduled jobs for system maintenance and recovery.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
*/
import wixData from "wix-data";
import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { makeTraceId } from "public/mmUtils";
import { logger } from "backend/booking/bookingCore";
import { _cleanExpiredDualSlotsInternal } from "backend/reservas.web";
import { processPendingFiscalRecoveries, _registerZClosingInternal } from "backend/cajas.web";
import { processBookingsServiceSyncQueue } from "backend/bookingServiceSync";
const log = logger;
export async function cleanExpiredLocks() {
const traceId = makeTraceId("cron-locks");
try {
const now = new Date();
const res = await wixData
.query(COLLECTIONS.SLOT_LOCKS)
.lt("expiresAt", now)
.limit(100)
.find({ suppressAuth: true });
let removed = 0;
for (const item of res?.items || []) {
await wixData.remove(COLLECTIONS.SLOT_LOCKS, item._id, { suppressAuth: true }).catch(() => null);
removed++;
}
log.info("Expired locks cleaned", { traceId, removed });
return { status: "SUCCESS", data: { removed }, error: null };
} catch (error) {
log.error("cleanExpiredLocks failed", { traceId, error: error?.message });
return { status: "ERROR", data: null, error: { code: "CRON_FAIL", message: error?.message } };
}
}
export async function cleanExpiredDualCache() {
const traceId = makeTraceId("cron-dual-cache");
try {
const result = await _cleanExpiredDualSlotsInternal({ limit: 100, traceId });
log.info("Expired dual cache cleaned", { traceId, removed: result?.data?.removed || 0 });
return result;
} catch (error) {
log.error("cleanExpiredDualCache failed", { traceId, error: error?.message });
return { status: "ERROR", data: null, error: { code: "CRON_FAIL", message: error?.message } };
}
}
export async function processFiscalRecoveries() {
const traceId = makeTraceId("cron-fiscal-recovery");
try {
const result = await processPendingFiscalRecoveries({ traceId, limit: 25 });
log.info("Fiscal recoveries processed", { traceId, ...result?.data });
return result;
} catch (error) {
log.error("processFiscalRecoveries failed", { traceId, error: error?.message });
return { status: "ERROR", data: null, error: { code: "CRON_FAIL", message: error?.message } };
}
}
export async function nightlyZClosing() {
const traceId = makeTraceId("cron-z-closing");
try {
const tz = SDK_CONFIG?.TZ || "Europe/Madrid";
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const diaKey = yesterday.toLocaleDateString("sv-SE", { timeZone: tz });
const result = await _registerZClosingInternal(diaKey, { traceId, autoCron: true });
log.info("Nightly Z closing processed", { traceId, diaKey, status: result?.status });
return result;
} catch (error) {
log.error("nightlyZClosing failed", { traceId, error: error?.message });
return { status: "ERROR", data: null, error: { code: "CRON_FAIL", message: error?.message } };
}
}
export async function processBookingsSync() {
const traceId = makeTraceId("cron-bookings-sync");
try {
const result = await processBookingsServiceSyncQueue({ traceId });
log.info("Bookings service sync processed", { traceId, ...result?.data });
return result;
} catch (error) {
log.error("processBookingsSync failed", { traceId, error: error?.message });
return { status: "ERROR", data: null, error: { code: "CRON_FAIL", message: error?.message } };
}
}
export async function cleanAuditLogs() {
const traceId = makeTraceId("cron-audit-clean");
try {
const retentionDays = SDK_CONFIG?.JOBS?.AUDIT_RETENTION_DAYS || 90;
const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
const res = await wixData
.query(COLLECTIONS.MM_AUDIT_LOG)
.lt("loggedAt", cutoff)
.limit(100)
.find({ suppressAuth: true });
let removed = 0;
for (const item of res?.items || []) {
await wixData.remove(COLLECTIONS.MM_AUDIT_LOG, item._id, { suppressAuth: true }).catch(() => null);
removed++;
}
log.info("Audit logs cleaned", { traceId, removed });
return { status: "SUCCESS", data: { removed }, error: null };
} catch (error) {
log.error("cleanAuditLogs failed", { traceId, error: error?.message });
return { status: "ERROR", data: null, error: { code: "CRON_FAIL", message: error?.message } };
}
}