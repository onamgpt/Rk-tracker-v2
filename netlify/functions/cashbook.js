// Cash Book only — for the accountant. This endpoint can read and write the
// one cash_book record and nothing else, and every call must carry a valid
// PIN (Maadhu's or the owner's), checked here on the server.
const crypto = require("crypto");
const db = require("./db.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const ALLOWED = ["maadhu", "main"];
const hash = (pin) => crypto.createHash("sha256").update("rkpin:" + pin).digest("hex");

async function who(user, pin) {
  user = String(user || "").toLowerCase();
  if (!ALLOWED.includes(user) || !pin) return null;
  const r = await call({ action: "getPortfolio", user: "main", key: "user_pins" });
  const map = (r && r.data) || {};
  if (!map[user]) return null;                      // no PIN set → no access
  return map[user] === hash(String(pin)) ? user : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad request" }); }
  const user = await who(b.user, b.pin);
  if (!user) return OK({ error: "pin" });

  const cur = (await call({ action: "getPortfolio", user: "main", key: "cash_book" })).data || { opening: "", openingDate: "", rows: [] };
  if (b.action === "get") return OK({ ok: true, book: cur, user });

  if (b.action === "save") {
    // Merge row by row so two people saving never wipe each other's entries.
    const del = new Set(b.deleted || []);
    const mine = new Map((b.rows || []).filter(r => r && r.id).map(r => [r.id, r]));
    const out = [];
    (cur.rows || []).forEach(r => { if (del.has(r.id)) return; out.push(mine.has(r.id) ? mine.get(r.id) : r); mine.delete(r.id); });
    mine.forEach(r => { if (!del.has(r.id)) out.push(Object.assign({ by: user }, r)); });
    const book = { opening: b.opening != null ? b.opening : cur.opening, openingDate: b.openingDate != null ? b.openingDate : cur.openingDate,
      rows: out, updated: new Date().toISOString(), updatedBy: user };
    await call({ action: "savePortfolio", user: "main", key: "cash_book", data: book });
    return OK({ ok: true, book });
  }
  return OK({ error: "unknown action" });
};
