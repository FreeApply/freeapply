// Hard rules enforced in tool code, not only in prompt text: an AI can be talked out of a written rule, code cannot.
// Every limit comes from the signed workflow bundle (`bundle.rules`), so it cannot be edited on the user's computer.
import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";
import * as autorun from "./autorun.js";
import { letterPdf } from "./pdf.js";

export class RuleError extends Error {}

// ───────────────────────────── pacing: one-time clearance per submit ─────────────────────────────

const clearances = new Map(); // job id -> expiry (ms)
const issued = []; // when clearances were issued, so jobs not yet recorded still count toward the per-minute limit

/** Checks the pace limits; when clear and a job id is given, issues the clearance recording 'applied' needs. In an
 * unattended run (runId given) the run's own limits come first: time and application budget, the daily cap and the
 * dashboard's Stop button; when one is reached the run must finish (stop_run). */
export function throttle(rules, method = "external", jobId, runId) {
  let restart = null;
  if (runId) {
    const run = autorun.check(runId);
    if (!run.go) return { clear: false, stop_run: true, reason: run.reason, applied_this_run: run.applied_this_run ?? null,
      advice: "do not submit; finish the run with freeapply_manage_autorun action finish" };
    if (run.restart) restart = { restart: true, restart_advice: "the user saved new settings and wants them used now: " +
      "submit and record this job, start no other, then finish the run; the next one begins at once" };
  }
  const s = store.loadSettings();
  const cap = rules.max_rate_per_minute || 3;
  const limit = Math.min(Number(s.automation.rate_per_minute) || cap, cap); // the user may go slower, never faster
  const { last_minute, today } = store.throttleCounts(method);
  const t = Date.now();
  while (issued.length && issued[0] < t - 60_000) issued.shift();
  const recent = Math.max(last_minute, issued.length);
  if (method === "easy_apply" && !s.automation.easy_apply_allowed) {
    return { clear: false, refused: "One-click apply (LinkedIn Easy Apply and similar) is off in the user's settings. " +
      "Apply on the employer's site instead, or skip the job (hard rule)." };
  }
  const dailyCap = s.automation.daily_cap;
  const clear = recent < limit && (!dailyCap || today < Number(dailyCap));
  const out = { clear, last_minute: recent, limit_per_minute: limit, today, daily_cap: dailyCap ?? null,
    advice: clear ? "submit now" : restart ? "wait and retry" : "wait and retry; work on the next job meanwhile", ...restart };
  if (clear && jobId) {
    const ttl = (rules.clearance_ttl_seconds || 900) * 1000;
    clearances.set(Number(jobId), t + ttl);
    issued.push(t);
    out.clearance = { job_id: Number(jobId), expires_at: store.now(new Date(t + ttl)) };
  } else if (clear) {
    out.note = "Pass job_id to get the clearance that freeapply_update_job needs to record 'applied'.";
  }
  return out;
}

/** Forgets issued clearances (tests, so one case's pacing does not leak into the next). */
export function resetPacing() {
  clearances.clear();
  issued.length = 0;
}

function takeClearance(jobId) {
  const exp = clearances.get(Number(jobId));
  clearances.delete(Number(jobId));
  return !!exp && exp > Date.now();
}

// ───────────────────────────── claiming a job ─────────────────────────────

/** Posted pay to a yearly figure. Uses the top of the range: a job is skipped only when even that is below the floor. */
export function annualPosted(min, max) {
  const v = Number(max ?? min);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < 500) return v * 2080; // hourly
  if (v < 20000) return v * 12; // monthly
  return v;
}

function annualFloor(t) {
  const v = Number(t.min_pay);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v * ({ hour: 2080, month: 12 }[t.pay_period] || 1);
}

/** freeapply_claim_job: the duplicate check, the user's job sites and their readiness, and the pay floor, then the
 * claim. Returns earlier jobs at the same company so the agent can spot a repost under another title. */
