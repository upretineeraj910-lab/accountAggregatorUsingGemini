// server-only
import { PAGE } from "../pdfText";
import { Txn, RawAiRow, AiQuality } from "../types";
import { isAnchorLine, countExpectedRows, normalizeRows } from "./normalize";

export class AiExtractError extends Error {
  code: "NO_KEY" | "HEADER_NOT_FOUND" | "CHUNK_FAILED" | "NO_ROWS" | string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = "AiExtractError";
    this.code = code;
  }
}

export type CallFn = (payload: {
  contents: { role: string; parts: { text: string }[] }[];
  generationConfig: Record<string, unknown>;
  systemInstruction?: { parts: { text: string }[] };
}) => Promise<{
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
}>;

const TABLE_HEADER_REGEX =
  /(?:transaction\s+remarks|particulars|tran(?:saction)?\s+date|Date\s+.*(?:Amount|Balance|Remarks|Debit|Withdrawal))/i;

const PAN_REGEX = /[A-Z]{5}\d{4}[A-Z]/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const SYSTEM_INSTRUCTION =
  `You extract bank statement transactions from raw PDF text lines (Indian banks).
1. Output EVERY transaction row present in the text, in the SAME order as the text. Never skip, merge, split or invent rows.
2. date: convert to YYYY-MM-DD. Dates are day-first (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, dd Mon yyyy).
3. amount: the transaction amount only, positive number, no commas. balance: the running balance printed for that row exactly as printed (can be negative).
4. type: DEBIT for withdrawals / Dr / DR, CREDIT for deposits / Cr / CR. If separate withdrawal/deposit columns exist, infer from column headers. Balance will be verified later, so do your best.
5. narration: full remarks text of that row joined with single spaces, including continuation lines (they can appear above or below the numbers line). Do NOT put amounts, balance or the date in narration.
6. Ignore headers, footers, page numbers, legends, disclaimers, OPENING BALANCE, TRANSACTION TOTAL, CLOSING BALANCE.
7. Copy numbers digit by digit. Never round, recompute or guess.`.trim();

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    transactions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING" },
          narration: { type: "STRING" },
          amount: { type: "NUMBER" },
          type: { type: "STRING", enum: ["DEBIT", "CREDIT"] },
          balance: { type: "NUMBER" },
        },
        required: ["date", "narration", "amount", "type", "balance"],
        propertyOrdering: ["date", "narration", "amount", "type", "balance"],
      },
    },
  },
  required: ["transactions"],
};

export function maskSensitiveData(text: string): string {
  return text.replace(PAN_REGEX, "[PAN_MASKED]").replace(EMAIL_REGEX, "[EMAIL_MASKED]");
}

export function detectOpeningBalance(lines: string[]): number | undefined {
  const opRegex =
    /(?:OPENING\s+BALANCE|BALANCE\s+B\/F|BAL\s+B\/F|BROUGHT\s+FORWARD)[\s:]+([0-9,]+\.?\d*)/i;
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i];
    const match = line.match(opRegex);
    if (match && match[1]) {
      const clean = match[1].replace(/,/g, "");
      const val = parseFloat(clean);
      if (isFinite(val)) {
        return val;
      }
    }
  }
  return undefined;
}

