// Auto-run: FreeApply applies on its own from the AI session that setup ends in; there is no scheduled task. That
// session loops on freeapply_manage_autorun start with wait, which holds the call while nothing is due and returns go when it
// is time to apply: at once, after the rest that follows a finished search (every_hours), or the moment the user
// presses Start. It returns replies_due when the email reply check is due, and needs_user at once when setup or the
// Terms need the user (freeapply_get_status with wait then holds until they are done). A run keeps applying until nothing
// new is left or a hard stop. The hard stops are decided here in code, not by the agent: the user's Start/Stop, the
// optional limits (they turn auto-run off, like Stop), the daily cap (until tomorrow), setup and Terms. One session runs
// it: a session entering auto-run (the user asked for setup or to keep applying) presses Start and takes over, and the
// one it replaced is told to end at its next call. Settings saved during a run apply from the next run, or, if the
// user chooses, the run ends after the job in hand and the next one begins at once (requestRestart).
import crypto from "node:crypto";
import * as store from "./store.js";
import * as sharing from "./sharing.js";

const LOCK = "autorun_lock", STOP = "autorun_stop_requested", RUNNER = "autorun_runner", REST = "autorun_rest_until",
  SINCE = "autorun_since", STOPPED = "autorun_stopped", REPLIES = "autorun_replies_offered_at", RESTART = "autorun_restart_requested";
// The AI app starts one FreeApply server per session, so this process stands for the session.
const SELF = crypto.randomUUID().slice(0, 8);

const STALE_MIN = 15; // a run checks in with every working tool call (touch) and before every submit (check)
const meta = (key) => JSON.parse(store.metaGet(key) || "null");
const readLock = () => meta(LOCK);
const alive = (lock) => !!lock && Date.now() - Date.parse(lock.seen_at || lock.started_at) < STALE_MIN * 60_000;
const appliedSince = (ts) => store.one("SELECT count(*) AS n FROM applications WHERE submitted_at>=?", ts).n;
const hours = (v, dflt) => Math.max(1, Number(v) || dflt) * 3600_000;

// The user's limits count from the last Start (or the session that took over) and turn auto-run off when reached.
function limitReached(s) {
  const since = store.metaGet(SINCE);
  if (!since) return null;
  const apps = Number(s.autorun.max_applications), mins = Number(s.autorun.max_run_minutes);
  if (apps && appliedSince(since) >= apps) return `the limit of ${apps} applications in Settings is reached`;
  if (mins && Date.now() - Date.parse(since) >= mins * 60_000) return `the limit of ${mins} minutes in Settings is reached`;
  return null;
}
function minutesLeft(s) {
  const since = store.metaGet(SINCE), mins = Number(s.autorun.max_run_minutes);
  return mins && since ? Math.max(0, Math.round((Date.parse(since) + mins * 60_000 - Date.now()) / 60_000)) : null;
}

function blockers(s) {
  const out = [];
  if (!s.autorun.enabled) out.push(`auto-run is off in the user's settings${store.metaGet(STOPPED) ? ` (${store.metaGet(STOPPED)})` : ""}`);
  if (!sharing.consentStatus(s).ok) out.push("the Terms are not accepted");
  if (store.missingFields(s).length) out.push("setup is not complete");
  const cap = s.automation.daily_cap;
  if (cap && store.throttleCounts("external").today >= Number(cap)) out.push(`the daily cap of ${cap} applications is reached`);
  return out;
}

const sitesNow = (s) => store.siteReadiness(s);

/** Starts a run if nothing stops it. Only one run holds the lock; a quiet lock is stale. */
export function start(runner = SELF) {
  const s = store.loadSettings();
  const stop = blockers(s);
  const held = readLock();
  if (alive(held)) stop.push(`run ${held.run_id} is still going (started ${held.started_at})`);
  const rest = store.metaGet(REST);
  if (rest && Date.parse(rest) > Date.now()) stop.push(`the next search is due at ${rest}`);
  if (stop.length) return { go: false, reason: stop.join("; ") };
  if (!store.metaGet(SINCE)) store.metaSet(SINCE, store.now());
  const lock = { run_id: crypto.randomUUID().slice(0, 8), runner, started_at: store.now(), seen_at: new Date().toISOString() };
  store.metaSet(LOCK, JSON.stringify(lock));
  store.run("DELETE FROM meta WHERE key IN (?, ?)", STOP, RESTART);
  store.run("INSERT INTO runs (started_at, summary) VALUES (?, ?)", lock.started_at, `auto-run ${lock.run_id}`);
  return { go: true, run_id: lock.run_id, minutes: minutesLeft(s), max_applications: s.autorun.max_applications ?? null, sites: sitesNow(s),
    note: "Pass this run_id to freeapply_clear_to_submit before every submit and stop when it returns stop_run; call " +
      "freeapply_manage_autorun with action finish at the end, then start with wait again." };
}

