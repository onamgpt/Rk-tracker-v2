// Inbound WhatsApp. The Mac Mini bridge posts every message that arrives at the
// office number here; this hands it to smartnote, the same brain /note and the
// Siri shortcut use, and returns one line for the bridge to reply with.
//
// Only owner numbers can file entries. A staff member messaging the office
// number gets a polite pointer back to their own channel — their words are
// logged for review but never turned into tracker entries, because a misread
// instruction that creates a financial note is worse than no note at all.
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

const OWNERS = {
  "919845563633": "Ravi",
  "918310368142": "Ravi",
  "919886211325": "Brunda",
  "919900504401": "Tassmai"
};
const KNOWN = {
  "919844725484": "Prakash",
  "919845807015": "Virupaksha",
  "916364559047": "Maadhu",
  "919900537494": "Security Onam"
};

async function call(mod, x) {
  const m = require("./" + mod);
  return JSON.parse((await m.handler({ httpMethod: "POST", body: JSON.stringify(x) })).body || "{}");
}

async function logInbound(entry) {
  try {
    const cur = (await call("db.js", { action: "getPortfolio", user: "main", key: "wa_inbound_log" })).data || { items: [] };
    const items = (cur.items || []).concat([entry]).slice(-300);
    await call("db.js", { action: "savePortfolio", user: "main", key: "wa_inbound_log", data: { items } });
  } catch (e) { /* logging must never break the reply */ }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };

  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch (e) {}

  const from = String(b.from || "").replace(/\D/g, "");
  const text = String(b.text || "").trim();
  const mediaB64 = b.mediaBase64 || "";
  const mediaType = b.mediaType || "";
  const stamp = new Date().toISOString();

  if (!from) return { statusCode: 400, headers: H, body: JSON.stringify({ ok: false, error: "no sender" }) };

  const ownerName = OWNERS[from];
  const staffName = KNOWN[from];

  // Unknown number: ignore completely. No reply, no log entry worth keeping.
  if (!ownerName && !staffName) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, ignored: "unknown sender" }) };
  }

  // Staff: record it, point them back to their own channel, file nothing.
  if (!ownerName) {
    await logInbound({ at: stamp, from, who: staffName, text, handled: "logged only" });
    return { statusCode: 200, headers: H, body: JSON.stringify({
      ok: true,
      reply: "Noted, " + staffName + ". This number sends reminders only. For orders and production please use your daily sheet or email so it reaches the right place."
    }) };
  }

  // Owner: read any image, then let smartnote decide what it is.
  let ocrText = "";
  if (mediaB64 && /^image\//.test(mediaType)) {
    try {
      const r = await call("smartnote.js", { action: "ocr", imageBase64: mediaB64, imageType: mediaType });
      ocrText = String(r.text || "").trim();
    } catch (e) { ocrText = ""; }
  }

  if (!text && !ocrText) {
    await logInbound({ at: stamp, from, who: ownerName, text: "(attachment only, unreadable)", handled: "no text" });
    return { statusCode: 200, headers: H, body: JSON.stringify({
      ok: true,
      reply: "I could not read that. Send a photo of the document, or type what you want noted."
    }) };
  }

  let routed = {};
  try {
    routed = await call("smartnote.js", { action: "route", user: "main", text, ocr: ocrText });
  } catch (e) {
    await logInbound({ at: stamp, from, who: ownerName, text, handled: "route failed: " + e.message });
    return { statusCode: 200, headers: H, body: JSON.stringify({
      ok: true,
      reply: "Could not file that just now. It is logged, nothing lost. Try again in a minute."
    }) };
  }

  if (routed.error) {
    await logInbound({ at: stamp, from, who: ownerName, text, handled: "error: " + routed.error });
    return { statusCode: 200, headers: H, body: JSON.stringify({
      ok: true, reply: "Nothing to file in that message."
    }) };
  }

  await logInbound({ at: stamp, from, who: ownerName, text, handled: routed.category || "filed", entryId: routed.id });

  // Confirm precisely. A vague "done" leaves the person unsure whether the
  // reminder actually exists, which defeats the point of messaging it in.
  let reply;
  if (routed.mode === "append") {
    reply = "Added to: " + (routed.title || "existing entry");
  } else if (routed.category === "Reminders") {
    reply = "Reminder set: " + (routed.title || text.slice(0, 50));
    if (routed.reminder) reply += "\nWhen: " + String(routed.reminder).slice(0, 16).replace("T", " ");
  } else {
    reply = "Filed under " + (routed.category || "Quick Notes") + ": " + (routed.title || text.slice(0, 50));
  }
  if (ocrText) reply += "\n(Text read from the attachment.)";
  reply += "\n\nOpen the tracker to check or change it.";

  return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, reply, entryId: routed.id }) };
};