export function stripHeaderLines(
  lines: string[],
  allowFullTextIfNoHeader = false
): { strippedLines: string[]; openingBalance?: number } {
  const openingBalance = detectOpeningBalance(lines);

  let headerIndex = -1;
  const searchLimit = Math.min(lines.length, 120);
  for (let i = 0; i < searchLimit; i++) {
    if (TABLE_HEADER_REGEX.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    if (!allowFullTextIfNoHeader) {
      throw new AiExtractError("HEADER_NOT_FOUND", "Table header line not found in the first 120 lines.");
    }
    return { strippedLines: lines, openingBalance };
  }

  // Header found: strip all lines up to and including the header
  const strippedLines = lines.slice(headerIndex + 1);
  return { strippedLines, openingBalance };
}

interface ChunkPlan {
  lines: string[];
  expectedAnchors: number;
}

export function prepareChunks(lines: string[]): ChunkPlan[] {
  // Split lines by PAGE marker
  const pages: string[][] = [];
  let currentPage: string[] = [];

  for (const line of lines) {
    if (line === PAGE) {
      if (currentPage.length > 0) {
        pages.push(currentPage);
        currentPage = [];
      }
    } else {
      currentPage.push(line);
    }
  }
  if (currentPage.length > 0) {
    pages.push(currentPage);
  }

  if (pages.length === 0) {
    pages.push(lines.filter((l) => l !== PAGE));
  }

  const chunks: ChunkPlan[] = [];

  for (const pageLines of pages) {
    const totalAnchors = countExpectedRows(pageLines);
    if (totalAnchors <= 60) {
      chunks.push({
        lines: pageLines,
        expectedAnchors: totalAnchors,
      });
    } else {
      // Split on anchor lines with 4 lines overlap
      const anchorIndices: number[] = [];
      for (let i = 0; i < pageLines.length; i++) {
        if (isAnchorLine(pageLines[i])) {
          anchorIndices.push(i);
        }
      }

      const SUB_CHUNK_ANCHOR_SIZE = 45;
      let startIdx = 0;

      while (startIdx < anchorIndices.length) {
        const endAnchorIdx = Math.min(startIdx + SUB_CHUNK_ANCHOR_SIZE, anchorIndices.length);
        const lineStart = anchorIndices[startIdx];
        const lineEnd =
          endAnchorIdx < anchorIndices.length
            ? Math.min(pageLines.length, anchorIndices[endAnchorIdx] + 4)
            : pageLines.length;

        const subLines = pageLines.slice(lineStart, lineEnd);
        chunks.push({
          lines: subLines,
          expectedAnchors: countExpectedRows(subLines),
        });

        startIdx = endAnchorIdx;
      }
    }
  }

  return chunks;
}

export function cleanJsonText(rawText: string): string {
  let cleaned = rawText.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

async function callGeminiRest(
  payload: {
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig: Record<string, unknown>;
    systemInstruction?: { parts: { text: string }[] };
  },
  model: string,
  apiKey: string
): Promise<{ candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] }> {
  const cleanKey = apiKey.trim().replace(/^["']|["']$/g, "");
  let activeModel = model.trim().replace(/^["']|["']$/g, "");

  // If configured with deprecated model, use current production model
  if (activeModel.includes("2.5") || activeModel.includes("2.0") || activeModel.includes("1.5")) {
    activeModel = "gemini-3.5-flash";
  }

  const makeCall = async (targetModel: string) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": cleanKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      return { status: res.status, ok: res.ok, res };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  try {
    let callRes = await makeCall(activeModel);

    // If 404 is returned because the model is discontinued for new keys, try fast fallback model
    if (callRes.status === 404 && activeModel !== "gemini-3.5-flash") {
      activeModel = "gemini-3.5-flash";
      callRes = await makeCall(activeModel);
    }

    if (!callRes.ok) {
      let errorDetail = "";
      try {
        const errJson = await callRes.res.json();
        errorDetail = errJson?.error?.message ? `: ${errJson.error.message}` : "";
      } catch {
        // ignore
      }
      throw new AiExtractError("CHUNK_FAILED", `Gemini API returned status ${callRes.status}${errorDetail}`);
    }

    const data = await callRes.res.json();
    return data;
  } catch (err: unknown) {
    if (err instanceof AiExtractError) throw err;
    const errName = err instanceof Error ? err.name : "Error";
    const errMsg = err instanceof Error ? err.message : "";
    throw new AiExtractError("CHUNK_FAILED", `Gemini API request failed: ${errName} ${errMsg}`.trim());
  }
}

async function processChunkWithRetry(
  chunk: ChunkPlan,
  caller: CallFn,
  model: string
): Promise<RawAiRow[]> {
  const isFlash = model.toLowerCase().includes("flash");
  const maskedLines = chunk.lines.map(maskSensitiveData).join("\n");

  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 8192,
  };
  if (isFlash) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  let bestRows: RawAiRow[] = [];
  let lastError: Error | null = null;
  let hint = "";

  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      if (lastError && (lastError.message.includes("429") || lastError.message.includes("quota"))) {
        const retryMatch = lastError.message.match(/retry in ([\d.]+)s/i);
        const waitSec = retryMatch ? parseFloat(retryMatch[1]) : 12;
        const sleepMs = Math.min(32000, Math.ceil(waitSec * 1000) + 1200);
        console.log(`[Rate Limit 429] Waiting ${(sleepMs / 1000).toFixed(1)}s for quota window to reset...`);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      } else if (lastError && lastError.message.includes("503")) {
        console.log("[High Demand 503] Pausing 3s before retry...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } else {
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
      }
    }

    try {
      const userText = hint
        ? `${hint}\n\nBank Statement Text Lines:\n${maskedLines}`
        : `Bank Statement Text Lines:\n${maskedLines}`;

      const payload = {
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig,
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      };

      const res = await caller(payload);
      const candidate = res.candidates?.[0];

      if (!candidate || candidate.finishReason === "MAX_TOKENS") {
        throw new AiExtractError("CHUNK_FAILED", "Response hit max tokens or empty candidate");
      }

      // Find the non-thought text part
      let text = "";
      const parts = candidate.content?.parts || [];
      for (const p of parts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p.text && !(p as any).thought) {
          text = p.text;
          break;
        }
      }
      if (!text) {
        text = parts.map((p) => p.text).filter(Boolean).join("") || "";
      }

      if (!text) {
        throw new AiExtractError("CHUNK_FAILED", "Empty text part from model response");
      }

      let parsed: { transactions?: RawAiRow[] };
      try {
        const cleanedJson = cleanJsonText(text);
        parsed = JSON.parse(cleanedJson);
      } catch {
        throw new AiExtractError("CHUNK_FAILED", "Invalid JSON from model");
      }

      const rows = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
      if (rows.length > bestRows.length) {
        bestRows = rows;
      }

      // Check if we retrieved >= 97% of expected anchor lines
      if (chunk.expectedAnchors === 0 || rows.length >= 0.97 * chunk.expectedAnchors) {
        return bestRows;
      }

      hint = `Previous attempt returned ${rows.length} rows but text has about ${chunk.expectedAnchors} date-start lines. Return ALL rows.`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error("Unknown chunk failure");
      console.error(`Chunk attempt ${attempt} error:`, lastError.message);
    }
  }

  if (bestRows.length > 0 || (chunk.expectedAnchors <= 2 && !lastError)) {
    return bestRows;
  }

  throw lastError || new AiExtractError("CHUNK_FAILED", "All retries failed for chunk");
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]);
      // Small pause between sequential chunks to respect free-tier per-minute quotas
      if (nextIndex < items.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

export async function extractWithAi(
  lines: string[],
  opts?: { call?: CallFn; allowFullTextIfNoHeader?: boolean }
): Promise<{
  txns: Txn[];
  quality: AiQuality;
  meta: { model: string; chunks: number };
}> {
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const apiKey = process.env.GEMINI_API_KEY;

  let caller: CallFn;
  if (opts?.call) {
    caller = opts.call;
  } else {
    if (!apiKey) {
      throw new AiExtractError("NO_KEY", "GEMINI_API_KEY environment variable is missing.");
    }
    caller = (payload) => callGeminiRest(payload, model, apiKey);
  }

  const { strippedLines, openingBalance } = stripHeaderLines(
    lines,
    opts?.allowFullTextIfNoHeader
  );

  const chunks = prepareChunks(strippedLines);
  const concurrency = parseInt(process.env.AI_CONCURRENCY || "5", 10) || 5;

  const chunkResults = await runWithConcurrency(chunks, concurrency, (chunk) =>
    processChunkWithRetry(chunk, caller, model)
  );

  // Merge and deduplicate overlapping rows
  const seenKeys = new Set<string>();
  const mergedRows: RawAiRow[] = [];

  for (const rowList of chunkResults) {
    for (const row of rowList) {
      const key = `${row.date}|${row.amount}|${row.balance}|${row.narration}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        mergedRows.push(row);
      }
    }
  }

  if (mergedRows.length === 0) {
    throw new AiExtractError("NO_ROWS", "No transaction rows could be extracted.");
  }

  const totalExpectedAnchors = countExpectedRows(strippedLines);
  const { txns, quality } = normalizeRows(mergedRows, totalExpectedAnchors, openingBalance);

  return {
    txns,
    quality,
    meta: {
      model,
      chunks: chunks.length,
    },
  };
}
