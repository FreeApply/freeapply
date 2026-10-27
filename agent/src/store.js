// FreeApply store: data folder, settings, SQLite database and stats. Port of server/core.py.
// The schema is a superset of the original job-agent `jobagent.py` schema, so an existing `jobs.db` works as is.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const VERSION = "1.0.0";

// Pipeline status of a job (what the agent did). Outcome (what the employer did) is separate.
export const STATUSES = {
  found: "qualified, not yet worked",
  ready: "documents prepared, not yet submitted",
  applied: "application submitted",
  skipped: "filtered out (see status_note)",
  needs_info: "a form asked something the profile does not answer",
  needs_account: "employer site requires creating an account",
  blocked: "CAPTCHA, verification code or site warning",
  failed: "error while applying",
};
export const OUTCOMES = {
  acknowledged: "automatic 'we received your application' email",
  replied: "a person replied",
  assessment: "test, assignment or screening questionnaire",
  interview: "interview requested or scheduled",
  rejected: "rejection",
  offer: "offer",
  withdrawn: "candidate withdrew",
};
// Outcomes that count as a real response (not an auto-acknowledgement).
export const RESPONSE_OUTCOMES = ["replied", "assessment", "interview", "rejected", "offer"];
const OUTCOME_RANK = { acknowledged: 1, replied: 2, assessment: 3, rejected: 3, interview: 4, offer: 5, withdrawn: 0 };
export const QTYPES = ["text", "textarea", "yesno", "choice", "multi", "number", "date"];
export const ISSUE_STATUSES = ["needs_info", "needs_account", "blocked"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linkedin_job_id TEXT UNIQUE,
  title TEXT, company TEXT, location TEXT, work_mode TEXT,
  pay_text TEXT, pay_min INTEGER, pay_max INTEGER,
  url TEXT, apply_url TEXT, description TEXT,
  fit_score INTEGER, fit_notes TEXT,
  status TEXT DEFAULT 'found', status_note TEXT,
  found_at TEXT, updated_at TEXT, run_id INTEGER
);
CREATE TABLE IF NOT EXISTS companies (
  name TEXT PRIMARY KEY, analysis_json TEXT, analyzed_at TEXT
);
CREATE TABLE IF NOT EXISTS applications (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
  resume_path TEXT, resume_json TEXT,
  cover_path TEXT, cover_text TEXT,
  method TEXT, answers_json TEXT,
  submitted_at TEXT, confirmation TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, ended_at TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id),
  company TEXT, gmail_message_id TEXT UNIQUE, gmail_thread_id TEXT,
  sender TEXT, subject TEXT, received_at TEXT,
  kind TEXT, summary TEXT, mail_action TEXT, recorded_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS job_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id),
  label TEXT NOT NULL, qtype TEXT DEFAULT 'text', options_json TEXT, required INTEGER DEFAULT 1,
  answer TEXT, answered_at TEXT, created_at TEXT
);
-- Employer sites where the user created an account themselves. Passwords are never stored here;
-- the user's browser or password manager keeps them.
CREATE TABLE IF NOT EXISTS site_accounts (
  domain TEXT PRIMARY KEY, email_used TEXT, created_at TEXT, job_id INTEGER, note TEXT
);
`;
// Columns added on top of the original schema (added in place to old databases).
const EXTRA_JOB_COLUMNS = { source: "TEXT", outcome: "TEXT", outcome_at: "TEXT", external_id: "TEXT" };

const DEFAULT_SETTINGS = {
  profile: { full_name: "", email: "", phone: "", city: "", region: "", country: "", linkedin_url: "", portfolio_url: "" },
  targets: { desired_roles: [], fields: [], seniority: [], keywords: [], exclude_keywords: [],
    min_pay: null, pay_period: "year", currency: "USD",
    locations: [], work_modes: ["onsite", "hybrid", "remote"],
    willing_to_relocate: false, max_commute_miles: null },
  eligibility: { work_authorized: null, needs_sponsorship: null, clearance: "none",
    earliest_start: "Immediately", years_experience: null },
  // profile: structured summary the AI assistant extracts (headline, skills, titles, education, certifications).
  resume: { files: [], primary: "", text: "", profile: {} },
  // sources: job sites from JOB_SITES the agent may use. signed_in: {site id: when the user confirmed they signed in
  // themselves in the browser the agent uses}. signed_out: {site id: when the agent found itself signed out}.
  // FreeApply never asks for or stores passwords.
  automation: { sources: ["linkedin", "company_sites"], signed_in: {}, signed_out: {}, site_paused_until: {}, easy_apply_allowed: false,
    fit_threshold: 60, rate_per_minute: 3, daily_cap: null },
  // Unattended runs on a schedule. Only the user changes these (dashboard); the agent reports schedule changes
  // through freeapply_autorun. Budgets are per run; the daily cap above still applies.
  autorun: { enabled: false, every_hours: 1, max_minutes: 50, max_applications: null, schedule_created: false },
  onboarding: { completed_at: null, dismissed_at: null },
  // Answers the user gave on the Issues tab and chose to reuse: {normalized question: answer}.
  custom_answers: {},
  gmail: { enabled: true, interval_hours: 4, action: "star", label_name: "Job Replies",
    count_acknowledgements: false, last_check: null, schedule_created: false },
  // Acceptance of the legal documents in web/legal: the versions accepted and the text fingerprint (sharing.js).
  legal: { terms_version: null, privacy_version: null, legal_hash: null, accepted_at: null, age_confirmed: false },
  // Each sharing choice is null until decided; nothing is sent while a choice is not true.
  sharing: { usage_stats: null, job_market: null, talent_pool: null, talent_include_phone: false,
    email_updates: false, updates_email: "", decided_at: null, install_id: "", install_secret: "",
    last_sync: null, last_sync_result: null },
  setup_complete: false,
};

// Job sites the user can let the agent search and apply on. Sites with signin: the user signs in once, themselves,
// in the browser the agent uses; the agent then works in that session and stops if the site signs them out.
export const JOB_SITES = [
  { id: "linkedin", name: "LinkedIn", url: "https://www.linkedin.com/login", signin: true, note: "Listings and Easy Apply", hosts: ["linkedin.com"] },
  { id: "indeed", name: "Indeed", url: "https://www.indeed.com/", signin: true, note: "Listings and Indeed Apply", hosts: ["indeed.com"] },
  { id: "glassdoor", name: "Glassdoor", url: "https://www.glassdoor.com/", signin: true, note: "Listings and company reviews", hosts: ["glassdoor.com"] },
  { id: "ziprecruiter", name: "ZipRecruiter", url: "https://www.ziprecruiter.com/", signin: true, note: "1-click apply", hosts: ["ziprecruiter.com"] },
  { id: "dice", name: "Dice", url: "https://www.dice.com/", signin: true, note: "Tech jobs", hosts: ["dice.com"] },
  { id: "wellfound", name: "Wellfound", url: "https://wellfound.com/", signin: true, note: "Startup jobs", hosts: ["wellfound.com", "angel.co"] },
  { id: "handshake", name: "Handshake", url: "https://app.joinhandshake.com/", signin: true, note: "Students and new grads", hosts: ["joinhandshake.com"] },
  { id: "company_sites", name: "Company career sites", url: null, signin: false,
    note: "Employer pages and forms like Greenhouse, Lever and Ashby; no sign-in needed",
    hosts: ["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "breezy.hr", "myworkdayjobs.com"] },
];
const SOURCE_ALIASES = { company_site: "company_sites", employer: "company_sites", career_site: "company_sites", greenhouse: "company_sites",
  lever: "company_sites", ashby: "company_sites", workday: "company_sites", workable: "company_sites", smartrecruiters: "company_sites", breezy: "company_sites" };

/** Which JOB_SITES entry a job came from, by its source name or else its links. null when it cannot tell. */
export function siteOf(j) {
  const src = String(j.source || "").toLowerCase().trim();
  const id = SOURCE_ALIASES[src] || src;
  if (JOB_SITES.some((s) => s.id === id)) return id;
  for (const u of [j.url, j.apply_url]) {
    const host = domainOf(u || "");
    const site = host && JOB_SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
    if (site) return site.id;
  }
  return null;
}

/** What the agent may report about a job site: it was signed out (the user signs in again and re-confirms in the
 * dashboard), or the site's own daily limit was reached (paused until tomorrow). It can never mark a site ready. */
export function markSite(site, status) {
  const s = loadSettings();
  if (!(s.automation.sources || []).includes(site)) throw new Error(`${site} is not one of the user's job sites`);
  if (status === "signed_out") return saveSettings({ automation: { signed_out: { [site]: now() } } });
  if (status === "limit_reached") {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    return saveSettings({ automation: { site_paused_until: { [site]: now(midnight) } } });
  }
  throw new Error("status must be signed_out or limit_reached");
}

