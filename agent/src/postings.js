// Fetches a job posting on the user's computer and returns it compactly, with form questions and suggested answers.
// Port of server/postings.py. Uses the public APIs of Greenhouse, Lever and Ashby when the URL is one of theirs,
// and plain page text otherwise, so the AI reads a short summary instead of a whole web page.
import * as store from "./store.js";

const UA = { "User-Agent": `FreeApply/${store.VERSION} (+local job-search assistant)` };
const LIMIT = 2_000_000;

async function get(url, asJson = true) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  const text = (await r.text()).slice(0, LIMIT);
  return asJson ? JSON.parse(text) : text;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", trade: "™", reg: "®", copy: "©" };
export function unescape(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function textOf(h) {
  let t = String(h || "").replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n").replace(/<li[^>]*>/gi, "• ");
  t = unescape(t.replace(/<[^>]+>/g, " "));
  return t.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

async function greenhouse(u) {
  const m = u.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
  const ghJid = u.searchParams.get("gh_jid");
  if (!m && !ghJid) return null;
  const slug = m ? m[1] : u.pathname.replace(/^\/+/, "").split("/")[0];
  const jid = m ? m[2] : ghJid;
  const d = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jid}?questions=true&pay_transparency=true`);
  const questions = (d.questions || []).map((q) => {
    const f = (q.fields || [{}])[0] || {};
    return { label: q.label, required: q.required, type: f.type, options: (f.values || []).map((v) => v.label).slice(0, 30) };
  }).map((q) => ({ ...q, options: q.options.length ? q.options : null }));
  const pay = (d.pay_input_ranges || []).map((r) => `${Math.floor((r.min_cents || 0) / 100)}-${Math.floor((r.max_cents || 0) / 100)} ${r.currency_type || ""}`);
  return { ats: "greenhouse", title: d.title, company: slug, location: d.location?.name ?? null, pay: pay.join("; ") || null,
    apply_url: d.absolute_url, description: textOf(unescape(d.content || "")), questions };
}

async function lever(u) {
  const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  const d = await get(`https://api.lever.co/v0/postings/${parts[0]}/${parts[1]}`);
  const lists = (d.lists || []).map((x) => `${x.text}:\n${textOf(x.content)}`).join("\n");
  const sal = d.salaryRange;
  return { ats: "lever", title: d.text, company: parts[0], location: d.categories?.location ?? null, work_mode: d.workplaceType,
    pay: sal ? `${sal.min}-${sal.max} ${sal.currency || ""} ${sal.interval || ""}`.trim() : null, apply_url: d.applyUrl,
    description: [d.descriptionPlain, lists, d.additionalPlain].filter(Boolean).join("\n"),
    questions: [{ label: "Standard Lever form: name, email, phone, current company, links, resume, additional info" }] };
}

async function ashby(u) {
  const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  const board = await get(`https://api.ashbyhq.com/posting-api/job-board/${parts[0]}?includeCompensation=true`);
  const job = (board.jobs || []).find((j) => j.id === parts[1] || (j.jobUrl || "").includes(parts[1]));
  if (!job) return null;
  return { ats: "ashby", title: job.title, company: parts[0], location: job.location, work_mode: job.workplaceType,
    pay: job.compensation?.compensationTierSummary ?? null, apply_url: job.applyUrl || job.jobUrl,
    description: job.descriptionPlain || textOf(job.descriptionHtml),
    questions: [{ label: "Ashby form: fields load in the page; upload the resume first (it autofills)" }] };
}

/** Maps common form questions to the user's saved settings. Unknown questions are left out on purpose. */
export function suggestedAnswers(questions, source) {
  const s = store.loadSettings(), p = s.profile, t = s.targets, e = s.eligibility;
  const [first, ...rest] = (p.full_name || "").split(" ");
  const yn = (v) => (v === null || v === undefined ? null : v ? "Yes" : "No");
  // Order matters: the first matching rule wins, so specific questions come before generic ones.
  const rules = [
    [/sponsor/, yn(e.needs_sponsorship)],
    [/authori[sz]ed to work|legally (authorized|eligible)|eligible to work/, yn(e.work_authorized)],
    [/relocat/, yn(t.willing_to_relocate)],
    [/how did you hear|where did you (hear|find)/, source === "linkedin" ? "LinkedIn" : "Company website"],
    [/salary|compensation|pay expectation/, t.min_pay],
    [/start date|when can you start|available to start/, e.earliest_start],
    [/\bfirst name\b|preferred (first )?name/, first], [/\blast name\b|surname/, rest.join(" ").trim()],
    [/^name$|full name/, p.full_name], [/e-?mail/, p.email], [/phone|mobile/, p.phone],
    [/linkedin/, p.linkedin_url], [/website|portfolio|github|blog/, p.portfolio_url],
    [/\bcity\b|^location|where .*(live|located|based)/, [p.city, p.region].filter(Boolean).join(", ")],
  ];
  const saved = s.custom_answers || {}, out = {};
  for (const q of questions || []) {
    const mine = store.savedAnswerFor(q.label, saved);
    if (mine?.score === 1) { // answers the user saved for the same question win (similar ones are only shown to the user)
      out[q.label] = mine.answer;
      continue;
    }
    const label = (q.label || "").toLowerCase();
    const hit = rules.find(([pat, ans]) => ans !== null && ans !== undefined && ans !== "" && pat.test(label));
    if (hit) out[q.label] = hit[1];
  }
  return out;
}

export async function fetchPosting(url, maxChars = 6000, source) {
  const u = new URL(url);
  const host = u.host.toLowerCase();
  let d = null;
  try {
    if (host.includes("greenhouse.io")) d = await greenhouse(u);
    else if (host.includes("lever.co")) d = await lever(u);
    else if (host.includes("ashbyhq.com")) d = await ashby(u);
  } catch {
    d = null; // fall back to the page text
  }
  if (!d) {
    const page = await get(url, false);
    const title = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    d = { ats: host, title: title ? unescape(title[1].trim()) : null, description: textOf(page), questions: [] };
  }
  const desc = d.description || "";
  d.description = desc.slice(0, maxChars) + (desc.length > maxChars ? "…" : "");
  d.description_chars = desc.length;
  d.suggested_answers = suggestedAnswers(d.questions, source);
  d.note = "Suggested answers come from the user's settings. Answer anything else only from the resume or the user.";
  return d;
}
