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

function parseYMD(dateStr: string): Date | null {
  const clean = dateStr.trim();
  const m = clean.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  // Use noon (12:00) so timezone shifts don't change the calendar day
  const d = new Date(year, month, day, 12, 0, 0, 0);
  if (isNaN(d.getTime())) return null;
  return d;
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
    const d = typeof r.date === "string" ? parseYMD(r.date) : null;
    const amt = typeof r.amount === "number" && isFinite(r.amount) ? round2(Math.abs(r.amount)) : NaN;
    const bal = typeof r.balance === "number" && isFinite(r.balance) ? round2(r.balance) : NaN;
    const type = r.type === "DEBIT" || r.type === "CREDIT" ? r.type : null;
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