/** The user's chosen sites and whether the agent can use each one right now. */
export function siteReadiness(s = loadSettings()) {
  const a = s.automation, t = now();
  return JOB_SITES.filter((x) => (a.sources || []).includes(x.id)).map((x) => {
    const signedOut = a.signed_out?.[x.id] || null, pausedUntil = a.site_paused_until?.[x.id] > t ? a.site_paused_until[x.id] : null;
    const ready = (!x.signin || (!!a.signed_in?.[x.id] && !signedOut)) && !pausedUntil;
    return { id: x.id, name: x.name, ready, ...(signedOut ? { signed_out_at: signedOut } : {}),
      ...(x.signin && !a.signed_in?.[x.id] ? { needs: "user to sign in and confirm in Settings → Job sites" } : {}),
      ...(pausedUntil ? { paused_until: pausedUntil } : {}) };
  });
}

// What first-run setup must collect before the agent applies anywhere.
const REQUIRED_FIELDS = [
  ["profile.full_name", "Full name"],
  ["profile.email", "Email"],
  ["targets.desired_roles", "Desired roles"],
  ["targets.min_pay", "Minimum pay (0 for no floor)"],
  ["targets.locations", "Locations (or 'Remote')"],
  ["eligibility.work_authorized", "Work authorization"],
  ["resume.primary", "Resume upload"],
];