// The email reply check is due once per interval, counted from the last check or the last time it was offered (a
// check that found no way to read email doesn't come back every poll), and only once something was applied to.
function repliesDue(s) {
  if (!s.gmail.enabled || !store.one("SELECT count(*) AS n FROM applications").n) return false;
  const every = hours(s.gmail.interval_hours, 4);
  return [s.gmail.last_check, store.metaGet(REPLIES)].every((t) => !t || Date.now() - Date.parse(t) >= every);
}

/** What the runner does now: a run (go), the reply check, the user (setup or Terms), or nothing yet (go false). */
function next(runner) {
  const s = store.loadSettings();
  if (s.autorun.enabled) {
    if (!sharing.consentStatus(s).ok) return { go: false, needs_user: "terms", reason: "the Terms are not accepted" };
    if (store.missingFields(s).length) return { go: false, needs_user: "setup", reason: "setup is not complete" };
    if (repliesDue(s)) {
      store.metaSet(REPLIES, new Date().toISOString());
      return { go: false, replies_due: true, reason: "the email reply check is due" };
    }
  }
  return start(runner);
}

// One session waits inside a single call (start with wait) and begins the moment something is due. Its mark is
// refreshed while it waits; the newest session to ask takes over, and the ones it replaced are told to end.
const WAIT_MS = 10 * 60_000, POLL_MS = 2000;
const waiterAlive = () => { const r = meta(RUNNER); return r && Date.now() - Date.parse(r.seen_at) < 60_000 ? r : null; };

/** Holds the call until `ready()` returns something, the time is up or the AI app cancels it. {signal, progress} come
 * from the MCP call: a cancel ends the wait, progress keeps the AI app from timing it out. */
