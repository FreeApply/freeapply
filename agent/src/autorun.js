// Unattended runs: a scheduled task wakes the agent (hourly by default) with no user prompt. The hard stops are
// decided here in code, not by the agent: the user's on/off switch, a Stop request from the dashboard, the run's time
// and application budget, the daily cap, setup and Terms, and one run at a time.
import crypto from "node:crypto";
import * as store from "./store.js";
import * as sharing from "./sharing.js";

const LOCK = "autorun_lock", STOP = "autorun_stop_requested";

const readLock = () => JSON.parse(store.metaGet(LOCK) || "null");
const minutesLeft = (lock) => Math.max(0, Math.round((Date.parse(lock.ends_at) - Date.now()) / 60_000));
const appliedSince = (ts) => store.one("SELECT count(*) AS n FROM applications WHERE submitted_at>=?", ts).n;

function blockers(s) {
  const out = [];
  if (!s.autorun.enabled) out.push("auto-run is off in the user's settings");
  if (!sharing.consentStatus(s).ok) out.push("the Terms are not accepted");
  if (store.missingFields(s).length) out.push("setup is not complete");
  const cap = s.automation.daily_cap;
  if (cap && store.throttleCounts("external").today >= Number(cap)) out.push(`the daily cap of ${cap} applications is reached`);
  return out;
}

const sitesNow = (s) => store.siteReadiness(s);

/** Starts a run if nothing stops it. Only one run holds the lock; a lock older than its budget is stale. */
export function start() {
  const s = store.loadSettings();
  const stop = blockers(s);
  const held = readLock();
  if (held && Date.parse(held.ends_at) + 10 * 60_000 > Date.now()) stop.push(`run ${held.run_id} is still going (started ${held.started_at})`);
  if (stop.length) return { go: false, reason: stop.join("; ") };
  const minutes = Math.max(5, Math.min(Number(s.autorun.max_minutes) || 50, 55)); // always ends before the next hourly wake
  const lock = { run_id: crypto.randomUUID().slice(0, 8), started_at: store.now(), ends_at: new Date(Date.now() + minutes * 60_000).toISOString() };
  store.metaSet(LOCK, JSON.stringify(lock));
  store.run("DELETE FROM meta WHERE key=?", STOP);
  store.run("INSERT INTO runs (started_at, summary) VALUES (?, ?)", lock.started_at, `auto-run ${lock.run_id}`);
  return { go: true, run_id: lock.run_id, minutes, max_applications: s.autorun.max_applications ?? null, sites: sitesNow(s),
    note: "Pass this run_id to freeapply_clear_to_submit before every submit and stop when it returns stop_run; call " +
      "freeapply_autorun with action finish at the end." };
}

/** May the run continue? freeapply_clear_to_submit asks this before every submit of an unattended run. */
export function check(runId) {
  const lock = readLock();
  if (!lock || lock.run_id !== runId) return { go: false, reason: "this run is not active (finished, stopped or replaced)" };
  const s = store.loadSettings();
  const stop = blockers(s);
  if (store.metaGet(STOP)) stop.push("the user pressed Stop in the dashboard");
  if (minutesLeft(lock) <= 0) stop.push("the run's time budget is used up");
  const applied = appliedSince(lock.started_at);
  const max = s.autorun.max_applications;
  if (max && applied >= Number(max)) stop.push(`the run's budget of ${max} applications is used up`);
  return stop.length ? { go: false, reason: stop.join("; "), applied_this_run: applied }
    : { go: true, minutes_left: minutesLeft(lock), applied_this_run: applied, sites: sitesNow(s) };
}

/** Ends the run, releases the lock and records a one-line summary. */
export function finish(runId, summary = "") {
  const lock = readLock();
  if (lock && lock.run_id === runId) store.run("DELETE FROM meta WHERE key IN (?, ?)", LOCK, STOP);
  const applied = lock && lock.run_id === runId ? appliedSince(lock.started_at) : null;
  store.run("UPDATE runs SET ended_at=?, summary=? WHERE summary LIKE ? AND ended_at IS NULL", store.now(),
    `auto-run ${runId}: ${String(summary).slice(0, 500)}`, `auto-run ${runId}%`);
  return { finished: true, applied_this_run: applied };
}

/** For the dashboard: switch state, the run in progress and recent runs. */
export function status() {
  const lock = readLock();
  const running = lock && Date.parse(lock.ends_at) + 10 * 60_000 > Date.now() ? { ...lock, applied: appliedSince(lock.started_at),
    minutes_left: minutesLeft(lock), stop_requested: !!store.metaGet(STOP) } : null;
  return { ...store.loadSettings().autorun, running,
    recent: store.all("SELECT started_at, ended_at, summary FROM runs WHERE summary LIKE 'auto-run %' ORDER BY id DESC LIMIT 5") };
}

/** The user's Stop button: the run stops at its next check. */
export function requestStop() {
  store.metaSet(STOP, store.now());
  return status();
}

/** The agent created or removed the scheduled task in the user's AI app. */
export function scheduleReported(created) {
  store.saveSettings({ autorun: { schedule_created: !!created } });
  return { schedule_created: !!created };
}
