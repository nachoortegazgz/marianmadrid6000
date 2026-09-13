/*
=============================================================================
MODULE: backend/m365GraphSync.js
RESPONSIBILITY: Durable projection of ledger records to M365 SharePoint.
STANDARDS: G10 ASCII Strict, Velo Native Optimized.
=============================================================================
*/

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";
import { makeTraceId } from "public/mmUtils";
import { hashSHA256 } from "backend/securityEngine";
import { logger } from "backend/booking/bookingCore";
import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";

const log = logger;
const QUEUE_COL = COLLECTIONS.M365_GRAPH_SYNC_QUEUE;
const BATCH_SIZE = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BATCH_SIZE || 20;
const MAX_ATTEMPTS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_MAX_ATTEMPTS || 3;
const BACKOFF_MS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BACKOFF_MS || 300000;
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

function _isM365Enabled() {
    return SDK_CONFIG?.M365?.ENABLED === true;
}

function _stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(_stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function _queueId(payload) {
    return `m365-graph-${hashSHA256(_stableSerialize(payload)).slice(0, 56)}`;
}

async function _loadGraphConfig() {
    const [tenantId, clientId, clientSecret, siteId, listId] = await Promise.all([
        getSecret(SECRETS.M365_GRAPH_TENANT_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_CLIENT_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_CLIENT_SECRET).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_SITE_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_LIST_ID).catch(() => ""),
    ]);

    if (!tenantId || !clientId || !clientSecret || !siteId || !listId) return null;
    return { tenantId, clientId, clientSecret, siteId, listId };
}

async function _acquireGraphToken(config) {
    const body = `client_id=${encodeURIComponent(config.clientId)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=${encodeURIComponent(config.clientSecret)}&grant_type=client_credentials`;
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!response?.ok) throw new Error(`M365_GRAPH_TOKEN_FAILED`);
    const data = await response.json().catch(() => null);
    if (!data?.access_token) throw new Error("M365_GRAPH_TOKEN_INVALID");
    return data.access_token;
}

async function _postListItem(config, token, payload) {
    const endpoint = `${GRAPH_BASE_URL}/sites/${encodeURIComponent(config.siteId)}/lists/${encodeURIComponent(config.listId)}/items`;
    const body = {
        fields: {
            Title: payload.title,
            CorrelationId: payload.correlationId,
            EventType: payload.eventType,
            OccurredAt: payload.occurredAt,
            BookingReference: payload.bookingReference,
            TransactionId: payload.transactionId,
            Amount: payload.amount,
            Currency: payload.currency,
            IntegrityHash: payload.integrityHash,
        },
    };

    const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (response.status === 409) return { externalRecordId: "", duplicate: true };
    if (!response?.ok) throw new Error(`M365_GRAPH_POST_FAILED`);
    const data = await response.json().catch(() => ({}));
    return { externalRecordId: data?.id || "", duplicate: false };
}

export async function enqueueM365LedgerRecord(movement, traceId) {
    if (!_isM365Enabled()) return { status: "PAUSED" };
    
    const payload = {
        eventType: "LEDGER_MOVEMENT",
        correlationId: traceId || movement?.traceId,
        transactionId: movement?.transactionId,
        bookingReference: movement?.reservaIdVinculada || movement?._id,
        amount: movement?.accountingAmount,
        currency: "EUR",
        occurredAt: movement?.registeredAt || new Date(),
    };
    payload.title = `LEDGER_MOVEMENT ${payload.transactionId || payload.bookingReference}`;
    payload.integrityHash = hashSHA256(_stableSerialize(payload));

    const queueId = _queueId(payload);
    const queue = {
        _id: queueId, payload, payloadHash: payload.integrityHash,
        status: "PENDING", attempts: 0, nextAttemptAt: new Date(),
        traceId: payload.correlationId, _createdDate: new Date(),
    };

    try {
        await wixData.insert(QUEUE_COL, queue, { suppressAuth: true });
        return { status: "PENDING" };
    } catch (err) {
        return { status: "DUPLICATE" };
    }
}

export async function processM365GraphSyncQueue(options = {}) {
    if (!_isM365Enabled()) return { status: "PAUSED" };
    
    const pending = await wixData.query(QUEUE_COL)
        .in("status", ["PENDING", "RETRY"])
        .le("nextAttemptAt", new Date())
        .limit(BATCH_SIZE)
        .find({ suppressAuth: true });

    if (!pending.items.length) return { status: "SUCCESS", data: { processed: 0 } };

    const config = await _loadGraphConfig();
    if (!config) return { status: "BLOCKED", error: "M365_NOT_CONFIGURED" };

    const token = await _acquireGraphToken(config);
    let processed = 0;

    for (const queue of pending.items) {
        try {
            const postResult = await _postListItem(config, token, queue.payload);
            await wixData.update(QUEUE_COL, { ...queue, status: "COMPLETED", externalRecordId: postResult.externalRecordId }, { suppressAuth: true });
            processed++;
        } catch (error) {
            const attempts = queue.attempts + 1;
            const terminal = attempts >= MAX_ATTEMPTS;
            await wixData.update(QUEUE_COL, {
                ...queue,
                status: terminal ? "FAILED" : "RETRY",
                attempts,
                nextAttemptAt: new Date(Date.now() + BACKOFF_MS * Math.pow(2, attempts - 1)),
                _updatedDate: new Date()
            }, { suppressAuth: true });
        }
    }
    return { status: "SUCCESS", data: { processed } };
}