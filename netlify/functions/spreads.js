// API for the Spread Scanner page (owner PIN). Read-only market data.
const crypto = require("crypto");
const S = require("./spreads-lib.js");
const T = require("./tally.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type" };
const OK = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const hash = (p) => crypto.createHash("sha256").update("rkpin:" + p).digest("hex");
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return OK({ error: "bad request" }); }
  const pins = (await S.kvGet("user_pins")) || {};
  if (!pins.main) return OK({ error: "nopin" });
  if (!b.pin || pins.main !== hash(String(b.pin))) return OK({ error: "pin" });
  try {
    if (b.action === "session" && b.token) {   // share this browser's Zerodha login with the server
      const cur = (await S.kvGet("kite_session")) || {};
      if (cur.token !== b.token) await S.kvSet("kite_session", { token: String(b.token), at: new Date().toISOString(), from: "browser" });
      return OK({ ok: true });
    }
    if (b.action === "get") {
      const [st, screen, live, hist, sess] = await Promise.all([S.settings(), S.kvGet("spread_screen"), S.kvGet("spread_live"), S.kvGet("spread_screen_hist"), S.session()]);
      const day = await S.kvGet("spread_day_" + S.istDay());
      return OK({ ok: true, settings: st, cost: S.roundTripPct(st.tradeValue), session: !!sess,
        screen: screen ? Object.assign({}, screen, { rows: (screen.rows || []).slice(0, 150) }) : null, live, hist, day });
    }
    if (b.action === "saveSettings") {
      const cur = (await S.kvGet("spread_settings")) || {}, n = b.settings || {};
      const next = Object.assign({}, cur, {
        tradeValue: Math.max(5000, Number(n.tradeValue) || S.DEFAULTS.tradeValue), wideMultiple: Math.max(1, Number(n.wideMultiple) || S.DEFAULTS.wideMultiple),
        minPrice: Math.max(1, Number(n.minPrice) || S.DEFAULTS.minPrice), minVolume: Math.max(0, Number(n.minVolume) || 0),
        watchMode: n.watchMode === "custom" ? "custom" : "auto",
        custom: String(n.custom || "").split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 100) });
      await S.kvSet("spread_settings", next); return OK({ ok: true, settings: next });
    }
    if (b.action === "runNow") {
      const base = process.env.URL || "https://rk-tracker-v2.netlify.app", h = { "Content-Type": "application/json", "x-run-key": T.runKey() };
      await Promise.all([fetch(base + "/.netlify/functions/spread-screen-background", { method: "POST", headers: h, body: "{}" }).catch(() => {}),
        b.watch ? fetch(base + "/.netlify/functions/spread-watch-background", { method: "POST", headers: h, body: "{}" }).catch(() => {}) : null]);
      return OK({ ok: true });
    }
    return OK({ error: "unknown action" });
  } catch (e) { return OK({ error: String(e.message || e) }); }
};
