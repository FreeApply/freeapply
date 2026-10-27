// Sponsored cards in the dashboard. A signed ad pack sits on our server behind the CDN; the agent checks it about once a
// day with a conditional request (an unchanged pack costs a "304 Not Modified" from the CDN), caches it, and picks a
// card on this computer from the user's own targets. Nothing about the user is sent to choose or show a card. Views
// and clicks are counted locally and leave only inside the opt-in usage statistics.
// Third-party ad scripts (AdSense and the like) never run in the dashboard: they could read the local API.
import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";
import { region } from "./sharing.js";
import { open, parseKeys } from "./workflow.js";

// The published pack. With this empty, nothing is fetched.
export const DEFAULT_ADS_URL = "https://www.mybotsai.com/ads/pack.json";
const ADS_URL = () => process.env.FREEAPPLY_ADS_URL || DEFAULT_ADS_URL;
// Every 6 hours, so a new sponsor card reaches installs the same day. An unchanged pack costs one "304 Not Modified".
const CHECK_EVERY_MS = 6 * 3600e3;
// What the card's label says: a paid placement, an affiliate link (we may earn a commission), or our own promotion.
export const KINDS = ["sponsored", "affiliate", "house"];
const MAX_PACK = 512 * 1024;
const COUNTS = "ad_counts";

let keys = new Map();
let allowedHosts = [];
/** Ad packs are signed with their own keys (agent/keys/ads.pub), never accepted by the workflow guard. The pack's key
 * may live on the server to build packs from partner feeds, so link domains are limited by the signed workflow
 * (rules.ad_link_hosts, offline key): a hacked server cannot point cards anywhere else. */
export function init(adKeysText, linkHosts = []) {
  try {
    keys = parseKeys(adKeysText || "");
  } catch {
    keys = new Map(); // no ad key: no pack verifies and no card is shown
  }
  allowedHosts = (linkHosts || []).map((h) => String(h).toLowerCase());
}

function hostAllowed(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

const cacheFile = () => path.join(store.paths.data, "ads.json");
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}
const writeCache = (c) => fs.writeFileSync(cacheFile(), JSON.stringify(c));

function verifiedPack(cache = readCache()) {
  if (!cache.raw) return null;
  try {
    const { bundle } = open(cache.raw, keys);
    return bundle.format === 1 && Array.isArray(bundle.ads) ? bundle : null;
  } catch {
    return null;
  }
}

/** The daily ping: fetch the pack only if it changed; accept it only if it verifies and is not older. */
export async function refresh(force = false) {
  const url = ADS_URL();
  if (!url) return { checked: false, reason: "no ad server configured" };
  const cache = readCache();
  if (!force && cache.checked_at && Date.now() - Date.parse(cache.checked_at) < CHECK_EVERY_MS) {
    return { checked: false, reason: "checked recently" };
  }
  const headers = { "User-Agent": `FreeApply/${store.VERSION}` };
  if (cache.etag) headers["If-None-Match"] = cache.etag;
  if (cache.last_modified) headers["If-Modified-Since"] = cache.last_modified;
  const next = { ...cache, checked_at: new Date().toISOString() };
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) {
    writeCache(next);
    return { checked: true, updated: false, status: r.status }; // 304: unchanged; anything else: keep the cached pack
  }
  const raw = (await r.text()).slice(0, MAX_PACK);
  let pack;
  try {
    pack = open(raw, keys).bundle;
  } catch (e) {
    writeCache(next);
    return { checked: true, updated: false, reason: `rejected: ${e.message}` };
  }
  const have = verifiedPack(cache);
  if (have && pack.version < have.version) {
    writeCache(next);
    return { checked: true, updated: false, reason: `rejected: pack ${pack.version} is older than ${have.version}` };
  }
  writeCache({ ...next, raw, etag: r.headers.get("etag"), last_modified: r.headers.get("last-modified") });
  return { checked: true, updated: true, version: pack.version };
}

const cut = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const usable = (a) => a && typeof a.id === "string" && typeof a.title === "string" && /^https:\/\/[^\s"'<>]+$/.test(a.url || "")
  && hostAllowed(a.url);

function count(id, kind) {
  const c = JSON.parse(store.metaGet(COUNTS) || "{}");
  if (!c[id] && Object.keys(c).length >= 200) return;
  c[id] = { shown: 0, clicked: 0, ...c[id] };
  c[id][kind]++;
  store.metaSet(COUNTS, JSON.stringify(c));
}

/** One card for a dashboard slot, chosen here from the cached pack by date, region and the user's own targets. */
export function pick(slot = "overview") {
  const pack = verifiedPack();
  const t = Date.now();
  if (!pack || (pack.expires && Date.parse(pack.expires) <= t)) return null;
  const s = store.loadSettings();
  const reg = region(s);
  const words = [...(s.targets.desired_roles || []), ...(s.targets.fields || [])].join(" ").toLowerCase();
  const fits = pack.ads.filter((a) => usable(a) && (!a.slots || a.slots.includes(slot)) && (!a.regions || a.regions.includes(reg))
    && (!a.starts || Date.parse(a.starts) <= t) && (!a.ends || Date.parse(a.ends) > t)
    && (!a.match?.length || a.match.some((m) => words.includes(String(m).toLowerCase()))));
  if (!fits.length) return null;
  const weight = (a) => Math.max(0, Number(a.weight) || 1);
  let x = Math.random() * fits.reduce((n, a) => n + weight(a), 0);
  const ad = fits.find((a) => (x -= weight(a)) < 0) || fits[0];
  count(ad.id, "shown");
  return { id: ad.id, kind: KINDS.includes(ad.kind) ? ad.kind : "sponsored", sponsor: cut(ad.sponsor, 60), title: cut(ad.title, 80), text: cut(ad.text, 220),
    cta: cut(ad.cta, 30) || "Learn more", url: ad.url };
}

export function click(id) {
  if (!verifiedPack()?.ads.some((a) => a.id === id)) return { counted: false };
  count(id, "clicked");
  return { counted: true };
}
