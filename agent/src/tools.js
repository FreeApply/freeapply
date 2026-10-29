// MCP tools and the gates in front of them: workflow integrity first, then the user's acceptance of the Terms.
import * as store from "./store.js";
import * as sharing from "./sharing.js";
import * as dashboard from "./dashboard.js";
import { fetchPosting } from "./postings.js";
import * as rules from "./rules.js";
import * as autorun from "./autorun.js";
import * as updater from "./updater.js";
import * as errorlog from "./errorlog.js";
import * as models from "./models.js";
import * as secrets from "./secrets.js";
import { findReplies, markReply } from "./imap.js";

const S = (props = {}, required) => ({ type: "object", properties: props, ...(required ? { required } : {}) });
// Parameter helpers: every parameter carries a description, and a fixed set of values is declared as an enum.
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const oneOf = (values, description) => ({ type: "string", enum: values, description });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const num = (description) => ({ type: "number", description });
const list = (description) => ({ type: "array", items: { type: "string" }, description });
const JOB_ID = int("The job's id, as returned by freeapply_claim_job or freeapply_list_jobs.", { minimum: 1 });
// A description in labeled parts, one per line: what it does and how it differs from its neighbours, when to use it
// (and when not), behavior, parameters, returns, errors.
const desc = (...parts) => parts.join("\n");
// MCP tool annotations: what a call can change, so clients can show it and decide when to ask the user.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SET = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const STATUS_IDS = Object.keys(store.STATUSES), OUTCOME_IDS = Object.keys(store.OUTCOMES), SITE_IDS = store.JOB_SITES.map((x) => x.id);
const listed = (o) => Object.entries(o).map(([k, v]) => `${k} (${v})`).join(", ");

// Tools usable while the workflow is locked (so the user can be told why), and before the Terms are accepted.
const WORKFLOW_UNGATED = new Set(["freeapply_status", "freeapply_open_dashboard"]);
const CONSENT_UNGATED = new Set(["freeapply_status", "freeapply_open_dashboard"]);

const scalars = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || ["number", "string", "boolean"].includes(typeof v)));

