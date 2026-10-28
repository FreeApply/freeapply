// Daily update check. The server's manifest only points at things; trust comes from the signatures:
//  - a newer signed workflow bundle is downloaded, verified against the built-in release keys and installed through the
//    guard, which refuses anything unsigned, edited or older than a version already accepted;
//  - a newer app version only produces a notice (the AI app updates the extension itself).
// A hacked server can therefore withhold updates but cannot change what the agent does. Nothing about the user is sent:
// the check is a conditional GET of one small public file.
import * as store from "./store.js";
import * as errorlog from "./errorlog.js";
import { endpoint } from "./sharing.js";
import { FORMAT, olderThan, open } from "./workflow.js";

const CHECK_EVERY_MS = 24 * 3600e3;
const JITTER_MS = 2 * 3600e3; // spreads the installations over two hours so the server never sees a spike
const MAX_MANIFEST = 64 * 1024;
const MAX_BUNDLE = 1024 * 1024;
const META = "update_check";
// Release assets are redirected from github.com to these hosts.
const RELEASE_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

const readCache = () => {
  try {
    return JSON.parse(store.metaGet(META) || "{}");
  } catch {
    return {};
  }
};
const writeCache = (c) => store.metaSet(META, JSON.stringify(c));

/** https only, and only our own site or GitHub Releases. The signature is the real protection; this is a second lock. */
export function urlAllowed(url, base = endpoint()) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && !(u.hostname === "127.0.0.1" && new URL(base || "https://x").hostname === "127.0.0.1")) return false;
  let own = "";
  try {
    own = new URL(base).hostname;
  } catch {
    // no endpoint: only release hosts qualify
  }
  return u.hostname === own || RELEASE_HOSTS.includes(u.hostname);
}

async function download(url, limit, fetchImpl = fetch) {
  const r = await fetchImpl(url, { headers: { "User-Agent": `FreeApply/${store.VERSION}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > limit) throw new Error("download too large");
  return { buf, r };
}

/** The part of the last check the rest of the app shows: is a newer app available, and what workflow is in use. */
export function info() {
  const c = readCache();
  const app = c.manifest?.app;
  const newer = app && typeof app.version === "string" && olderThan(store.VERSION, app.version);
  return { app_update: newer ? { version: app.version, notes: String(app.notes || "").slice(0, 300),
    url: urlAllowed(app.url || "") ? app.url : null } : null,
    last_checked: c.checked_at || null, workflow_update_blocked: c.blocked || null };
}

/**
 * One check. `guard` is the workflow guard. Returns what happened; never throws (a failed check backs off and the app
 * keeps running on the bundle it has).
 */
export async function check(guard, { force = false, fetchImpl = fetch } = {}) {
  const base = endpoint();
  if (!base) return { checked: false, reason: "no update server configured" };
  const cache = readCache();
  if (!force && cache.next_at && Date.now() < Date.parse(cache.next_at)) return { checked: false, reason: "checked recently" };
  const next = { ...cache, checked_at: new Date().toISOString() };
  const schedule = (failures) => {
    // Success: tomorrow plus jitter. Failure: 1 h, 2 h, 4 h ... capped at a day.
    const wait = failures ? Math.min(CHECK_EVERY_MS, 3600e3 * 2 ** (failures - 1)) : CHECK_EVERY_MS + Math.random() * JITTER_MS;
    return { ...next, failures, next_at: new Date(Date.now() + wait).toISOString() };
  };
  try {
    const headers = { "User-Agent": `FreeApply/${store.VERSION}` };
    if (cache.etag) headers["If-None-Match"] = cache.etag;
    const r = await fetchImpl(`${base}/v1/manifest`, { headers, signal: AbortSignal.timeout(15000) });
    let manifest = cache.manifest, etag = cache.etag;
    if (r.status === 200) {
      const text = await r.text();
      if (text.length > MAX_MANIFEST) throw new Error("manifest too large");
      manifest = JSON.parse(text);
      etag = r.headers.get("etag");
    } else if (r.status !== 304) {
      throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    }
    const out = { checked: true, workflow: "current" };
    next.manifest = manifest;
    next.etag = etag;
    next.blocked = null;
    const wf = manifest?.workflow;
    const have = guard.bundle?.version ?? store.integrityMemory.highestVersion();
    if (wf && Number.isInteger(wf.version) && wf.version > have && typeof wf.url === "string") {
      if (!urlAllowed(wf.url, base)) {
        out.workflow = "refused: url not allowed";
        next.blocked = out.workflow;
      } else {
        const { buf } = await download(wf.url, MAX_BUNDLE, fetchImpl);
        // Check that this build can run it before the guard installs it: a bundle that needs a newer app or format would
        // make the guard lock, and an update must never turn a working install into a locked one.
        const b = open(buf, guard.keys).bundle;
        if (b.format !== FORMAT || (b.min_app_version && olderThan(store.VERSION, b.min_app_version))) {
          out.workflow = `needs a newer FreeApply (${b.min_app_version || `format ${b.format}`})`;
          next.blocked = out.workflow;
        } else {
          const st = guard.install(buf);
          out.workflow = st.ok ? `updated to ${st.version}` : `not installed: ${st.problem}`;
          if (!st.ok) next.blocked = out.workflow;
        }
      }
    }
    writeCache(schedule(0));
    // A refused or failed install is a problem worth reporting; "needs a newer FreeApply" is not (the app update fixes it).
    if (/^(refused|not installed)/.test(out.workflow)) errorlog.record("update", "workflow update", out.workflow);
    out.app_update = info().app_update;
    return out;
  } catch (e) {
    writeCache(schedule((cache.failures || 0) + 1));
    if (!errorlog.transient(e)) errorlog.record("update", "update check", e);
    return { checked: true, error: e.message };
  }
}
