// FreeApply dashboard: a local web server (127.0.0.1 only) serving web/index.html and a small JSON API.
// Port of server/dashboard.py; same endpoints, so the page works unchanged.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import * as sharing from "./sharing.js";
import * as autorun from "./autorun.js";
import * as inbox from "./inbox.js";
import * as ads from "./ads.js";
import * as errorlog from "./errorlog.js";
import * as models from "./models.js";
import * as secrets from "./secrets.js";
import { testLogin } from "./imap.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MAX_BODY = 15 * 1024 * 1024;
let _url = null, _starting = null;

function send(res, code, body, ctype = "application/json") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" && ctype !== "application/json" ? body : JSON.stringify(body));
  res.writeHead(code, { "Content-Type": ctype, "Content-Length": data.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}

// Refuse requests whose Host is not this machine (DNS-rebinding guard).
function localHost(req) {
  const h = req.headers.host || "";
  const host = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return ["127.0.0.1", "localhost", "[::1]"].includes(host);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error("request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Global Privacy Control: a browser opt-out signal. Honored by keeping the Talent Pool (a sale) off. */
function gpc(req) {
  if (req.headers["sec-gpc"] !== "1") return false;
  if (store.loadSettings().sharing.talent_pool === true) store.saveSettings({ sharing: { talent_pool: false, decided_at: store.now() } });
  return true;
}

// The models each level uses now, plus what Automatic would pick, for the AI models panel in Advanced settings.
const modelInfo = (s) => ({ ...models.resolve({ settings: s }), defaults: models.resolve({ settings: { ...s, model_choices: {} } }).levels });

function doGet(req, res, u) {
  const q = Object.fromEntries(u.searchParams);
  const g = gpc(req);
  const legal = u.pathname.match(/^\/api\/legal\/(\w+)$/);
  if (legal) return send(res, 200, sharing.renderDoc(legal[1]), "text/html; charset=utf-8");
  switch (u.pathname) {
    case "/api/consent": {
      const s = store.loadSettings();
      return send(res, 200, { ...sharing.consentStatus(s), defaults: sharing.defaults(s, g), sharing: store.publicSettings(s).sharing, gpc: g,
        operator: sharing.OPERATOR, contact: sharing.CONTACT_EMAIL, effective: sharing.EFFECTIVE_DATE });
    }
    case "/api/issues": return send(res, 200, store.listIssues());
    case "/api/autorun": return send(res, 200, { ...autorun.status(), sites: store.siteReadiness() });
    case "/api/sponsor": return send(res, 200, { ad: ads.pick(q.slot || "overview") });
    case "/api/sharing/preview": return send(res, 200, sharing.preview());
    case "/api/problems": return send(res, 200, sharing.errorReports());
    case "/":
    case "/index.html": return send(res, 200, fs.readFileSync(path.join(WEB, "index.html")), "text/html; charset=utf-8");
    case "/api/health": return send(res, 200, { app: "freeapply", version: store.VERSION, runtime: "node" });
    case "/api/stats": return send(res, 200, store.stats());
    // Whether an email login is saved, and for which address: never the password.
    case "/api/email": return send(res, 200, secrets.emailStatus());
    case "/api/jobs": return send(res, 200, store.listJobs(q.status, q.outcome, q.q));
    case "/api/replies": return send(res, 200, store.listReplies());
    case "/api/inbox": return send(res, 200, store.listInbox());
    // Asked every few seconds by the open dashboard; it reloads when the stamp moves.
    case "/api/changes": return send(res, 200, { stamp: store.changeStamp() });
    case "/api/settings": {
      const s = store.publicSettings(store.loadSettings());
      return send(res, 200, { settings: s, missing: store.missingFields(s), statuses: store.STATUSES, outcomes: store.OUTCOMES,
        sites: store.JOB_SITES, data_dir: store.paths.data, db: store.paths.db, models: modelInfo(s) });
    }
    default: return send(res, 404, { error: "not found" });
  }
}

async function doPost(req, res, u) {
  // The custom header forces a CORS preflight, which this server never approves, so other sites cannot post.
  if (req.headers["x-freeapply"] !== "1") return send(res, 403, { error: "forbidden" });
  const body = await readBody(req);
  const g = gpc(req);
  const bg = (fn) => setImmediate(() => fn().catch(() => {}));
  switch (u.pathname) {
    case "/api/consent":
      sharing.accept(body, g);
      bg(() => sharing.sync(true));
      return send(res, 200, sharing.consentStatus());
    case "/api/sharing":
      sharing.updateChoices(body, g);
      bg(() => sharing.sync(true));
      return send(res, 200, { ok: true, gpc: g });
    case "/api/autorun/stop": return send(res, 200, autorun.requestStop());
    case "/api/inbox/check": return send(res, 200, await inbox.check({ force: true }));
    // The top bar's Start and Stop: turns auto-run on or off (Stop also ends a run in progress).
    case "/api/autorun/switch": return send(res, 200, autorun.setOn(body.on === true));
    // The email login is checked with the mail server first and saved only if it works; only the local .env keeps it.
    case "/api/email/save": {
      const login = secrets.checkLogin(body);
      try {
        await testLogin(login);
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message, ...secrets.emailStatus() });
      }
      const st = secrets.saveEmailLogin(login);
      store.refreshSetup();
      return send(res, 200, { ok: true, ...st, missing: store.missingFields() });
    }
    case "/api/email/remove": {
      const st = secrets.removeEmailLogin();
      store.refreshSetup();
      return send(res, 200, { ok: true, ...st, missing: store.missingFields() });
    }
    case "/api/sponsor/click": return send(res, 200, ads.click(String(body.id || "")));
    case "/api/issues/answer": return send(res, 200, store.answerQuestions(body.answers));
    case "/api/issues/account": return send(res, 200, store.markAccount(Number(body.job_id), String(body.email || "").trim(), body.note));
    case "/api/sharing/sync": return send(res, 200, await sharing.sync(true));
    case "/api/sharing/delete": return send(res, 200, await sharing.deleteRemote());
    // A problem report leaves this computer only here, with consent: true from the report's own checkbox.
    case "/api/problems/send": return send(res, 200, await sharing.sendErrorReport(String(body.id || ""), body.consent === true));
    case "/api/problems/dismiss": return send(res, 200, errorlog.remove(String(body.id || "")));
    case "/api/settings": {
      // Consent changes go through /api/consent and /api/sharing only; integrity records are never editable.
      const { legal, sharing: _s, integrity, ...patch } = body;
      const s = store.saveSettings(patch);
      return send(res, 200, { settings: store.publicSettings(s), missing: store.missingFields(s), models: modelInfo(s) });
    }
    case "/api/resume": {
      const s = store.saveResume(body.filename, Buffer.from(body.data_base64 || "", "base64"), body.text || "");
      return send(res, 200, { settings: store.publicSettings(s), missing: store.missingFields(s) });
    }
  }
  // Removing a job is the user's call only: the agent has no tool for it.
  const remove = u.pathname.match(/^\/api\/jobs\/(\d+)\/remove$/);
  if (remove) return send(res, 200, store.deleteJob(Number(remove[1])));
  const job = u.pathname.match(/^\/api\/jobs\/(\d+)$/);
  if (job) {
    // The user's own changes from the dashboard: not subject to the agent's rules.
    const jid = Number(job[1]);
    if ("outcome" in body) store.setOutcome(jid, body.outcome);
    if (body.status) store.setStatus(jid, body.status, { note: body.note });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "not found" });
}

