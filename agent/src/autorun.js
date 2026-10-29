// Unattended runs: a scheduled task wakes the agent (hourly by default) with no user prompt. A run keeps applying
// until there is nothing new to apply to or a hard stop; the hourly wake only starts a new one when none is going (one
// that died, at a usage limit or with the app closed, goes quiet and counts as ended after STALE_MIN). The hard stops
// are decided here in code, not by the agent: the user's on/off switch, a Stop request from the dashboard, the run's
// optional time and application limits, the daily cap, setup and Terms, and one run at a time.
import crypto from "node:crypto";
import * as store from "./store.js";
import * as sharing from "./sharing.js";

const LOCK = "autorun_lock", STOP = "autorun_stop_requested";

const STALE_MIN = 15; // a run checks in with every working tool call (touch) and before every submit (check)
const readLock = () => JSON.parse(store.metaGet(LOCK) || "null");
const minutesLeft = (lock) => (lock.ends_at ? Math.max(0, Math.round((Date.parse(lock.ends_at) - Date.now()) / 60_000)) : null);
const alive = (lock) => !!lock && Date.now() - Date.parse(lock.seen_at || lock.started_at) < STALE_MIN * 60_000 &&
  (!lock.ends_at || Date.parse(lock.ends_at) + 10 * 60_000 > Date.now());
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

/** Starts a run if nothing stops it. Only one run holds the lock; a quiet or overdue lock is stale. */
export function start() {
  const s = store.loadSettings();
  const stop = blockers(s);
  const held = readLock();
  if (alive(held)) stop.push(`run ${held.run_id} is still going (started ${held.started_at})`);
  if (stop.length) return { go: false, reason: stop.join("; ") };
  const minutes = Number(s.autorun.max_run_minutes) ? Math.max(5, Number(s.autorun.max_run_minutes)) : null; // null: no time limit
  const lock = { run_id: crypto.randomUUID().slice(0, 8), started_at: store.now(), seen_at: new Date().toISOString(),
    ends_at: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null };
  store.metaSet(LOCK, JSON.stringify(lock));
  store.run("DELETE FROM meta WHERE key=?", STOP);
  store.run("INSERT INTO runs (started_at, summary) VALUES (?, ?)", lock.started_at, `auto-run ${lock.run_id}`);
  return { go: true, run_id: lock.run_id, minutes, max_applications: s.autorun.max_applications ?? null, sites: sitesNow(s),
    note: "Pass this run_id to freeapply_clear_to_submit before every submit and stop when it returns stop_run; call " +
      "freeapply_autorun with action finish at the end." };
}

// While the user has auto-run off, one scheduled session waits inside a single call (start with wait) and begins the
// moment they press Start, instead of at the next hourly wake. Only one session waits: the waiter mark is refreshed
// while it waits, and a wake that finds a live one leaves at once.
const WAITER = "autorun_waiter", WAIT_MS = 10 * 60_000, POLL_MS = 2000;
const waiterAlive = () => { const w = JSON.parse(store.metaGet(WAITER) || "null"); return w && Date.now() - Date.parse(w.seen_at) < 60_000 ? w : null; };
const onlyOff = (reason) => reason.split("; ").every((r) => /auto-run is off/.test(r));

/** start(), but while auto-run is off only because the user pressed Stop, waits up to `ms` for Start. {signal, progress}
 * come from the MCP call: a cancel ends the wait, progress keeps the AI app from timing it out. */
