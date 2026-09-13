/**
 * MODULE: public/mmUtils.js
 * VERSION: v5005-5
 * ASCII ONLY
 */

export const VERSION = Object.freeze({
    CORE: "v5005-5",
    BOOKINGS_API: "v2",
    STORES_CATALOG: "v1",
    COMPLIANCE_ES: "2026"
});

export const SDK_CONFIG = Object.freeze({
    TZ: "Europe/Madrid",
    CURRENCY: "EUR"
});

export const TIMEOUTS = Object.freeze({
    API_MS: 15000,
    FRONTEND_MS: 30000,
    WATCHDOG_MS: 30000
});

export const MONEY = Object.freeze({
    DISPLAY_CURRENCY: "EUR",
    DECIMAL_PLACES: 2
});

export const BOOKINGS_ADDON_CONFIG = Object.freeze({
    MAX_PER_BOOKING: 21
});

export const MESSAGE_TYPES = Object.freeze({
    READY: "MM_READY",
    CONTEXT: "MM_CONTEXT",
    AVAIL: "MM_AVAIL",
    SELECT: "MM_SELECT",
    BOOK: "MM_BOOK",
    NAV: "MM_NAV"
});

export const URLS = Object.freeze({
    SERVICIOS: "/reserva-online",
    CALENDARIO_2: "/booking-calendar/calendario-2",
    DETALLE_SERVICIO: "/servicio-2",
    PRIVACY_POLICY: "/politica-de-privacidad",
    TPV_PANEL: "/onlystaff"
});

export const UI = Object.freeze({
    HANDSHAKE_MAX_ATTEMPTS: 7,
    HANDSHAKE_BASE_BACKOFF_MS: 750,
    HANDSHAKE_TIMEOUT_MS: 120000,
    CONTEXT_TIMEOUT_MS: 120000,
    FRONTEND_API_TIMEOUT_MS: 30000,
    FRONTEND_RETRY_ATTEMPTS: 3,
    FRONTEND_RETRY_BASE_BACKOFF_MS: 500,
    TPV_POLLING_MS: 60000,
    MAX_VISIBLE_SLOTS: 100,
    SLOT_BUTTON_CLASS: "slot-btn",
    DEFAULT_SERVICE_IMAGE_URL: "https://static.wixstatic.com/media/ab7708_374e5f7adb2f47f3944f3355da129b80~mv2.jpg",
    SALON_LOCATION_LABEL: "C/ Maurice Ravel 35, Zaragoza"
});

export const STAFF_DEFAULT_NAME = "PROFESIONAL SEGUN HORARIO";

export const ARIA = Object.freeze({
    ROLE: Object.freeze({
        BUTTON: "button",
        DIALOG: "dialog",
        ALERT: "alert",
        STATUS: "status",
        NAVIGATION: "navigation",
        MAIN: "main",
        FORM: "form",
        LIST: "list",
        LISTITEM: "listitem"
    }),
    LIVE: Object.freeze({
        POLITE: "polite",
        ASSERTIVE: "assertive"
    })
});

export const LOADING_STATES = Object.freeze({
    IDLE: "idle",
    LOADING: "loading",
    SUCCESS: "success",
    ERROR: "error"
});

export const VALIDATION_RULES = Object.freeze({
    REQUIRED: "required",
    EMAIL: "email",
    PHONE: "phone",
    MIN_LENGTH: "minLength",
    MAX_LENGTH: "maxLength",
    PATTERN: "pattern"
});

export function normalizeIdPart(value, maxLength = 80) {
    const text = String(value || "").trim();
    const safe = text.replace(/[^A-Za-z0-9_-]/g, "");

    return safe.length > maxLength ?
        safe.slice(0, maxLength) :
        safe;
}

export function _normalizeIdPart(value, maxLength = 80) {
    return normalizeIdPart(value, maxLength);
}

export function makeTraceId(prefix = "mm") {
    const safePrefix = normalizeIdPart(prefix, 20) || "mm";
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 10);

    return `${safePrefix}_${timestamp}_${random}`;
}

export function _safeTrim(value) {
    return value === null || value === undefined ?
        "" :
        String(value).trim();
}

export function _cloneDeep(value) {
    if (value === null || typeof value !== "object") {
        return value;
    }

    if (value instanceof Date) {
        return new Date(value.getTime());
    }

    if (Array.isArray(value)) {
        return value.map((item) => _cloneDeep(item));
    }

    const output = {};

    Object.keys(value).forEach((key) => {
        output[key] = _cloneDeep(value[key]);
    });

    return output;
}

export function _safeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

export function _isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_safeEmail(value));
}