export async function holdUntil(ready, { signal, progress, ms = WAIT_MS, poll = POLL_MS, tick } = {}) {
  const until = Date.now() + ms;
  let ticks = 0;
  for (;;) {
    const r = ready();
    if (r.done) return r;
    if (signal?.aborted || Date.now() >= until) return { ...r, wait_again: !signal?.aborted };
    await new Promise((res) => { const t = setTimeout(res, poll); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
    const stop = tick?.();
    if (stop) return stop;
    if (++ticks === 1 || ticks % 10 === 0) progress?.(ticks, `waiting: ${r.reason}`);
  }
}

/** The runner's call: start, or wait until something is due. takeover (the call right after the user asked this
 * session for setup or to keep applying) presses Start and makes this session the runner; without it, a session
 * another one took over from is told to end. */
export async function startOrWait({ signal, progress, ms = WAIT_MS, poll = POLL_MS, runner = SELF, takeover = false } = {}) {
  const prev = meta(RUNNER), held = readLock();
  const replaced = { go: false, reason: "another session runs FreeApply now; this one can end", replaced: true };
  if (prev?.id !== runner) {
    // The other runner is alive while it waits (its mark is refreshed about every 20 seconds) or holds a live run.
    const other = prev && (Date.now() - Date.parse(prev.seen_at) < 2 * 60_000 || (alive(held) && held.runner === prev.id));
    if (other && !takeover) return replaced;
    store.metaSet(SINCE, store.now());
  }
  if (alive(held) && held.runner === runner) finish(held.run_id, "ended without finish");
  // With the Terms and settings complete, asking for setup starts FreeApply: an earlier Stop, a limit or the rest after
  // a search doesn't keep this session waiting (the daily cap still does).
  if (takeover) setOn(true);
  const mark = () => store.metaSet(RUNNER, JSON.stringify({ id: runner, seen_at: new Date().toISOString() }));
  mark();
  let polls = 0;
  const r = await holdUntil(() => {
    const n = next(runner);
    return n.go || n.replies_due || n.needs_user ? { ...n, done: true } : { go: false, reason: n.reason };
  }, { signal, progress, ms, poll, tick: () => {
    if (meta(RUNNER)?.id !== runner) return replaced;
    if (++polls % 10 === 0) mark();
    return null;
  } });
  delete r.done;
  return r;
}

/** May the run continue? freeapply_clear_to_submit asks this before every submit of an unattended run. */
export function check(runId) {
  const lock = readLock();
  if (!lock || lock.run_id !== runId) return { go: false, reason: "this run is not active (finished, stopped or replaced)" };
  const s = store.loadSettings();
  const limit = s.autorun.enabled && limitReached(s);
  if (limit) { // a hard stop from Settings: auto-run turns off until the user presses Start
    store.saveSettings({ autorun: { enabled: false } });
    store.metaSet(STOPPED, limit);
  }
  const stop = blockers(store.loadSettings());
  if (store.metaGet(STOP)) stop.push("the user pressed Stop in the dashboard");
  if (!stop.length) store.metaSet(LOCK, JSON.stringify({ ...lock, seen_at: new Date().toISOString() }));
  const applied = appliedSince(lock.started_at);
  return stop.length ? { go: false, reason: stop.join("; "), applied_this_run: applied }
    : { go: true, minutes_left: minutesLeft(s), applied_this_run: applied, sites: sitesNow(s), ...(store.metaGet(RESTART) ? { restart: true } : {}) };
}

/** Ends the run, releases the lock, records a one-line summary and rests every_hours before the next search, unless the
 * user asked for a restart with new settings: then the next run begins at once. */
export function finish(runId, summary = "") {
  const lock = readLock();
  const mine = lock && lock.run_id === runId;
  if (mine) {
    store.run("DELETE FROM meta WHERE key IN (?, ?)", LOCK, STOP);
    if (store.metaGet(RESTART)) store.run("DELETE FROM meta WHERE key IN (?, ?)", RESTART, REST);
    else store.metaSet(REST, new Date(Date.now() + hours(store.loadSettings().autorun.every_hours, 1)).toISOString());
  }
  const applied = mine ? appliedSince(lock.started_at) : null;
  store.run("UPDATE runs SET ended_at=?, summary=? WHERE summary LIKE ? AND ended_at IS NULL", store.now(),
    `auto-run ${runId}: ${String(summary).slice(0, 500)}`, `auto-run ${runId}%`);
  return { finished: true, applied_this_run: applied };
}

/** For the dashboard: switch state, the run in progress, recent runs, and one state for the top bar: setup (setup not
 * complete), off (stopped; stopped_reason when a limit did it), idle (on, but no AI session is running FreeApply),
 * paused (the daily cap), on (between searches: the next one is at next_run_at), running (a run, or the user's own
 * session, is working: activity says on what) or stopping. waiting: a session waits, so Start begins within seconds. */
export function status() {
  const s = store.loadSettings();
  const lock = readLock();
  const running = alive(lock) ? { ...lock, applied: appliedSince(lock.started_at),
    minutes_left: minutesLeft(s), stop_requested: !!store.metaGet(STOP), restart_requested: !!store.metaGet(RESTART) } : null;
  const stops = blockers(s).filter((b) => !/auto-run is off|setup is not complete|Terms/.test(b));
  const act = JSON.parse(store.metaGet("activity") || "null");
  const activity = act && Date.now() - Date.parse(act.at) < 10 * 60_000 ? act.text : null;
  const waiting = !!waiterAlive();
  const rest = store.metaGet(REST);
  const state = running?.stop_requested ? "stopping" : running || activity ? "running" : store.missingFields(s).length ? "setup"
    : !s.autorun.enabled ? "off" : !waiting ? "idle" : stops.length ? "paused" : "on";
  return { ...s.autorun, running, state, activity, reason: stops.join("; ") || null, waiting,
    stopped_reason: !s.autorun.enabled ? store.metaGet(STOPPED) : null,
    next_run_at: waiting && rest && Date.parse(rest) > Date.now() ? rest : null,
    recent: store.all("SELECT started_at, ended_at, summary FROM runs WHERE summary LIKE 'auto-run %' ORDER BY id DESC LIMIT 5") };
}

/** The agent is working (tools.js calls this on each working tool call): the run in progress stays alive. */
export function touch() {
  const lock = readLock();
  if (alive(lock)) store.metaSet(LOCK, JSON.stringify({ ...lock, seen_at: new Date().toISOString() }));
}

/** The dashboard's Start and Stop, the user's own switch. Stop also ends a run in progress at its next check; Start
 * begins at once (no rest) and counts the limits afresh. */
export function setOn(on) {
  store.saveSettings({ autorun: { enabled: !!on, chosen_at: store.now() } });
  if (!on && readLock()) store.metaSet(STOP, store.now());
  if (on) {
    store.run("DELETE FROM meta WHERE key IN (?, ?)", REST, STOPPED);
    store.metaSet(SINCE, store.now());
  }
  return status();
}

/** The user's Stop button: the run stops at its next check. */
export function requestStop() {
  store.metaSet(STOP, store.now());
  return status();
}

/** The user saved settings during a run and chose to use them now: the run ends after the job in hand and the next one
 * begins at once, reading the new settings. Only while a run is going (otherwise the next run reads them anyway). */
export function requestRestart() {
  if (alive(readLock())) store.metaSet(RESTART, store.now());
  return status();
}

/** True in the session running the current run once the user asked for that restart (freeapply_claim_job says so). */
export function restartRequested() {
  const lock = readLock();
  return !!store.metaGet(RESTART) && alive(lock) && lock.runner === SELF;
}
