// Label printing endpoint.
//  · Mac Mini label agent (x-bridge-key): "pending" → jobs to print, "ack" → result.
//  · Tracker pages (user + PIN): "print" a carton set / worker card / test label on the Zebra, "status".
const crypto = require("crypto");
const W = require("./wa-lib.js");
const LB = require("./label-lib.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type, x-bridge-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const OK = (o, c) => ({ statusCode: c || 200, headers: H, body: JSON.stringify(o) });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");

// Print station key: the WhatsApp bridge key (Mac Mini) or the label-only key (Prakash's Windows PC).
let _lk = null;
async function stationOk(event) {
  if (await W.bridgeOk(event)) return true;
  if (_lk == null) { const r = await W.sb("GET", "/rest/v1/wa_bridge_secret?id=eq.2&select=secret"); _lk = (r && r[0] && r[0].secret) || ""; }
  const h = event.headers || {}, got = String(h["x-label-key"] || h["X-Label-Key"] || h["x-bridge-key"] || "");
  return !!_lk && got.length === _lk.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(_lk));
}
async function pinOk(user, pin) {
  const pins = (await W.kvGet("user_pins")) || {};
  return !!(pins[user] && pins[user] === hash(String(pin || "")));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return OK({});
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  try {
    // ---------- Mac Mini agent ----------
    if (b.action === "pending" || b.action === "ack") {
      if (!(await stationOk(event))) return OK({ ok: false, error: "key required" }, 403);
      if (b.action === "pending") {
        const agent = { lastSeen: new Date().toISOString(), printer: String(b.printer || ""), state: String(b.state || "").slice(0, 300),
          host: String(b.host || "").slice(0, 60), version: String(b.version || "") };
        const prev = (await W.kvGet("label_agent")) || {};
        // a station without the Zebra must not hide the one that has it
        if (agent.printer || !prev.printer || prev.host === agent.host || Date.now() - Date.parse(prev.lastSeen || 0) > 3 * 60e3) await W.kvSet("label_agent", agent);
        if (!agent.printer) return OK({ ok: true, jobs: [], note: "no Zebra printer found on this computer" });
        const jobs = await W.sb("GET", "/rest/v1/label_jobs?status=eq.pending&order=id.asc&limit=10&select=id,kind,title,n,zpl");
        return OK({ ok: true, jobs: jobs || [] });
      }
      const id = +b.id; if (!id) return OK({ ok: false, error: "id?" });
      const rows = await W.sb("GET", "/rest/v1/label_jobs?id=eq." + id + "&select=*");
      const j = rows && rows[0]; if (!j) return OK({ ok: false, error: "not found" });
      if (b.ok) {
        await W.sb("PATCH", "/rest/v1/label_jobs?id=eq." + id, { status: "done", printed_at: new Date().toISOString(), error: null });
        if (j.notify && j.notify.to && j.notify.text) await W.send(j.notify.to, j.notify.text, { kind: "label" });
      } else {
        const tries = (j.tries || 0) + 1, err = String(b.err || "print failed").slice(0, 300);
        await W.sb("PATCH", "/rest/v1/label_jobs?id=eq." + id, { status: tries >= 3 ? "error" : "pending", tries, error: err });
        if (tries >= 3) await W.send(["ravi", "prakash"], "⚠️ *Label printer problem*\n" + j.title + " (" + j.n + " labels) did not print.\n" + err +
          "\nCheck the Zebra: labels, ribbon, cable, light. Then reply here *reprint labels* or tap Print again in the tracker.", { kind: "label" });
      }
      return OK({ ok: true });
    }

    // ---------- tracker pages ----------
    const user = String(b.user || "").toLowerCase();
    if (!(await pinOk(user, b.pin))) return OK({ error: "pin" });
    if (b.action === "status") {
      const agent = (await W.kvGet("label_agent")) || {};
      const pend = (await W.sb("GET", "/rest/v1/label_jobs?status=eq.pending&select=id,title,n,created_at&order=id.asc&limit=20")) || [];
      return OK({ ok: true, agent, pending: pend });
    }
    if (b.action === "print") {
      if (b.what === "carton") {
        if (!["main", "prakash"].includes(user)) return OK({ error: "not allowed" });
        const loads = (await W.kvGet("dispatch_loads")) || [];
        const L = loads.find((x) => x.orderId === b.orderId); if (!L || !(L.total > 0)) return OK({ error: "Set the carton count first" });
        const only = Array.isArray(b.cartons) && b.cartons.length ? b.cartons.map(Number).filter((n) => n >= 1 && n <= L.total) : null;
        const j = await LB.queueCartons(L, { to: ["prakash"], text: "🏷️ " + (only ? only.length : L.total) + " carton labels printed (reprint) – " + L.customer + " · Inv " + (L.invoice || "-") }, only);
        return OK({ ok: true, job: j && j.id });
      }
      if (b.what === "card") {
        if (user !== "main") return OK({ error: "owner only" });
        const ws = (await W.kvGet("gate_workers")) || [];
        const w = ws.find((x) => x.id === b.workerId); if (!w) return OK({ error: "worker not found" });
        const j = await LB.queueCard(w, { to: ["ravi"], text: "🪪 ID card printed – " + w.name });
        return OK({ ok: true, job: j && j.id });
      }
      if (b.what === "test") {
        const j = await LB.queue("test", null, "Test label", [LB.testZpl("Test from " + user + " " + W.istNow().toISOString().slice(11, 16))], null);
        return OK({ ok: true, job: j && j.id });
      }
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e && e.message || e) }); }
};
