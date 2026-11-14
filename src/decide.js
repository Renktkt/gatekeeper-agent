import {
  parseQuantity,
  encodeAddress,
  encodeVkHash,
  encodeTaskId,
  dec,
} from "./encode.js";

// Deterministic decision engine for Proof Gatekeeper tasks. No LLM, no I/O
// except the seen-set lookup. Checks run in the documented order and the
// FIRST failure wins:
//
//   1. proof_vk == registered_vk          -> VK_SUBSTITUTION
//   2. public_balance >= minimum          -> THRESHOLD_MISMATCH
//   3. recipient == condition_recipient   -> RECIPIENT_MISMATCH
//   4. current_block <  expiry_block      -> EXPIRED_CONDITION   (see note)
//   5. amount <= max_transfer             -> AMOUNT_OVERFLOW
//   6. proof_tx not in local seen-set     -> PROOF_REUSED (answered WITHOUT proof)
//   all pass                              -> APPROVE / VALID_CONDITION
//
// NOTE on check 4 (measured, not assumed): the Gatekeeper circuit itself
// asserts decision == validity, and local proving tests against the real
// circuit show an APPROVE is only provable when current_block < expiry_block
// (strict). At current_block == expiry_block the only provable decision is
// REJECT, so equality is treated as expired here. This matches the circuit
// being "the referee" for what counts as a verified decision.
//
// FAIL CLOSED: any missing/unparseable field fails its check (a wrong REJECT
// costs -3; a wrong APPROVE costs -6). Decisions whose witness inputs cannot
// be faithfully built are returned without a proof (provable=false).

export const REASONS = {
  VALID: "VALID_CONDITION",
  VK: "VK_SUBSTITUTION",
  THRESHOLD: "THRESHOLD_MISMATCH",
  RECIPIENT: "RECIPIENT_MISMATCH",
  EXPIRED: "EXPIRED_CONDITION",
  OVERFLOW: "AMOUNT_OVERFLOW",
  REUSED: "PROOF_REUSED",
  MALFORMED: "MALFORMED_TASK",
};

function normStr(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : null;
}

export function decide(task, seenStore, opts = {}) {
  const fail = (reason_code, extra = {}) => ({
    decision: "REJECT",
    reason_code,
    provable: false,
    witness: null,
    ...extra,
  });

  if (!task || typeof task !== "object" || !task.input || typeof task.input !== "object") {
    return fail(REASONS.MALFORMED);
  }
  const input = task.input;
  const taskId = typeof task.task_id === "string" ? task.task_id : null;

  const proofTx = typeof input.proof_tx === "string" && input.proof_tx !== "" ? input.proof_tx : null;
  if (!proofTx) return fail(REASONS.MALFORMED, { taskId });

  // Parse every quantity once. null = missing/unparseable -> its check fails.
  const minimum = parseQuantity(input.minimum);
  const publicBalance = parseQuantity(input.public_balance);
  const expiryBlock = parseQuantity(input.expiry_block);
  const currentBlock = parseQuantity(input.current_block);
  const amount = parseQuantity(input.amount);
  const maxTransfer = parseQuantity(input.max_transfer);

  const registeredVk = normStr(input.registered_vk);
  const proofVk = normStr(input.proof_vk);
  const recipient = normStr(input.recipient);
  const conditionRecipient = normStr(input.condition_recipient);

  const checks = {
    vk: registeredVk !== null && proofVk !== null && registeredVk === proofVk,
    threshold: minimum !== null && publicBalance !== null && publicBalance >= minimum,
    recipient: recipient !== null && conditionRecipient !== null && recipient === conditionRecipient,
    expiry: expiryBlock !== null && currentBlock !== null && currentBlock < expiryBlock,
    amount: amount !== null && maxTransfer !== null && amount <= maxTransfer,
    reused: seenStore ? seenStore.has(proofTx) : false,
  };

  // Can we build faithful witness inputs for the circuit? Numeric fields must
  // all have parsed; string fields are always encodable (hash fallback).
  const witnessOk =
    minimum !== null &&
    publicBalance !== null &&
    expiryBlock !== null &&
    currentBlock !== null &&
    amount !== null &&
    maxTransfer !== null;

  const buildWitness = (decisionBit) => {
    if (!witnessOk) return null;
    return {
      decision: decisionBit,
      minimum: dec(minimum),
      publicBalance: dec(publicBalance),
      expiryBlock: dec(expiryBlock),
      currentBlock: dec(currentBlock),
      recipient: dec(encodeAddress(input.recipient)),
      conditionRecipient: dec(encodeAddress(input.condition_recipient)),
      amount: dec(amount),
      maxTransfer: dec(maxTransfer),
      taskId: dec(encodeTaskId(taskId ?? "", opts.taskIdEncoding)),
      registeredVkHash: dec(encodeVkHash(input.registered_vk)),
      proofVkHash: dec(encodeVkHash(input.proof_vk)),
      // salt is added by the prover (random per proof, or fixed in tests)
    };
  };

  const reject = (reason_code) => ({
    decision: "REJECT",
    reason_code,
    provable: witnessOk,
    witness: buildWitness("0"),
    taskId,
    proofTx,
    checks,
  });

  if (!checks.vk) return reject(REASONS.VK);
  if (!checks.threshold) return reject(REASONS.THRESHOLD);
  if (!checks.recipient) return reject(REASONS.RECIPIENT);
  if (!checks.expiry) return reject(REASONS.EXPIRED);
  if (!checks.amount) return reject(REASONS.OVERFLOW);
  if (checks.reused) {
    // Spec: PROOF_REUSED tasks carry no proof and are excluded from the
    // reliability set. Return the decision only.
    return {
      decision: "REJECT",
      reason_code: REASONS.REUSED,
      provable: false,
      witness: null,
      taskId,
      proofTx,
      checks,
    };
  }

  return {
    decision: "APPROVE",
    reason_code: REASONS.VALID,
    provable: witnessOk,
    witness: buildWitness("1"),
    taskId,
    proofTx,
    checks,
  };
}