// ───────────────────────────── paths ─────────────────────────────

export const paths = {};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "") || "{}");
  } catch {
    return null;
  }
}

/** Resolves the data folder, database and port: arguments, then environment, then ~/.freeapply/config.json. */
export function init(opts = {}) {
  const home = (p) => (p ? path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir())) : null);
  const data = home(opts.data || process.env.FREEAPPLY_DATA) || path.join(os.homedir(), ".freeapply");
  const config = readJson(path.join(data, "config.json")) || {};
  Object.assign(paths, {
    data, settings: path.join(data, "settings.json"), resumes: path.join(data, "resumes"),
    db: home(opts.db || process.env.FREEAPPLY_DB || config.db) || path.join(data, "jobs.db"),
    port: Number(opts.port || process.env.FREEAPPLY_PORT || 7878),
  });
  if (_db) {
    _db.close();
    _db = null;
  }
  _firstRun = null;
  return paths;
}

// ───────────────────────────── small helpers ─────────────────────────────

const pad = (n) => String(n).padStart(2, "0");
/** Local time without zone, seconds precision, like Python's datetime.now().isoformat(timespec="seconds"). */
export function now(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const today = (d = new Date()) => now(d).slice(0, 10);
export const daysAgo = (n) => today(new Date(Date.now() - n * 864e5));
export const slug = (s, n = 40) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "x";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// SQLite parameters: undefined is not bindable, booleans become 1/0.
const p = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);

// ───────────────────────────── settings ─────────────────────────────

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

export function get(obj, dotted) {
  return dotted.split(".").reduce((d, k) => (isObj(d) ? d[k] : undefined), obj);
}

