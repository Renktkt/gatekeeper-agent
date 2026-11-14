import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { hmacHex } from "../src/hmac.js";
import { startMockKurier } from "./mock-kurier.js";

// Practice harness: boots the real agent against a mock Kurier and feeds it
// the documented sample task, one synthetic task per trap type, boundary
// cases, and protocol abuse cases. Asserts decision + reason_code (and, for
// the sample, that the attached Groth16 proof verifies against the real VK
// and that Kurier finalization lands inside the response).
//
// Run: npm test

const SECRET = "test-secret";
const VK_A = "0x" + "7d3a".padEnd(64, "a"); // registered condition VK
const VK_B = "0x" + "a4c1".padEnd(64, "b"); // substituted VK
const RECIPIENT = "0xDe42" + "0".repeat(32) + "9f01";
const OTHER_RECIPIENT = "0xBeef" + "0".repeat(32) + "1234";

let txCounter = 0;
function freshTx() {
  txCounter += 1;
  return "0x" + txCounter.toString(16).padStart(64, "0");
}

function baseTask(overrides = {}) {
  const input = {
    registered_vk: VK_A,
    proof_vk: VK_A,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: RECIPIENT,
    condition_recipient: RECIPIENT,
    amount: "500",
    max_transfer: "1000",
    proof_tx: freshTx(),
    ...(overrides.input || {}),
  };
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: "gk_24_9d1",
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
    input,
  };
}

const results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function postTask(base, payload, { sign = true, raw = null, secret = SECRET } = {}) {
  const bodyBuf = raw !== null ? Buffer.from(raw) : Buffer.from(JSON.stringify(payload));
  const headers = { "content-type": "application/json" };
  if (sign) headers["x-agent-games-signature"] = hmacHex(secret, bodyBuf);
  const t0 = Date.now();
  const res = await fetch(`${base}/agent`, { method: "POST", headers, body: bodyBuf });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, headers: res.headers, json, text, ms: Date.now() - t0 };
}

