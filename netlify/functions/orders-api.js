// ============================================================================
//  ONAM ORDERS — management API for RK Tracker v2
//  Reads and updates the `orders` / `order_lines` tables in Supabase.
//  Uses raw https + Supabase REST, matching db.js, so no new npm dependency.
//
//  Actions: list | lines | updateStatus | analytics
// ============================================================================

const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || "";
const BOT          = process.env.TELEGRAM_BOT_TOKEN || "";
const OWNER_CHAT   = process.env.TELEGRAM_OWNER_CHAT_ID || "-5372910186";

const H = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};

const OK   = (obj) => ({ statusCode: 200, headers: H, body: JSON.stringify(obj) });
const FAIL = (msg, code) => ({ statusCode: code || 500, headers: H, body: JSON.stringify({ ok: false, error: String(msg) }) });

// ---------- Supabase REST helper ----------
function sb(method, path, bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + path);
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = Object.assign({
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json"
    }, extraHeaders || {});
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method,
      headers: headers
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Supabase timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------- Telegram helper (never throws) ----------
function tgSend(text) {
  return new Promise((resolve) => {
    if (!BOT) return resolve({ ok: false, error: "TELEGRAM_BOT_TOKEN not set" });
    const payload = JSON.stringify({
      chat_id: String(OWNER_CHAT),
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false, raw: d }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: String(e) }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: "telegram timeout" }); });
    req.write(payload);
    req.end();
  });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function n(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }

