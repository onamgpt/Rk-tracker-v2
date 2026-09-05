// Background function (15-min limit) for the India screener's protection stage.
//
// 1. NSE surveillance file (REG1_IND / REG_IND, daily): every listed security's
//    ASM/GSM/ESM stage, trade-for-trade series, listing-fee default, pledge
//    indicators. Cached 1 day in kv as pf_in_surveillance. Best effort — NSE
//    guards its site; if every URL pattern fails we record that honestly so the
//    screener says "not checked" instead of pretending the check passed.
// 2. Fundamentals per symbol via Yahoo quoteSummary. Yahoo now requires a
//    session cookie + crumb and rate-limits, so: one crumb per run, ~0.9s
//    between symbols, retry with backoff on 429, and a 7-day per-symbol cache
//    in kv (pf_in_fundamentals) so a re-screen is instant.
//
// POST body: { symbols: ["RELIANCE", "TCS", ...] }  (NSE symbols, no suffix)
// Progress is written to pf_in_fund_job; the app polls it via db.js.

export default async (req) => {
  const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
  const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
  const sbH = { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" };
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const kvRead = async (k) => {
    try { const r = await fetch(SUPABASE_URL + "/rest/v1/kv?owner=eq.main&k=eq." + k + "&select=v", { headers: sbH }); const j = await r.json(); return Array.isArray(j) && j[0] ? j[0].v : null; } catch (e) { return null; }
  };
  const kvWrite = async (k, v) => {
    await fetch(SUPABASE_URL + "/rest/v1/kv?on_conflict=owner,k", { method: "POST", headers: Object.assign({ "Prefer": "resolution=merge-duplicates,return=minimal" }, sbH), body: JSON.stringify({ owner: "main", k, v }) });
  };
  const job = async (o) => kvWrite("pf_in_fund_job", Object.assign({ at: new Date().toISOString() }, o));

  let symbols = [];
  try { const b = await req.json(); symbols = Array.isArray(b && b.symbols) ? b.symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean) : []; } catch (e) {}
  symbols = symbols.slice(0, 250);

  try {
    await job({ state: "running", step: "surveillance", total: symbols.length, done: 0 });

    /* ---------------- 1. NSE surveillance ---------------- */
    let surv = await kvRead("pf_in_surveillance");
    if (!surv || !surv.fetchedAt || (Date.now() - new Date(surv.fetchedAt).getTime()) > 86400000) {
      surv = await fetchSurveillance(UA);
      await kvWrite("pf_in_surveillance", surv);
    }

    /* ---------------- 2. Fundamentals ---------------- */
    const cache = (await kvRead("pf_in_fundamentals")) || { data: {} };
    if (!cache.data) cache.data = {};
    const fresh = (s) => cache.data[s] && cache.data[s].fetchedAt && (Date.now() - new Date(cache.data[s].fetchedAt).getTime()) < 7 * 86400000;
    const todo = symbols.filter(s => !fresh(s));
    await job({ state: "running", step: "fundamentals", total: symbols.length, done: symbols.length - todo.length, surveillance: surv.ok ? "ok" : "unavailable" });

    let session = null;
    let done = symbols.length - todo.length, errors = 0;
    for (let i = 0; i < todo.length; i++) {
      const sym = todo[i];
      try {
        if (!session) session = await yahooSession(UA);
        const f = await yahooFundamentals(sym + ".NS", session, UA);
        cache.data[sym] = Object.assign({ fetchedAt: new Date().toISOString() }, f);
      } catch (e) {
        errors++;
        cache.data[sym] = { fetchedAt: new Date().toISOString(), error: String(e && e.message || e) };
        if (/429|crumb|401|403/i.test(String(e && e.message || e))) { session = null; await sleep(4000); }
      }
      done++;
      if (i % 10 === 9 || i === todo.length - 1) {
        await kvWrite("pf_in_fundamentals", { updatedAt: new Date().toISOString(), data: cache.data });
        await job({ state: "running", step: "fundamentals", total: symbols.length, done, errors, surveillance: surv.ok ? "ok" : "unavailable" });
      }
      await sleep(900);
    }
    await kvWrite("pf_in_fundamentals", { updatedAt: new Date().toISOString(), data: cache.data });
    await job({ state: "done", total: symbols.length, done, errors, surveillance: surv.ok ? "ok" : "unavailable", survCount: surv.ok ? Object.keys(surv.flags || {}).length : 0 });
    return new Response(JSON.stringify({ ok: true, done, errors }), { status: 200 });
  } catch (e) {
    await job({ state: "error", error: String(e && e.message || e) });
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 200 });
  }
};

