const Anthropic = require("@anthropic-ai/sdk");

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
    const { action, tallyText, answers, month, year } = body;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── ACTION: parse → extract ledgers + ask questions ──────────────────
    if (action === "parse") {
      const prompt = `You are a Tally accounting expert for an Indian incense manufacturing company called Onam Agarbathi Pvt. Ltd. (brand: Vaishak).

The user has pasted a TallyPrime Trial Balance export below. Your job:
1. Extract all ledger balances and map them to the correct financial categories
2. Identify what information is MISSING that cannot be derived from the Trial Balance alone
3. Return structured JSON

TALLY TRIAL BALANCE DATA:
${tallyText}

Map ledgers to these categories (use best judgment on ledger names):
- income.wholesale: Sales, Dealer Sales, Trade Sales ledgers
- income.retail: Direct Sales, Counter Sales, Retail ledgers  
- income.other: Other Income, Interest Received, Misc Income
- cogs.rawMaterials: Purchase, Raw Material Purchase, Bamboo, Powder, Material ledgers
- cogs.packaging: Packaging, Carton, Box, Label ledgers
- cogs.jobWork: Job Work, Contract Labour, Piece Work ledgers
- cogs.freightIn: Freight Inward, Inward Freight, Transport In ledgers
- opex.salary: Director Remuneration, Owner Salary, Proprietor Draw ledgers
- opex.staffSalary: Salaries, Wages, Staff Pay ledgers
- opex.pf: PF, ESI, Provident Fund, Employee Benefit ledgers
- opex.rent: Rent, Godown Rent, Factory Rent ledgers
- opex.electricity: Electricity, Power, EB Bill ledgers
- opex.vehicle: Vehicle, Transport, Fuel, Driver ledgers
- opex.freightOut: Freight Outward, Delivery Charges, Courier ledgers
- opex.carLoanEMI: Car Loan, Vehicle Loan EMI ledgers (debit side payments)
- opex.bankCharges: Bank Charges, Bank Interest, Interest on OD ledgers
- opex.creditCard: Credit Card Payment, CC Payment ledgers
- opex.marketing: Marketing, Advertising, Digital Marketing, Meta Ads ledgers
- opex.professional: CA Fees, Professional Fees, Legal Fees ledgers
- opex.telephone: Telephone, Mobile, Internet, Broadband ledgers
- opex.repairs: Repairs, Maintenance, R&M ledgers
- opex.gst: GST Paid, Tax, TDS ledgers
- opex.other: any other expense ledgers not mapped above
- bs.inventory: Stock in Hand, Closing Stock, Inventory ledgers
- bs.debtors: Sundry Debtors, Trade Receivables, Debtors ledgers
- bs.cash: Cash, Petty Cash ledgers
- bs.bank: Bank Account, Current Account, Savings Account ledgers
- bs.advanceToSuppliers: Advance to Suppliers, Supplier Advance ledgers
- bs.creditors: Sundry Creditors, Trade Payables, Creditors ledgers
- bs.carLoanOutstanding: Car Loan (liability), Vehicle Loan outstanding ledgers
- bs.otherLoan: Other Loans, Term Loan, Working Capital Loan ledgers
- bs.creditCardOutstanding: Credit Card outstanding (liability) ledgers
- bs.customerAdvance: Customer Advance, Advance from Customers ledgers
- bs.gstPayable: GST Payable, Output GST, Tax Payable ledgers
- owner.loanGiven: Loans Given by proprietor, Capital, Owner Loan ledgers
- owner.drawings: Drawings, Personal Expenses, Owner Drawings ledgers

IMPORTANT RULES:
- Use absolute values (ignore Dr/Cr sign — just extract the number)
- If a category has multiple matching ledgers, sum them
- If you cannot find a ledger for a category, set it to null (not 0)
- For bs.inventory: TallyPrime often shows closing stock as a separate line — look for it carefully

Return ONLY valid JSON, no explanation, no markdown:
{
  "extracted": {
    "income": { "wholesale": number|null, "retail": number|null, "other": number|null },
    "cogs": { "rawMaterials": number|null, "packaging": number|null, "jobWork": number|null, "freightIn": number|null },
    "opex": { "salary": number|null, "staffSalary": number|null, "pf": number|null, "rent": number|null, "electricity": number|null, "vehicle": number|null, "freightOut": number|null, "carLoanEMI": number|null, "bankCharges": number|null, "creditCard": number|null, "marketing": number|null, "professional": number|null, "telephone": number|null, "repairs": number|null, "gst": number|null, "other": number|null },
    "bs": { "inventory": number|null, "debtors": number|null, "cash": number|null, "bank": number|null, "advanceToSuppliers": number|null, "creditors": number|null, "carLoanOutstanding": number|null, "otherLoan": number|null, "creditCardOutstanding": number|null, "customerAdvance": number|null, "gstPayable": number|null },
    "owner": { "loanGiven": number|null, "drawings": number|null }
  },
  "ledgerMap": [
    { "tallyLedger": "exact ledger name from Tally", "mappedTo": "category key", "amount": number }
  ],
  "questions": [
    { "id": "q1", "field": "bs.inventory", "question": "What is your closing stock / inventory value for this month? (Tally may not show this clearly in Trial Balance)", "hint": "Check your stock register or Tally → Stock Summary" },
    { "id": "q2", "field": "income.online", "question": "What were your online sales on onamagarbathi.com this month?", "hint": "This is not in Tally — check Razorpay dashboard or website orders" }
  ]
}

Only include questions for fields that are NULL in extracted (truly missing). Maximum 8 questions. Always ask about online sales since it's not in Tally. Always ask about inventory if not clearly found.`;

      const resp = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }]
      });

      const raw = resp.content[0].text.trim();
      const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(clean);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, ...parsed }) };
    }

    // ── ACTION: finalize → merge answers + produce P&L summary ──────────
    if (action === "finalize") {
      const { extracted, answers, month, year } = body;

      // Merge answers into extracted
      const merged = JSON.parse(JSON.stringify(extracted));
      for (const [field, value] of Object.entries(answers || {})) {
        const parts = field.split(".");
        if (parts.length === 2) {
          if (!merged[parts[0]]) merged[parts[0]] = {};
          merged[parts[0]][parts[1]] = parseFloat(value) || 0;
        }
      }

      const prompt = `You are an accounting expert. Given this financial data for Onam Agarbathi Pvt. Ltd. for ${month} ${year}, produce a clean P&L analysis.

DATA:
${JSON.stringify(merged, null, 2)}

Calculate:
- Total Income = income.wholesale + income.retail + income.online + income.other
- Total COGS = cogs.rawMaterials + cogs.packaging + cogs.jobWork + cogs.freightIn
- Gross Profit = Total Income - Total COGS
- Gross Margin % = Gross Profit / Total Income * 100
- Total Opex = sum of all opex fields
- Operating Profit = Gross Profit - Total Opex

Then write a CONCISE diagnosis (3-5 bullet points) answering:
1. Is the business profitable this month?
2. Where is profit stuck? (check inventory, debtors changes)
3. Any red flags? (credit card rising, your salary vs profit ratio)
4. One actionable recommendation

Return ONLY valid JSON:
{
  "summary": {
    "totalIncome": number,
    "totalCOGS": number,
    "grossProfit": number,
    "grossMarginPct": number,
    "totalOpex": number,
    "operatingProfit": number,
    "operatingMarginPct": number
  },
  "merged": { ...same structure as input data... },
  "diagnosis": ["bullet 1", "bullet 2", "bullet 3"],
  "status": "profit"|"loss"|"breakeven"
}`;

      const resp = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      });

      const raw = resp.content[0].text.trim();
      const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const result = JSON.parse(clean);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, ...result }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
