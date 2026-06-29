const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  try {
    const body = JSON.parse(event.body || "{}");
    const { action, tallyText, answers, month, year, extracted } = body;
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

    async function claudeCall(userPrompt, maxTokens) {
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: maxTokens || 4000,
          messages: [{ role: "user", content: userPrompt }]
        });
        const req = https.request({
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = "";
          res.on("data", c => data += c);
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve((parsed.content && parsed.content[0] && parsed.content[0].text) || "");
            } catch(e) { reject(e); }
          });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
      });
    }

    if (action === "parse") {
      const prompt = `You are a Tally accounting expert for Onam Agarbathi Pvt. Ltd. (incense manufacturer, Bangalore).
Read this TallyPrime Trial Balance and map every ledger to the correct financial category.

TALLY DATA:
${(tallyText || "").slice(0, 8000)}

Map ledgers to these categories:
- income.wholesale, income.retail, income.other
- cogs.rawMaterials, cogs.packaging, cogs.jobWork, cogs.freightIn
- opex.salary, opex.staffSalary, opex.pf, opex.rent, opex.electricity, opex.vehicle, opex.freightOut, opex.carLoanEMI, opex.bankCharges, opex.creditCard, opex.marketing, opex.professional, opex.telephone, opex.repairs, opex.gst, opex.other
- bs.inventory, bs.debtors, bs.cash, bs.bank, bs.advanceToSuppliers, bs.creditors, bs.carLoanOutstanding, bs.otherLoan, bs.creditCardOutstanding, bs.customerAdvance, bs.gstPayable
- owner.loanGiven, owner.drawings

RULES:
- Use absolute values (ignore Dr/Cr)
- Sum multiple ledgers in same category
- Set null if category not found
- Always ask about online sales (not in Tally) and closing stock if unclear

Return ONLY valid JSON:
{"extracted":{"income":{"wholesale":null,"retail":null,"other":null},"cogs":{"rawMaterials":null,"packaging":null,"jobWork":null,"freightIn":null},"opex":{"salary":null,"staffSalary":null,"pf":null,"rent":null,"electricity":null,"vehicle":null,"freightOut":null,"carLoanEMI":null,"bankCharges":null,"creditCard":null,"marketing":null,"professional":null,"telephone":null,"repairs":null,"gst":null,"other":null},"bs":{"inventory":null,"debtors":null,"cash":null,"bank":null,"advanceToSuppliers":null,"creditors":null,"carLoanOutstanding":null,"otherLoan":null,"creditCardOutstanding":null,"customerAdvance":null,"gstPayable":null},"owner":{"loanGiven":null,"drawings":null}},"ledgerMap":[{"tallyLedger":"name","mappedTo":"category","amount":0}],"questions":[{"id":"q1","field":"bs.inventory","question":"What is your closing stock value?","hint":"Check stock register"}]}`;

      const raw = await claudeCall(prompt, 4000);
      const clean = raw.replace(/```json/g,"").replace(/```/g,"").trim();
      const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
      const parsed = JSON.parse(s >= 0 ? clean.substring(s, e+1) : clean);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, ...parsed }) };
    }

    if (action === "finalize") {
      const merged = JSON.parse(JSON.stringify(extracted || {}));
      for (const [field, value] of Object.entries(answers || {})) {
        const parts = field.split(".");
        if (parts.length === 2) {
          if (!merged[parts[0]]) merged[parts[0]] = {};
          merged[parts[0]][parts[1]] = parseFloat(value) || 0;
        }
      }
      const prompt = `You are an accountant for Onam Agarbathi Pvt. Ltd. Calculate P&L for ${month} ${year}.

DATA: ${JSON.stringify(merged)}

Calculate totals and write 3-5 bullet diagnosis: is business profitable? where is cash stuck? red flags? one recommendation.

Return ONLY valid JSON:
{"summary":{"totalIncome":0,"totalCOGS":0,"grossProfit":0,"grossMarginPct":0,"totalOpex":0,"operatingProfit":0,"operatingMarginPct":0},"merged":{},"diagnosis":["bullet1","bullet2"],"status":"profit"}`;

      const raw = await claudeCall(prompt, 2000);
      const clean = raw.replace(/```json/g,"").replace(/```/g,"").trim();
      const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
      const result = JSON.parse(s >= 0 ? clean.substring(s, e+1) : clean);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, ...result }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch(e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
