// Inbound WhatsApp. The Mac Mini bridge posts every message that reaches the
// office number (direct chats and groups). This stores it (wa_messages, deduped
// by WhatsApp's message id, so the morning catch-up can safely resend), keeps
// any photo/PDF in the private tracker-files bucket, then hands it to
// wa-brain-background, which decides what to do and replies via the outbox.
const W = require("./wa-lib.js");
const T = require("./tally.js");
const db = require("./db.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type, x-bridge-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const OK = (o, c) => ({ statusCode: c || 200, headers: H, body: JSON.stringify(o) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return OK({});
  if (!(await W.bridgeOk(event))) return OK({ ok: false, error: "bridge key required" }, 403);
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}

  const id = String(b.id || "").slice(0, 200);
  const chatJid = String(b.chatJid || "");
  const isGroup = /@g\.us$/.test(chatJid) || !!b.isGroup;
  const from = String(b.from || "").replace(/\D/g, "");
  if (!id || !chatJid) return OK({ ok: false, error: "missing id/chat" }, 400);

  const p = W.personByPhone(from);
  const role = isGroup ? "group" : (p ? (p.owner ? "owner" : "staff") : "unknown");

  // Duplicate (already stored) → nothing to do.
  const have = await W.sb("GET", "/rest/v1/wa_messages?id=eq." + encodeURIComponent(id) + "&select=id");
  if (have && have.length) return OK({ ok: true, duplicate: true });

  let mediaPath = null;
  if (b.mediaBase64 && role !== "unknown") {
    try {
      const up = JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify({ action: "uploadFile", user: "main",
        file: { name: b.mediaName || ("whatsapp-" + Date.now()), type: b.mediaType || "application/octet-stream", data: b.mediaBase64 } }) })).body || "{}");
      if (up.ok) mediaPath = up.id;
    } catch (e) {}
  }

  await W.sb("POST", "/rest/v1/wa_messages", [{
    id, chat_jid: chatJid, chat_name: String(b.chatName || "").slice(0, 120), chat_role: role,
    sender: from, sender_name: p ? p.name : String(b.senderName || "").slice(0, 80),
    ts: b.ts ? new Date(Number(b.ts) * 1000).toISOString() : new Date().toISOString(),
    body: String(b.text || "").slice(0, 20000), media_type: b.mediaType || (b.mediaSkipped ? "skipped:" + b.mediaSkipped : null),
    media_url: mediaPath, media_name: b.mediaName || null, quoted_id: b.quotedId || null,
    status: role === "unknown" ? "ignored" : "new", source: "whatsapp"
  }], { Prefer: "return=minimal,resolution=ignore-duplicates" });

  if (role !== "unknown") {
    try {
      await fetch(W.SITE() + "/.netlify/functions/wa-brain-background", { method: "POST",
        headers: { "Content-Type": "application/json", "x-run-key": T.runKey() }, body: JSON.stringify({ ids: [id] }) });
    } catch (e) {}
  }
  return OK({ ok: true, role });
};
