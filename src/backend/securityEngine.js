/*
=============================================================================
MODULE: backend/securityEngine.js
VERSION: v5001-optimized (base v18.9.1-ultimate)
RESPONSIBILITY: Cryptographic engine for fiscal hash chains and JWT authentication.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
*/
import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from "wix-crypto";
import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";
import { makeTraceId, _safeTrim } from "public/mmUtils";
import { logger } from "backend/booking/bookingCore";
const log = logger;
const JWT_ALGORITHM = "HS256";
const JWT_EXPIRATION_MS = 1800000;
export function hashSHA256(input) {
const clean = String(input || "");
return createHash("sha256").update(clean).digest("hex");
}
export function hmacSha256Hex(key, payload) {
const cleanKey = String(key || "");
const cleanPayload = String(payload || "");
return createHmac("sha256", cleanKey).update(cleanPayload).digest("hex");
}
export function hashChain(prevHash, payload) {
const cleanPrev = String(prevHash || "");
const cleanPayload = String(payload || "");
return hashSHA256(`${cleanPrev}|${cleanPayload}`);
}
export function timingSafeEqual(a, b) {
try {
const bufA = Buffer.from(String(a || ""), "utf8");
const bufB = Buffer.from(String(b || ""), "utf8");
if (bufA.length !== bufB.length) return false;
return nodeTimingSafeEqual(bufA, bufB);
} catch (_) {
return String(a || "") === String(b || "");
}
}
function _base64UrlEncode(input) {
const clean = String(input || "");
return Buffer.from(clean, "utf8")
.toString("base64")
.replace(/\+/g, "-")
.replace(/\//g, "_")
.replace(/=+$/, "");
}
function _base64UrlDecode(input) {
const clean = String(input || "");
const padded = clean.replace(/-/g, "+").replace(/_/g, "/");
const pad = padded.length % 4;
const finalPadded = pad ? padded + "=".repeat(4 - pad) : padded;
try {
return Buffer.from(finalPadded, "base64").toString("utf8");
} catch (_) {
return "";
}
}
export async function generateJWT(payload, traceId) {
const activeTraceId = traceId || makeTraceId("jwt-gen");
try {
const secretKey = await getSecret(SECRETS.AUTH_JWT_KEY);
if (!secretKey) {
log.error("AUTH_JWT_KEY missing in Secrets Manager", { traceId: activeTraceId });
return null;
}
const now = Math.floor(Date.now() / 1000);
const exp = now + Math.floor(JWT_EXPIRATION_MS / 1000);
const header = { alg: JWT_ALGORITHM, typ: "JWT" };
const tokenPayload = {
...(payload || {}),
iat: now,
exp: exp,
};
const headerEncoded = _base64UrlEncode(JSON.stringify(header));
const payloadEncoded = _base64UrlEncode(JSON.stringify(tokenPayload));
const signingInput = `${headerEncoded}.${payloadEncoded}`;
const signature = hmacSha256Hex(secretKey, signingInput);
return `${signingInput}.${signature}`;
} catch (error) {
log.error("JWT generation failed", { traceId: activeTraceId, error: error?.message });
return null;
}
}
export async function verifyJWT(token, traceId) {
const activeTraceId = traceId || makeTraceId("jwt-verify");
try {
const cleanToken = _safeTrim(token);
if (!cleanToken) return null;
const parts = cleanToken.split(".");
if (parts.length !== 3) return null;
const secretKey = await getSecret(SECRETS.AUTH_JWT_KEY);
if (!secretKey) {
log.error("AUTH_JWT_KEY missing in Secrets Manager", { traceId: activeTraceId });
return null;
}
const signingInput = `${parts[0]}.${parts[1]}`;
const expectedSignature = hmacSha256Hex(secretKey, signingInput);
if (!timingSafeEqual(parts[2], expectedSignature)) {
return null;
}
const payloadJson = _base64UrlDecode(parts[1]);
if (!payloadJson) return null;
const payload = JSON.parse(payloadJson);
const now = Math.floor(Date.now() / 1000);
if (payload.exp && payload.exp < now) {
return null;
}
return payload;
} catch (error) {
log.error("JWT verification failed", { traceId: activeTraceId, error: error?.message });
return null;
}
}