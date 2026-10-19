// Dispatch loading count: every master carton gets a QR label (shipment token + carton n of N).
// Security scans each carton as it goes into the truck; the tracker counts loaded vs total per order.
// Users: "gate" (security: scan only), "prakash" (packing setup + scan), "main" (Ravi: all).
const crypto = require("crypto");
const db = require("./db.js");
const call = async (b) => JSON.parse((await db.handler({ httpMethod: "POST", body: JSON.stringify(b) })).body || "{}");
const kvGet = async (k) => { const r = await call({ action: "getPortfolio", user: "main", key: k }); return r && r.data != null ? r.data : null; };
const kvSet = (k, d) => call({ action: "savePortfolio", user: "main", key: k, data: d });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
const shift = (ms) => new Date(Date.now() + 5.5 * 3600e3 + ms);
const todayIST = () => shift(0).toISOString().slice(0, 10);
const nowIST = () => shift(0).toISOString().slice(11, 16);
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const PREFIX = "ONAMC:";

async function shipments() { return ((await kvGet("logistics_v2")) || {}).shipments || []; }
async function loadLoads() { return (await kvGet("dispatch_loads")) || []; }
function cartonsFromItems(s) { const m = String(s || "").match(/TOTAL\s+(\d+)\s*(CTN|CARTON|CASE)/i); return m ? +m[1] : 0; }

// Pure: scan one carton. loads = array of {id, token, total, invoice, customer, orderNo, loaded:[{n,t,d,by}]}
function applyCarton(loads, token, n, N, by, now) {
  const L = loads.find((x) => x.token === String(token || "").trim());
  if (!L) return { ok: false, result: "unknown", msg: "Label not recognised" };
  if (!(n >= 1 && n <= L.total)) return { ok: false, result: "bad", msg: "Carton " + n + " is not part of this order" };
  if (L.loaded.some((x) => x.n === n)) return { ok: false, result: "dup", msg: "Carton " + n + "/" + L.total + " already loaded" };
  L.loaded.push({ n, t: now.hhmm, d: now.day, ts: now.ts, by });
  const left = L.total - L.loaded.length;
  return { ok: true, result: "LOADED", msg: "Carton " + n + "/" + L.total + " · " + (L.customer || "").slice(0, 40), loaded: L.loaded.length, total: L.total, done: left === 0 };
}
exports.applyCarton = applyCarton; exports.cartonsFromItems = cartonsFromItems;
exports.loadLoads = loadLoads; exports.shipments = shipments; exports.kvGet = kvGet; exports.kvSet = kvSet; exports.todayIST = todayIST;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const user = String(b.user || "").toLowerCase();
  if (!["gate", "prakash", "main"].includes(user)) return OK({ error: "pin" });
  const pins = (await kvGet("user_pins")) || {};
  if (!pins[user] || pins[user] !== hash(String(b.pin || ""))) return OK({ error: "pin" });
  const owner = user === "main", manager = user !== "gate";
  try {
    const today = todayIST();
    let loads = await loadLoads();
    if (b.action === "state") {
      const ships = await shipments();
      const rows = ships.filter((s) => s.id).slice(0, 200).map((s) => {
        const L = loads.find((x) => x.orderId === s.id);
        return { id: s.id, orderNo: s.orderNo || "", customer: s.customer || "", invoice: (L && L.invoice) || s.invoiceNo || "", suggested: cartonsFromItems(s.items), date: s.date || "",
          total: L ? L.total : null, loaded: L ? L.loaded.length : 0, done: !!(L && L.loaded.length === L.total && L.total > 0), lastDay: L && L.loaded.length ? L.loaded[L.loaded.length - 1].d : null };
      });
      return OK({ ok: true, owner, manager, today, rows: manager ? rows : rows.filter((r) => r.total != null && !r.done),
        scans: loads.flatMap((L) => L.loaded.map((x) => ({ orderId: L.orderId, invoice: L.invoice || L.orderNo, customer: L.customer, n: x.n, total: L.total, t: x.t, d: x.d, by: x.by }))).filter((x) => x.d === today).slice(-80).reverse() });
    }
    if (b.action === "setup") {        // Prakash/Ravi: create the labels for an order
      if (!manager) return OK({ error: "not allowed" });
      const ships = await shipments(), s = ships.find((x) => x.id === b.orderId);
      if (!s) return OK({ error: "order not found" });
      const N = Math.floor(+b.total || 0); if (N < 1 || N > 500) return OK({ error: "cartons?" });
      let L = loads.find((x) => x.orderId === s.id);
      if (L && L.loaded.length) return OK({ error: "Cartons already scanned — cannot change the count" });
      if (!L) { L = { id: "dl_" + Date.now().toString(36), orderId: s.id, token: crypto.randomBytes(10).toString("base64url"), loaded: [], created: today }; loads.push(L); }
      L.total = N; L.invoice = String(b.invoice || s.invoiceNo || "").trim().slice(0, 40); L.orderNo = s.orderNo || ""; L.customer = s.customer || "";
      await kvSet("dispatch_loads", loads);
      return OK({ ok: true, load: { id: L.id, total: L.total, invoice: L.invoice, orderNo: L.orderNo, customer: L.customer, token: L.token } });
    }
    if (b.action === "scan") {
      const raw = String(b.code || "").trim();
      let token = "", n = 0;
      if (raw.indexOf(PREFIX) === 0) { const p = raw.slice(PREFIX.length).split("|"); token = p[0]; n = +p[1]; }
      else { token = raw; n = +b.n || 0; }
      const r = applyCarton(loads, token, n, 0, user, { day: today, ts: Date.now(), hhmm: nowIST() });
      if (r.ok) await kvSet("dispatch_loads", loads);
      return OK(r);
    }
    if (b.action === "unload") {       // correct a wrong scan (Prakash or Ravi)
      if (!manager) return OK({ error: "not allowed" });
      const L = loads.find((x) => x.orderId === b.orderId); if (!L) return OK({ error: "not found" });
      const n = +b.n; L.loaded = L.loaded.filter((x) => x.n !== n);
      await kvSet("dispatch_loads", loads); return OK({ ok: true });
    }
    if (b.action === "labels") {       // full label set for printing (token included so the QR can be drawn)
      if (!manager) return OK({ error: "not allowed" });
      const L = loads.find((x) => x.orderId === b.orderId); if (!L) return OK({ error: "not set up" });
      return OK({ ok: true, load: { invoice: L.invoice, orderNo: L.orderNo, customer: L.customer, total: L.total, token: L.token, loaded: L.loaded.map((x) => x.n) } });
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e && e.message || e) }); }
};
