// Every 15 minutes. Keeps the WhatsApp loop moving:
//   • #wa emails → into the WhatsApp brain (forward any email with #wa in the subject)
//   • tasks: "due now" nudge, one overdue nudge a day, escalation to whoever set it
//   • 10:15 each person's open tasks · 17:30 Ravi's day summary
//   • retries any message the brain couldn't finish
// Messages only go out 10:00–18:00 IST, when the office Mac Mini (bridge) is on.
const W = require("./wa-lib.js");
const T = require("./tally.js");
const db = require("./db.js");
const EMAIL_PEOPLE = { "onamagarbathi@gmail.com": "ravi", "prakashonam@gmail.com": "prakash", "onamviru@gmail.com": "virupaksha", "onammadhu@gmail.com": "maadhu" };
const READABLE = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;

async function brain(body) {
  try { await fetch(W.SITE() + "/.netlify/functions/wa-brain-background", { method: "POST", headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: JSON.stringify(body || {}) }); } catch (e) {}
}

async function importEmails() {
  const G = require("./gmail.js");
  const st = (await W.kvGet("wa_mail_seen")) || { ids: [] };
  const seen = new Set(st.ids || []);
  const { tok, messages } = await G.search("subject:#wa newer_than:3d -label:spam", 10);
  const ids = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const addr = (String(m.from).match(/[\w.+-]+@[\w.-]+/) || [""])[0].toLowerCase();
    const key = EMAIL_PEOPLE[addr] || "ravi";
    const p = W.PEOPLE[key];
    let mediaPath = null, mediaType = null, mediaName = null;
    const att = (m.attachments || []).find((a) => READABLE.test(a.type) && (a.size || 0) < 4.5e6);
    if (att) {
      try {
        const buf = await G.attachment(tok, m.id, att.id);
        const up = JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify({ action: "uploadFile", user: "main", file: { name: att.name, type: att.type, data: buf.toString("base64") } }) })).body || "{}");
        if (up.ok) { mediaPath = up.id; mediaType = att.type; mediaName = att.name; }
      } catch (e) {}
    }
    const others = (m.attachments || []).filter((a) => a !== att).map((a) => a.name);
    const body = String(m.subject || "").replace(/#wa\b/ig, "").trim() + "\n(email from " + m.from + ")\n\n" + String(m.body || "").slice(0, 12000) + (others.length ? "\n\nOther attachments: " + others.join(", ") : "");
    const id = "email:" + m.id;
    await W.sb("POST", "/rest/v1/wa_messages", [{ id, chat_jid: p.phone + "@c.us", chat_name: "email", chat_role: p.owner ? "owner" : "staff", sender: p.phone, sender_name: p.name,
      ts: new Date(m.internalDate || Date.now()).toISOString(), body, media_type: mediaType, media_url: mediaPath, media_name: mediaName, status: "new", source: "email" }], { Prefer: "return=minimal,resolution=ignore-duplicates" });
    ids.push(id);
  }
  await W.kvSet("wa_mail_seen", { ids: [...seen].slice(-300), at: new Date().toISOString() });
  if (ids.length) await brain({ ids });
  return ids.length;
}

async function taskNudges(today) {
  const open = await W.sb("GET", "/rest/v1/wa_tasks?status=eq.open&due=lte." + new Date().toISOString() + "&select=*&order=due.asc");
  const escal = {};
  for (const t of open || []) {
    if (t.last_nudge !== today) {
      await W.send(t.assignee, "⏰ *Due* — #" + t.id + " " + t.title + " (was due " + W.fmtDue(t.due) + ")\nReply *done " + t.id + "* when finished.", { kind: "task", taskId: t.id });
      await W.sb("PATCH", "/rest/v1/wa_tasks?id=eq." + t.id, { last_nudge: today }, { Prefer: "return=minimal" });
    }
    const lateH = (Date.now() - new Date(t.due).getTime()) / 36e5;
    if (lateH > 24 && t.escalated !== today && t.created_by !== t.assignee) {
      (escal[t.created_by] = escal[t.created_by] || []).push(t);
      await W.sb("PATCH", "/rest/v1/wa_tasks?id=eq." + t.id, { escalated: today }, { Prefer: "return=minimal" });
    }
  }
  for (const k of Object.keys(escal)) {
    await W.send(k, "🚩 *Overdue more than a day*\n" + escal[k].map((t) => "• #" + t.id + " " + t.title + " — " + (W.PEOPLE[t.assignee] || { name: t.assignee }).name + " (due " + W.fmtDue(t.due) + ")").join("\n"));
  }
}

