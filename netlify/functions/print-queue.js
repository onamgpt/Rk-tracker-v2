// Print queue for the office HP M132nw, printed locally by the Mac Mini (no cloud).
// Items are queued here (plain text, ready to print) and the Mac Mini polls and prints them.
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
async function call(x) {
  const db = require("./db.js");
  return JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(x) })).body || "{}");
}
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const cur = (await call({ action: "getPortfolio", user: "main", key: "print_queue" })).data || { items: [] };
  const items = cur.items || [];

  if (b.action === "add") {
    const id = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    items.push({ id, person: b.person || "", text: b.text || "", printed: false, created: new Date().toISOString() });
    await call({ action: "savePortfolio", user: "main", key: "print_queue", data: { items } });
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, id }) };
  }
  if (b.action === "ack") {
    items.forEach(x => { if (x.id === b.id) x.printed = true; });
    await call({ action: "savePortfolio", user: "main", key: "print_queue", data: { items } });
    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
  }
  // default: pending
  const pending = items.filter(x => !x.printed);
  return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, items: pending }) };
};
