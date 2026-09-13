/*
=============================================================================
MODULE: backend/responseUtils.js
VERSION: marianmadrid4001 (v21.0.0-LTS-canonical-response-utils)
RESPONSIBILITY: Centralized response standardization, AppError class,
            and webMethod error handling helpers.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
*/

import { _cloneDeep, _safeTrim } from "public/mmUtils";

const MAX_ERROR_MESSAGE_LENGTH = 500;

export class AppError extends Error {
    constructor(code = "INTERNAL_ERROR", message = "Error interno", meta = {}) {
        super(String(message || "Error interno"));
        this.name = "AppError";
        this.code = String(code || "INTERNAL_ERROR");
        this.meta = meta && typeof meta === "object" ? meta : { details: meta };
        if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
    }
}

export function successResponse(data = null, metaExtra = {}) {
    const extra = metaExtra && typeof metaExtra === "object" ? _cloneDeep(metaExtra) : {};
    return {
        status: "SUCCESS",
        meta: { timestamp: new Date().toISOString(), ...extra },
        data,
        error: null,
    };
}

export function errorResponse(code = "INTERNAL_ERROR", message = "Error inesperado", metaExtra = {}) {
    let finalCode = code;
    let finalMsg = message;
    if (code instanceof Error) {
        finalMsg = code.message || String(code);
        finalCode = code.code || code.name || "UNKNOWN_ERROR";
    } else if (typeof code === "object" && code !== null && (message === undefined || message === null)) {
        finalMsg = code.message || code.error || code.reason || JSON.stringify(code);
        finalCode = code.code || "UNKNOWN_ERROR";
    } else if (typeof code === "string" && (message === undefined || message === null)) {
        finalMsg = code;
        finalCode = "UNKNOWN_ERROR";
    }
    const rawMsg = finalMsg instanceof Error ? finalMsg.message || String(finalMsg) : String(finalMsg || "Unknown error");
    const safeMsg = _safeTrim(rawMsg);
    const truncatedMsg = safeMsg.length > MAX_ERROR_MESSAGE_LENGTH
        ? safeMsg.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "..."
        : safeMsg;
    const extra = metaExtra && typeof metaExtra === "object" ? _cloneDeep(metaExtra) : {};
    return {
        status: "ERROR",
        meta: { timestamp: new Date().toISOString(), ...extra },
        data: null,
        error: {
            code: String(finalCode || "UNKNOWN_ERROR"),
            message: truncatedMsg || "Error no especificado",
        },
    };
}

export function _toPublicError(err, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "Error interno") {
    return {
        code: String(err?.code || fallbackCode),
        message: String(err?.message || fallbackMessage),
    };
}

export function toWebMethodResult(actionFn) {
    return async (...args) => {
        try {
            const result = await actionFn(...args);
            if (result && typeof result === "object" && "status" in result) return result;
            return successResponse(result);
        } catch (err) {
            const code = err?.code || err?.name || "OPERATION_FAILED";
            const message = err?.message || "No se pudo procesar la solicitud.";
            return errorResponse(code, message);
        }
    };
}

export function isSuccess(res) {
    if (!res) return false;
    if (res === true) return true;
    const rawStatus = res?.status ?? res?.payload?.status ?? res?.data?.status;
    if (typeof rawStatus === "string") {
        const norm = rawStatus.trim().toUpperCase();
        if (norm === "SUCCESS" || norm === "OK") return true;
    }
    if (rawStatus === 200 || res?.success === true) return true;
    return false;
}