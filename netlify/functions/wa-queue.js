// WhatsApp outbound queue. Messages are queued here; the Mac Mini bridge
// (~/onam-whatsapp/bridge.js) polls this, sends via WhatsApp, then acks.
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

// Who gets what. Owners see everything incl. profit/margin/attendance.
const PEOPLE = {
  ravi:      { name: "Ravi",      phone: "919845563633", owner: true },
  ravi2:     { name: "Ravi (biz)", phone: "918310368142", owner: true },
  brunda:    { name: "Brunda",    phone: "919886211325", owner: true },
  tassmai:   { name: "Tassmai",   phone: "919900504401", owner: true },
  prakash:   { name: "Prakash",   phone: "919844725484", owner: false },
  virupaksha:{ name: "Virupaksha", phone: "919845807015", owner: false },
  security:  { name: "Security Onam", phone: "919900537494", owner: false },
  maadhu:    { name: "Maadhu",    phone: "916364559047", owner: false }
};

async function call(x) {
  const db = require("./db.js");
  return JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(x) })).body || "{}");
}

function resolve(to) {
  if (!to) return null;
  const key = String(to).toLowerCase().trim();
  if (PEOPLE[key]) return PEOPLE[key].phone;
  const digits = String(to).replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length >= 11) return digits;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const q = event.queryStringParameters || {};
  const action = b.action || q.action || "pending";

  const cur = (await call({ action: "getPortfolio", user: "main", key: "wa_queue" })).data || { items: [] };
  let items = cur.items || [];

  if (action === "people") {
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, people: PEOPLE }) };
  }

  if (action === "add") {
    const targets = Array.isArray(b.to) ? b.to : [b.to];
    const added = [];
    for (const t of targets) {
      const phone = resolve(t);
      if (!phone) continue;
      const id = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      items.push({ id, to: phone, message: b.message || "", sent: false, created: new Date().toISOString() });
      added.push(id);
    }
    await call({ action: "savePortfolio", user: "main", key: "wa_queue", data: { items } });
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, added }) };
  }

  if (action === "ack") {
    items.forEach(x => { if (x.id === b.id) { x.sent = true; x.sentAt = new Date().toISOString(); } });
    // keep the last 200 so the record does not grow forever
    if (items.length > 200) items = items.slice(-200);
    await call({ action: "savePortfolio", user: "main", key: "wa_queue", data: { items } });
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
  }

  // default: pending jobs for the bridge
  const jobs = items.filter(x => !x.sent);
  return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, jobs }) };
};
