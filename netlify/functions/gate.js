// Gate attendance: each worker's card carries a random token (QR). Security scans it on a phone.
// Users: "gate" (security, scan only) and "main" (Ravi, also manages workers and cards). Nobody else.
const crypto = require("crypto");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
const shift = (ms) => new Date(Date.now() + 5.5 * 3600e3 + ms);
const todayIST = () => shift(0).toISOString().slice(0, 10);
const nowIST = () => shift(0).toISOString().slice(11, 16);
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const DUP_SECONDS = 120;

async function loadAll() { return { W: (await kvGet("gate_workers")) || [], S: (await kvGet("gate_scans")) || [] }; }

// Pure scan logic, also used by the tests.
function applyScan(W, S, token, by, now) {
  const w = W.find((x) => x.token === String(token || "").trim());
  const t = now.day, ts = now.ts, hhmm = now.hhmm;
  if (!w) { S.push({ wid: null, name: "unrecognised card", d: t, t: hhmm, ts, dir: "BAD", by }); return { ok: false, result: "unknown", msg: "Card not recognised" }; }
  if (!w.active) { S.push({ wid: w.id, name: w.name, d: t, t: hhmm, ts, dir: "BAD", by }); return { ok: false, result: "inactive", msg: w.name + " — card cancelled" }; }
  const mine = S.filter((s) => s.wid === w.id && s.d === t && s.dir !== "DUP" && s.dir !== "BAD");
  const last = mine[mine.length - 1];
  if (last && ts - last.ts < DUP_SECONDS * 1000) { S.push({ wid: w.id, name: w.name, d: t, t: hhmm, ts, dir: "DUP", by }); return { ok: false, result: "duplicate", msg: w.name + " — already scanned a moment ago" }; }
  const dir = !last || last.dir === "OUT" ? "IN" : "OUT";
  S.push({ wid: w.id, name: w.name, d: t, t: hhmm, ts, dir, by });
  return { ok: true, result: dir, name: w.name, t: hhmm, msg: w.name + " — " + dir + " at " + hhmm };
}

exports.applyScan = applyScan;
exports.loadAll = loadAll; exports.kvGet = kvGet; exports.kvSet = kvSet; exports.todayIST = todayIST; exports.addDays = addDays; exports.hash = hash;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const user = String(b.user || "").toLowerCase();
  if (user !== "gate" && user !== "main") return OK({ error: "pin" });
  const pins = (await kvGet("user_pins")) || {};
  if (!pins[user] || pins[user] !== hash(String(b.pin || ""))) return OK({ error: "pin" });
  const owner = user === "main";
  try {
    const { W, S } = await loadAll();
    const today = todayIST();
    if (b.action === "state") {
      return OK({ ok: true, owner, today,
        workers: owner ? W.map((w) => ({ id: w.id, name: w.name, active: w.active, token: w.token })) : W.filter((w) => w.active).map((w) => ({ id: w.id, name: w.name })),
        scans: S.filter((s) => s.d === today).slice(-80).reverse() });
    }
    if (b.action === "scan") {
      const r = applyScan(W, S, b.token, user, { day: today, ts: Date.now(), hhmm: nowIST() });
      await kvSet("gate_scans", S.filter((s) => s.d >= addDays(today, -400)));
      return OK(r);
    }
    if (!owner) return OK({ error: "owner only" });
    if (b.action === "workerAdd") {
      const name = String(b.name || "").trim().slice(0, 80); if (!name) return OK({ error: "name?" });
      const w = { id: "w_" + Date.now().toString(36), name, active: true, token: crypto.randomBytes(12).toString("base64url") };
      W.push(w); await kvSet("gate_workers", W); return OK({ ok: true, worker: w });
    }
    if (b.action === "workerCancel" || b.action === "workerReissue" || b.action === "workerActivate") {
      const w = W.find((x) => x.id === b.id); if (!w) return OK({ error: "not found" });
      if (b.action === "workerCancel") w.active = false;
      if (b.action === "workerActivate") w.active = true;
      if (b.action === "workerReissue") { w.token = crypto.randomBytes(12).toString("base64url"); w.active = true; }
      await kvSet("gate_workers", W); return OK({ ok: true, worker: w });
    }
    if (b.action === "reportNow") {
      const r = await require("./gate-weekly.js").run({ force: true }); return OK({ ok: true, sent: r });
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e && e.message || e) }); }
};
