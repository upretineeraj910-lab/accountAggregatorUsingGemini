import { Txn, BalancesResult } from "../types";
import { getMonthInfoList } from "./months";

function calculateMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function analyzeBalances(
  txns: Txn[],
  salaryCredits: Txn[]
): BalancesResult {
  if (txns.length === 0) {
    return {
      medianDailyBalance: 0,
      minBalance: 0,
      daysAtOrBelow500: 0,
      monthEndAvgBalance: 0,
      avgTxnBalance: 0,
      preSalaryBalances: [],
      avgPreSalaryBalance: 0,
      passThroughPct: 0,
      passThroughMonthsCount: 0,
      salaryRegularity: 0,
    };
  }

  // Ensure chronologically sorted
  const sorted = [...txns].sort((a, b) => a.date.getTime() - b.date.getTime());

  // 1. Min Balance & Avg Txn Balance
  let minBalance = sorted[0].balance;
  let txnBalanceSum = 0;
  for (const t of sorted) {
    if (t.balance < minBalance) {
      minBalance = t.balance;
    }
    txnBalanceSum += t.balance;
  }
  const avgTxnBalance = Math.round(txnBalanceSum / sorted.length);

  // 2. Daily End-of-Day balances (calendar days)
  const firstDate = new Date(sorted[0].date);
  const lastDate = new Date(sorted[sorted.length - 1].date);

  // Group latest balance for each calendar day that has txns
  const dayBalanceMap = new Map<string, number>();
  for (const t of sorted) {
    const dayKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}-${String(t.date.getDate()).padStart(2, "0")}`;
    dayBalanceMap.set(dayKey, t.balance);
  }

  const dailyBalances: number[] = [];
  let daysAtOrBelow500 = 0;
  let currentRunningBalance = sorted[0].balance;

  const cur = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate(), 12, 0, 0);
  const end = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate(), 12, 0, 0);

  // Map to collect month-end balance
  const monthEndBalances = new Map<string, number>();

  while (cur.getTime() <= end.getTime()) {
    const dayKey = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    if (dayBalanceMap.has(dayKey)) {
      currentRunningBalance = dayBalanceMap.get(dayKey)!;
    }

    dailyBalances.push(currentRunningBalance);
    if (currentRunningBalance <= 500) {
      daysAtOrBelow500++;
    }

    // Save as current candidate for this month's end balance
    const mKey = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
    monthEndBalances.set(mKey, currentRunningBalance);

    cur.setDate(cur.getDate() + 1);
  }

  const medianDailyBalance = Math.round(calculateMedian(dailyBalances));

  const monthEndValues = Array.from(monthEndBalances.values());
  const monthEndAvgBalance =
    monthEndValues.length > 0
      ? Math.round(monthEndValues.reduce((s, v) => s + v, 0) / monthEndValues.length)
      : 0;

  // 3. Pre-Salary Balance
  // Balance immediately before each salary credit
  const preSalaryBalances: { date: Date; balance: number }[] = [];
  for (const sc of salaryCredits) {
    const scIdx = sorted.findIndex((t) => t === sc);
    let preBal = 0;
    if (scIdx > 0) {
      preBal = sorted[scIdx - 1].balance;
    } else {
      // If it's the very first txn, balance before it is balance - credit
      preBal = Math.max(0, sc.balance - sc.credit);
    }
    preSalaryBalances.push({ date: sc.date, balance: preBal });
  }

  const avgPreSalaryBalance =
    preSalaryBalances.length > 0
      ? Math.round(
          preSalaryBalances.reduce((s, p) => s + p.balance, 0) / preSalaryBalances.length
        )
      : 0;

  // 4. Pass-through Pct
  // For each salary credit, within 3 calendar days, sum debits. If debits >= 90% of salary credit, pass-through month.
  let passThroughMonthsCount = 0;

  for (const sc of salaryCredits) {
    const scTime = sc.date.getTime();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    let postDebits = 0;
    for (const t of sorted) {
      if (t.debit <= 0) continue;
      const diffMs = t.date.getTime() - scTime;
      if (diffMs >= 0 && diffMs <= threeDaysMs) {
        postDebits += t.debit;
      }
    }

    if (postDebits >= 0.9 * sc.credit) {
      passThroughMonthsCount++;
    }
  }

  const totalSalaryCreditsCount = salaryCredits.length;
  const passThroughPct =
    totalSalaryCreditsCount > 0
      ? Math.round((passThroughMonthsCount / totalSalaryCreditsCount) * 100)
      : 0;

  // 5. Salary Regularity
  const monthList = getMonthInfoList(txns);
  const totalMonths = Math.max(1, monthList.length);
  const salaryRegularity =
    Number((totalSalaryCreditsCount / totalMonths).toFixed(2));

  return {
    medianDailyBalance,
    minBalance: Math.round(minBalance),
    daysAtOrBelow500,
    monthEndAvgBalance,
    avgTxnBalance,
    preSalaryBalances,
    avgPreSalaryBalance,
    passThroughPct,
    passThroughMonthsCount,
    salaryRegularity,
  };
}
