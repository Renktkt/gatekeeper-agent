import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

const cfg = loadConfig();
const { server, prover } = createApp(cfg, console);

server.listen(cfg.port, cfg.host, () => {
  console.info(
    `[gatekeeper] listening on http://${cfg.host}:${cfg.port} (POST /agent, GET /health)` +
      ` kurier=${cfg.kurierApiKey ? "enabled" : "disabled"} proving=${cfg.provingEnabled ? "on" : "off"}`
  );
});

// Warm the prover in the background so the first real task is fast.
prover.warmUp();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.info(`[gatekeeper] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
