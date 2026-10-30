import { Txn, SalaryResult } from "../types";
import {
  SALARY_REGEX,
  CASH_DEPOSIT_REGEX,
  REFUND_REGEX,
  INTEREST_REGEX,
} from "../keywords";
import { getMonthInfoList, selectMonthsForAverage } from "./months";

function getMonthKey(date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function extractSenderKey(narration: string, holderName?: string): string | null {
  // UPI is strictly not salary
  if (/^UPI[\/:]/i.test(narration)) return null;

  // Split narration by / or -
  const segments = narration.split(/[\/\-:]+/).map((s) => s.trim());

  let bestSegment: string | null = null;
  let maxAlpha = 0;

  for (const seg of segments) {
    if (!seg || seg.length < 3) continue;

    // Discard digits-heavy / UTR / code segments (e.g. N12345678, 20261030, CMS)
    const digitsCount = (seg.match(/\d/g) || []).length;
    if (digitsCount > seg.length * 0.4) continue;

    // Discard known banking protocol prefixes
    if (/^(NEFT|RTGS|IMPS|INB|INF|CMS|TRANSFER|CR|DR|BY|TO|REV|RET)$/i.test(seg)) {
      continue;
    }

    const alphaCount = (seg.match(/[A-Za-z]/g) || []).length;
    const alphaRatio = alphaCount / seg.length;

    if (alphaRatio >= 0.6 && alphaCount > maxAlpha) {
      // Check holder name exclusion
      if (holderName && holderName.trim().length >= 3) {
        const tokens = holderName.trim().toUpperCase().split(/\s+/);
        const segUpper = seg.toUpperCase();
        const matchesHolder = tokens.some(
          (t) => t.length >= 4 && segUpper.includes(t)
        );
        if (matchesHolder) continue;
      }

      maxAlpha = alphaCount;
      bestSegment = seg.toUpperCase();
    }
  }

  return bestSegment;
}

function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function detectSalary(
  txns: Txn[],
  opts?: {
    holderName?: string;
    excludedCreditKeys?: Set<string>;
    manualSalary?: number;
  }
): SalaryResult {
  const holderName = opts?.holderName;
  const excludedKeys = opts?.excludedCreditKeys;
  const manualSalary = opts?.manualSalary;

  // If manual salary override is given
  if (typeof manualSalary === "number" && manualSalary > 0) {
    const credits = txns.filter((t) => t.credit > 0);
    return {
      credits,
      avgSalary: Math.round(manualSalary),
      months: 1,
      method: "keyword",
      extraCredits: [],
      monthlyCredits: {},
      sender: "Manual Override",
    };
  }

  const allMonths = getMonthInfoList(txns);
  const totalMonthsCount = Math.max(1, allMonths.length);

  // Filter candidate credits
  // Strict: UPI, Cash, Refund, Interest are NEVER salary
  const eligibleCredits = txns.filter((t, idx) => {
    if (t.credit <= 0) return false;
    const key = `${t.date.toISOString()}_${t.credit}_${idx}`;
    if (excludedKeys && excludedKeys.has(key)) return false;

    const narr = t.narration;
    if (
      /^UPI[\/:]/i.test(narr) ||
      CASH_DEPOSIT_REGEX.test(narr) ||
      REFUND_REGEX.test(narr) ||
      INTEREST_REGEX.test(narr)
    ) {
      return false;
    }
    return true;
  });

  // Step A: Keyword Match
  const keywordMatched = eligibleCredits.filter((t) => SALARY_REGEX.test(t.narration));
  const keywordMonths = new Set(keywordMatched.map((t) => getMonthKey(t.date)));

  let chosenCredits: Txn[] = [];
  let method: "keyword" | "recurring" | "none" = "none";
  let detectedSender: string | undefined;

  if (keywordMonths.size >= 2) {
    chosenCredits = keywordMatched;
    method = "keyword";
  } else {
    // Step B: Recurring matching (amount >= 5000, consistent employer/sender)
    const recurringEligible = eligibleCredits.filter((t) => {
      if (t.credit < 5000) return false;
      // Exclude obvious non-corporate deposits
      const narr = t.narration;
      if (/^(?:UPI[\/:]|CASH|ATM|CDM|BY CASH)/i.test(narr)) return false;
      return true;
    });

    // Group by senderKey
    const bySender = new Map<string, Txn[]>();
    for (const t of recurringEligible) {
      const sender = extractSenderKey(t.narration, holderName);
      if (!sender) continue;
      const list = bySender.get(sender) || [];
      list.push(t);
      bySender.set(sender, list);
    }

    let bestSender: string | null = null;
    let bestTotal = 0;
    let bestList: Txn[] = [];

    const minMonthsRequired = totalMonthsCount === 1 ? 1 : 2;

    for (const [sender, list] of bySender.entries()) {
      const distinctMonths = new Set(list.map((t) => getMonthKey(t.date)));
      // Candidate: >= minMonthsRequired, >= 50% of total months
      if (
        distinctMonths.size >= minMonthsRequired &&
        distinctMonths.size >= Math.ceil(totalMonthsCount * 0.5)
      ) {
        const amounts = list.map((t) => t.credit);
        const med = calculateMedian(amounts);
        const withinBounds = list.filter(
          (t) => Math.abs(t.credit - med) <= 0.4 * med
        );
        // amount within median +/- 40% in >= 60% of months seen
        if (withinBounds.length >= Math.ceil(list.length * 0.6)) {
          const totalAmt = list.reduce((sum, t) => sum + t.credit, 0);
          if (totalAmt > bestTotal) {
            bestTotal = totalAmt;
            bestSender = sender;
            bestList = list;
          }
        }
      }
    }

    if (bestSender && bestList.length > 0) {
      // Gather all credits from bestSender across all eligibleCredits (including < 5000)
      const allFromSender = eligibleCredits.filter((t) => {
        const sender = extractSenderKey(t.narration, holderName);
        return sender === bestSender;
      });
      chosenCredits = allFromSender.length > 0 ? allFromSender : bestList;
      method = "recurring";
      detectedSender = bestSender;
    } else if (keywordMatched.length > 0) {
      // Fallback to keyword match even if 1 month
      chosenCredits = keywordMatched;
      method = "keyword";
    }
  }

  if (chosenCredits.length === 0) {
    return {
      credits: [],
      avgSalary: 0,
      months: 0,
      method: "none",
      extraCredits: [],
      monthlyCredits: {},
    };
  }

  // Step C: Per-month largest salary credit + separate outliers (arrears/bonus)
  // Group chosenCredits by month
  const byMonth = new Map<string, Txn[]>();
  for (const t of chosenCredits) {
    const mKey = getMonthKey(t.date);
    const list = byMonth.get(mKey) || [];
    list.push(t);
    byMonth.set(mKey, list);
  }

  const monthlyHighest: Txn[] = [];
  const monthlyExtra: Txn[] = [];

  for (const list of byMonth.values()) {
    // Sort descending by credit amount
    list.sort((a, b) => b.credit - a.credit);
    monthlyHighest.push(list[0]);
    for (let i = 1; i < list.length; i++) {
      monthlyExtra.push(list[i]);
    }
  }

  // Compute median of monthly highest
  const baseAmounts = monthlyHighest.map((t) => t.credit);
  const medianSalary = calculateMedian(baseAmounts);

  const regularCredits: Txn[] = [];
  const extraCredits: Txn[] = [...monthlyExtra];

  for (const t of monthlyHighest) {
    // If credit is outside median +/- 40%, treat as arrears/bonus
    if (Math.abs(t.credit - medianSalary) > 0.4 * medianSalary) {
      extraCredits.push(t);
    } else {
      regularCredits.push(t);
    }
  }

  // If all were deemed outside median, keep monthlyHighest
  const finalSalaryCredits = regularCredits.length > 0 ? regularCredits : monthlyHighest;

  const monthlyCredits: Record<string, number> = {};
  for (const t of finalSalaryCredits) {
    const mKey = getMonthKey(t.date);
    monthlyCredits[mKey] = t.credit;
  }

  const avgSalary =
    finalSalaryCredits.length > 0
      ? Math.round(
          finalSalaryCredits.reduce((s, t) => s + t.credit, 0) / finalSalaryCredits.length
        )
      : 0;

  return {
    credits: finalSalaryCredits,
    avgSalary,
    months: Object.keys(monthlyCredits).length,
    method,
    extraCredits,
    sender: detectedSender,
    monthlyCredits,
  };
}