export function _safePhone(value) {
    const raw = String(value || "").trim();

    if (!raw) {
        return "";
    }

    const prefix = raw.startsWith("+") ? "+" : "";
    const digits = raw.replace(/\D/g, "");

    return digits ? `${prefix}${digits}` : "";
}

export function _looksLikeGuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(String(value || "").trim());
}

export function _safeSlugOrId(value) {
    let text = String(value || "").trim();

    if (!text) {
        return "";
    }

    text = text.split("?")[0].split("#")[0];
    text = text.replace(/^\/+|\/+$/g, "");

    const parts = text.split("/").filter(Boolean);
    text = parts.length ? parts[parts.length - 1] : text;

    if (_looksLikeGuid(text)) {
        return text;
    }

    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

export function _normalizeLocalIsoStr(value) {
    if (!value || value instanceof Date) {
        return "";
    }

    const match =
        /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/
        .exec(String(value).trim());

    if (!match) {
        return "";
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] === undefined ? 0 : Number(match[4]);
    const minute = match[5] === undefined ? 0 : Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);

    const check = new Date(
        Date.UTC(year, month - 1, day, hour, minute, second)
    );

    const valid =
        check.getUTCFullYear() === year &&
        check.getUTCMonth() === month - 1 &&
        check.getUTCDate() === day &&
        hour >= 0 &&
        hour <= 23 &&
        minute >= 0 &&
        minute <= 59 &&
        second >= 0 &&
        second <= 59;

    if (!valid) {
        return "";
    }

    return (
        `${String(year).padStart(4, "0")}-` +
        `${String(month).padStart(2, "0")}-` +
        `${String(day).padStart(2, "0")}T` +
        `${String(hour).padStart(2, "0")}:` +
        `${String(minute).padStart(2, "0")}:` +
        `${String(second).padStart(2, "0")}`
    );
}

export function _toDateSafe(value) {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "object" && value.$date) {
        return _toDateSafe(value.$date);
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
}

export function getUtcDateFromMadridLocal(localValue) {
    if (localValue instanceof Date) {
        return _toDateSafe(localValue);
    }

    const normalized = _normalizeLocalIsoStr(localValue);

    if (!normalized) {
        return null;
    }

    const parts = normalized.split("T");
    const dateParts = parts[0].split("-").map(Number);
    const timeParts = parts[1].split(":").map(Number);

    const year = dateParts[0];
    const month = dateParts[1];
    const day = dateParts[2];
    const hour = timeParts[0];
    const minute = timeParts[1];
    const second = timeParts[2];

    const guessUtcMs = Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second
    );

    const guessDate = new Date(guessUtcMs);

    const formatter = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG.TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });

    const partsFormatted = formatter.formatToParts(guessDate);

    function getPart(type) {
        const part = partsFormatted.find((item) => item.type === type);
        return part ? Number(part.value) : NaN;
    }

    const localAsUtcMs = Date.UTC(
        getPart("year"),
        getPart("month") - 1,
        getPart("day"),
        getPart("hour"),
        getPart("minute"),
        getPart("second")
    );

    const offsetMs = localAsUtcMs - guessDate.getTime();
    const result = new Date(guessUtcMs - offsetMs);

    if (Number.isNaN(result.getTime())) {
        return null;
    }

    const roundTrip = formatter.formatToParts(result);

    function getRoundTripPart(type) {
        const part = roundTrip.find((item) => item.type === type);
        return part ? Number(part.value) : NaN;
    }

    const matches =
        getRoundTripPart("year") === year &&
        getRoundTripPart("month") === month &&
        getRoundTripPart("day") === day &&
        getRoundTripPart("hour") === hour &&
        getRoundTripPart("minute") === minute &&
        getRoundTripPart("second") === second;

    return matches ? result : null;
}

export function getMadridLocalStringNoZ(value) {
    const date = _toDateSafe(value);

    if (!date) {
        return "";
    }

    return date
        .toLocaleString("sv-SE", {
            timeZone: SDK_CONFIG.TZ,
            hour12: false
        })
        .replace(" ", "T");
}

