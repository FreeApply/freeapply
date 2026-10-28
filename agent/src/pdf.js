// A one-to-few-page text PDF for cover letters, with no dependencies: US Letter, Helvetica, real text (not an image),
// so applicant tracking systems can read every word. Characters outside Windows-1252 become "?".

// Helvetica advance widths (1/1000 em) for ASCII 32-126, from the standard font metrics.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556,
  278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const width = (s, size) => [...s].reduce((n, c) => n + (W[c.charCodeAt(0) - 32] ?? 556), 0) * size / 1000;

// Unicode punctuation that Windows-1252 places in 0x80-0x9F; Latin-1 (0xA0-0xFF) maps to itself.
const CP1252 = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "™": 0x99 };
const byte = (c) => { const n = c.charCodeAt(0); return n < 128 || (n >= 0xa0 && n <= 0xff) ? n : CP1252[c] ?? 0x3f; };
// A PDF string literal in plain ASCII: ( ) \ escaped, everything outside printable ASCII as an octal byte.
const lit = (s) => "(" + [...s].map((c) => { const b = byte(c), ch = String.fromCharCode(b);
  return b === 0x28 || b === 0x29 || b === 0x5c ? "\\" + ch : b < 32 || b > 126 ? "\\" + b.toString(8).padStart(3, "0") : ch; }).join("") + ")";

function wrap(text, size, max) {
  const lines = [];
  for (const para of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next, size) > max) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Builds the PDF. header: lines at the top (the first in bold), e.g. name and contact details; body: the letter, with
 * blank lines between paragraphs. Returns a Buffer.
 */
export function letterPdf({ title = "Cover letter", author = "", header = [], body = "" }) {
  const PAGE_W = 612, PAGE_H = 792, M = 72, MAXW = PAGE_W - 2 * M, SIZE = 11, LEAD = 15;
  const rows = []; // [font, size, text] per line; null text is a blank line
  header.filter(Boolean).forEach((h, i) => wrap(h, i ? 10 : 14, MAXW).forEach((t) => rows.push([i ? "F1" : "F2", i ? 10 : 14, t])));
  if (rows.length) rows.push(["F1", SIZE, ""]);
  wrap(body.trim(), SIZE, MAXW).forEach((t) => rows.push(["F1", SIZE, t]));
  const perPage = Math.floor((PAGE_H - 2 * M) / LEAD), pages = [];
  for (let i = 0; i < rows.length; i += perPage) pages.push(rows.slice(i, i + perPage));

  const objs = []; // object number = index + 1
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add(null), pagesObj = add(null);
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = pages.map((page) => {
    const ops = [`BT ${M} ${PAGE_H - M} Td`];
    for (const [font, size, t] of page) ops.push(`/${font} ${size} Tf ${t ? `${lit(t)} Tj ` : ""}0 -${LEAD} Td`);
    ops.push("ET");
    const stream = ops.join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${lit(title)} /Author ${lit(author)} /Producer (FreeApply) >>`);

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = objs.map((o, i) => { const at = Buffer.byteLength(out, "latin1"); out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
