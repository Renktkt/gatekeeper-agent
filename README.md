# Proof Gatekeeper Agent — zkVerify Agent Games

A deploy-ready Node service that plays the **Proof Gatekeeper** track of
[Agent Games](https://agentgames.zkverify.io/events/proof-gatekeeper): the
platform POSTs proof-backed payment tasks, the agent answers
APPROVE/REJECT with a reason code, and backs every answer (except
PROOF_REUSED) with a locally generated Groth16 proof that is submitted to
zkVerify via Kurier and polled until Finalized — all inside the platform's
60-second response deadline.

The decision engine is **fully deterministic** (field checks only, no LLM in
the hot path) and mirrors the Gatekeeper circuit, which itself asserts
`decision == validity`: a wrong decision cannot even be proven.

## Run it

```bash
npm install
AGENT_GAMES_SECRET=<platform secret> KURIER_API_KEY=<kurier key> npm start
# -> POST /agent, GET /health on PORT (default 8080)
```

Local end-to-end test (mock Kurier, real circuit): `npm test`
Standalone mock Kurier: `npm run mock-kurier` (port 8791).

## How it works

1. **Signature first.** The raw request body is HMAC-SHA256-verified against
   `AGENT_GAMES_SECRET` *before* any JSON parsing. Invalid/missing signature
   → 401, no processing. Every response is signed with the
   `x-agent-games-signature` header over the raw response body.
2. **Decide** (`src/decide.js`) — first failing check wins:
   `proof_vk == registered_vk` → VK_SUBSTITUTION ·
   `public_balance >= minimum` → THRESHOLD_MISMATCH ·
   `recipient == condition_recipient` → RECIPIENT_MISMATCH ·
   `current_block < expiry_block` → EXPIRED_CONDITION ·
   `amount <= max_transfer` → AMOUNT_OVERFLOW ·
   `proof_tx` in the persisted seen-set → PROOF_REUSED (answered with **no**
   proof, per the rules) · otherwise APPROVE / VALID_CONDITION.
   Fail-closed throughout: any missing/unparseable field fails its check
   (wrong REJECT −3 beats wrong APPROVE −6).
3. **Prove** (`src/prove.js`) — snarkjs `groth16.fullProve` against the local
   circuit artifacts in `circuits/` (~0.3 s warm / ~1.5 s cold on a small VM;
   proofs are serialized through a queue). Witness inputs are the task's own
   fields, encoded as field elements (see `src/encode.js`).
4. **Submit** (`src/kurier.js`) — Kurier REST: `register-vk` once (cached in
   `data/kurier-vk.json`), `submit-proof`, poll `job-status` until
   `Finalized`. The response carries `proof`, `public_signals`,
   `proof_reference` (finalized tx/job ref) and `proof_status`.
5. **Deadline discipline.** Internal budget defaults to 50 s (tightened by a
   task's own `deadline_at`). If Kurier finalization can't complete in time,
   the response still goes out with the decision + local proof
   (`proof_status: "submitted"`/`"local"`) — a proof-less-in-time correct
   answer beats a timeout (−2), and a late answer scores nothing.

### Measured circuit semantics (why expiry is strict)

Proving tests against the real circuit (2026-11-15) show an APPROVE is only
provable when `current_block < expiry_block`; at equality the only provable
decision is REJECT. Balance uses `>=`, amount uses `<=`, both as documented.
The engine follows the circuit — it is the referee for verified decisions.

## Registration mapping (dashboard ↔ this service)

| Platform step | This service |
|---|---|
| Register agent endpoint URL | `https://<your-host>/agent` (the arena POSTs tasks here; `GET /health` must pass the platform health check) |
| Rotate Secret (dashboard) | Put the generated value in env `AGENT_GAMES_SECRET`. Never hardcode it, never paste it into chat/logs. Restart the service after rotating. |
| Kurier API key (free, kurier.xyz) | Env `KURIER_API_KEY`. Without it the agent still answers with local proofs (`proof_status: "local"`) but nothing reaches the chain — do not compete in that mode. |
| Practice mode | Complete the signed preflight + at least one practice task before the first scored round. Practice is also where the two encoding seams below get validated. |
| Tracks | Register this agent for **Proof Gatekeeper**. One agent per owner in the event. |

## Environment variables

| Var | Required | Default | Meaning |
|---|---|---|---|
| `AGENT_GAMES_SECRET` | yes* | — | Platform HMAC secret (Rotate Secret). *Or `ALLOW_UNSIGNED_DEV=1` for local plumbing tests only. |
| `KURIER_API_KEY` | for competition | — | Kurier key; enables submit/finalize. |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address. Terminate HTTPS at your proxy/host — the platform requires a public HTTPS endpoint. |
| `KURIER_BASE_URL` | no | `https://api.kurier.xyz/api/v1` | Kurier REST base. |
| `KURIER_VK_HASH` | no | register-vk / published | VK hash to submit against. Published Gatekeeper hash: `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`. |
| `KURIER_CHAIN_ID` | no | unset | Only for publish-to-chain flows; omit for verify-only. |
| `RESPONSE_BUDGET_MS` | no | `50000` | Hard internal response budget (< 60 s platform deadline). |
| `SEEN_STORE_PATH` | no | `data/seen.json` | PROOF_REUSED seen-set file. Keep it on persistent disk and **do not wipe it mid-event** — a forgotten reference is a wrong APPROVE (−6). Back it up before redeploys. |
| `CIRCUIT_WASM` / `CIRCUIT_ZKEY` / `CIRCUIT_VK_JSON` | no | `circuits/…` | Circuit artifact paths. |
| `TASK_ID_ENCODING` | no | `sha256` | Field encoding for non-numeric `task_id`s (see seams). |
| `AGENT_GAMES_SALT` | no | random per proof | Fixed circuit salt (tests only). |
| `PROVING_ENABLED` | no | `1` | `0` disables proving (plumbing dev only). |

## Operating notes (rounds)

- Rounds run **daily ≈17:30–03:30 WIB (16:00–02:00 IST), 13–20 Nov 2026**,
  8 tasks per round; scores cumulative. The agent must be up, healthy and
  registered **before** a round opens — entries lock while a round is open.
- Run it under a supervisor (systemd/pm2/Docker restart policy) with the
  health endpoint monitored: most of the current field scored 0 because
  their endpoints died. A watchdog that restarts on `/health` failure is
  the single highest-value ops measure.
- Warm-up: the service runs one dummy proof at boot (`[prove] warm-up ok`),
  keeping the first task of a round at ~0.4 s instead of ~2 s.
- Watch the per-task log line (`decision=… reason=… proof=finalized
  total_ms=…`). Anything other than `proof=finalized` in a scored round
  means points are leaking on the proof side — check Kurier status first.
- The seen-set spans the whole event (references can recur across rounds).

## Known seams (validate in practice mode, in this order)

1. **Hosting** — the endpoint needs a stable public HTTPS URL (a tunnel from
   the dev VM was proven unviable in recon). Not solved by this repo.
2. **Kurier finalization latency** — untested against the real API (no key
   yet). The mock implements the documented contract; practice mode is the
   first real measurement. If finalization regularly exceeds ~50 s, answers
   still land with local proofs (points docked, not zeroed).
3. **Field encodings** — `task_id` (non-numeric → `sha256 mod p`), VK hashes
   (`BigInt mod p`) and addresses (`BigInt`) use the natural encodings in
   `src/encode.js`. If the platform recomputes public signals with different
   encodings, practice submissions will show it; encodings are env-switchable
   where alternatives exist.
4. **On-chain proof lookup** — the build checklist mentions confirming the
   task's proof on-chain (zkVerifyJS). All 7 documented traps are decidable
   from the payload fields themselves, which is what the engine uses; a live
   chain lookup is not in the hot path (it would need a funded account and
   adds deadline risk for no documented scoring gain).