/* ---- NSE surveillance file: try several known locations/name formats ---- */
async function fetchSurveillance(UA) {
  const pad = (n) => (n < 10 ? "0" : "") + n;
  const cands = [];
  for (let back = 0; back < 6; back++) {           // last 6 days covers weekends/holidays
    const d = new Date(Date.now() - back * 86400000);
    const dd = pad(d.getUTCDate()), mm = pad(d.getUTCMonth() + 1), yy = String(d.getUTCFullYear()).slice(2);
    ["REG1_IND", "REG_IND"].forEach(pre => {
      cands.push("https://nsearchives.nseindia.com/content/equities/" + pre + dd + mm + yy + ".csv");
      cands.push("https://nsearchives.nseindia.com/content/nsccl/" + pre + dd + mm + yy + ".csv");
      cands.push("https://nsearchives.nseindia.com/others/surveillance/" + pre + dd + mm + yy + ".csv");
    });
  }
  const H = { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*", "Referer": "https://www.nseindia.com/", "Accept-Language": "en-US,en;q=0.9" };
  for (const url of cands) {
    try {
      const r = await fetch(url, { headers: H });
      if (!r.ok) continue;
      const txt = await r.text();
      if (!txt || txt.length < 200 || !/SYMBOL|Symbol/i.test(txt.slice(0, 500))) continue;
      const flags = parseSurveillance(txt);
      return { ok: true, fetchedAt: new Date().toISOString(), source: url, flags };
    } catch (e) { /* try next */ }
  }
  return { ok: false, fetchedAt: new Date().toISOString(), flags: {}, note: "NSE surveillance file not reachable from server — check ASM/GSM manually on nseindia.com" };
}

// The file has one row per security with a SYMBOL column, a SERIES column and a
// set of indicator columns (ASM/GSM/ESM stage, listing-fee default, pledge etc.).
// Column names have changed between REG_IND and REG1_IND, so we match by
// keyword rather than fixed position.
function parseSurveillance(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  const header = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
  const iSym = header.findIndex(h => /^symbol$/i.test(h));
  const iSer = header.findIndex(h => /^series$/i.test(h));
  const flags = {};
  const interesting = header.map((h, i) => ({ i, h })).filter(x => /asm|gsm|esm|surveillance|pledge|default|listing.?fee|ibc|insolvency|trade.?for.?trade|caution|stage/i.test(x.h));
  for (let r = 1; r < lines.length; r++) {
    const cols = lines[r].split(",").map(c => c.replace(/"/g, "").trim());
    const sym = cols[iSym]; if (!sym) continue;
    const list = [];
    const ser = iSer >= 0 ? cols[iSer] : "";
    if (/^(BE|BZ|SZ|ST)$/i.test(ser)) list.push("series " + ser.toUpperCase() + " (trade-for-trade)");
    interesting.forEach(x => {
      const v = cols[x.i];
      if (v && !/^(0|N|NO|NA|-|)$/i.test(v)) list.push(x.h + (/^(1|Y|YES)$/i.test(v) ? "" : " " + v));
    });
    if (list.length) flags[sym.toUpperCase()] = list;
  }
  return flags;
}

/* ---- Yahoo: cookie + crumb handshake, then quoteSummary ---- */
async function yahooSession(UA) {
  const r = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const raw = r.headers.get("set-cookie") || "";
  const cookie = raw.split(",").map(s => s.split(";")[0].trim()).filter(s => /^(A3|A1|A1S)=/.test(s)).join("; ") || raw.split(";")[0];
  if (!cookie) throw new Error("no yahoo cookie");
  const c = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, "Cookie": cookie } });
  const crumb = (await c.text()).trim();
  if (!crumb || crumb.length > 40 || /Too Many/i.test(crumb)) throw new Error("bad crumb: " + crumb.slice(0, 30));
  return { cookie, crumb };
}

async function yahooFundamentals(ysym, session, UA) {
  const mods = "financialData,defaultKeyStatistics,summaryDetail,majorHoldersBreakdown,balanceSheetHistory,incomeStatementHistory,cashflowStatementHistory";
  const url = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/" + encodeURIComponent(ysym) + "?modules=" + mods + "&formatted=false&crumb=" + encodeURIComponent(session.crumb);
  let r = await fetch(url, { headers: { "User-Agent": UA, "Cookie": session.cookie } });
  if (r.status === 429) { await new Promise(x => setTimeout(x, 5000)); r = await fetch(url, { headers: { "User-Agent": UA, "Cookie": session.cookie } }); }
  if (!r.ok) throw new Error("yahoo " + r.status);
  const j = await r.json();
  const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!res) throw new Error("no result" + (j && j.quoteSummary && j.quoteSummary.error ? ": " + j.quoteSummary.error.description : ""));
  const g = (o, k) => { const v = o && o[k]; return v == null ? null : (typeof v === "object" && "raw" in v ? v.raw : v); };
  const fd = res.financialData || {}, ks = res.defaultKeyStatistics || {}, sd = res.summaryDetail || {}, mh = res.majorHoldersBreakdown || {};
  const bs = (res.balanceSheetHistory && res.balanceSheetHistory.balanceSheetStatements) || [];
  const is = (res.incomeStatementHistory && res.incomeStatementHistory.incomeStatementHistory) || [];
  const cf = (res.cashflowStatementHistory && res.cashflowStatementHistory.cashflowStatements) || [];
  const b0 = bs[0] || {}, b1 = bs[1] || {}, i0 = is[0] || {}, i1 = is[1] || {}, c0 = cf[0] || {};
  const ins = g(mh, "insidersPercentHeld");
  return {
    rev: g(i0, "totalRevenue") ?? g(fd, "totalRevenue"), revPrior: g(i1, "totalRevenue"),
    ni: g(i0, "netIncome") ?? g(ks, "netIncomeToCommon"), niPrior: g(i1, "netIncome"),
    ebit: g(i0, "ebit") ?? g(i0, "operatingIncome"), interest: g(i0, "interestExpense") != null ? Math.abs(g(i0, "interestExpense")) : null,
    ocf: g(c0, "totalCashFromOperatingActivities") ?? g(fd, "operatingCashflow"),
    assets: g(b0, "totalAssets"), assetsPrior: g(b1, "totalAssets"),
    liab: g(b0, "totalLiab"), equity: g(b0, "totalStockholderEquity"),
    curAssets: g(b0, "totalCurrentAssets"), curLiab: g(b0, "totalCurrentLiabilities"),
    ltd: g(b0, "longTermDebt") ?? g(fd, "totalDebt"), ltdPrior: g(b1, "longTermDebt"),
    retained: g(b0, "retainedEarnings"),
    shares: g(ks, "sharesOutstanding"), sharesPrior: null,
    marketCap: g(sd, "marketCap"),
    promoterPct: ins != null ? ins * 100 : null,
    beta: g(sd, "beta") ?? g(ks, "beta")
  };
}
