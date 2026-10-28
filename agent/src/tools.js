// MCP tools and the gates in front of them: workflow integrity first, then the user's acceptance of the Terms.
import * as store from "./store.js";
import * as sharing from "./sharing.js";
import * as dashboard from "./dashboard.js";
import { fetchPosting } from "./postings.js";
import * as rules from "./rules.js";
import * as autorun from "./autorun.js";
import * as updater from "./updater.js";
import * as errorlog from "./errorlog.js";

const S = (props = {}, required) => ({ type: "object", properties: props, ...(required ? { required } : {}) });
// Parameter helpers: every parameter carries a description, and a fixed set of values is declared as an enum.
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const oneOf = (values, description) => ({ type: "string", enum: values, description });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const num = (description) => ({ type: "number", description });
const list = (description) => ({ type: "array", items: { type: "string" }, description });
const JOB_ID = int("The job's id, as returned by freeapply_add_job or freeapply_list_jobs.", { minimum: 1 });
// MCP tool annotations: what a call can change, so clients can show it and decide when to ask the user.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SET = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const STATUS_IDS = Object.keys(store.STATUSES), OUTCOME_IDS = Object.keys(store.OUTCOMES), SITE_IDS = store.JOB_SITES.map((x) => x.id);
const listed = (o) => Object.entries(o).map(([k, v]) => `${k} (${v})`).join(", ");

// Tools usable while the workflow is locked (so the user can be told why), and before the Terms are accepted.
const WORKFLOW_UNGATED = new Set(["freeapply_status", "freeapply_open_dashboard"]);
const CONSENT_UNGATED = new Set(["freeapply_status", "freeapply_open_dashboard", "freeapply_workflow"]);

const scalars = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || ["number", "string", "boolean"].includes(typeof v)));

