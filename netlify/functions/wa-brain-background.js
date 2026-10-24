// The brain behind the office WhatsApp number. One message in → one decision:
//   task      "Prakash: send samples to Kerala by Mon"  → task, sent to Prakash, tracked till done
//   reminder  "remind me Friday 11am to call DEP supplier" (owners → tracker reminder; staff → own task)
//   note      anything to keep                          → tracker entry (owners via smartnote)
//   document  photo / PDF of an order, bill, LR …       → read, filed with the file attached
//   question  "pending dispatches?" "CSD outstanding?"  → answered from tracker, tasks, WhatsApp, Tally
//   done      "done 12" or a reply to the task message  → task closed, creator told
// Groups: photos/PDFs are filed quietly (no reply in the group); chatter is kept for questions.
// Emails sent to the tracker with #wa in the subject arrive here too (source "email").
const W = require("./wa-lib.js");
const T = require("./tally.js");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");

const CATS = ["Business - Purchase", "Sales - Order", "Sales - Payment", "Sales - Visit", "Sales - Expense", "Sales - Complaint",
  "Finance", "Health", "Family", "Personal", "Compliance", "Property", "Digital", "Reminders", "Intelligence", "Problem", "Quick Notes"];
const READABLE = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const HELP =
  "*Onam office number — what you can send*\n" +
  "• A task: _Prakash: send samples to Kerala by Monday_\n" +
  "• A reminder: _remind me Friday 11am to call the DEP supplier_\n" +
  "• A photo or PDF (order, bill, LR, e-way bill) — it gets read and filed\n" +
  "• A question: _pending dispatches?_ · _what is due today?_\n" +
  "• *tasks* — your open tasks\n" +
  "• *done 12* (or reply *done* to the task message) — closes task 12\n" +
  "Forward an email to the tracker with *#wa* in the subject and it comes here too.";