// ============================================================================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  if (!SUPABASE_URL || !SERVICE_KEY) return FAIL("Supabase not configured on this site");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return FAIL("invalid JSON", 400); }

  const action = body.action || "list";

  try {
    // ---------------------------------------------------------------- LIST
    if (action === "list") {
      let q = "/rest/v1/orders?select=*&order=created_log_ts.desc.nullslast&limit=" + (body.limit || 500);
      if (body.status && body.status !== "All") {
        q += "&status=eq." + encodeURIComponent(body.status);
      }
      const r = await sb("GET", q);
      if (r.status >= 300) return FAIL("Supabase list failed: " + JSON.stringify(r.body));
      return OK({ ok: true, orders: r.body || [], count: (r.body || []).length });
    }

    // --------------------------------------------------------------- LINES
    if (action === "lines") {
      if (!body.invoiceNo) return FAIL("invoiceNo required", 400);
      const q = "/rest/v1/order_lines?select=*&invoice_no=eq." + encodeURIComponent(body.invoiceNo);
      const r = await sb("GET", q);
      if (r.status >= 300) return FAIL("Supabase lines failed: " + JSON.stringify(r.body));
      return OK({ ok: true, lines: r.body || [] });
    }

    // -------------------------------------------------------- UPDATE STATUS
    if (action === "updateStatus") {
      const inv = body.invoiceNo;
      if (!inv) return FAIL("invoiceNo required", 400);

      const nowIso = new Date().toISOString();
      const patch = { updated_at: nowIso, updated_by: body.user || "main" };

      if (body.status)    patch.status = body.status;
      if (body.tracking !== undefined) patch.tracking_number = body.tracking;
      if (body.courier !== undefined)  patch.courier = body.courier;
      if (body.notes !== undefined)    patch.notes = body.notes;

      // Stamp the fulfilment milestone that matches the new status
      if (body.status === "Dispatched") patch.dispatched_at = nowIso;
      if (body.status === "Delivered")  patch.delivered_at  = nowIso;
      if (body.status === "Returned")   patch.returned_at   = nowIso;
      if (body.status === "Refunded")   patch.refunded_at   = nowIso;

      const r = await sb(
        "PATCH",
        "/rest/v1/orders?id=eq." + encodeURIComponent(inv),
        patch,
        { "Prefer": "return=representation" }
      );
      if (r.status >= 300) return FAIL("Supabase update failed: " + JSON.stringify(r.body));

      const row = Array.isArray(r.body) && r.body.length ? r.body[0] : null;

      // Telegram alert on dispatch — the one status change that needs a push
      let tgResult = null;
      if (body.status === "Dispatched" && row) {
        const lines = [];
        lines.push("\uD83D\uDE9A <b>DISPATCHED</b>");
        lines.push("");
        lines.push("<b>" + esc(row.id) + "</b>");
        lines.push(esc(row.customer_name || "-") + "  \u00B7  Rs." + n(row.grand_total));
        if (row.customer_city) lines.push(esc(row.customer_city) + " - " + esc(row.customer_pin || ""));
        if (row.tracking_number) {
          lines.push("");
          lines.push("Tracking: <code>" + esc(row.tracking_number) + "</code>");
          if (row.courier) lines.push("Courier: " + esc(row.courier));
        }
        lines.push("");
        lines.push("<i>Marked by " + esc(body.user || "main") + "</i>");
        tgResult = await tgSend(lines.join("\n"));
      }

      return OK({
        ok: true,
        order: row,
        telegram: tgResult ? (tgResult.ok ? "sent" : ("failed: " + (tgResult.description || tgResult.error || "unknown"))) : null
      });
    }

    // ----------------------------------------------------------- ANALYTICS
    if (action === "analytics") {
      const r = await sb("GET", "/rest/v1/orders?select=*&limit=5000");
      if (r.status >= 300) return FAIL("Supabase analytics failed: " + JSON.stringify(r.body));
      const rows = r.body || [];

      const rl = await sb("GET", "/rest/v1/order_lines?select=item_name,pack_size,qty,line_total&limit=20000");
      const lines = (rl.status < 300 && rl.body) ? rl.body : [];

      // --- Status counts
      const byStatus = {};
      rows.forEach(o => {
        const s = o.status || "Pending";
        byStatus[s] = (byStatus[s] || 0) + 1;
      });

      // --- Revenue. Excludes refunded orders: money that came back is not revenue.
      let revenue = 0, refunded = 0, orderCount = 0;
      rows.forEach(o => {
        const amt = n(o.grand_total);
        if (o.status === "Refunded") { refunded += amt; return; }
        revenue += amt;
        orderCount++;
      });
      const avgOrder = orderCount ? Math.round(revenue / orderCount * 100) / 100 : 0;

      // --- Daily series (last 30 days) keyed by ISO date
      const daily = {};
      rows.forEach(o => {
        const ts = o.created_log_ts;
        if (!ts) return;
        const d = String(ts).substring(0, 10);
        if (!daily[d]) daily[d] = { date: d, orders: 0, revenue: 0 };
        daily[d].orders++;
        if (o.status !== "Refunded") daily[d].revenue += n(o.grand_total);
      });
      const dailyArr = Object.keys(daily).sort().slice(-30).map(k => daily[k]);

      // --- Top products by qty and by value
      const prod = {};
      lines.forEach(l => {
        const key = (l.item_name || "?") + (l.pack_size ? " (" + l.pack_size + ")" : "");
        if (!prod[key]) prod[key] = { name: key, qty: 0, value: 0 };
        prod[key].qty += n(l.qty);
        prod[key].value += n(l.line_total);
      });
      const topProducts = Object.values(prod).sort((a, b) => b.qty - a.qty).slice(0, 15);

      // --- Repeat customers, keyed on phone (the one field always present)
      const byPhone = {};
      rows.forEach(o => {
        const p = String(o.customer_phone || "").trim();
        if (!p) return;
        if (!byPhone[p]) byPhone[p] = { phone: p, name: o.customer_name || "", orders: 0, value: 0 };
        byPhone[p].orders++;
        if (o.status !== "Refunded") byPhone[p].value += n(o.grand_total);
      });
      const customers = Object.values(byPhone).sort((a, b) => b.value - a.value);
      const repeatCustomers = customers.filter(c => c.orders > 1);

      // --- Fulfilment lag: hours from order to dispatch
      let lagSum = 0, lagCount = 0, slowest = null;
      rows.forEach(o => {
        if (!o.created_log_ts || !o.dispatched_at) return;
        const t0 = new Date(o.created_log_ts).getTime();
        const t1 = new Date(o.dispatched_at).getTime();
        if (isNaN(t0) || isNaN(t1) || t1 < t0) return;
        const hrs = (t1 - t0) / 3600000;
        lagSum += hrs; lagCount++;
        if (!slowest || hrs > slowest.hours) slowest = { id: o.id, hours: Math.round(hrs * 10) / 10 };
      });
      const avgLagHours = lagCount ? Math.round(lagSum / lagCount * 10) / 10 : null;

      // --- Pending ageing: how long unshipped orders have been waiting
      const nowMs = Date.now();
      const pendingAgeing = rows
        .filter(o => (o.status || "Pending") === "Pending" && o.created_log_ts)
        .map(o => ({
          id: o.id,
          name: o.customer_name || "",
          amount: n(o.grand_total),
          hours: Math.round((nowMs - new Date(o.created_log_ts).getTime()) / 3600000 * 10) / 10
        }))
        .filter(x => !isNaN(x.hours))
        .sort((a, b) => b.hours - a.hours);

      // --- State split, useful for courier and GST planning
      const byState = {};
      rows.forEach(o => {
        const s = (o.customer_state || "Unknown").trim().toUpperCase();
        if (!byState[s]) byState[s] = { state: s, orders: 0, revenue: 0 };
        byState[s].orders++;
        if (o.status !== "Refunded") byState[s].revenue += n(o.grand_total);
      });
      const states = Object.values(byState).sort((a, b) => b.revenue - a.revenue);

      // --- GST split for the accountant
      let cgstTotal = 0, sgstTotal = 0, igstTotal = 0, taxableTotal = 0;
      rows.forEach(o => {
        if (o.status === "Refunded") return;
        cgstTotal += n(o.cgst); sgstTotal += n(o.sgst);
        igstTotal += n(o.igst); taxableTotal += n(o.taxable_value);
      });

      return OK({
        ok: true,
        analytics: {
          totalOrders: rows.length,
          byStatus: byStatus,
          revenue: Math.round(revenue * 100) / 100,
          refundedValue: Math.round(refunded * 100) / 100,
          avgOrder: avgOrder,
          daily: dailyArr,
          topProducts: topProducts,
          uniqueCustomers: customers.length,
          repeatCustomers: repeatCustomers.length,
          topCustomers: customers.slice(0, 10),
          avgLagHours: avgLagHours,
          slowestDispatch: slowest,
          pendingAgeing: pendingAgeing.slice(0, 20),
          states: states,
          gst: {
            taxable: Math.round(taxableTotal * 100) / 100,
            cgst: Math.round(cgstTotal * 100) / 100,
            sgst: Math.round(sgstTotal * 100) / 100,
            igst: Math.round(igstTotal * 100) / 100
          }
        }
      });
    }

    return FAIL("unknown action: " + action, 400);

  } catch (err) {
    return FAIL(err && err.message ? err.message : err);
  }
};
