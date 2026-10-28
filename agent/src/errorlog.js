// Problem reports: a small local log of things that went wrong, in the data folder (errors.json). Nothing here is ever
// sent on its own. The dashboard shows each report exactly as it would be sent, and only the user can send one, after
// ticking its consent box (sharing.sendErrorReport). Personal data is stripped before anything is written, so the log
// holds only the app and workflow versions, what failed, the error message and a shortened stack.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";

export const KINDS = ["tool", "dashboard", "crash", "update", "sync"];
const MAX_REPORTS = 30;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_FRAMES = 15;
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const file = () => (store.paths.data ? path.join(store.paths.data, "errors.json") : null);

function read() {
  try {
    const r = JSON.parse(fs.readFileSync(file(), "utf8")).reports;
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

function write(reports) {
  const f = file(), tmp = `${f}.tmp`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ reports }, null, 1));
  fs.renameSync(tmp, f);
}

/** Deliberate refusals (a hard rule, a bad argument, a missing job) are answers, not problems; a network that is down
 * is not FreeApply's fault and could not be reported anyway. What remains: programming errors and system errors. */
export function unexpected(e) {
  if (!(e instanceof Error)) return true;
  if (transient(e)) return false;
  if (e.code) return typeof e.code === "string"; // ENOENT, EACCES, ERR_SQLITE_ERROR ...; numeric codes are protocol answers
  return [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError].some((c) => e instanceof c);
}

/** Failures of the connection rather than of FreeApply: offline, timed out, or the server busy for a moment. */
export function transient(e) {
  return ["AbortError", "TimeoutError"].includes(e?.name) || /^fetch failed$/.test(e?.message || "") || [429, 502, 503, 504].includes(e?.status);
}

// ───────────────────────────── redaction ─────────────────────────────

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Values on this computer that must never appear in a report: the user's names, contact details, links, resume text,
 * the account name and the sharing secrets. Each is [value, tag, regex flags]; parts of a name match only as written
 * ("Will", not "will"), everything else in any case. */
function personal(s) {
  const p = s?.profile || {}, sh = s?.sharing || {};
  const words = [];
  const add = (v, tag, flags = "giu") => {
    if (typeof v === "string" && v.trim().length >= 3) words.push([v.trim(), tag, flags]);
  };
  const name = String(p.full_name || "").trim(), parts = name.split(/\s+/).filter(Boolean);
  // The whole name and first + last, also as written in a link or file name ("dana-okafor", "dana_okafor").
  for (const n of new Set([parts.join(" "), parts.length > 2 ? `${parts[0]} ${parts.at(-1)}` : ""])) {
    for (const sep of [" ", "-", "_", ".", ""]) add(n.replace(/ /g, sep), "[name]");
  }
  for (const part of parts) add(part, "[name]", "gu");
  for (const v of [p.email, sh.updates_email]) add(v, "[email]");
  add(p.phone, "[phone]");
  for (const v of [p.linkedin_url, p.portfolio_url]) {
    add(v, "[link]");
    add(String(v || "").replace(/^[a-z]+:\/\/(www\.)?/i, "").replace(/\/+$/, ""), "[link]");
  }
  for (const v of [p.street, p.address, p.postal_code, p.zip]) add(v, "[address]");
  for (const v of [sh.install_secret, sh.talent_secret]) add(v, "[secret]");
  try {
    add(os.userInfo().username, "[user]");
  } catch {
    // no account name available
  }
  // Resume text: every line long enough to be specific to this person.
  for (const line of String(s?.resume?.text || "").split(/\r?\n/)) {
    if (line.trim().length >= 20) words.push([line.trim(), "[resume text]", "giu"]);
  }
  return words.sort((a, b) => b[0].length - a[0].length).slice(0, 400);
}