export function withTimeout(
    promise,
    timeoutMs = TIMEOUTS.API_MS,
    label = "operation"
) {
    const ms =
        Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ?
        Number(timeoutMs) :
        TIMEOUTS.API_MS;

    let timer = null;

    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(
                `TIMEOUT: ${label} exceeded ${ms}ms`
            );

            error.code = "TIMEOUT";
            reject(error);
        }, ms);
    });

    return Promise.race([
        Promise.resolve(promise),
        timeoutPromise
    ]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

function extractStatusCode(error) {
    if (!error) {
        return null;
    }

    if (Number.isInteger(error.statusCode)) {
        return error.statusCode;
    }

    if (Number.isInteger(error.status)) {
        return error.status;
    }

    if (
        error.details &&
        Number.isInteger(error.details.statusCode)
    ) {
        return error.details.statusCode;
    }

    return null;
}

function isRetryableError(error) {
    return [
        408,
        425,
        429,
        500,
        502,
        503,
        504
    ].includes(extractStatusCode(error));
}

export async function executeWithRetry(fn, options = {}) {
    if (typeof fn !== "function") {
        throw new TypeError("RETRY_FUNCTION_REQUIRED");
    }

    const attempts = Number.isInteger(options.attempts) ?
        Math.max(1, Math.min(options.attempts, 5)) :
        3;

    const baseDelay = Number.isFinite(options.baseDelay) ?
        Math.max(100, Number(options.baseDelay)) :
        500;

    const retrySafe = options.retrySafe === true;
    let lastError = null;

    for (
        let attempt = 0; attempt < attempts; attempt += 1
    ) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (!retrySafe || !isRetryableError(error)) {
                throw error;
            }

            if (attempt >= attempts - 1) {
                break;
            }

            const delay =
                baseDelay * (2 ** attempt) +
                Math.floor(Math.random() * baseDelay);

            await new Promise((resolve) => {
                setTimeout(resolve, delay);
            });
        }
    }

    throw lastError || new Error("RETRY_FAILED");
}

export const _executeWithRetry = executeWithRetry;

export function _roundMoney(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount)) {
        return 0;
    }

    return Math.round(
        (amount + Number.EPSILON) * 100
    ) / 100;
}

export function _readPositiveAmount(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const amount = _roundMoney(value);

    return amount > 0 ? amount : null;
}

export function _readNonNegativeAmount(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const amount = _roundMoney(value);

    return amount >= 0 ? amount : null;
}

export function _maskEmail(value) {
    const email = _safeEmail(value);
    const parts = email.split("@");

    if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1]
    ) {
        return "***@***";
    }

    return `${parts[0].slice(0, 2)}***@${parts[1]}`;
}

export function _maskPhone(value) {
    const phone = _safePhone(value);

    if (phone.length <= 4) {
        return "***";
    }

    return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

export function _maskName(value) {
    const name = String(value || "").trim();

    if (!name) {
        return "";
    }

    if (name.length <= 2) {
        return `${name[0]}*`;
    }

    return `${name[0]}*${name[name.length - 1]}`;
}

export function _cleanText(value, maxLength = 5000) {
    const text = String(value ?? "").trim();

    if (text.length > maxLength) {
        throw new Error("TEXT_TOO_LONG");
    }

    return text;
}

export function _extractRelationalId(value) {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "string") {
        return value.trim();
    }

    if (typeof value === "object") {
        return String(
            value._id ||
            value.id ||
            value.serviceId ||
            ""
        ).trim();
    }

    return String(value).trim();
}

export function _normType(value) {
    return value ?
        String(value).trim().toUpperCase() :
        "";
}

export function _readDate(value) {
    const text = String(value || "");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return null;
    }

    const date = new Date(`${text}T00:00:00Z`);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const normalized = [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-");

    return normalized === text ? text : null;
}

