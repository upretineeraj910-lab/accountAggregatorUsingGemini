import { Txn, ObligationResult, ObligationItem } from "../types";
import {
  isObligation,
  INSURANCE_REGEX,
  CASH_DEPOSIT_REGEX,
  LENDER_SUBSTR_REGEX,
} from "../keywords";
import { getMonthInfoList, selectMonthsForAverage } from "./months";

function getMonthKey(date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function calculateMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function extractObligationKey(narration: string): { key: string; label: string } {
  // Check for Loan account format: 6 digits + N + 1 letter + 6+ digits (e.g. 036120NB00000710, TO036120NB00000729)
  const loanAccMatch = narration.match(/(?:TO)?(\d{6}N[A-Z]\d{6,})/i);
  if (loanAccMatch) {
    const acc = loanAccMatch[1].toUpperCase();
    return { key: acc, label: `Loan A/c ${acc}` };
  }

  // Check for ACH/Lender format: ACH/BAJAJ FINANCE LTD
  const achMatch = narration.match(/ACH\/([^\/]+)/i);
  if (achMatch && achMatch[1]) {
    const rawLender = achMatch[1].trim().toUpperCase();
    return { key: rawLender, label: rawLender };
  }

  // Check for glued lender names
  const lenderMatch = narration.match(LENDER_SUBSTR_REGEX);
  if (lenderMatch) {
    // Extract surrounding word or clean token
    const token = lenderMatch[0].toUpperCase();
    return { key: token, label: token };
  }

  return { key: "OTHER_LOAN", label: "Other Loan / EMI" };
}

export function analyzeObligations(txns: Txn[]): ObligationResult {
  const debits = txns.filter((t) => t.debit > 0);
  const deposits = txns.filter((t) => t.credit > 0);

  const insuranceItems: { label: string; amount: number; date: Date }[] = [];
  const obligationDebits: { txn: Txn; key: string; label: string }[] = [];

  for (const t of debits) {
    const n = t.narration;
    // Separate Insurance (e.g. ACH/LIC OF INDIA, STAR HEALTH) from EMIs
    if (INSURANCE_REGEX.test(n)) {
      insuranceItems.push({
        label: n.slice(0, 30),
        amount: t.debit,
        date: t.date,
      });
      continue;
    }

    if (isObligation(n)) {
      const { key, label } = extractObligationKey(n);
      obligationDebits.push({ txn: t, key, label });
    }
  }

  // Group by obligation key
  const byKey = new Map<string, { label: string; txns: Txn[] }>();
  for (const item of obligationDebits) {
    const existing = byKey.get(item.key) || { label: item.label, txns: [] };
    existing.txns.push(item.txn);
    byKey.set(item.key, existing);
  }

  const items: ObligationItem[] = [];
  const partialRecoveries: { key: string; count: number; dates: Date[] }[] = [];

  for (const [key, data] of byKey.entries()) {
    data.txns.sort((a, b) => a.date.getTime() - b.date.getTime());

    const monthlyTotals: Record<string, number> = {};
    for (const t of data.txns) {
      const mKey = getMonthKey(t.date);
      monthlyTotals[mKey] = (monthlyTotals[mKey] || 0) + t.debit;
    }

    const monthTotalsArray = Object.values(monthlyTotals);
    const typicalAmount = Math.round(calculateMedian(monthTotalsArray));
    const lastDate = data.txns[data.txns.length - 1].date;

    items.push({
      key,
      label: data.label,
      monthlyTotals,
      typicalAmount,
      monthsSeen: Object.keys(monthlyTotals).length,
      lastDate,
    });

    // Check Partial Recovery:
    // 2+ debits for same key within 5 days, and after first debit balance <= ₹1
    const pDates: Date[] = [];
    let pCount = 0;

    for (let i = 0; i < data.txns.length - 1; i++) {
      const curr = data.txns[i];
      const next = data.txns[i + 1];
      const daysDiff = (next.date.getTime() - curr.date.getTime()) / (1000 * 60 * 60 * 24);

      if (daysDiff >= 0 && daysDiff <= 5 && curr.balance <= 1.0) {
        pCount++;
        pDates.push(curr.date, next.date);
      }
    }

    if (pCount > 0) {
      partialRecoveries.push({
        key,
        count: pCount,
        dates: Array.from(new Set(pDates.map((d) => d.toISOString()))).map((s) => new Date(s)),
      });
    }
  }

  // Check Cash before EMI:
  // For each obligation debit >= 5000, check if a cash deposit >= 5000 happened in prior 2 days (inclusive of same day)
  let cashBeforeEmiCount = 0;
  const largeEmiDebits = obligationDebits.filter((d) => d.txn.debit >= 5000);

  const cashDeposits = deposits.filter(
    (c) => c.credit >= 5000 && CASH_DEPOSIT_REGEX.test(c.narration)
  );

  for (const emi of largeEmiDebits) {
    const emiTime = emi.txn.date.getTime();
    const hasCashPrior = cashDeposits.some((cd) => {
      const diffMs = emiTime - cd.date.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      return diffDays >= 0 && diffDays <= 2;
    });
    if (hasCashPrior) {
      cashBeforeEmiCount++;
    }
  }

  // Calculate monthlyEmi from complete months if available
  const allMonths = getMonthInfoList(txns);
  const { selectedKeys } = selectMonthsForAverage(allMonths);

  let totalObligationInSelected = 0;
  for (const key of selectedKeys) {
    let monthSum = 0;
    for (const item of items) {
      monthSum += item.monthlyTotals[key] || 0;
    }
    totalObligationInSelected += monthSum;
  }

  const denominator = Math.max(1, selectedKeys.size);
  const monthlyEmi = Math.round(totalObligationInSelected / denominator);

  const totalInsurance = Math.round(insuranceItems.reduce((s, it) => s + it.amount, 0));

  return {
    items,
    monthlyEmi,
    partialRecoveries,
    cashBeforeEmiCount,
    totalEmiDebits: largeEmiDebits.length,
    insuranceItems,
    totalInsurance,
  };
}
