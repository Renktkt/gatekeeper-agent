import crypto from "node:crypto";

// HMAC-SHA256 helpers for the Agent Games platform signature scheme.
// - Incoming tasks: signature over the RAW request body, verified BEFORE parsing.
// - Outgoing responses: `x-agent-games-signature` over the RAW response body.
// The secret is only ever passed in from config (env). Never log it.

export function hmacHex(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function hmacBase64(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Accepts hex or base64 digests, with or without a "sha256=" prefix.
export function verifySignature(secret, rawBody, headerValue) {
  if (!secret || !headerValue || typeof headerValue !== "string") return false;
  let v = headerValue.trim();
  if (v.toLowerCase().startsWith("sha256=")) v = v.slice("sha256=".length).trim();
  if (safeEqual(v.toLowerCase(), hmacHex(secret, rawBody))) return true;
  if (safeEqual(v, hmacBase64(secret, rawBody))) return true;
  return false;
}

export function signBody(secret, rawBody) {
  return hmacHex(secret, rawBody);
}
