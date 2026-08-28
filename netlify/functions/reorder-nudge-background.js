// Scheduled function: runs daily at 10:00 AM IST (04:30 UTC).
//
// "Good company" reorder reminder — the goal is a gentle nudge, not a sales
// push. Rules, matching what was discussed and agreed:
//   - Only customers with 2+ past orders (proven repeat buyers, not one-time)
//   - Only fires once the customer's typical gap since last order suggests
//     they're due (default window: 45-60 days since last order — tunable
//     below via REORDER_MIN_DAYS / REORDER_MAX_DAYS)
//   - Never more than one marketing message (this OR a festival greeting)
//     per customer per 30 days — enforced via wa_marketing_log, shared with
//     the festival-greeting sender in whatsapp.js
//   - Opt-outs (wa_optouts, populated by whatsapp-webhook.js on "STOP") are
//     always skipped
//
// Storage: both wa_optouts and wa_marketing_log are single JSON objects in the
// existing kv table (owner='main'), keyed by phone. No new tables required.

const REORDER_MIN_DAYS = 45;
const REORDER_MAX_DAYS = 60;
const MARKETING_GAP_DAYS = 30;

export default async (req) => {
  const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
  const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
  const PHONE_NUMBER_ID = Netlify.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const ACCESS_TOKEN = Netlify.env.get("WHATSAPP_ACCESS_TOKEN");
  const BOT_TOKEN = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const CHAT_ID = Netlify.env.get("TELEGRAM_CHAT_ID");

  const summary = { checked: 0, eligible: 0, sent: 0, skippedOptOut: 0, skippedRecentMarketing: 0, skippedOutOfWindow: 0, errors: [] };

  if (!SUPABASE_URL || !SUPABASE_KEY || !PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "Missing required env vars", summary }), { status: 200 });
  }

  const sbHeaders = { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY };

  try {
    // 1. Pull all orders, group by phone (Supabase REST has no GROUP BY).
    const ordersRes = await fetch(SUPABASE_URL + "/rest/v1/orders?select=customer_phone,customer_name,created_log_ts&limit=5000", { headers: sbHeaders });
    const orders = await ordersRes.json();

    const byPhone = {};
    (orders || []).forEach(o => {
      const p = String(o.customer_phone || "").trim();
      if (!p) return;
      if (!byPhone[p]) byPhone[p] = { phone: p, name: o.customer_name || "", orders: [] };
      if (o.created_log_ts) byPhone[p].orders.push(new Date(o.created_log_ts).getTime());
    });

    const repeatCustomers = Object.values(byPhone).filter(c => c.orders.length >= 2);
    summary.checked = repeatCustomers.length;

    // 2. Opt-outs and recent marketing sends, fetched once up front. Both live
    //    in the existing kv table as single JSON objects keyed by phone —
    //    no dedicated tables, same store the rest of the tracker uses.
    const kvRead = async (key) => {
      try {
        const r = await fetch(SUPABASE_URL + "/rest/v1/kv?owner=eq.main&k=eq." + key + "&select=v", { headers: sbHeaders });
        const j = await r.json();
        return (Array.isArray(j) && j[0] && j[0].v) ? j[0].v : {};
      } catch (e) { return {}; }
    };

    const optOuts = await kvRead("wa_optouts");
    const marketingLog = await kvRead("wa_marketing_log");

    const now = Date.now();
    const sentPhones = [];
    const formatPhone = (p) => { let d = String(p).replace(/[^\d]/g, ""); if (d.length === 10) d = "91" + d; return d; };

    for (const c of repeatCustomers) {
      const lastOrderMs = Math.max(...c.orders);
      const daysSinceOrder = (now - lastOrderMs) / 86400000;

      if (daysSinceOrder < REORDER_MIN_DAYS || daysSinceOrder > REORDER_MAX_DAYS) {
        summary.skippedOutOfWindow++;
        continue;
      }
      if (optOuts[c.phone]) {
        summary.skippedOptOut++;
        continue;
      }
      const lastMarketing = marketingLog[c.phone];
      if (lastMarketing && (now - new Date(lastMarketing).getTime()) / 86400000 < MARKETING_GAP_DAYS) {
        summary.skippedRecentMarketing++;
        continue;
      }

      summary.eligible++;

      try {
        const payload = {
          messaging_product: "whatsapp",
          to: formatPhone(c.phone),
          type: "template",
          template: {
            name: "reorder_nudge",
            language: { code: "en" },
            components: [{ type: "body", parameters: [{ type: "text", text: c.name || "there" }] }]
          }
        };
        const r = await fetch("https://graph.facebook.com/v21.0/" + PHONE_NUMBER_ID + "/messages", {
          method: "POST",
          headers: { "Authorization": "Bearer " + ACCESS_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const j = await r.json();
        if (j.error) {
          summary.errors.push({ phone: c.phone, error: j.error.message || j.error });
          continue;
        }
        summary.sent++;
        sentPhones.push(c.phone);
      } catch (e) {
        summary.errors.push({ phone: c.phone, error: String(e && e.message ? e.message : e) });
      }
    }
    // One write for the whole run, so the 30-day cap holds without N racing
    // read-modify-write cycles against the same kv row.
    if (sentPhones.length) {
      const stamp = new Date().toISOString();
      sentPhones.forEach(p => { marketingLog[p] = stamp; });
      await fetch(SUPABASE_URL + "/rest/v1/kv?on_conflict=owner,k", {
        method: "POST",
        headers: { ...sbHeaders, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({ owner: "main", k: "wa_marketing_log", v: marketingLog })
      });
    }
  } catch (e) {
    summary.errors.push({ fatal: String(e && e.message ? e.message : e) });
  }

  // Quiet Telegram summary so this isn't a silent background job.
  if (BOT_TOKEN && CHAT_ID && (summary.sent > 0 || summary.errors.length > 0)) {
    const text = "\uD83D\uDD01 Reorder nudge run: " + summary.sent + " sent, " +
      summary.eligible + " eligible, " + summary.checked + " repeat customers checked" +
      (summary.errors.length ? ", " + summary.errors.length + " errors" : "");
    fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, summary }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = {
  path: "/.netlify/functions/reorder-nudge-background"
};
