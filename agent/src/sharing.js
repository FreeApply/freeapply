// Legal acceptance and data sharing. Port of server/sharing.py.
// Everything is built and filtered here on the user's computer. The server only receives the whitelisted fields
// below, and only for choices that are on (regional defaults, see `defaults`). Talent Pool profiles use their own ID
// and secret so the server cannot join them to usage or job-market data.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import * as errorlog from "./errorlog.js";

export const OPERATOR = "MyBotsAI";
export const CONTACT_EMAIL = "mybotsai@gmail.com";
// Since 1.0.0 the legal documents carry the app version. Users accept again only when the text changes (LEGAL_HASH
// below), not on every release. Change EFFECTIVE_DATE whenever the text changes.
export const TERMS_VERSION = store.VERSION;
export const PRIVACY_VERSION = store.VERSION;
export const EFFECTIVE_DATE = "October 27, 2026";
// The deployed server (Contabo VPS behind Caddy). With this empty, nothing is ever sent.
export const DEFAULT_ENDPOINT = "https://www.mybotsai.com";
const ENDPOINT = () => (process.env.FREEAPPLY_SYNC_URL || DEFAULT_ENDPOINT).replace(/\/+$/, "");
export const endpoint = ENDPOINT;
const SYNC_EVERY_HOURS = 12;
const LEGAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "legal");
const LEGAL_DOCS = ["terms", "privacy", "disclosures", "recruiters"];
const CHOICES = ["usage_stats", "job_market", "talent_pool"];

/** Fingerprint of what the user accepts: every document's text and the values filled into it, except the version
 * number. Line endings are normalized so a checkout and an installed package agree. */
export const LEGAL_HASH = (() => {
  const h = crypto.createHash("sha256").update(JSON.stringify([OPERATOR, CONTACT_EMAIL, EFFECTIVE_DATE]));
  for (const name of LEGAL_DOCS) {
    h.update(`\n${name}\n`).update(fs.readFileSync(path.join(LEGAL_DIR, `${name}.html`), "utf8").replace(/\r\n/g, "\n"));
  }
  return h.digest("hex");
})();

export function renderDoc(name) {
  if (!LEGAL_DOCS.includes(name)) throw new Error("unknown document");
  let html = fs.readFileSync(path.join(LEGAL_DIR, `${name}.html`), "utf8");
  for (const [k, v] of Object.entries({ OPERATOR, CONTACT_EMAIL, TERMS_VERSION, PRIVACY_VERSION, EFFECTIVE_DATE })) {
    html = html.replaceAll(`{{${k}}}`, v);
  }
  return html;
}

const US_NAMES = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"]);

// IANA time zones of the 50 states and DC (territories excluded), plus the legacy US/* aliases.
const US_ZONE = /^(America\/(New_York|Detroit|Kentucky\/.+|Indiana\/.+|Chicago|Menominee|North_Dakota\/.+|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak)|Pacific\/Honolulu|US\/.+)$/;

export function systemLocale() {
  let locale = "", timeZone = "";
  try {
    ({ locale = "", timeZone = "" } = Intl.DateTimeFormat().resolvedOptions());
  } catch {
    // no Intl data: treated as outside the US
  }
  return { locale, timeZone, lang: `${process.env.LC_ALL || ""} ${process.env.LANG || ""}` };
}

/** "us" or "intl". The profile country wins. Otherwise the computer must say US twice, in its language setting
 * and its time zone, because many people outside the US use US English. Anything unclear counts as "intl" (strict). */
export function region(s = store.loadSettings(), sys = systemLocale()) {
  const c = (s.profile.country || "").trim().toLowerCase();
  if (c) return US_NAMES.has(c) ? "us" : "intl";
  const usLanguage = /[-_]US\b/i.test(`${sys.locale} ${sys.lang}`);
  return usLanguage && US_ZONE.test(sys.timeZone || "") ? "us" : "intl";
}

/** Sharing that applies when the user accepts the Terms (no prompt at setup). United States: usage stats and
 * job-market data on, disclosed in the agreement, opt out in Settings. Elsewhere, or with GPC: off. The Talent Pool
 * and update emails are off everywhere until the user turns them on. */
export function defaults(s, gpc = false) {
  const on = region(s) === "us" && !gpc;
  return { usage_stats: on, job_market: on, talent_pool: false };
}

export function consentStatus(s = store.loadSettings()) {
  const lg = s.legal;
  const accepted = lg.legal_hash === LEGAL_HASH && !!lg.age_confirmed;
  return { accepted, ok: accepted, terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION,
    accepted_at: lg.accepted_at, endpoint_configured: !!ENDPOINT(), region: region(s), defaults: defaults(s) };
}

