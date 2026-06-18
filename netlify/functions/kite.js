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
    if (action === "quote") {
      var syms = (body.symbols||[]).map(function(s){ return "NSE:" + s; }).join("&i=");
      var raw4 = await kiteGet("/quote?i=" + syms, body.access_token);
      return {statusCode:200, headers:h, body:raw4};
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