// [name, title, annotations, description, inputSchema, handler]. Descriptions say what a tool does, when to use it
// (and which neighbour to use instead), and what it returns or changes.
export const TOOLS = [
  // ── session start ──
  ["freeapply_status", "Check that FreeApply can run", READ,
    "Checks whether FreeApply can be used right now; call it first in every session. Unlike freeapply_get_settings " +
    "(the user's settings) and freeapply_get_stats or freeapply_list_jobs (the job search itself), it answers \"can I " +
    "work?\". Returns: workflow (ok, or why the signed workflow is locked), terms (ok when the user accepted the Terms), " +
    "setup_complete and missing (required settings not filled in), sites (each chosen job site and whether it is ready), " +
    "autorun (unattended-run state), update (a newer version, if any), dashboard (local URL), data_dir and stats " +
    "(counts). Starts the local dashboard if it is not running; changes no data. If workflow.ok or terms.ok is false, " +
    "follow the freeapply-setup procedure before anything else.",
    S(), async (a, ctx) => {
      const { recent, ...auto } = autorun.status();
      return { ...store.bootstrap(), workflow: ctx.guard.status, terms: sharing.consentStatus(), dashboard: await dashboard.start(),
        sites: store.siteReadiness(), autorun: auto, update: updater.info(), stats: scalars(store.stats()) };
    }],
  ["freeapply_open_dashboard", "Open the dashboard in the browser", READ,
    "Opens the local dashboard (http://127.0.0.1:7878, or the next free port; reachable only from this computer) in " +
    "the user's browser, starting it if needed. Use it whenever the user must act there: accept the Terms, fill in " +
    "Settings, answer questions on the Needs you tab, or review applications. Returns url and opened. If the dashboard " +
    "could not start (no free port), url is null and opened is false: tell the user. If a browser could not be opened, " +
    "give the user the url to open themselves.",
    S({ tab: oneOf(["overview", "applications", "replies", "issues", "settings"], "Tab to show. Optional; default overview.") }),
    async (a) => {
      const url = await dashboard.start();
      if (url) dashboard.openBrowser(url + (a.tab ? `#${a.tab}` : ""));
      return { url, opened: !!url };
    }],
  ["freeapply_workflow", "Get a signed procedure", READ,
    "Gets the signed, step-by-step procedure for a task. Call it after freeapply_status reports everything ok and before " +
    "starting the task, then follow the returned text exactly; it says which tools to call in which order. Tasks: " +
    "freeapply-setup (first run and the check at the start of a session), freeapply-apply (find jobs and apply) and " +
    "freeapply-replies (Gmail reply check). With a name, returns name, description, text (the procedure in Markdown), " +
    "workflow_version and workflow_hash. Without a name, returns procedures (each name with its description).",
    S({ name: oneOf(["freeapply-setup", "freeapply-apply", "freeapply-replies"], "Procedure to get. Optional; omit to list the procedures.") }),
    (a, ctx) => {
      const b = ctx.guard.bundle, procs = b.procedures || {};
      const meta = { workflow_version: b.version, workflow_hash: ctx.guard.status.hash };
      if (!a.name) return { ...meta, procedures: Object.fromEntries(Object.entries(procs).map(([k, v]) => [k, v.description])) };
      const p = procs[a.name];
      if (!p) throw new Error(`no procedure ${a.name}; available: ${Object.keys(procs).join(", ")}`);
      return { name: a.name, description: p.description, text: p.text, ...meta };
    }],

  // ── the user's settings and résumé ──
  ["freeapply_get_settings", "Read the user's settings", READ,
    "Reads the user's settings from this computer. Call it before scoring jobs or filling in a form: it is the only " +
    "source of facts about the user besides the résumé and their own words, so never invent anything it doesn't contain. " +
    "Returns settings, with these sections: profile (name, contact details, links), targets (roles, pay floor, " +
    "locations, work modes, keywords), eligibility (work authorization, sponsorship, start date), resume (file paths, " +
    "text, profile), automation (job sites, pace, daily cap), autorun, gmail (reply-check preferences), custom_answers " +
    "(saved answers) and sharing (choices only; no secrets). Also returns missing: the required fields still empty, " +
    "each with key and label.",
    S(), () => ({ settings: store.publicSettings(store.loadSettings()), missing: store.missingFields() })],
  ["freeapply_update_settings", "Update the user's settings", SET,
    "Saves settings the user told you, deep-merged into the current ones: only the fields in patch change, and arrays " +
    "are replaced whole. Use only values the user stated; never guess or infer them. You may change profile, targets, " +
    "eligibility, resume, gmail and custom_answers. Ignored here, because only the user changes them in the dashboard: " +
    "legal (Terms), sharing, automation (job sites, pace, daily cap), autorun, onboarding and integrity. Returns " +
    "setup_complete and missing (required fields still empty).",
    S({ patch: { type: "object", description: "The fields to change, nested by section, e.g. {\"targets\": {\"min_pay\": 60000, " +
      "\"locations\": [\"Denver, CO\"]}} or {\"profile\": {\"phone\": \"+1 555 0100\"}}. Field names are as freeapply_get_settings returns them." } }, ["patch"]),
    (a, ctx) => {
      const s = store.saveSettings(rules.agentSettingsPatch(ctx.rules(), a.patch));
      return { setup_complete: s.setup_complete, missing: store.missingFields(s) };
    }],
  ["freeapply_save_resume", "Save the résumé text and profile", SET,
    "Stores what setup reads from the user's résumé file (its path is settings.resume.primary): the plain text, and a " +
    "structured profile taken only from that text (headline, skills, job titles, education, certifications). Call it " +
    "during setup, after reading the file, and again only if the user changes their résumé. Pass the text, profile " +
    "fields, or both; what you pass replaces what was saved, and what you omit stays. The truthfulness check and fit " +
    "scoring rely on it, so include nothing the résumé doesn't say. Returns saved (what was stored), setup_complete and missing.",
    S({ text: str("The résumé's full plain text, as read from the file."), headline: str("One-line professional headline from the résumé."),
      skills: list("Skills and tools named in the résumé."), titles: list("Job titles held, as written in the résumé."),
      education: list("Degrees and schools."), certifications: list("Certifications and licenses.") }), (a) => {
      const profile = Object.fromEntries(["headline", "skills", "titles", "education", "certifications"].filter((k) => a[k] != null).map((k) => [k, a[k]]));
      if (a.text == null && !Object.keys(profile).length) throw new Error("pass the résumé text, profile fields, or both");
      const s = store.saveSettings({ resume: { ...(a.text != null ? { text: a.text } : {}), ...(Object.keys(profile).length ? { profile } : {}) } });
      return { setup_complete: s.setup_complete, missing: store.missingFields(s), saved: { text: a.text != null, profile: Object.keys(profile) } };
    }],

  // ── finding and claiming jobs ──
  ["freeapply_fetch_posting", "Fetch a job posting", { ...READ, openWorldHint: true },
    "Fetches a job posting on the user's computer and returns it compactly. Use it instead of reading the whole page in " +
    "a browser; it saves tokens. Reads Greenhouse, Lever and Ashby postings through their public APIs (with the " +
    "application form's questions), and other sites as plain page text. Returns ats (the platform or host), title, " +
    "company, location, work_mode and pay when known, description (trimmed to max_chars), description_chars (its full " +
    "length), questions (the form's questions, each with label, required, type and options) and suggested_answers " +
    "(answers taken from the user's settings and saved answers; answer anything else only from the résumé or the user).",
    S({ url: str("The posting's URL: the job page or its application form."),
      max_chars: int("Longest description to return, in characters. Optional; default 6000.", { minimum: 500, default: 6000 }),
      source: str("Where the posting was found, as a job site id (linkedin, indeed, company_sites, ...). Optional; helps pick suggested answers.") }, ["url"]),
    (a) => fetchPosting(a.url, a.max_chars || 6000, a.source)],
  ["freeapply_check_duplicate", "Find already-tracked jobs at a company", READ,
    "Before claiming a job with freeapply_add_job, finds jobs already tracked at the same company (company name, not case " +
    "sensitive) or with the same posting id, so you never apply twice, reposts included. A title doesn't narrow the " +
    "search: every job at the company is returned, and those with the same title are marked same_title: true. Returns " +
    "matches: a list of {id, title, company, status, same_title}; an empty list means no earlier job. Treat a same_title " +
    "match with status applied as a repost and skip it.",
    S({ company: str("Employer name as shown in the posting."), title: str("Job title. Optional; marks matches with the same title."),
      external_id: str("The posting's id on its source site. Optional; also finds the exact posting.") }, ["company"]),
    (a) => ({ matches: store.findDuplicates(a.company, a.title, a.external_id) })],
  ["freeapply_add_job", "Track a job", ADD,
    "Claims a job before you work on it and returns its job_id, which every later call about the job needs. Call " +
    "freeapply_check_duplicate first. Returns {job_id, existing}: existing is true when the same posting id was already " +
    "tracked (nothing new is added). Refused, with refused explaining why, for jobs from a site the user didn't choose " +
    "and for a job with the same company and title as one already applied to. A job whose posted pay is below the " +
    "user's minimum is recorded with status skipped and rule pay_floor.",
    S({ title: str("Job title."), company: str("Employer name."), location: str("Location as posted."),
      work_mode: str("remote, hybrid or onsite, as posted."), pay_text: str("Pay exactly as posted, e.g. \"$90k-$110k\"."),
      pay_min: num("Lowest posted pay as a number (annual, or hourly if posted hourly)."), pay_max: num("Highest posted pay as a number."),
      url: str("The posting's URL."), apply_url: str("Where the application form is, if different."),
      description: str("Short description or key requirements."), fit_score: int("Fit from 0 to 100, as the procedure describes.", { minimum: 0, maximum: 100 }),
      fit_notes: str("Why it fits or doesn't, in a sentence."), status: oneOf(["found", "skipped"], "found to work on it (default), skipped to record a job that doesn't fit."),
      status_note: str("Reason, for a skipped job."), source: str("Where it was found: a job site id (linkedin, indeed, company_sites, ...) or referral."),
      external_id: str("The posting's id on its source site, used to spot reposts.") }, ["title", "company"]),
    (a, ctx) => rules.claimJob(ctx.rules(), a)],

  // ── applying ──
  ["freeapply_check_text", "Check text for unsupported claims", READ,
    "Truthfulness check: call it before typing a cover letter or any free-text answer into a form. Compares the text " +
    "with the saved résumé text and profile (freeapply_save_resume must have run), the settings and the user's saved " +
    "answers, and lists tools, skills, claim words, numbers and years of experience they don't support; for a cover " +
    "letter it also checks the length and leftover placeholders. Returns ok and problems (a list of sentences). Fix or " +
    "remove each problem, or ask the user, then check again. freeapply_update_job runs the same check on cover_text and " +
    "refuses a failing letter.",
    S({ text: str("The cover letter or answer to check."), kind: oneOf(["cover_letter", "answer"], "What the text is. Optional; default answer."),
      job_id: { ...JOB_ID, description: "The job it is for. Optional; numbers from its posting and the user's answers for it then count as supported." },
      company: str("The employer it is addressed to. Optional; a cover letter that never mentions it is flagged.") }, ["text"]),
    (a, ctx) => {
      const problems = rules.checkText(ctx.rules(), a.text, { kind: a.kind || "answer", jobId: a.job_id, company: a.company });
      return { ok: !problems.length, problems };
    }],
  ["freeapply_answers", "Get or save the user's answers", { ...SET, idempotentHint: true },
    "The user's answers to application questions. action get (read-only): returns {job_id, answers, saved_answers}: " +
    "answers is the list of {label, answer} the user gave on the dashboard's Needs you tab for that job, and saved_answers " +
    "maps questions to the user's reusable answers. Call it before retrying a job the user re-queued, and use these " +
    "answers instead of guessing. action save: keeps an answer the user gave you in this conversation for reuse on " +
    "later forms (an empty answer removes it), and returns {label, saved, removed, saved_answers}. Save only the user's " +
    "own words, never your guess: saved answers count as facts in the truthfulness check.",
    S({ action: oneOf(["get", "save"], "get a job's answers, or save one reusable answer."),
      job_id: { ...JOB_ID, description: "For get: the job whose answers you need." },
      label: str("For save: the question, worded as forms ask it, e.g. \"Are you willing to relocate?\"."),
      answer: str("For save: the user's answer in their words; empty to remove a saved answer.") }, ["action"]),
    (a) => {
      if (a.action === "save") return store.saveAnswer(a.label, a.answer);
      if (a.action !== "get") throw new Error("action must be get or save");
      if (!a.job_id) throw new Error("job_id is required for get");
      return store.jobAnswers(a.job_id);
    }],
  ["freeapply_site_account", "Look up an employer-site account", READ,
    "Looks up (read-only) whether the user already has an account on an employer's careers site and which email they " +
    "used. Call it when an application form asks you to sign in or create an account. It records nothing: the user " +
    "records accounts they create on the dashboard's Needs you tab. Returns {domain, email_used, created_at, job_id, note} " +
    "when an account is known, or {domain, account: null} when not. Passwords are never stored: if an account exists, " +
    "ask the user to sign in in the browser, then continue in their session; if not, mark the job needs_account with " +
    "freeapply_update_job. For job boards that signed the user out, use freeapply_site_status instead; for jobs already tracked, freeapply_check_duplicate.",
    S({ site: str("The employer site's domain or any URL on it, e.g. careers.example.com or the application form's URL.") }, ["site"]),
    (a) => store.siteAccount(a.site)],
  ["freeapply_throttle", "Get clearance to submit", ADD,
    "Call it right before every submit, with the job_id. Enforces the pace limit (at most 3 submissions a minute, or " +
    "the user's slower setting) and the user's daily cap. Returns clear (true or false), advice, last_minute, " +
    "limit_per_minute, today and daily_cap. When clear is true and job_id was given, it also returns clearance " +
    "{job_id, expires_at}: submit within 15 minutes, then record it with freeapply_update_job status applied, which is " +
    "refused without it. When clear is false, don't submit; work on the next job and call again later. Easy-apply is " +
    "refused (clear false, with refused) unless the user allowed one-click apply.",
    S({ job_id: JOB_ID, method: oneOf(["external", "easy_apply", "email"], "How you will submit. Optional; default external (an employer or ATS form).") }),
    (a, ctx) => rules.throttle(ctx.rules(), a.method || "external", a.job_id)],
  ["freeapply_update_job", "Update a job's application status", SET,
    "Records your side of an application: its pipeline status, from found to applied or the reason it stopped. Not for " +
    "what the employer did: use freeapply_record_reply for an employer email, or freeapply_set_outcome for anything " +
    "else. Rules: status applied needs a clearance from freeapply_throttle for this job; cover_text must pass the " +
    "truthfulness check. For needs_info, pass the form's open questions; the user answers them on the dashboard's Needs " +
    "you tab, which puts the job back in the queue. Each question is checked against what already waits on the user and " +
    "what they answered before: needs_info is refused when the user already answered every question (the error lists " +
    "the answers: use them), and a question asked by other jobs too is shown once. Returns {job_id, status}, plus " +
    "already_waiting when the job already had that status, questions (each with result: added, duplicate, grouped or " +
    "already_answered with its answer) and questions_added, for needs_account same_account (other jobs whose account is " +
    "made at the same address: they share one card) and for blocked same_site (other jobs blocked on the same site); or " +
    "an error explaining what is missing.",
    S({ job_id: JOB_ID, status: oneOf(STATUS_IDS, `New status: ${listed(store.STATUSES)}.`),
      note: str("What happened, in one plain sentence the user will read on the dashboard: no code, page elements or " +
        "technical terms, e.g. \"The site asked to prove you're a person.\""),
      account_url: str("For needs_account: the full link to the page where the user makes the account (the site's " +
        "sign-up page). Jobs whose account is made at the same address share one card, and one \"I made the account\" " +
        "re-queues them all; without it the application link is used, so jobs rarely share."),
      method: oneOf(["easy_apply", "external", "email"], "How it was submitted, for applied."), confirmation: str("Confirmation text or number the site showed."),
      resume_path: str("Path of the résumé file submitted."), cover_path: str("Path of the cover-letter file submitted."),
      cover_text: str("The cover letter actually submitted; it must pass the truthfulness check."),
      questions: { type: "array", description: "For needs_info: the form's unanswered questions. Give each a plain prompt and " +
        "the simplest kind of answer that fits: a choice with options (or yesno) when the form offers fixed answers, multi " +
        "when it takes several, text otherwise.",
        items: { type: "object", properties: { label: str("The question exactly as the form words it (you need it to fill the form later)."),
          prompt: str("The question in plain words for the user: one short sentence, no form codes or jargon, e.g. " +
            "\"Can you work weekends?\" for \"Availability - Sat/Sun shifts (Y/N)*\"."),
          help: str("Optional one-line hint the user sees under the prompt: why it's asked or what a good answer looks like."),
          type: oneOf(["text", "textarea", "yesno", "choice", "multi", "number", "date"], "Kind of answer: text or textarea (open-ended, " +
            "short or long), yesno, choice (pick one; buttons for up to 5 options, a dropdown for more), multi (pick all that " +
            "apply), number or date."),
          options: list("Choices, for choice or multi, worded as the form offers them."),
          required: { type: "boolean", description: "Whether the form requires it." } }, required: ["label"] } } },
    ["job_id", "status"]),
    (a, ctx) => rules.agentSetStatus(ctx.rules(), a)],
  ["freeapply_site_status", "Report a job site signed out or limited", SET,
    "Reports a problem with one of the user's job sites: it signed the user out (signed_out), or showed its own daily " +
    "limit (limit_reached). freeapply_status lists which sites are ready; this tool is how you tell FreeApply that one " +
    "isn't. A signed-out site stays unavailable until the user signs in again and confirms it in the dashboard; a " +
    "limited site is paused until tomorrow. Reporting the same thing twice changes nothing. Never type a password: keep " +
    "applying on the other ready sites or on company career sites. Returns {site, status, sites}, where sites lists " +
    "each chosen site with ready.",
    S({ site: oneOf(SITE_IDS, "The job site."), status: oneOf(["signed_out", "limit_reached"], "What the site showed.") }, ["site", "status"]),
    (a) => {
      store.markSite(a.site, a.status);
      return { site: a.site, status: a.status, sites: store.siteReadiness() };
    }],
  ["freeapply_autorun", "Control an unattended run", ADD,
    "For unattended (scheduled) runs. The schedule itself lives in the user's AI app (its scheduled or recurring tasks), " +
    "not in FreeApply: create, change or remove it there, then report it here so the dashboard shows it. Actions and " +
    "what they return: start asks whether a run may go now ({go: true, run_id, minutes, max_applications, sites}, or " +
    "{go: false, reason}: then stop at once, quietly); check, before each new job, with run_id ({go, reason, " +
    "applied_this_run}; stop when go is false); finish ends the run with a one-line summary ({finished, " +
    "applied_this_run}); schedule_created and schedule_removed record the scheduled task you made or deleted " +
    "({schedule_created}). The run and application budgets, the daily cap and the dashboard's Stop button are enforced " +
    "by start and check.",
    S({ action: oneOf(["start", "check", "finish", "schedule_created", "schedule_removed"], "What to do."),
      run_id: str("The run_id that start returned; needed for check and finish."), summary: str("One-line summary, for finish.") }, ["action"]),
    (a) => {
      switch (a.action) {
        case "start": return autorun.start();
        case "check": return autorun.check(a.run_id);
        case "finish": return autorun.finish(a.run_id, a.summary);
        case "schedule_created": return autorun.scheduleReported(true);
        case "schedule_removed": return autorun.scheduleReported(false);
        default: throw new Error("action must be start, check, finish, schedule_created or schedule_removed");
      }
    }],

  // ── tracking and replies ──
  ["freeapply_list_jobs", "List tracked jobs", READ,
    "Lists the user's tracked jobs, most recent activity first (submitted, else updated, else found). Use it to find a " +
    "job_id or to answer questions about particular jobs; for totals and rates use freeapply_get_stats. Filters: status " +
    "and outcome match exactly; search matches text in the title, company or location (not case sensitive). Returns a " +
    "list of jobs, each with id, title, company, location, work_mode, pay_text, pay_min, pay_max, url, apply_url, " +
    "fit_score, status, status_note, outcome, outcome_at, source, found_at, updated_at, method, submitted_at, " +
    "confirmation, resume_path, cover_path and reply_count. Page with limit and offset: fewer than limit jobs means the end.",
    S({ status: oneOf(STATUS_IDS, "Only jobs with this status. Optional."), outcome: oneOf(OUTCOME_IDS, "Only jobs with this employer outcome. Optional."),
      search: str("Text to find in the title, company or location. Optional."),
      limit: int("Most jobs to return. Optional; default 200.", { minimum: 1, maximum: 2000, default: 200 }),
      offset: int("Jobs to skip, for the next page. Optional; default 0.", { minimum: 0, default: 0 }) }),
    (a) => store.listJobs(a.status, a.outcome, a.search, a.limit || 200, a.offset || 0)],
  ["freeapply_get_stats", "Get job-search statistics", READ,
    "Summarizes the job search; use it to report progress. For the state of FreeApply itself use freeapply_status, and " +
    "for individual jobs freeapply_list_jobs. Returns tracked, applied, applied_today, queued, needs_you (jobs waiting " +
    "on the user), interviews, offers, rejections, acknowledged, response_rate, avg_fit, last_reply_check, " +
    "by_status, by_outcome and by_method (counts), daily (applications per day), and top_companies, top_titles and " +
    "top_jobs.",
    S(), () => store.stats()],
  ["freeapply_reply_check", "Start or finish a Gmail reply check", { ...ADD, idempotentHint: true },
    "Brackets the freeapply-replies procedure. action start (read-only) returns the plan: since (search Gmail from this " +
    "time), gmail (the user's mail action: none, star, label or star_and_label, plus label_name), applied (the jobs " +
    "applied to: job_id, company, title, submitted_at) and known_message_ids (already recorded: skip them). Then record " +
    "each employer email with freeapply_record_reply. action finish marks the check done, so the next one starts from " +
    "now, and returns last_check.",
    S({ action: oneOf(["start", "finish"], "start returns the plan; finish marks the check done.") }, ["action"]),
    (a) => {
      if (a.action === "start") return store.replyCheckPlan();
      if (a.action === "finish") return { last_check: store.markReplyCheckDone().gmail.last_check };
      throw new Error("action must be start or finish");
    }],
  ["freeapply_record_reply", "Record an employer email", { ...ADD, idempotentHint: true },
    "Records one employer email found during a reply check (between freeapply_reply_check start and finish). Stores " +
    "the email and raises the job's outcome when this email ranks higher than the current one (an interview request " +
    "outranks an acknowledgement; a lower-ranking email leaves the outcome as it is). Calling it again with the same " +
    "gmail_message_id stores nothing new. Use it whenever there is an email; use freeapply_set_outcome only for news " +
    "without one. Returns {recorded, kind}.",
    S({ job_id: { ...JOB_ID, description: "The job the email is about. Optional, but without it no outcome changes." },
      company: str("The employer that sent it."), gmail_message_id: str("Gmail message id; prevents recording it twice."),
      gmail_thread_id: str("Gmail thread id."), sender: str("Sender address."), subject: str("Subject line."),
      received_at: str("When it arrived (ISO 8601)."), kind: oneOf(OUTCOME_IDS, `What the email is: ${listed(store.OUTCOMES)}.`),
      summary: str("One sentence on what the email says (at most 20 words, no personal data beyond what is needed)."),
      mail_action: str("What you did with it in Gmail: starred, labeled:<name>, starred+labeled:<name> or none.") }, ["kind"]),
    (a) => store.recordReply(a)],
  ["freeapply_set_outcome", "Set the employer's outcome", SET,
    "Sets or corrects what the employer did with an application when there is no email to record: for example the " +
    "user tells you about a phone call, or an outcome is wrong. Overwrites the current outcome whatever its rank; an " +
    "empty string clears it. For an employer email use freeapply_record_reply instead, which also keeps the email. " +
    "Your own side of the application (applied, skipped, ...) is freeapply_update_job. Returns {job_id, outcome}.",
    S({ job_id: JOB_ID, outcome: { type: "string", enum: [...OUTCOME_IDS, ""], description: `${listed(store.OUTCOMES)}, or "" to clear.` } },
    ["job_id", "outcome"]),
    (a) => store.setOutcome(a.job_id, a.outcome)],

  // ── data sharing ──
  ["freeapply_shared_data", "Preview or send shared data", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    "The data the user chose to share with the FreeApply server. action preview (read-only, sends nothing) returns the " +
    "exact requests that would be sent under the user's current choices: analytics_request (anonymous usage and " +
    "job-market data) and the talent-pool request (only if the user joined it; secrets hidden). Use it when the user " +
    "asks what is shared. action sync sends it now instead of at the automatic sync every 12 hours, sends nothing for " +
    "choices that are off, and returns {sent, reason or result}; only when the user asks. The user changes the choices " +
    "themselves in the dashboard (Settings → Data sharing).",
    S({ action: oneOf(["preview", "sync"], "preview shows what would be sent; sync sends it now.") }, ["action"]),
    (a) => {
      if (a.action === "preview") return sharing.preview();
      if (a.action === "sync") return sharing.sync(true);
      throw new Error("action must be preview or sync");
    }],
].map(([name, title, annotations, description, inputSchema, handler]) => ({ name, title, annotations, description, inputSchema, handler }));

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const text = (out, isError = false) => ({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }], ...(isError ? { isError: true } : {}) });

