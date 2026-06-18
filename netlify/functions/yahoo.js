const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return {statusCode:200, headers:h, body:""};

  function fetchUrl(url) {
    return new Promise(function(resolve, reject) {
      https.get(url, {headers:{"User-Agent":"Mozilla/5.0"}}, function(res) {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchUrl(res.headers.location).then(resolve).catch(reject);
        }
        var data = "";
        res.on("data", function(c){ data += c; });
        res.on("end", function(){ resolve(data); });
      }).on("error", reject);
    });
  }

  try {
    var p = event.queryStringParameters || {};
    var action = p.action || "quote";
    var symbol = encodeURIComponent(p.symbol || "");
    var url;

    if (action === "quote") {
      url = "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol + "?interval=1d&range=5d";
    } else if (action === "history") {
      var range = p.range || "2y";
      url = "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol + "?interval=1d&range=" + range;
    } else if (action === "uslist") {
      // Official NASDAQ + NYSE/AMEX symbol directories — every listed US stock
      var nasdaqRaw = await fetchUrl("https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt");
      var otherRaw  = await fetchUrl("https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt");
      var syms = [];
      nasdaqRaw.split("\n").forEach(function(line, i){
        if (i === 0) return;
        var c = line.split("|");
        // Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot|ETF|NextShares
        if (c.length > 6 && c[3] === "N" && c[6] === "N") {
          var s = c[0].trim();
          if (s && s.indexOf(".") === -1 && s.indexOf("$") === -1 && s.length <= 5) syms.push(s);
        }
      });
      otherRaw.split("\n").forEach(function(line, i){
        if (i === 0) return;
        var c = line.split("|");
        // ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot|Test Issue|NASDAQ Symbol
        if (c.length > 6 && c[4] === "N" && c[6] === "N") {
          var s = c[0].trim();
          if (s && s.indexOf(".") === -1 && s.indexOf("$") === -1 && s.length <= 5) syms.push(s);
        }
      });
      return {statusCode:200, headers:h, body:JSON.stringify({symbols:syms, count:syms.length})};
    } else {
      return {statusCode:400, headers:h, body:JSON.stringify({error:"bad action"})};
    }

    var raw = await fetchUrl(url);
    return {statusCode:200, headers:h, body:raw};
  } catch(e) {
    return {statusCode:500, headers:h, body:JSON.stringify({error:e.message})};
  }
};
