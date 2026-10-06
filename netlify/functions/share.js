// iPhone Share Sheet -> tracker. The "Save to Tracker" shortcut POSTs whatever
// was shared (text, links, photos, PDFs, any file) as a form. Text-only shares
// are saved straight away. Files are parked in Supabase and handed to
// share-background, which uploads them to Drive and only then saves the entry —
// so the tracker never caches a version with missing attachments.
// Everything lands in category "Quick Notes", away from sales/purchase views.
const db = require("./db.js");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const sbH = { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" };

const reply = (code, text) => ({ statusCode: code, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text });

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function istDate() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); }

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return [];
  const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    let start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === "--") break;
    start += 2; // CRLF
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    const part = buf.slice(start, next - 2); // drop CRLF before boundary
    const hEnd = part.indexOf("\r\n\r\n");
    if (hEnd !== -1) {
      const head = part.slice(0, hEnd).toString("utf8");
      const body = part.slice(hEnd + 4);
      const name = (/name="([^"]*)"/i.exec(head) || [])[1] || "";
      const filename = (/filename="([^"]*)"/i.exec(head) || [])[1];
      const type = ((/content-type:\s*([^\r\n;]+)/i.exec(head) || [])[1] || "").trim().toLowerCase();
      parts.push({ name, filename, type, body });
    }
    pos = next;
  }
  return parts;
}

const isTextPart = (p) => !p.filename && !p.type ||
  /^text\/(plain|uri-list|x-url)/.test(p.type) && p.body.length < 200000 && !/\.(pdf|docx?|xlsx?|csv|rtf)$/i.test(p.filename || "");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, "Use the Save to Tracker shortcut.");
  const q = event.queryStringParameters || {};
  const key = q.k || (event.headers || {})["x-share-key"] || "";
  if (!process.env.SHARE_KEY || key !== process.env.SHARE_KEY) return reply(401, "❌ Not authorised — shortcut key is wrong.");
  const user = String(q.user || "main").toLowerCase();

  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : Buffer.from(event.body || "", "utf8");
  const ct = (event.headers || {})["content-type"] || (event.headers || {})["Content-Type"] || "";
  let texts = [], files = [];

  if (/multipart\/form-data/i.test(ct)) {
    for (const p of parseMultipart(raw, ct)) {
      if (!p.body.length) continue;
      if (isTextPart(p)) texts.push(p.body.toString("utf8").trim());
      else files.push({ name: p.filename || ("file-" + (files.length + 1)), type: p.type || "application/octet-stream", b64: p.body.toString("base64") });
    }
  } else if (/application\/json/i.test(ct)) {
    try { const j = JSON.parse(raw.toString("utf8")); if (j.text) texts.push(String(j.text)); } catch (e) {}
  } else {
    texts.push(raw.toString("utf8"));
  }
  if (q.t) texts.unshift(String(q.t));
  const text = texts.filter(Boolean).join("\n\n").trim();
  if (!text && !files.length) return reply(400, "Nothing was shared.");

  const first = text ? text.split("\n")[0] : ("📎 " + files.map(f => f.name).join(", "));
  const entry = {
    id: genId(), title: first.length > 60 ? first.slice(0, 57) + "…" : first, date: istDate(),
    category: "Quick Notes", tags: ["Quick Note", "Shared"], notes: text, attachments: [],
    createdAt: new Date().toISOString()
  };

  if (!files.length) {
    const r = JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify({ action: "save", user, entry }) })).body);
    return r && r.ok ? reply(200, "✅ Saved to tracker") : reply(500, "❌ Could not save: " + JSON.stringify(r).slice(0, 200));
  }

  // Park files, then hand off. The entry itself is saved by the background job.
  const k = "share_" + entry.id;
  const park = await fetch(SUPABASE_URL + "/rest/v1/kv?on_conflict=owner,k", {
    method: "POST", headers: Object.assign({ Prefer: "resolution=merge-duplicates,return=minimal" }, sbH),
    body: JSON.stringify({ owner: "_share", k, v: { user, entry, files } })
  });
  if (park.status >= 400) return reply(500, "❌ Could not store the file (" + park.status + "). It may be too large.");

  const base = process.env.URL || "https://rk-tracker-v2.netlify.app";
  try {
    await fetch(base + "/.netlify/functions/share-background", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ k, key: process.env.SHARE_KEY })
    });
  } catch (e) {}
  return reply(200, "✅ Saved — " + files.length + " file" + (files.length > 1 ? "s" : "") + " uploading to tracker");
};
