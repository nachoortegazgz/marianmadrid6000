/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5003.1
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 */

import wixLocation from "wix-location";

import {
    MESSAGE_TYPES,
    URLS,
    UI,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    _sanitizeForLog,
    withTimeout
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web";

let currentServiceId = null;
let currentSlugUrl = null;
let bridge = null;

function parseUrlParams() {
    const query = wixLocation.query || {};

    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slugUrl: _safeSlugOrId(query.slugUrl || ""),
        referral: _safeTrim(query.referral || "")
    };
}

function resolveServiceFromParams(params) {
    if (
        params.serviceId &&
        _looksLikeGuid(params.serviceId)
    ) {
        return {
            serviceId: params.serviceId,
            slugUrl: params.slugUrl || null
        };
    }

    if (params.slugUrl) {
        return {
            serviceId: null,
            slugUrl: params.slugUrl
        };
    }

    return null;
}

function getMessageType(message) {
    return String(
        message &&
        (message.type || message.action) ||
        ""
    ).trim().toUpperCase();
}

function createBookingError(code, message) {
    return {
        status: "ERROR",
        data: null,
        error: {
            code,
            message
        }
    };
}

function getNavigationTarget(payload) {
    return _safeTrim(
        payload && payload.target || ""
    ).toUpperCase();
}

async function handleNavigation(payload) {
    const target = getNavigationTarget(payload);

    if (target === "SERVICIOS") {
        wixLocation.to(
            URLS && URLS.SERVICIOS ?
            URLS.SERVICIOS :
            "/reserva-online"
        );

        return true;
    }

    if (target === "PRIVACY") {
        wixLocation.to(
            URLS && URLS.PRIVACY_POLICY ?
            URLS.PRIVACY_POLICY :
            "/politica-de-privacidad"
        );

        return true;
    }

    return false;
}

$w.onReady(async function () {
    const traceId = makeTraceId("calendario");
    const params = parseUrlParams();
    const resolved = resolveServiceFromParams(params);

    if (!resolved) {
        console.error(
            "[calendario-2] No valid service in URL", { traceId }
        );
        return;
    }

    currentServiceId = resolved.serviceId;
    currentSlugUrl = resolved.slugUrl;

    const widget = $w("#htmlWidgetCalendario");

    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        console.error(
            "[calendario-2] HTML widget is not available", { traceId }
        );
        return;
    }

    bridge = createWidgetBridge(widget, {
        slugUrl: currentSlugUrl ||
            currentServiceId ||
            "calendario",

        traceId,

        handshakeTimeoutMs: UI && UI.HANDSHAKE_TIMEOUT_MS ?
            UI.HANDSHAKE_TIMEOUT_MS :
            30000,

        contextTimeoutMs: UI && UI.CONTEXT_TIMEOUT_MS ?
            UI.CONTEXT_TIMEOUT_MS :
            30000,

        messageTimeoutMs: UI && UI.FRONTEND_API_TIMEOUT_MS ?
            UI.FRONTEND_API_TIMEOUT_MS :
            30000,

        onContextReady: async function () {
            return {
                serviceId: currentServiceId,
                slugUrl: currentSlugUrl,
                referral: params.referral
            };
        },

        onWidgetMessage: async function (message, reply) {
            const type = getMessageType(message);
            const payload =
                message && message.payload &&
                typeof message.payload === "object" ?
                message.payload :
                {};

            if (type === MESSAGE_TYPES.NAV) {
                await handleNavigation(payload);
                return;
            }

            if (type !== MESSAGE_TYPES.BOOK) {
                console.warn(
                    "[calendario-2] Unsupported widget message", { traceId, type }
                );
                return;
            }

            const bookingData =
                payload.bookingData &&
                typeof payload.bookingData === "object" ?
                payload.bookingData :
                payload;

            if (
                !bookingData ||
                typeof bookingData !== "object"
            ) {
                const invalidResult = createBookingError(
                    "INVALID_BOOKING_PAYLOAD",
                    "Los datos de la reserva no son validos."
                );

                reply("BOOK_RES", invalidResult);
                return invalidResult;
            }

            const requestPayload = {
                ...bookingData,
                serviceId: bookingData.serviceId ||
                    currentServiceId,
                slugUrl: bookingData.slugUrl ||
                    currentSlugUrl,
                traceId
            };

            console.info(
                "[calendario-2] Booking request received", {
                    traceId,
                    data: _sanitizeForLog(requestPayload)
                }
            );

            try {
                const result = await withTimeout(
                    processDualBooking(requestPayload),
                    UI && UI.FRONTEND_API_TIMEOUT_MS ?
                    UI.FRONTEND_API_TIMEOUT_MS :
                    30000,
                    "processDualBooking"
                );

                const safeResult = result || {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "EMPTY_BOOKING_RESPONSE",
                        message: "No se recibio respuesta de la reserva."
                    }
                };

                reply("BOOK_RES", safeResult);
                return safeResult;
            } catch (error) {
                const message = String(
                    error && error.message || ""
                );

                const isTimeout =
                    error &&
                    error.code === "TIMEOUT" ||
                    message.toUpperCase().includes("TIMEOUT");

                const result = createBookingError(
                    isTimeout ?
                    "BOOKING_TIMEOUT" :
                    "BOOKING_FAILED",
                    isTimeout ?
                    "La reserva esta tardando demasiado. Intentalo de nuevo." :
                    "No se pudo completar la reserva."
                );

                console.error(
                    "[calendario-2] Booking request failed", {
                        traceId,
                        code: result.error.code,
                        message
                    }
                );

                reply("BOOK_RES", result);
                return result;
            }
        },

        onError: function (error) {
            console.error(
                "[calendario-2] Widget bridge error", {
                    traceId,
                    message: error && error.message
                }
            );
        }
    });

    if (!bridge) {
        console.error(
            "[calendario-2] Widget bridge initialization failed", { traceId }
        );
    }
});