export function loadSettings() {
  fs.mkdirSync(paths.data, { recursive: true });
  return merge(structuredClone(DEFAULT_SETTINGS), readJson(paths.settings) || {});
}

export function missingFields(s = loadSettings()) {
  return REQUIRED_FIELDS.filter(([key]) => {
    const v = get(s, key);
    return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  }).map(([key, label]) => ({ key, label }));
}

/** Settings without the installation secrets, for display. */
export function publicSettings(s) {
  const { install_secret, talent_secret, ...sharing } = s.sharing;
  return { ...s, sharing };
}

/** Deep-merges `patch` into settings.json and recomputes setup_complete. */
export function saveSettings(patch) {
  const s = merge(loadSettings(), patch || {});
  s.setup_complete = !missingFields(s).length;
  const tmp = `${paths.settings}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, paths.settings);
  return s;
}

export function saveResume(filename, data, text = "") {
  fs.mkdirSync(paths.resumes, { recursive: true });
  const base = path.basename(filename || "resume.pdf");
  const ext = path.extname(base).toLowerCase();
  if (![".pdf", ".docx", ".doc", ".txt", ".md", ".rtf"].includes(ext)) throw new Error("resume must be .pdf, .docx, .doc, .txt, .md or .rtf");
  const file = path.join(paths.resumes, `${slug(path.basename(base, path.extname(base)))}${ext}`);
  fs.writeFileSync(file, data);
  if (!text && [".txt", ".md"].includes(ext)) text = Buffer.from(data).toString("utf8");
  const s = loadSettings();
  const files = s.resume.files.filter((f) => f.path !== file);
  files.push({ name: path.basename(file), path: file, uploaded_at: now(), bytes: data.length });
  return saveSettings({ resume: { files, primary: file, text: text || s.resume.text } });
}

// ───────────────────────────── database ─────────────────────────────

let _db = null;

export function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(paths.db), { recursive: true });
  // Foreign keys off, like Python's sqlite3, so old rows that point at missing jobs still load.
  const con = new DatabaseSync(paths.db, { enableForeignKeyConstraints: false });
  con.exec("PRAGMA busy_timeout = 15000");
  con.exec(SCHEMA);
  const have = new Set(con.prepare("PRAGMA table_info(jobs)").all().map((r) => r.name));
  for (const [col, typ] of Object.entries(EXTRA_JOB_COLUMNS)) if (!have.has(col)) con.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${typ}`);
  _db = con;
  return con;
}

export const all = (sql, ...args) => db().prepare(sql).all(...args.map(p)).map((r) => ({ ...r }));
export const one = (sql, ...args) => {
  const r = db().prepare(sql).get(...args.map(p));
  return r ? { ...r } : null;
};
export const run = (sql, ...args) => db().prepare(sql).run(...args.map(p));
const scalar = (sql, ...args) => {
  const r = one(sql, ...args);
  return r ? Object.values(r)[0] : null;
};

export function metaGet(key) {
  return one("SELECT value FROM meta WHERE key=?", key)?.value ?? null;
}
export function metaSet(key, value) {
  run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value));
}

/** What the workflow guard remembers between runs: newest accepted bundle version and tamper events. */
export const integrityMemory = {
  highestVersion: () => Number(metaGet("workflow_highest") || 0),
  setHighestVersion: (v) => metaSet("workflow_highest", v),
  recordTamper(what) {
    const log = JSON.parse(metaGet("tamper_log") || "[]");
    log.push({ what, at: now() });
    metaSet("tamper_log", JSON.stringify(log.slice(-20)));
    metaSet("tamper_detected_at", now());
  },
};

let _firstRun = null;