/** Records acceptance of the current documents. Choices already made are kept; undecided ones get the regional
 * default. GPC always turns sharing off. */
export function accept(body, gpc = false) {
  if (body.accept_terms !== true || body.age_confirmed !== true) {
    throw new Error("You must confirm you are 18 or older and accept the Terms and Privacy Policy.");
  }
  const s = store.loadSettings(), d = defaults(s, gpc), sh = s.sharing;
  let choices = Object.fromEntries(CHOICES.map((c) => [c, typeof sh[c] === "boolean" ? sh[c] : d[c]]));
  if (gpc) choices = Object.fromEntries(CHOICES.map((c) => [c, false]));
  return store.saveSettings({
    legal: { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, legal_hash: LEGAL_HASH, accepted_at: store.now(),
      age_confirmed: true, region_at_acceptance: region(s), gpc_at_acceptance: gpc },
    sharing: { ...choices, decided_at: sh.decided_at || store.now(), last_sync_result: "choices changed" },
  });
}

export function updateChoices(body, gpc = false) {
  const patch = Object.fromEntries(CHOICES.filter((c) => typeof body[c] === "boolean").map((c) => [c, body[c]]));
  if (gpc) patch.talent_pool = false;
  if ("email_updates" in body) {
    patch.email_updates = !!body.email_updates;
    patch.updates_email = body.email_updates ? String(body.updates_email || "").trim() : "";
  }
  patch.decided_at = store.now();
  if ("job_market" in patch) patch.last_sync_result = "choices changed"; // forces the next sync to send every job
  return store.saveSettings({ sharing: patch });
}

// ───────────────────────────── payloads (whitelists) ─────────────────────────────

const annual = (amount, period) => (amount === null || amount === undefined || amount === "" ? null
  : Number(amount) * ({ hour: 2080, month: 12 }[period || "year"] || 1));
const band = (amount) => (amount === null ? null : Math.floor(amount / 10000) * 10000);
const cut = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : v ?? null);
const lower = (arr, n, w) => (arr || []).slice(0, n).map((x) => cut(String(x), w).toLowerCase());

function cleanUrl(u) {
  try {
    const x = new URL(u);
    return ["http:", "https:"].includes(x.protocol) ? `${x.protocol}//${x.host}${x.pathname}` : null;
  } catch {
    return null;
  }
}

