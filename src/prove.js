import { randomSalt, dec } from "./encode.js";

// Local Groth16 proving with snarkjs against the Gatekeeper circuit.
// Measured on this VM: ~1.4-1.7 s per proof. Proving is CPU-bound, so calls
// are serialized through a queue — concurrent proofs on a small VM would
// inflate each other's latency against the 60 s platform deadline.

let snarkjsPromise = null;
function loadSnarkjs() {
  if (!snarkjsPromise) snarkjsPromise = import("snarkjs");
  return snarkjsPromise;
}

export class Prover {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.tail = Promise.resolve();
    this.ready = false;
  }

  // One dummy proof so WASM/zkey loading and JIT costs are paid at boot,
  // not inside the first scored task's 60 s window.
  async warmUp() {
    const dummy = {
      decision: "1",
      minimum: "1000",
      publicBalance: "1460",
      expiryBlock: "19842201",
      currentBlock: "19832000",
      recipient: "12345",
      conditionRecipient: "12345",
      amount: "500",
      maxTransfer: "1000",
      taskId: "424242",
      registeredVkHash: "999",
      proofVkHash: "999",
    };
    try {
      const t0 = Date.now();
      await this.prove(dummy);
      this.ready = true;
      this.log.info?.(`[prove] warm-up ok in ${Date.now() - t0} ms`);
    } catch (e) {
      this.log.error?.(`[prove] warm-up FAILED: ${e.message}`);
    }
  }

  prove(witness) {
    const run = async () => {
      const snarkjs = await loadSnarkjs();
      const input = { ...witness };
      if (input.salt === undefined) {
        input.salt = this.cfg.fixedSalt ? this.cfg.fixedSalt : dec(randomSalt());
      }
      const t0 = Date.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        this.cfg.circuitWasm,
        this.cfg.circuitZkey
      );
      return { proof, publicSignals, ms: Date.now() - t0 };
    };
    // Serialize: chain onto the previous proof regardless of its outcome.
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}
