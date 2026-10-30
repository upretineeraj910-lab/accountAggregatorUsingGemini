import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // Check if AI insights are enabled
  if (process.env.ENABLE_AI_INSIGHTS !== "true") {
    return NextResponse.json(
      { error: "AI insights feature is disabled." },
      { status: 403 }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured." },
      { status: 500 }
    );
  }

  try {
    const body = await req.json();

    // STRICT SANITIZATION: Only numbers allowed in payload - no names, narrations, accounts, or transactions
    const metrics = {
      avgSalary: Number(body.avgSalary) || 0,
      monthlyEmi: Number(body.monthlyEmi) || 0,
      foir: Number(body.foir) || 0,
      bouncesCount: Number(body.bouncesCount) || 0,
      cashPct: Number(body.cashPct) || 0,
      passThroughPct: Number(body.passThroughPct) || 0,
      selfNet: Number(body.selfNet) || 0,
      roundTripCount: Number(body.roundTripCount) || 0,
      medianDailyBalance: Number(body.medianDailyBalance) || 0,
      minBalance: Number(body.minBalance) || 0,
    };

    const systemPrompt =
      "You are a credit underwriting assistant. Given only numeric metrics from a bank statement analysis, output a concise 4-5 bullet point summary. Do NOT make any new inferences outside the numbers provided. Do NOT make a loan approval, rejection, or credit limit decision.";

    const userMessage = `Here are the verified numeric metrics:
- Average Monthly Salary: ₹${metrics.avgSalary.toLocaleString("en-IN")}
- Monthly EMI Obligations: ₹${metrics.monthlyEmi.toLocaleString("en-IN")}
- FOIR: ${metrics.foir}%
- Bounces / Returns: ${metrics.bouncesCount}
- Cash Deposit Volume: ${metrics.cashPct}% of total inflows
- Pass-Through Ratio: ${metrics.passThroughPct}% of salary drained in 3 days
- Net Self Transfers: ₹${metrics.selfNet.toLocaleString("en-IN")}
- Round-trip / Circular Transactions: ${metrics.roundTripCount}
- Median Daily Balance: ₹${metrics.medianDailyBalance.toLocaleString("en-IN")}
- Minimum Balance: ₹${metrics.minBalance.toLocaleString("en-IN")}

Provide a factual 4-5 bullet point summary of these numbers.`;

    const model = (process.env.GEMINI_MODEL || "gemini-3.5-flash")
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/gemini-2\.[05]-flash/, "gemini-3.5-flash");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const payload = {
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
      systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error("Gemini insights error status:", res.status);
      return NextResponse.json(
        { error: "Failed to generate AI insights." },
        { status: 502 }
      );
    }

    const data = await res.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    return NextResponse.json({ summary });
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : "Error";
    console.error("Insights API error:", errName);
    return NextResponse.json(
      { error: "Error generating summary." },
      { status: 500 }
    );
  }
}