/** First-run install: data folder, database and settings file. Safe to call on every start. */
export function bootstrap() {
  if (_firstRun === null) _firstRun = !fs.existsSync(paths.settings);
  let s = loadSettings();
  const sh = s.sharing;
  if (_firstRun || !sh.install_id || !sh.talent_id) {
    // Two unrelated identities: one for usage/job-market data, one for the Talent Pool profile.
    s = saveSettings({ sharing: { install_id: sh.install_id || crypto.randomUUID(),
      install_secret: sh.install_secret || crypto.randomBytes(32).toString("base64url"),
      talent_id: sh.talent_id || crypto.randomUUID(),
      talent_secret: sh.talent_secret || crypto.randomBytes(32).toString("base64url") } });
  }
  run("INSERT OR IGNORE INTO meta (key, value) VALUES ('installed_at', ?)", now());
  return { first_run: _firstRun, data_dir: paths.data, db: paths.db, setup_complete: !missingFields(s).length, missing: missingFields(s) };
}

export function findDuplicates(company, title, externalId) {
  const rows = [];
  if (externalId) rows.push(...all("SELECT id, title, company, status FROM jobs WHERE linkedin_job_id=? OR external_id=?", externalId, externalId));
  if (company) rows.push(...all("SELECT id, title, company, status FROM jobs WHERE lower(company)=lower(?)", company));
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id))
    .map((r) => ({ ...r, same_title: !!title && (r.title || "").toLowerCase() === title.toLowerCase() }));
}

const JOB_COLS = ["linkedin_job_id", "external_id", "source", "title", "company", "location", "work_mode", "pay_text",
  "pay_min", "pay_max", "url", "apply_url", "description", "fit_score", "fit_notes", "status", "status_note", "run_id"];

export function addJob(j) {
  const ext = j.external_id || j.linkedin_job_id;
  if (ext) {
    const row = one("SELECT id FROM jobs WHERE linkedin_job_id=? OR external_id=?", ext, ext);
    if (row) return { job_id: row.id, existing: true };
  }
  const vals = JOB_COLS.map((c) => (c === "status" ? j.status || "found" : j[c] ?? null));
  const r = run(`INSERT INTO jobs (${JOB_COLS.join(",")}, found_at, updated_at) VALUES (${JOB_COLS.map(() => "?").join(",")},?,?)`,
    ...vals, now(), now());
  return { job_id: Number(r.lastInsertRowid), existing: false };
}

export function getJob(jobId) {
  return one("SELECT j.*, a.method, a.submitted_at FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.id=?", jobId);
}

export function setStatus(jobId, status, { note, method, confirmation, resumePath, coverPath, coverText } = {}) {
  if (!STATUSES[status]) throw new Error(`status must be one of ${Object.keys(STATUSES).sort().join(", ")}`);
  if (!one("SELECT 1 AS x FROM jobs WHERE id=?", jobId)) throw new Error(`no job ${jobId}`);
  run("UPDATE jobs SET status=?, status_note=coalesce(?,status_note), updated_at=? WHERE id=?", status, note, now(), jobId);
  run("INSERT INTO applications (job_id) VALUES (?) ON CONFLICT(job_id) DO NOTHING", jobId);
  if (resumePath || coverPath || coverText) {
    run("UPDATE applications SET resume_path=coalesce(?,resume_path), cover_path=coalesce(?,cover_path), " +
      "cover_text=coalesce(?,cover_text) WHERE job_id=?", resumePath, coverPath, coverText, jobId);
  }
  if (status === "applied") {
    run("UPDATE applications SET method=coalesce(?,method), submitted_at=coalesce(submitted_at,?), " +
      "confirmation=coalesce(?,confirmation) WHERE job_id=?", method, now(), confirmation, jobId);
  }
  return { job_id: jobId, status };
}

export function setOutcome(jobId, outcome) {
  if (outcome && !OUTCOMES[outcome]) throw new Error(`outcome must be one of ${Object.keys(OUTCOMES).sort().join(", ")}`);
  run("UPDATE jobs SET outcome=?, outcome_at=?, updated_at=? WHERE id=?", outcome || null, outcome ? now() : null, now(), jobId);
  return { job_id: jobId, outcome };
}