// [name, title, annotations, description, inputSchema, handler]. Descriptions say what a tool does, when to use it
// (and which neighbour to use instead), and what it returns or changes.
export const TOOLS = [
  // ── session start ──
  ["freeapply_status", "Check FreeApply and get a procedure", READ,
    desc(
      "Whether FreeApply can work now, plus the signed step-by-step procedure for a task. About FreeApply itself " +
        "(user details: freeapply_get_settings; job search: freeapply_job_stats).",
      "Use: first in every session and before each task; again only to re-check after the user acts. Works while " +
        "locked or the Terms are unaccepted, so it can say why.",
      "Behavior: changes no user data. Creates the data folder on first run, starts the local dashboard if needed, " +
        "refreshes the résumé copy in the documents folder.",
      "Returns: workflow {ok, problem}, terms {ok}, setup_complete, missing, sites [{id, name, ready}] (chosen job " +
        "sites), autorun, update, dashboard (URL), data_dir, documents {dir, resume, cover_letters}, stats, " +
        "procedures, models {can_delegate, rescan, levels, lanes, unfilled} (each level and lane {model, effort, " +
        "source}; model current = your own model does it). With procedure also procedure {name, description, text, " +
        "workflow_version, workflow_hash}, null while locked.",
      "Next: workflow.ok false: tell the user why, stop. terms.ok or setup_complete false: follow freeapply-setup. " +
        "models.rescan true: do its AI models step first."),
    S({ procedure: oneOf(["freeapply-setup", "freeapply-apply", "freeapply-replies"], "Adds this task's procedure: freeapply-setup " +
      "(first run; Terms or settings missing), freeapply-apply (find jobs, apply), freeapply-replies (Gmail reply check). Omit for status only."),
      lane: oneOf(["scout", "writer", "applier"], "A helper's lane of freeapply-apply: only the hard rules and that lane's steps, with a short status. Optional; the agent that starts helpers omits it.") }),
    async (a, ctx) => {
      const { recent, ...auto } = autorun.status();
      const b = ctx.guard.bundle || {}, procs = b.procedures || {};
      const out = { ...store.bootstrap(), workflow: ctx.guard.status, terms: sharing.consentStatus(), dashboard: await dashboard.start(),
        sites: store.siteReadiness(), autorun: auto, update: updater.info(), documents: store.documentsInfo(),
        stats: scalars(store.stats()), procedures: Object.keys(procs), models: models.resolve({ rules: ctx.rules(), workflow: b.version ?? null }) };
      if (a.procedure) {
        const p = ctx.guard.status.ok ? procs[a.procedure] : null;
        if (ctx.guard.status.ok && !p) throw new Error(`no procedure ${a.procedure}; available: ${Object.keys(procs).join(", ")}`);
        const laneText = p && a.lane ? models.laneProcedure(p.text, ctx.rules().lane_steps?.[a.lane]) : null;
        out.procedure = p ? { name: a.procedure, description: p.description, text: laneText ?? p.text, ...(laneText ? { lane: a.lane } : {}),
          workflow_version: b.version, workflow_hash: ctx.guard.status.hash } : null;
        // A helper needs the gates, what it may use and where the documents are, not the lead agent's overview.
        if (laneText) {
          const { workflow, terms, setup_complete, missing, sites, documents, procedure } = out;
          return { workflow, terms, setup_complete, missing, sites, documents, procedure };
        }
      }
      return out;
    }],
  ["freeapply_open_dashboard", "Open the dashboard in the browser", READ,
    desc(
      "Opens the local FreeApply dashboard in the user's browser, one tab (freeapply_status only reports its URL).",
      "Use: when the user must act there: accept the Terms, fill settings, answer questions waiting on them, review " +
        "applications and replies. Not for reading data: other tools return it.",
      "Behavior: changes no data. Starts the dashboard if needed at http://127.0.0.1:7878 or the next free port; " +
        "reachable only from this computer.",
      "Returns: {url, opened}. url null: it couldn't start (no free port); tell the user. opened false with a url: " +
        "no browser launched; give the user the url."),
    S({ tab: oneOf(["overview", "applications", "replies", "issues", "settings"], "Page: overview (default; shows the Terms until " +
      "accepted), settings (setup fields), issues (Needs you: questions, sign-ups), applications, replies.") }),
    async (a) => {
      const url = await dashboard.start();
      const opened = url ? await dashboard.openBrowser(url + (a.tab ? `#${a.tab}` : "")) : false;
      return { url, opened };
    }],

  // ── the user's settings and résumé ──
  ["freeapply_get_settings", "Read the user's settings", READ,
    desc(
      "The user's settings: who they are, what they seek, how FreeApply should work; the facts about the user " +
        "(single form answers: freeapply_user_answers; whether FreeApply can run: freeapply_status).",
      "Use: once per session or helper, before scoring jobs or filling a form. With the résumé text and the user's " +
        "own words, the only source of facts about the user: never invent beyond it. To change: " +
        "freeapply_update_settings.",
      "Behavior: read-only; never includes installation secrets.",
      "Returns: {settings, missing}. Sections: profile, targets, eligibility, resume (file paths, text, profile), " +
        "cover_letter, automation, autorun, gmail, custom_answers, models, model_choices, sharing (choices only). " +
        "missing: required fields still empty [{key, label}]; while non-empty, apply nowhere: open the settings tab " +
        "(freeapply_open_dashboard) and ask the user to fill them.",
      "Errors: an unknown section; the message lists valid ones."),
    S({ sections: list("Sections to return (default all), e.g. [\"profile\", \"eligibility\"] for a form; omit resume, the " +
      "largest, unless you need its text.") }),
    (a) => {
      const all = store.publicSettings(store.loadSettings());
      const bad = (a.sections || []).filter((k) => !(k in all));
      if (bad.length) throw new Error(`no section ${bad.join(", ")}; sections: ${Object.keys(all).join(", ")}`);
      const settings = a.sections?.length ? Object.fromEntries(a.sections.map((k) => [k, all[k]])) : all;
      return { settings, missing: store.missingFields() };
    }],
  ["freeapply_update_settings", "Save settings and résumé", SET,
    desc(
      "Saves what the user told you, the résumé's text and profile (setup) and the AI models scan: the settings " +
        "themselves (single form answers: freeapply_user_answers; reading: freeapply_get_settings).",
      "Use: when the user states a fact or preference, in setup's résumé step, in the AI models step. Never fill a " +
        "field the user didn't give you.",
      "Behavior: overwrites the sent fields, no undo. Deep merge: only sent fields change, nested objects merge, " +
        "lists are replaced whole. User-only sections (legal, sharing, automation, autorun, onboarding, integrity, " +
        "model_choices) are skipped and listed in ignored. All or nothing: one wrong field saves nothing.",
      "Returns: {changed, ignored, setup_complete, missing}; after a scan also models (model and effort chosen per " +
        "level).",
      "Errors: nothing writable, unknown section or field, wrong type, value outside its choices (e.g. " +
        "cover_letter.length short|standard|long), résumé files (the user adds them in the dashboard), malformed " +
        "scan; the message names every problem."),
    S({ patch: { type: "object", description: "Fields to change, nested by section with freeapply_get_settings' names, e.g. " +
      "{\"targets\": {\"min_pay\": 60000}}. resume: only text and profile {headline, skills, titles, education, certifications}, " +
      "from the résumé text alone. models: the scan {app, current, can_delegate, available, efforts}, read from your own " +
      "tools; replaces the last scan." } }, ["patch"]),
    (a, ctx) => {
      const keys = Object.keys(a.patch || {});
      const allowed = rules.agentSettingsPatch(ctx.rules(), a.patch);
      const changed = Object.keys(allowed), ignored = keys.filter((k) => !changed.includes(k));
      if (!changed.length) throw new Error(`nothing to save: ${keys.length ? `only the user changes ${ignored.join(", ")}` : "patch is empty"}`);
      rules.checkSettingsPatch(allowed);
      if (allowed.models) allowed.models = models.cleanScan(allowed.models, ctx.guard.bundle?.version ?? null);
      const s = store.saveSettings(allowed);
      const out = { changed, ignored, setup_complete: s.setup_complete, missing: store.missingFields(s) };
      if (allowed.models) out.models = models.resolve({ rules: ctx.rules(), workflow: ctx.guard.bundle?.version ?? null, settings: s });
      return out;
    }],

  // ── finding and claiming jobs ──
  ["freeapply_fetch_posting", "Fetch a job posting", { ...READ, openWorldHint: true },
    desc(
      "Fetches one job posting from the user's computer, trimmed: description, form questions, suggested answers, " +
        "skills asked. Costs few tokens next to the browser, which you still use to fill and submit the form.",
      "Use: read each posting before scoring or applying. Not for search-result or sign-in pages: read those in the " +
        "browser.",
      "Behavior: read-only; one web request. Greenhouse, Lever, Ashby via their public APIs, other sites as page " +
        "text. Public http(s) only: an address on this computer or a local network, or a redirect to one, is refused. " +
        "Remembered this session, so freeapply_claim_job keeps its keywords.",
      "Returns: ats, title, company, location, work_mode, pay, description, description_chars (full length), " +
        "questions [{label, required, type, options}], suggested_answers (from settings and saved answers; answer " +
        "anything else only from the résumé or the user), keywords {matched, missing, coverage}: use matched in the " +
        "posting's words, never claim missing; coverage = matched share in %, null if the posting names none.",
      "Errors: a bad or local address, or an unfetchable page, with the reason: read it in the browser. Next: " +
        "freeapply_claim_job."),
    S({ url: str("The job page or its application form."),
      max_chars: int("Description cap in characters (default 6000).", { minimum: 500, default: 6000 }),
      source: str("Job site id where found, e.g. linkedin; picks the saved answers meant for that site.") }, ["url"]),
    async (a, ctx) => {
      const d = await fetchPosting(a.url, a.max_chars || 6000, a.source);
      d.keywords = rules.postingKeywords(ctx.rules(), d.fullText);
      rules.rememberPosting([a.url, d.apply_url], d.fullText, d.keywords);
      return d;
    }],
  ["freeapply_claim_job", "Claim or skip a job", ADD,
    desc(
      "Claims a job before you work on it: duplicate check, the user's rules, starts tracking, returns the job_id " +
        "every later call needs. Makes the job's first record (listing: freeapply_list_jobs; changing: " +
        "freeapply_update_job).",
      "Use: before opening any application form; also to record a reviewed job you won't pursue (status skipped + " +
        "status_note) so it isn't reviewed again. Not for a job already claimed.",
      "Behavior, first match wins: posting id already tracked: returns that job (existing true, nothing added); job " +
        "site the user didn't choose, or signed out or paused: refused (refused says why, sites lists ready ones); " +
        "same company and title as an applied job: refused as a repost; posted pay below the user's minimum: saved " +
        "as skipped (rule pay_floor). Else added.",
      "Returns: {job_id, existing, status, rule, earlier}. earlier: up to 20 other jobs at the company [{id, title, " +
        "company, status, same_title}]; if an applied one is clearly the same role under another title, mark this one " +
        "skipped (freeapply_update_job).",
      "Errors: a missing title or company."),
    S({ title: str("As posted."), company: str("The employer as posted; not a staffing firm, when you can tell."),
      location: str("As posted."), work_mode: str("remote, hybrid or onsite, as posted."),
      pay_text: str("Pay exactly as posted, e.g. \"$90k-$110k\"."),
      pay_min: num("Lowest posted pay, a number: annual, or hourly if posted hourly. Feeds the pay floor."),
      pay_max: num("Highest posted pay, a number. Feeds the pay floor."),
      url: str("Posting URL; tells the job site. The URL just read by freeapply_fetch_posting keeps its keywords."),
      apply_url: str("Application form URL, if different."),
      description: str("Short description or key requirements."),
      fit_score: int("0-100, scored as the apply procedure says.", { minimum: 0, maximum: 100 }),
      fit_notes: str("Why it fits or doesn't, one sentence."),
      status: oneOf(["found", "skipped"], "found (default): to work on; skipped: a job you won't pursue."),
      status_note: str("For skipped: why, one plain sentence."),
      source: str("Where found: job site id (linkedin, indeed, company_sites, ...) or referral; tells the job site like url."),
      external_id: str("The posting's id on its source site; pass it whenever shown: finds the posting again and catches reposts.") }, ["title", "company"]),
    (a, ctx) => rules.claimJob(ctx.rules(), a)],

  // ── applying ──
  ["freeapply_check_text", "Check text and save the cover letter", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    desc(
      "Checks a cover letter or free-text answer against what the user really has; saves a passing cover letter as " +
        "a PDF to upload. Every piece of prose is checked here before you type or attach it (freeapply_update_job " +
        "only records).",
      "Use: before typing any written answer or attaching any letter, and after each fix. Not for short fields " +
        "straight from settings (name, date, yes/no).",
      "Behavior: flags every skill, tool, number or claim the résumé, settings, highlights and saved answers don't " +
        "support. Without save, changes nothing. With save, a passing letter becomes a PDF in the documents folder, " +
        "kept with the job; a failing one is never saved; saving again replaces the file; refused once the job is " +
        "applied.",
      "Returns: {ok, problems} (plain sentences: fix, remove or ask the user). With job_id also keywords {used, " +
        "unused}: the posting's supported skills this text uses / could still use. With save also file {path, name, " +
        "bytes}, or note (why not saved).",
      "Errors: save without kind cover_letter and job_id; unknown job_id. Résumé never saved: most claims are " +
        "reported unsupported."),
    S({ text: str("The letter or answer, exactly as you will type or attach it."),
      kind: oneOf(["cover_letter", "answer"], "cover_letter: also checks the user's length, sign-off, leftover placeholders and " +
        "that the company is named. answer (default): facts only."),
      job_id: { ...JOB_ID, description: "Adds the posting's keywords; numbers from the job's posting, title, pay, location and " +
        "posting id, and the user's answers for this job, count as facts. Needed for save." },
      company: str("The employer, when there is no job_id."),
      save: { type: "boolean", description: "Save a passing cover letter as a PDF (default false). For a letter, pass it from the " +
        "first call: checked and saved at once." } }, ["text"]),
    (a, ctx) => {
      const kind = a.kind || "answer";
      if (a.save && (kind !== "cover_letter" || !a.job_id)) throw new Error("save needs kind cover_letter and the job_id");
      const job = a.job_id ? store.getJob(a.job_id) : null;
      if (a.job_id && !job) throw new Error(`no job ${a.job_id}; find its id with freeapply_list_jobs`);
      const problems = rules.checkText(ctx.rules(), a.text, { kind, jobId: a.job_id, company: a.company || (kind === "cover_letter" ? job?.company : null) });
      const out = { ok: !problems.length, problems };
      const kw = rules.keywordUse(a.job_id, a.text);
      if (kw) out.keywords = kw;
      if (a.save) {
        if (problems.length) out.note = "not saved: fix the problems first";
        else out.file = rules.saveCoverLetter(a.job_id, a.text);
      }
      return out;
    }],
  ["freeapply_user_answers", "Get or save the user's answers", { ...SET, idempotentHint: true },
    desc(
      "Gets or saves the user's own answers to specific form questions, so you never guess one (general details: " +
        "freeapply_get_settings). Asks the user nothing new (that is freeapply_update_job needs_info).",
      "Use: get before retrying a job the user re-queued from the Needs you tab; save when the user answers a " +
        "question in this conversation, for later forms. Save only the user's own words: saved answers count as " +
        "facts in freeapply_check_text.",
      "Behavior: get is read-only. save replaces the answer saved under the same question; an empty answer removes " +
        "it.",
      "Returns: get {job_id, answers: [{label, answer}] the user gave for this job, saved_answers: {question: " +
        "reusable answer}, cover_letter: the job's saved letter {path, text} (text: for a text-box letter field) or " +
        "null}. save {label, saved, removed, saved_answers}.",
      "Errors: get without job_id or with an unknown one; save without label; another action."),
    S({ action: oneOf(["get", "save"], "get: a job's answers and saved letter; save: one reusable answer."),
      job_id: { ...JOB_ID, description: "Required for get." },
      label: str("Required for save: the question as forms word it, e.g. \"Are you willing to relocate?\"."),
      answer: str("For save: the user's own words; empty removes the saved answer.") }, ["action"]),
    (a) => {
      if (a.action === "save") return store.saveAnswer(a.label, a.answer);
      if (a.action !== "get") throw new Error("action must be get or save");
      if (!a.job_id) throw new Error("job_id is required for get");
      if (!store.getJob(a.job_id)) throw new Error(`no job ${a.job_id}; find its id with freeapply_list_jobs`);
      return store.jobAnswers(a.job_id);
    }],
  ["freeapply_find_site_account", "Find the user's employer-site account", READ,
    desc(
      "Whether the user already made an account on an employer's careers site, and with which email. Employer sites " +
        "only (job boards such as LinkedIn that signed the user out: freeapply_report_site_problem).",
      "Use: when an application form asks you to sign in or create an account. Not for signing in or up: FreeApply " +
        "stores no passwords and you never type one.",
      "Behavior: read-only. The user records the accounts they make on the dashboard's Needs you tab.",
      "Returns: known account {domain, email_used, created_at, job_id, note}: ask the user to sign in in the " +
        "browser, then continue in their session. None {domain, account: null}: freeapply_update_job status " +
        "needs_account, account_url = the sign-up page.",
      "Errors: a site that isn't a domain or web address."),
    S({ site: str("Domain or any URL on it, e.g. careers.example.com; reduced to the domain without www. and matched exactly " +
      "(careers.example.com and example.com differ).") }, ["site"]),
    (a) => store.siteAccount(a.site)],
  ["freeapply_clear_to_submit", "Get clearance to submit", ADD,
    desc(
      "Go-ahead for one submit after checking the pace, the user's limits and, in an unattended run, its budgets. " +
        "Comes right before the submit; freeapply_update_job refuses applied without its clearance.",
      "Use: right before every submit, with job_id. Not early, not for a job you won't submit now: each clearance " +
        "counts toward the per-minute pace at once.",
      "Behavior: at most 3 submits a minute (or the user's slower setting), the user's daily cap and, for " +
        "easy_apply, whether one-click apply is allowed. A clearance: one job, 15 minutes, used up when applied is " +
        "recorded; asking again for the same job issues a new one; kept only while FreeApply runs.",
      "Returns: {clear, advice, last_minute, limit_per_minute, today, daily_cap}, plus clearance {job_id, " +
        "expires_at} when clear. clear false: don't submit; prepare the next job, call again later. refused: " +
        "one-click apply is off; apply on the employer's site or skip the job. stop_run true (with reason): the run " +
        "must end now: freeapply_autorun action finish."),
    S({ job_id: { ...JOB_ID, description: "The job about to be submitted; without it you only see the pace." },
      method: oneOf(["external", "easy_apply", "email"], "How you will submit: external (employer or ATS form; default), easy_apply (a job board's " +
        "one-click apply; refused while one-click apply is off) or email."),
      run_id: str("Unattended run only: the run_id from freeapply_autorun start; first checks that run's limits and the " +
        "dashboard's Stop button, and keeps the run alive.") }),
    (a, ctx) => rules.throttle(ctx.rules(), a.method || "external", a.job_id, a.run_id)],
  ["freeapply_update_job", "Update a job's application status", SET,
    desc(
      "Sets a claimed job's status: your side of the application (employer's response: freeapply_record_outcome; " +
        "adding a job: freeapply_claim_job).",
      "Use: after a submit (applied); giving up (skipped, failed); when the user must act: needs_info with the form's " +
        "questions, needs_account with the sign-up page, blocked by a check you can't pass.",
      "Behavior: replaces the status. Enforced: applied needs a fresh freeapply_clear_to_submit clearance for this " +
        "job; cover_text must pass the truthfulness check; an applied job only the user can change. needs_info " +
        "questions go to the Needs you tab and re-queue the job once answered; if the user already answered them " +
        "all, refused with the answers to use. A field marked for one status is refused with any other.",
      "Returns: {job_id, status} and when relevant: already_waiting; questions (each added, duplicate, grouped or " +
        "already_answered, with its answer), questions_added; same_account (needs_account: jobs sharing one sign-up " +
        "card); same_site (blocked: jobs blocked on the same site).",
      "Errors: an unknown job_id or a broken rule, saying what is missing."),
    S({ job_id: JOB_ID, status: oneOf(STATUS_IDS, `New status: ${listed(store.STATUSES)}.`),
      note: str("What happened, for the user: one plain sentence, no technical terms, e.g. \"The site asked to prove you're a person.\""),
      account_url: str("needs_account only: the site's sign-up page. Jobs with the same one share a card; one \"I made the " +
        "account\" re-queues them all. Default: the application link, so jobs rarely share."),
      method: oneOf(["easy_apply", "external", "email"], "applied only: how it was submitted."),
      confirmation: str("applied only: the confirmation text or number the site showed."),
      resume_path: str("applied only: the résumé file sent, if not the documents copy (recorded by default)."),
      cover_path: str("applied only: the letter file sent, if not the saved one."),
      cover_text: str("applied only: the letter sent, if not the saved one."),
      letter_sent: { type: "boolean", description: "applied only; required when a letter is saved for the job (freeapply_check_text " +
        "save): true if attached or pasted, false if not (letter dropped from the record)." },
      questions: { type: "array", description: "needs_info only, at least one: the form's unanswered questions, each with a plain " +
        "prompt and the simplest kind of answer that fits.",
        items: { type: "object", properties: { label: str("Exactly as the form words it (needed to fill the form later)."),
          prompt: str("Plain words for the user: one short sentence, no form codes or jargon, e.g. " +
            "\"Can you work weekends?\" for \"Availability - Sat/Sun shifts (Y/N)*\"."),
          help: str("Optional one-line hint the user sees under the prompt: why it's asked or what a good answer looks like."),
          type: oneOf(["text", "textarea", "yesno", "choice", "multi", "number", "date"], "yesno or choice: one fixed answer " +
            "(buttons up to 5 options, else a dropdown); multi: all that apply; number; date; text or textarea."),
          options: list("For choice or multi: the choices as the form words them."),
          required: { type: "boolean", description: "Whether the form requires it." } }, required: ["label"] } } },
    ["job_id", "status"]),
    (a, ctx) => rules.agentSetStatus(ctx.rules(), a)],
  ["freeapply_report_site_problem", "Report a job site signed out or limited", SET,
    desc(
      "Marks a job site the user chose in Settings (e.g. LinkedIn, Indeed) unusable for now: it signed the user out " +
        "or showed its own daily limit (an employer's own careers site: freeapply_find_site_account).",
      "Use: as soon as a chosen site shows a sign-in page or a daily limit; then keep applying on the ready sites or " +
        "company career sites. Never type a password.",
      "Behavior: signed_out: unavailable until the user signs in again and confirms it in the dashboard; " +
        "limit_reached: paused until midnight. Meanwhile freeapply_claim_job refuses new jobs from it. Reporting " +
        "again changes nothing; only the user can mark a site ready.",
      "Returns: {site, status, sites} (each chosen site with ready).",
      "Errors: a site the user didn't choose."),
    S({ site: oneOf(SITE_IDS, "Job site id, as freeapply_status lists it in sites."),
      status: oneOf(["signed_out", "limit_reached"], "signed_out: a sign-in page, or the site says you're signed out. " +
        "limit_reached: the site's own daily limit, e.g. \"You reached today's Easy Apply limit\".") }, ["site", "status"]),
    (a) => {
      store.markSite(a.site, a.status);
      return { site: a.site, status: a.status, sites: store.siteReadiness() };
    }],
  ["freeapply_autorun", "Start or finish an unattended run", ADD,
    desc(
      "Starts and finishes unattended (scheduled) runs and records the schedule, itself a scheduled task in the " +
        "user's AI app (freeapply_status only shows the run state).",
      "Use: start at the beginning of every scheduled run, finish at its end, also when stopping early; " +
        "schedule_created or schedule_removed after you create or delete the scheduled task, so the dashboard shows " +
        "it. Not in a session the user runs by hand.",
      "Behavior: start opens a run only when none is going (a run checks in with each job-work tool call and " +
        "freeapply_clear_to_submit; 15 minutes without one counts as ended), else go false. A run continues until nothing is left to apply to; " +
        "freeapply_clear_to_submit with the run_id ends it when a limit is reached or the user presses Stop. start " +
        "with wait: while auto-run is off only because the user pressed Stop, holds the call up to 10 minutes and " +
        "returns as soon as they press Start (one session waits; another gets go false at once). finish releases the " +
        "run; harmless on a run that already ended.",
      "Returns: start {go: true, run_id, minutes (time limit, null: none), max_applications, sites} or {go: false, reason} (auto-run off, " +
        "Terms or setup missing, daily cap reached, another run going or waiting), plus wait_again true when a wait " +
        "timed out with auto-run still off: call start with wait again; any other go false: stop at once, quietly. finish " +
        "{finished, applied_this_run}, null for a run no longer active. schedule_created/schedule_removed " +
        "{schedule_created}.",
      "Errors: finish without run_id; another action."),
    S({ action: oneOf(["start", "finish", "schedule_created", "schedule_removed"], "start or finish a run; schedule_created or " +
      "schedule_removed report the scheduled task."),
      run_id: str("Required for finish: the run_id start returned."),
      wait: { type: "boolean", description: "For start, in a scheduled run: if the user turned auto-run off, wait for them to press Start." },
      summary: str("For finish: one line on the run, e.g. \"applied 4, needs you 2\" (up to 500 characters).") }, ["action"]),
    (a, ctx) => {
      switch (a.action) {
        case "start": return a.wait ? autorun.startOrWait({ signal: ctx.signal, progress: ctx.progress }) : autorun.start();
        case "finish":
          if (!a.run_id) throw new Error("run_id is required for finish: pass the run_id that start returned");
          return autorun.finish(a.run_id, a.summary);
        case "schedule_created": return autorun.scheduleReported(true);
        case "schedule_removed": return autorun.scheduleReported(false);
        default: throw new Error("action must be start, finish, schedule_created or schedule_removed");
      }
    }],

  // ── tracking and replies ──
  ["freeapply_list_jobs", "List tracked jobs", READ,
    desc(
      "Lists the user's tracked jobs, most recent activity first (submitted, else updated, else found): the jobs " +
        "themselves (totals and rates: freeapply_job_stats).",
      "Use: to find a job_id or answer questions about particular jobs. Not for adding or changing jobs " +
        "(freeapply_claim_job, freeapply_update_job).",
      "Behavior: read-only. Filters combine.",
      "Returns: [{id, title, company, location, work_mode, pay_text, pay_min, pay_max, url, apply_url, fit_score, " +
        "status, status_note, outcome, outcome_at, source, found_at, updated_at, method, submitted_at, confirmation, " +
        "resume_path, cover_path, reply_count}]; empty when nothing matched."),
    S({ status: oneOf(STATUS_IDS, "Exact status filter."), outcome: oneOf(OUTCOME_IDS, "Exact employer-outcome filter."),
      search: str("Text in the title, company or location, ignoring case."),
      limit: int("Most jobs to return (default 200); fewer returned means the end.", { minimum: 1, maximum: 2000, default: 200 }),
      offset: int("Jobs to skip, for the next page (default 0).", { minimum: 0, default: 0 }) }),
    (a) => store.listJobs(a.status, a.outcome, a.search, a.limit || 200, a.offset || 0)],
  ["freeapply_job_stats", "Get job-search statistics", READ,
    desc(
      "The user's job search in numbers: applications, replies, interviews, offers, rates (individual jobs: " +
        "freeapply_list_jobs; whether FreeApply can run: freeapply_status).",
      "Use: to report progress, e.g. when wrapping up a session. Not for finding a particular job.",
      "Behavior: read-only, cheap: counted fresh from the local database each call, nothing cached. No parameters.",
      "Returns: tracked, applied, applied_today, queued, needs_you (jobs waiting on the user), interviews, offers, " +
        "rejections, acknowledged, response_rate (% of applications with a real reply; automatic acknowledgements " +
        "not counted), avg_fit, last_reply_check (when the last Gmail reply check finished), counts by_status, " +
        "by_outcome, by_method, daily (applications per day), top_companies, top_titles, top_jobs."),
    S(), () => store.stats()],
  ["freeapply_reply_check", "Run a reply check: plan, read, mark, finish", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    desc(
      "Begins and ends a reply check (the freeapply-replies procedure) and, when the user saved an email login in " +
        "Settings, reads and marks their mailbox itself. Frames the check (each email is recorded with " +
        "freeapply_record_outcome).",
      "Use: start first; then read (start's mail.reader freeapply) or the Gmail connector (connector); mark after " +
        "recording each email read returned; finish once everything found is recorded.",
      "Behavior: start: read-only, repeatable. read: signs in with the app password kept on this computer (you never " +
        "see it), returns matching emails, changes nothing. mark: stars and/or labels one email as the user chose in " +
        "Settings. finish: sets the last check to now, so the next check reads only newer email: only after recording " +
        "everything found.",
      "Returns: start (the plan) {since, gmail (the user's mail settings: action none|star|label|star_and_label, " +
        "label_name, ...), mail {reader: freeapply|connector, address}, applied [{job_id, company, title, " +
        "submitted_at}], known_message_ids (already recorded)}. read {emails: [{gmail_message_id, gmail_thread_id, " +
        "sender, subject, received_at, text}] newest first, already-recorded left out, count}. mark {mail_action} " +
        "(for freeapply_record_outcome). finish {last_check}.",
      "Errors: another action; read or mark without a saved email login; the mail server refusing the login."),
    S({ action: oneOf(["start", "read", "mark", "finish"], "start: the plan; read: the mailbox; mark: star or label one email; finish: the check is done."),
      gmail_message_id: str("Required for mark: the email's id, from read."),
      kind: { type: "string", enum: OUTCOME_IDS, description: "Required for mark: the outcome you recorded for the email." } }, ["action"]),
    async (a) => {
      if (a.action === "start") {
        const mail = secrets.emailStatus();
        return { ...store.replyCheckPlan(), mail: { reader: mail.saved ? "freeapply" : "connector", address: mail.address } };
      }
      if (a.action === "finish") return { last_check: store.markReplyCheckDone().gmail.last_check };
      if (a.action !== "read" && a.action !== "mark") throw new Error("action must be start, read, mark or finish");
      const login = secrets.emailLogin();
      if (!login) throw new Error("no email login is saved: use the Gmail connector, or ask the user to add an app password in Settings → Email");
      const plan = store.replyCheckPlan();
      if (a.action === "read") {
        if (!plan.applied.length) return { emails: [], count: 0 };
        const emails = await findReplies(login, { since: plan.since, companies: plan.applied.map((j) => j.company), known: plan.known_message_ids });
        store.inboxSeen(emails.map((e) => e.gmail_message_id));
        return { emails, count: emails.length };
      }
      if (!a.gmail_message_id || !a.kind) throw new Error("mark needs gmail_message_id and kind");
      const g = plan.gmail;
      if (g.action === "none" || (a.kind === "acknowledged" && !g.count_acknowledgements)) return { mail_action: "none" };
      return { mail_action: await markReply(login, a.gmail_message_id, g.action, g.label_name) };
    }],
  ["freeapply_record_outcome", "Record what an employer did", { ...ADD, idempotentHint: true },
    desc(
      "Records what an employer did with an application (your side, e.g. applied or skipped: freeapply_update_job).",
      "Use: for each employer email found in a reply check, between freeapply_reply_check start and finish, and when " +
        "the user tells you about a call or corrects an outcome. Not for your own steps.",
      "Behavior: with an email (gmail_message_id): stores it; raises the job's outcome only if this email ranks " +
        "higher than the current one (an interview outranks an acknowledgement); the same gmail_message_id again " +
        "stores nothing new. Without an email: sets the outcome exactly, whatever its rank. The email fields fill " +
        "the dashboard's Replies tab.",
      "Returns: with an email {recorded (false: recorded before), kind, job_id, outcome (the job's, afterwards)}, " +
        "job_id and outcome null without job_id; without one {job_id, outcome}.",
      "Errors: an unknown job_id; no job_id and no email; an empty outcome with an email."),
    S({ job_id: { ...JOB_ID, description: "From the reply-check plan or freeapply_list_jobs. Required without an email; with one " +
      "optional, but without it no outcome changes." },
      outcome: { type: "string", enum: [...OUTCOME_IDS, ""], description: `What the employer did: ${listed(store.OUTCOMES)}; ` +
        "or \"\" to clear it (without an email only)." },
      gmail_message_id: str("The employer email's Gmail message id."),
      gmail_thread_id: str("Email: Gmail thread id."), company: str("Email: the employer that sent it."),
      sender: str("Email: sender address."), subject: str("Email: subject line."),
      received_at: str("Email: when it arrived (ISO 8601)."),
      summary: str("Email: what it says, one sentence of at most 20 words, no personal data beyond what is needed."),
      mail_action: str("Email: what you did with it in Gmail: starred, labeled:<name>, starred+labeled:<name> or none.") }, ["outcome"]),
    (a) => {
      if (a.gmail_message_id) {
        if (!a.outcome) throw new Error("outcome is required with an email: say what the email is");
        return store.recordReply({ ...a, kind: a.outcome });
      }
      if (!a.job_id) throw new Error("job_id is required without an email (pass gmail_message_id to record an email)");
      return store.setOutcome(a.job_id, a.outcome);
    }],

  // ── data sharing ──
  ["freeapply_shared_data", "Preview or send shared data", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    desc(
      "Shows or sends the exact data the user chose to share with the FreeApply server (the sharing choices " +
        "themselves: freeapply_get_settings).",
      "Use: preview when the user asks what is shared; sync only when the user asks to send now (it also runs on its " +
        "own every 12 hours). Not for changing the choices: the user does that in the dashboard (Settings, Data " +
        "sharing).",
      "Behavior: preview: read-only, sends nothing, safe any time. sync: sends over the internet only what the " +
        "current choices allow; can't be undone from here (the user can delete shared data in the dashboard); " +
        "refused moments after the last sync.",
      "Returns: preview: the exact requests that would be sent: analytics_request (anonymous usage and job-market " +
        "data), the talent-pool request only if the user joined; secrets hidden. sync: {sent, result} or {sent: " +
        "false, reason}: Terms not accepted, a sync moments ago, or the server unreachable (the automatic sync " +
        "retries later).",
      "Errors: another action."),
    S({ action: oneOf(["preview", "sync"], "preview: show what would be sent; sync: send it now.") }, ["action"]),
    (a) => {
      if (a.action === "preview") return sharing.preview();
      if (a.action === "sync") return sharing.sync(true);
      throw new Error("action must be preview or sync");
    }],
].map(([name, title, annotations, description, inputSchema, handler]) => ({ name, title, annotations, description, inputSchema, handler }));

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const text = (out, isError = false) => ({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }], ...(isError ? { isError: true } : {}) });