export function claimJob(rules, j) {
  const ext = j.external_id || j.linkedin_job_id;
  const same = ext && store.one("SELECT id, status FROM jobs WHERE linkedin_job_id=? OR external_id=?", ext, ext);
  if (same) return { job_id: same.id, existing: true, status: same.status, earlier: [] };
  const settings = store.loadSettings();
  const site = store.siteOf(j);
  if (site && !(settings.automation.sources || []).includes(site)) {
    const name = store.JOB_SITES.find((x) => x.id === site).name;
    return { refused: `${name} is not one of the job sites the user chose (Settings → Job sites). Do not use it (hard rule).` };
  }
  if (site && (j.status || "found") === "found") {
    const sites = store.siteReadiness(settings), here = sites.find((x) => x.id === site);
    if (here && !here.ready) {
      return { refused: `${here.name} is not ready (${here.paused_until ? `paused until ${here.paused_until}` : "the user must sign in again and confirm it"}); ` +
        "work on a ready site or a company career site instead", sites };
    }
  }
  if (j.company && j.title) {
    const dup = store.one("SELECT id FROM jobs WHERE lower(company)=lower(?) AND lower(title)=lower(?) AND status='applied'", j.company, j.title);
    if (dup) {
      return { job_id: dup.id, existing: true, refused: `duplicate: job ${dup.id} (${j.company}, "${j.title}") was already applied to. ` +
        "Staffing firms repost one role; do not apply again (hard rule)." };
    }
  }
  const floor = annualFloor(settings.targets);
  const posted = annualPosted(j.pay_min, j.pay_max);
  let rule = null;
  if (floor && posted !== null && posted < floor && (j.status || "found") === "found") {
    j = { ...j, status: "skipped", status_note: `Posted pay (about $${Math.round(posted).toLocaleString("en-US")}/yr) is below ` +
      `the minimum in settings ($${Math.round(floor).toLocaleString("en-US")}/yr) (hard rule)` };
    rule = "pay_floor";
  }
  const earlier = j.company ? store.findDuplicates(j.company, j.title).slice(0, 20) : [];
  const fetched = recent.get(String(j.url || "")) || recent.get(String(j.apply_url || ""));
  if (fetched && !j.description) j = { ...j, description: fetched.text };
  const r = store.addJob(j);
  if (fetched?.keywords) store.run("UPDATE jobs SET keywords=? WHERE id=?", JSON.stringify(fetched.keywords), r.job_id);
  return { ...r, ...(rule ? { status: "skipped", rule } : { status: j.status || "found" }), earlier };
}

// ───────────────────────────── recording what the agent did ─────────────────────────────

/** freeapply_update_job: user-only statuses, the truthfulness check on cover letters, and the submit clearance. */
// Fields that belong to one status. With any other status they are refused, so nothing lands on the wrong record
// (questions on an applied job would reach the user's Needs you tab).
const STATUS_FIELDS = { questions: "needs_info", account_url: "needs_account", method: "applied", confirmation: "applied",
  resume_path: "applied", cover_path: "applied", cover_text: "applied", letter_sent: "applied" };

export function agentSetStatus(rules, a) {
  const job = store.getJob(a.job_id);
  if (!job) throw new RuleError(`no job ${a.job_id}; find its id with freeapply_list_jobs`);
  const misplaced = Object.keys(STATUS_FIELDS).filter((k) => a[k] != null && a[k] !== "" && STATUS_FIELDS[k] !== a.status &&
    !(Array.isArray(a[k]) && !a[k].length));
  if (misplaced.length) {
    throw new RuleError(`${misplaced.map((k) => `${k} goes with status ${STATUS_FIELDS[k]}`).join("; ")}, not ${a.status}: ` +
      "leave it out or use that status");
  }
  if (a.status === "needs_info" && !a.questions?.length) {
    throw new RuleError("needs_info needs questions: the form's open questions, which the user answers on the Needs you tab");
  }
  if ((rules.user_only_statuses || []).includes(job.status) && a.status !== job.status) {
    throw new RuleError(`job ${a.job_id} is '${job.status}'; only the user can change that, in the dashboard (hard rule)`);
  }
  if (a.cover_text) {
    const problems = checkText(rules, a.cover_text, { kind: "cover_letter", jobId: a.job_id, company: job.company });
    if (problems.length) throw new RuleError(`cover letter failed the truthfulness check (hard rule): ${problems.join("; ")}`);
  }
  // A saved letter is on the record only if it went out: a text-box form or a failed upload can leave it behind.
  const ownLetter = a.cover_path || a.cover_text;
  if (a.letter_sent === false && ownLetter) throw new RuleError("letter_sent false contradicts cover_path/cover_text: leave those out");
  if (a.status === "applied" && job.status !== "applied" && !ownLetter && typeof a.letter_sent !== "boolean" &&
    store.coverLetter(a.job_id)) {
    throw new RuleError("a cover letter is saved for this job: pass letter_sent true if it was attached or pasted, false if not");
  }
  if (a.status === "applied" && job.status !== "applied" && !takeClearance(a.job_id)) {
    throw new RuleError("refused: call freeapply_clear_to_submit with this job_id right before submitting; recording 'applied' " +
      "needs that clearance (hard rule)");
  }
  // Never ask the user again what they already answered: a stop for questions that all have answers is refused.
  const asked = a.status === "needs_info" && a.questions?.length ? store.checkQuestions(a.job_id, a.questions) : null;
  if (asked?.length && asked.every((q) => q.result === "already_answered")) {
    throw new RuleError("refused: the user already answered every one of these questions, so don't stop for them; fill in " +
      `these answers and continue: ${asked.map((q) => `"${q.label}" -> ${q.answer}`).join("; ")}`);
  }
  if (a.account_url) store.setAccountUrl(a.job_id, a.account_url); // checked before the status changes
  const before = store.ISSUE_STATUSES.includes(a.status) && job.status === a.status;
  // The résumé sent is the documents copy unless the agent names another file; the letter was kept when it was saved,
  // and is dropped from the record when it was not sent.
  const resumePath = a.resume_path || (a.status === "applied" && job.status !== "applied" ? store.documentsInfo().resume : null);
  const out = store.setStatus(a.job_id, a.status, { note: a.note, method: a.method, confirmation: a.confirmation,
    resumePath, coverPath: a.cover_path, coverText: a.cover_text, dropCover: a.letter_sent === false && job.status !== "applied" });
  if (before) out.already_waiting = true; // the job was already waiting on the user for this
  if (a.questions?.length) {
    out.questions = store.addQuestions(a.job_id, a.questions);
    out.questions_added = out.questions.filter((q) => q.result === "added" || q.result === "grouped").length;
  }
  if (a.status === "needs_account") out.same_account = store.sameAccountIssues(a.job_id);
  if (a.status === "blocked") out.same_site = store.sameSiteIssues(a.job_id, a.status);
  return out;
}

