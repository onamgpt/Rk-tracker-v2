// Pre-compiles the app's JSX once at deploy time, so phones no longer download
// the 3 MB Babel compiler and recompile 1 MB of code on every open.
// Uses the exact Babel version and options the browser used before, so the
// compiled output is the same code the app has always run.
// If anything fails, the build fails and Netlify keeps the last good site live.
const fs = require("fs");
const path = require("path");
const Babel = require("@babel/standalone");

const BABEL_TAG = /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]+"><\/script>\s*/;
const JSX_BLOCK = /<script type="text\/babel">([\s\S]*?)<\/script>/g;

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".html")) out.push(p);
  }
  return out;
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
let done = 0;
for (const file of walk(__dirname, [])) {
  let html = fs.readFileSync(file, "utf8");
  if (!html.includes('type="text/babel"')) continue;
  const t0 = Date.now();
  html = html.replace(JSX_BLOCK, (m, src) => {
    src = src.replace(/const BUILD_STAMP="[^"]*";/, 'const BUILD_STAMP="' + stamp + '";');
    const out = Babel.transform(src, {
      filename: path.basename(file),
      presets: ["react", "env"],
      plugins: ["transform-class-properties", "transform-object-rest-spread", "transform-flow-strip-types"],
      sourceMaps: false,
      compact: true,
      comments: false
    }).code;
    if (out.includes("</script")) throw new Error("compiled code contains </script in " + file);
    return "<script>\n" + out + "\n</script>";
  });
  html = html.replace(BABEL_TAG, "");
  if (html.includes('type="text/babel"') || /babel-standalone/.test(html)) throw new Error("Babel left in " + file);
  fs.writeFileSync(file, html);
  done++;
  console.log("compiled", path.relative(__dirname, file), (Date.now() - t0) + "ms", Math.round(html.length / 1024) + "KB");
}
console.log("build done:", done, "file(s)");
