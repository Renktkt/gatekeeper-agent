import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Published in GET https://agentgames.zkverify.io/api/circuit-info (mainnet).
export const GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env ${name} must be an integer, got "${v}"`);
  return n;
}

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(overrides = {}) {
  const cfg = {
    host: str("HOST", "0.0.0.0"),
    port: int("PORT", 8080),

    // Platform HMAC secret (dashboard -> Rotate Secret). Required in production.
    secret: process.env.AGENT_GAMES_SECRET || "",
    allowUnsignedDev: process.env.ALLOW_UNSIGNED_DEV === "1",
    // Incoming signature headers we accept (first match wins). The response is
    // always signed in `responseSigHeader`.
    sigHeaders: (process.env.PLATFORM_SIG_HEADERS || "x-agent-games-signature,x-signature")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    responseSigHeader: "x-agent-games-signature",

    // Circuits (local artifacts).
    circuitWasm: str("CIRCUIT_WASM", path.join(ROOT, "circuits", "gatekeeper.wasm")),
    circuitZkey: str("CIRCUIT_ZKEY", path.join(ROOT, "circuits", "gatekeeper_final.zkey")),
    circuitVkJson: str("CIRCUIT_VK_JSON", path.join(ROOT, "circuits", "vk-gatekeeper.json")),
    gatekeeperVkHash: str("GATEKEEPER_VK_HASH", GATEKEEPER_VK_HASH),

    // Kurier (zkVerify REST relayer). Disabled when no API key is configured:
    // the agent then returns decisions with the locally generated proof only.
    kurierApiKey: process.env.KURIER_API_KEY || "",
    kurierBaseUrl: str("KURIER_BASE_URL", "https://api.kurier.xyz/api/v1"),
    kurierVkHash: process.env.KURIER_VK_HASH || "", // empty -> register-vk / published hash
    kurierChainId: process.env.KURIER_CHAIN_ID ? int("KURIER_CHAIN_ID", 0) : null,
    kurierCachePath: str("KURIER_CACHE_PATH", path.join(ROOT, "data", "kurier-vk.json")),
    kurierPollMs: int("KURIER_POLL_MS", 1200),

    // Seen-set persistence for PROOF_REUSED.
    seenStorePath: str("SEEN_STORE_PATH", path.join(ROOT, "data", "seen.json")),

    // Hard internal response budget. The platform deadline is 60 s; we keep a
    // safety margin and also honour a task's own deadline_at when it is sooner.
    responseBudgetMs: int("RESPONSE_BUDGET_MS", 50_000),
    deadlineSafetyMs: int("DEADLINE_SAFETY_MS", 2_000),

    // Proving can be disabled for plumbing-only dev (never in competition).
    provingEnabled: process.env.PROVING_ENABLED !== "0",
    // Fixed salt for reproducible tests; empty -> fresh random salt per proof.
    fixedSalt: process.env.AGENT_GAMES_SALT || "",
    // How a non-numeric task_id is encoded into a circuit field element.
    // "sha256": sha256(task_id) mod p. "digits": concatenated digits (sha256 fallback).
    taskIdEncoding: str("TASK_ID_ENCODING", "sha256"),

    logLevel: str("LOG_LEVEL", "info"),
    ...overrides,
  };

  if (!cfg.secret && !cfg.allowUnsignedDev) {
    throw new Error(
      "AGENT_GAMES_SECRET is not set. Set it to the platform secret from the dashboard (Rotate Secret), " +
        "or set ALLOW_UNSIGNED_DEV=1 for local plumbing tests only."
    );
  }
  return cfg;
}
