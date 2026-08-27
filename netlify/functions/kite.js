const https = require("https");
const crypto = require("crypto");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return {statusCode:200, headers:h, body:""};

  const API_KEY    = process.env.KITE_API_KEY;
  const API_SECRET = process.env.KITE_API_SECRET;

  function kiteGet(path, token) {
    return new Promise(function(resolve, reject) {
      var opts = {
        hostname: "api.kite.trade",
        path: path,
        method: "GET",
        headers: {
          "X-Kite-Version": "3",
          "Authorization": "token " + API_KEY + ":" + token
        }
      };
      https.request(opts, function(res) {
        var data = "";
        res.on("data", function(c){ data += c; });
        res.on("end", function(){ resolve(data); });
      }).on("error", reject).end();
    });
  }

  function kitePost(path, body) {
    return new Promise(function(resolve, reject) {
      var postData = Object.keys(body).map(function(k){
        return encodeURIComponent(k) + "=" + encodeURIComponent(body[k]);
      }).join("&");
      var opts = {
        hostname: "api.kite.trade",
        path: path,
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData)
        }
      };
      var req = https.request(opts, function(res) {
        var data = "";
        res.on("data", function(c){ data += c; });
        res.on("end", function(){ resolve(data); });
      });
      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  }

  try {
    var body = JSON.parse(event.body || "{}");
    var action = body.action || "";

    // Generate login URL for user to authenticate
    if (action === "loginUrl") {
      var url = "https://kite.zerodha.com/connect/login?api_key=" + API_KEY + "&v=3";
      return {statusCode:200, headers:h, body:JSON.stringify({url:url})};
    }

    // Exchange request_token for access_token
    if (action === "getToken") {
      var reqToken = body.request_token;
      var checksum = crypto.createHash("sha256")
        .update(API_KEY + reqToken + API_SECRET)
        .digest("hex");
      var raw = await kitePost("/session/token", {
        api_key: API_KEY,
        request_token: reqToken,
        checksum: checksum
      });
      var d = JSON.parse(raw);
      return {statusCode:200, headers:h, body:JSON.stringify(d)};
    }

    // Get holdings
    if (action === "holdings") {
      var raw2 = await kiteGet("/portfolio/holdings", body.access_token);
      return {statusCode:200, headers:h, body:raw2};
    }

    // Get positions
    if (action === "positions") {
      var raw3 = await kiteGet("/portfolio/positions", body.access_token);
      return {statusCode:200, headers:h, body:raw3};
    }

    // Get quote for multiple symbols
    // The publisher api_key is meant to be visible in the page — it is what
    // identifies the app on Kite's own order screen. The secret never leaves here.
    if (action === "apiKey") {
      return {statusCode:200, headers:h, body: JSON.stringify({ api_key: API_KEY })};
    }

    if (action === "quote") {
      // Symbols are requested one at a time rather than as a single batch.
      // Kite rejects the whole request if any one symbol is unknown to NSE —
      // a Yahoo-style ticker like SHK.NS would silently kill every other price
      // in the same call, which is exactly how prices appeared to "not update".
      var list = (body.symbols || []).filter(Boolean);
      var out = {};
      var failed = [];
      var authError = null;

      // One request for all of them. Kite accepts many instruments in a single
      // quote call and simply omits any it does not recognise — so a bad ticker
      // costs that one price, not the whole set. Firing 26 separate requests
      // instead trips the rate limit; doing them one after another runs past
      // the function time limit. A single batch avoids both.
      var qs = list.map(function (s) { return "i=" + encodeURIComponent("NSE:" + s); }).join("&");
      try {
        var raw = await kiteGet("/quote?" + qs, body.access_token);
        var parsed = JSON.parse(raw);

        if (parsed && parsed.status === "error") {
          var et = String(parsed.error_type || "");
          authError = (parsed.message || et || "request rejected") + (et ? (" [" + et + "]") : "");
        } else if (parsed && parsed.data) {
          list.forEach(function (sym) {
            var key = "NSE:" + sym;
            if (parsed.data[key]) out[key] = parsed.data[key];
            else failed.push(sym);
          });
        } else {
          failed = list.slice();
        }
      } catch (e) {
        authError = "could not reach Zerodha: " + String(e && e.message ? e.message : e);
      }


      if (authError) {
        return {statusCode:200, headers:h,
          body: JSON.stringify({ status:"error", authError: authError, data: {}, failed: [] })};
      }
      return {statusCode:200, headers:h,
        body: JSON.stringify({ status:"success", data: out, failed: failed })};
    }

    // Place a single order — only when user explicitly presses the button
    if (action === "placeOrder") {
      var o = body.order || {};
      if(!o.tradingsymbol || !o.transaction_type || !o.quantity){
        return {statusCode:400, headers:h, body:JSON.stringify({error:"Missing order fields"})};
      }
      var postData = "exchange=NSE"
        + "&tradingsymbol=" + encodeURIComponent(o.tradingsymbol)
        + "&transaction_type=" + encodeURIComponent(o.transaction_type)
        + "&quantity=" + encodeURIComponent(String(o.quantity))
        + "&product=CNC&order_type=MARKET&validity=DAY";
      var raw5 = await new Promise(function(resolve, reject) {
        var opts = {
          hostname: "api.kite.trade",
          path: "/orders/regular",
          method: "POST",
          headers: {
            "X-Kite-Version": "3",
            "Authorization": "token " + API_KEY + ":" + body.access_token,
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(postData)
          }
        };
        var rq = https.request(opts, function(res) {
          var data = "";
          res.on("data", function(c){ data += c; });
          res.on("end", function(){ resolve(data); });
        });
        rq.on("error", reject);
        rq.write(postData);
        rq.end();
      });
      return {statusCode:200, headers:h, body:raw5};
    }

    // Full NSE instrument list (official, from Zerodha)
    if (action === "instruments") {
      var rawList = await kiteGet("/instruments/NSE", body.access_token);
      // Parse CSV server-side, return only EQ symbols to keep payload small
      var lines = rawList.split("\n");
      var syms = [];
      for (var li = 1; li < lines.length; li++) {
        var cols = lines[li].split(",");
        // CSV: instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
        if (cols.length > 11 && cols[9] === "EQ" && cols[10] === "NSE") {
          var ts = cols[2];
          // skip bonds/odd series with dashes/numbers suffixes
          if (ts && ts.indexOf("-") === -1) syms.push(ts);
        }
      }
      return {statusCode:200, headers:h, body:JSON.stringify({symbols:syms, count:syms.length})};
    }

    // Real 6-month high/low, sourced from the exchange via your own Kite
    // subscription rather than an unofficial scrape. This is the one piece
    // of the gate check that Kite Connect can actually provide — fundamentals
    // like EPS are not part of this API at any subscription tier; Zerodha's
    // own developer forum confirms that even paid Kite Connect access does
    // not expose them, so that half of the gate still has to come from
    // elsewhere. Not overselling what ₹500/month buys here.
    if (action === "historicalRange") {
      var tsym = String(body.tradingsymbol || "").toUpperCase();
      if (!tsym) return {statusCode:400, headers:h, body:JSON.stringify({error:"tradingsymbol required"})};

      var rawList2 = await kiteGet("/instruments/NSE", body.access_token);
      var lines2 = rawList2.split("\n");
      var token = null;
      for (var lj = 1; lj < lines2.length; lj++) {
        var cols2 = lines2[lj].split(",");
        if (cols2.length > 11 && cols2[9] === "EQ" && cols2[10] === "NSE" && cols2[2] === tsym) {
          token = cols2[0]; break;
        }
      }
      if (!token) return {statusCode:400, headers:h, body:JSON.stringify({error:"symbol not found on NSE — check the spelling"})};

      var to = new Date();
      var from = new Date(); from.setMonth(from.getMonth() - 6);
      var fmt = function(d){ return d.toISOString().slice(0,10); };
      var histPath = "/instruments/historical/" + token + "/day?from=" + fmt(from) + "&to=" + fmt(to);
      var rawHist = await kiteGet(histPath, body.access_token);
      var hist;
      try { hist = JSON.parse(rawHist); } catch(e) { return {statusCode:502, headers:h, body:JSON.stringify({error:"could not read Kite's historical response"})}; }
      var candles = hist && hist.data && hist.data.candles;
      if (!candles || !candles.length) return {statusCode:400, headers:h, body:JSON.stringify({error:hist.message||"no historical data returned"})};

      var hi = -Infinity, lo = Infinity, lastClose = candles[candles.length-1][4];
      candles.forEach(function(c){ if(c[2]>hi) hi=c[2]; if(c[3]<lo) lo=c[3]; });
      var rangePct = lo>0 ? Math.round(((hi-lo)/lo)*10000)/100 : null;
      return {statusCode:200, headers:h, body:JSON.stringify({ok:true, symbol:tsym, high:hi, low:lo, price:lastClose, sixMonthRange:rangePct, source:"Kite Connect (official exchange data)"})};
    }

    // Today's order book (to auto-apply executed trades)
    if (action === "orders") {
      var rawOrders = await kiteGet("/orders", body.access_token);
      return {statusCode:200, headers:h, body:rawOrders};
    }

    return {statusCode:400, headers:h, body:JSON.stringify({error:"Unknown action"})};
  } catch(e) {
    return {statusCode:500, headers:h, body:JSON.stringify({error:e.message})};
  }
};