// ---------- storage ----------
async function fileB64(path) {
  const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), KEY = process.env.SUPABASE_SERVICE_KEY || "";
  const r = await fetch(SB + "/storage/v1/object/" + db.FILE_BUCKET + "/" + path.split("/").map(encodeURIComponent).join("/"), { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}
const fileLink = (path) => W.SITE() + "/.netlify/functions/file?p=" + encodeURIComponent(path) + "&s=" + db.fileSig(path);

// ---------- tasks ----------
const openTasks = (assignee) => W.sb("GET", "/rest/v1/wa_tasks?status=eq.open" + (assignee ? "&assignee=eq." + encodeURIComponent(assignee) : "") + "&order=due.asc.nullslast,id.asc&limit=80&select=*");
function taskLine(t, withWho) {
  const late = t.due && new Date(t.due) < new Date() ? " ⚠️ overdue" : "";
  return "#" + t.id + " " + t.title + (withWho ? " — " + (W.PEOPLE[t.assignee] || { name: t.assignee }).name : "") + " (due " + W.fmtDue(t.due) + ")" + late;
}
async function createTask(t, by, srcId) {
  const who = W.personKey(t.assignee) || by.key;
  let due = String(t.due || "");
  due = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(due) ? new Date(due.slice(0, 16) + ":00+05:30").toISOString()
    : /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(due + "T17:00:00+05:30").toISOString() : null;
  const entry = { id: genId(), title: String(t.title || "Task").slice(0, 60), date: W.istDate(), category: "Reminders",
    tags: ["Task", "Pending", "WhatsApp"], person: W.PEOPLE[who].name,
    notes: (t.details ? t.details + "\n\n" : "") + "Task from " + by.name + " via WhatsApp, for " + W.PEOPLE[who].name + (due ? ", due " + W.fmtDue(due) : "") + ".",
    createdAt: new Date().toISOString() };
  try { await call({ action: "save", user: "main", entry }); } catch (e) { entry.id = null; }
  const row = (await W.sb("POST", "/rest/v1/wa_tasks", [{ title: entry.title, details: String(t.details || "").slice(0, 2000), assignee: who, created_by: by.key,
    due, source_msg: srcId, entry_id: entry.id }], { Prefer: "return=representation" }))[0];
  if (who !== by.key) {
    await W.send(who, "📌 *Task #" + row.id + "* from " + by.name + "\n" + row.title + (row.details ? "\n" + row.details : "") +
      "\nDue: " + W.fmtDue(row.due) + "\n\nWhen finished, reply *done " + row.id + "* (a photo is welcome).", { kind: "task", taskId: row.id });
  }
  return row;
}
async function setEntryDone(entryId) {
  if (!entryId) return;
  try {
    const rows = await W.sb("GET", "/rest/v1/entries?id=eq." + encodeURIComponent(entryId) + "&owner=eq.main&select=tags,data");
    if (!rows || !rows[0]) return;
    const fix = (tags) => (tags || []).filter((x) => x !== "Pending").concat(["Done"]).filter((v, i, a) => a.indexOf(v) === i);
    const data = Object.assign({}, rows[0].data || {});
    data.tags = fix(data.tags || rows[0].tags); data.updatedAt = new Date().toISOString(); data.serverEdit = data.updatedAt;
    await W.sb("PATCH", "/rest/v1/entries?id=eq." + encodeURIComponent(entryId) + "&owner=eq.main", { tags: fix(rows[0].tags), data }, { Prefer: "return=minimal" });
  } catch (e) {}
}
async function closeTask(task, by, note, mediaPath) {
  await W.sb("PATCH", "/rest/v1/wa_tasks?id=eq." + task.id, { status: "done", done_at: new Date().toISOString(), done_note: String(note || "").slice(0, 1000), done_media: mediaPath ? fileLink(mediaPath) : null }, { Prefer: "return=minimal" });
  await setEntryDone(task.entry_id);
  if (task.created_by !== by.key) {
    await W.send(task.created_by, "✅ " + by.name + " finished *#" + task.id + "* " + task.title + (note && !/^\s*(done|completed|finished|ok)\W*\d*\s*$/i.test(note) ? "\n“" + String(note).slice(0, 300) + "”" : "") + (mediaPath ? "\nPhoto/file: " + fileLink(mediaPath) : ""));
  }
}

// ---------- context for answers ----------
// Each person's answer is built ONLY from the data their role may see (locked here, not just told to the AI).
//   owners (Ravi, Brunda, Tassmai): everything · maadhu: office accounts (Tally) + own tasks
//   prakash: dispatch + perfume/chemical stock · virupaksha: production status + packing/carton stock
//   security: lorries expected, inward labels, today's gate scans (names/times only)
const ROLE_CATS = { prakash: ["perfume", "other"], virupaksha: ["packing", "carton"], security: ["raw"] };
const fmtIST = (ts) => new Date(new Date(ts).getTime() + 5.5 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
function stockLines(lots, cats) {
  const s = {};
  (lots || []).forEach((l) => { if (cats && !cats.includes(l.cat)) return; if (l.status === "used") return;
    const e = s[l.item] = s[l.item] || { unit: l.unit, store: 0, pk: 0, issued: 0, expected: 0 };
    if (l.status === "store") { e.store += +l.qty || 0; e.pk++; } else if (l.status === "issued") e.issued++; else if (l.status === "expected") e.expected++; });
  return Object.keys(s).sort().map((k) => k + ": in store " + Math.round(s[k].store * 100) / 100 + " " + (s[k].unit || "") + " (" + s[k].pk + " pkgs), issued " + s[k].issued + ", expected " + s[k].expected).join("\n") || "no labelled stock yet";
}
function dispatchFor(lg, money) {
  return ((lg && lg.shipments) || []).slice(0, 80).map((x) => {
    const o = { order: x.orderNo, customer: x.customer, date: x.date, items: x.items, cartons: x.qty, production: x.production, invoice: x.invoiceNo,
      readyOn: x.readyOn, dispatchedOn: x.dispatchedOn, deliveredOn: x.deliveredOn, transporter: x.transporter, lr: x.lrNo, destination: x.destination, followUp: x.followUp };
    if (money) { o.invoiceAmount = x.invoiceAmount; o.freight = x.freight; o.payments = x.payments; }
    return JSON.stringify(o);
  }).join("\n");
}
async function answerContext(p) {
  const parts = [], role = p.owner ? "owner" : p.key;
  const tasks = await openTasks(p.owner ? null : p.key);
  parts.push("OPEN TASKS (id | for | title | due):\n" + (tasks.length ? tasks.map((t) => "#" + t.id + " | " + t.assignee + " | " + t.title + " | " + W.fmtDue(t.due)).join("\n") : "none"));
  const done = await W.sb("GET", "/rest/v1/wa_tasks?status=eq.done&done_at=gte." + new Date(Date.now() - 7 * 864e5).toISOString() + (p.owner ? "" : "&assignee=eq." + p.key) + "&order=done_at.desc&limit=40&select=id,assignee,title,done_at");
  parts.push("TASKS DONE IN LAST 7 DAYS:\n" + ((done || []).map((t) => "#" + t.id + " " + t.assignee + " — " + t.title + " (" + String(t.done_at).slice(0, 10) + ")").join("\n") || "none"));
  // messages: owners see all; staff see only their own direct chat + groups
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const msgs = (await W.sb("GET", "/rest/v1/wa_messages?ts=gte." + since + "&chat_role=neq.unknown&order=ts.desc&limit=120&select=ts,chat_name,chat_role,chat_jid,sender,sender_name,body,media_name")) || [];
  const mine = (m) => m.chat_role === "group" || (W.personByPhone(m.sender) || {}).key === p.key || m.sender_name === p.name;
  parts.push("WHATSAPP MESSAGES, LAST 3 DAYS (newest first; time | chat | sender | text):\n" + msgs.filter((m) => p.owner || mine(m))
    .map((m) => fmtIST(m.ts) + " | " + (m.chat_role === "group" ? m.chat_name : "direct") + " | " + (m.sender_name || "?") + " | " + String(m.body || m.media_name || "").replace(/\s+/g, " ").slice(0, 300)).join("\n"));
  const K = {};
  try { const rows = (await W.sb("GET", "/rest/v1/kv?owner=eq.main&k=in.(pf_logistics_v2,pf_inv_lots,pf_inv_expected,pf_dispatch_loads,pf_gate_scans)&select=k,v")) || []; rows.forEach((r) => (K[r.k.slice(3)] = r.v)); } catch (e) {}
  if (role === "owner") {
    parts.push("DISPATCH REGISTER (raw JSON, may be truncated):\n" + JSON.stringify(K.logistics_v2 || {}).slice(0, 14000));
    parts.push("STORE STOCK (labelled packages):\n" + stockLines(K.inv_lots));
    try {
      const ent = await W.sb("GET", "/rest/v1/entries?owner=eq.main&created_at=gte." + new Date(Date.now() - 21 * 864e5).toISOString() + "&order=created_at.desc&limit=200&select=date,category,title,person,vendor,amount,tags");
      parts.push("TRACKER ENTRIES, LAST 3 WEEKS (date | category | title | person | vendor | amount | tags):\n" + (ent || []).map((e) => [e.date, e.category, e.title, e.person, e.vendor, e.amount, (e.tags || []).join("/")].map((x) => x || "").join(" | ")).join("\n"));
    } catch (e) {}
    try { parts.push(await require("./tally-ask-background.js").context()); } catch (e) {}
  } else if (role === "maadhu") {
    try { parts.push(await require("./tally-ask-background.js").context()); } catch (e) {}
  } else if (role === "prakash") {
    parts.push("DISPATCH REGISTER:\n" + dispatchFor(K.logistics_v2, true));
    parts.push("CARTON LOADING (customer | invoice | loaded/total):\n" + (K.dispatch_loads || []).map((L) => L.customer + " | " + (L.invoice || "-") + " | " + (L.loaded || []).length + "/" + L.total).join("\n"));
    parts.push("PERFUME & CHEMICAL STOCK:\n" + stockLines(K.inv_lots, ROLE_CATS.prakash));
  } else if (role === "virupaksha") {
    parts.push("ORDERS & PRODUCTION STATUS:\n" + dispatchFor(K.logistics_v2, false));
    parts.push("PACKING & CARTON STOCK:\n" + stockLines(K.inv_lots, ROLE_CATS.virupaksha));
  } else if (role === "security") {
    parts.push("LORRIES / BILLS EXPECTED (supplier | bill | packages):\n" + (K.inv_expected || []).filter((e) => !e.done).map((e) => (e.supplier || "") + " | " + (e.billNo || "") + " | " + ((K.inv_lots || []).filter((l) => l.expId === e.id && l.status === "expected").length) + " still to arrive").join("\n"));
    parts.push("RAW MATERIAL STOCK:\n" + stockLines(K.inv_lots, ROLE_CATS.security));
    const today = W.istDate();
    parts.push("TODAY'S GATE SCANS (name | in/out | time):\n" + (K.gate_scans || []).filter((x) => x.d === today && (x.dir === "IN" || x.dir === "OUT")).map((x) => x.name + " | " + x.dir + " | " + x.t).join("\n"));
  }
  parts.push("ACCESS: this person is " + (p.owner ? "an owner — may see everything above." : "staff (" + p.name + ") — the data above is ALL they may see. If asked about anything else (money, profit, salaries, bank, other people's chats, Ravi's personal notes or reminders) reply: \"Sorry, that isn't available on this number for you.\""));
  return parts.join("\n\n");
}

// ---------- conversation memory (last few turns in this chat) ----------
async function history(jid) {
  const inn = await W.sb("GET", "/rest/v1/wa_messages?chat_jid=eq." + encodeURIComponent(jid) + "&order=ts.desc&limit=6&select=ts,sender_name,body,media_name");
  const out = await W.sb("GET", "/rest/v1/wa_outbox?to_jid=eq." + encodeURIComponent(jid) + "&order=id.desc&limit=6&select=created_at,body");
  const all = (inn || []).map((m) => ({ t: m.ts, s: (m.sender_name || "them") + ": " + String(m.body || m.media_name || "").slice(0, 300) }))
    .concat((out || []).map((m) => ({ t: m.created_at, s: "Office number: " + String(m.body || "").slice(0, 300) })));
  return all.sort((a, b) => (a.t < b.t ? -1 : 1)).map((x) => x.s).join("\n");
}

// ---------- the decision ----------
async function decide(row, p, media, extra) {
  const now = W.istNow();
  const people = Object.keys(W.PEOPLE).filter((k) => !W.PEOPLE[k].alias).map((k) => k + " = " + W.PEOPLE[k].name + (W.PEOPLE[k].owner ? " (owner/family)" : " (staff)")).join(", ");
  const prompt =
`Now (India time): ${now.toISOString().slice(0, 16).replace("T", " ")}, ${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}.
Company: Onam Agarbathi Pvt Ltd, incense maker, Bangalore. Roles: Prakash = orders, dispatch, chemicals & perfumes; Virupaksha = production, packing material; Maadhu = accountant (Tally); Security = gate, inwards, raw bathi; Ravi = director.
People (use these keys): ${people}
Message from: ${p.name} (${p.owner ? "owner/family" : "staff"})${row.source === "email" ? " — this arrived as an EMAIL he forwarded" : ""}
${p.name}'s open tasks: ${extra.myTasks || "none"}
${extra.quoted ? "They are replying to this earlier message from the office number:\n\"\"\"" + extra.quoted + "\"\"\"\n" : ""}Recent conversation in this chat:
${extra.hist || "(none)"}

Message text: """${String(row.body || "").slice(0, 8000)}"""
${media ? "An attachment is included above (" + (row.media_name || row.media_type) + ")." : (row.media_name ? "There was an attachment (" + row.media_name + ") that cannot be read." : "")}

Decide ONE intent:
- "task": someone is asked to do something (e.g. "Prakash: send samples by Mon", "ask Viru to finish 500 boxes tomorrow"). Assignee = the person named; if they say "I will…"/"remind me" and the sender is staff, the assignee is the sender.
- "reminder": an owner/family member wants a reminder for THEMSELVES ("remind me…").
- "done": they report finishing one of their open tasks (give its id). Use only when clear.
- "document": the attachment is a business document or photo (sales order, purchase bill, PO, payment advice, delivery proof, e-way bill, LR, quotation, lorry/goods photo…).
- "question": they want information ("pending dispatches?", "what's due today?", "did the DEP bill come?").
- "note": something to keep on record.
- "chat": greeting/thanks/unclear — reply briefly.
Dates: "today/tomorrow/Monday" relative to now; no time → 17:00; "by end of week" → Saturday 17:00.
Categories for entries: ${CATS.join(", ")}. Use "Sales - Order" only for a customer order, "Business - Purchase" for supplier bills/purchases, "Sales - Payment" only for money received.

Reply with ONLY this JSON:
{"intent":"task|reminder|done|document|question|note|chat",
 "tasks":[{"assignee":"key","title":"max 60 chars","details":"","due":"YYYY-MM-DDTHH:MM or empty"}],
 "done_ids":[0],
 "doc":{"type":"","party":"","amount":"","date":"YYYY-MM-DD","ref":"invoice/PO/LR number","summary":"2 lines max, exact numbers"},
 "entry":{"category":"","title":"max 60 chars","notes":"what to keep, exact figures, no fluff"},
 "reply":"for chat only: one short line"}`;
  const content = [];
  if (media) content.push(media.type === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: media.b64 } }
    : { type: "image", source: { type: "base64", media_type: media.type, data: media.b64 } });
  content.push({ type: "text", text: prompt });
  return W.parseJSON(await W.claude(content, "You are the operations assistant on Onam Agarbathi's office WhatsApp number. Output only JSON.", 1400));
}