async function morningLists() {
  const open = (await W.sb("GET", "/rest/v1/wa_tasks?status=eq.open&select=*&order=due.asc.nullslast")) || [];
  const by = {};
  open.forEach((t) => (by[t.assignee] = by[t.assignee] || []).push(t));
  for (const k of Object.keys(by)) {
    await W.send(k, "☀️ *Good morning " + (W.PEOPLE[k] || { name: "" }).name + " — your open tasks*\n" + by[k].map((t) => "• #" + t.id + " " + t.title + " (due " + W.fmtDue(t.due) + ")" + (t.due && new Date(t.due) < new Date() ? " ⚠️" : "")).join("\n") + "\n\nAs you finish, reply *done* with the number (e.g. *done " + by[k][0].id + "*).");
  }
}

async function eveningSummary(today) {
  const start = new Date(today + "T00:00:00+05:30").toISOString();
  const done = (await W.sb("GET", "/rest/v1/wa_tasks?status=eq.done&done_at=gte." + start + "&select=id,title,assignee")) || [];
  const open = (await W.sb("GET", "/rest/v1/wa_tasks?status=eq.open&select=id,title,assignee,due&order=due.asc.nullslast")) || [];
  const msgs = (await W.sb("GET", "/rest/v1/wa_messages?ts=gte." + start + "&chat_role=neq.unknown&select=result,chat_role")) || [];
  const filed = msgs.filter((m) => /^filed /.test(m.result || ""));
  const cats = {}; filed.forEach((m) => { const c = String(m.result).split(" ").slice(2).join(" ") || "?"; cats[c] = (cats[c] || 0) + 1; });
  const late = open.filter((t) => t.due && new Date(t.due) < new Date());
  const name = (k) => (W.PEOPLE[k] || { name: k }).name;
  const txt = "🌆 *WhatsApp day summary — " + today + "*\n" +
    "Messages in: " + msgs.length + " · Filed: " + filed.length + (filed.length ? " (" + Object.keys(cats).map((c) => c + " " + cats[c]).join(", ") + ")" : "") + "\n\n" +
    "*Done today (" + done.length + ")*\n" + (done.map((t) => "• #" + t.id + " " + t.title + " — " + name(t.assignee)).join("\n") || "• none") + "\n\n" +
    "*Overdue (" + late.length + ")*\n" + (late.map((t) => "• #" + t.id + " " + t.title + " — " + name(t.assignee) + " (due " + W.fmtDue(t.due) + ")").join("\n") || "• none") + "\n\n" +
    "Open in total: " + open.length + ". Send *tasks* for the full list.";
  await W.send("ravi", txt);
}

exports.handler = async () => {
  const h = W.istHour(), today = W.istDate();
  const st = (await W.kvGet("wa_cron_state")) || {};
  const log = [];
  try { if (h >= 9.5 && h < 19) log.push("emails " + await importEmails()); } catch (e) { log.push("emails: " + e.message); }
  try {
    const stuck = await W.sb("GET", "/rest/v1/wa_messages?status=in.(new,retry)&ts=gte." + new Date(Date.now() - 3 * 864e5).toISOString() + "&ts=lte." + new Date(Date.now() - 120e3).toISOString() + "&select=id&limit=1");
    if (stuck && stuck.length) { await brain({}); log.push("retry kicked"); }
  } catch (e) { log.push("retry: " + e.message); }
  if (h >= 10 && h < 18) {
    try { await taskNudges(today); } catch (e) { log.push("nudges: " + e.message); }
    if (h >= 10.25 && h < 12 && st.morning !== today) { st.morning = today; try { await morningLists(); } catch (e) { log.push("morning: " + e.message); } }
    if (h >= 17.5 && st.evening !== today) { st.evening = today; try { await eveningSummary(today); } catch (e) { log.push("evening: " + e.message); } }
  }
  st.last = new Date().toISOString(); st.log = log;
  await W.kvSet("wa_cron_state", st);
  return { statusCode: 200, body: JSON.stringify({ ok: true, log }) };
};
