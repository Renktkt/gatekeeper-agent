import http from "node:http";
import { GATEKEEPER_VK_HASH } from "../src/config.js";

// Mock of the Kurier REST API for local testing (no real API key needed).
//   POST /api/v1/register-vk/:key       -> { vkHash }
//   POST /api/v1/submit-proof/:key      -> { jobId, status: "Submitted" }
//   GET  /api/v1/job-status/:key/:jobId -> Submitted -> IncludedInBlock -> Finalized
// Finalization happens `finalizeMs` after submission. Standalone:
//   MOCK_KURIER_PORT=8791 MOCK_FINALIZE_MS=2500 node test/mock-kurier.js

export function startMockKurier({ port = 0, finalizeMs = 2500, log = null } = {}) {
  const jobs = new Map();
  let counter = 0;
  const calls = { registerVk: 0, submitProof: 0, jobStatus: 0, bodies: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    const readBody = () =>
      new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });

    (async () => {
      if (req.method === "POST" && /^\/api\/v1\/register-vk\/.+/.test(url.pathname)) {
        calls.registerVk++;
        await readBody();
        return send(200, { vkHash: GATEKEEPER_VK_HASH, status: "Registered" });
      }
      if (req.method === "POST" && /^\/api\/v1\/submit-proof\/.+/.test(url.pathname)) {
        calls.submitProof++;
        const raw = await readBody();
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          /* fallthrough to 400 */
        }
        calls.bodies.push(body);
        if (
          !body ||
          body.proofType !== "groth16" ||
          !body.proofData ||
          !body.proofData.proof ||
          !Array.isArray(body.proofData.publicSignals) ||
          !body.proofData.vk
        ) {
          return send(400, { error: "malformed submit-proof body" });
        }
        const jobId = `job-${++counter}`;
        jobs.set(jobId, { submittedAt: Date.now(), body });
        return send(200, { jobId, status: "Submitted" });
      }
      const m = /^\/api\/v1\/job-status\/[^/]+\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        calls.jobStatus++;
        const job = jobs.get(m[1]);
        if (!job) return send(404, { error: "unknown job" });
        const age = Date.now() - job.submittedAt;
        if (age >= finalizeMs) {
          return send(200, { jobId: m[1], status: "Finalized", txHash: `0xmocktx${m[1]}` });
        }
        return send(200, {
          jobId: m[1],
          status: age >= finalizeMs / 2 ? "IncludedInBlock" : "Submitted",
        });
      }
      return send(404, { error: "not_found" });
    })().catch((e) => {
      log?.error?.(`[mock-kurier] ${e.message}`);
      try {
        send(500, { error: "mock_error" });
      } catch {
        /* ignore */
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      resolve({
        server,
        calls,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startMockKurier({
    port: Number(process.env.MOCK_KURIER_PORT || 8791),
    finalizeMs: Number(process.env.MOCK_FINALIZE_MS || 2500),
    log: console,
  });
  console.info(`[mock-kurier] listening at ${url}/api/v1`);
}