/** Drops the settings the agent may never change (terms, sharing choices, integrity records). */
export function agentSettingsPatch(rules, patch) {
  const locked = new Set(rules.agent_locked_settings || ["legal", "sharing", "setup_complete"]);
  return Object.fromEntries(Object.entries(patch || {}).filter(([k]) => !locked.has(k)));
}

// What the agent may write, beyond each field having the type of its default: choices, nullable numbers and yes/no
// fields, the two résumé fields it fills (the files are the user's uploads), and fields another tool keeps.
const SETTING_CHOICES = {
  "targets.pay_period": ["year", "hour", "month"], "targets.work_modes": ["onsite", "hybrid", "remote"],
  "targets.seniority": ["internship", "entry", "mid", "senior", "lead"], "eligibility.clearance": ["none", "eligible", "active"],
  "cover_letter.write": ["when_slot", "when_required"], "cover_letter.length": Object.keys(store.COVER_LENGTHS),
  "cover_letter.tone": ["professional", "warm", "enthusiastic", "direct"], "gmail.action": ["none", "star", "label", "star_and_label"] };
const NULLABLE = { "targets.min_pay": "number", "targets.max_commute_miles": "number", "eligibility.years_experience": "number",
  "eligibility.work_authorized": "boolean", "eligibility.needs_sponsorship": "boolean" };
const AGENT_FIELDS = { resume: ["text", "profile"] };
const KEPT_BY = { "gmail.last_check": "freeapply_check_replies sets it when a check finishes",
  "gmail.manual_logins": "only the user chooses it, in the dashboard's Settings → Email replies" };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const kindOf = (v) => (Array.isArray(v) ? "a list of text" : typeof v === "string" ? "text" : typeof v === "boolean" ? "true or false"
  : typeof v === "number" ? "a number" : "an object");

function fieldProblem(key, v, def) {
  const choices = SETTING_CHOICES[key];
  if (choices) {
    if (Array.isArray(def)) return Array.isArray(v) && v.every((x) => choices.includes(x)) ? null : `${key} must be a list of: ${choices.join(", ")}`;
    return choices.includes(v) ? null : `${key} must be one of: ${choices.join(", ")}`;
  }
  if (NULLABLE[key] === "number") return v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0) ? null : `${key} must be a number of 0 or more, or null`;
  if (NULLABLE[key] === "boolean") return v === null || typeof v === "boolean" ? null : `${key} must be true, false or null (not known)`;
  if (Array.isArray(def)) return Array.isArray(v) && v.every((x) => typeof x === "string") ? null : `${key} must be a list of text`;
  if (isObj(def)) return isObj(v) ? null : `${key} must be an object`;
  if (def !== null && typeof v !== typeof def) return `${key} must be ${kindOf(def)}`;
  return null;
}

/** Refuses a settings patch the agent can't make: an unknown section or field, a value of the wrong type or outside its
 * choices, the résumé's files, or a field another tool keeps. The error lists every problem and what is allowed. */