function responseSigOk(r) {
  const sig = r.headers.get("x-agent-games-signature");
  return sig === hmacHex(SECRET, r.text);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gk-harness-"));
  const mock = await startMockKurier({ finalizeMs: 1200 });
  const cfg = loadConfig({
    secret: SECRET,
    kurierApiKey: "test-api-key",
    kurierBaseUrl: `${mock.url}/api/v1`,
    kurierCachePath: path.join(tmp, "kurier-vk.json"),
    seenStorePath: path.join(tmp, "seen.json"),
    responseBudgetMs: 30_000,
    kurierPollMs: 250,
    fixedSalt: "777",
    port: 0,
  });
  const app = createApp(cfg, console);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const vkJson = JSON.parse(fs.readFileSync(cfg.circuitVkJson, "utf8"));

  const expect = async (name, task, decision, reason, extra = {}) => {
    const r = await postTask(base, task);
    let ok =
      r.status === 200 &&
      r.json?.decision === decision &&
      r.json?.reason_code === reason &&
      responseSigOk(r);
    let detail = `${r.json?.decision}/${r.json?.reason_code} in ${r.ms} ms, proof=${r.json?.proof_status}`;
    if (extra.proof === true && !r.json?.proof) (ok = false), (detail += " (missing proof)");
    if (extra.proof === false && r.json?.proof) (ok = false), (detail += " (unexpected proof)");
    if (extra.verify) {
      const v = await snarkjs.groth16.verify(vkJson, r.json.public_signals, r.json.proof);
      if (!v) (ok = false), (detail += " (proof does not verify!)");
      else detail += ", proof verifies vs VK";
    }
    if (extra.finalized) {
      if (r.json?.proof_status !== "finalized" || !r.json?.proof_reference)
        (ok = false), (detail += " (not finalized via Kurier)");
      else detail += `, kurier ref=${r.json.proof_reference}`;
    }
    report(name, ok, detail);
    return r;
  };

  // --- health ---
  {
    const res = await fetch(`${base}/health`);
    const j = await res.json();
    report("health endpoint", res.status === 200 && j.status === "ok", `kurier=${j.kurier}`);
  }

  // --- documented sample (full-length values, same relationships) ---
  await expect("sample task -> APPROVE", baseTask(), "APPROVE", "VALID_CONDITION", {
    proof: true,
    verify: true,
    finalized: true,
  });

  // --- one synthetic task per trap type ---
  await expect(
    "trap VK_SUBSTITUTION",
    baseTask({ input: { proof_vk: VK_B } }),
    "REJECT",
    "VK_SUBSTITUTION",
    { proof: true, verify: true }
  );
  await expect(
    "trap THRESHOLD_MISMATCH",
    baseTask({ input: { public_balance: "999" } }),
    "REJECT",
    "THRESHOLD_MISMATCH",
    { proof: true }
  );
  await expect(
    "trap RECIPIENT_MISMATCH",
    baseTask({ input: { condition_recipient: OTHER_RECIPIENT } }),
    "REJECT",
    "RECIPIENT_MISMATCH",
    { proof: true }
  );
  await expect(
    "trap EXPIRED_CONDITION",
    baseTask({ input: { current_block: 19842202 } }),
    "REJECT",
    "EXPIRED_CONDITION",
    { proof: true }
  );
  await expect(
    "trap AMOUNT_OVERFLOW",
    baseTask({ input: { amount: "1001" } }),
    "REJECT",
    "AMOUNT_OVERFLOW",
    { proof: true }
  );
  {
    // PROOF_REUSED: first use approves, second use of the same proof_tx rejects without proof.
    const sharedTx = freshTx();
    const first = await postTask(base, baseTask({ input: { proof_tx: sharedTx } }));
    const second = await postTask(
      base,
      baseTask({ task_id: "gk_24_zz2", input: { proof_tx: sharedTx } })
    );
    report(
      "trap PROOF_REUSED (1st use approves)",
      first.json?.decision === "APPROVE",
      `${first.json?.decision}/${first.json?.reason_code}`
    );
    report(
      "trap PROOF_REUSED (2nd use rejects, no proof)",
      second.json?.decision === "REJECT" &&
        second.json?.reason_code === "PROOF_REUSED" &&
        second.json?.proof === null &&
        second.json?.proof_status === "not_required",
      `${second.json?.decision}/${second.json?.reason_code}, proof=${second.json?.proof_status}`
    );
    // seen-set must be persisted on disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, "seen.json"), "utf8"));
    report("seen-set persisted to disk", onDisk.includes(sharedTx), `${onDisk.length} refs stored`);
  }

  // --- boundary cases ---
  await expect(
    "edge balance == minimum -> APPROVE",
    baseTask({ input: { public_balance: "1000" } }),
    "APPROVE",
    "VALID_CONDITION",
    { proof: true }
  );
  await expect(
    "edge amount == cap -> APPROVE",
    baseTask({ input: { amount: "1000" } }),
    "APPROVE",
    "VALID_CONDITION",
    { proof: true }
  );
  await expect(
    "edge current_block == expiry_block -> REJECT (circuit semantics: approve requires current < expiry)",
    baseTask({ input: { current_block: 19842201 } }),
    "REJECT",
    "EXPIRED_CONDITION",
    { proof: true }
  );
  await expect(
    "edge current_block == expiry_block - 1 -> APPROVE",
    baseTask({ input: { current_block: 19842200 } }),
    "APPROVE",
    "VALID_CONDITION",
    { proof: true }
  );

  // --- protocol abuse ---
  {
    const r = await postTask(base, baseTask(), { sign: false });
    report("unsigned request -> 401", r.status === 401, `status=${r.status}`);
    const r2 = await postTask(base, baseTask(), { secret: "wrong-secret" });
    report("bad signature -> 401", r2.status === 401, `status=${r2.status}`);
    const garbage = Buffer.from("{not json!!");
    const r3 = await postTask(base, null, { raw: garbage });
    report(
      "malformed JSON (valid HMAC) -> signed fail-closed REJECT",
      r3.status === 200 && r3.json?.decision === "REJECT" && responseSigOk(r3),
      `${r3.json?.decision}/${r3.json?.reason_code}`
    );
  }

  // --- slow Kurier: finalization beyond budget -> answer still lands in time ---
  {
    const slowMock = await startMockKurier({ finalizeMs: 60_000 });
    const cfg2 = loadConfig({
      secret: SECRET,
      kurierApiKey: "test-api-key",
      kurierBaseUrl: `${slowMock.url}/api/v1`,
      kurierCachePath: path.join(tmp, "kurier-vk2.json"),
      seenStorePath: path.join(tmp, "seen2.json"),
      responseBudgetMs: 6_000,
      kurierPollMs: 250,
      fixedSalt: "777",
      port: 0,
    });
    const app2 = createApp(cfg2, console);
    await new Promise((r) => app2.server.listen(0, "127.0.0.1", r));
    const base2 = `http://127.0.0.1:${app2.server.address().port}`;
    const r = await postTask(base2, baseTask());
    report(
      "slow Kurier -> decision + local proof inside budget",
      r.json?.decision === "APPROVE" &&
        r.json?.proof !== null &&
        (r.json?.proof_status === "local" || r.json?.proof_status === "submitted") &&
        r.ms < 9_000,
      `${r.json?.decision}, proof=${r.json?.proof_status}, ${r.ms} ms (budget 6000 ms)`
    );
    await new Promise((r2) => app2.server.close(r2));
    await slowMock.close();
  }

  // --- mock Kurier actually received well-formed submissions ---
  report(
    "kurier submissions well-formed",
    mock.calls.submitProof >= 10 && mock.calls.registerVk >= 0,
    `register-vk calls=${mock.calls.registerVk}, submit-proof calls=${mock.calls.submitProof}, job-status calls=${mock.calls.jobStatus}`
  );

  await new Promise((r) => app.server.close(r));
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} harness checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
