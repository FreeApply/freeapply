// FreeApply's own reader for employer replies, over IMAP with the app password from secrets.js, so neither the AI app
// nor its provider ever sees the password (they get the emails' text, as with a Gmail connector). Built on node:tls
// with no dependencies: sign in, find the mailbox, search, fetch, and star or label. On Gmail it uses Gmail's own
// search syntax (X-GM-RAW) and Gmail's message and thread ids, the same ids the Gmail connector reports.
import net from "node:net";
import tls from "node:tls";

const CRLF = "\r\n";

class Imap {
  constructor(socket, timeoutMs) {
    this.sock = socket;
    this.timeoutMs = timeoutMs;
    this.buf = Buffer.alloc(0);
    this.tag = 0;
    this.waiting = null; // { tag, untagged, resolve, reject, onContinue }
    this.greeting = new Promise((resolve, reject) => { this.greeted = { resolve, reject }; });
    socket.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new Error("the mail server closed the connection")));
    socket.setTimeout(timeoutMs, () => { this.fail(new Error("the mail server stopped answering")); socket.destroy(); });
  }

  fail(e) {
    if (this.greeted) { this.greeted.reject(e); this.greeted = null; }
    if (this.waiting) { this.waiting.reject(e); this.waiting = null; }
  }

  /** Takes one whole response (a line, plus any {n} literals and the line parts after them) off the buffer. */
  next() {
    let pos = 0;
    const parts = [], literals = [];
    for (;;) {
      const end = this.buf.indexOf(CRLF, pos);
      if (end < 0) return null;
      const line = this.buf.subarray(pos, end).toString("latin1");
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) {
        parts.push(line);
        this.buf = this.buf.subarray(end + 2);
        return { text: parts.join(""), literals };
      }
      const n = Number(m[1]), start = end + 2;
      if (this.buf.length < start + n) return null;
      literals.push(this.buf.subarray(start, start + n));
      parts.push(line.slice(0, m.index) + `\u0000${literals.length - 1}`);
      pos = start + n;
    }
  }

  drain() {
    for (let r = this.next(); r; r = this.next()) {
      if (this.greeted) {
        const ok = /^\* (OK|PREAUTH)/i.test(r.text);
        (ok ? this.greeted.resolve : this.greeted.reject)(ok ? r : new Error(`the mail server refused: ${r.text}`));
        this.greeted = null;
        continue;
      }
      const w = this.waiting;
      if (!w) continue;
      if (r.text.startsWith("+")) { w.onContinue?.(); continue; }
      if (r.text.startsWith("* ")) { w.untagged.push(r); continue; }
      if (r.text.startsWith(w.tag + " ")) {
        this.waiting = null;
        const status = r.text.slice(w.tag.length + 1).split(" ")[0].toUpperCase();
        if (status === "OK") w.resolve(w.untagged);
        else w.reject(Object.assign(new Error(r.text.slice(w.tag.length + 1)), { status }));
      }
    }
  }

  /** Runs one command. parts are strings, or { literal } for text sent as an IMAP literal (any characters). */
  command(...parts) {
    if (this.waiting) return Promise.reject(new Error("one IMAP command at a time"));
    const tag = `F${++this.tag}`;
    return new Promise((resolve, reject) => {
      const queue = [...parts];
      let out = `${tag} `;
      const send = () => {
        while (queue.length) {
          const p = queue.shift();
          if (typeof p === "string") { out += p; continue; }
          const bytes = Buffer.from(String(p.literal), "utf8");
          this.sock.write(`${out}{${bytes.length}}${CRLF}`);
          out = "";
          this.waiting.onContinue = () => { this.waiting.onContinue = null; this.sock.write(bytes); send(); };
          return;
        }
        this.sock.write(out + CRLF);
      };
      this.waiting = { tag, untagged: [], resolve, reject, onContinue: null };
      send();
    });
  }

  close() {
    this.command("LOGOUT").catch(() => {}).finally(() => this.sock.end());
  }
}

/** Opens and signs in. secure: false (plain TCP) is for tests only. */
export async function open({ host, port = 993, secure = true, address, password, timeoutMs = 20000, gmail }) {
  const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  const c = new Imap(sock, timeoutMs);
  try {
    await c.greeting;
    await c.command("LOGIN ", quote(address), " ", quote(password));
  } catch (e) {
    sock.destroy();
    throw friendly(e, host, gmail || host === "imap.gmail.com");
  }
  return c;
}

function friendly(e, host, gmail) {
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(e.message)) {
    return new Error(gmail
      ? "Google didn't accept that address and app password. Check both, or make a new app password."
      : "the mail server didn't accept that address and password");
  }
  if (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT") return new Error(`couldn't reach ${host}`);
  return e;
}

