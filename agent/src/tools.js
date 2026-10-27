// MCP tools and the gates in front of them: workflow integrity first, then the user's acceptance of the Terms.
import * as store from "./store.js";
import * as sharing from "./sharing.js";
import * as dashboard from "./dashboard.js";
import { fetchPosting } from "./postings.js";
import * as rules from "./rules.js";
import * as autorun from "./autorun.js";
import * as updater from "./updater.js";

const S = (props = {}, required) => ({ type: "object", properties: props, ...(required ? { required } : {}) });
const STR = { type: "string" }, INT = { type: "integer" }, NUM = { type: "number" };
const LIST = { type: "array", items: STR };

// Tools usable while the workflow is locked (so the user can be told why), and before the Terms are accepted.
const WORKFLOW_UNGATED = new Set(["freeapply_status", "freeapply_open_dashboard"]);
const CONSENT_UNGATED = new Set(["freeapply_status", "freeapply_open_dashboard", "freeapply_workflow"]);

const scalars = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || ["number", "string", "boolean"].includes(typeof v)));

export const TOOLS = [
  ["freeapply_status", "Install/first-run check: data paths, workflow integrity, whether the Terms are accepted and setup is complete, missing settings, dashboard URL, counts.",
    S(), async (a, ctx) => {
      const { recent, ...auto } = autorun.status();
      return { ...store.bootstrap(), workflow: ctx.guard.status, terms: sharing.consentStatus(), dashboard: await dashboard.start(),
        sites: store.siteReadiness(), autorun: auto, update: updater.info(), stats: scalars(store.stats()) };
    }],
  ["freeapply_open_dashboard", "Start the local dashboard if needed and open it in the user's browser. tab: overview|applications|replies|issues|settings.",
    S({ tab: STR }), async (a) => {
      const url = await dashboard.start();
      if (url) dashboard.openBrowser(url + (a.tab ? `#${a.tab}` : ""));
      return { url, opened: !!url };
    }],
  ["freeapply_workflow", "The signed procedure for a task: freeapply-setup, freeapply-apply or freeapply-replies. Follow it exactly. Without a name, lists the procedures.",
    S({ name: STR }), (a, ctx) => {
      const b = ctx.guard.bundle, procs = b.procedures || {};
      const meta = { workflow_version: b.version, workflow_hash: ctx.guard.status.hash };
      if (!a.name) return { ...meta, procedures: Object.fromEntries(Object.entries(procs).map(([k, v]) => [k, v.description])) };
      const p = procs[a.name];
      if (!p) throw new Error(`no procedure ${a.name}; available: ${Object.keys(procs).join(", ")}`);
      return { name: a.name, description: p.description, text: p.text, ...meta };
    }],
  ["freeapply_get_settings", "Read the user's profile, targets, eligibility, resume info, automation and Gmail settings.",
    S(), () => ({ settings: store.publicSettings(store.loadSettings()), missing: store.missingFields() })],
  ["freeapply_update_settings", "Deep-merge a partial settings object, e.g. {\"targets\": {\"min_pay\": 60000}}. Only with values the user gave. Terms, data-sharing and integrity settings cannot be changed here.",
    S({ patch: { type: "object" } }, ["patch"]), (a, ctx) => {
      const s = store.saveSettings(rules.agentSettingsPatch(ctx.rules(), a.patch));
      return { setup_complete: s.setup_complete, missing: store.missingFields(s) };
    }],
  ["freeapply_check_duplicate", "Find jobs already tracked for this company / posting id, to avoid applying twice (reposts included).",
    S({ company: STR, title: STR, external_id: STR }, ["company"]), (a) => ({ matches: store.findDuplicates(a.company, a.title, a.external_id) })],
  ["freeapply_add_job", "Track (claim) a job before working on it. status: found or skipped. Returns job_id. Refuses a job with the same company and title as one already applied to, and records posted pay below the user's minimum as skipped.",
    S({ title: STR, company: STR, location: STR, work_mode: STR, pay_text: STR, pay_min: NUM, pay_max: NUM, url: STR,
      apply_url: STR, description: STR, fit_score: INT, fit_notes: STR, status: STR, status_note: STR,
      source: { type: "string", description: "linkedin, company_site, indeed, referral, ..." },
      external_id: { type: "string", description: "posting id on the source site" } }, ["title", "company"]),
    (a, ctx) => rules.claimJob(ctx.rules(), a)],
  ["freeapply_update_job", `Set a job's pipeline status (${Object.keys(store.STATUSES).join(", ")}) with note, method (easy_apply|external|email), confirmation text, document paths and cover_text (the letter actually submitted; it must pass the truthfulness check). 'applied' needs a clearance from freeapply_throttle for this job. ` +
    "For needs_info, pass `questions` (each {label, type: text|textarea|yesno|choice|multi|number|date, options, required}) exactly as the form asks them; the user answers them on the dashboard's Issues tab.",
    S({ job_id: INT, status: STR, note: STR, method: STR, confirmation: STR, resume_path: STR, cover_path: STR, cover_text: STR,
      questions: { type: "array", items: { type: "object" } } }, ["job_id", "status"]),
    (a, ctx) => ({ ...rules.agentSetStatus(ctx.rules(), a),
      questions_added: a.questions ? store.addQuestions(a.job_id, a.questions) : 0 })],
  ["freeapply_check_text", "Truthfulness check for a cover letter or free-text answer before it goes into a form: lists tools, claims, numbers and year counts the resume and settings do not support. kind: cover_letter|answer.",
    S({ text: STR, kind: STR, job_id: INT, company: STR }, ["text"]), (a, ctx) => {
      const problems = rules.checkText(ctx.rules(), a.text, { kind: a.kind || "answer", jobId: a.job_id, company: a.company });
      return { ok: !problems.length, problems };
    }],
  ["freeapply_get_answers", "Answers the user gave on the Issues tab for a job, plus their saved reusable answers. Call before retrying a re-queued job.",
    S({ job_id: INT }, ["job_id"]), (a) => store.jobAnswers(a.job_id)],
  ["freeapply_site_account", "Whether the user created an account on an employer site (domain or URL) and which email they used. Passwords are never stored: if an account exists, ask the user to sign in in the browser, then continue in their session.",
    S({ site: STR }, ["site"]), (a) => store.siteAccount(a.site)],
  ["freeapply_set_outcome", `Set what the employer did: ${Object.keys(store.OUTCOMES).join(", ")} (empty string clears).`,
    S({ job_id: INT, outcome: STR }, ["job_id", "outcome"]), (a) => store.setOutcome(a.job_id, a.outcome)],
  ["freeapply_site_status", "Report that a job site signed the user out (status signed_out) or showed its own daily limit (limit_reached, paused until tomorrow). Never type a password: keep applying on the other ready sites or on company career sites. Returns which sites are ready now.",
    S({ site: { type: "string", description: store.JOB_SITES.map((x) => x.id).join(", ") }, status: STR }, ["site", "status"]),
    (a) => {
      store.markSite(a.site, a.status);
      return { site: a.site, status: a.status, sites: store.siteReadiness() };
    }],
  ["freeapply_autorun", "Unattended runs. action start: may this run go (go=false means stop at once, quietly); check: call before each new job; finish: end the run with a one-line summary. schedule_created / schedule_removed: report that you created or removed the scheduled task in the user's AI app.",
    S({ action: STR, run_id: STR, summary: STR }, ["action"]), (a) => {
      switch (a.action) {
        case "start": return autorun.start();
        case "check": return autorun.check(a.run_id);
        case "finish": return autorun.finish(a.run_id, a.summary);
        case "schedule_created": return autorun.scheduleReported(true);
        case "schedule_removed": return autorun.scheduleReported(false);
        default: throw new Error("action must be start, check, finish, schedule_created or schedule_removed");
      }
    }],
  ["freeapply_throttle", "Call right before submitting, with the job_id. clear=false means wait and do other work first; clear=true returns the clearance that recording 'applied' needs.",
    S({ method: STR, job_id: INT }), (a, ctx) => rules.throttle(ctx.rules(), a.method || "external", a.job_id)],
  ["freeapply_list_jobs", "List tracked jobs, newest first, optionally filtered.",
    S({ status: STR, outcome: STR, search: STR, limit: INT }), (a) => store.listJobs(a.status, a.outcome, a.search, a.limit || 200)],
  ["freeapply_get_stats", "Dashboard numbers: applied, responses, interviews, offers, response rate, daily counts, top companies.",
    S(), () => store.stats()],
  ["freeapply_reply_check_plan", "Start a Gmail reply check: returns the time window, applied companies, already-recorded message ids and the mail action (none|star|label|star_and_label, label_name).",
    S(), () => store.replyCheckPlan()],
  ["freeapply_record_reply", `Record one employer email. kind: ${Object.keys(store.OUTCOMES).join(", ")}. mail_action: what was done in Gmail (starred, labeled:<name>, none).`,
    S({ job_id: INT, company: STR, gmail_message_id: STR, gmail_thread_id: STR, sender: STR, subject: STR,
      received_at: STR, kind: STR, summary: STR, mail_action: STR }, ["kind"]), (a) => store.recordReply(a)],
  ["freeapply_finish_reply_check", "Mark the reply check done (stamps last_check).", S(),
    () => ({ last_check: store.markReplyCheckDone().gmail.last_check })],
  ["freeapply_save_resume_text", "Store the plain text of the user's uploaded resume (read from settings.resume.primary) so later sessions need not re-read the file.",
    S({ text: STR }, ["text"]), (a) => {
      const s = store.saveSettings({ resume: { text: a.text } });
      return { setup_complete: s.setup_complete, missing: store.missingFields(s) };
    }],
  ["freeapply_save_resume_profile", "Store a structured summary of the resume, taken only from its text: headline, skills, titles, education, certifications (lists of strings).",
    S({ headline: STR, skills: LIST, titles: LIST, education: LIST, certifications: LIST }), (a) => {
      const profile = Object.fromEntries(["headline", "skills", "titles", "education", "certifications"].filter((k) => a[k] != null).map((k) => [k, a[k]]));
      const s = store.saveSettings({ resume: { profile } });
      return { setup_complete: s.setup_complete, missing: store.missingFields(s) };
    }],
  ["freeapply_fetch_posting", "Fetch a job posting on the user's computer and return it compactly: title, company, location, pay, description (trimmed), form questions and answers suggested from settings. Use instead of reading the whole page. Supports Greenhouse, Lever and Ashby APIs, plain text for other sites.",
    S({ url: STR, max_chars: INT, source: STR }, ["url"]), (a) => fetchPosting(a.url, a.max_chars || 6000, a.source)],
  ["freeapply_preview_shared_data", "Show exactly what FreeApply would send to the FreeApply server under the user's current data-sharing choices.",
    S(), () => sharing.preview()],
  ["freeapply_sync_shared_data", "Send opted-in data now (normally automatic every 12 hours). Does nothing for choices that are off.",
    S(), () => sharing.sync(true)],
].map(([name, description, inputSchema, handler]) => ({ name, description, inputSchema, handler }));

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
    return text(`error: ${e.message}`, true); // tool errors go back to the model, not the protocol
  }
}