export function checkSettingsPatch(patch) {
  const base = store.settingsDefaults(), probs = [];
  for (const [section, value] of Object.entries(patch)) {
    if (!(section in base)) {
      probs.push(`no section ${section} (sections: ${Object.keys(base).join(", ")})`);
      continue;
    }
    if (section === "models") continue; // the scan has its own check (models.cleanScan)
    if (!isObj(value)) {
      probs.push(`${section} must be an object of fields`);
      continue;
    }
    if (section === "custom_answers") {
      for (const [q, ans] of Object.entries(value)) if (typeof ans !== "string") probs.push(`custom_answers["${q}"] must be text`);
      continue;
    }
    const fields = AGENT_FIELDS[section] || Object.keys(base[section]);
    for (const [field, v] of Object.entries(value)) {
      const key = `${section}.${field}`;
      if (KEPT_BY[key]) probs.push(`${key} can't be set here: ${KEPT_BY[key]}`);
      else if (!fields.includes(field)) {
        probs.push(`no field ${key} (${AGENT_FIELDS[section] ? "you can set" : "fields"}: ${fields.join(", ")}` +
          `${section === "resume" ? "; the user adds résumé files in the dashboard" : ""})`);
      } else {
        const p = fieldProblem(key, v, base[section][field]);
        if (p) probs.push(p);
      }
    }
  }
  if (probs.length) throw new Error(`settings not saved: ${probs.join("; ")}`);
}

// ───────────────────────────── truthfulness check ─────────────────────────────

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const present = (term, text) => new RegExp(`(?<![a-z0-9+#.])${esc(term)}(?![a-z0-9+#])`).test(text);
const numberIn = (num, text) => new RegExp(`(?<!\\d)${esc(num)}(?!\\d)`).test(text);
// Other forms of a claim word that back it: the résumé's "Leads a crew" backs a letter's "lead" or "led". Nouns such
// as "manager" stay out, so "reported to the manager" never backs "managed".
const CLAIM_FORMS = { lead: ["leads", "leading", "led"], led: ["lead", "leads", "leading"],
  leader: ["lead", "leads", "leading", "led"], managed: ["manage", "manages", "managing"],
  supervised: ["supervise", "supervises", "supervising"], mentored: ["mentors", "mentoring"],
  spearheaded: ["spearhead", "spearheads", "spearheading"], directed: ["directs", "directing"] };
const claimBacked = (word, blob) => [word, ...(CLAIM_FORMS[word] || [])].some((f) => present(f, blob));

