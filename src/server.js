import http from "node:http";
import { verifySignature, signBody } from "./hmac.js";
import { decide, REASONS } from "./decide.js";
import { SeenStore } from "./seen.js";
import { Prover } from "./prove.js";
import { KurierClient } from "./kurier.js";

const MAX_BODY_BYTES = 1_048_576;

// Race a promise against a deadline; resolves to null on timeout.
// The underlying promise keeps running in the background (its result is
// simply unused) — a slow proof must never hold the response hostage.
function withTimeout(promise, ms) {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

export function createApp(cfg, log = console) {
  const seen = new SeenStore(cfg.seenStorePath, log);
  const prover = new Prover(cfg, log);
  const kurier = new KurierClient(cfg, log);

  function sendSigned(res, status, obj) {
    const body = JSON.stringify(obj);
    const headers = { "content-type": "application/json" };
    if (cfg.secret) headers[cfg.responseSigHeader] = signBody(cfg.secret, body);
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendPlain(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  async function handleTask(req, res, rawBody) {
    const t0 = Date.now();

    // --- Signature first, before any parsing (per the build guide). ---
    if (cfg.secret) {
      const headerVal = cfg.sigHeaders
        .map((h) => req.headers[h])
        .find((v) => typeof v === "string" && v !== "");
      if (!verifySignature(cfg.secret, rawBody, headerVal)) {
        log.warn?.(`[agent] rejected request: missing/invalid signature`);
        return sendPlain(res, 401, { error: "invalid_signature" });
      }
    }

    // --- Parse (fail closed: a signed REJECT beats a timeout). ---
    let task = null;
    try {
      task = JSON.parse(rawBody.toString("utf8"));
    } catch {
      task = null;
    }
    if (!task || typeof task !== "object") {
      return sendSigned(res, 200, {
        task_id: null,
        decision: "REJECT",
        reason_code: REASONS.MALFORMED,
        proof_tx: null,
        proof: null,
        public_signals: null,
        vk_hash: cfg.gatekeeperVkHash,
        proof_reference: null,
        proof_status: "unavailable",
      });
    }

    // --- Deadline budget: internal cap, tightened by the task's own deadline. ---
    let deadline = t0 + cfg.responseBudgetMs;
    if (typeof task.deadline_at === "string") {
      const d = Date.parse(task.deadline_at);
      if (!Number.isNaN(d)) deadline = Math.min(deadline, d - cfg.deadlineSafetyMs);
    }
    const remaining = () => Math.max(0, deadline - Date.now());

    // --- Decide (deterministic). Record the proof reference as seen AFTER
    // deciding, for every task that carries one (any later task reusing it
    // is PROOF_REUSED). ---
    const outcome = decide(task, seen, { taskIdEncoding: cfg.taskIdEncoding });
    if (outcome.proofTx) seen.add(outcome.proofTx);

    const response = {
      task_id: outcome.taskId ?? (typeof task.task_id === "string" ? task.task_id : null),
      decision: outcome.decision,
      reason_code: outcome.reason_code,
      proof_tx: outcome.proofTx ?? null,
      proof: null,
      public_signals: null,
      vk_hash: cfg.gatekeeperVkHash,
      proof_reference: null,
      proof_status: "unavailable",
    };

    // --- Proof pipeline (never allowed to change the decision or blow the deadline). ---
    let proveMs = null;
    let kurierMs = null;
    if (outcome.reason_code === REASONS.REUSED) {
      response.proof_status = "not_required";
    } else if (outcome.provable && cfg.provingEnabled) {
      const tProve = Date.now();
      const proved = await withTimeout(prover.prove(outcome.witness), remaining());
      if (proved) {
        proveMs = Date.now() - tProve;
        response.proof = proved.proof;
        response.public_signals = proved.publicSignals;
        response.proof_status = "local";
        if (kurier.enabled) {
          const tKur = Date.now();
          try {
            const fin = await withTimeout(
              kurier.submitAndFinalize(proved.proof, proved.publicSignals, remaining()),
              remaining()
            );
            kurierMs = Date.now() - tKur;
            if (fin && fin.status === "Finalized") {
              response.proof_reference = fin.proofReference;
              response.proof_status = "finalized";
            } else if (fin) {
              response.proof_status = "submitted";
            }
          } catch (e) {
            kurierMs = Date.now() - tKur;
            log.warn?.(`[kurier] ${kurier.redact(e.message)}`);
            // Local proof still attached; decision unaffected.
          }
        }
      } else {
        log.warn?.(`[agent] proof did not complete inside budget for task ${response.task_id}`);
      }
    }

    log.info?.(
      `[agent] task=${response.task_id} decision=${response.decision} reason=${response.reason_code} ` +
        `proof=${response.proof_status} total_ms=${Date.now() - t0}` +
        (proveMs !== null ? ` prove_ms=${proveMs}` : "") +
        (kurierMs !== null ? ` kurier_ms=${kurierMs}` : "")
    );
    return sendSigned(res, 200, response);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return sendPlain(res, 200, {
        status: "ok",
        service: "proof-gatekeeper",
        prover_ready: prover.ready,
        kurier: kurier.enabled ? "enabled" : "disabled",
        seen_count: seen.size,
        time: new Date().toISOString(),
      });
    }
    if (req.method === "POST" && url.pathname === "/agent") {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size <= MAX_BODY_BYTES) chunks.push(c);
      });
      req.on("end", () => {
        if (size > MAX_BODY_BYTES) return sendPlain(res, 413, { error: "body_too_large" });
        handleTask(req, res, Buffer.concat(chunks)).catch((e) => {
          // Last-resort fail-closed: a signed REJECT is better than a timeout.
          log.error?.(`[agent] handler error: ${e.message}`);
          try {
            sendSigned(res, 200, {
              task_id: null,
              decision: "REJECT",
              reason_code: REASONS.MALFORMED,
              proof_tx: null,
              proof: null,
              public_signals: null,
              vk_hash: cfg.gatekeeperVkHash,
              proof_reference: null,
              proof_status: "unavailable",
            });
          } catch {
            /* socket already gone */
          }
        });
      });
      req.on("error", () => {
        try {
          res.writeHead(400);
          res.end();
        } catch {
          /* ignore */
        }
      });
      return;
    }
    return sendPlain(res, 404, { error: "not_found" });
  });

  return { server, seen, prover, kurier };
}
