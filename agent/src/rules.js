// Hard rules enforced in tool code, not only in prompt text: an AI can be talked out of a written rule, code cannot.
// Every limit comes from the signed workflow bundle (`bundle.rules`), so it cannot be edited on the user's computer.
import * as store from "./store.js";

export class RuleError extends Error {}

// ───────────────────────────── pacing: one-time clearance per submit ─────────────────────────────

const clearances = new Map(); // job id -> expiry (ms)
const issued = []; // when clearances were issued, so jobs not yet recorded still count toward the per-minute limit

/** Checks the pace limits; when clear and a job id is given, issues the clearance recording 'applied' needs. */
export function throttle(rules, method = "external", jobId) {
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
    advice: clear ? "submit now" : "wait and retry; work on the next job meanwhile" };
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

/** freeapply_add_job with the job-site, duplicate and pay-floor rules applied. */
export function claimJob(rules, j) {
  const ext = j.external_id || j.linkedin_job_id;
  const same = ext && store.one("SELECT id FROM jobs WHERE linkedin_job_id=? OR external_id=?", ext, ext);
  if (same) return { job_id: same.id, existing: true };
  const settings = store.loadSettings();
  const site = store.siteOf(j);
  if (site && !(settings.automation.sources || []).includes(site)) {
    const name = store.JOB_SITES.find((x) => x.id === site).name;
    return { refused: `${name} is not one of the job sites the user chose (Settings → Job sites). Do not use it (hard rule).` };
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
  const r = store.addJob(j);
  return rule ? { ...r, status: "skipped", rule } : r;
}

// ───────────────────────────── recording what the agent did ─────────────────────────────

/** freeapply_update_job: user-only statuses, the truthfulness check on cover letters, and the submit clearance. */
export function agentSetStatus(rules, a) {
  const job = store.getJob(a.job_id);
  if (!job) throw new RuleError(`no job ${a.job_id}`);
  if ((rules.user_only_statuses || []).includes(job.status) && a.status !== job.status) {
    throw new RuleError(`job ${a.job_id} is '${job.status}'; only the user can change that, in the dashboard (hard rule)`);
  }
  if (a.cover_text) {
    const problems = checkText(rules, a.cover_text, { kind: "cover_letter", jobId: a.job_id, company: job.company });
    if (problems.length) throw new RuleError(`cover letter failed the truthfulness check (hard rule): ${problems.join("; ")}`);
  }
  if (a.status === "applied" && job.status !== "applied" && !takeClearance(a.job_id)) {
    throw new RuleError("refused: call freeapply_throttle with this job_id right before submitting; recording 'applied' " +
      "needs that clearance (hard rule)");
  }
  return store.setStatus(a.job_id, a.status, { note: a.note, method: a.method, confirmation: a.confirmation,
    resumePath: a.resume_path, coverPath: a.cover_path, coverText: a.cover_text });
}

/** Drops the settings the agent may never change (terms, sharing choices, integrity records). */
export function agentSettingsPatch(rules, patch) {
  const locked = new Set(rules.agent_locked_settings || ["legal", "sharing", "setup_complete"]);
  return Object.fromEntries(Object.entries(patch || {}).filter(([k]) => !locked.has(k)));
}

// ───────────────────────────── truthfulness check ─────────────────────────────

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const present = (term, text) => new RegExp(`(?<![a-z0-9+#.])${esc(term)}(?![a-z0-9+#])`).test(text);
const numberIn = (num, text) => new RegExp(`(?<!\\d)${esc(num)}(?!\\d)`).test(text);

/** Everything the user has said about themselves: resume text and profile, settings, saved and job answers. */
export function factBlob(s, jobId) {
  const parts = [];
  const walk = (x) => {
    if (typeof x === "string" || typeof x === "number") parts.push(String(x));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  [s.resume.text, s.resume.profile, s.profile, s.targets, s.eligibility, s.custom_answers].forEach(walk);
  if (jobId) store.all("SELECT answer FROM job_questions WHERE job_id=? AND answer IS NOT NULL", jobId).forEach((r) => walk(r.answer));
  return parts.join("\n").toLowerCase();
}

/** Problems with a piece of prose the agent wants to submit. An empty list means it passed. */
export function checkText(rules, text, { kind = "answer", jobId = null, company = null } = {}) {
  const probs = [], low = String(text || "").toLowerCase();
  const blob = factBlob(store.loadSettings(), jobId);
  const posting = jobId ? (store.one("SELECT description FROM jobs WHERE id=?", jobId)?.description || "").toLowerCase() : "";
  for (const term of rules.tech_terms || []) {
    if (present(term, low) && !present(term, blob)) probs.push(`'${term}' is not in the resume or settings`);
  }
  for (const w of rules.claim_words || []) {
    if (present(w, low) && !present(w, blob)) probs.push(`claim word '${w}' is not supported by the resume or settings`);
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
    const lo = rules.cover_words_min || 120, hi = rules.cover_words_max || 380;
    if (n < lo || n > hi) probs.push(`cover letter is ${n} words; keep it between ${lo} and ${hi}`);
    if (/\[[^\]]*\]|TODO|XX+|lorem/i.test(text)) probs.push("placeholder text found");
    if (company && !low.includes(company.toLowerCase())) probs.push(`letter never mentions ${company}`);
  }
  return probs;
}