let lastSkillCheck = 0;

// ───────────────────────────── checking a call's arguments ─────────────────────────────

const TYPE_TEXT = { string: "text", integer: "a whole number", number: "a number", boolean: "true or false", array: "a list", object: "an object" };

/** One value against its schema: returns [value, problem]. Numbers and true/false sent as text are accepted, and a
 * number where text is expected becomes text, since clients differ in how they send them. */
function checkValue(key, v, p) {
  let x = v;
  if ((p.type === "integer" || p.type === "number") && typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x.trim())) x = Number(x);
  if (p.type === "boolean" && (x === "true" || x === "false")) x = x === "true";
  if (p.type === "string" && typeof x === "number") x = String(x);
  const ok = { string: typeof x === "string", integer: Number.isInteger(x), number: typeof x === "number" && Number.isFinite(x),
    boolean: typeof x === "boolean", array: Array.isArray(x), object: x !== null && typeof x === "object" && !Array.isArray(x) }[p.type];
  if (ok === false) return [x, `${key} must be ${TYPE_TEXT[p.type]}`];
  if (p.enum && !p.enum.includes(x)) return [x, `${key} must be one of: ${p.enum.map((e) => (e === "" ? '""' : e)).join(", ")}`];
  if (p.minimum !== undefined && x < p.minimum) return [x, `${key} must be at least ${p.minimum}`];
  if (p.maximum !== undefined && x > p.maximum) return [x, `${key} must be at most ${p.maximum}`];
  if (p.type === "array" && p.items) {
    const out = [];
    for (const [i, item] of x.entries()) {
      const [y, problem] = p.items.type === "object" ? checkObject(`${key}[${i}]`, item, p.items, false) : checkValue(`${key}[${i}]`, item, p.items);
      if (problem) return [x, problem];
      out.push(y);
    }
    x = out;
  }
  return [x, null];
}