/** Stores one employer email and raises the job's outcome if this reply ranks higher. */
export function recordReply(r) {
  const kind = r.kind || "replied";
  if (!OUTCOMES[kind]) throw new Error(`kind must be one of ${Object.keys(OUTCOMES).sort().join(", ")}`);
  run("INSERT OR IGNORE INTO replies (job_id, company, gmail_message_id, gmail_thread_id, sender, subject, " +
    "received_at, kind, summary, mail_action, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    r.job_id, r.company, r.gmail_message_id, r.gmail_thread_id, r.sender, r.subject, r.received_at, kind, r.summary, r.mail_action, now());
  if (r.job_id) {
    const cur = one("SELECT outcome FROM jobs WHERE id=?", r.job_id);
    if (cur && (OUTCOME_RANK[kind] ?? 0) >= (OUTCOME_RANK[cur.outcome || ""] ?? -1)) {
      run("UPDATE jobs SET outcome=?, outcome_at=?, updated_at=? WHERE id=?", kind, r.received_at || now(), now(), r.job_id);
    }
  }
  return { recorded: true, kind };
}

/** What the Gmail reply check needs: applied companies, the time window and the mail action. */
export function replyCheckPlan() {
  const s = loadSettings();
  const rows = all("SELECT j.id, j.company, j.title, a.submitted_at FROM jobs j JOIN applications a ON a.job_id=j.id " +
    "WHERE j.status='applied' ORDER BY a.submitted_at DESC");
  const known = all("SELECT gmail_message_id FROM replies WHERE gmail_message_id IS NOT NULL").map((r) => r.gmail_message_id);
  let since = s.gmail.last_check;
  if (!since && rows.length) since = rows.map((r) => r.submitted_at || now()).sort()[0];
  return { since, gmail: s.gmail, applied: rows, known_message_ids: known.slice(-500) };
}

export const markReplyCheckDone = () => saveSettings({ gmail: { last_check: now() } });

/** Submissions in the last minute for a method and today overall (rules.js turns this into a clearance). */
export function throttleCounts(method) {
  const cutoff = now(new Date(Date.now() - 60_000));
  return {
    last_minute: scalar("SELECT count(*) FROM applications WHERE method=? AND submitted_at>?", method, cutoff),
    today: scalar("SELECT count(*) FROM applications WHERE submitted_at>=?", today()),
  };
}

// ───────────────────────────── reads for the dashboard ─────────────────────────────

export function listJobs(status, outcome, search, limit = 2000) {
  let q = "SELECT j.id, j.title, j.company, j.location, j.work_mode, j.pay_text, j.pay_min, j.pay_max, j.url, " +
    "j.apply_url, j.fit_score, j.status, j.status_note, j.outcome, j.outcome_at, j.source, j.found_at, " +
    "j.updated_at, a.method, a.submitted_at, a.confirmation, a.resume_path, a.cover_path, " +
    "(SELECT count(*) FROM replies r WHERE r.job_id=j.id) AS reply_count " +
    "FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE 1=1";
  const args = [];
  if (status) (q += " AND j.status=?"), args.push(status);
  if (outcome) (q += " AND j.outcome=?"), args.push(outcome);
  if (search) (q += " AND (j.title LIKE ? OR j.company LIKE ? OR j.location LIKE ?)"), args.push(...Array(3).fill(`%${search}%`));
  q += " ORDER BY coalesce(a.submitted_at, j.updated_at, j.found_at) DESC LIMIT ?";
  return all(q, ...args, Number(limit) || 2000);
}

export function listReplies(limit = 500) {
  return all("SELECT r.*, j.title FROM replies r LEFT JOIN jobs j ON j.id=r.job_id " +
    "ORDER BY coalesce(r.received_at, r.recorded_at) DESC LIMIT ?", limit);
}

export function stats() {
  const applied = scalar("SELECT count(*) FROM jobs WHERE status='applied'");
  const responded = scalar(`SELECT count(*) FROM jobs WHERE outcome IN (${RESPONSE_OUTCOMES.map(() => "?").join(",")})`, ...RESPONSE_OUTCOMES);
  const byStatus = Object.fromEntries(all("SELECT status, count(*) AS n FROM jobs GROUP BY status").map((r) => [r.status, r.n]));
  const byOutcome = Object.fromEntries(all("SELECT outcome, count(*) AS n FROM jobs WHERE outcome IS NOT NULL GROUP BY outcome").map((r) => [r.outcome, r.n]));
  const start = new Date(Date.now() - 29 * 864e5);
  const perDay = Object.fromEntries(all("SELECT substr(submitted_at,1,10) AS d, count(*) AS n FROM applications WHERE submitted_at>=? GROUP BY 1",
    today(start)).map((r) => [r.d, r.n]));
  const daily = Array.from({ length: 30 }, (_, i) => {
    const d = today(new Date(start.getTime() + i * 864e5));
    return { date: d, count: perDay[d] || 0 };
  });
  const byMethod = Object.fromEntries(all("SELECT a.method, count(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id " +
    "WHERE j.status='applied' GROUP BY a.method").map((r) => [r.method || "unknown", r.n]));
  const s = loadSettings();
  return {
    applied,
    applied_7d: scalar("SELECT count(*) FROM applications WHERE submitted_at>=?", daysAgo(6)),
    applied_today: scalar("SELECT count(*) FROM applications WHERE submitted_at>=?", today()),
    acknowledged: byOutcome.acknowledged || 0,
    responded,
    interviews: byOutcome.interview || 0,
    offers: byOutcome.offer || 0,
    rejections: byOutcome.rejected || 0,
    response_rate: applied ? Math.round((1000 * responded) / applied) / 10 : 0,
    tracked: scalar("SELECT count(*) FROM jobs"),
    needs_you: ISSUE_STATUSES.reduce((n, k) => n + (byStatus[k] || 0), 0),
    queued: (byStatus.found || 0) + (byStatus.ready || 0),
    avg_fit: scalar("SELECT round(avg(fit_score),1) FROM jobs WHERE status='applied'"),
    by_status: byStatus, by_outcome: byOutcome, by_method: byMethod, daily,
    top_companies: all("SELECT company, count(*) AS n FROM jobs WHERE status='applied' GROUP BY lower(company) ORDER BY n DESC, company LIMIT 8"),
    top_titles: all("SELECT title, count(*) AS n FROM jobs WHERE status='applied' GROUP BY lower(title) ORDER BY n DESC LIMIT 8"),
    top_jobs: all("SELECT j.id, j.title, j.company, j.pay_text, j.fit_score, j.outcome, j.url FROM jobs j " +
      "WHERE j.status='applied' ORDER BY coalesce(j.fit_score,0) DESC, j.updated_at DESC LIMIT 6"),
    last_reply_check: s.gmail.last_check,
    setup_complete: !missingFields(s).length,
  };
}

// ───────────────────────────── issues (needs_info / needs_account / blocked) ─────────────────────────────

export const normQ = (label) => (label || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);

/** Stores the form questions that stopped an application, so the user can answer them on the Issues tab. */
export function addQuestions(jobId, questions) {
  let n = 0;
  for (const q of questions || []) {
    const label = String(q?.label || "").trim();
    if (!label) continue;
    const qtype = QTYPES.includes(q.type) ? q.type : q.options ? "choice" : "text";
    if (one("SELECT 1 AS x FROM job_questions WHERE job_id=? AND label=? AND answer IS NULL", jobId, label)) continue;
    run("INSERT INTO job_questions (job_id, label, qtype, options_json, required, created_at) VALUES (?,?,?,?,?,?)",
      jobId, label.slice(0, 500), qtype, JSON.stringify(q.options || null), q.required === false ? 0 : 1, now());
    n++;
  }
  return n;
}

export function domainOf(u) {
  try {
    return new URL(u).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function listIssues() {
  const saved = loadSettings().custom_answers || {};
  const out = Object.fromEntries(ISSUE_STATUSES.map((k) => [k, []]));
  const rows = all(`SELECT j.*, a.method FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.status IN (${ISSUE_STATUSES.map(() => "?").join(",")}) ` +
    "ORDER BY j.updated_at DESC", ...ISSUE_STATUSES);
  const questions = (id) => all("SELECT * FROM job_questions WHERE job_id=? ORDER BY id", id);
  for (const r of rows) {
    const j = Object.fromEntries(["id", "title", "company", "location", "work_mode", "pay_text", "url", "apply_url",
      "status", "status_note", "fit_score", "updated_at"].map((k) => [k, r[k] ?? null]));
    if (r.status === "needs_info") {
      let qs = questions(r.id);
      if (!qs.length && r.status_note) {
        // Older records only have the question in the note: offer it as one free-text question.
        addQuestions(r.id, [{ label: r.status_note, type: "textarea" }]);
        qs = questions(r.id);
      }
      j.questions = qs.map(({ options_json, ...q }) => {
        const out = { ...q, options: JSON.parse(options_json || "null") };
        if (q.answer === null && saved[normQ(q.label)] !== undefined) out.suggested = saved[normQ(q.label)];
        return out;
      });
    }
    if (r.status === "needs_account") {
      j.domain = domainOf(r.apply_url || r.url);
      j.account = one("SELECT email_used, created_at FROM site_accounts WHERE domain=?", j.domain);
    }
    out[r.status].push(j);
  }
  return out;
}

/** answers: [{id, answer, save}]. When every required question of a job is answered, the job is re-queued. */
export function answerQuestions(answers) {
  const reuse = {}, jobs = new Set();
  for (const a of answers || []) {
    const q = one("SELECT * FROM job_questions WHERE id=?", Number(a.id));
    if (!q) continue;
    let val = a.answer;
    val = Array.isArray(val) ? JSON.stringify(val) : val === null || val === undefined || val === "" ? null : String(val);
    run("UPDATE job_questions SET answer=?, answered_at=? WHERE id=?", val, val ? now() : null, q.id);
    jobs.add(q.job_id);
    if (a.save && val) reuse[normQ(q.label)] = val;
  }
  const requeued = [];
  for (const jid of jobs) {
    if (!scalar("SELECT count(*) FROM job_questions WHERE job_id=? AND required=1 AND answer IS NULL", jid)) {
      run("UPDATE jobs SET status='found', status_note='Answers provided on the Issues tab; ready to retry', updated_at=? " +
        "WHERE id=? AND status='needs_info'", now(), jid);
      requeued.push(jid);
    }
  }
  if (Object.keys(reuse).length) saveSettings({ custom_answers: reuse });
  return { saved: (answers || []).length, requeued, reusable: Object.keys(reuse).length };
}

export function jobAnswers(jobId) {
  return { job_id: jobId, answers: all("SELECT label, answer FROM job_questions WHERE job_id=? AND answer IS NOT NULL", jobId),
    saved_answers: loadSettings().custom_answers || {} };
}

/** The user created an account on the employer site themselves: remember the site and email, re-queue the job. */
export function markAccount(jobId, emailUsed, note) {
  const r = one("SELECT url, apply_url FROM jobs WHERE id=?", jobId);
  if (!r) throw new Error(`no job ${jobId}`);
  const d = domainOf(r.apply_url || r.url);
  run("INSERT INTO site_accounts (domain, email_used, created_at, job_id, note) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(domain) DO UPDATE SET email_used=excluded.email_used, note=excluded.note", d, emailUsed, now(), jobId, note);
  run("UPDATE jobs SET status='found', status_note=?, updated_at=? WHERE id=?",
    `Account created by the user on ${d} (${emailUsed}). User must be signed in before the agent continues.`, now(), jobId);
  return { domain: d, requeued: jobId };
}

export function siteAccount(domainOrUrl) {
  const v = domainOrUrl || "";
  const d = v.includes("/") ? domainOf(v) : v.toLowerCase().replace(/^www\./, "");
  return one("SELECT * FROM site_accounts WHERE domain=?", d) || { domain: d, account: null };
}