let lastSkillCheck = 0;

/** Runs one tool call through the gates. ctx: { guard, rules() }. */
export async function callTool(name, args, ctx) {
  const tool = BY_NAME.get(name);
  if (!tool) return text(`error: unknown tool ${name}`, true);
  if (!ctx.guard.status.ok && !WORKFLOW_UNGATED.has(name)) {
    return text(`locked: FreeApply's signed workflow failed verification (${ctx.guard.status.problem}). Tell the user. ` +
      "Do not try to repair or edit FreeApply files; updating or reinstalling FreeApply restores it.", true);
  }
  if (!CONSENT_UNGATED.has(name) && !sharing.consentStatus().ok) {
    return text("locked: the user has not accepted the FreeApply Terms of Service. Call freeapply_open_dashboard and ask the " +
      "user to review and accept them in the dashboard. Do not accept on their behalf.", true);
  }
  if (ctx.guard.status.ok && Date.now() - lastSkillCheck > 30_000) {
    lastSkillCheck = Date.now();
    ctx.guard.checkSkills(); // edited skill files are restored and recorded
  }
  try {
    return text((await tool.handler(args || {}, ctx)) ?? {});
  } catch (e) {
    // Refusals and bad arguments are answers; anything unexpected also goes into the local problem log.
    if (errorlog.unexpected(e)) errorlog.record("tool", name, e);
    return text(`error: ${e.message}`, true); // tool errors go back to the model, not the protocol
  }
}