/** An object's fields: required ones present (text not blank), each known one valid. strict: unknown names are errors. */
function checkObject(where, obj, schema, strict) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [obj, `${where} must be an object`];
  const props = schema.properties || {}, out = {}, probs = [];
  for (const k of Object.keys(obj)) {
    if (!(k in props)) {
      if (strict) probs.push(`unknown parameter ${k}`);
      else out[k] = obj[k];
    }
  }
  for (const [k, p] of Object.entries(props)) {
    const v = obj[k], key = where ? `${where}.${k}` : k;
    const blank = p.type === "string" && typeof v === "string" && !v.trim() && !p.enum?.includes("");
    if (v === undefined || v === null || (blank && (schema.required || []).includes(k))) {
      if ((schema.required || []).includes(k)) probs.push(`${key} is required`);
      continue;
    }
    const [x, problem] = checkValue(key, v, p);
    if (problem) probs.push(problem);
    else out[k] = x;
  }
  return [out, probs.join("; ") || null];
}

/** A call's arguments against the tool's input schema. Throws one error naming every problem and, for an unknown
 * name, the parameters the tool takes, so the agent can fix the call in one try. */
export function checkArgs(tool, args) {
  const [out, problems] = checkObject("", args ?? {}, tool.inputSchema, true);
  if (!problems) return out;
  const names = Object.keys(tool.inputSchema.properties || {});
  throw new Error(`bad arguments for ${tool.name}: ${problems}` +
    (/unknown parameter/.test(problems) ? `. It takes: ${names.length ? names.join(", ") : "no parameters"}` : ""));
}