async function handle(req, res) {
  if (!localHost(req)) return send(res, 403, { error: "forbidden host" });
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET") return doGet(req, res, u);
    if (req.method === "POST") return await doPost(req, res, u);
    return send(res, 405, { error: "method not allowed" });
  } catch (e) {
    if (errorlog.unexpected(e)) errorlog.record("dashboard", `${req.method} ${u.pathname.replace(/\d+/g, ":id")}`, e);
    return send(res, req.method === "GET" ? 500 : 400, { error: e.message });
  }
}

// Reuse only a dashboard of this exact build; an older FreeApply (for example the Python one) keeps its port and this
// one takes the next free port, so the page always matches this agent.
async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const h = await r.json();
    return h.app === "freeapply" && h.runtime === "node" && h.version === store.VERSION;
  } catch {
    return false;
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handle(req, res));
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.unref(); // the MCP stdio loop decides when the process ends
      resolve(server);
    });
  });
}

/** Starts the dashboard once per machine; reuses one that another FreeApply process already serves. */
export function start() {
  if (_url) return Promise.resolve(_url);
  _starting ??= (async () => {
    for (let port = store.paths.port; port < store.paths.port + 10; port++) {
      if (await isOurs(port)) {
        _url = `http://127.0.0.1:${port}/`;
        break;
      }
      try {
        await listen(port);
        _url = `http://127.0.0.1:${port}/`;
        break;
      } catch {
        // port taken by something else: try the next one
      }
    }
    _starting = null;
    return _url;
  })();
  return _starting;
}

/** Opens a URL in the user's default browser without a shell. */
/** Opens the URL in the user's browser. Resolves true once the launcher started, false if there is none (the URL is
 * returned to the agent anyway). A missing launcher is an 'error' event, which must be handled or the process exits. */
export function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}
