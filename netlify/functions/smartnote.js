// Smart Quick Note: one brain for /note, the Siri shortcut and the Share Sheet.
// Reads what was said and files it:
//   • names a section ("for my health…")        → that category
//   • "remind me …"                              → Reminders, with a real alert time
//   • about an existing entry ("note for the Avadi order: …") → appended to it
//   • "new order" / "payment received" said plainly → new Sales entry
//   • anything unclear                           → Quick Notes (never touches sales)
// Also: action "ocr" (read text from a photo), "undo", "move".
const db = require("./db.js");
const https = require("https");

const CATS = ["Business - Purchase","Sales - Order","Sales - Payment","Sales - Visit","Sales - Expense","Sales - Complaint",
  "Finance","Health","Family","Personal","Compliance","Property","Digital","Reminders","Intelligence","Problem","Quick Notes"];
const OWNER_CHAT_ID = "8632288596";
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });

const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
// Light reads straight from Supabase — getAll pulls every full entry and was
// too slow to finish inside Netlify's 10-second limit.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
async function sbGet(path) {
  const r = await fetch(SB_URL + path, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
  if (r.status >= 400) throw new Error("supabase " + r.status);
  return r.json();
}
async function listLight(user) {
  try {
    const rows = await sbGet("/rest/v1/entries?owner=eq." + encodeURIComponent(user) +
      "&select=id,title,category,date,person,vendor,tags,created_at&order=created_at.desc&limit=400");
    return rows.map(r => ({ id: r.id, title: r.title, category: r.category, date: r.date, person: r.person, vendor: r.vendor, tags: r.tags || [], createdAt: r.created_at }));
  } catch (e) { return []; }
}
async function getFull(user, id) {
  const rows = await sbGet("/rest/v1/entries?id=eq." + encodeURIComponent(id) + "&owner=eq." + encodeURIComponent(user) + "&select=*");
  const r = rows && rows[0]; if (!r) return null;
  const base = (r.data && typeof r.data === "object") ? r.data : {};
  return Object.assign({ id: r.id, title: r.title, date: r.date, category: r.category, person: r.person, vendor: r.vendor,
    amount: r.amount, notes: r.notes, link: r.link, linkLabel: r.link_label, tags: r.tags || [], attachments: r.attachments || [],
    createdAt: r.created_at, reminder: r.reminder, reminderNote: r.reminder_note, paymentStatus: r.payment_status }, base);
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const istDate = () => istNow().toISOString().slice(0, 10);
const istStamp = () => istNow().toISOString().slice(0, 16).replace("T", " ");

function claude(content, system, maxTokens, timeoutMs) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Promise.reject(new Error("no api key"));
  const body = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens || 800, system, messages: [{ role: "user", content }] });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { const j = JSON.parse(d); if (j.error) return reject(new Error(j.error.message)); resolve((j.content || []).map(x => x.text || "").join("")); }
        catch (e) { reject(e); } }); });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 7000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body); req.end();
  });
}

async function ocrImage(b64, type, ms) {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type || "") || !b64 || b64.length > 4800000) return "";
  try {
    const t = await claude([{ type: "image", source: { type: "base64", media_type: type, data: b64 } },
      { type: "text", text: "Read every bit of text in this image exactly as written, line by line. Keep numbers, amounts, dates, names and invoice numbers exact. If there is no text, reply with nothing." }],
      "You are an OCR engine. Output only the text found in the image, nothing else.", 2000, ms || 20000);
    return String(t || "").trim();
  } catch (e) { return ""; }
}

// Reminder alerts use the same Telegram queue the tracker writes to.
async function queueReminder(entry, user) {
  try {
    const cur = await call({ action: "getPortfolio", user: "main", key: "tg_scheduled" });
    let list = (cur && cur.data && Array.isArray(cur.data.scheduled)) ? cur.data.scheduled : [];
    const tag = "tg_rem_" + entry.id;
    list = list.filter(m => m.id !== tag);
    let chatId = OWNER_CHAT_ID;
    if (user !== "main") {
      const cr = await call({ action: "getPortfolio", user: "main", key: "tg_contacts" });
      const contacts = (cr && Array.isArray(cr.data)) ? cr.data : [];
      const mine = contacts.find(c => String(c.label || c.name || "").toLowerCase() === user);
      if (mine && mine.chatId) chatId = mine.chatId;
    }
    if (entry.reminder && !entry.remindDone) list.push({
      id: tag, text: "\u23f0 <b>" + (entry.title || "Reminder") + "</b>" + (entry.reminderNote ? "\n" + entry.reminderNote : ""),
      chatIds: [chatId], when: new Date(entry.reminder).toISOString(), repeat: "once", emails: [],
      subject: entry.title || "Reminder", body: entry.reminderNote || "", entryId: entry.id, owner: user, created: new Date().toISOString()
    });
    await call({ action: "savePortfolio", user: "main", key: "tg_scheduled", data: { scheduled: list } });
  } catch (e) {}
}