export function _stableSerialize(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(_stableSerialize).join(",")}]`;
    }

    return `{${Object.keys(value)
    .sort()
    .map((key) => {
      return (
        `${JSON.stringify(key)}:` +
        _stableSerialize(value[key])
      );
    })
    .join(",")}}`;
}

export function _hashKey(value) {
    const text = String(value || "");
    let hash = 5381;

    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }

    return Math.abs(hash)
        .toString(16)
        .padStart(8, "0");
}

export function _generateUUID() {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }

    const template =
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";

    return template.replace(/[xy]/g, (char) => {
        const random = Math.floor(Math.random() * 16);
        const value = char === "x" ?
            random :
            (random & 3) | 8;

        return value.toString(16);
    });
}

export function _sanitizeForLog(
    value,
    sensitiveKeys = [
        "email",
        "phone",
        "telefono",
        "nombre",
        "apellidos",
        "address",
        "direccion",
        "cliente",
        "contact",
        "token",
        "password",
        "secret",
        "authorization",
        "cookie"
    ]
) {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) =>
            _sanitizeForLog(item, sensitiveKeys)
        );
    }

    if (typeof value !== "object") {
        return value;
    }

    const result = {};

    Object.entries(value).forEach(([key, item]) => {
        const lowerKey = key.toLowerCase();

        const sensitive = sensitiveKeys.some((entry) =>
            lowerKey.includes(entry.toLowerCase())
        );

        result[key] = sensitive ?
            "***REDACTED***" :
            _sanitizeForLog(item, sensitiveKeys);
    });

    return result;
}

export function _createAriaLabel(text, context = "") {
    const clean = String(text || "").trim();

    if (!clean) {
        return "";
    }

    return context ?
        `${clean}, ${String(context).trim()}` :
        clean;
}

export function _announceToScreenReader(
    message,
    priority = ARIA.LIVE.POLITE
) {
    if (
        typeof document === "undefined" ||
        !document.body
    ) {
        return;
    }

    let announcer = document.getElementById(
        "sr-announcer"
    );

    if (!announcer) {
        announcer = document.createElement("div");
        announcer.id = "sr-announcer";
        announcer.style.cssText =
            "position:absolute;left:-10000px;" +
            "width:1px;height:1px;overflow:hidden;";
        document.body.appendChild(announcer);
    }

    announcer.setAttribute("aria-live", priority);
    announcer.setAttribute("aria-atomic", "true");
    announcer.textContent = "";

    setTimeout(() => {
        if (announcer) {
            announcer.textContent = String(message || "");
        }
    }, 100);
}

export function _createLoadingState(container) {
    if (!container) {
        throw new Error("LOADING_CONTAINER_REQUIRED");
    }

    const state = {
        current: LOADING_STATES.IDLE,

        showLoading(message = "Cargando...") {
            state.current = LOADING_STATES.LOADING;
            container.textContent = String(message);
            container.setAttribute("role", ARIA.ROLE.STATUS);
            _announceToScreenReader(message);
        },

        showSuccess(message = "Completado") {
            state.current = LOADING_STATES.SUCCESS;
            container.textContent = String(message);
            container.setAttribute("role", ARIA.ROLE.STATUS);
            _announceToScreenReader(message);
        },

        showError(message = "Error") {
            state.current = LOADING_STATES.ERROR;
            container.textContent = String(message);
            container.setAttribute("role", ARIA.ROLE.ALERT);
            _announceToScreenReader(
                message,
                ARIA.LIVE.ASSERTIVE
            );
        },

        reset() {
            state.current = LOADING_STATES.IDLE;
            container.textContent = "";
        }
    };

    return state;
}

export function _validateField(value, rules = []) {
    const errors = [];
    const text = String(value || "").trim();

    rules.forEach((rule) => {
        if (!rule || typeof rule !== "object") {
            return;
        }

        switch (rule.type) {
        case VALIDATION_RULES.REQUIRED:
            if (!text) {
                errors.push(
                    rule.message || "Este campo es obligatorio"
                );
            }
            break;

        case VALIDATION_RULES.EMAIL:
            if (text && !_isValidEmail(text)) {
                errors.push(
                    rule.message || "Email invalido"
                );
            }
            break;

        case VALIDATION_RULES.PHONE:
            if (
                text &&
                !/^[+]?[0-9\s()\-]{9,20}$/.test(text)
            ) {
                errors.push(
                    rule.message || "Telefono invalido"
                );
            }
            break;

        case VALIDATION_RULES.MIN_LENGTH:
            if (
                text &&
                text.length < Number(rule.value)
            ) {
                errors.push(
                    rule.message ||
                    `Minimo ${rule.value} caracteres`
                );
            }
            break;

        case VALIDATION_RULES.MAX_LENGTH:
            if (
                text &&
                text.length > Number(rule.value)
            ) {
                errors.push(
                    rule.message ||
                    `Maximo ${rule.value} caracteres`
                );
            }
            break;

        case VALIDATION_RULES.PATTERN:
            if (
                text &&
                rule.value instanceof RegExp
            ) {
                rule.value.lastIndex = 0;

                if (!rule.value.test(text)) {
                    errors.push(
                        rule.message || "Formato invalido"
                    );
                }

                rule.value.lastIndex = 0;
            }
            break;

        default:
            break;
        }
    });

    return {
        isValid: errors.length === 0,
        errors
    };
}

export function _serializeForm(formElement) {
    if (
        !formElement ||
        !formElement.elements
    ) {
        return {};
    }

    const data = {};

    Array.from(formElement.elements).forEach((element) => {
        if (!element.name || element.disabled) {
            return;
        }

        if (element.type === "checkbox") {
            data[element.name] = element.checked;
            return;
        }

        if (element.type === "radio") {
            if (element.checked) {
                data[element.name] = element.value;
            }
            return;
        }

        data[element.name] = element.value;
    });

    return data;
}