function isoWeek(ts) {
  if (!ts) return null;
  const d = new Date(`${ts.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function days(a, b) {
  const x = Date.parse(`${(a || "").slice(0, 10)}T00:00:00Z`), y = Date.parse(`${(b || "").slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.max(0, Math.round((y - x) / 864e5));
}

export function usagePayload(s) {
  const st = store.stats(), t = s.targets;
  return { app_version: store.VERSION, os: { win32: "Windows", darwin: "Darwin", linux: "Linux" }[os.platform()] || os.platform(),
    counts: { tracked: st.tracked, applied: st.applied, responded: st.responded, interviews: st.interviews,
      offers: st.offers, rejections: st.rejections },
    response_rate: st.response_rate, by_status: st.by_status, by_outcome: st.by_outcome, by_method: st.by_method,
    features: { gmail_checks: !!s.gmail.enabled, easy_apply: !!s.automation.easy_apply_allowed, sources: s.automation.sources,
      autorun: !!s.autorun?.enabled },
    // Sponsored-card views and clicks per card id, counted on this computer (no user data).
    ads: JSON.parse(store.metaGet("ad_counts") || "{}"),
    targets: { roles: lower(t.desired_roles, 10, 80), fields: lower(t.fields, 10, 60), seniority: t.seniority,
      work_modes: t.work_modes, region: cut(s.profile.region, 40), country: cut(s.profile.country, 40),
      pay_floor_band: band(annual(t.min_pay, t.pay_period)) } };
}

/** Jobs changed since `since` (all jobs when null), whitelisted fields only. */
export function jobMarketPayload(s, since = null) {
  const iid = s.sharing.install_id;
  const q = "SELECT j.id, j.company, j.title, j.location, j.work_mode, j.pay_text, j.pay_min, j.pay_max, " +
    "j.url, j.apply_url, j.source, j.status, j.outcome, j.outcome_at, j.found_at, a.method, a.submitted_at " +
    "FROM jobs j LEFT JOIN applications a ON a.job_id=j.id";
  const rows = since ? store.all(`${q} WHERE coalesce(j.updated_at, j.found_at) > ?`, since) : store.all(q);
  return rows.map((r) => ({
    key: crypto.createHash("sha256").update(`${iid}:${r.id}`).digest("hex").slice(0, 20),
    company: cut(r.company, 120), title: cut(r.title, 160), location: cut(r.location, 120), work_mode: cut(r.work_mode, 20),
    pay_text: cut(r.pay_text, 60), pay_min: r.pay_min, pay_max: r.pay_max, posting_url: cut(cleanUrl(r.url), 300),
    ats: store.domainOf(r.apply_url || r.url) || null, source: cut(r.source, 30), method: r.method,
    status: r.status, outcome: r.outcome, applied_week: isoWeek(r.submitted_at), found_week: isoWeek(r.found_at),
    days_to_response: r.outcome ? days(r.submitted_at, r.outcome_at) : null,
  }));
}

export function talentPayload(s) {
  const p = s.profile, t = s.targets, r = s.resume, prof = r.profile || {};
  const lst = (v, n = 30, w = 80) => (v || []).slice(0, n).filter((x) => typeof x === "string").map((x) => cut(x, w));
  return { name: cut(p.full_name, 120), email: cut(p.email, 200),
    phone: s.sharing.talent_include_phone ? cut(p.phone, 40) : null,
    city: cut(p.city, 80), region: cut(p.region, 80), country: cut(p.country, 80),
    linkedin_url: cut(p.linkedin_url, 300), portfolio_url: cut(p.portfolio_url, 300),
    desired_roles: lst(t.desired_roles, 10), fields: lst(t.fields, 10), seniority: lst(t.seniority, 5),
    work_modes: lst(t.work_modes, 3), locations: lst(t.locations, 10), min_pay: t.min_pay, pay_period: t.pay_period,
    years_experience: s.eligibility.years_experience, headline: cut(prof.headline, 200), skills: lst(prof.skills, 60, 60),
    titles: lst(prof.titles, 15, 120), education: lst(prof.education, 10, 200), certifications: lst(prof.certifications, 20, 120),
    resume_text: cut(r.text || "", 30000) };
}

/** What the next anonymous sync would send: usage stats, job-market data and the integrity flag. Nothing identifying. */
export function buildPayload(s = store.loadSettings(), full = false) {
  const sh = s.sharing;
  const tamperAt = store.metaGet("tamper_detected_at");
  const body = { install_id: sh.install_id, install_secret: sh.install_secret, app_version: store.VERSION,
    consent: { terms_version: s.legal.terms_version, privacy_version: s.legal.privacy_version,
      usage_stats: sh.usage_stats === true, job_market: sh.job_market === true, decided_at: sh.decided_at },
    // Always sent with a sync (no personal data): lets the server set aside data from modified installs.
    integrity: { workflow_version: Number(store.metaGet("workflow_highest") || 0),
      tamper_detected: !!tamperAt && (!sh.last_sync || tamperAt > sh.last_sync) } };
  body.usage = sh.usage_stats === true ? usagePayload(s) : null;
  // Incremental after a successful sync, full otherwise; the server replaces everything on a full sync.
  const since = sh.last_sync_result === "ok" && !full ? sh.last_sync : null;
  body.jobs_full = since === null;
  body.jobs = sh.job_market === true ? jobMarketPayload(s, since) : null;
  return body;
}

/** Identifying data, under its own ID and only with consent. `profile` / `updates_email` are null when off, which
 * tells the server to delete them. */
export function buildTalent(s = store.loadSettings()) {
  const sh = s.sharing;
  return { talent_id: sh.talent_id, talent_secret: sh.talent_secret, terms_version: s.legal.terms_version,
    privacy_version: s.legal.privacy_version, profile: sh.talent_pool === true ? talentPayload(s) : null,
    updates_email: sh.email_updates ? sh.updates_email : null };
}

export function preview(s = store.loadSettings()) {
  const b = { ...buildPayload(s, true), install_secret: "(hidden)" };
  if (b.jobs) {
    b.jobs_count = b.jobs.length;
    b.jobs = b.jobs.slice(0, 3);
  }
  const t = { ...buildTalent(s), talent_secret: "(hidden)" };
  if (t.profile?.resume_text) t.profile = { ...t.profile, resume_text: `${t.profile.resume_text.slice(0, 400)}…` };
  return { analytics_request: b, "talent_pool_request (separate ID, not linked)": t };
}

// ───────────────────────────── transport ─────────────────────────────

async function request(pathname, body) {
  const r = await fetch(ENDPOINT() + pathname, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "User-Agent": `FreeApply/${store.VERSION}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) {
    const why = (await r.json().catch(() => ({}))).error;
    throw Object.assign(new Error(`HTTP ${r.status}${typeof why === "string" ? `: ${why.slice(0, 200)}` : ""}`), { status: r.status });
  }
  return r.json().catch(() => ({}));
}

export const PING_EVERY_MS = 5 * 60e3;

/** "Still running": only the anonymous installation ID, every 5 minutes while FreeApply runs and only while usage
 * statistics are on. It feeds the live user count on the website (totals only). */
export async function ping() {
  const s = store.loadSettings();
  if (!consentStatus(s).ok || !s.sharing.usage_stats || !ENDPOINT()) return { sent: false };
  try {
    await request("/v1/ping", { install_id: s.sharing.install_id });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

/** Sends the current payloads. A category that is off tells the server to delete it. */
export async function sync(force = false) {
  const s = store.loadSettings();
  if (!consentStatus(s).ok) return { sent: false, reason: "terms not accepted" };
  if (!ENDPOINT()) return { sent: false, reason: "no sync endpoint configured" };
  const last = s.sharing.last_sync;
  if (!force && last && s.sharing.last_sync_result === "ok" && Date.now() - Date.parse(last) < SYNC_EVERY_HOURS * 3600e3) {
    return { sent: false, reason: "synced recently", last_sync: last };
  }
  try {
    const res = { analytics: await request("/v1/sync", buildPayload(s)) };
    // The identifying request goes out only when the user opted in, or once more to delete after they opt out.
    const t = buildTalent(s);
    const wants = t.profile !== null || t.updates_email !== null;
    if (wants || s.sharing.talent_remote) res.talent = await request("/v1/talent", t);
    store.saveSettings({ sharing: { last_sync: store.now(), last_sync_result: "ok", talent_remote: wants } });
    return { sent: true, result: res };
  } catch (e) {
    store.saveSettings({ sharing: { last_sync_result: `error: ${e.message}` } });
    if (!errorlog.transient(e)) errorlog.record("sync", "sync", e);
    return { sent: false, reason: e.message };
  }
}

/** Deletes everything this computer shared (both identities), turns sharing off and starts fresh IDs. */
export async function deleteRemote() {
  const sh = store.loadSettings().sharing;
  const result = { deleted_remote: false };
  if (ENDPOINT()) {
    try {
      result.analytics = await request("/v1/delete", { install_id: sh.install_id, install_secret: sh.install_secret });
      result.talent = await request("/v1/talent", { talent_id: sh.talent_id, talent_secret: sh.talent_secret, profile: null, delete: true });
      result.deleted_remote = true;
    } catch (e) {
      result.error = e.message;
      if (!errorlog.transient(e)) errorlog.record("sync", "delete shared data", e);
      return result;
    }
  }
  store.saveSettings({ sharing: { usage_stats: false, job_market: false, talent_pool: false, email_updates: false,
    updates_email: "", install_id: crypto.randomUUID(), install_secret: crypto.randomBytes(32).toString("base64url"),
    talent_id: crypto.randomUUID(), talent_secret: crypto.randomBytes(32).toString("base64url"),
    last_sync: null, last_sync_result: "deleted", decided_at: store.now() } });
  result.new_ids = true;
  return result;
}

// ───────────────────────────── problem reports ─────────────────────────────

/** Exactly what Send posts for one problem report (errorlog.js). The installation ID lets "Delete my shared data"
 * remove reports too; the secret proves the report comes from this installation. */
export function errorReportPayload(r, s = store.loadSettings(), consentedAt = null) {
  return { install_id: s.sharing.install_id, install_secret: s.sharing.install_secret, consent: true,
    consented_at: consentedAt, report: errorlog.payload(r) };
}

/** The reports waiting in the dashboard, each with the payload Send would post (secret hidden). */
export function errorReports(s = store.loadSettings()) {
  return { endpoint_configured: !!ENDPOINT(), reports: errorlog.list().map((r) => ({ id: r.id, kind: r.kind, source: r.source,
    message: r.message, count: r.count || 1, first_at: r.first_at, last_at: r.last_at,
    payload: { ...errorReportPayload(r, s, "(the time you press Send)"), install_secret: "(hidden)" } })) };
}

/** Sends one report, and only with the user's consent: the dashboard passes consent: true from the report's own
 * checkbox. Nothing calls this on its own. A sent report leaves the local log. */
export async function sendErrorReport(id, consent) {
  if (consent !== true) throw new Error("Tick “I agree to share this report with FreeApply” before sending.");
  const s = store.loadSettings();
  if (!consentStatus(s).ok) throw new Error("Accept the current Terms and Privacy Policy first.");
  const r = errorlog.get(id);
  if (!r) throw new Error("This report is no longer there.");
  if (!ENDPOINT()) return { sent: false, reason: "no server configured" };
  try {
    await request("/v1/errors", errorReportPayload(r, s, new Date().toISOString().replace(/\.\d+Z$/, "Z")));
  } catch (e) {
    const reason = e.status === 429 ? "You sent several reports in a row. Try this one again in an hour."
      : errorlog.transient(e) ? "FreeApply's server could not be reached. Try again later." : e.message;
    return { sent: false, reason };
  }
  errorlog.remove(id);
  return { sent: true };
}
