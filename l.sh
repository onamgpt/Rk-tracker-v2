#!/bin/bash
# Onam Tracker — Zebra label printer agent for the Mac Mini.
# Run once:   curl -sL rk-tracker-v2.netlify.app/l.sh | bash
# Every 15 seconds it asks the tracker for labels to print and sends them to the Zebra (raw ZPL).
# Safe to run again. No secrets in this file: the key is read from the WhatsApp bridge already installed.
set -e
AGENT="$HOME/onam-label-agent.py"
PLIST="$HOME/Library/LaunchAgents/com.onam.labels.plist"
LOG="$HOME/onam-labels.log"

echo ""
echo "== Onam label printer setup =="

KEY=$(grep -hoE "[a-f0-9]{48}" "$HOME/onam-whatsapp/bridge.js" 2>/dev/null | head -1)
if [ -z "$KEY" ]; then
  echo "Could not find the WhatsApp bridge on this Mac (~/onam-whatsapp). Run this on the office Mac Mini."; exit 1
fi
echo "$KEY" > "$HOME/.onam-label-key"; chmod 600 "$HOME/.onam-label-key"

ZQ=$(lpstat -p 2>/dev/null | grep -iE "zebra|zd2" | head -1 | awk '{print $2}')
if [ -z "$ZQ" ]; then
  echo ""
  echo "No Zebra printer found yet. Add it first:"
  echo "  Apple menu > System Settings > Printers & Scanners > Add Printer > pick the Zebra > Use: Zebra ZPL Label Printer > Add"
  echo "Then run this command again."
  exit 1
fi
echo "Zebra printer found: $ZQ"

cat > "$AGENT" <<'PYEOF'
import json, os, subprocess, tempfile, socket, re
URL = "https://rk-tracker-v2.netlify.app/.netlify/functions/label-queue"
KEY = open(os.path.expanduser("~/.onam-label-key")).read().strip()
def post(body):
    r = subprocess.run(["curl", "-s", "-m", "20", "-X", "POST", URL, "-H", "Content-Type: application/json",
                        "-H", "x-bridge-key: " + KEY, "-d", json.dumps(body)], capture_output=True, text=True)
    try: return json.loads(r.stdout or "{}")
    except Exception: return {}
lp = subprocess.run(["lpstat", "-p"], capture_output=True, text=True).stdout
line = next((l for l in lp.splitlines() if re.search(r"zebra|zd2", l, re.I)), "")
printer = line.split()[1] if line.startswith("printer ") else ""
res = post({"action": "pending", "printer": printer, "state": line, "host": socket.gethostname(), "version": "1.0"})
for j in res.get("jobs", []):
    fd, path = tempfile.mkstemp(suffix=".zpl")
    with os.fdopen(fd, "w") as f: f.write(j.get("zpl", ""))
    r = subprocess.run(["lp", "-d", printer, "-o", "raw", path], capture_output=True, text=True)
    os.remove(path)
    ok = r.returncode == 0
    post({"action": "ack", "id": j["id"], "ok": ok, "err": (r.stderr or r.stdout or "")[:300]})
    print(("printed " if ok else "FAILED ") + str(j.get("n")) + " · " + str(j.get("title")), flush=True)
PYEOF

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.onam.labels</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>$AGENT</string></array>
  <key>StartInterval</key><integer>15</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLEOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# one test label straight away
printf '^XA^CI28^PW799^LL400^FO10,10^GB779,380,4^FS^FO40,60^A0N,44,44^FDONAM LABEL PRINTER^FS^FO40,140^A0N,34,34^FDSetup OK - auto-print is ON^FS^FO560,170^BQN,2,6^FDMA,ONAM-TEST^FS^XZ' > /tmp/onam-test.zpl
lp -d "$ZQ" -o raw /tmp/onam-test.zpl >/dev/null && echo "Test label sent to the Zebra."

echo ""
echo "DONE. A test label should come out now. From here on labels print by themselves."
echo ""