// What the agent is doing now, in plain words for the dashboard's top bar ("Running · Applying to IT Support at Acme").
// Taken from the tool calls themselves, so it costs the agent nothing.
const jobName = (id) => { const j = id && store.getJob(id); return j ? `${j.title} at ${j.company}` : null; };
const ACTIVITY = {
  freeapply_status: (a) => (a.lane === "scout" || (a.procedure === "freeapply-apply" && !a.lane) ? "Searching for jobs" : null),
  freeapply_fetch_posting: () => "Reading a job posting",
  freeapply_claim_job: (a) => `Looking at ${a.title} at ${a.company}`,
  freeapply_check_text: (a) => (a.kind === "cover_letter" && jobName(a.job_id) ? `Writing a cover letter for ${jobName(a.job_id)}` : null),
  freeapply_clear_to_submit: (a) => (jobName(a.job_id) ? `Applying to ${jobName(a.job_id)}` : null),
  freeapply_update_job: (a) => (a.status === "applied" && jobName(a.job_id) ? `Applied to ${jobName(a.job_id)}` : null),
  freeapply_reply_check: (a) => (a.action === "start" || a.action === "read" ? "Checking email for replies" : null),
};
// Calls that only happen while the agent is working keep an unattended run alive (autorun.touch). Status and
// autorun calls don't: a fresh hourly wake makes them before asking to start, and must not revive a run that died.
const WORK_TOOLS = new Set(["freeapply_fetch_posting", "freeapply_claim_job", "freeapply_check_text", "freeapply_user_answers",
  "freeapply_find_site_account", "freeapply_update_job", "freeapply_report_site_problem"]);
function noteActivity(name, args) {
  try {
    if (WORK_TOOLS.has(name)) autorun.touch();
    const text = ACTIVITY[name]?.(args || {});
    if (text) store.metaSet("activity", JSON.stringify({ text: text.slice(0, 140), at: new Date().toISOString() }));
  } catch { /* the top bar can do without it */ }
}

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
    const out = await tool.handler(checkArgs(tool, args), ctx);
    noteActivity(name, args);
    return text(out ?? {});
  } catch (e) {
    // Refusals and bad arguments are answers; anything unexpected also goes into the local problem log.
    if (errorlog.unexpected(e)) errorlog.record("tool", name, e);
    return text(`error: ${e.message}`, true); // tool errors go back to the model, not the protocol
  }
}
