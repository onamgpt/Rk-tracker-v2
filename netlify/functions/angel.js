// ---------------------------------------------------------------------------
//  ANGEL ONE — SmartAPI bridge
//
//  Unlike Kite, this session renews itself. Angel authenticates with
//  clientcode + password + a six digit TOTP, and because the TOTP is derived
//  from a stored secret the server can generate it on demand. There is no
//  daily "log in again" step for the user.
//
//  Required Netlify environment variables:
//    ANGEL_API_KEY       the app's API key (sent as X-PrivateKey)
//    ANGEL_CLIENT_CODE   your Angel client code
//    ANGEL_PASSWORD      your MPIN / password
//    ANGEL_TOTP_SECRET   the base32 secret from Angel's enable-TOTP page
//                        (NOT the six digit code, and NOT the app secret)
// ---------------------------------------------------------------------------

const https  = require("https");
const crypto = require("crypto");

const HOST = "apiconnect.angelone.in";

// A warm lambda keeps the session between calls. Angel rate limits login, so
// re-authenticating on every request would get us blocked within minutes.
let SESSION = { jwt: "", feed: "", refresh: "", exp: 0 };

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const API_KEY  = process.env.ANGEL_API_KEY || "";
  const CLIENT   = process.env.ANGEL_CLIENT_CODE || "";
  const PASSWORD = process.env.ANGEL_PASSWORD || "";
  const SECRET   = process.env.ANGEL_TOTP_SECRET || "";

  const OK  = (o) => ({ statusCode: 200, headers: h, body: JSON.stringify(o) });
  const ERR = (m, extra) => OK(Object.assign({ ok: false, error: String(m) }, extra || {}));

  // ---- TOTP (RFC 6238) ----------------------------------------------------
  function base32Decode(s) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    s = String(s || "").toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
    let bits = 0, val = 0; const out = [];
    for (const c of s) {
      const i = A.indexOf(c);
      if (i < 0) continue;
      val = (val << 5) | i; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
  }

  function totpAt(secret, msec) {
    const key = base32Decode(secret);
    if (!key.length) throw new Error("TOTP secret is not valid base32");
    const counter = Math.floor((msec || Date.now()) / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const mac = crypto.createHmac("sha1", key).update(buf).digest();
    const off = mac[mac.length - 1] & 0x0f;
    const code = ((mac[off] & 0x7f) << 24) | ((mac[off + 1] & 0xff) << 16) |
                 ((mac[off + 2] & 0xff) << 8) | (mac[off + 3] & 0xff);
    return String(code % 1000000).padStart(6, "0");
  }

  // ---- transport ----------------------------------------------------------
  function call(method, path, payload, jwt) {
    return new Promise((resolve, reject) => {
      const data = payload ? JSON.stringify(payload) : "";
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": API_KEY
      };
      if (jwt) headers["Authorization"] = "Bearer " + jwt;
      if (data) headers["Content-Length"] = Buffer.byteLength(data);

      const req = https.request({ hostname: HOST, path, method, headers }, (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { resolve({ status: false, message: "Angel returned non-JSON", raw: raw.slice(0, 300) }); }
        });
      });
      req.on("error", reject);
      req.setTimeout(20000, () => { req.destroy(new Error("Angel One timed out")); });
      if (data) req.write(data);
      req.end();
    });
  }

  // ---- login --------------------------------------------------------------
  // The clock matters here. A TOTP is only valid for its 30 second window, so
  // a rejected code is retried once against the previous window before giving
  // up — that covers small clock drift between Netlify and Angel.
  async function login() {
    if (!API_KEY || !CLIENT || !PASSWORD || !SECRET) {
      throw new Error("Angel One is not configured — set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD and ANGEL_TOTP_SECRET in Netlify.");
    }
    const windows = [Date.now(), Date.now() - 30000];
    let last = null;
    for (const w of windows) {
      const r = await call("POST", "/rest/auth/angelbroking/user/v1/loginByPassword", {
        clientcode: CLIENT, password: PASSWORD, totp: totpAt(SECRET, w)
      });
      if (r && r.status === true && r.data && r.data.jwtToken) {
        SESSION = {
          jwt: r.data.jwtToken,
          feed: r.data.feedToken || "",
          refresh: r.data.refreshToken || "",
          // Angel's token runs to end of day; six hours keeps us well inside it
          // while still surviving a long working session on a warm lambda.
          exp: Date.now() + 6 * 3600 * 1000
        };
        return SESSION.jwt;
      }
      last = r;
      if (!/totp/i.test(String((r && r.message) || ""))) break;  // not a clock problem
    }
    const msg = (last && (last.message || last.errorcode)) || "login refused";
    throw new Error("Angel One login failed: " + msg);
  }

  async function jwt() {
    if (SESSION.jwt && Date.now() < SESSION.exp) return SESSION.jwt;
    return await login();
  }

  // Any call can meet an expired token. One silent re-login, then give up —
  // looping on a rejected credential is how accounts get locked.
  async function authed(method, path, payload) {
    let t = await jwt();
    let r = await call(method, path, payload, t);
    const bad = r && r.status !== true &&
                /token|expire|invalid|unauthor/i.test(String(r.message || r.errorcode || ""));
    if (bad) {
      SESSION = { jwt: "", feed: "", refresh: "", exp: 0 };
      t = await login();
      r = await call(method, path, payload, t);
    }
    return r;
  }

  // ---------------------------------------------------------------------------
  try {
    const body   = JSON.parse(event.body || "{}");
    const action = body.action || "";

    // Is this thing wired up at all? Used by the panel to show status without
    // pretending a missing env var is a network fault.
    if (action === "status") {
      const missing = [];
      if (!API_KEY)  missing.push("ANGEL_API_KEY");
      if (!CLIENT)   missing.push("ANGEL_CLIENT_CODE");
      if (!PASSWORD) missing.push("ANGEL_PASSWORD");
      if (!SECRET)   missing.push("ANGEL_TOTP_SECRET");
      if (missing.length) return OK({ ok: false, configured: false, missing });
      try {
        await jwt();
        return OK({ ok: true, configured: true, client: CLIENT });
      } catch (e) {
        return OK({ ok: false, configured: true, error: String(e.message || e) });
      }
    }

    // Holdings, and with them the live LTP for everything held. One call does
    // the work that needs two on Kite — so this doubles as the price source.
    if (action === "holdings") {
      const r = await authed("GET", "/rest/secure/angelbroking/portfolio/v1/getAllHolding");
      if (!r || r.status !== true) return ERR((r && r.message) || "could not read holdings", { errorcode: r && r.errorcode });
      const d = r.data || {};
      const rows = (d.holdings || []).filter(x => Number(x.quantity) > 0).map(x => ({
        symbol: String(x.tradingsymbol || "").replace(/-EQ$/i, "").toUpperCase(),
        tradingsymbol: x.tradingsymbol,
        symboltoken: x.symboltoken,
        exchange: x.exchange || "NSE",
        isin: x.isin || "",
        quantity: Number(x.quantity) || 0,
        average_price: Number(x.averageprice) || 0,
        last_price: Number(x.ltp) || 0,
        close: Number(x.close) || 0,
        pnl: Number(x.profitandloss) || 0,
        pnlpct: Number(x.pnlpercentage) || 0
      }));
      return OK({ ok: true, holdings: rows, total: d.totalholding || null });
    }

    // Cash available to trade — AIM cannot fund a buy signal without it.
    if (action === "funds") {
      const r = await authed("GET", "/rest/secure/angelbroking/user/v1/getRMS");
      if (!r || r.status !== true) return ERR((r && r.message) || "could not read funds");
      const d = r.data || {};
      return OK({
        ok: true,
        available: Number(d.availablecash) || 0,
        net: Number(d.net) || 0,
        raw: d
      });
    }

    if (action === "orders") {
      const r = await authed("GET", "/rest/secure/angelbroking/order/v1/getOrderBook");
      if (!r || r.status !== true) return ERR((r && r.message) || "could not read order book");
      return OK({ ok: true, orders: r.data || [] });
    }

    if (action === "trades") {
      const r = await authed("GET", "/rest/secure/angelbroking/order/v1/getTradeBook");
      if (!r || r.status !== true) return ERR((r && r.message) || "could not read trade book");
      return OK({ ok: true, trades: r.data || [] });
    }

    // Angel needs the numeric symboltoken, not just the name. Holdings carry
    // their own token, so a search is only needed for something not yet held.
    if (action === "search") {
      const r = await authed("POST", "/rest/secure/angelbroking/order/v1/searchScrip", {
        exchange: body.exchange || "NSE",
        searchscrip: String(body.symbol || "").toUpperCase()
      });
      if (!r || r.status !== true) return ERR((r && r.message) || "no match");
      return OK({ ok: true, matches: r.data || [] });
    }

    // Orders go out one at a time and each result is reported separately. A
    // partial batch is the normal outcome when funds or limits run out, and
    // hiding that behind a single success flag would be misleading.
    if (action === "placeOrder") {
      const list = Array.isArray(body.orders) ? body.orders : [body];
      const out = [];
      for (const o of list) {
        const qty = Math.floor(Number(o.qty) || 0);
        if (!o.symboltoken || !o.tradingsymbol || qty < 1) {
          out.push({ symbol: o.symbol || o.tradingsymbol, ok: false, error: "needs tradingsymbol, symboltoken and a whole quantity" });
          continue;
        }
        const price = Number(o.price) || 0;
        const r = await authed("POST", "/rest/secure/angelbroking/order/v1/placeOrder", {
          variety: "NORMAL",
          tradingsymbol: o.tradingsymbol,
          symboltoken: String(o.symboltoken),
          transactiontype: String(o.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY",
          exchange: o.exchange || "NSE",
          ordertype: price > 0 ? "LIMIT" : "MARKET",
          producttype: "DELIVERY",
          duration: "DAY",
          price: price > 0 ? String(price.toFixed(2)) : "0",
          squareoff: "0",
          stoploss: "0",
          quantity: String(qty),
          ordertag: "RK-AIM"
        });
        out.push(r && r.status === true
          ? { symbol: o.symbol || o.tradingsymbol, ok: true, orderid: (r.data || {}).orderid, uniqueorderid: (r.data || {}).uniqueorderid }
          : { symbol: o.symbol || o.tradingsymbol, ok: false, error: (r && (r.message || r.errorcode)) || "rejected" });
      }
      return OK({ ok: out.some(x => x.ok), results: out,
                  placed: out.filter(x => x.ok).length, failed: out.filter(x => !x.ok).length });
    }

    // Angel answers a bad secret and a bad client code with the same message,
    // so this reports the *shape* of what we hold without ever returning the
    // values themselves. A TOTP secret is base32: A-Z and 2-7 only. If the
    // string carries 0, 1, 8, 9 or lowercase, it is the app secret from the
    // API key page, not the TOTP secret from the enable-TOTP page.
    if (action === "diag") {
      const s = String(SECRET || "");
      const stripped = s.replace(/=+$/, "").replace(/\s+/g, "");
      const illegal = stripped.split("").filter(c => !/[A-Z2-7]/.test(c));
      const classes = [];
      if (/[a-z]/.test(stripped)) classes.push("lowercase letters");
      if (/[0189]/.test(stripped)) classes.push("the digits 0/1/8/9");
      if (/[^A-Za-z0-9]/.test(stripped)) classes.push("punctuation");
      let code = "", codeErr = "";
      try { code = totpAt(SECRET, Date.now()); } catch (e) { codeErr = String(e.message || e); }
      return OK({
        ok: true,
        secret: {
          length: stripped.length,
          validBase32: illegal.length === 0 && stripped.length > 0,
          illegalCount: illegal.length,
          contains: classes,
          // The code itself is never returned — only whether one could be
          // derived at all. This endpoint is public.
          canGenerateCode: !!code,
          generateError: codeErr
        },
        client: { length: String(CLIENT || "").length, set: !!CLIENT },
        password: { length: String(PASSWORD || "").length, set: !!PASSWORD },
        apiKey: { length: String(API_KEY || "").length, set: !!API_KEY },
        serverTimeUTC: new Date().toISOString(),
        note: illegal.length
          ? "This is NOT a valid TOTP secret — it contains " + classes.join(" and ") + ", which base32 does not allow."
          : "Secret is well-formed base32. If login still fails, the client code or MPIN is the mismatch."
      });
    }

    return ERR("unknown action: " + action);

  } catch (e) {
    return ERR(e && e.message ? e.message : e);
  }
};
