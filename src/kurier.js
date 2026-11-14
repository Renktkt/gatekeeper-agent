import fs from "node:fs";
import path from "node:path";

// Kurier (zkVerify) REST client — the platform-recommended verification path.
//   POST {base}/register-vk/{apiKey}    register the circuit VK once
//   POST {base}/submit-proof/{apiKey}   submit { proof, publicSignals, vk }
//   GET  {base}/job-status/{apiKey}/{jobId}   poll until "Finalized"
//
// The API key travels in the URL path (that's Kurier's design), so every log
// line goes through redact() — the key must never appear in logs or errors.

export class KurierClient {
  constructor(cfg, log = console, fetchImpl = fetch) {
    this.cfg = cfg;
    this.log = log;
    this.fetch = fetchImpl;
    this.enabled = Boolean(cfg.kurierApiKey);
    this.vkHashPromise = null;
  }

  redact(text) {
    const s = String(text);
    if (!this.cfg.kurierApiKey) return s;
    return s.split(this.cfg.kurierApiKey).join("***");
  }

  url(p) {
    return `${this.cfg.kurierBaseUrl.replace(/\/$/, "")}${p}/${this.cfg.kurierApiKey}`;
  }

  async postJson(url, body) {
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text for the error message */
    }
    if (!res.ok) {
      throw new Error(
        `Kurier POST ${this.redact(url)} -> HTTP ${res.status}: ${this.redact(text.slice(0, 200))}`
      );
    }
    return data ?? {};
  }

  async getJson(url) {
    const res = await this.fetch(url, { method: "GET" });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      throw new Error(
        `Kurier GET ${this.redact(url)} -> HTTP ${res.status}: ${this.redact(text.slice(0, 200))}`
      );
    }
    return data ?? {};
  }

  readCachedVkHash() {
    try {
      const j = JSON.parse(fs.readFileSync(this.cfg.kurierCachePath, "utf8"));
      return j.vkHash || null;
    } catch {
      return null;
    }
  }

  cacheVkHash(vkHash) {
    try {
      fs.mkdirSync(path.dirname(this.cfg.kurierCachePath), { recursive: true });
      fs.writeFileSync(this.cfg.kurierCachePath, JSON.stringify({ vkHash }, null, 2));
    } catch (e) {
      this.log.warn?.(`[kurier] could not cache vk hash: ${e.message}`);
    }
  }

  // Resolve the vk hash to submit proofs against: explicit env override ->
  // register-vk result (cached on disk) -> the platform-published hash.
  ensureVkHash() {
    if (!this.vkHashPromise) {
      this.vkHashPromise = (async () => {
        if (this.cfg.kurierVkHash) return this.cfg.kurierVkHash;
        const cached = this.readCachedVkHash();
        if (cached) return cached;
        if (!this.enabled) return this.cfg.gatekeeperVkHash;
        const vk = JSON.parse(fs.readFileSync(this.cfg.circuitVkJson, "utf8"));
        const data = await this.postJson(this.url("/register-vk"), {
          proofType: "groth16",
          proofOptions: { library: "snarkjs", curve: "bn128" },
          vk,
        });
        const vkHash = data.vkHash || data.meta?.vkHash || data.data?.vkHash || null;
        if (!vkHash) {
          throw new Error(`Kurier register-vk returned no vkHash: ${this.redact(JSON.stringify(data).slice(0, 200))}`);
        }
        if (vkHash.toLowerCase() !== this.cfg.gatekeeperVkHash.toLowerCase()) {
          this.log.warn?.(
            `[kurier] registered vkHash ${vkHash} differs from platform-published ${this.cfg.gatekeeperVkHash}; using the registered one for submissions`
          );
        }
        this.cacheVkHash(vkHash);
        return vkHash;
      })();
    }
    return this.vkHashPromise;
  }

  async submitProof(proof, publicSignals) {
    const vk = await this.ensureVkHash();
    const body = {
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk },
    };
    if (this.cfg.kurierChainId !== null && this.cfg.kurierChainId !== undefined) {
      body.chainId = this.cfg.kurierChainId;
    }
    const data = await this.postJson(this.url("/submit-proof"), body);
    const jobId = data.jobId || data.data?.jobId || null;
    if (!jobId) {
      throw new Error(`Kurier submit-proof returned no jobId: ${this.redact(JSON.stringify(data).slice(0, 200))}`);
    }
    return { jobId, vkHash: vk };
  }

  async jobStatus(jobId) {
    const data = await this.getJson(`${this.url("/job-status")}/${jobId}`);
    const d = data.data && typeof data.data === "object" ? { ...data, ...data.data } : data;
    return {
      status: d.status || null,
      txHash: d.txHash || d.extrinsicHash || d.transactionHash || null,
      raw: data,
    };
  }

  // Submit and poll until Finalized or the budget runs out.
  // Returns { proofReference, status, jobId } — status "Finalized" only when
  // the chain verification actually finalized inside the budget.
  async submitAndFinalize(proof, publicSignals, budgetMs) {
    const { jobId } = await this.submitProof(proof, publicSignals);
    const deadline = Date.now() + Math.max(0, budgetMs);
    let last = null;
    for (;;) {
      last = await this.jobStatus(jobId);
      if (last.status === "Finalized") {
        return { proofReference: last.txHash || jobId, status: "Finalized", jobId };
      }
      if (last.status && /fail|error|reject|invalid/i.test(last.status)) {
        throw new Error(`Kurier job ${jobId} ended in status ${last.status}`);
      }
      if (Date.now() + this.cfg.kurierPollMs > deadline) {
        return { proofReference: null, status: last.status || "Submitted", jobId };
      }
      await new Promise((r) => setTimeout(r, this.cfg.kurierPollMs));
    }
  }
}
