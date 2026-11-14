// Shared Vercel adapter: builds the gatekeeper app once per warm instance
// and exposes its Node http request listener as a Vercel function handler.
// Seen-set persistence degrades to in-memory on the read-only filesystem
// (SeenStore already swallows write failures); everything else is identical
// to the standalone server.
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";

let listener = null;

function getListener() {
  if (listener) return listener;
  const cfg = loadConfig();
  const { server } = createApp(cfg);
  const handlers = server.listeners("request");
  if (!handlers.length) throw new Error("gatekeeper app has no request listener");
  listener = handlers[0];
  return listener;
}

export default function handler(req, res) {
  // Normalize: direct hits arrive as /api/agent, rewrites keep /agent.
  if (typeof req.url === "string" && req.url.startsWith("/api/")) {
    req.url = req.url.slice(4);
  }
  getListener()(req, res);
}

export const config = { maxDuration: 60 };
