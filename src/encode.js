import crypto from "node:crypto";

// Encodings from task payload values to BN128 circuit field elements.
// The Gatekeeper circuit takes 13 inputs (all decimal strings when fed to
// snarkjs): decision, minimum, publicBalance, expiryBlock, currentBlock,
// recipient, conditionRecipient, amount, maxTransfer, taskId,
// registeredVkHash, proofVkHash, salt.
//
// Honest, faithful encodings are used throughout:
//  - decimal quantities        -> BigInt as-is
//  - 0x-hex addresses / hashes -> BigInt(hex), reduced mod p when needed
//  - non-numeric task_id       -> sha256(task_id) mod p (see TASK_ID_ENCODING)
// The platform-side check of these encodings is a known seam: practice mode
// is where they get validated before scored rounds (see README).

export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function sha256Field(text) {
  const h = crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
  return BigInt("0x" + h) % FIELD_PRIME;
}

// Parse a decimal or 0x-hex integer quantity. Returns BigInt or null.
export function parseQuantity(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
    return BigInt(v);
  }
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  return null;
}

// Addresses: hex -> integer value (always < 2^160 << p). Anything else falls
// back to a deterministic hash so a witness can still be constructed.
export function encodeAddress(addr) {
  if (typeof addr === "string" && /^0x[0-9a-fA-F]+$/.test(addr.trim())) {
    return BigInt(addr.trim()) % FIELD_PRIME;
  }
  return sha256Field(addr ?? "");
}

// VK identifiers in the task payload are hex hashes. Reduce mod p if the
// value does not fit the field (e.g. a full 256-bit hash).
export function encodeVkHash(vk) {
  if (typeof vk === "string" && /^0x[0-9a-fA-F]+$/.test(vk.trim())) {
    return BigInt(vk.trim()) % FIELD_PRIME;
  }
  if (typeof vk === "string" && /^[0-9]+$/.test(vk.trim())) {
    return BigInt(vk.trim()) % FIELD_PRIME;
  }
  return sha256Field(vk ?? "");
}

export function encodeTaskId(taskId, mode = "sha256") {
  const s = String(taskId ?? "");
  if (/^[0-9]+$/.test(s)) return BigInt(s) % FIELD_PRIME;
  if (mode === "digits") {
    const digits = s.replace(/[^0-9]/g, "");
    if (digits) return BigInt(digits) % FIELD_PRIME;
  }
  return sha256Field(s);
}

// Salt is the circuit's blinding input (it feeds the commitment that appears
// as the first public signal; it is not itself echoed). Fresh random per proof.
export function randomSalt() {
  return BigInt("0x" + crypto.randomBytes(31).toString("hex")) % FIELD_PRIME;
}

export function dec(n) {
  return n.toString(10);
}