async function fileEntry(d, row, p, mediaPath, quiet) {
  const e = d.entry || {}, doc = d.doc || {};
  let cat = CATS.includes(e.category) ? e.category : "Quick Notes";
  const money = !!(doc.amount || /₹|rs\.?\s?\d|\d{4,}/i.test(String(e.notes || "")));
  const tags = ["WhatsApp"].concat(p.owner ? [] : ["From " + p.name]).concat(cat === "Quick Notes" ? ["Quick Note"] : ["Pending"]).concat(!p.owner && money ? ["To verify"] : []);
  const notes = [e.notes, doc.summary ? "Document: " + doc.summary : "", doc.ref ? "Ref: " + doc.ref : "",
    "Received on WhatsApp from " + p.name + (row.chat_role === "group" ? " in group " + row.chat_name : "") + (row.source === "email" ? " (forwarded email)" : "") + ".",
    row.body && row.body.length > 0 && row.body !== e.notes ? "Original message: " + String(row.body).slice(0, 1500) : ""].filter(Boolean).join("\n\n");
  const entry = { id: genId(), title: String(e.title || doc.summary || row.media_name || "WhatsApp note").slice(0, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(doc.date || "") ? doc.date : W.istDate(), category: cat, tags, notes, createdAt: new Date().toISOString() };
  if (doc.party) { if (/Purchase/.test(cat)) entry.vendor = doc.party; else entry.person = doc.party; }
  if (doc.amount) entry.amount = String(doc.amount).replace(/[^\d.]/g, "");
  if (mediaPath) { const url = fileLink(mediaPath); entry.attachments = [{ name: row.media_name || "attachment", data: url, type: row.media_type || "" }]; entry.link = url; entry.linkLabel = "📎 " + (row.media_name || "Attachment"); }
  const s = await call({ action: "save", user: "main", entry });
  return s.ok ? entry : null;
}

async function processRow(row) {
  const claim = await W.sb("PATCH", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(row.id) + "&status=in.(new,retry)", { status: "working" }, { Prefer: "return=representation" });
  if (!claim || !claim.length) return; // someone else has it
  const done = (result) => W.sb("PATCH", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(row.id), { status: "done", result: String(result).slice(0, 500) }, { Prefer: "return=minimal" });
  const isGroup = row.chat_role === "group";
  const p = W.personByPhone(row.sender) || { key: "unknown", name: row.sender_name || "Someone", owner: false };
  const replyTo = row.chat_jid;
  const reply = (t) => (isGroup ? null : W.send(replyTo, t));
  const text = String(row.body || "").trim();

  // voice / unreadable
  if (/^audio\//.test(row.media_type || "") && !text) { await reply("🎙️ Voice notes can't be read yet — please type it, or send a photo."); return done("voice"); }
  if (/^skipped:/.test(row.media_type || "")) { await reply("That file is too large to read (over ~4 MB). Send a photo of the page instead."); }

  // quick commands (direct chats only)
  if (!isGroup && /^(help|\?|hi|hello|menu)$/i.test(text) && !row.media_url) { await reply(HELP); return done("help"); }
  if (!isGroup && /^(tasks?|my tasks|pending|open tasks)\??$/i.test(text)) {
    const list = await openTasks(p.owner ? null : p.key);
    await reply(list.length ? "*Open tasks (" + list.length + ")*\n" + list.map((t) => "• " + taskLine(t, p.owner)).join("\n") : "No open tasks 🎉");
    return done("tasks");
  }

  // done — explicit number, or a reply to the task message, or the only open task
  const dm = text.match(/^(?:✅\s*)?(done|completed|complete|finished|ok done)(?:\s*#?\s*(\d+)\b[\s\S]*|[\s.!👍✅]*)$/i);
  let quoted = null, quotedTask = null;
  if (row.quoted_id) {
    let q = await W.sb("GET", "/rest/v1/wa_outbox?wa_id=eq." + encodeURIComponent(row.quoted_id) + "&select=body,task_id&limit=1");
    const tail = String(row.quoted_id).split("_").pop();
    if ((!q || !q.length) && tail && tail.length > 8) q = await W.sb("GET", "/rest/v1/wa_outbox?wa_id=like.*" + encodeURIComponent(tail) + "&select=body,task_id&limit=1");
    if (q && q[0]) { quoted = q[0].body; if (q[0].task_id) quotedTask = q[0].task_id; }
  }
  if (!isGroup && (dm || (quotedTask && /\b(done|completed|finished|delivered|sent|ok)\b/i.test(text)) || (quotedTask && row.media_url && !text))) {
    const mine = await openTasks(p.owner ? null : p.key);
    const id = (dm && dm[2]) ? Number(dm[2]) : quotedTask;
    let t = id ? (await W.sb("GET", "/rest/v1/wa_tasks?id=eq." + id + "&select=*"))[0] : null;
    if (!t && !id) { const own = mine.filter((x) => x.assignee === p.key); if (own.length === 1) t = own[0]; }
    if (t && t.status === "done") { await reply("Task #" + t.id + " was already closed."); return done("already done"); }
    if (t && (t.assignee === p.key || p.owner)) { await closeTask(t, p, text, row.media_url); await reply("✅ Closed #" + t.id + " " + t.title + (t.created_by !== p.key ? " — " + (W.PEOPLE[t.created_by] || { name: t.created_by }).name + " has been told." : "")); return done("closed #" + t.id); }
    if (dm) {
      const own = mine.filter((x) => x.assignee === p.key);
      await reply(own.length ? "Which one? Reply *done* with the number:\n" + own.map((x) => "• " + taskLine(x)).join("\n") : "You have no open tasks to close.");
      return done("asked which task");
    }
  }

  // group text with no attachment: keep for questions, no action
  if (isGroup && !row.media_url) return done("group text logged");

  // read the attachment if we can
  let media = null;
  if (row.media_url && READABLE.test(row.media_type || "")) {
    const b64 = await fileB64(row.media_url);
    if (b64 && b64.length < 6.5e6) media = { b64, type: row.media_type };
  }
  if (!text && !media && !row.media_url) return done("empty");

  const myTasks = (await openTasks(p.key)).map((t) => "#" + t.id + " " + t.title).join("; ");
  let d;
  try { d = await decide(row, p, media, { myTasks, quoted, hist: isGroup ? "" : await history(row.chat_jid) }); }
  catch (e) { await W.sb("PATCH", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(row.id), { status: "retry", result: "AI: " + e.message }, { Prefer: "return=minimal" }); return; }
  let intent = d.intent;
  if (isGroup) intent = "document";                               // groups: only file attachments
  if (intent === "reminder" && !p.owner) { intent = "task"; (d.tasks || []).forEach((t) => { t.assignee = p.key; }); }

  if (intent === "task" && (d.tasks || []).length) {
    const made = [];
    for (const t of d.tasks.slice(0, 8)) { if (!W.personKey(t.assignee)) t.assignee = p.key; made.push(await createTask(t, p, row.id)); }
    await reply(made.map((t) => (t.assignee === p.key ? "📝 Noted for you: " : "📌 Sent to " + W.PEOPLE[t.assignee].name + ": ") + "#" + t.id + " " + t.title + " — due " + W.fmtDue(t.due)).join("\n") +
      "\nI'll follow up until it's marked done.");
    return done("tasks " + made.map((t) => "#" + t.id).join(","));
  }

  if (intent === "reminder") {
    const r = await require("./smartnote.js").route({ user: "main", text: text || (d.entry && d.entry.notes) || "" });
    await reply(r && r.ok ? "⏰ Reminder set: " + (r.title || "") + (r.reminder ? "\nWhen: " + W.fmtDue(r.reminder) : "") : "Could not set that reminder — try again with a date and time.");
    return done("reminder " + ((r && r.id) || "failed"));
  }

  if (intent === "done" && (d.done_ids || []).filter(Boolean).length) {
    const out = [];
    for (const id of d.done_ids.filter(Boolean).slice(0, 5)) {
      const t = (await W.sb("GET", "/rest/v1/wa_tasks?id=eq." + Number(id) + "&status=eq.open&select=*"))[0];
      if (t && (t.assignee === p.key || p.owner)) { await closeTask(t, p, text, row.media_url); out.push("#" + t.id + " " + t.title); }
    }
    await reply(out.length ? "✅ Closed: " + out.join(", ") : "I couldn't match that to an open task. Send *tasks* to see the list.");
    return done("done " + out.join(","));
  }

  if (intent === "question") {
    const ctx = await answerContext(p);
    const ans = await W.claude([{ type: "text", text: ctx + "\n\nQuestion from " + p.name + ": " + text }],
      "You answer questions on Onam Agarbathi's office WhatsApp number. Today (India) is " + W.istDate() + ". Answer ONLY from the data given; if it isn't there, say what's missing in one line. " +
      "WhatsApp style: short, plain text, *bold* allowed, bullet lines starting with •, no tables, no markdown headers. Indian number format (₹1,23,456, lakh, crore). " +
      (p.owner ? "" : "This person is staff: never reveal profit, margin, salaries, bank balances or attendance figures.") + " End with one suggested next step if useful.", 1200);
    await reply(ans.slice(0, 3800));
    return done("answered");
  }

  if (intent === "chat" && !media) { await reply(d.reply || "👍"); return done("chat"); }

  // note / document
  if (intent === "note" && p.owner && !media && !row.media_url) {
    const r = await require("./smartnote.js").route({ user: "main", text });
    await reply(r && r.ok ? (r.mode === "append" ? "Added to: " + r.title : "Filed under " + r.category + ": " + r.title) : "Nothing to file in that.");
    return done("note " + ((r && r.id) || ""));
  }
  const e = await fileEntry(d, row, p, row.media_url, isGroup);
  if (!e) { await reply("Could not file that just now — it's saved and I'll retry."); await W.sb("PATCH", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(row.id), { status: "retry" }, { Prefer: "return=minimal" }); return; }
  const doc = d.doc || {};
  await reply("🗂️ Filed under *" + e.category + "*: " + e.title + (doc.summary ? "\n" + doc.summary : "") +
    (e.tags.includes("To verify") ? "\n(Marked *to verify*.)" : "") +
    (media || row.media_url ? "\n\nIf someone needs to act on it, reply with who and when — e.g. _Prakash dispatch by Friday_." : ""));
  return done("filed " + e.id + " " + e.category);
}

exports.processRow = processRow; exports.answerContext = answerContext;
exports.handler = async (event) => {
  if ((event.headers || {})["x-run-key"] !== T.runKey()) return { statusCode: 403, body: "no" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  let rows = [];
  if (Array.isArray(b.ids) && b.ids.length) rows = await W.sb("GET", "/rest/v1/wa_messages?id=in.(" + b.ids.map((x) => '"' + String(x).replace(/"/g, "") + '"').join(",") + ")&order=ts.asc&select=*");
  else rows = await W.sb("GET", "/rest/v1/wa_messages?status=in.(new,retry)&ts=gte." + new Date(Date.now() - 3 * 864e5).toISOString() + "&order=ts.asc&limit=25&select=*");
  for (const r of rows || []) {
    try { await processRow(r); }
    catch (e) { try { await W.sb("PATCH", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(r.id), { status: "retry", result: "error: " + String(e.message || e).slice(0, 300) }, { Prefer: "return=minimal" }); } catch (x) {} }
  }
  return { statusCode: 200, body: "ok" };
};
