// FreeApply's own look at the mailbox between reply checks, so the Replies tab shows new employer emails as they
// arrive. With the email login the user saved, every EVERY_MIN minutes it lists new emails tied to an application
// (the same filter as the reply check: a company applied to, or a hiring system) and keeps only sender, subject and
// date. It never decides what an email means: the reply check (the AI app) records each one, which takes it off the
// list. Every FreeApply process runs the timer; the time of the last check in the database makes them take turns.
import * as store from "./store.js";
import * as secrets from "./secrets.js";
import { findReplies } from "./imap.js";

export const EVERY_MIN = 15;
const AT = "inbox_checked_at", ERR = "inbox_error";

/** Checks the mailbox if it is due (or now, with force). opts go to the IMAP connection (tests). */
export async function check({ force = false } = {}, opts = {}) {
  const s = store.loadSettings();
  const login = secrets.emailLogin();
  if (!login || !s.gmail.enabled || !s.setup_complete) return { checked: false, reason: "no email login, or email checks are off" };
  const last = Date.parse(store.metaGet(AT) || "");
  if (!force && Date.now() - last < EVERY_MIN * 60_000) return { checked: false, reason: "checked recently" };
  store.metaSet(AT, store.now()); // claim this turn before the slow part, so other processes skip it
  const plan = store.replyCheckPlan();
  if (!plan.applied.length) return { checked: true, new: 0 };
  const companies = [...new Set(plan.applied.map((j) => j.company).filter(Boolean))];
  const known = [...plan.known_message_ids, ...store.listInbox().map((e) => e.gmail_message_id)];
  try {
    const emails = await findReplies(login, { since: plan.since, companies, known }, opts);
    const named = (e) => { const hay = `${e.sender} ${e.subject} ${e.text}`.toLowerCase();
      return companies.find((c) => c.length > 2 && hay.includes(c.toLowerCase())) || null; };
    const added = store.inboxAdd(emails.map((e) => ({ ...e, company: named(e) })));
    store.run("DELETE FROM meta WHERE key=?", ERR);
    return { checked: true, new: added };
  } catch (e) {
    store.metaSet(ERR, e.message);
    return { checked: true, error: e.message };
  }
}

/** Runs check() every minute in the background; it only reaches the mail server when a turn is due. */
export function watch() {
  const tick = () => check().catch(() => {});
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 60_000).unref();
}
