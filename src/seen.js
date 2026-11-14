import fs from "node:fs";
import path from "node:path";

// Persistent set of proof_tx references this agent has already seen.
// Used for the PROOF_REUSED check. Stored as a JSON array on disk; every add
// is written through atomically (tmp file + rename) — task volume is tiny
// (8 tasks/day), so synchronous durability beats cleverness here.

export class SeenStore {
  constructor(filePath, log = console) {
    this.filePath = filePath;
    this.log = log;
    this.set = new Set();
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string") this.set.add(x);
    } catch (e) {
      if (e.code !== "ENOENT") {
        this.log.warn?.(`[seen] could not load ${filePath}: ${e.message} — starting empty`);
      }
    }
  }

  has(tx) {
    return this.set.has(tx);
  }

  add(tx) {
    if (typeof tx !== "string" || tx === "" || this.set.has(tx)) return;
    this.set.add(tx);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.set]));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      // In-memory state is still correct for this process lifetime.
      this.log.warn?.(`[seen] persist failed: ${e.message}`);
    }
  }

  get size() {
    return this.set.size;
  }
}
