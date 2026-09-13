/*
=============================================================================
MODULE: backend/security.web.js
VERSION: v5002-rbac-web-facade
RESPONSIBILITY: Public facade for RBAC checks.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import {
    webMethod,
    Permissions
} from "wix-web-module";

import {
    makeTraceId,
    _safeTrim
} from "public/mmUtils";

import {
    isAdmin,
    isCajero,
    isStaffCollaborator,
    enforceRateLimit
} from "backend/security";

import { _toPublicError } from "backend/responseUtils";

async function _checkAccessRateLimit(
    surface,
    options,
    traceId
) {
    const key = _safeTrim(
        options?.key ||
        options?.email ||
        "member"
    );

    return enforceRateLimit({
            surface,
            key
        },
        30,
        10000
    );
}

export const checkAdminAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId =
            options.traceId ||
            makeTraceId("wm-admin");

        try {
            const limit =
                await _checkAccessRateLimit(
                    "security.checkAdminAccess",
                    options,
                    traceId
                );

            if (!limit.allowed) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "RATE_LIMITED",
                        message: "Too many access checks."
                    }
                };
            }

            const admin =
                await isAdmin(traceId);

            return {
                status: "SUCCESS",
                data: {
                    isAdmin: admin
                },
                error: null
            };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(
                    error,
                    "ADMIN_CHECK_FAIL"
                )
            };
        }
    }
);

export const checkCajeroAccess = webMethod(
    Permissions.SiteMember,
    async (options = {}) => {
        const traceId =
            options.traceId ||
            makeTraceId("wm-cajero");

        try {
            const limit =
                await _checkAccessRateLimit(
                    "security.checkCajeroAccess",
                    options,
                    traceId
                );

            if (!limit.allowed) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "RATE_LIMITED",
                        message: "Too many access checks."
                    }
                };
            }

            const cajero =
                await isCajero(traceId);

            return {
                status: "SUCCESS",
                data: {
                    isCajero: cajero
                },
                error: null
            };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(
                    error,
                    "CAJERO_CHECK_FAIL"
                )
            };
        }
    }
);

export const checkStaffCollaboratorAccess =
    webMethod(
        Permissions.SiteMember,
        async (options = {}) => {
            const traceId =
                options.traceId ||
                makeTraceId("wm-staff-collab");

            try {
                const limit =
                    await _checkAccessRateLimit(
                        "security.checkStaffCollaboratorAccess",
                        options,
                        traceId
                    );

                if (!limit.allowed) {
                    return {
                        status: "ERROR",
                        data: null,
                        error: {
                            code: "RATE_LIMITED",
                            message: "Too many access checks."
                        }
                    };
                }

                const staffCollaborator =
                    await isStaffCollaborator(
                        traceId
                    );

                const marianManager =
                    await isCajero(traceId);

                return {
                    status: "SUCCESS",
                    data: {
                        isStaffCollaborator: staffCollaborator,
                        isMarianManager: marianManager
                    },
                    error: null
                };
            } catch (error) {
                return {
                    status: "ERROR",
                    data: null,
                    error: _toPublicError(
                        error,
                        "STAFF_COLLAB_CHECK_FAIL"
                    )
                };
            }
        }
    );