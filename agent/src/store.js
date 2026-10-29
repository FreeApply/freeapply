// FreeApply store: data folder, settings, SQLite database and stats. Port of server/core.py.
// The schema is a superset of the original job-agent `jobagent.py` schema, so an existing `jobs.db` works as is.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emailStatus } from "./secrets.js";

export const VERSION = "1.0.5";

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
-- New emails FreeApply's own mailbox check found (inbox.js), shown in Replies until the reply check records them.
-- Only who sent it, the subject and when: the text stays in the mailbox. seen: a reply check read it.
CREATE TABLE IF NOT EXISTS inbox (
  gmail_message_id TEXT PRIMARY KEY, company TEXT, sender TEXT, subject TEXT, received_at TEXT, found_at TEXT, seen INTEGER DEFAULT 0
);
`;
// Columns added on top of the original schema (added in place to old databases).
// account_url: for needs_account, the page where the user makes the account (jobs with the same one share a card).
// keywords: the posting's ATS keywords from freeapply_fetch_posting, {matched, missing} (JSON), kept when the job is claimed.
const EXTRA_JOB_COLUMNS = { source: "TEXT", outcome: "TEXT", outcome_at: "TEXT", external_id: "TEXT", account_url: "TEXT", keywords: "TEXT" };
// prompt: the question in plain words for the user; help: a one-line hint. label stays the form's exact wording.
const EXTRA_QUESTION_COLUMNS = { prompt: "TEXT", help: "TEXT" };

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
  // How the user wants cover letters written. write: when_slot (whenever a form has a slot) or when_required; tone and
  // length pick the style (length ranges in COVER_LENGTHS); highlights are the user's own words to lead with (they
  // count as facts), avoid is what never to mention, sign_off the closing lines (empty: "Sincerely," and their name).
  cover_letter: { write: "when_slot", tone: "professional", length: "standard", highlights: "", avoid: "", sign_off: "" },
  // sources: job sites from JOB_SITES the agent may use. signed_in: {site id: when the user confirmed they signed in
  // themselves in the browser the agent uses}. signed_out: {site id: when the agent found itself signed out}.
  // FreeApply never asks for or stores job-site passwords: the browser the agent uses fills in the ones the user saved.
  // The only credential it keeps is an optional email app password, in the local .env (secrets.js), never in here.
  automation: { sources: ["linkedin", "company_sites"], signed_in: {}, signed_out: {}, site_paused_until: {}, easy_apply_allowed: false,
    fit_threshold: 60, rate_per_minute: 3, daily_cap: null },
  // Unattended runs on a schedule. Only the user changes these (dashboard); the agent reports schedule changes
  // through freeapply_autorun. A run goes on until nothing is left or a limit: max_run_minutes and max_applications are
  // optional per-run limits (null: none); the daily cap above still applies; every_hours is how often the schedule
  // wakes to restart a run that ended. chosen_at: when the user last pressed Start or Stop. auto_started_at: when
  // FreeApply turned it on by itself, once, the first time setup was complete. (max_minutes, from before runs were
  // continuous, is no longer read.)
  autorun: { enabled: false, every_hours: 1, max_run_minutes: null, max_applications: null, schedule_created: false, chosen_at: null,
    auto_started_at: null },
  onboarding: { completed_at: null, dismissed_at: null },
  // Answers the user gave on the Needs you tab and chose to reuse: {normalized question: answer}.
  custom_answers: {},
  // manual_logins: the user chose at setup to enter every password themselves instead of saving an email login.
  gmail: { enabled: true, interval_hours: 4, action: "star", label_name: "Job Replies",
    count_acknowledgements: false, last_check: null, schedule_created: false, manual_logins: false },
  // The models the AI app can hand a step to, as it reported them (freeapply_update_settings, re-scanned after updates),
  // and the user's own pick per level in Advanced settings (empty: the signed catalog decides). See models.js.
  models: { app: null, current: null, can_delegate: false, available: [], efforts: [], scanned_at: null, scanned_for: null },
  model_choices: { low: { model: "", effort: "" }, mid: { model: "", effort: "" }, high: { model: "", effort: "" } },
  // Acceptance of the legal documents in web/legal: the versions accepted and the text fingerprint (sharing.js).
  legal: { terms_version: null, privacy_version: null, legal_hash: null, accepted_at: null, age_confirmed: false },
  // Each sharing choice is null until decided; nothing is sent while a choice is not true.
  sharing: { usage_stats: null, job_market: null, talent_pool: null, talent_include_phone: false,
    email_updates: false, updates_email: "", decided_at: null, install_id: "", install_secret: "",
    last_sync: null, last_sync_result: null },
  setup_complete: false,
};

/** A fresh copy of the default settings: every section and field FreeApply knows, with its type. */
export const settingsDefaults = () => structuredClone(DEFAULT_SETTINGS);

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
  const custom = home(opts.data || process.env.FREEAPPLY_DATA);
  const data = custom || path.join(os.homedir(), ".freeapply");
  const config = readJson(path.join(data, "config.json")) || {};
  // Files to upload to application forms live in a visible folder, so a browser's file-select window can reach them:
  // ~/Documents/FreeApply for the normal data folder, or "documents" inside a custom one (tests, the dev copy).
  const docsHome = path.join(os.homedir(), "Documents");
  const documents = home(opts.documents || process.env.FREEAPPLY_DOCUMENTS || config.documents) ||
    (!custom && fs.existsSync(docsHome) ? path.join(docsHome, "FreeApply") : path.join(data, "documents"));
  Object.assign(paths, {
    data, settings: path.join(data, "settings.json"), resumes: path.join(data, "resumes"), documents,
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
/** A time from outside (an email's date, often in UTC) as local time like now(); one without a time zone stays as it is. */
export const localTime = (s) => (s && /(?:z|[+-]\d\d:?\d\d)$/i.test(s) && Number.isFinite(Date.parse(s)) ? now(new Date(s)) : s);
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
  const out = REQUIRED_FIELDS.filter(([key]) => {
    const v = get(s, key);
    return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  }).map(([key, label]) => ({ key, label }));
  // The email login lives in the local .env, not in settings: it is required unless the user chose to enter all
  // passwords themselves (then replies come through their AI app's Gmail connector, if any).
  if (!s.gmail?.manual_logins && !emailStatus().saved) out.push({ key: "email.login", label: "Email login (or \"I'll enter all passwords myself\")" });
  return out;
}

/** Recomputes setup_complete after something outside settings.json changed what is missing (the email login). */
export const refreshSetup = () => writeSettings(loadSettings());

/** Settings without the installation secrets, for display. */
export function publicSettings(s) {
  const { install_secret, talent_secret, ...sharing } = s.sharing;
  return { ...s, sharing };
}

/** Deep-merges `patch` into settings.json and recomputes setup_complete. */
export function saveSettings(patch) {
  return writeSettings(merge(loadSettings(), patch || {}));
}

function writeSettings(s) {
  s.setup_complete = !missingFields(s).length;
  // The first time setup is complete, auto-run turns on by itself, unless the user already chose, or finished setup
  // before this existed (an update that asks for one new field doesn't switch on an install the user left off).
  const a = s.autorun;
  if (s.setup_complete && !a.enabled && !a.chosen_at && !a.auto_started_at && !s.onboarding?.completed_at) {
    a.enabled = true; a.auto_started_at = now();
  }
  const tmp = `${paths.settings}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, paths.settings);
  return s;
}