/** An IMAP quoted string, or a literal when the text has characters a quoted string can't carry. */
function quote(s) {
  s = String(s);
  return /^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/[\\"]/g, "\\$&")}"` : { literal: s };
}

/** The mailbox to search: Gmail's All Mail (any language: found by its \All flag), else the inbox. */
async function chooseMailbox(c) {
  const list = await c.command('LIST "" "*"').catch(() => []);
  for (const r of list) {
    const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i.exec(r.text);
    if (m && /\\All\b/i.test(m[1])) return unquoteName(m[2], r.literals);
  }
  return "INBOX";
}
const unquoteName = (s, literals) => (s.startsWith("\u0000") ? literals[Number(s.slice(1))].toString("utf8")
  : s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d) => `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
const gmailDate = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
const KEYWORDS = '(interview OR "next steps" OR assessment OR unfortunately OR offer) (application OR position OR role)';
// Hiring systems that send employers' replies under their own address (the replies procedure names the main ones).
const ATS_SENDER = /@([a-z0-9-]+\.)*(greenhouse(-mail)?\.io|greenhouse\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|myworkday(jobs)?\.com|workday\.com|icims\.com|smartrecruiters\.com|workablemail\.com|workable\.com|jobvite\.com|bamboohr\.com|taleo\.net|successfactors\.(com|eu)|breezy\.hr|recruitee\.com|teamtailor(-mail)?\.com|jazzhr\.com|applytojob\.com|rippling(-ats)?\.com|paylocity\.com|ultipro\.com|dayforcehcm\.com|oraclecloud\.com)>?\s*$/i;

/** The Gmail searches of the replies procedure: companies in batches of 15, plus replies from recruiters and ATSs. */
export function gmailQueries(since, companies) {
  const after = `after:${gmailDate(since)} -from:me -category:promotions -category:social -category:forums`;
  const names = [...new Set(companies.map((c) => String(c || "").replace(/["()]/g, " ").trim()).filter(Boolean))];
  const out = [];
  for (let i = 0; i < names.length; i += 15) {
    out.push(`${after} (${names.slice(i, i + 15).map((n) => (/\s/.test(n) ? `"${n}"` : n)).join(" OR ")})`);
  }
  out.push(`${after} ${KEYWORDS}`);
  return out;
}

const searchIds = (rs) => rs.filter((r) => /^\* SEARCH/i.test(r.text)).flatMap((r) => r.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/)).filter((x) => /^\d+$/.test(x)).map(Number);

/**
 * Employer emails since `since` that may be replies to the applications in `companies`, newest first, at most `max`,
 * skipping ids in `known`. Each: {gmail_message_id, gmail_thread_id, sender, subject, received_at, text}.
 */
export async function findReplies(login, { since, companies = [], known = [], max = 40 }, opts = {}) {
  const c = await open({ ...login, ...opts });
  try {
    const gmail = login.host === "imap.gmail.com" || opts.gmail;
    const box = await chooseMailbox(c);
    await c.command("SELECT ", quote(box));
    const from = since ? new Date(since) : new Date(Date.now() - 30 * 864e5);
    let uids = [];
    if (gmail) {
      for (const q of gmailQueries(from, companies)) {
        const arg = quote(q);
        uids.push(...searchIds(await c.command(typeof arg === "string" ? "UID SEARCH X-GM-RAW " : "UID SEARCH CHARSET UTF-8 X-GM-RAW ", arg)));
      }
    } else {
      uids = searchIds(await c.command(`UID SEARCH SINCE ${imapDate(from)}`));
    }
    uids = [...new Set(uids)].sort((a, b) => b - a).slice(0, gmail ? max * 2 : 300);
    if (!uids.length) return [];
    const items = gmail ? "(UID X-GM-MSGID X-GM-THRID INTERNALDATE BODY.PEEK[]<0.65536>)" : "(UID INTERNALDATE BODY.PEEK[]<0.65536>)";
    const rows = await c.command(`UID FETCH ${uids.join(",")} ${items}`);
    const knownSet = new Set(known);
    const needles = companies.map((x) => String(x || "").toLowerCase()).filter((x) => x.length > 2);
    const out = [];
    for (const r of rows) {
      if (!/^\* \d+ FETCH/i.test(r.text) || !r.literals.length) continue;
      const msg = parseMessage(r.literals[r.literals.length - 1]);
      const gid = /X-GM-MSGID (\d+)/i.exec(r.text), tid = /X-GM-THRID (\d+)/i.exec(r.text);
      const id = gid ? BigInt(gid[1]).toString(16) : msg.messageId;
      if (!id || knownSet.has(id)) continue;
      // Only emails tied to an application leave this computer for the AI app: ones that name a company applied to,
      // or that come from a hiring system. Newsletters, offers and job spam that merely say "offer" or "role" stay here.
      const hay = `${msg.from} ${msg.subject} ${msg.text.slice(0, 3000)}`.toLowerCase();
      if (!needles.some((n) => hay.includes(n)) && !ATS_SENDER.test(msg.from)) continue;
      const internal = /INTERNALDATE "([^"]+)"/i.exec(r.text);
      out.push({ gmail_message_id: id, gmail_thread_id: tid ? BigInt(tid[1]).toString(16) : id, sender: msg.from,
        subject: msg.subject, received_at: toIso(msg.date || (internal && internal[1])), text: msg.text.slice(0, 2000),
        uid: Number((/UID (\d+)/i.exec(r.text) || [])[1]) });
    }
    out.sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));
    return out.slice(0, max).map(({ uid, ...m }) => m);
  } finally {
    c.close();
  }
}

/** Stars and/or labels one email the reply check recorded. action: star, label, star_and_label or none. */
export async function markReply(login, messageId, action, labelName, opts = {}) {
  if (!action || action === "none") return "none";
  const c = await open({ ...login, ...opts });
  try {
    const gmail = login.host === "imap.gmail.com" || opts.gmail;
    await c.command("SELECT ", quote(await chooseMailbox(c)));
    const found = gmail && /^[0-9a-f]+$/i.test(messageId)
      ? searchIds(await c.command(`UID SEARCH X-GM-MSGID ${BigInt("0x" + messageId).toString()}`))
      : searchIds(await c.command("UID SEARCH HEADER Message-ID ", quote(messageId)));
    if (!found.length) throw new Error("couldn't find that email in the mailbox");
    const done = [];
    if (action === "star" || action === "star_and_label") {
      await c.command(`UID STORE ${found[0]} +FLAGS.SILENT (\\Flagged)`);
      done.push("starred");
    }
    if ((action === "label" || action === "star_and_label") && labelName) {
      if (!gmail) throw new Error("labels need Gmail; choose star in Settings");
      await c.command(`UID STORE ${found[0]} +X-GM-LABELS.SILENT (`, quote(labelName), ")");
      done.push(`labeled:${labelName}`);
    }
    return done.join("+") || "none";
  } finally {
    c.close();
  }
}

/** Signs in and opens the mailbox, to check a login before it is saved. Returns the mailbox name. */
export async function testLogin(login, opts = {}) {
  const c = await open({ ...login, ...opts });
  try {
    const box = await chooseMailbox(c);
    await c.command("EXAMINE ", quote(box));
    return box;
  } finally {
    c.close();
  }
}

function toIso(d) {
  const t = Date.parse(String(d || "").replace(/\s+\(.*\)$/, ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ── a small MIME reader: headers, RFC 2047 words, multipart, base64 / quoted-printable, charsets ──

function decodeBytes(bytes, charset = "utf-8") {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^us-ascii$/, "utf-8"), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const qp = (s) => Buffer.from(s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");

/** Decodes =?charset?B|Q?...?= words in a header. */
export function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=(\s+(?==\?))?/gi, (_, cs, enc, text) =>
    decodeBytes(enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : qp(text.replace(/_/g, " ")), cs));
}

function splitHead(buf) {
  const s = buf.toString("latin1");
  const i = s.search(/\r?\n\r?\n/);
  const head = i < 0 ? s : s.slice(0, i);
  const bodyStart = i < 0 ? buf.length : i + s.slice(i).match(/^\r?\n\r?\n/)[0].length;
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] ??= m[2];
  }
  return { headers, body: buf.subarray(bodyStart) };
}

const param = (v, name) => (new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(v || "") || [])[2] ??
  ((new RegExp(`${name}\\s*=\\s*([^;\\s]+)`, "i").exec(v || "") || [])[1]);

function textOf(buf, depth = 0) {
  const { headers, body } = splitHead(buf);
  const type = (headers["content-type"] || "text/plain").toLowerCase();
  if (type.startsWith("multipart/") && depth < 5) {
    const boundary = param(headers["content-type"], "boundary");
    if (!boundary) return { plain: "", html: "" };
    const parts = body.toString("latin1").split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--"));
    let plain = "", html = "";
    for (const p of parts) {
      const t = textOf(Buffer.from(p.replace(/^\r?\n/, ""), "latin1"), depth + 1);
      plain ||= t.plain;
      html ||= t.html;
    }
    return { plain, html };
  }
  if (!type.startsWith("text/")) return { plain: "", html: "" };
  const enc = (headers["content-transfer-encoding"] || "").toLowerCase();
  const raw = enc === "base64" ? Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
    : enc === "quoted-printable" ? qp(body.toString("latin1")) : body;
  const text = decodeBytes(raw, param(headers["content-type"], "charset") || "utf-8");
  return type.startsWith("text/html") ? { plain: "", html: text } : { plain: text, html: "" };
}

const stripHtml = (h) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** From, subject, date, Message-ID and readable text of a raw email. */
export function parseMessage(buf) {
  const { headers } = splitHead(buf);
  const t = textOf(buf);
  const text = (t.plain || stripHtml(t.html)).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return { from: decodeWords(headers.from), subject: decodeWords(headers.subject), date: headers.date || null,
    messageId: (headers["message-id"] || "").trim() || null, text };
}