function parseJSON(t) {
  const s = String(t || "").replace(/```json|```/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return JSON.parse(a >= 0 ? s.slice(a, b + 1) : s);
}

async function decide(text, entries) {
  const cutoff = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
  const cands = entries.filter(e => e && e.id && !(e.tags || []).includes("Done") && e.category !== "Quick Notes" &&
      String(e.date || e.createdAt || "").slice(0, 10) >= cutoff)
    .slice(0, 250)
    .map(e => [e.id, String(e.date || "").slice(0, 10), e.category || "", String(e.title || "").slice(0, 80), e.person || "", e.vendor || ""].join(" | "))
    .join("\n");
  const now = istNow();
  const system = "You file quick notes for Ravikiran, director of Onam Agarbathi (incense maker, Bangalore). Reply with ONLY one JSON object.";
  const prompt =
`Now (India time): ${now.toISOString().slice(0, 16).replace("T", " ")} (${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}).
Note: """${text.slice(0, 4000)}"""

Categories: ${CATS.join(", ")}

Rules — follow strictly:
1. If the note clearly says it is FOR / ABOUT one specific existing entry listed below (e.g. "note for the Avadi sales order: …", "add to the Benson purchase …"), use mode "append" with that entry's id. Only when the match is clear.
2. If it says "remind me" / "reminder" → mode "new", category "Reminders", and set "reminder" to the date-time meant (YYYY-MM-DDTHH:MM, India time). No time given → 10:00. No date given → tomorrow 10:00.
3. If it names a section ("for my health", "health note", "personal", "family", "finance", "property", "compliance", "intelligence", "problem", "purchase"…) → that category.
4. Use "Sales - Order" ONLY if it plainly says a NEW order was received/placed; "Sales - Payment" ONLY if it plainly says a payment was received/collected. Otherwise never use Sales categories.
5. If unsure about anything → category "Quick Notes".

Existing entries (id | date | category | title | person | vendor):
${cands || "(none)"}

Return JSON: {"mode":"new|append","targetId":"","category":"","title":"short title, max 60 chars","notes":"the note, cleaned of the routing words like 'make a quick note for my health', otherwise unchanged","date":"YYYY-MM-DD","reminder":"","person":"","vendor":"","amount":"","paymentStatus":""}`;
  return parseJSON(await claude([{ type: "text", text: prompt }], system, 500, 5500));
}

async function route(b) {
  const user = String(b.user || "main").toLowerCase();
  const text = String(b.text || "").trim();
  const atts = (Array.isArray(b.attachments) ? b.attachments : []).filter(a => a && String(a.data || "").indexOf("http") === 0);
  const ocr = String(b.ocr || "").trim();
  if (!text && !atts.length && !ocr) return { error: "empty" };

  const entries = await listLight(user);
  let d = null;
  const basis = text || (ocr ? "Scanned document:\n" + ocr.slice(0, 1500) : "");
  if (basis) { try { d = await decide(basis, entries); } catch (e) { d = null; } }
  d = d || {};
  let cat = CATS.includes(d.category) ? d.category : "Quick Notes";
  if (/^Sales - (Order|Payment)$/.test(cat) && !/\b(new|got|received|receive|placed|booked)\b.*\border|\border\b.*\b(received|placed|booked|confirmed)|payment\b.*\b(received|collected|came|credited)|\b(received|collected|got)\b.*\bpayment/i.test(text)) cat = "Quick Notes";
  const body = String(d.notes || text).trim() || text;
  const ocrBlock = ocr ? "\n\n🔍 Text from photo:\n" + ocr : "";

  // ── append to an existing entry ──
  let target = null;
  if (d.mode === "append" && d.targetId && entries.find(e => e.id === d.targetId)) { try { target = await getFull(user, d.targetId); } catch (e) { target = null; } }
  if (target) {
    const prev = JSON.parse(JSON.stringify(target));
    const upd = Object.assign({}, target);
    upd.notes = (upd.notes ? upd.notes + "\n\n" : "") + "📝 " + istStamp() + ": " + body + ocrBlock;
    upd.attachments = (upd.attachments || []).concat(atts);
    if (!upd.link && atts[0]) { upd.link = atts[0].data; upd.linkLabel = "📎 Attachment"; }
    upd.updatedAt = new Date().toISOString();
    upd.serverEdit = upd.updatedAt;
    const s = await call({ action: "save", user, entry: upd });
    if (!s.ok) return { error: "save_failed" };
    return { ok: true, mode: "append", id: upd.id, title: upd.title, category: upd.category, undo: { type: "restore", entry: Object.assign(prev, { serverEdit: new Date(Date.now() + 1000).toISOString() }) } };
  }

  // ── new entry ──
  const first = (body || ocr || (atts[0] && atts[0].name) || "Quick note").split("\n")[0];
  const e = {
    id: genId(), title: String(d.title || first).slice(0, 60) || "Quick note",
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") ? d.date : istDate(),
    category: cat, tags: cat === "Quick Notes" ? ["Quick Note"] : ["Quick Note", "Pending"],
    notes: body + ocrBlock, attachments: atts, createdAt: new Date().toISOString()
  };
  if (cat !== "Quick Notes") { ["person", "vendor", "amount", "paymentStatus"].forEach(k => { if (d[k]) e[k] = String(d[k]); }); }
  if (atts[0]) { e.link = atts[0].data; e.linkLabel = "📎 Attachment"; }
  if (cat === "Reminders" || d.reminder) {
    let r = String(d.reminder || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r)) { const t = new Date(istNow().getTime() + 864e5); r = t.toISOString().slice(0, 10) + "T10:00"; }
    e.reminder = r.slice(0, 16) + ":00+05:30";
    e.reminderNote = body.slice(0, 300);
    if (cat === "Quick Notes") e.category = cat = "Reminders";
  }
  const s = await call({ action: "save", user, entry: e });
  if (!s.ok) return { error: "save_failed" };
  if (e.reminder) await queueReminder(e, user);
  return { ok: true, mode: "new", id: e.id, title: e.title, category: cat, reminder: e.reminder || "", undo: { type: "delete", id: e.id } };
}

