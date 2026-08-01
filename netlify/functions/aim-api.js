// ============================================================================
//  AIM ENGINE  —  Robert Lichello Automatic Investment Management
//
//  Rules implemented exactly as published:
//    MV     = shares x price
//    SAFE   = 10% of MV
//    Advice = PC - MV
//    BUY    when (Advice - SAFE) > 0, for that amount
//    SELL   when (MV - PC - SAFE) > 0, for that amount
//    PC rises by HALF of every buy. PC is NEVER reduced by a sale.
//
//  The ledger is append-only. Portfolio Control is cumulative, so a single
//  missing or edited transaction corrupts every later signal permanently.
//  Corrections are entered as ADJUST rows, never by rewriting history.
//
//  Raw https + Supabase REST, matching db.js. No npm dependency.
// ============================================================================

const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || "";

const H = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};

const OK   = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const FAIL = (m, c) => ({ statusCode: c || 500, headers: H, body: JSON.stringify({ ok: false, error: String(m) }) });

function sb(method, path, bodyObj, extra) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + path);
    const bs = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = Object.assign({
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json"
    }, extra || {});
    if (bs) headers["Content-Length"] = Buffer.byteLength(bs);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        let parsed = null;
        try { parsed = d ? JSON.parse(d) : null; } catch (e) { parsed = d; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Supabase timeout")); });
    if (bs) req.write(bs);
    req.end();
  });
}

const n  = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const r2 = (v) => Math.round(n(v) * 100) / 100;

// ---------------------------------------------------------------- AIM core
// Single source of truth for the arithmetic. Used by both the live signal and
// the audit, so the two can never drift apart.
function aimSignal(shares, price, pc) {
  const mv     = n(shares) * n(price);
  const safe   = 0.10 * mv;
  const advice = n(pc) - mv;

  let action = "HOLD", amount = 0, qty = 0;

  if (advice - safe > 0) {
    action = "BUY";
    amount = advice - safe;
  } else if (mv - n(pc) - safe > 0) {
    action = "SELL";
    amount = mv - n(pc) - safe;
  }
  if (amount > 0 && n(price) > 0) qty = Math.floor(amount / n(price));
  // A signal that cannot buy or sell at least one whole share is not actionable.
  if (qty < 1) { action = "HOLD"; amount = 0; qty = 0; }

  return {
    mv: r2(mv), safe: r2(safe), advice: r2(advice),
    action, amount: r2(amount), qty
  };
}

// Rebuild Portfolio Control from the full ledger, from first principles.
// This is what makes the stored value checkable rather than merely trusted.
function replayLedger(txns) {
  const rows = txns.slice().sort((a, b) => {
    const d = String(a.txn_date).localeCompare(String(b.txn_date));
    return d !== 0 ? d : (a.id - b.id);
  });

  let pc = 0, shares = 0, cost = 0, first = true, realised = 0, costsPaid = 0;
  const steps = [];

  rows.forEach(t => {
    const act = String(t.action || "").toUpperCase();
    const amt = n(t.amount);
    const pcBefore = pc;
    costsPaid += n(t.costs);

    if (act === "BUY") {
      // The opening purchase sets PC. Every later buy adds half its value.
      pc = first ? amt : pc + amt / 2;
      shares += n(t.shares);
      cost += amt + n(t.costs);
      first = false;
    } else if (act === "SELL") {
      // PC deliberately unchanged — this asymmetry is the ratchet.
      const sold = n(t.shares);
      const avg = shares > 0 ? cost / shares : 0;
      realised += (n(t.price) - avg) * sold - n(t.costs);
      shares -= sold;
      cost = shares > 0 ? avg * shares : 0;
    } else if (act === "ADJUST") {
      // Explicit correction, recorded rather than hidden.
      if (t.pc_after !== null && t.pc_after !== undefined) pc = n(t.pc_after);
      shares += n(t.shares);
    }

    steps.push({
      id: t.id, date: t.txn_date, action: act, shares: n(t.shares),
      price: n(t.price), amount: amt, pcBefore: r2(pcBefore), pcAfter: r2(pc)
    });
  });

  return { pc: r2(pc), shares: r2(shares), cost: r2(cost), realised: r2(realised), costsPaid: r2(costsPaid), steps };
}

