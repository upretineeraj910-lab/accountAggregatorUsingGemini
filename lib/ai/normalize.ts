import { RawAiRow, Txn, AiQuality } from "../types";

/**
 * Matches transaction date anchor lines (optional 1-4 digit serial + day-first date).
 * Ensures footers like "Date: 22/10/2026 ... Page 1" do not match.
 */
export const ANCHOR_LINE_REGEX =
  /^(?:\d{1,4}\s+)?(?:\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}[ \-][A-Za-z]{3}[ \-]\d{2,4})(?=\s|$)/;

export function isAnchorLine(line: string): boolean {
  return ANCHOR_LINE_REGEX.test(line.trim());
}

export function countExpectedRows(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (isAnchorLine(line)) {
      count++;
    }
  }
  return count;
}

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

export function parseDateRobust(dateStr: string): Date | null {
  if (!dateStr || typeof dateStr !== "string") return null;
  const clean = dateStr.trim();

  // 1. YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  let m = clean.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    if (mon >= 0 && mon <= 11 && d >= 1 && d <= 31) {
      return new Date(y, mon, d, 12, 0, 0, 0);
    }
  }

  // 2. DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (Indian standard day-first)
  m = clean.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10) - 1;
    const y = parseInt(m[3], 10);
    if (mon >= 0 && mon <= 11 && d >= 1 && d <= 31) {
      return new Date(y, mon, d, 12, 0, 0, 0);
    }
  }

  // 3. DD/MM/YY or DD-MM-YY (2-digit year)
  m = clean.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10) - 1;
    let y = parseInt(m[3], 10);
    y = y < 70 ? 2000 + y : 1900 + y;
    if (mon >= 0 && mon <= 11 && d >= 1 && d <= 31) {
      return new Date(y, mon, d, 12, 0, 0, 0);
    }
  }

  // 4. DD Mon YYYY or DD-Mon-YYYY (e.g. 01 Jan 2026, 01-MAY-2026)
  m = clean.match(/^(\d{1,2})[ \-.]([A-Za-z]{3})[ \-.](\d{2,4})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const monName = m[2].toLowerCase();
    let y = parseInt(m[3], 10);
    if (y < 100) y = y < 70 ? 2000 + y : 1900 + y;
    const mon = MONTH_MAP[monName];
    if (mon !== undefined && d >= 1 && d <= 31) {
      return new Date(y, mon, d, 12, 0, 0, 0);
    }
  }

  return null;
}

function parseNum(val: unknown): number {
  if (typeof val === "number" && isFinite(val)) return val;
  if (typeof val === "string") {
    const clean = val.replace(/,/g, "").trim();
    const num = parseFloat(clean);
    if (isFinite(num)) return num;
  }
  return NaN;
}

function parseType(val: unknown): "DEBIT" | "CREDIT" | null {
  if (typeof val !== "string") return null;
  const upper = val.trim().toUpperCase();
  if (upper === "DEBIT" || upper === "DR" || upper === "WITHDRAWAL" || upper === "WDL") {
    return "DEBIT";
  }
  if (upper === "CREDIT" || upper === "CR" || upper === "DEPOSIT" || upper === "DEP") {
    return "CREDIT";
  }
  return null;
}

