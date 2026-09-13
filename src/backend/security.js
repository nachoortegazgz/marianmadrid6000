/*
=============================================================================
MODULE: backend/security.js
VERSION: v5004-rbac-security
RESPONSIBILITY: RBAC authorization, persistent blocks and rate limiting.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import { getSecret } from "wix-secrets-backend";
import { currentMember } from "wix-members-backend";
import wixData from "wix-data";

import { SECRETS } from "backend/mmSecrets";
import { COLLAB_ROLES, COLLECTIONS } from "backend/internalConfig";
import {
    makeTraceId,
    _safeEmail,
    _safeTrim
} from "public/mmUtils";

import {
    logger,
    ERROR_CODES,
    createBookingError
} from "backend/booking/bookingCore";

const log = logger;

const ROLE_CACHE_TTL_MS = 300000;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const PERSIST_THRESHOLD = 3;
const PERSIST_BLOCK_MS = 60 * 60 * 1000;

let cachedAdminEmails = null;
let cachedCajeroEmails = null;
let adminCacheTime = 0;
let cajeroCacheTime = 0;

const rateLimitCache = new Map();
const persistentBlockCache = new Map();

function _normalizeRole(role) {
    return _safeTrim(
        role?.name ||
        role?.title ||
        role
    ).toUpperCase();
}

function _normalizeKey(value, fallback = "anon") {
    const clean = _safeTrim(value);
    return clean || fallback;
}

async function _getCachedSecretEmails(
    secretName,
    cacheType
) {
    const now = Date.now();

    if (
        cacheType === "admin" &&
        cachedAdminEmails &&
        now - adminCacheTime < ROLE_CACHE_TTL_MS
    ) {
        return cachedAdminEmails;
    }

    if (
        cacheType === "cajero" &&
        cachedCajeroEmails &&
        now - cajeroCacheTime < ROLE_CACHE_TTL_MS
    ) {
        return cachedCajeroEmails;
    }

    const raw = await getSecret(secretName)
        .catch(() => "");

    const emails = String(raw || "")
        .split(",")
        .map((email) => _safeEmail(email))
        .filter(Boolean);

    if (cacheType === "admin") {
        cachedAdminEmails = emails;
        adminCacheTime = now;
    } else {
        cachedCajeroEmails = emails;
        cajeroCacheTime = now;
    }

    return emails;
}

async function _getCachedAdminEmails() {
    return _getCachedSecretEmails(
        SECRETS.ADMIN_EMAILS,
        "admin"
    );
}

async function _getCachedCajeroEmails() {
    return _getCachedSecretEmails(
        SECRETS.CAJERO_EMAILS,
        "cajero"
    );
}

function _buildRateKey(surface, key) {
    return [
        _normalizeKey(surface, "global"),
        _normalizeKey(key, "anon")
    ].join(":");
}

function _getBlockStorageKey(surface, key) {
    return _buildRateKey(surface, key);
}

function _cleanupRateLimitCache(now) {
    for (const [
            cacheKey,
            entry
        ] of rateLimitCache.entries()) {
        if (
            !entry ||
            now - entry.windowStart >
            RATE_LIMIT_WINDOW_MS * 2
        ) {
            rateLimitCache.delete(cacheKey);
        }
    }

    for (const [
            cacheKey,
            expiresAt
        ] of persistentBlockCache.entries()) {
        if (!expiresAt || expiresAt <= now) {
            persistentBlockCache.delete(cacheKey);
        }
    }
}

export async function isKeyPersistentlyBlocked(
    surface,
    key
) {
    const cleanSurface = _normalizeKey(
        surface,
        "global"
    );

    const cleanKey = _normalizeKey(
        key,
        "anon"
    );

    const storageKey = _getBlockStorageKey(
        cleanSurface,
        cleanKey
    );

    const cachedExpiry =
        persistentBlockCache.get(storageKey);

    if (
        cachedExpiry &&
        cachedExpiry > Date.now()
    ) {
        return true;
    }

    if (cachedExpiry) {
        persistentBlockCache.delete(storageKey);
    }

    try {
        const result = await wixData
            .query(COLLECTIONS.RATE_LIMIT_BLOCKS)
            .eq("surface", cleanSurface)
            .eq("key", cleanKey)
            .gt("expiresAt", new Date())
            .limit(1)
            .find({
                suppressAuth: true
            });

        const blocked =
            Array.isArray(result?.items) &&
            result.items.length > 0;

        if (blocked) {
            const item = result.items[0];
            const expiry = new Date(
                item.expiresAt
            ).getTime();

            if (
                Number.isFinite(expiry) &&
                expiry > Date.now()
            ) {
                persistentBlockCache.set(
                    storageKey,
                    expiry
                );
            }
        }

        return blocked;
    } catch (error) {
        log.warn(
            "Persistent block lookup failed", {
                surface: cleanSurface,
                key: cleanKey,
                message: error?.message
            }
        );

        return false;
    }
}

async function _persistRateLimitBlock(
    surface,
    key,
    violations,
    traceId
) {
    const cleanSurface = _normalizeKey(
        surface,
        "global"
    );

    const cleanKey = _normalizeKey(
        key,
        "anon"
    );

    const now = Date.now();
    const expiresAt =
        now + PERSIST_BLOCK_MS;

    const storageKey = _getBlockStorageKey(
        cleanSurface,
        cleanKey
    );

    persistentBlockCache.set(
        storageKey,
        expiresAt
    );

    const itemId = [
        "RL",
        cleanSurface,
        cleanKey,
        now
    ].join("-").slice(0, 100);

    await wixData
        .insert(
            COLLECTIONS.RATE_LIMIT_BLOCKS, {
                _id: itemId,
                surface: cleanSurface,
                key: cleanKey,
                violations: Number(violations) || 0,
                expiresAt: new Date(expiresAt),
                _createdDate: new Date()
            }, {
                suppressAuth: true
            }
        )
        .catch((error) => {
            log.warn(
                "Persistent rate limit block write failed", {
                    traceId,
                    surface: cleanSurface,
                    message: error?.message
                }
            );
        });
}

export function rateLimiter({
        surface,
        key
    } = {},
    maxRequests = RATE_LIMIT_MAX_REQUESTS,
    windowMs = RATE_LIMIT_WINDOW_MS
) {
    const cleanSurface = _normalizeKey(
        surface,
        "global"
    );

    const cleanKey = _normalizeKey(
        key,
        "anon"
    );

    const cacheKey = _buildRateKey(
        cleanSurface,
        cleanKey
    );

    const now = Date.now();
    const max = Math.max(
        1,
        Number(maxRequests) ||
        RATE_LIMIT_MAX_REQUESTS
    );

    const window = Math.max(
        1000,
        Number(windowMs) ||
        RATE_LIMIT_WINDOW_MS
    );

    _cleanupRateLimitCache(now);

    let entry = rateLimitCache.get(cacheKey);

    if (
        !entry ||
        now - entry.windowStart >= window
    ) {
        entry = {
            count: 1,
            windowStart: now,
            violations: 0
        };

        rateLimitCache.set(cacheKey, entry);

        return {
            allowed: true,
            retryAfter: 0,
            violations: 0
        };
    }

    entry.count += 1;

    if (entry.count <= max) {
        return {
            allowed: true,
            retryAfter: 0,
            violations: entry.violations || 0
        };
    }

    entry.violations =
        Number(entry.violations || 0) + 1;

    if (
        entry.violations >= PERSIST_THRESHOLD
    ) {
        void _persistRateLimitBlock(
            cleanSurface,
            cleanKey,
            entry.violations,
            makeTraceId("rate-limit")
        );
    }

    return {
        allowed: false,
        retryAfter: Math.max(
            0,
            window - (now - entry.windowStart)
        ),
        violations: entry.violations
    };
}

export async function enforceRateLimit({
        surface,
        key
    } = {},
    maxRequests = RATE_LIMIT_MAX_REQUESTS,
    windowMs = RATE_LIMIT_WINDOW_MS
) {
    const cleanSurface = _normalizeKey(
        surface,
        "global"
    );

    const cleanKey = _normalizeKey(
        key,
        "anon"
    );

    const blocked =
        await isKeyPersistentlyBlocked(
            cleanSurface,
            cleanKey
        );

    if (blocked) {
        return {
            allowed: false,
            retryAfter: PERSIST_BLOCK_MS,
            persistent: true
        };
    }

    return rateLimiter({
            surface: cleanSurface,
            key: cleanKey
        },
        maxRequests,
        windowMs
    );
}

function _getMemberRoles(member) {
    return Array.isArray(member?.roles) ?
        member.roles :
        [];
}

async function _getCurrentMember() {
    return currentMember
        .getMember({
            fieldsets: ["FULL"]
        })
        .catch(() => null);
}

export async function isAdmin(
    traceId
) {
    const activeTraceId =
        traceId || makeTraceId("rbac");

    try {
        const member =
            await _getCurrentMember();

        if (!member) return false;

        const memberEmail =
            _safeEmail(
                member.loginEmail ||
                member.contact?.emails?.[0]?.email ||
                ""
            );

        const adminEmails =
            await _getCachedAdminEmails();

        if (
            memberEmail &&
            adminEmails.includes(memberEmail)
        ) {
            return true;
        }

        return _getMemberRoles(member)
            .some(
                (role) =>
                _normalizeRole(role) ===
                String(
                    COLLAB_ROLES.ADMIN || ""
                ).toUpperCase()
            );
    } catch (error) {
        log.error(
            "isAdmin check failed", {
                traceId: activeTraceId,
                message: error?.message
            }
        );

        return false;
    }
}

export async function isCajero(
    traceId
) {
    const activeTraceId =
        traceId || makeTraceId("rbac");

    try {
        const member =
            await _getCurrentMember();

        if (!member) return false;

        const memberEmail =
            _safeEmail(
                member.loginEmail ||
                member.contact?.emails?.[0]?.email ||
                ""
            );

        const cajeroEmails =
            await _getCachedCajeroEmails();

        if (
            memberEmail &&
            cajeroEmails.includes(memberEmail)
        ) {
            return true;
        }

        if (
            await isAdmin(activeTraceId)
        ) {
            return true;
        }

        const allowedRoles = [
                COLLAB_ROLES.ADMIN,
                COLLAB_ROLES.GESTION
            ]
            .filter(Boolean)
            .map((role) =>
                String(role).toUpperCase()
            );

        return _getMemberRoles(member)
            .some((role) =>
                allowedRoles.includes(
                    _normalizeRole(role)
                )
            );
    } catch (error) {
        log.error(
            "isCajero check failed", {
                traceId: activeTraceId,
                message: error?.message
            }
        );

        return false;
    }
}

export async function isStaffCollaborator(
    traceId
) {
    const activeTraceId =
        traceId || makeTraceId("rbac");

    try {
        const member =
            await _getCurrentMember();

        if (!member) return false;

        if (
            await isAdmin(activeTraceId)
        ) {
            return true;
        }

        if (
            await isCajero(activeTraceId)
        ) {
            return true;
        }

        const allowedRoles = [
                COLLAB_ROLES.ADMIN,
                COLLAB_ROLES.GESTION,
                COLLAB_ROLES.ESTILISTA
            ]
            .filter(Boolean)
            .map((role) =>
                String(role).toUpperCase()
            );

        return _getMemberRoles(member)
            .some((role) =>
                allowedRoles.includes(
                    _normalizeRole(role)
                )
            );
    } catch (error) {
        log.error(
            "isStaffCollaborator check failed", {
                traceId: activeTraceId,
                message: error?.message
            }
        );

        return false;
    }
}

export async function requireAdmin(
    traceId
) {
    const activeTraceId =
        traceId || makeTraceId("rbac");

    if (
        !(await isAdmin(activeTraceId))
    ) {
        throw createBookingError(
            ERROR_CODES.ACCESS_DENIED,
            "Admin access required", {
                traceId: activeTraceId
            }
        );
    }

    return true;
}

export async function requireCajero(
    traceId
) {
    const activeTraceId =
        traceId || makeTraceId("rbac");

    if (
        !(await isCajero(activeTraceId))
    ) {
        throw createBookingError(
            ERROR_CODES.ACCESS_DENIED,
            "Cajero access required", {
                traceId: activeTraceId
            }
        );
    }

    return true;
}

export async function requireMarianManager(
    traceId
) {
    const activeTraceId =
        traceId || makeTraceId("rbac");

    if (
        !(await isCajero(activeTraceId))
    ) {
        throw createBookingError(
            ERROR_CODES.ACCESS_DENIED,
            "Marian manager access required", {
                traceId: activeTraceId
            }
        );
    }

    return true;
}

export function clearSecurityCaches() {
    cachedAdminEmails = null;
    cachedCajeroEmails = null;
    adminCacheTime = 0;
    cajeroCacheTime = 0;
    rateLimitCache.clear();
    persistentBlockCache.clear();
}