// ============================================================================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  if (!SUPABASE_URL || !SERVICE_KEY) return FAIL("Supabase not configured on this site");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return FAIL("invalid JSON", 400); }

  const action = body.action || "dashboard";
  const book   = (body.book || "INDIA").toUpperCase();

  try {
    // ------------------------------------------------------------ DASHBOARD
    if (action === "dashboard") {
      const hr = await sb("GET", "/rest/v1/aim_holdings?select=*&book=eq." + encodeURIComponent(book) + "&order=symbol.asc");
      if (hr.status >= 300) return FAIL("holdings read failed: " + JSON.stringify(hr.body));
      const holdings = hr.body || [];

      const cr = await sb("GET", "/rest/v1/aim_cash?select=*&book=eq." + encodeURIComponent(book));
      const cash = (cr.status < 300 && cr.body && cr.body.length) ? n(cr.body[0].cash) : 0;

      const withSignals = holdings.map(h => {
        const sig = aimSignal(h.shares, h.last_price, h.portfolio_control);
        return Object.assign({}, h, { signal: sig });
      });

      const stockValue = withSignals.reduce((s, h) => s + h.signal.mv, 0);
      const totalPC    = withSignals.reduce((s, h) => s + n(h.portfolio_control), 0);
      const invested   = withSignals.reduce((s, h) => s + n(h.shares) * n(h.avg_cost), 0);
      const total      = stockValue + cash;

      return OK({
        ok: true, book, cash: r2(cash), holdings: withSignals,
        summary: {
          stockValue: r2(stockValue),
          cash: r2(cash),
          total: r2(total),
          cashPct: total > 0 ? r2(cash / total * 100) : 0,
          totalPC: r2(totalPC),
          invested: r2(invested),
          unrealised: r2(stockValue - invested),
          unrealisedPct: invested > 0 ? r2((stockValue - invested) / invested * 100) : 0,
          buySignals: withSignals.filter(h => h.signal.action === "BUY").length,
          sellSignals: withSignals.filter(h => h.signal.action === "SELL").length
        }
      });
    }

    // ------------------------------------------------------------ SET CASH
    if (action === "setCash") {
      const amt = n(body.cash);
      const r = await sb("POST", "/rest/v1/aim_cash",
        { book, cash: amt, updated_at: new Date().toISOString() },
        { "Prefer": "resolution=merge-duplicates,return=representation" });
      if (r.status >= 300) return FAIL("cash update failed: " + JSON.stringify(r.body));
      return OK({ ok: true, cash: r2(amt) });
    }

    // ------------------------------------------------------- ADD / OPEN HOLDING
    // The opening buy also sets Portfolio Control, so it goes through the ledger.
    if (action === "openPosition") {
      const symbol = String(body.symbol || "").trim().toUpperCase();
      if (!symbol) return FAIL("symbol required", 400);
      const shares = n(body.shares), price = n(body.price), costs = n(body.costs);
      if (shares <= 0 || price <= 0) return FAIL("shares and price must be positive", 400);

      const amount = shares * price;
      const id = book + "|" + symbol;
      const today = body.date || new Date().toISOString().slice(0, 10);

      const ex = await sb("GET", "/rest/v1/aim_holdings?select=id&id=eq." + encodeURIComponent(id));
      if (ex.status < 300 && ex.body && ex.body.length) {
        return FAIL("position already open for " + symbol + " — use recordTrade instead", 400);
      }

      const cr = await sb("GET", "/rest/v1/aim_cash?select=*&book=eq." + encodeURIComponent(book));
      const cashNow = (cr.status < 300 && cr.body && cr.body.length) ? n(cr.body[0].cash) : 0;
      const cashAfter = cashNow - amount - costs;

      const hr = await sb("POST", "/rest/v1/aim_holdings", {
        id, book, symbol, name: body.name || symbol,
        shares, avg_cost: r2((amount + costs) / shares),
        portfolio_control: r2(amount),
        last_price: price, last_review: today, active: true,
        updated_at: new Date().toISOString()
      }, { "Prefer": "return=representation" });
      if (hr.status >= 300) return FAIL("could not open position: " + JSON.stringify(hr.body));

      await sb("POST", "/rest/v1/aim_transactions", {
        book, symbol, txn_date: today, action: "BUY",
        shares, price, amount: r2(amount), costs: r2(costs),
        pc_before: 0, pc_after: r2(amount), cash_after: r2(cashAfter),
        note: body.note || "opening purchase — sets Portfolio Control"
      });

      await sb("POST", "/rest/v1/aim_cash",
        { book, cash: r2(cashAfter), updated_at: new Date().toISOString() },
        { "Prefer": "resolution=merge-duplicates" });

      return OK({ ok: true, opened: symbol, pc: r2(amount), cash: r2(cashAfter) });
    }

    // ------------------------------------------------------------ PRICE UPDATE
    if (action === "updatePrice") {
      const id = book + "|" + String(body.symbol || "").trim().toUpperCase();
      const r = await sb("PATCH", "/rest/v1/aim_holdings?id=eq." + encodeURIComponent(id),
        { last_price: n(body.price), last_review: body.date || new Date().toISOString().slice(0, 10),
          updated_at: new Date().toISOString() },
        { "Prefer": "return=representation" });
      if (r.status >= 300) return FAIL("price update failed: " + JSON.stringify(r.body));
      const row = Array.isArray(r.body) && r.body.length ? r.body[0] : null;
      return OK({ ok: true, holding: row, signal: row ? aimSignal(row.shares, row.last_price, row.portfolio_control) : null });
    }

    // ------------------------------------------------------------ RECORD TRADE
    if (action === "recordTrade") {
      const symbol = String(body.symbol || "").trim().toUpperCase();
      const id = book + "|" + symbol;
      const act = String(body.tradeAction || "").toUpperCase();
      if (["BUY", "SELL"].indexOf(act) === -1) return FAIL("tradeAction must be BUY or SELL", 400);

      const shares = n(body.shares), price = n(body.price), costs = n(body.costs);
      if (shares <= 0 || price <= 0) return FAIL("shares and price must be positive", 400);
      const amount = shares * price;
      const today = body.date || new Date().toISOString().slice(0, 10);

      const hr = await sb("GET", "/rest/v1/aim_holdings?select=*&id=eq." + encodeURIComponent(id));
      if (hr.status >= 300 || !hr.body || !hr.body.length) return FAIL("no open position for " + symbol, 400);
      const h = hr.body[0];

      if (act === "SELL" && shares > n(h.shares)) {
        return FAIL("cannot sell " + shares + " — only " + h.shares + " held", 400);
      }

      const pcBefore = n(h.portfolio_control);
      // The whole ratchet lives in this one line.
      const pcAfter  = act === "BUY" ? pcBefore + amount / 2 : pcBefore;

      const newShares = act === "BUY" ? n(h.shares) + shares : n(h.shares) - shares;
      const oldCost   = n(h.shares) * n(h.avg_cost);
      const newAvg    = act === "BUY"
        ? (newShares > 0 ? (oldCost + amount + costs) / newShares : 0)
        : n(h.avg_cost);

      const cr = await sb("GET", "/rest/v1/aim_cash?select=*&book=eq." + encodeURIComponent(book));
      const cashNow = (cr.status < 300 && cr.body && cr.body.length) ? n(cr.body[0].cash) : 0;
      const cashAfter = act === "BUY" ? cashNow - amount - costs : cashNow + amount - costs;

      if (act === "BUY" && cashAfter < 0) {
        return FAIL("insufficient cash: need " + r2(amount + costs) + ", have " + r2(cashNow), 400);
      }

      await sb("PATCH", "/rest/v1/aim_holdings?id=eq." + encodeURIComponent(id), {
        shares: r2(newShares), avg_cost: r2(newAvg), portfolio_control: r2(pcAfter),
        last_price: price, last_review: today, active: newShares > 0,
        updated_at: new Date().toISOString()
      });

      await sb("POST", "/rest/v1/aim_transactions", {
        book, symbol, txn_date: today, action: act,
        shares, price, amount: r2(amount), costs: r2(costs),
        pc_before: r2(pcBefore), pc_after: r2(pcAfter), cash_after: r2(cashAfter),
        note: body.note || ""
      });

      await sb("POST", "/rest/v1/aim_cash",
        { book, cash: r2(cashAfter), updated_at: new Date().toISOString() },
        { "Prefer": "resolution=merge-duplicates" });

      return OK({
        ok: true, symbol, action: act,
        pcBefore: r2(pcBefore), pcAfter: r2(pcAfter),
        shares: r2(newShares), cash: r2(cashAfter),
        signal: aimSignal(newShares, price, pcAfter)
      });
    }

    // ---------------------------------------------------------------- LEDGER
    if (action === "ledger") {
      let q = "/rest/v1/aim_transactions?select=*&book=eq." + encodeURIComponent(book);
      if (body.symbol) q += "&symbol=eq." + encodeURIComponent(String(body.symbol).toUpperCase());
      q += "&order=txn_date.desc,id.desc&limit=" + (body.limit || 300);
      const r = await sb("GET", q);
      if (r.status >= 300) return FAIL("ledger read failed: " + JSON.stringify(r.body));
      return OK({ ok: true, transactions: r.body || [] });
    }

    // ----------------------------------------------------------------- AUDIT
    // Recompute PC from the full ledger and compare against what is stored.
    if (action === "audit") {
      const hr = await sb("GET", "/rest/v1/aim_holdings?select=*&book=eq." + encodeURIComponent(book));
      if (hr.status >= 300) return FAIL("holdings read failed");
      const holdings = hr.body || [];

      const tr = await sb("GET", "/rest/v1/aim_transactions?select=*&book=eq." + encodeURIComponent(book) + "&order=txn_date.asc,id.asc&limit=5000");
      const txns = (tr.status < 300 && tr.body) ? tr.body : [];

      const results = holdings.map(h => {
        const mine = txns.filter(t => String(t.symbol).toUpperCase() === String(h.symbol).toUpperCase());
        const rep = replayLedger(mine);
        const pcDiff = r2(rep.pc - n(h.portfolio_control));
        const shDiff = r2(rep.shares - n(h.shares));
        return {
          symbol: h.symbol,
          storedPC: r2(h.portfolio_control), ledgerPC: rep.pc, pcDiff,
          storedShares: r2(h.shares), ledgerShares: rep.shares, shDiff,
          txnCount: mine.length,
          ok: Math.abs(pcDiff) < 1 && Math.abs(shDiff) < 0.01,
          steps: rep.steps.slice(-10)
        };
      });

      const bad = results.filter(r => !r.ok);
      return OK({
        ok: true, book,
        clean: bad.length === 0,
        checked: results.length,
        mismatches: bad.length,
        results
      });
    }

    // ------------------------------------------------------- CLOSE / DEACTIVATE
    if (action === "closePosition") {
      const symbol = String(body.symbol || "").trim().toUpperCase();
      const id = book + "|" + symbol;
      const r = await sb("PATCH", "/rest/v1/aim_holdings?id=eq." + encodeURIComponent(id),
        { active: false, updated_at: new Date().toISOString() });
      if (r.status >= 300) {
        console.log("closePosition FAIL: id=" + id + " status=" + r.status + " body=" + JSON.stringify(r.body));
        return FAIL("close failed: " + (r.body && r.body.message ? r.body.message : "status " + r.status));
      }
      return OK({ ok: true });
    }

    // ------------------------------------------------------------- GATE CHECK
    // Stage 1 of the manual, applied to numbers entered by hand. Returns a
    // pass/fail per rule — deliberately not a score, so nothing compensates.
    if (action === "gateCheck") {
      const d = body.data || {};

      // Crypto has no earnings, no balance sheet and no auditor, so the equity
      // gate is meaningless here. A different gate applies, built on survival
      // through drawdown cycles rather than on financial statements.
      if (book === "CRYPTO") {
        const cc = [];
        const cadd = (rule, pass, detail) => cc.push({ rule, pass: !!pass, detail });
        const sym = String(d.symbol || "").toUpperCase();

        cadd("Bitcoin or Ethereum only", sym === "BTC" || sym === "ETH",
             sym || "not set");
        cadd("At least 8 years of price history", n(d.yearsLive) >= 8,
             n(d.yearsLive) + " years");
        cadd("Survived and recovered from at least 2 drawdowns over 50%",
             n(d.majorRecoveries) >= 2, n(d.majorRecoveries) + " recoveries");
        cadd("Top 2 by market cap", n(d.rank) > 0 && n(d.rank) <= 2,
             "rank " + n(d.rank));
        cadd("Listed on a regulated Indian exchange", !!d.indianExchange,
             d.indianExchange ? "yes" : "no");
        cadd("Daily volume above USD 1 billion", n(d.volume) >= 1000,
             "$" + n(d.volume) + "m");
        cadd("Position sized so a 70% fall is survivable",
             !!d.drawdownAccepted,
             d.drawdownAccepted ? "acknowledged" : "NOT acknowledged");

        const failed2 = cc.filter(c => !c.pass);
        return OK({
          ok: true,
          passed: failed2.length === 0,
          failedCount: failed2.length,
          checks: cc,
          drawdownBand: "Crypto is judged on cycle survival, not on distance from the high. "
                      + "Bitcoin has repeatedly fallen 70-80% and recovered; the 40% equity "
                      + "rule would exclude it almost permanently and is not applied here.",
          taxWarning: "Every sale is taxed at a flat 31.2% with no loss offset, plus 1% TDS. "
                    + "AIM trades often, so model the tax before acting on a sell signal."
        });
      }

      const isIndia = book === "INDIA";
      const checks = [];
      const add = (rule, pass, detail) => checks.push({ rule, pass: !!pass, detail });

      add("Profitable in 2 of last 3 years", d.profitableYears >= 2,
          (d.profitableYears || 0) + " of 3");
      add("Positive operating margin", n(d.opMargin) > 0, n(d.opMargin) + "%");
      add("ROE at least 6% in last 4 years", n(d.bestRoe) >= 6, n(d.bestRoe) + "%");
      add("Debt to equity below 1.0", n(d.debtEquity) < 1, String(n(d.debtEquity)));
      add("Interest cover at least 2x", n(d.interestCover) >= 2, n(d.interestCover) + "x");
      add("Positive operating cash flow", n(d.cashFlow) > 0, String(n(d.cashFlow)));

      add("Market cap above floor",
          isIndia ? n(d.marketCap) >= 1000 : n(d.marketCap) >= 300,
          isIndia ? n(d.marketCap) + " cr (need 1000)" : "$" + n(d.marketCap) + "m (need 300)");
      add("Share price above floor",
          isIndia ? n(d.price) >= 50 : n(d.price) >= 5,
          isIndia ? "Rs." + n(d.price) : "$" + n(d.price));
      add("Daily turnover above floor",
          isIndia ? n(d.turnover) >= 5 : n(d.turnover) >= 2,
          isIndia ? n(d.turnover) + " cr" : "$" + n(d.turnover) + "m");
      add("Listed at least 3 years", n(d.yearsListed) >= 3, n(d.yearsListed) + " years");

      const dd = n(d.drawdown);
      add("Not more than 40% below 52-week high", dd <= 40, dd + "% below high");

      if (isIndia) {
        add("Promoter pledge under 25%", n(d.pledge) < 25, n(d.pledge) + "%");
        add("No auditor resignation in 24 months", !d.auditorResigned, d.auditorResigned ? "RESIGNED" : "clean");
        add("No qualified audit opinion", !d.qualifiedOpinion, d.qualifiedOpinion ? "QUALIFIED" : "clean");
        add("No pending regulatory action", !d.regulatoryAction, d.regulatoryAction ? "PENDING" : "clean");
      }

      const failed = checks.filter(c => !c.pass);
      let band = "";
      if (dd > 40) band = "EXCLUDED — beyond the drawdown limit";
      else if (dd >= 25) band = "Allowed but flagged — needs 20 days without a new low";
      else if (dd >= 8) band = "PREFERRED band — best zone for AIM";
      else band = "Allowed, low priority — little discount available";

      return OK({
        ok: true,
        passed: failed.length === 0,
        failedCount: failed.length,
        checks,
        drawdownBand: band
      });
    }

    // ----------------------------------------------------------- COMPARE
    // Head-to-head across books. Crypto tax is deterministic (flat 31.2%, no
    // offset) so it is computed exactly. Equity tax depends on holding period,
    // so both scenarios are shown rather than one guessed figure.
    if (action === "compare") {
      const books = ["INDIA", "USA", "CRYPTO"];
      const out = [];

      for (const b of books) {
        const hr = await sb("GET", "/rest/v1/aim_holdings?select=*&book=eq." + b);
        const holdings = (hr.status < 300 && hr.body) ? hr.body : [];
        const tr = await sb("GET", "/rest/v1/aim_transactions?select=*&book=eq." + b + "&order=txn_date.asc,id.asc&limit=5000");
        const txns = (tr.status < 300 && tr.body) ? tr.body : [];
        const cr = await sb("GET", "/rest/v1/aim_cash?select=*&book=eq." + b);
        const cash = (cr.status < 300 && cr.body && cr.body.length) ? n(cr.body[0].cash) : 0;

        let realised = 0, costsPaid = 0;
        const symbols = {};
        txns.forEach(t => { symbols[String(t.symbol).toUpperCase()] = 1; });
        Object.keys(symbols).forEach(sym => {
          const mine = txns.filter(t => String(t.symbol).toUpperCase() === sym);
          const rep = replayLedger(mine);
          realised += rep.realised;
          costsPaid += rep.costsPaid;
        });

        const marketValue = holdings.reduce((s2, h) => s2 + n(h.shares) * n(h.last_price), 0);
        const invested    = holdings.reduce((s2, h) => s2 + n(h.shares) * n(h.avg_cost), 0);
        const unrealised  = marketValue - invested;

        // Crypto: flat 31.2%, no loss offset, so a loss yields zero relief.
        const cryptoTax = b === "CRYPTO" ? (realised > 0 ? realised * 0.312 : 0) : null;
        const equityStcg = b !== "CRYPTO" ? (realised > 0 ? realised * 0.20 : 0) : null;
        const equityLtcg = b !== "CRYPTO" ? (realised > 0 ? realised * 0.125 : 0) : null;

        out.push({
          book: b,
          positions: holdings.length,
          invested: r2(invested),
          marketValue: r2(marketValue),
          cash: r2(cash),
          total: r2(marketValue + cash),
          unrealised: r2(unrealised),
          unrealisedPct: invested > 0 ? r2(unrealised / invested * 100) : 0,
          realised: r2(realised),
          costsPaid: r2(costsPaid),
          tax: {
            crypto: cryptoTax === null ? null : r2(cryptoTax),
            stcg: equityStcg === null ? null : r2(equityStcg),
            ltcg: equityLtcg === null ? null : r2(equityLtcg)
          },
          netAfterTax: b === "CRYPTO"
            ? r2(unrealised + realised - (cryptoTax || 0))
            : r2(unrealised + realised - (equityStcg || 0)),
          symbolCount: Object.keys(symbols).length
        });
      }

      return OK({ ok: true, books: out });
    }

    // ------------------------------------------------- CRYPTO TAX ESTIMATE
    // What a sale actually costs under Section 115BBH / 194S.
    if (action === "cryptoTax") {
      const proceeds = n(body.proceeds), costBasis = n(body.costBasis);
      const gain = proceeds - costBasis;
      const tds = proceeds * 0.01;
      const tax = gain > 0 ? gain * 0.312 : 0;
      return OK({
        ok: true,
        proceeds: r2(proceeds), costBasis: r2(costBasis), gain: r2(gain),
        tds: r2(tds), tax: r2(tax),
        netInHand: r2(proceeds - tds - tax),
        effectivePct: gain > 0 ? r2((tax + tds) / gain * 100) : null,
        note: gain <= 0
          ? "Loss on a VDA gives no relief: it cannot offset other income, other crypto gains, or be carried forward. The 1% TDS is still deducted."
          : "Flat 30% plus 4% cess under Section 115BBH, plus 1% TDS under Section 194S."
      });
    }

    return FAIL("unknown action: " + action, 400);

  } catch (err) {
    return FAIL(err && err.message ? err.message : err);
  }
};