export async function startOrWait({ signal, progress, ms = WAIT_MS, poll = POLL_MS } = {}) {
  let r = start();
  if (r.go || !onlyOff(r.reason)) return r;
  const other = waiterAlive();
  const me = crypto.randomUUID().slice(0, 8);
  if (other) return { go: false, reason: "another session is already waiting for the user to press Start" };
  const mark = () => store.metaSet(WAITER, JSON.stringify({ id: me, seen_at: new Date().toISOString() }));
  mark();
  const until = Date.now() + ms;
  let ticks = 0;
  try {
    while (Date.now() < until && !signal?.aborted) {
      await new Promise((res) => { const t = setTimeout(res, poll); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
      if (++ticks === 1 || ticks % 10 === 0) { mark(); progress?.(ticks, "waiting for the user to press Start"); }
      if (store.loadSettings().autorun.enabled) { r = start(); if (r.go || !onlyOff(r.reason)) return r; }
    }
    return { go: false, reason: "auto-run is still off", wait_again: !signal?.aborted };
  } finally {
    if (JSON.parse(store.metaGet(WAITER) || "null")?.id === me) store.run("DELETE FROM meta WHERE key=?", WAITER);
  }
}

/** May the run continue? freeapply_clear_to_submit asks this before every submit of an unattended run. */
export function check(runId) {
  const lock = readLock();
  if (!lock || lock.run_id !== runId) return { go: false, reason: "this run is not active (finished, stopped or replaced)" };
  const s = store.loadSettings();
  const stop = blockers(s);
  if (store.metaGet(STOP)) stop.push("the user pressed Stop in the dashboard");
  if (minutesLeft(lock) === 0) stop.push("the run's time limit is used up");
  else store.metaSet(LOCK, JSON.stringify({ ...lock, seen_at: new Date().toISOString() }));
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

// The next wake of the scheduled task: on the hour, every every_hours hours from midnight, the computer's local time.
function nextWake(everyHours, from = new Date()) {
  const d = new Date(from); d.setMinutes(0, 0, 0);
  do d.setHours(d.getHours() + 1); while (d.getHours() % Math.max(1, Number(everyHours) || 1));
  return d.toISOString();
}

/** For the dashboard: switch state, the run in progress, recent runs, and one state for the top bar: setup (setup not
 * complete), off, schedule (on, but the AI app has not set up its schedule yet), paused (a hard stop such as the daily
 * cap), on (between runs: the next wake, next_run_at, starts one), running (a run, or the user's own session, is
 * working: activity says on what) or stopping. */
export function status() {
  const s = store.loadSettings();
  const lock = readLock();
  const running = alive(lock) ? { ...lock, applied: appliedSince(lock.started_at),
    minutes_left: minutesLeft(lock), stop_requested: !!store.metaGet(STOP) } : null;
  const stops = blockers(s).filter((b) => !/auto-run is off|setup is not complete/.test(b));
  const act = JSON.parse(store.metaGet("activity") || "null");
  const activity = act && Date.now() - Date.parse(act.at) < 10 * 60_000 ? act.text : null;
  const state = running?.stop_requested ? "stopping" : running || activity ? "running" : store.missingFields(s).length ? "setup"
    : !s.autorun.enabled ? "off" : !s.autorun.schedule_created ? "schedule" : stops.length ? "paused" : "on";
  // waiting: a scheduled session is waiting for Start, so Start begins within seconds instead of at next_run_at.
  return { ...s.autorun, running, state, activity, reason: stops.join("; ") || null, waiting: !!waiterAlive(),
    next_run_at: s.autorun.schedule_created ? nextWake(s.autorun.every_hours) : null,
    recent: store.all("SELECT started_at, ended_at, summary FROM runs WHERE summary LIKE 'auto-run %' ORDER BY id DESC LIMIT 5") };
}

/** The agent is working (tools.js calls this on each working tool call): the run in progress stays alive. */
export function touch() {
  const lock = readLock();
  if (alive(lock)) store.metaSet(LOCK, JSON.stringify({ ...lock, seen_at: new Date().toISOString() }));
}

/** The dashboard's Start and Stop, the user's own switch. Stop also ends a run in progress at its next check. */
export function setOn(on) {
  store.saveSettings({ autorun: { enabled: !!on, chosen_at: store.now() } });
  if (!on && readLock()) store.metaSet(STOP, store.now());
  return status();
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