/** Everything the user has said about themselves: resume text and profile, settings, saved and job answers. */
export function factBlob(s, jobId) {
  const parts = [];
  const walk = (x) => {
    if (typeof x === "string" || typeof x === "number") parts.push(String(x));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  [s.resume.text, s.resume.profile, s.profile, s.targets, s.eligibility, s.custom_answers, s.cover_letter?.highlights].forEach(walk);
  if (jobId) store.all("SELECT answer FROM job_questions WHERE job_id=? AND answer IS NOT NULL", jobId).forEach((r) => walk(r.answer));
  return parts.join("\n").toLowerCase();
}

/** The words-per-letter range for the user's length choice, kept inside the signed minimum and maximum. */
export function coverRange(rules, pref = {}) {
  const [lo, hi] = store.COVER_LENGTHS[pref.length] || store.COVER_LENGTHS.standard;
  return [Math.max(lo, rules.cover_words_min || 120), Math.min(hi, rules.cover_words_max || 380)];
}

// ───────────────────────────── ATS keywords ─────────────────────────────

/** The posting's keywords an applicant tracking system looks for: skills, tools and credentials from the signed
 * vocabulary and the user's own résumé profile and target keywords. matched: the user's facts support them (use them,
 * worded as the posting words them); missing: they don't (never claim them). The same test as the truthfulness check. */
export function postingKeywords(rules, text, s = store.loadSettings()) {
  const low = String(text || "").toLowerCase(), blob = factBlob(s);
  const vocab = new Map();
  const addTerm = (t) => { const k = String(t || "").trim().toLowerCase(); if (k.length > 1 && k.length <= 40 && !vocab.has(k)) vocab.set(k, String(t).trim()); };
  [s.resume.profile?.skills, s.resume.profile?.certifications, s.targets?.keywords, rules.tech_terms].forEach((l) => (l || []).forEach(addTerm));
  const matched = [], missing = [];
  for (const [k, shown] of vocab) {
    if (!present(k, low)) continue;
    (present(k, blob) ? matched : missing).push(shown);
  }
  const total = matched.length + missing.length;
  return { matched: matched.slice(0, 40), missing: missing.slice(0, 40), coverage: total ? Math.round(matched.length / total * 100) : null };
}

// Postings fetched in this session, by URL, so a job claimed with the same URL keeps its keywords and text.
const recent = new Map();
export function rememberPosting(urls, text, keywords) {
  for (const u of urls.filter(Boolean)) recent.set(String(u), { text: String(text || "").slice(0, 4000), keywords });
  while (recent.size > 100) recent.delete(recent.keys().next().value);
}

/** Which of the job's matched keywords a text uses, and which it could still use truthfully. */
export function keywordUse(jobId, text) {
  const row = jobId && store.one("SELECT keywords FROM jobs WHERE id=?", jobId);
  if (!row?.keywords) return null;
  const { matched = [] } = JSON.parse(row.keywords), low = String(text || "").toLowerCase();
  return { used: matched.filter((k) => present(k.toLowerCase(), low)), unused: matched.filter((k) => !present(k.toLowerCase(), low)) };
}

/** Saves a cover letter that passed the check as a text PDF in the documents folder, ready to upload, and keeps it
 * with the job's application, so freeapply_update_job records it without the agent sending the text again. */
export function saveCoverLetter(jobId, text) {
  const job = store.getJob(jobId);
  if (!job) throw new RuleError(`no job ${jobId}; find its id with freeapply_list_jobs`);
  if (job.status === "applied") throw new RuleError(`job ${jobId} was already applied to; its cover letter can't change`);
  const s = store.loadSettings(), p = s.profile, docs = store.documentsInfo(s);
  const clean = (t) => String(t || "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const name = `Cover letter - ${clean(p.full_name) || "applicant"} - ${clean(job.company) || "employer"} - ${job.id}.pdf`;
  const contact = [p.email, p.phone, [p.city, p.region].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const pdf = letterPdf({ title: `Cover letter - ${p.full_name || ""} - ${job.company || ""}`, author: p.full_name || "",
    header: [p.full_name, contact, date], body: text });
  fs.mkdirSync(docs.cover_letters, { recursive: true });
  const file = path.join(docs.cover_letters, name);
  fs.writeFileSync(file, pdf);
  store.setCoverLetter(jobId, file, text);
  return { path: file, name, bytes: pdf.length };
}

/** Problems with a piece of prose the agent wants to submit. An empty list means it passed. */
export function checkText(rules, text, { kind = "answer", jobId = null, company = null } = {}) {
  const probs = [], low = String(text || "").toLowerCase();
  const blob = factBlob(store.loadSettings(), jobId);
  // What the job itself says: its posting, title, pay, place and posting id (a letter may cite "BEC-JE-2207").
  const job = jobId ? store.one("SELECT description, title, company, location, pay_text, external_id FROM jobs WHERE id=?", jobId) : null;
  const posting = Object.values(job || {}).filter(Boolean).join("\n").toLowerCase();
  for (const term of rules.tech_terms || []) {
    if (present(term, low) && !present(term, blob)) probs.push(`'${term}' is not in the resume or settings`);
  }
  for (const w of rules.claim_words || []) {
    if (present(w, low) && !claimBacked(w, blob)) probs.push(`claim word '${w}' is not supported by the resume or settings`);
  }
  for (const ban of rules.bans || []) {
    for (const m of low.matchAll(new RegExp(ban.pattern, "g"))) {
      if (!blob.includes(m[0])) {
        probs.push(`${ban.why} ('${m[0]}')`);
        break;
      }
    }
  }
  for (const num of new Set(String(text || "").match(/\d[\d,.]*\d|\d/g) || [])) {
    // Numbers must come from the user's facts; the posting may supply numbers about the job itself.
    if (!numberIn(num, blob) && !numberIn(num.replace(/,/g, ""), blob) && !numberIn(num, posting)) {
      probs.push(`number '${num}' is not in the resume, settings or posting`);
    }
  }
  if (kind === "cover_letter") {
    const n = low.split(/\s+/).filter(Boolean).length;
    const [lo, hi] = coverRange(rules, store.loadSettings().cover_letter);
    if (n < lo || n > hi) probs.push(`cover letter is ${n} words; the user's length choice needs ${lo} to ${hi}`);
    const signOff = String(store.loadSettings().cover_letter?.sign_off || "").trim();
    const flat = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
    if (signOff && !flat(text).endsWith(flat(signOff))) probs.push(`end the letter with the user's sign-off: "${signOff.replace(/\s+/g, " ")}"`);
    if (/\[[^\]]*\]|TODO|XX+|lorem/i.test(text)) probs.push("placeholder text found");
    if (company && !low.includes(company.toLowerCase())) probs.push(`letter never mentions ${company}`);
  }
  return probs;
}
