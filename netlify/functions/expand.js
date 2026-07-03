// Expands short URLs (maps.app.goo.gl etc.) by following redirects; returns final URL + first coords found in HTML
const https = require("https");
const http = require("http");

function follow(url, depth, cb) {
  if (depth > 6) return cb(null, url, "");
  const mod = url.startsWith("https") ? https : http;
  const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      let loc = res.headers.location;
      if (loc.startsWith("/")) {
        const u = new URL(url);
        loc = u.origin + loc;
      }
      // Google consent wrapper: real URL is in ?continue=
      try {
        const cu = new URL(loc);
        if (cu.hostname.includes("consent.google") && cu.searchParams.get("continue")) {
          loc = cu.searchParams.get("continue");
        }
      } catch (e) {}
      res.resume();
      return follow(loc, depth + 1, cb);
    }
    let data = "";
    res.on("data", (c) => { if (data.length < 300000) data += c; });
    res.on("end", () => cb(null, url, data));
  });
  req.on("error", (e) => cb(e, url, ""));
  req.setTimeout(10000, () => { req.destroy(); cb(new Error("timeout"), url, ""); });
}

exports.handler = async (event) => {
  const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const target = (event.queryStringParameters || {}).url || "";
  if (!/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|www\.google\.com|maps\.google\.com)\//.test(target)) {
    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "unsupported url" }) };
  }
  return new Promise((resolve) => {
    follow(target, 0, (err, finalUrl, html) => {
      // Grab a coords-bearing snippet from the HTML so the client regex can find @lat,lng
      let snippet = "";
      if (html) {
        const m = html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || html.match(/\[(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/) || html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
        if (m) snippet = "@" + m[1] + "," + m[2];
      }
      resolve({ statusCode: 200, headers: h, body: JSON.stringify({ ok: true, finalUrl: finalUrl || target, html: snippet, error: err ? String(err.message || err) : "" }) });
    });
  });
};
