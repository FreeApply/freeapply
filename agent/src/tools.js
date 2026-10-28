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
      "Reports whether FreeApply can work now and returns the signed step-by-step procedure for a task. Unlike " +
        "freeapply_get_settings (the user's details) and freeapply_job_stats (the job search), it is about " +
        "FreeApply itself.",
      "Use it first in every session and before each task; call it again only to re-check after the user acts. " +
        "It works while FreeApply is locked or the Terms aren't accepted, so it can tell you why.",
      "Behavior: changes no user data. Sets up the data folder on first run, starts the local dashboard if " +
        "needed and refreshes the résumé copy in the documents folder.",
      "Parameters: procedure adds that task's text: freeapply-setup (first run, or Terms or settings missing), " +
        "freeapply-apply (find jobs and apply) or freeapply-replies (Gmail reply check). Omit it for the status " +
        "alone.",
      "Returns: workflow {ok, problem}, terms {ok}, setup_complete, missing, sites (each chosen job site with " +
        "ready), autorun, update, dashboard (its URL), data_dir, documents {dir, resume, cover_letters}, stats, " +
        "procedures, and models {can_delegate, rescan, levels, lanes, unfilled}: each level and lane gives " +
        "{model, effort, source}, and model current means your own model does it. With procedure also procedure " +
        "{name, description, text, workflow_version, workflow_hash}, null while locked.",
      "Next: workflow.ok false: tell the user why and stop. terms.ok or setup_complete false: follow " +
        "freeapply-setup. models.rescan true: do its AI models step first."),
    S({ procedure: oneOf(["freeapply-setup", "freeapply-apply", "freeapply-replies"], "The task whose procedure to include. Optional.") }),
    async (a, ctx) => {
      const { recent, ...auto } = autorun.status();
      const b = ctx.guard.bundle || {}, procs = b.procedures || {};
      const out = { ...store.bootstrap(), workflow: ctx.guard.status, terms: sharing.consentStatus(), dashboard: await dashboard.start(),
        sites: store.siteReadiness(), autorun: auto, update: updater.info(), documents: store.documentsInfo(),
        stats: scalars(store.stats()), procedures: Object.keys(procs), models: models.resolve({ rules: ctx.rules(), workflow: b.version ?? null }) };
      if (a.procedure) {
        const p = ctx.guard.status.ok ? procs[a.procedure] : null;
        if (ctx.guard.status.ok && !p) throw new Error(`no procedure ${a.procedure}; available: ${Object.keys(procs).join(", ")}`);
        out.procedure = p ? { name: a.procedure, description: p.description, text: p.text, workflow_version: b.version,
          workflow_hash: ctx.guard.status.hash } : null;
      }
      return out;
    }],
  ["freeapply_open_dashboard", "Open the dashboard in the browser", READ,
    desc(
      "Opens the user's local FreeApply dashboard in their browser, on one tab. Unlike freeapply_status, which " +
        "only reports its address, it puts the page in front of the user.",
      "Use it when the user has to act there: accept the Terms, fill in settings, answer questions waiting on " +
        "them, or review applications and replies. Not for reading data; the other tools give you the same " +
        "information.",
      "Behavior: changes no data. Starts the dashboard if needed, on http://127.0.0.1:7878 or the next free " +
        "port; only this computer can reach it.",
      "Parameters: tab picks the page: overview (the Terms show there until accepted), settings (the setup " +
        "fields), issues (the Needs you list of questions and sign-ups), applications or replies. Default " +
        "overview.",
      "Returns: {url, opened}. url null: the dashboard couldn't start (no free port); tell the user. opened " +
        "false with a url: no browser could be launched; give the user the url."),
    S({ tab: oneOf(["overview", "applications", "replies", "issues", "settings"], "The page to open. Optional; default overview.") }),
    async (a) => {
      const url = await dashboard.start();
      const opened = url ? await dashboard.openBrowser(url + (a.tab ? `#${a.tab}` : "")) : false;
      return { url, opened };
    }],

  // ── the user's settings and résumé ──
  ["freeapply_get_settings", "Read the user's settings", READ,
    desc(
      "Reads the user's settings: who they are, what they're looking for and how FreeApply should work. Unlike " +
        "freeapply_user_answers (answers to single form questions) and freeapply_status (whether FreeApply can " +
        "run), it holds the facts about the user.",
      "Use it once per session, or once per helper, before scoring jobs or filling in a form. With the résumé " +
        "text and the user's own words it is the only source of facts about the user: never invent what it " +
        "doesn't contain. To change settings, use freeapply_update_settings.",
      "Behavior: read-only; installation secrets are never included.",
      "Parameters: sections limits the reply to what a step needs, e.g. [\"profile\", \"eligibility\"] for a form; " +
        "leave out resume, the largest, when you don't need its text. Default all.",
      "Returns: {settings, missing}. Sections: profile, targets, eligibility, resume (file paths, text, " +
        "profile), cover_letter, automation, autorun, gmail, custom_answers, models, model_choices and sharing " +
        "(choices only). missing lists required fields still empty as {key, label}; while it isn't empty, don't " +
        "apply anywhere: open the settings tab with freeapply_open_dashboard and ask the user to fill them.",
      "Errors: an unknown section name; the message lists the valid ones."),
    S({ sections: list("Sections to return. Optional; default all.") }),
    (a) => {
      const all = store.publicSettings(store.loadSettings());
      const bad = (a.sections || []).filter((k) => !(k in all));
      if (bad.length) throw new Error(`no section ${bad.join(", ")}; sections: ${Object.keys(all).join(", ")}`);
      const settings = a.sections?.length ? Object.fromEntries(a.sections.map((k) => [k, all[k]])) : all;
      return { settings, missing: store.missingFields() };
    }],
  ["freeapply_update_settings", "Save settings and résumé", SET,
    desc(
      "Saves what the user told you, what setup reads from their résumé, and the AI models scan. Unlike " +
        "freeapply_user_answers, which keeps answers to single form questions, it changes the settings " +
        "themselves.",
      "Use it when the user states a fact or preference, in setup to store the résumé's text and profile, and " +
        "in the AI models step. Don't fill a field the user didn't give you; to read settings, use " +
        "freeapply_get_settings.",
      "Behavior: overwrites the fields you send, with no undo. patch is deep-merged: only its fields change, " +
        "nested objects merge, lists are replaced whole. Sections only the user changes in the dashboard (legal, " +
        "sharing, automation, autorun, onboarding, integrity, model_choices) are skipped and listed in ignored. " +
        "All or nothing: if any field is wrong, nothing is saved.",
      "Parameters: patch is nested by section with freeapply_get_settings' field names, e.g. {\"targets\": " +
        "{\"min_pay\": 60000}}. resume takes only text and profile ({headline, skills, titles, education, " +
        "certifications}, from the résumé text alone). models is the scan {app, current, can_delegate, available, " +
        "efforts}, read from your own tools; it replaces the last scan.",
      "Returns: {changed, ignored, setup_complete, missing}; after a scan also models, the model and effort " +
        "chosen for each level.",
      "Errors: nothing writable, an unknown section or field, a wrong type, a value outside its choices (e.g. " +
        "cover_letter.length is short, standard or long), résumé files (the user adds those in the dashboard) or " +
        "a malformed scan. The message names every problem."),
    S({ patch: { type: "object", description: "The fields to change, nested by section, e.g. {\"profile\": {\"phone\": \"+1 555 0100\"}}." } }, ["patch"]),
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
      "Fetches one job posting on the user's computer and returns it trimmed, with its form questions, " +
        "suggested answers and the skills it asks for. Unlike opening the page in the browser it costs few " +
        "tokens; you still use the browser to fill in and submit the form.",
      "Use it to read each posting before scoring or applying. Not for search-results pages or pages behind a " +
        "sign-in; read those in the browser.",
      "Behavior: read-only; one web request from the user's computer. Greenhouse, Lever and Ashby postings are " +
        "read through their public APIs, other sites as plain page text. Only public http and https pages are " +
        "fetched: an address on this computer or a local network, or a redirect to one, is refused. The posting " +
        "is remembered for this session, so freeapply_claim_job can keep its keywords.",
      "Parameters: url is the job page or its application form. max_chars caps the description (default 6000, " +
        "at least 500); description_chars gives its full length. source, a job site id such as linkedin, picks " +
        "the saved answers meant for that site.",
      "Returns: ats, title, company, location, work_mode, pay, description, description_chars, questions " +
        "(label, required, type, options), suggested_answers (from settings and saved answers; answer anything " +
        "else only from the résumé or the user) and keywords {matched, missing, coverage}: use matched skills in " +
        "the posting's words, never claim missing ones; coverage is the matched share in percent, null when the " +
        "posting names none.",
      "Errors: a bad or local address, or a page that can't be fetched, with the reason; then read it in the " +
        "browser. Next: freeapply_claim_job."),
    S({ url: str("The posting's URL: the job page or its application form."),
      max_chars: int("Longest description to return, in characters. Optional; default 6000.", { minimum: 500, default: 6000 }),
      source: str("The job site id where it was found. Optional.") }, ["url"]),
    async (a, ctx) => {
      const d = await fetchPosting(a.url, a.max_chars || 6000, a.source);
      d.keywords = rules.postingKeywords(ctx.rules(), d.fullText);
      rules.rememberPosting([a.url, d.apply_url], d.fullText, d.keywords);
      return d;
    }],
  ["freeapply_claim_job", "Claim or skip a job", ADD,
    desc(
      "Claims a job before you work on it: runs the duplicate check, applies the user's rules and starts " +
        "tracking it, returning the job_id every later call needs. Unlike freeapply_list_jobs it adds a job, and " +
        "unlike freeapply_update_job it makes the job's first record.",
      "Use it before opening any application form, and to record a job you reviewed and won't pursue (status " +
        "skipped, with status_note) so it isn't reviewed again. Not for changing a job you already claimed.",
      "Behavior: adds the job unless, in this order: a posting id already tracked returns that job (existing: " +
        "true; nothing added); a job site the user didn't choose, or one signed out or paused, is refused " +
        "(refused says why, sites lists the ready ones); the same company and title as a job already applied to " +
        "is refused as a repost; posted pay below the user's minimum is saved as skipped (rule: pay_floor).",
      "Parameters: title and company are required; company is the employer, not a staffing firm, when you can " +
        "tell. Pass external_id whenever the site shows the posting's id: it catches reposts. url or source tells " +
        "which job site it came from; the URL just read by freeapply_fetch_posting keeps its keywords. pay_min " +
        "and pay_max feed the pay floor; fit_score is 0 to 100, as the apply procedure scores it.",
      "Returns: {job_id, existing, status, rule, earlier}. earlier lists up to 20 other jobs at the same " +
        "company as {id, title, company, status, same_title}; if an applied one is clearly the same role under " +
        "another title, mark this one skipped with freeapply_update_job.",
      "Errors: a missing title or company."),
    S({ title: str("Job title, as posted."), company: str("Employer name, as posted (not the staffing firm's name, if known)."),
      location: str("Location as posted."), work_mode: str("remote, hybrid or onsite, as posted."),
      pay_text: str("Pay exactly as posted, e.g. \"$90k-$110k\"."),
      pay_min: num("Lowest posted pay as a number: annual, or hourly if posted hourly."), pay_max: num("Highest posted pay as a number."),
      url: str("The posting's URL; also tells which job site it came from."), apply_url: str("Where the application form is, if different."),
      description: str("Short description or key requirements."),
      fit_score: int("Fit from 0 to 100, scored as the apply procedure describes.", { minimum: 0, maximum: 100 }),
      fit_notes: str("Why it fits or doesn't, in one sentence."),
      status: oneOf(["found", "skipped"], "found to work on it (default), or skipped to record a job you won't pursue."),
      status_note: str("Why it was skipped, in one plain sentence; for status skipped."),
      source: str("Where it was found: a job site id (linkedin, indeed, company_sites, ...) or referral."),
      external_id: str("The posting's id on its source site; finds the same posting again, reposts included.") }, ["title", "company"]),
    (a, ctx) => rules.claimJob(ctx.rules(), a)],

  // ── applying ──
  ["freeapply_check_text", "Check text and save the cover letter", { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    desc(
      "Checks a cover letter or free-text answer against what the user really has, and turns a passing cover " +
        "letter into a PDF to upload. Unlike freeapply_update_job, which only records the result, it is where " +
        "every piece of prose is checked before you type or attach it.",
      "Use it before typing any written answer or attaching any letter, and again after each fix. Not for short " +
        "fields taken straight from the settings, such as a name, a date or yes/no.",
      "Behavior: flags every skill, tool, number or claim that the résumé, settings, highlights and saved " +
        "answers don't support. Without save it changes nothing. With save a passing letter becomes a PDF in the " +
        "documents folder, kept with the job; a failing one is never saved, saving again replaces the file, and a " +
        "job already applied to is refused.",
      "Parameters: kind cover_letter also checks the user's chosen length, their sign-off, leftover " +
        "placeholders and that the company is named; answer, the default, checks facts only. job_id adds the " +
        "posting's keywords, counts numbers from the posting and the user's answers for that job as facts, and is " +
        "needed for save. company names the employer when there is no job_id. For a letter, pass save from the " +
        "first call so a passing letter is checked and saved at once.",
      "Returns: {ok, problems}, problems being plain sentences to fix, remove or ask the user about. With " +
        "job_id also keywords {used, unused}: the posting's supported skills this text uses, and those it could " +
        "still use. With save also file {path, name, bytes}, or a note why it wasn't saved.",
      "Errors: save without kind cover_letter and a job_id, or an unknown job_id. If the résumé was never " +
        "saved, most claims are reported as unsupported."),
    S({ text: str("The cover letter or answer to check, exactly as you will type or attach it."),
      kind: oneOf(["cover_letter", "answer"], "What the text is. Optional; default answer."),
      job_id: { ...JOB_ID, description: "The job it is for. Optional; needed for save." },
      company: str("The employer, when there is no job_id. Optional."),
      save: { type: "boolean", description: "Save a passing cover letter as a PDF. Optional; default false." } }, ["text"]),
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
      "Gets or saves the user's own answers to application questions, so you never guess one. Unlike " +
        "freeapply_get_settings (the user's general details) it holds answers to specific form questions, and " +
        "unlike freeapply_update_job status needs_info it asks the user nothing new.",
      "Use get before retrying a job the user re-queued from the Needs you tab, and save when the user answers " +
        "a question in this conversation, so later forms can reuse it. Save only the user's own words: saved " +
        "answers count as facts in freeapply_check_text.",
      "Behavior: get is read-only. save replaces an answer saved under the same question; an empty answer " +
        "removes it.",
      "Parameters: action get needs job_id. action save needs label, the question as forms word it (e.g. \"Are " +
        "you willing to relocate?\"), and answer, the user's words.",
      "Returns: get {job_id, answers, saved_answers}: answers are the {label, answer} pairs the user gave for " +
        "that job (empty when none), saved_answers maps questions to reusable answers. save {label, saved, " +
        "removed, saved_answers}.",
      "Errors: get without job_id or with an unknown one, save without label, or another action."),
    S({ action: oneOf(["get", "save"], "get a job's answers, or save one reusable answer."),
      job_id: { ...JOB_ID, description: "For get: the job whose answers you need." },
      label: str("For save: the question, worded as forms ask it, e.g. \"Are you willing to relocate?\"."),
      answer: str("For save: the user's answer in their own words; empty to remove a saved answer.") }, ["action"]),
    (a) => {
      if (a.action === "save") return store.saveAnswer(a.label, a.answer);
      if (a.action !== "get") throw new Error("action must be get or save");
      if (!a.job_id) throw new Error("job_id is required for get");
      if (!store.getJob(a.job_id)) throw new Error(`no job ${a.job_id}; find its id with freeapply_list_jobs`);
      return store.jobAnswers(a.job_id);
    }],
  ["freeapply_find_site_account", "Find the user's employer-site account", READ,
    desc(
      "Looks up whether the user already made an account on an employer's careers site, and with which email. " +
        "Unlike freeapply_report_site_problem, which is for job boards such as LinkedIn that signed the user out, " +
        "it is about an employer's own site.",
      "Use it when an application form asks you to sign in or create an account. Not for signing in or up: " +
        "FreeApply never stores passwords and you never type one.",
      "Behavior: read-only. The user records the accounts they make on the dashboard's Needs you tab.",
      "Parameters: site is the site's domain or any web address on it, reduced to the domain without www. and " +
        "matched exactly, so careers.example.com and example.com are different sites.",
      "Returns: {domain, email_used, created_at, job_id, note} for a known account, or {domain, account: null}. " +
        "Known: ask the user to sign in in the browser, then continue in their session. None: record the job " +
        "with freeapply_update_job status needs_account and the sign-up page as account_url.",
      "Errors: a site that isn't a domain or web address."),
    S({ site: str("The employer site's domain or any URL on it, e.g. careers.example.com.") }, ["site"]),
    (a) => store.siteAccount(a.site)],
  ["freeapply_clear_to_submit", "Get clearance to submit", ADD,
    desc(
      "Gives the go-ahead for one submit after checking the pace, the user's limits and, in an unattended run, " +
        "its budgets. Unlike freeapply_update_job, which records the submit afterwards, it comes right before it; " +
        "recording applied is refused without its clearance.",
      "Use it right before every submit, with the job_id. Not early, and not for a job you won't submit now: " +
        "each clearance counts toward the per-minute pace at once.",
      "Behavior: allows at most 3 submissions a minute (or the user's slower setting), keeps the user's daily " +
        "cap and, for easy_apply, whether the user allows one-click apply. A clearance is for one job, lasts 15 " +
        "minutes and is used up when freeapply_update_job records applied; asking again for the same job issues a " +
        "new one. Clearances last only while FreeApply runs.",
      "Parameters: job_id gets the clearance; without it you only see the pace. method (default external) " +
        "matters only for easy_apply, refused while one-click apply is off. run_id, in an unattended run, first " +
        "checks that run's time and application budgets and the dashboard's Stop button.",
      "Returns: {clear, advice, last_minute, limit_per_minute, today, daily_cap}, plus clearance {job_id, " +
        "expires_at} when clear. clear false: don't submit; prepare the next job and call again later. refused: " +
        "one-click apply is off; apply on the employer's site or skip the job. stop_run true, with reason: the " +
        "run must end now; call freeapply_autorun action finish."),
    S({ job_id: { ...JOB_ID, description: "The job about to be submitted." },
      method: oneOf(["external", "easy_apply", "email"], "How you will submit: external (an employer or ATS form; default), easy_apply (a job board's one-click apply) or email."),
      run_id: str("In an unattended run only: the run_id that freeapply_autorun start returned.") }),
    (a, ctx) => rules.throttle(ctx.rules(), a.method || "external", a.job_id, a.run_id)],
  ["freeapply_update_job", "Update a job's application status", SET,
    desc(
      "Records your side of an application by setting a tracked job's status. Unlike freeapply_record_outcome " +
        "(what the employer did) and freeapply_claim_job (adding a job), it changes a job you already claimed.",
      "Use it after a submit (applied), when you give up on a job (skipped or failed), and when the user must " +
        "act: needs_info with the form's questions, needs_account with the sign-up page, blocked by a check you " +
        "can't pass. Not for employer replies.",
      "Behavior: replaces the job's status. Enforced: applied needs a fresh clearance from " +
        "freeapply_clear_to_submit for this job; cover_text must pass the truthfulness check; a job already " +
        "applied to only the user can change. needs_info questions go to the Needs you tab and re-queue the job " +
        "once answered; if the user already answered them all, the call is refused with the answers to use.",
      "Parameters: note is one plain sentence the user reads, with no technical terms. Some fields go with one " +
        "status and are refused with any other: questions (at least one) with needs_info; account_url with " +
        "needs_account; method, confirmation, resume_path, cover_path and cover_text with applied. The résumé " +
        "copy and the letter saved by freeapply_check_text are recorded by default; pass the file and letter " +
        "fields only when you sent something else.",
      "Returns: {job_id, status}, and when relevant: already_waiting; questions (each added, duplicate, grouped " +
        "or already_answered, with its answer) and questions_added; same_account (needs_account: jobs sharing " +
        "one sign-up card); same_site (blocked: jobs blocked on the same site).",
      "Errors: an unknown job_id or a broken rule, saying what is missing."),
    S({ job_id: JOB_ID, status: oneOf(STATUS_IDS, `New status: ${listed(store.STATUSES)}.`),
      note: str("What happened, for the user, e.g. \"The site asked to prove you're a person.\""),
      account_url: str("For needs_account: the site's sign-up page. Jobs with the same one share a card, and one \"I made the " +
        "account\" re-queues them all; without it the application link is used, so jobs rarely share."),
      method: oneOf(["easy_apply", "external", "email"], "For applied: how it was submitted."),
      confirmation: str("For applied: the confirmation text or number the site showed."),
      resume_path: str("For applied: the résumé file sent, if not the documents copy. Optional."),
      cover_path: str("For applied: the cover-letter file sent, if not the saved one. Optional."),
      cover_text: str("For applied: the cover letter sent, if not the saved one. Optional."),
      questions: { type: "array", description: "For needs_info: the form's unanswered questions, each with a plain prompt and the simplest " +
        "kind of answer that fits.",
        items: { type: "object", properties: { label: str("The question exactly as the form words it (you need it to fill the form later)."),
          prompt: str("The question in plain words for the user: one short sentence, no form codes or jargon, e.g. " +
            "\"Can you work weekends?\" for \"Availability - Sat/Sun shifts (Y/N)*\"."),
          help: str("Optional one-line hint the user sees under the prompt: why it's asked or what a good answer looks like."),
          type: oneOf(["text", "textarea", "yesno", "choice", "multi", "number", "date"], "Kind of answer: yesno or choice for fixed answers (one; " +
            "buttons up to 5 options, a dropdown for more), multi (all that apply), number, date, or text or textarea."),
          options: list("Choices, for choice or multi, worded as the form offers them."),
          required: { type: "boolean", description: "Whether the form requires it." } }, required: ["label"] } } },
    ["job_id", "status"]),
    (a, ctx) => rules.agentSetStatus(ctx.rules(), a)],
  ["freeapply_report_site_problem", "Report a job site signed out or limited", SET,
    desc(
      "Tells FreeApply that one of the user's job sites can't be used right now: it signed the user out, or " +
        "showed its own daily limit. Unlike freeapply_find_site_account, which is about an employer's own careers " +
        "site, it is for the job sites the user chose in Settings, such as LinkedIn or Indeed.",
      "Use it as soon as a chosen job site shows a sign-in page or a daily limit, then keep applying on the " +
        "ready sites or on company career sites. Never type a password.",
      "Behavior: a signed-out site stays unavailable until the user signs in again and confirms it in the " +
        "dashboard; a limited site is paused until midnight. Meanwhile freeapply_claim_job refuses new jobs from " +
        "it. Reporting the same problem again changes nothing, and only the user can mark a site ready.",
      "Parameters: site is the job site's id as freeapply_status lists it in sites. status is signed_out (a " +
        "sign-in page, or the site says you're signed out) or limit_reached (the site's own daily limit, e.g. " +
        "\"You reached today's Easy Apply limit\").",
      "Returns: {site, status, sites}, where sites lists each chosen site with ready.",
      "Errors: a site the user didn't choose."),
    S({ site: oneOf(SITE_IDS, "The job site, as listed in freeapply_status sites."),
      status: oneOf(["signed_out", "limit_reached"], "What the site showed.") }, ["site", "status"]),
    (a) => {
      store.markSite(a.site, a.status);
      return { site: a.site, status: a.status, sites: store.siteReadiness() };
    }],
  ["freeapply_autorun", "Start or finish an unattended run", ADD,
    desc(
      "Starts and finishes unattended (scheduled) runs, and records the schedule. Unlike freeapply_status, " +
        "which only shows the run state, it changes it; the schedule itself is a scheduled task in the user's AI " +
        "app.",
      "Use start at the beginning of every scheduled run and finish at its end, also when stopping early. Use " +
        "schedule_created or schedule_removed after you create or delete the scheduled task, so the dashboard " +
        "shows it. Not in a session the user runs by hand.",
      "Behavior: start opens a run only when one may go now; another start while a run is going, or within 10 " +
        "minutes of its planned end, gets go false. During the run, freeapply_clear_to_submit with the run_id " +
        "ends it when a budget runs out or the user presses Stop. finish releases the run; finishing a run that " +
        "already ended is harmless.",
      "Parameters: action picks the step. finish needs the run_id from start and takes summary, one line on the " +
        "run, e.g. \"applied 4, needs you 2\" (up to 500 characters).",
      "Returns: start {go: true, run_id, minutes, max_applications, sites}, or {go: false, reason} (auto-run " +
        "off, Terms or setup missing, daily cap reached, or another run going); then stop at once, quietly. " +
        "finish {finished, applied_this_run}, null for a run no longer active. schedule_created and " +
        "schedule_removed {schedule_created}.",
      "Errors: finish without run_id, or another action."),
    S({ action: oneOf(["start", "finish", "schedule_created", "schedule_removed"], "start or finish a run, or report the scheduled task."),
      run_id: str("For finish: the run_id that start returned."),
      summary: str("For finish: one line on the run.") }, ["action"]),
    (a) => {
      switch (a.action) {
        case "start": return autorun.start();
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
      "Lists the user's tracked jobs, most recent activity first (submitted, else updated, else found). Unlike " +
        "freeapply_job_stats, which gives totals and rates, it returns the jobs themselves.",
      "Use it to find a job_id or to answer questions about particular jobs. Not for adding or changing jobs; " +
        "that is freeapply_claim_job and freeapply_update_job.",
      "Behavior: read-only.",
      "Parameters: filters combine. status and outcome match exactly; search finds text in the title, company " +
        "or location, ignoring case. limit (default 200, at most 2000) and offset (default 0) page through long " +
        "lists: fewer jobs than limit means the end.",
      "Returns: a list of jobs, each with id, title, company, location, work_mode, pay_text, pay_min, pay_max, " +
        "url, apply_url, fit_score, status, status_note, outcome, outcome_at, source, found_at, updated_at, " +
        "method, submitted_at, confirmation, resume_path, cover_path and reply_count; empty when nothing matched."),
    S({ status: oneOf(STATUS_IDS, "Only jobs with this status. Optional."), outcome: oneOf(OUTCOME_IDS, "Only jobs with this employer outcome. Optional."),
      search: str("Text to find in the title, company or location. Optional."),
      limit: int("Most jobs to return. Optional; default 200.", { minimum: 1, maximum: 2000, default: 200 }),
      offset: int("Jobs to skip, for the next page. Optional; default 0.", { minimum: 0, default: 0 }) }),
    (a) => store.listJobs(a.status, a.outcome, a.search, a.limit || 200, a.offset || 0)],
  ["freeapply_job_stats", "Get job-search statistics", READ,
    desc(
      "Summarizes the user's job search in numbers: applications, replies, interviews, offers and rates. Unlike " +
        "freeapply_list_jobs (individual jobs) and freeapply_status (whether FreeApply can run), it gives " +
        "totals.",
      "Use it to report progress, for example when wrapping up a session. Not for finding a particular job.",
      "Behavior: read-only and cheap: counted fresh from the local database on each call, nothing cached. Takes " +
        "no parameters.",
      "Returns: tracked, applied, applied_today, queued, needs_you (jobs waiting on the user), interviews, " +
        "offers, rejections, acknowledged, response_rate (percent of applications with a real reply, automatic " +
        "acknowledgements not counted), avg_fit, last_reply_check (when the last Gmail reply check finished), " +
        "counts by_status, by_outcome and by_method, daily (applications per day), and top_companies, top_titles " +
        "and top_jobs."),
    S(), () => store.stats()],
  ["freeapply_reply_check", "Start or finish a Gmail reply check", { ...ADD, idempotentHint: true },
    desc(
      "Begins and ends a Gmail reply check (the freeapply-replies procedure). Unlike freeapply_record_outcome, " +
        "which records each email, it frames the check: start gives the plan, finish marks it done.",
      "Use start before searching Gmail and finish once every email you found is recorded. Not for recording an " +
        "email.",
      "Behavior: start is read-only and can be repeated. finish sets the last check to now, so the next check " +
        "searches only newer email: call it only after recording everything you found.",
      "Parameters: action start returns the plan: since (search Gmail from this time), gmail (the user's mail " +
        "action: none, star, label or star_and_label, plus label_name), applied (the jobs applied to: job_id, " +
        "company, title, submitted_at) and known_message_ids (already recorded: skip them). action finish marks " +
        "the check done.",
      "Returns: start: the plan above. finish: {last_check}.",
      "Errors: another action."),
    S({ action: oneOf(["start", "finish"], "start returns the plan; finish marks the check done.") }, ["action"]),
    (a) => {
      if (a.action === "start") return store.replyCheckPlan();
      if (a.action === "finish") return { last_check: store.markReplyCheckDone().gmail.last_check };
      throw new Error("action must be start or finish");
    }],
  ["freeapply_record_outcome", "Record what an employer did", { ...ADD, idempotentHint: true },
    desc(
      "Records what an employer did with an application: acknowledged, replied, assessment, interview, rejected " +
        "or offer. Unlike freeapply_update_job, which records your side (applied, skipped, ...), it is about the " +
        "employer's response.",
      "Use it for each employer email found during a reply check, between freeapply_reply_check start and " +
        "finish, and when the user tells you about a call or corrects an outcome. Not for your own steps.",
      "Behavior: with an email (gmail_message_id) it stores the email and raises the job's outcome only if this " +
        "email ranks higher than the current one (an interview outranks an acknowledgement); the same " +
        "gmail_message_id again stores nothing new. Without an email it sets the outcome exactly, whatever its " +
        "rank, and an empty outcome clears it.",
      "Parameters: outcome is required; \"\" clears it, without an email only. job_id, from the reply-check plan " +
        "or freeapply_list_jobs, is required without an email; with an email it is optional, but then no outcome " +
        "changes. The email fields fill the dashboard's Replies tab: gmail_thread_id, company, sender, subject, " +
        "received_at (ISO 8601), summary (at most 20 words, no personal data beyond what is needed) and " +
        "mail_action (starred, labeled:<name>, starred+labeled:<name> or none).",
      "Returns: with an email {recorded, kind, job_id, outcome}, where outcome is the job's outcome afterwards " +
        "and both are null without job_id; without one {job_id, outcome}.",
      "Errors: an unknown job_id, no job_id and no email, or an empty outcome with an email."),
    S({ job_id: { ...JOB_ID, description: "The job it is about." },
      outcome: { type: "string", enum: [...OUTCOME_IDS, ""], description: `What the employer did: ${listed(store.OUTCOMES)}; ` +
        "or \"\" to clear it." },
      gmail_message_id: str("The employer email's Gmail message id."),
      gmail_thread_id: str("With an email: Gmail thread id."), company: str("With an email: the employer that sent it."),
      sender: str("With an email: sender address."), subject: str("With an email: subject line."),
      received_at: str("With an email: when it arrived (ISO 8601)."),
      summary: str("With an email: one sentence on what it says."),
      mail_action: str("With an email: what you did with it in Gmail.") }, ["outcome"]),
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
      "Shows or sends the data the user chose to share with the FreeApply server. Unlike " +
        "freeapply_get_settings, which shows the sharing choices, it shows the exact data those choices send.",
      "Use preview when the user asks what is shared, and sync only when the user asks to send now; it also " +
        "runs on its own every 12 hours. Not for changing the choices: the user does that in the dashboard " +
        "(Settings, Data sharing).",
      "Behavior: preview is read-only and sends nothing. sync sends over the internet only what the current " +
        "choices allow and can't be undone from here; the user can delete their shared data in the dashboard.",
      "Parameters: action preview is safe to call any time; action sync sends now and is refused moments after " +
        "the last sync.",
      "Returns: preview: the exact requests that would be sent: analytics_request (anonymous usage and " +
        "job-market data) and the talent-pool request, only if the user joined, secrets hidden. sync: {sent, " +
        "result}, or {sent: false, reason}: the Terms not accepted, a sync moments ago, or the server unreachable " +
        "(the automatic sync retries later).",
      "Errors: another action."),
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
    return text((await tool.handler(checkArgs(tool, args), ctx)) ?? {});
  } catch (e) {
    // Refusals and bad arguments are answers; anything unexpected also goes into the local problem log.
    if (errorlog.unexpected(e)) errorlog.record("tool", name, e);
    return text(`error: ${e.message}`, true); // tool errors go back to the model, not the protocol
  }
}