function round2(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

export function normalizeRows(
  raw: RawAiRow[],
  expectedRows: number,
  openingBalance?: number
): { txns: Txn[]; quality: AiQuality } {
  let dropped = 0;
  const valid: { date: Date; narration: string; amount: number; type: "DEBIT" | "CREDIT"; balance: number }[] = [];

  for (const r of raw) {
    if (!r || typeof r !== "object") {
      dropped++;
      continue;
    }
    const d = typeof r.date === "string" ? parseDateRobust(r.date) : null;
    const rawAmt = parseNum(r.amount);
    const rawBal = parseNum(r.balance);
    const amt = isFinite(rawAmt) ? round2(Math.abs(rawAmt)) : NaN;
    const bal = isFinite(rawBal) ? round2(rawBal) : NaN;
    const type = parseType(r.type);
    const narr = typeof r.narration === "string" ? r.narration.trim() : "";

    if (!d || isNaN(amt) || isNaN(bal) || !type) {
      dropped++;
      continue;
    }

    valid.push({
      date: d,
      narration: narr,
      amount: amt,
      type,
      balance: bal,
    });
  }

  // Reverse if newest-first (e.g. PNB statement where first date > last date)
  if (valid.length >= 2) {
    const firstTime = valid[0].date.getTime();
    const lastTime = valid[valid.length - 1].date.getTime();
    if (firstTime > lastTime) {
      valid.reverse();
    }
  }

  let chainMismatches = 0;
  let flippedByChain = 0;
  let firstRowUncertain = false;

  const txns: Txn[] = [];

  for (let i = 0; i < valid.length; i++) {
    const row = valid[i];
    let debit = row.type === "DEBIT" ? row.amount : 0;
    let credit = row.type === "CREDIT" ? row.amount : 0;

    if (i === 0) {
      if (typeof openingBalance === "number" && isFinite(openingBalance)) {
        const diff = round2(row.balance - openingBalance);
        if (Math.abs(diff - row.amount) <= 0.02) {
          if (row.type !== "CREDIT") {
            credit = row.amount;
            debit = 0;
            flippedByChain++;
          }
        } else if (Math.abs(diff + row.amount) <= 0.02) {
          if (row.type !== "DEBIT") {
            debit = row.amount;
            credit = 0;
            flippedByChain++;
          }
        } else {
          chainMismatches++;
        }
      } else {
        firstRowUncertain = true;
      }
    } else {
      const prev = txns[i - 1];
      const diff = round2(row.balance - prev.balance);
      if (Math.abs(diff - row.amount) <= 0.02) {
        // Must be CREDIT
        if (row.type !== "CREDIT") {
          credit = row.amount;
          debit = 0;
          flippedByChain++;
        }
      } else if (Math.abs(diff + row.amount) <= 0.02) {
        // Must be DEBIT
        if (row.type !== "DEBIT") {
          debit = row.amount;
          credit = 0;
          flippedByChain++;
        }
      } else {
        // Neither matches: balance jump / missed row
        chainMismatches++;
      }
    }

    txns.push({
      date: row.date,
      narration: row.narration,
      debit,
      credit,
      balance: row.balance,
    });
  }

  const rows = txns.length;
  const mismatchRatio = rows > 0 ? chainMismatches / rows : 1;
  const expectedDiffRatio = expectedRows > 0 ? Math.abs(rows - expectedRows) / expectedRows : 0;
  const notes: string[] = [];

  if (rows < 5) {
    notes.push(`Rows extracted (${rows}) is less than minimum required (5).`);
  }
  if (mismatchRatio > 0.02) {
    notes.push(
      `Balance chain mismatches (${chainMismatches}/${rows}, ${(mismatchRatio * 100).toFixed(1)}%) exceeded 2% threshold.`
    );
  }
  if (expectedRows > 0 && expectedDiffRatio > 0.03) {
    notes.push(
      `Extracted row count (${rows}) differs from expected anchor rows (${expectedRows}) by ${(expectedDiffRatio * 100).toFixed(1)}% (>3%).`
    );
  }
  if (dropped > 0) {
    notes.push(`${dropped} invalid raw row(s) were dropped.`);
  }
  if (flippedByChain > 0) {
    notes.push(`${flippedByChain} row direction(s) corrected via balance chain verification.`);
  }
  if (firstRowUncertain) {
    notes.push("Opening balance was not specified; first row direction could not be verified by chain.");
  }

  const ok = rows >= 5 && mismatchRatio <= 0.02 && (expectedRows === 0 || expectedDiffRatio <= 0.03);

  const quality: AiQuality = {
    ok,
    rows,
    expectedRows,
    dropped,
    chainMismatches,
    flippedByChain,
    firstRowUncertain,
    notes,
  };

  return { txns, quality };
}
