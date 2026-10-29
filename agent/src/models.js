// Which of the AI app's models does each part of the work. FreeApply never runs a model: the AI app scans what it can
// hand a step to (freeapply_update_settings models, at setup and again after every update), the signed catalog in
// rules.json picks the best of those for each level (low, mid, high), and the user's picks in Advanced settings win.
// A level nothing fills uses the app's current model, so an app that can't hand off works exactly as before.
import * as store from "./store.js";

export const LEVELS = ["low", "mid", "high"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Set by main.js: the signed rules, the workflow version, and the AI app from the MCP handshake (clientInfo).
const env = { rules: () => ({}), workflow: () => null, client: null };
export function init({ rules, workflow } = {}) {
  if (rules) env.rules = rules;
  if (workflow) env.workflow = workflow;
}
export function setClient(info) {
  env.client = info?.name ? { name: String(info.name).slice(0, 80), version: String(info.version || "").slice(0, 40) } : null;
}
export const client = () => env.client;

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const hasWord = (name, word) => ` ${norm(name)} `.includes(` ${norm(word)} `);
const version = (name) => (norm(name).match(/\d+/g) || []).map(Number);
const newer = (a, b) => {
  const va = version(a), vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] ?? -1) !== (vb[i] ?? -1)) return (va[i] ?? -1) > (vb[i] ?? -1);
  return false;
};

/** The effort to ask for: the catalog's, or the nearest one below it that the app offers. */
function effortFor(want, offered) {
  if (!want || !offered?.length || offered.includes(want)) return want || null;
  const i = EFFORTS.indexOf(want);
  const below = offered.filter((e) => EFFORTS.includes(e) && EFFORTS.indexOf(e) <= i);
  return below.sort((a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a))[0] || offered[0];
}

/** The catalog's best available model for a level, newest version of the first family the app offers, or null. */
function pick(entries, scan) {
  for (const c of entries || []) {
    const fits = (scan.available || []).filter((m) => hasWord(m, c.match) && !(c.except || []).some((w) => hasWord(m, w)));
    const model = fits.reduce((best, m) => (best === null || newer(m, best) ? m : best), null);
    if (model) return { model, effort: effortFor(c.effort, scan.efforts) };
  }
  return null;
}

/** What the AI app reported it can hand work to, cleaned for settings.models. Throws on a malformed scan. */
export function cleanScan(raw, workflow = env.workflow()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("models must be an object: {app, current, can_delegate, available, efforts}");
  const names = (v, what) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`models.${what} must be a list of names`);
    return [...new Set(v.map((x) => x.trim()).filter(Boolean))].slice(0, 50);
  };
  if (raw.can_delegate !== undefined && typeof raw.can_delegate !== "boolean") throw new Error("models.can_delegate must be true or false");
  const available = names(raw.available, "available");
  const text = (v) => (v == null ? null : String(v).trim().slice(0, 120) || null);
  return { app: text(raw.app), current: text(raw.current), can_delegate: raw.can_delegate === true,
    available, efforts: names(raw.efforts, "efforts"), scanned_at: store.now(),
    scanned_for: { client: env.client?.name || null, app_version: store.VERSION, workflow } };
}

/** Each level's model and effort, each lane's, and whether the app should scan again (first run, or FreeApply, its
 * workflow or the AI app changed since the last scan). unfilled: levels the catalog couldn't fill and the user hasn't
 * picked; they use the app's current model and the dashboard asks for a pick in Advanced view. */
export function resolve({ rules = env.rules(), workflow = env.workflow(), settings = store.loadSettings() } = {}) {
  const scan = settings.models || {}, picks = settings.model_choices || {}, catalog = rules.model_catalog || {};
  const was = scan.scanned_for || {};
  const rescan = !scan.scanned_at || was.app_version !== store.VERSION || (workflow != null && was.workflow !== workflow) ||
    (!!env.client && was.client !== env.client.name);
  const levels = {}, unfilled = [];
  for (const level of LEVELS) {
    const p = picks[level] || {};
    const picked = scan.can_delegate && p.model && (!scan.available?.length || scan.available.includes(p.model));
    const auto = scan.can_delegate ? pick(catalog[level], scan) : null;
    if (picked) levels[level] = { model: p.model, effort: p.effort || auto?.effort || null, source: "user" };
    else if (auto) levels[level] = { ...auto, source: "catalog" };
    else {
      levels[level] = { model: "current", effort: null, source: "current" };
      if (scan.can_delegate) unfilled.push(level);
    }
  }
  const lanes = Object.fromEntries(Object.entries(rules.model_lanes || {}).map(([lane, level]) => [lane, { level, ...levels[level] }]));
  return { can_delegate: !!scan.can_delegate, rescan, app: scan.app || env.client?.name || null, current: scan.current || null,
    levels, lanes, unfilled, available: scan.available || [], efforts: scan.efforts || [], scanned_at: scan.scanned_at || null };
}

/** The procedure text one lane needs: the whole text without its "## Lanes" section (only the agent that starts helpers
 * needs it) and with "## Loop" cut to the numbered steps in `steps`. Null when `steps` is empty or the text lacks that
 * shape, so the caller sends the whole procedure. */
export function laneProcedure(text, steps) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const out = [], seen = new Set();
  let section = "", keep = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = /^## (.+)$/.exec(line);
    if (h) { section = h[1].trim(); keep = null; }
    if (/^Lanes\b/.test(section)) continue;
    if (section === "Loop" && !h) {
      const n = /^(\d+)\. /.exec(line);
      if (n) { keep = steps.includes(Number(n[1])); if (keep) seen.add(Number(n[1])); }
      if (keep === false) continue;
    }
    out.push(line);
  }
  return seen.size === steps.length && out.includes("## Loop") ? out.join("\n").replace(/\n{3,}/g, "\n\n") : null;
}
