// Signed workflow bundle: the server instructions, procedures, skill pointers and hard-rule limits the agent runs
// under. Only a bundle signed with a release key is ever used, so editing any byte of it fails verification.
// The agent carries public keys only. Byte-compatible with the Go reference in internal/workflow.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FORMAT = 1;

export class WorkflowError extends Error {}
export const UNKNOWN_KEY = "signed with an unknown key";
export const BAD_SIGNATURE = "signature does not match: the workflow was modified";

/** Reads "key_id base64-public-key" lines. Blank lines and # comments are ignored. */
export function parseKeys(text) {
  const keys = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [id, b64] = line.split(/\s+/);
    const pub = Buffer.from(b64 || "", "base64");
    if (!id || pub.length !== 32) throw new WorkflowError(`bad key line "${line}"`);
    keys.set(id, crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") }, format: "jwk" }));
  }
  if (!keys.size) throw new WorkflowError("no release keys");
  return keys;
}

/** Verifies a signed envelope. Returns { bundle, hash } (hash: SHA-256 of the payload). */
export function open(raw, keys) {
  let env;
  try {
    env = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  } catch (e) {
    throw new WorkflowError(`not a signed workflow file: ${e.message}`);
  }
  const pub = keys.get(env?.key_id);
  if (!pub) throw new WorkflowError(UNKNOWN_KEY);
  const payload = Buffer.from(typeof env.payload === "string" ? env.payload : "", "base64");
  const sig = Buffer.from(typeof env.signature === "string" ? env.signature : "", "base64");
  let ok = false;
  try {
    ok = sig.length === 64 && crypto.verify(null, payload, pub, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new WorkflowError(BAD_SIGNATURE);
  let bundle;
  try {
    bundle = JSON.parse(payload.toString("utf8"));
  } catch (e) {
    throw new WorkflowError(`signed payload is not a bundle: ${e.message}`);
  }
  return { bundle, hash: crypto.createHash("sha256").update(payload).digest("hex") };
}

/** Signs a bundle with a release key (a KeyObject). Used by the release tool only. */
export function seal(bundle, keyId, privateKey) {
  const payload = Buffer.from(JSON.stringify(bundle), "utf8");
  return JSON.stringify({ key_id: keyId, payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, privateKey).toString("base64") }, null, 2);
}

/** Compares dotted versions: olderThan("0.2.0", "0.10.0") is true. */
export function olderThan(have, want) {
  const h = String(have).split("."), w = String(want).split(".");
  for (let i = 0; i < Math.max(h.length, w.length); i++) {
    const a = parseInt(h[i] || "0", 10) || 0, b = parseInt(w[i] || "0", 10) || 0;
    if (a !== b) return a < b;
  }
  return false;
}

// Line endings differ after a Git checkout on Windows; they are not an edit.
const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/\n+$/, "");

/**
 * Loads the verified bundle and keeps the saved copy and the installed skill files equal to it.
 * memory: { highestVersion(), setHighestVersion(v), recordTamper(what) } (rollback protection, tamper log).
 */
export class Guard {
  constructor({ keys, shipped, dataDir, skillDirs = [], appVersion, memory }) {
    Object.assign(this, { keys, shipped, skillDirs, appVersion, memory });
    this.path = path.join(dataDir, "workflow.signed.json");
    this.bundle = null;
    this.status = { ok: false, problem: "workflow not loaded" };
  }

  /** Verifies the shipped and saved copies, uses the newest one that verifies, restores the rest. */
  load() {
    const cands = [], problems = [];
    try {
      cands.push({ ...open(this.shipped, this.keys), raw: this.shipped, source: "built-in" });
    } catch (e) {
      problems.push(`built-in workflow: ${e.message}`);
    }
    let saved = null, savedBad = false;
    try {
      saved = fs.readFileSync(this.path);
    } catch {
      saved = null;
    }
    if (saved) {
      try {
        cands.push({ ...open(saved, this.keys), raw: saved, source: "saved" });
      } catch (e) {
        savedBad = true;
        problems.push(`saved workflow: ${e.message}`);
        this.memory.recordTamper("saved workflow file");
      }
    }
    cands.sort((a, b) => b.bundle.version - a.bundle.version);
    return this.#accept(cands, problems, saved, savedBad);
  }

  /** Accepts a newer signed bundle (from the updater). Never an older one than the one in use. */
  install(raw) {
    const c = { ...open(raw, this.keys), raw: Buffer.from(raw), source: "saved" };
    if (this.bundle && c.bundle.version < this.bundle.version) {
      throw new WorkflowError(`workflow version ${c.bundle.version} is older than the one in use (${this.bundle.version})`);
    }
    let saved = null;
    try {
      saved = fs.readFileSync(this.path);
    } catch {
      saved = null;
    }
    return this.#accept([c], [], saved, false);
  }

  #accept(cands, problems, saved, savedBad) {
    const lock = (problem) => {
      this.bundle = null;
      this.status = { ok: false, problem };
      return this.status;
    };
    if (!cands.length) return lock(problems.join("; "));
    const best = cands[0], b = best.bundle;
    if (b.format !== FORMAT) return lock(`workflow format ${b.format} is not supported by this version of FreeApply; update FreeApply`);
    if (b.min_app_version && olderThan(this.appVersion, b.min_app_version)) {
      return lock(`this workflow needs FreeApply ${b.min_app_version} or newer (this is ${this.appVersion}); update FreeApply`);
    }
    const highest = this.memory.highestVersion();
    if (b.version < highest) return lock(`workflow version ${b.version} is older than version ${highest} already accepted; refusing the rollback`);
    const firstLoad = b.version > highest;
    this.memory.setHighestVersion(b.version);
    const repaired = [];
    if (!saved || !Buffer.from(saved).equals(Buffer.from(best.raw))) {
      try {
        fs.mkdirSync(path.dirname(this.path), { recursive: true });
        fs.writeFileSync(this.path, best.raw);
        if (savedBad) repaired.push("saved workflow file");
      } catch {
        // A read-only data folder still runs from the verified copy in memory.
      }
    }
    this.bundle = b;
    repaired.push(...this.#checkSkills(!firstLoad));
    this.status = { ok: true, version: b.version, hash: best.hash, source: best.source, repaired };
    return this.status;
  }

  /** Restores any installed skill file that differs from the bundle. Returns the paths it fixed. */
  checkSkills() {
    return this.#checkSkills(true);
  }

  // A difference counts as tampering only when this bundle version was accepted before; on the first load of a new
  // version it is an ordinary update.
  #checkSkills(tamperIfDifferent) {
    if (!this.bundle) return [];
    const fixed = [];
    for (const dir of this.skillDirs) {
      for (const [rel, want] of Object.entries(this.bundle.skills || {})) {
        const p = path.join(dir, ...rel.split("/"));
        let have = null;
        try {
          have = fs.readFileSync(p, "utf8");
        } catch (e) {
          if (e.code !== "ENOENT") continue;
        }
        if (have !== null && normalize(have) === normalize(want)) continue;
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, want);
        } catch {
          continue;
        }
        fixed.push(p);
        if (tamperIfDifferent && have !== null) this.memory.recordTamper(`skill file ${rel}`);
      }
    }
    return fixed.sort();
  }
}
