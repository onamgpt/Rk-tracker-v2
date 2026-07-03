// Expands short Google Maps links and returns coordinates directly.
// Handles HTTP redirects AND HTML interstitials (meta-refresh / embedded destination URL).
const https = require("https");

function grabCoords(text) {
  if (!text) return null;
  var pats = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]center=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/,
    /[?&]destination=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/,
    /\[(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/,
    /"(-?\d+\.\d{4,})",\s*"(-?\d+\.\d{4,})"/,
    /(-?\d{1,2}\.\d{5,}),(-?\d{2,3}\.\d{5,})/,
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = text.match(pats[i]);
    if (m) {
      var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat: lat, lng: lng };
      }
    }
  }
  return null;
}

function get(url, depth) {
  return new Promise(function (resolve) {
    if (depth > 8) return resolve({ url: url, html: "" });
    var req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }, function (res) {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        var loc = res.headers.location;
        try {
          if (loc.startsWith("/")) loc = new URL(url).origin + loc;
          var cu = new URL(loc);
          if (cu.hostname.includes("consent.google") && cu.searchParams.get("continue")) {
            loc = cu.searchParams.get("continue");
          }
        } catch (e) {}
        res.resume();
        return resolve(get(loc, depth + 1));
      }
      var data = "";
      res.on("data", function (c) { if (data.length < 500000) data += c; });
      res.on("end", function () { resolve({ url: url, html: data }); });
    });
    req.on("error", function () { resolve({ url: url, html: "" }); });
    req.setTimeout(9000, function () { req.destroy(); resolve({ url: url, html: "" }); });
  });
}

exports.handler = async (event) => {
  const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const target = (event.queryStringParameters || {}).url || "";
  if (!/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|www\.google\.[a-z.]+|maps\.google\.[a-z.]+)\//.test(target)) {
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "unsupported url", target: target }) };
  }
  const r = await get(target, 0);
  let coords = grabCoords(r.url);
  if (!coords && r.html) {
    coords = grabCoords(decodeURIComponent(r.html.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&"))) || grabCoords(r.html);
  }
  return {
    statusCode: 200,
    headers: h,
    body: JSON.stringify({ ok: true, finalUrl: r.url, coords: coords || null, gotHtml: !!r.html })
  };
};