const HOME_PATH = /([A-Za-z]:(?:\\\\|\\|\/)(?:Users|Documents and Settings)(?:\\\\|\\|\/))[^\\/:*?"<>|\s]+|(\/(?:Users|home)\/)[^/\s:]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>`]*)[?#][^\s"'<>`]*/gi;
const PHONE = /(?<![\w.:/-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?![\w.:/-])|(?<![\w.:/-])\d{10,11}(?![\w.:/-])/g;
const SECRET = /\b(Bearer\s+)[\w.~+/=-]+|\b((?:access_?|refresh_?|id_?)?token|secret|password|passwd|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
const LONG_QUOTE = /(["'“‘])[^"'“”‘’\n]{60,}(["'”’])/g;

/** Strips personal data from text: known personal values, the home folder, emails, phone numbers, URL query strings,
 * tokens and long quoted text (which is usually echoed input, such as a cover letter). */
export function redact(text, s = safeSettings()) {
  let t = String(text ?? "");
  // Folders first: the account name inside a path would otherwise be taken for the user's name.
  const paths = [[APP, "<app>"], [store.paths.data, "<data>"], [os.homedir(), "~"]].filter(([p]) => p && p.length > 3);
  for (const [p, tag] of paths) {
    for (const form of new Set([p, p.replace(/\\/g, "/"), p.replace(/\\/g, "\\\\")])) t = t.replace(new RegExp(esc(form), "gi"), tag);
  }
  t = t.replace(/file:\/\/\/?(?=<app>|<data>|~)/g, "").replace(HOME_PATH, (m, win, nix) => `${win || nix}[user]`);
  for (const [v, tag, flags] of personal(s)) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(v)}(?![\\p{L}\\p{N}])`, flags), tag);
  return t.replace(URL_QUERY, "$1")
    .replace(EMAIL, "[email]")
    .replace(SECRET, (m, bearer, key, sep) => (bearer ? `${bearer}[secret]` : `${key}${sep}[secret]`))
    .replace(PHONE, "[phone]")
    .replace(LONG_QUOTE, "$1[text]$2");
}

function safeSettings() {
  try {
    return store.loadSettings();
  } catch {
    return {};
  }
}

const cutTo = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** The stack without the message line repeated, at most MAX_FRAMES frames, redacted. */
function stackOf(e, s) {
  const lines = String(e?.stack || "").split("\n").filter((l) => /^\s+at /.test(l)).slice(0, MAX_FRAMES);
  return cutTo(redact(lines.map((l) => l.trim()).join("\n"), s), MAX_STACK);
}

function messageOf(e) {
  if (e instanceof Error) return `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}${e.code && typeof e.code === "string" ? ` (${e.code})` : ""}`;
  return typeof e === "string" ? e : JSON.stringify(e) ?? String(e);
}

function workflowVersion() {
  try {
    return Number(store.metaGet("workflow_highest") || 0);
  } catch {
    return 0;
  }
}

// ───────────────────────────── the log ─────────────────────────────

/**
 * Records one problem. `kind` is one of KINDS, `source` says what failed (a tool name, a dashboard request, ...).
 * The same problem again only counts up. Never throws: logging must not turn one failure into two.
 */
export function record(kind, source, error) {
  try {
    if (!file()) return null;
    const s = safeSettings();
    const r = { kind: KINDS.includes(kind) ? kind : "other", source: cutTo(redact(source, s), 120),
      message: cutTo(redact(messageOf(error), s), MAX_MESSAGE), stack: stackOf(error, s),
      app_version: store.VERSION, workflow_version: workflowVersion() };
    const key = crypto.createHash("sha256").update([r.kind, r.source, r.message, r.stack.split("\n")[0]].join("|")).digest("hex").slice(0, 16);
    const reports = read(), at = new Date().toISOString();
    const same = reports.find((x) => x.key === key);
    if (same) Object.assign(same, { count: (same.count || 1) + 1, last_at: at, app_version: r.app_version, workflow_version: r.workflow_version });
    else reports.push({ id: crypto.randomBytes(6).toString("hex"), key, ...r, count: 1, first_at: at, last_at: at });
    reports.sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
    write(reports.slice(0, MAX_REPORTS));
    return same?.id || reports.find((x) => x.key === key)?.id || null;
  } catch {
    return null;
  }
}

export const list = () => read();
export const get = (id) => read().find((r) => r.id === id) || null;

/** Throws a report away (Dismiss, or after it was sent). */
export function remove(id) {
  const reports = read(), kept = reports.filter((r) => r.id !== id);
  if (kept.length !== reports.length) write(kept);
  return { removed: kept.length !== reports.length };
}

/** The report part of what Send posts: nothing but these fields leaves the computer. */
export function payload(r) {
  return { app_version: r.app_version, workflow_version: r.workflow_version, kind: r.kind, source: r.source,
    message: r.message, stack: r.stack, occurrences: r.count || 1 };
}