/** Cover-letter word ranges by the user's length choice; the signed rules' minimum and maximum still bound them. */
export const COVER_LENGTHS = { short: [120, 180], standard: [150, 250], long: [250, 380] };

/** The folder of files to upload, with a current copy of the user's primary résumé in it (the original sits in the
 * hidden data folder, which file-select windows often don't show). */
export function documentsInfo(s = loadSettings()) {
  const dir = paths.documents;
  let resume = null;
  const src = s.resume.primary;
  if (src && fs.existsSync(src)) {
    fs.mkdirSync(dir, { recursive: true });
    resume = path.join(dir, path.basename(src));
    const st = fs.statSync(src);
    if (!fs.existsSync(resume) || fs.statSync(resume).mtimeMs < st.mtimeMs || fs.statSync(resume).size !== st.size) fs.copyFileSync(src, resume);
  }
  return { dir, resume, cover_letters: path.join(dir, "Cover letters") };
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
  const haveQ = new Set(con.prepare("PRAGMA table_info(job_questions)").all().map((r) => r.name));
  for (const [col, typ] of Object.entries(EXTRA_QUESTION_COLUMNS)) if (!haveQ.has(col)) con.exec(`ALTER TABLE job_questions ADD COLUMN ${col} ${typ}`);
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

export function setStatus(jobId, status, { note, method, confirmation, resumePath, coverPath, coverText, dropCover } = {}) {
  if (!STATUSES[status]) throw new Error(`status must be one of ${Object.keys(STATUSES).sort().join(", ")}`);
  if (!one("SELECT 1 AS x FROM jobs WHERE id=?", jobId)) throw new Error(`no job ${jobId}`);
  run("UPDATE jobs SET status=?, status_note=coalesce(?,status_note), updated_at=? WHERE id=?", status, note, now(), jobId);
  run("INSERT INTO applications (job_id) VALUES (?) ON CONFLICT(job_id) DO NOTHING", jobId);
  // A saved letter that never went out leaves the record; its PDF stays in the documents folder.
  if (dropCover) run("UPDATE applications SET cover_path=NULL, cover_text=NULL WHERE job_id=?", jobId);
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

/** Keeps the cover letter saved for a job with its application, so recording the submit needs no second copy of it. */
export function setCoverLetter(jobId, file, text) {
  run("INSERT INTO applications (job_id, cover_path, cover_text) VALUES (?,?,?) ON CONFLICT(job_id) DO UPDATE SET " +
    "cover_path=excluded.cover_path, cover_text=excluded.cover_text", jobId, file, text);
}

/** The letter kept with a job ({path, text}), or null: what to attach, or paste into a text-box letter field. */
export function coverLetter(jobId) {
  const r = one("SELECT cover_path, cover_text FROM applications WHERE job_id=?", jobId);
  return r && (r.cover_path || r.cover_text) ? { path: r.cover_path, text: r.cover_text } : null;
}

/** Saves one reusable answer under the question's label, or removes it when the answer is empty. Saved answers fill
 * later forms and count as the user's own words in the truthfulness check. */
export function saveAnswer(label, answer) {
  const key = String(label || "").trim();
  if (!key) throw new Error("label is required");
  const s = loadSettings(), answers = { ...(s.custom_answers || {}) };
  const value = answer == null ? "" : String(answer).trim();
  if (value) answers[key] = value;
  else delete answers[key];
  writeSettings({ ...s, custom_answers: answers });
  return { label: key, saved: !!value, removed: !value, saved_answers: answers };
}

/** Removes a job and what belongs only to it (application record, form questions, recorded emails). An account the
 * user made on the employer's site stays, unlinked from the job. The dashboard's Remove button calls this. */
export function deleteJob(jobId) {
  const id = Number(jobId);
  const job = one("SELECT id, title, company FROM jobs WHERE id=?", id);
  if (!job) throw new Error(`no job ${id}`);
  db().exec("BEGIN");
  try {
    for (const t of ["job_questions", "applications", "replies"]) run(`DELETE FROM ${t} WHERE job_id=?`, id);
    run("UPDATE site_accounts SET job_id=NULL WHERE job_id=?", id);
    run("DELETE FROM jobs WHERE id=?", id);
    db().exec("COMMIT");
  } catch (e) {
    db().exec("ROLLBACK");
    throw e;
  }
  return { removed: id, title: job.title, company: job.company };
}

export function setOutcome(jobId, outcome) {
  if (outcome && !OUTCOMES[outcome]) throw new Error(`outcome must be one of ${Object.keys(OUTCOMES).sort().join(", ")}`);
  if (!one("SELECT id FROM jobs WHERE id=?", jobId)) throw new Error(`no job ${jobId}; find its id with freeapply_list_jobs`);
  run("UPDATE jobs SET outcome=?, outcome_at=?, updated_at=? WHERE id=?", outcome || null, outcome ? now() : null, now(), jobId);
  return { job_id: jobId, outcome };
}

/** Stores one employer email and raises the job's outcome if this reply ranks higher. */
export function recordReply(r) {
  const kind = r.kind || "replied";
  if (!OUTCOMES[kind]) throw new Error(`kind must be one of ${Object.keys(OUTCOMES).sort().join(", ")}`);
  if (r.job_id && !one("SELECT id FROM jobs WHERE id=?", r.job_id)) throw new Error(`no job ${r.job_id}; find its id with freeapply_list_jobs`);
  if (r.gmail_message_id) run("DELETE FROM inbox WHERE gmail_message_id=?", r.gmail_message_id);
  const received = localTime(r.received_at);
  const added = Number(run("INSERT OR IGNORE INTO replies (job_id, company, gmail_message_id, gmail_thread_id, sender, subject, " +
    "received_at, kind, summary, mail_action, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    r.job_id, r.company, r.gmail_message_id, r.gmail_thread_id, r.sender, r.subject, received, kind, r.summary, r.mail_action, now()).changes) > 0;
  if (r.job_id) {
    // An email recorded before changes nothing: its outcome already counted when it was first recorded.
    const cur = one("SELECT outcome FROM jobs WHERE id=?", r.job_id);
    if (added && cur && (OUTCOME_RANK[kind] ?? 0) >= (OUTCOME_RANK[cur.outcome || ""] ?? -1)) {
      run("UPDATE jobs SET outcome=?, outcome_at=?, updated_at=? WHERE id=?", kind, received || now(), now(), r.job_id);
    }
    return { recorded: added, kind, job_id: r.job_id, outcome: one("SELECT outcome FROM jobs WHERE id=?", r.job_id).outcome };
  }
  return { recorded: added, kind, job_id: null, outcome: null };
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

/** The reply check is done: emails it read and left unrecorded (not about an application after all) leave the list. */
export function markReplyCheckDone() {
  run("DELETE FROM inbox WHERE seen=1");
  return saveSettings({ gmail: { last_check: now() } });
}

/** The mailbox check's new emails, newest first; known ids are skipped. */
export function inboxAdd(emails) {
  let n = 0;
  for (const e of emails) n += Number(run("INSERT OR IGNORE INTO inbox (gmail_message_id, company, sender, subject, received_at, found_at) " +
    "VALUES (?,?,?,?,?,?)", e.gmail_message_id, e.company || null, e.sender, e.subject, localTime(e.received_at), now()).changes);
  return n;
}
export const inboxSeen = (ids) => ids.forEach((id) => run("UPDATE inbox SET seen=1 WHERE gmail_message_id=?", id));
export const listInbox = () => all("SELECT * FROM inbox ORDER BY coalesce(received_at, found_at) DESC LIMIT 200");

/** Changes when anything the dashboard shows changes, from this process or another (the dashboard asks every few
 * seconds and reloads when it moves). data_version moves with other connections' commits, total_changes with ours. */
export function changeStamp() {
  const d = db();
  let mtime = 0;
  try { mtime = fs.statSync(paths.settings).mtimeMs; } catch { /* no settings yet */ }
  return `${d.prepare("PRAGMA data_version").get().data_version}.${d.prepare("SELECT total_changes() AS n").get().n}.${mtime}`;
}

/** Submissions in the last minute for a method and today overall (rules.js turns this into a clearance). */
export function throttleCounts(method) {
  const cutoff = now(new Date(Date.now() - 60_000));
  return {
    last_minute: scalar("SELECT count(*) FROM applications WHERE method=? AND submitted_at>?", method, cutoff),
    today: scalar("SELECT count(*) FROM applications WHERE submitted_at>=?", today()),
  };
}

// ───────────────────────────── reads for the dashboard ─────────────────────────────

/** Tracked jobs, most recent activity first. limit and offset page through them (the dashboard asks for all). */
export function listJobs(status, outcome, search, limit = 2000, offset = 0) {
  let q = "SELECT j.id, j.title, j.company, j.location, j.work_mode, j.pay_text, j.pay_min, j.pay_max, j.url, " +
    "j.apply_url, j.fit_score, j.status, j.status_note, j.outcome, j.outcome_at, j.source, j.found_at, " +
    "j.updated_at, a.method, a.submitted_at, a.confirmation, a.resume_path, a.cover_path, " +
    "(SELECT count(*) FROM replies r WHERE r.job_id=j.id) AS reply_count " +
    "FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE 1=1";
  const args = [];
  if (status) (q += " AND j.status=?"), args.push(status);
  if (outcome) (q += " AND j.outcome=?"), args.push(outcome);
  if (search) (q += " AND (j.title LIKE ? OR j.company LIKE ? OR j.location LIKE ?)"), args.push(...Array(3).fill(`%${search}%`));
  q += " ORDER BY coalesce(a.submitted_at, j.updated_at, j.found_at) DESC, j.id DESC LIMIT ? OFFSET ?";
  return all(q, ...args, Number(limit) || 2000, Math.max(0, Number(offset) || 0));
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
    inbox_checked_at: metaGet("inbox_checked_at"), inbox_error: metaGet("inbox_error"), inbox_new: scalar("SELECT count(*) FROM inbox"),
    email_login: emailStatus().saved,
    setup_complete: !missingFields(s).length,
  };
}

// ───────────────────────────── issues (needs_info / needs_account / blocked) ─────────────────────────────

export const normQ = (label) => (label || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);

// Filler words that don't change what a form question asks.
const Q_FILLER = new Set(("a an the and or of to in on for at by with from is are am be been do does did you your i me my " +
  "we our this that these those it its as if please any have has had will would can could should may there here what " +
  "which who whom whose when where how about into than so able").split(" "));
const qWords = (label) => new Set(normQ(label).split(" ").filter((w) => w && !Q_FILLER.has(w))
  .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));

/** How alike two form questions are: 1 for the same words once filler is ignored, down to 0 for nothing in common. */
export function qSimilarity(a, b) {
  const na = normQ(a);
  if (na && na === normQ(b)) return 1;
  const x = qWords(a), y = qWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
// From this score two questions are similar: a saved answer becomes a suggestion, and on one job the newer is a duplicate.
export const SIMILAR = 0.6;

// Answer kinds that are the same to the user: free text either way, or picking one option.
const FAMILY = { text: "open", textarea: "open", yesno: "choice" };
const family = (q) => FAMILY[q.qtype] || q.qtype;
const optionsOf = (q) => (q.qtype === "yesno" ? ["Yes", "No"] : q.options || null);
const optionKey = (q) => (optionsOf(q) || []).map((o) => String(o).trim().toLowerCase()).sort().join("|");
const sameWords = (a, b) => !!a && !!b && qSimilarity(a, b) === 1;
/** The same question: the same words (filler aside) in the form's label or in the plain prompt, the same kind of answer
 * and the same options. Two forms word one question differently; the plain prompts then usually agree. */
const sameQuestion = (a, b) => (sameWords(a.label, b.label) || sameWords(a.prompt, b.prompt)) && family(a) === family(b) &&
  optionKey(a) === optionKey(b);

/** Whether an answer fits a question: one of its options for a choice or yes/no, a list of them for multi. */
function answerFits(q, answer) {
  const opts = optionsOf(q);
  if (!opts) return true;
  const ok = (v) => opts.some((o) => String(o).trim().toLowerCase() === String(v).trim().toLowerCase());
  if (q.qtype !== "multi") return ok(answer);
  let v;
  try {
    v = JSON.parse(answer);
  } catch {
    v = String(answer).split(/\s*,\s*/);
  }
  return Array.isArray(v) && v.length > 0 && v.every(ok);
}

/** The user's saved answer closest to a question, by its label or its plain prompt: {key, answer, score}, or null when
 * none is at least similar. */
export function savedAnswerFor(label, saved = loadSettings().custom_answers || {}, prompt = null) {
  let best = null;
  for (const [key, answer] of Object.entries(saved)) {
    const score = Math.max(qSimilarity(label, key), prompt ? qSimilarity(prompt, key) : 0);
    if (score >= SIMILAR && (!best || score > best.score)) best = { key, answer, score };
  }
  return best;
}

/** A form label in plainer words, for questions that came without a prompt: no asterisks, "(required)", field ids,
 * "Please enter" or shouting. */
export function plainer(label) {
  const raw = String(label || "").replace(/\s+/g, " ").trim();
  let t = raw.replace(/\*+/g, "").replace(/\((?:required|optional|mandatory|y\/n|yes\/no)\)/gi, "")
    .replace(/\b[a-z]+(?:_[a-z0-9]+)*_\d+\b/gi, "").replace(/\[\d*\]/g, "")
    .replace(/^please\s+(?:enter|provide|specify|indicate|select|state|list)\s+/i, "").replace(/^please\s+/i, "")
    .replace(/\s+([?.:,])/g, "$1").replace(/[\s:]+$/, "").replace(/\s+/g, " ").trim();
  if (/[A-Z]{4}/.test(t) && t === t.toUpperCase()) t = t.toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : raw;
}

const withOptions = ({ options_json, ...q }) => ({ ...q, options: JSON.parse(options_json || "null") });

/** A question as the agent sent it, tidied: label (the form's exact wording), qtype, options, required, prompt, help. */
function cleanQuestion(q) {
  const options = Array.isArray(q?.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
  const line = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n) || null;
  return { label: String(q?.label || "").trim().slice(0, 500), qtype: QTYPES.includes(q?.type) ? q.type : options.length ? "choice" : "text",
    options: options.length ? options : null, required: q?.required !== false, prompt: line(q?.prompt, 200), help: line(q?.help, 300) };
}

function insertQuestion(jobId, q) {
  run("INSERT INTO job_questions (job_id, label, qtype, options_json, required, prompt, help, created_at) VALUES (?,?,?,?,?,?,?,?)",
    jobId, q.label, q.qtype, JSON.stringify(q.options), q.required ? 1 : 0, q.prompt, q.help, now());
}

/** Checks new form questions against what already waits on the user and what they already answered, storing nothing.
 * Each result is: added (new); duplicate (this job already waits on the same or a similar question: same_as);
 * grouped (other jobs wait on the same question, with_jobs: one answer will fill them all); or already_answered (the
 * user answered the same question before, for this job or as a saved answer: answer). A similar saved answer is
 * offered to the user as suggested. */
export function checkQuestions(jobId, questions) {
  const id = Number(jobId), saved = loadSettings().custom_answers || {};
  const rows = all("SELECT q.* FROM job_questions q JOIN jobs j ON j.id=q.job_id WHERE q.job_id=? OR (q.answer IS NULL AND j.status='needs_info')", id)
    .map(withOptions);
  const open = rows.filter((r) => r.answer === null), mine = open.filter((r) => r.job_id === id), others = open.filter((r) => r.job_id !== id);
  const answeredHere = rows.filter((r) => r.job_id === id && r.answer !== null);
  const taken = [];
  return (questions || []).map(cleanQuestion).filter((q) => q.label).map((q) => {
    const dup = [...mine, ...taken].find((m) => family(m) === family(q) && (qSimilarity(m.label, q.label) >= SIMILAR || sameWords(m.prompt, q.prompt)));
    if (dup) return { q, label: q.label, result: "duplicate", same_as: dup.label };
    const before = answeredHere.find((r) => sameQuestion(r, q) && answerFits(q, r.answer));
    if (before) return { q, label: q.label, result: "already_answered", answer: before.answer };
    const s = savedAnswerFor(q.label, saved, q.prompt);
    if (s?.score === 1 && answerFits(q, s.answer)) return { q, label: q.label, result: "already_answered", answer: s.answer };
    taken.push(q);
    const withJobs = [...new Set(others.filter((o) => sameQuestion(o, q)).map((o) => o.job_id))];
    return { q, label: q.label, result: withJobs.length ? "grouped" : "added", ...(withJobs.length ? { with_jobs: withJobs } : {}),
      ...(s && answerFits(q, s.answer) ? { suggested: s.answer } : {}) };
  });
}

/** Stores the form questions that stopped an application, so the user can answer them on the Needs you tab. Only
 * added and grouped questions are stored (checkQuestions). Returns the result for each question. */
export function addQuestions(jobId, questions) {
  const plan = checkQuestions(jobId, questions);
  for (const p of plan) if (p.result === "added" || p.result === "grouped") insertQuestion(jobId, p.q);
  return plan.map(({ q, ...r }) => r);
}

/** Other jobs blocked on the same employer site. */
export function sameSiteIssues(jobId, status) {
  const j = one("SELECT url, apply_url FROM jobs WHERE id=?", jobId), d = j && domainOf(j.apply_url || j.url);
  if (!d) return [];
  return all("SELECT id, title, company, url, apply_url FROM jobs WHERE status=? AND id<>?", status, jobId)
    .filter((r) => domainOf(r.apply_url || r.url) === d).map(({ id, title, company }) => ({ id, title, company }));
}

// Link parameters that only track where a visit came from; they don't change which page opens.
const TRACKING = /^(utm_\w+|gclid|fbclid|ref|src|source|trk|trackingid|refid)$/i;

/** Where a job's account is made, as a key: the same key means the same account, so the jobs share one card. It is the
 * account page the agent recorded (else the application link), with the host in lower case and without www, no
 * trailing slash, no #fragment and no tracking parameters. Only the same address counts: one host often serves many
 * employers (boards.greenhouse.io/acme and boards.greenhouse.io/globex are different accounts). */
export function accountKey(j) {
  try {
    const u = new URL(j.account_url || j.apply_url || j.url);
    const q = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    return u.host.toLowerCase().replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + (q.length ? `?${new URLSearchParams(q)}` : "");
  } catch {
    return "";
  }
}

/** Other jobs waiting on an account at the same address (accountKey). */
export function sameAccountIssues(jobId) {
  const j = one("SELECT url, apply_url, account_url FROM jobs WHERE id=?", jobId), key = j && accountKey(j);
  if (!key) return [];
  return all("SELECT id, title, company, url, apply_url, account_url FROM jobs WHERE status='needs_account' AND id<>?", jobId)
    .filter((r) => accountKey(r) === key).map(({ id, title, company }) => ({ id, title, company }));
}

/** Records the page where the user makes the account a job needs. Only http(s) links. */
export function setAccountUrl(jobId, url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u) || !accountKey({ url: u })) throw new Error("account_url must be a full http(s) link to the sign-up page");
  run("UPDATE jobs SET account_url=? WHERE id=?", u.slice(0, 1000), jobId);
}

/** What stopped a blocked job, read from the agent's note: a "prove you're human" check (captcha), a code sent to the
 * user (code), a warning about automated use (warning), or something else (other). The dashboard words each plainly. */
export function blockedKind(note) {
  const t = String(note || "").toLowerCase();
  if (/transcript|writing sample|work sample|portfolio (?:file|upload)|upload (?:a|an|your) (?!resume|résumé|cv)/.test(t)) return "document";
  if (/essay|own words|not genai|real story|behaviou?ral|in \d+ words|cover letter in (?:a|the) (?:box|text)/.test(t)) return "essay";
  if (/captcha|human|robot|turnstile|puzzle|challenge/.test(t)) return "captcha";
  if (/\bcode\b|one[- ]time|\botp\b|2fa|two[- ]factor|passcode|verification (?:email|text|sms)/.test(t)) return "code";
  if (/automat|unusual|suspicious|\bbots?\b|too many|rate.?limit|warning|restricted|banned/.test(t)) return "warning";
  return "other";
}

export function domainOf(u) {
  try {
    return new URL(u).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Everything waiting on the user, by status, plus the two views the Needs you tab shows: questions (each question
 * once, however many jobs ask it, worded plainly) and accounts (one per employer site, however many jobs wait on it). */
// An older record's note is offered as a question only when it reads like one for the user. Notes the agent wrote for
// itself ("Greenhouse form requires ...") are not questions: those jobs go to Stuck, explained in plain words.
const asksUser = (note) => { const t = String(note || "").trim();
  if (!t || /https?:|[\\/]\w+[\\/]|\.pdf\b|\bclaim:/i.test(t)) return false;
  return t.endsWith("?") ? t.length <= 200 // a question, or a short field label ("Desired salary (required)")
    : t.length <= 80 && !/[.;]\s/.test(t) && !/\b(?:form|requires?|needs|upload|captcha|account|agent|retry|fit \d+)\b/i.test(t); };

export function listIssues() {
  const saved = loadSettings().custom_answers || {};
  const out = Object.fromEntries(ISSUE_STATUSES.map((k) => [k, []]));
  const rows = all(`SELECT j.*, a.method FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.status IN (${ISSUE_STATUSES.map(() => "?").join(",")}) ` +
    "ORDER BY j.updated_at DESC, j.id DESC", ...ISSUE_STATUSES);
  const questions = (id) => all("SELECT * FROM job_questions WHERE job_id=? ORDER BY id", id);
  for (const r of rows) {
    const j = Object.fromEntries(["id", "title", "company", "location", "work_mode", "pay_text", "url", "apply_url",
      "status", "status_note", "fit_score", "updated_at"].map((k) => [k, r[k] ?? null]));
    if (r.status === "needs_info") {
      // Earlier versions turned every such note into a question; those that aren't questions are dropped here.
      let qs = questions(r.id).filter((q) => q.label !== r.status_note || asksUser(r.status_note));
      if (!qs.length && asksUser(r.status_note)) {
        // Older records only have the question in the note: offer it as one free-text question.
        insertQuestion(r.id, cleanQuestion({ label: r.status_note, type: "textarea" }));
        qs = questions(r.id);
      }
      if (!qs.length) j.kind = blockedKind(r.status_note);
      j.questions = qs.map(withOptions).map((q) => {
        const s = q.answer === null && savedAnswerFor(q.label, saved, q.prompt);
        return { ...q, prompt: q.prompt || plainer(q.label), ...(s && answerFits(q, s.answer) ? { suggested: s.answer } : {}) };
      });
    }
    if (r.status === "needs_account") {
      j.account_url = r.account_url || null;
      j.domain = domainOf(r.account_url || r.apply_url || r.url);
      j.account = one("SELECT email_used, created_at FROM site_accounts WHERE domain=?", j.domain);
    }
    if (r.status === "blocked") j.kind = blockedKind(r.status_note);
    out[r.status].push(j);
  }
  const brief = (j) => ({ id: j.id, title: j.title, company: j.company, url: j.apply_url || j.url });
  // A card takes its wording from the question asked first (an account card its link from the job that waited first),
  // so it does not change when another job joins it. Cards are listed by their newest job, like the jobs themselves.
  const byNewest = (list) => {
    const rank = new Map(list.map((j, i) => [j.id, i]));
    return (cards) => cards.map((c) => [Math.min(...c.jobs.map((j) => rank.get(j.id))), c]).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  };
  const groups = [];
  const asked = out.needs_info.flatMap((j) => j.questions.map((q) => [j, q])).sort((a, b) => a[1].id - b[1].id);
  for (const [j, q] of asked) {
    let g = groups.find((x) => sameQuestion(x, q));
    if (!g) groups.push(g = { ids: [], label: q.label, labels: [], prompt: q.prompt, help: q.help, qtype: q.qtype,
      options: q.options, required: false, answer: null, suggested: q.suggested ?? null, done: true, jobs: [] });
    g.ids.push(q.id);
    if (!g.labels.includes(q.label)) g.labels.push(q.label);
    g.help ??= q.help;
    g.required ||= !!q.required;
    g.answer ??= q.answer;
    g.done &&= q.answer !== null;
    if (!g.jobs.some((x) => x.id === j.id)) g.jobs.push(brief(j));
  }
  // One card per account address: jobs share a card only when their account is made at the same URL.
  const accounts = new Map();
  for (const j of [...out.needs_account].reverse()) {
    const key = accountKey(j) || `job ${j.id}`;
    if (!accounts.has(key)) accounts.set(key, { domain: j.domain, company: j.company, account: j.account,
      signup_url: j.account_url || j.apply_url || j.url, note: j.status_note, jobs: [] });
    accounts.get(key).jobs.push(brief(j));
  }
  return { ...out, questions: byNewest(out.needs_info)(groups), accounts: byNewest(out.needs_account)([...accounts.values()]) };
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
    if (a.save && val) {
      reuse[normQ(q.label)] = val;
      if (q.prompt) reuse[normQ(q.prompt)] = val; // so a form that words it differently still finds it
    }
  }
  const requeued = [];
  for (const jid of jobs) {
    if (!scalar("SELECT count(*) FROM job_questions WHERE job_id=? AND required=1 AND answer IS NULL", jid)) {
      run("UPDATE jobs SET status='found', status_note='Answers provided on the Needs you tab; ready to retry', updated_at=? " +
        "WHERE id=? AND status='needs_info'", now(), jid);
      requeued.push(jid);
    }
  }
  if (Object.keys(reuse).length) saveSettings({ custom_answers: reuse });
  return { saved: (answers || []).length, requeued, reusable: Object.keys(reuse).length };
}

export function jobAnswers(jobId) {
  return { job_id: jobId, answers: all("SELECT label, answer FROM job_questions WHERE job_id=? AND answer IS NOT NULL", jobId),
    saved_answers: loadSettings().custom_answers || {}, cover_letter: coverLetter(jobId) };
}

/** The user created an account on the employer site themselves: remember the site and email, and re-queue the job
 * and every other job waiting on an account at the same address (accountKey). */
export function markAccount(jobId, emailUsed, note) {
  const r = one("SELECT url, apply_url, account_url FROM jobs WHERE id=?", jobId);
  if (!r) throw new Error(`no job ${jobId}`);
  const d = domainOf(r.account_url || r.apply_url || r.url);
  run("INSERT INTO site_accounts (domain, email_used, created_at, job_id, note) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(domain) DO UPDATE SET email_used=excluded.email_used, note=excluded.note", d, emailUsed, now(), jobId, note);
  const ids = [Number(jobId), ...sameAccountIssues(jobId).map((j) => j.id)];
  for (const id of ids) {
    run("UPDATE jobs SET status='found', status_note=?, updated_at=? WHERE id=?",
      `Account created by the user on ${d} (${emailUsed}). User must be signed in before the agent continues.`, now(), id);
  }
  return { domain: d, requeued: ids };
}

export function siteAccount(domainOrUrl) {
  const v = String(domainOrUrl || "").trim();
  const d = v.includes("/") ? domainOf(v) : v.toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error(`"${v.slice(0, 200)}" is not a site: pass its domain, like careers.example.com, or any web address on it`);
  return one("SELECT * FROM site_accounts WHERE domain=?", d) || { domain: d, account: null };
}