exports.route = route;
exports.ocrImage = ocrImage;
exports.queueReminder = queueReminder;
exports.claude = claude;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad json" }); }
  const user = String(b.user || "main").toLowerCase();
  try {
    if (b.action === "ocr") return OK({ ok: true, text: await ocrImage(String(b.imageBase64 || ""), b.imageType || "image/jpeg", 8500) });
    if (b.action === "route") return OK(await route(b));
    if (b.action === "undo" && b.undo) {
      if (b.undo.type === "delete" && b.undo.id) {
        await call({ action: "delete", user, id: b.undo.id });
        const cur = await call({ action: "getPortfolio", user: "main", key: "tg_scheduled" });
        const list = (cur && cur.data && Array.isArray(cur.data.scheduled)) ? cur.data.scheduled : [];
        const kept = list.filter(m => m.id !== "tg_rem_" + b.undo.id);
        if (kept.length !== list.length) await call({ action: "savePortfolio", user: "main", key: "tg_scheduled", data: { scheduled: kept } });
        return OK({ ok: true });
      }
      if (b.undo.type === "restore" && b.undo.entry && b.undo.entry.id) return OK(await call({ action: "save", user, entry: b.undo.entry }));
    }
    if (b.action === "move" && b.id && CATS.includes(b.category)) {
      const e = await getFull(user, b.id);
      if (!e) return OK({ error: "not found" });
      e.category = b.category; e.updatedAt = new Date().toISOString(); e.serverEdit = e.updatedAt;
      const s = await call({ action: "save", user, entry: e });
      if (b.category === "Reminders" && !e.reminder) { /* reminder time is set in the tracker */ }
      return OK(s.ok ? { ok: true, category: e.category } : { error: "save_failed" });
    }
    if (b.action === "cats") return OK({ ok: true, categories: CATS });
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e.message || e) }); }
};
