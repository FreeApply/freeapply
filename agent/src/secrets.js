// The email login for the built-in reply reader: an app password the user pastes into the dashboard (Settings →
// Email). It is kept only in a .env file in the FreeApply data folder, readable by the user alone, and is never
// returned by a tool, the dashboard API, a log or shared data: only imap.js reads it, to sign in to the mail server.
// Job-site passwords are never stored: the browser the AI app uses fills them in (see the apply procedure).
import fs from "node:fs";
import path from "node:path";
import { paths } from "./store.js";

const KEYS = { address: "FREEAPPLY_EMAIL_ADDRESS", password: "FREEAPPLY_EMAIL_APP_PASSWORD", host: "FREEAPPLY_EMAIL_HOST" };
export const GMAIL_HOST = "imap.gmail.com";

const envPath = () => path.join(paths.data, ".env");

function readEnv() {
  let text = "";
  try {
    text = fs.readFileSync(envPath(), "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function writeEnv(values) {
  fs.mkdirSync(paths.data, { recursive: true });
  const lines = ["# FreeApply's email login for reading employer replies. Only on this computer; delete it to remove it.",
    ...Object.entries(values).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)];
  const tmp = `${envPath()}.tmp`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, envPath());
  try {
    fs.chmodSync(envPath(), 0o600);
  } catch {
    // Windows keeps files in the user's own profile folder private by default.
  }
}

/** Google shows app passwords as four groups of four letters; spaces and dashes are dropped. */
export const cleanAppPassword = (p) => String(p || "").replace(/[\s-]+/g, "");

/** Checks an email login before it is saved: a plausible address, a host name, and nothing that could break the file. */
export function checkLogin({ address, password, host }) {
  const a = String(address || "").trim(), p = cleanAppPassword(password), h = String(host || GMAIL_HOST).trim().toLowerCase();
  if (!/^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/.test(a)) throw new Error("that doesn't look like an email address");
  if (!p) throw new Error("paste the app password");
  if (/[\r\n"]/.test(p) || p.length > 256) throw new Error("the app password has characters it can't have");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new Error("the mail server name looks wrong");
  if (h === GMAIL_HOST && !/^[a-z]{16}$/i.test(p)) throw new Error("a Google app password is 16 letters (Google shows it in four groups of four)");
  return { address: a, password: p, host: h };
}

export function saveEmailLogin(login) {
  const l = checkLogin(login);
  writeEnv({ ...readEnv(), [KEYS.address]: l.address, [KEYS.password]: l.password, [KEYS.host]: l.host });
  return emailStatus();
}

export function removeEmailLogin() {
  const env = readEnv();
  for (const k of Object.values(KEYS)) delete env[k];
  if (Object.keys(env).length) writeEnv(env);
  else fs.rmSync(envPath(), { force: true });
  return emailStatus();
}

/** What may be shown anywhere: whether a login is saved, for which address and server. Never the password. */
export function emailStatus() {
  const env = readEnv();
  const saved = Boolean(env[KEYS.address] && env[KEYS.password]);
  return { saved, address: saved ? env[KEYS.address] : "", host: saved ? env[KEYS.host] || GMAIL_HOST : "",
    gmail: saved && (env[KEYS.host] || GMAIL_HOST) === GMAIL_HOST };
}

/** The full login, for imap.js only. */
export function emailLogin() {
  const env = readEnv();
  if (!env[KEYS.address] || !env[KEYS.password]) return null;
  return { address: env[KEYS.address], password: env[KEYS.password], host: env[KEYS.host] || GMAIL_HOST };
}
