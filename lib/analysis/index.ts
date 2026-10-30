import {
  Txn,
  AnalysisResult,
  FactorItem,
  MonthlyBreakdown,
  CounterpartyItem,
} from "../types";
import {
  BOUNCE_REGEX,
  BETTING_REGEX,
  LOAN_APP_REGEX,
  CASH_DEPOSIT_REGEX,
  CASH_WITHDRAWAL_REGEX,
  WALLET_REGEX,
  CC_PAYMENT_REGEX,
  CARD_LIKE_REGEX,
  BROKER_REGEX,
  MF_SIP_REGEX,
} from "../keywords";
import { getMonthInfoList, selectMonthsForAverage } from "./months";
import { detectSalary } from "./salary";
import { analyzeObligations } from "./obligations";
import { classifyOtherCredits } from "./otherCredits";
import { detectRoundTrips } from "./roundTrip";
import { analyzeBalances } from "./balances";
import {
  topCounterparties,
  findLargeDebitsToOthers,
  findUnclassifiedLargeDebits,
} from "./counterparty";

export const CONFIG = {
  deductions: {
    bounce: -25,
    foirHigh: -35, // > 55%
    foirMid: -20, // > 45%
    foirLow: -10, // > 35%
    betting: -20,
    cashHigh: -10, // > 40%
    medianBalLowCritical: -15, // < 10%
    medianBalLow: -8, // < 20%
    passThroughHigh: -20, // >= 80%
    passThroughMid: -10, // >= 50%
    salaryIrregular: -15, // < 0.7
    lendingApps: -15,
    oneOffCredit: -5, // max -10
    partialEmiRecovery: -10,
    marketHeavy: -15,
    marketNetLoss: -10,
    marketActive: -5,
    walletHeavy: -10,
    roundTrip: -10,
    creditCardHeavy: -10, // >= 40%
    noSalary: -20,
  },
  hardCaps: {
    passThroughHigh: 69,
    foirHigh: 49,
    bounce: 59,
    insufficientDataOrQuality: 74,
  },
};

export function analyze(
  txns: Txn[],
  opts?: {
    holderName?: string;
    accountNo?: string;
    excludedSalaryIds?: Set<string>;
    manualSalary?: number;
    parseQualityOk?: boolean;
    marketAffectsScore?: boolean;
    walletAffectsScore?: boolean;
  }
): AnalysisResult {
  const holderName = opts?.holderName;
  const accountNo = opts?.accountNo;
  const excludedSalaryIds = opts?.excludedSalaryIds;
  const manualSalary = opts?.manualSalary;
  const parseQualityOk = opts?.parseQualityOk ?? true;
  const marketAffectsScore = opts?.marketAffectsScore ?? true;
  const walletAffectsScore = opts?.walletAffectsScore ?? true;

  // Chronologically sort txns
  const sorted = [...txns].sort((a, b) => a.date.getTime() - b.date.getTime());

  // 1. Months handling
  const allMonths = getMonthInfoList(sorted);
  const { selectedKeys, monthsUsed } = selectMonthsForAverage(allMonths);
  const totalMonthsCount = Math.max(1, allMonths.length);

  // 2. Salary Detection
  const salary = detectSalary(sorted, {
    holderName,
    excludedCreditKeys: excludedSalaryIds,
    manualSalary,
  });

  const salaryCreditSet = new Set(salary.credits);
  const isSalaryIdentified = salary.avgSalary > 0;

  // 3. Obligations Analysis
  const obligations = analyzeObligations(sorted);

  // 4. Fallback for FOIR if salary not identified
  let effectiveSalaryForFoir = salary.avgSalary;
  let foirReason = "";

  // 5. Credits Classification
  const creditsResult = classifyOtherCredits(
    sorted,
    salaryCreditSet,
    salary.avgSalary,
    holderName,
    accountNo
  );

  if (!isSalaryIdentified) {
    // Fallback: average monthly credits excluding self transfers
    const nonSelfCredits = creditsResult.realAdjustedCredit;
    const avgMonthlyCreditExSelf = Math.round(nonSelfCredits / totalMonthsCount);
    effectiveSalaryForFoir = Math.max(1, avgMonthlyCreditExSelf);
    foirReason = "Salary pehchani nahi gayi (Fallback: inflow excluding self-transfer)";
  }

  const foir =
    effectiveSalaryForFoir > 0
      ? Math.round((obligations.monthlyEmi / effectiveSalaryForFoir) * 100)
      : 0;

  // 6. Balances & Risk
  const balances = analyzeBalances(sorted, salary.credits);

  // 7. Round Trip
  const roundTrip = detectRoundTrips(sorted);

  // 8. Market Activity
  let brokerInvested = 0;
  let brokerWithdrawn = 0;
  let brokerTransfers = 0;
  let sipTotal = 0;

  for (const t of sorted) {
    const isBroker = BROKER_REGEX.test(t.narration);
    const isSip = MF_SIP_REGEX.test(t.narration);

    if (isBroker || isSip) {
      if (t.debit > 0) {
        brokerInvested += t.debit;
        brokerTransfers++;
        if (isSip) sipTotal += t.debit;
      }
      if (t.credit > 0) {
        brokerWithdrawn += t.credit;
        brokerTransfers++;
      }
    }
  }

  const brokerNet = brokerInvested - brokerWithdrawn;
  const isMarketActive = brokerTransfers >= 6;
  const monthlyInvested = brokerInvested / totalMonthsCount;
  const isMarketHeavy =
    salary.avgSalary > 0 && monthlyInvested > 0.3 * salary.avgSalary;

  const market = {
    invested: Math.round(brokerInvested),
    withdrawn: Math.round(brokerWithdrawn),
    net: Math.round(brokerNet),
    transfers: brokerTransfers,
    sip: Math.round(sipTotal),
    isActive: isMarketActive,
    isHeavy: isMarketHeavy,
  };

  // 9. Bounces, Betting, Lending Apps, Cards, Cash
  const bounces: { date: Date; amount: number; narration: string }[] = [];
  let bettingCount = 0;
  let lendingAppsCount = 0;
  let lendingAppsTotal = 0;
  let ccPaymentTotal = 0;
  let cardLikeTotal = 0;

  let cashDepositTotal = 0;
  let cashDepositCount = 0;
  const cashByMonth: Record<string, number> = {};

  let cashWithdrawalTotal = 0;
  let cashWithdrawalCount = 0;

  let walletIn = 0;
  let walletOut = 0;

  let totalCredits = 0;
  let totalDebits = 0;

  for (const t of sorted) {
    if (t.credit > 0) totalCredits += t.credit;
    if (t.debit > 0) totalDebits += t.debit;

    const n = t.narration;

    // Bounce
    if (BOUNCE_REGEX.test(n)) {
      bounces.push({ date: t.date, amount: t.debit || t.credit, narration: n });
    }

    // Betting
    if (BETTING_REGEX.test(n)) {
      bettingCount++;
    }

    // Lending app
    if (LOAN_APP_REGEX.test(n)) {
      lendingAppsCount++;
      if (t.credit > 0) lendingAppsTotal += t.credit;
    }

    // CC payment
    if (t.debit > 0 && CC_PAYMENT_REGEX.test(n)) {
      ccPaymentTotal += t.debit;
    }

    // Card-like
    if (t.debit > 0 && CARD_LIKE_REGEX.test(n)) {
      cardLikeTotal += t.debit;
    }

    // Cash deposit
    if (t.credit > 0 && CASH_DEPOSIT_REGEX.test(n)) {
      cashDepositTotal += t.credit;
      cashDepositCount++;
      const mKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
      cashByMonth[mKey] = (cashByMonth[mKey] || 0) + t.credit;
    }

    // Cash withdrawal
    if (t.debit > 0 && CASH_WITHDRAWAL_REGEX.test(n)) {
      cashWithdrawalTotal += t.debit;
      cashWithdrawalCount++;
    }

    // Wallet
    if (WALLET_REGEX.test(n)) {
      if (t.credit > 0) walletIn += t.credit;
      if (t.debit > 0) walletOut += t.debit;
    }
  }

  const cashPctOfCredits =
    totalCredits > 0 ? Math.round((cashDepositTotal / totalCredits) * 100) : 0;

  const walletCreditPct =
    totalCredits > 0 ? Math.round((walletIn / totalCredits) * 100) : 0;
  const walletDebitPct =
    totalDebits > 0 ? Math.round((walletOut / totalDebits) * 100) : 0;

  // One-off non-salary credits >= 2x salary
  const oneOffCredits = sorted.filter(
    (t) =>
      t.credit > 0 &&
      !salaryCreditSet.has(t) &&
      salary.avgSalary > 0 &&
      t.credit >= 2 * salary.avgSalary
  );

  // 10. Scoring Calculation & Deductions
  let score = 100;
  const factors: FactorItem[] = [];

  // Bounces
  if (bounces.length > 0) {
    score += CONFIG.deductions.bounce;
    factors.push({
      type: "negative",
      text: `Inward/Outward check or EMI bounce detected (${bounces.length} event(s))`,
      points: CONFIG.deductions.bounce,
    });
  } else {
    factors.push({
      type: "positive",
      text: "No cheque, ACH, or NACH returns/bounces detected",
    });
  }

  // FOIR
  if (foir > 55) {
    score += CONFIG.deductions.foirHigh;
    factors.push({
      type: "negative",
      text: `High debt burden: FOIR is ${foir}% (>55%)`,
      points: CONFIG.deductions.foirHigh,
    });
  } else if (foir > 45) {
    score += CONFIG.deductions.foirMid;
    factors.push({
      type: "negative",
      text: `Moderate-high debt burden: FOIR is ${foir}% (>45%)`,
      points: CONFIG.deductions.foirMid,
    });
  } else if (foir > 35) {
    score += CONFIG.deductions.foirLow;
    factors.push({
      type: "negative",
      text: `Elevated debt burden: FOIR is ${foir}% (>35%)`,
      points: CONFIG.deductions.foirLow,
    });
  } else if (isSalaryIdentified) {
    factors.push({
      type: "positive",
      text: `Comfortable debt obligation: FOIR is ${foir}% (<=35%)`,
    });
  }

  if (foirReason) {
    factors.push({
      type: "info",
      text: foirReason,
    });
  }

  // Salary identified or missing
  if (!isSalaryIdentified) {
    score += CONFIG.deductions.noSalary;
    factors.push({
      type: "negative",
      text: "Salary credits not identified through keywords or recurring patterns",
      points: CONFIG.deductions.noSalary,
    });
  } else {
    // Salary regularity
    if (balances.salaryRegularity < 0.7) {
      score += CONFIG.deductions.salaryIrregular;
      factors.push({
        type: "negative",
        text: `Irregular salary frequency (present in only ${(balances.salaryRegularity * 100).toFixed(0)}% of months)`,
        points: CONFIG.deductions.salaryIrregular,
      });
    } else if (balances.salaryRegularity >= 0.9) {
      factors.push({
        type: "positive",
        text: "Consistent monthly salary receipt across the statement period",
      });
    }
  }

  // Pass-through
  if (balances.passThroughPct >= 80) {
    score += CONFIG.deductions.passThroughHigh;
    factors.push({
      type: "negative",
      text: `Severe pass-through behavior (${balances.passThroughPct}% of salary drained within 3 days)`,
      points: CONFIG.deductions.passThroughHigh,
    });
  } else if (balances.passThroughPct >= 50) {
    score += CONFIG.deductions.passThroughMid;
    factors.push({
      type: "negative",
      text: `Moderate pass-through behavior (${balances.passThroughPct}% of salary drained within 3 days)`,
      points: CONFIG.deductions.passThroughMid,
    });
  }

  // Median Daily Balance
  if (salary.avgSalary > 0) {
    const ratio = balances.medianDailyBalance / salary.avgSalary;
    if (ratio < 0.1) {
      score += CONFIG.deductions.medianBalLowCritical;
      factors.push({
        type: "negative",
        text: `Critically low median daily balance (₹${balances.medianDailyBalance.toLocaleString("en-IN")}, <10% of salary)`,
        points: CONFIG.deductions.medianBalLowCritical,
      });
    } else if (ratio < 0.2) {
      score += CONFIG.deductions.medianBalLow;
      factors.push({
        type: "negative",
        text: `Low median daily balance (₹${balances.medianDailyBalance.toLocaleString("en-IN")}, <20% of salary)`,
        points: CONFIG.deductions.medianBalLow,
      });
    } else if (ratio >= 0.3) {
      factors.push({
        type: "positive",
        text: `Healthy median daily balance buffer (₹${balances.medianDailyBalance.toLocaleString("en-IN")}, >=30% of salary)`,
      });
    }
  }

  // Lending Apps
  if (lendingAppsCount > 0) {
    score += CONFIG.deductions.lendingApps;
    factors.push({
      type: "negative",
      text: `Fintech instant loan app transactions detected (${lendingAppsCount} txn(s))`,
      points: CONFIG.deductions.lendingApps,
    });
  }

  // Betting
  if (bettingCount > 0) {
    score += CONFIG.deductions.betting;
    factors.push({
      type: "negative",
      text: `Gaming / betting platforms detected (${bettingCount} txn(s))`,
      points: CONFIG.deductions.betting,
    });
  }

  // Cash deposits > 40%
  if (cashPctOfCredits > 40) {
    score += CONFIG.deductions.cashHigh;
    factors.push({
      type: "negative",
      text: `High cash deposit ratio (${cashPctOfCredits}% of total credit inflows)`,
      points: CONFIG.deductions.cashHigh,
    });
  }

  // Partial EMI Recovery
  if (obligations.partialRecoveries.length > 0) {
    score += CONFIG.deductions.partialEmiRecovery;
    factors.push({
      type: "negative",
      text: `Partial EMI recovery on due date due to insufficient balance (${obligations.partialRecoveries.length} loan(s))`,
      points: CONFIG.deductions.partialEmiRecovery,
    });
  }

  // Market speculative trading
  if (marketAffectsScore) {
    if (market.isHeavy) {
      score += CONFIG.deductions.marketHeavy;
      factors.push({
        type: "negative",
        text: "Heavy speculative market turnover (>30% of monthly salary invested)",
        points: CONFIG.deductions.marketHeavy,
      });
    }
    if (salary.avgSalary > 0 && market.net > salary.avgSalary) {
      score += CONFIG.deductions.marketNetLoss;
      factors.push({
        type: "negative",
        text: "High net outflow into stock trading / derivatives (>1x salary)",
        points: CONFIG.deductions.marketNetLoss,
      });
    }
    if (market.isActive) {
      score += CONFIG.deductions.marketActive;
      factors.push({
        type: "negative",
        text: `Active trading account movements (${market.transfers} transfers)`,
        points: CONFIG.deductions.marketActive,
      });
    }
  }

  // Wallet
  if (walletAffectsScore) {
    if (walletCreditPct > 30 || walletDebitPct > 30) {
      score += CONFIG.deductions.walletHeavy;
      factors.push({
        type: "negative",
        text: `High wallet rotation (>30% of credits or debits)`,
        points: CONFIG.deductions.walletHeavy,
      });
    }
  }

  // Round trip
  if (roundTrip.suspected) {
    score += CONFIG.deductions.roundTrip;
    factors.push({
      type: "negative",
      text: `Suspected round-trip / circular fund routing (${roundTrip.count} matched pairs, ₹${roundTrip.volume.toLocaleString("en-IN")})`,
      points: CONFIG.deductions.roundTrip,
    });
  }

  // Credit Card repayments >= 40% of credits
  if (totalCredits > 0 && (ccPaymentTotal / totalCredits) >= 0.4) {
    score += CONFIG.deductions.creditCardHeavy;
    factors.push({
      type: "negative",
      text: `Heavy credit card bill servicing (>=40% of credit inflows)`,
      points: CONFIG.deductions.creditCardHeavy,
    });
  }

  // One-off credits
  if (oneOffCredits.length > 0) {
    const penalty = Math.min(10, oneOffCredits.length * 5);
    score -= penalty;
    factors.push({
      type: "negative",
      text: `Large one-off credit inflows detected (${oneOffCredits.length} txn(s) >= 2x salary)`,
      points: -penalty,
    });
  }

  // Informational factors
  if (obligations.totalInsurance > 0) {
    factors.push({
      type: "info",
      text: `Insurance policy servicing detected (Total ₹${obligations.totalInsurance.toLocaleString("en-IN")})`,
    });
  }

  if (obligations.cashBeforeEmiCount > 0) {
    factors.push({
      type: "info",
      text: `Cash deposited within 2 days prior to EMI debit: ${obligations.cashBeforeEmiCount}/${obligations.totalEmiDebits} times`,
    });
  }

  const unclassifiedLarge = findUnclassifiedLargeDebits(sorted, holderName, accountNo);
  if (unclassifiedLarge.length > 0) {
    factors.push({
      type: "info",
      text: `Unclassified large debits requiring verification (${unclassifiedLarge.length} txn(s)) — client se poochho`,
    });
  }

  // Hard caps
  if (balances.passThroughPct >= 80) {
    score = Math.min(score, CONFIG.hardCaps.passThroughHigh);
  }
  if (foir > 55) {
    score = Math.min(score, CONFIG.hardCaps.foirHigh);
  }
  if (bounces.length > 0) {
    score = Math.min(score, CONFIG.hardCaps.bounce);
  }
  if (marketAffectsScore && market.isHeavy) {
    score = Math.min(score, 74);
  }
  if (walletAffectsScore && (walletCreditPct > 30 || walletDebitPct > 30)) {
    score = Math.min(score, 74);
  }
  if (totalMonthsCount < 3 || sorted.length < 15 || !parseQualityOk) {
    score = Math.min(score, CONFIG.hardCaps.insufficientDataOrQuality);
    factors.push({
      type: "info",
      text: "Data kam/parsing pakki nahi, score indicative hai",
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: "Strong" | "Average" | "Weak";
  if (score >= 75) {
    verdict = "Strong";
  } else if (score >= 50) {
    verdict = "Average";
  } else {
    verdict = "Weak";
  }

  const salaryShareLow =
    salary.credits.length > 0 && creditsResult.salaryPct < 40;

  // Monthly breakdown
  const monthlyMap = new Map<string, { credit: number; debit: number; closing: number }>();
  for (const m of allMonths) {
    monthlyMap.set(m.key, { credit: 0, debit: 0, closing: 0 });
  }

  for (const t of sorted) {
    const mKey = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
    const curr = monthlyMap.get(mKey);
    if (curr) {
      if (t.credit > 0) curr.credit += t.credit;
      if (t.debit > 0) curr.debit += t.debit;
      curr.closing = t.balance;
    }
  }

  const monthly: MonthlyBreakdown[] = allMonths.map((m) => {
    const data = monthlyMap.get(m.key) || { credit: 0, debit: 0, closing: 0 };
    return {
      monthKey: m.key,
      label: m.label,
      credit: Math.round(data.credit),
      debit: Math.round(data.debit),
      closingBalance: Math.round(data.closing),
      isPartial: m.isPartial,
    };
  });

  const startDate = sorted[0]?.date || new Date();
  const endDate = sorted[sorted.length - 1]?.date || new Date();
  const totalDays = Math.max(
    1,
    Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  );

  return {
    score,
    verdict,
    factors,
    foir,
    currentEmi: obligations.monthlyEmi,
    avgSalary: salary.avgSalary,
    isSalaryIdentified,
    salaryShareLow,
    salary,
    obligations,
    credits: creditsResult,
    balances,
    roundTrip,
    risks: {
      passThrough: balances.passThroughPct >= 50,
      passThroughPct: balances.passThroughPct,
      lowPreSalaryBalance: balances.avgPreSalaryBalance < 0.1 * (salary.avgSalary || 1),
      salaryRegularity: balances.salaryRegularity,
      lendingAppsCount,
      lendingAppsTotal: Math.round(lendingAppsTotal),
      oneOffCreditsCount: oneOffCredits.length,
      oneOffCreditsTotal: Math.round(oneOffCredits.reduce((s, t) => s + t.credit, 0)),
      creditCardPaymentsTotal: Math.round(ccPaymentTotal),
      cardLikeTotal: Math.round(cardLikeTotal),
      bettingCount,
      bouncesCount: bounces.length,
      bounces,
      market,
      walletIn: Math.round(walletIn),
      walletOut: Math.round(walletOut),
      walletCreditPct,
      walletDebitPct,
    },
    monthly,
    monthsUsed,
    topCreditSenders: topCounterparties(sorted, "credit", 8),
    topDebitReceivers: topCounterparties(sorted, "debit", 8),
    largeDebitsToOthers: findLargeDebitsToOthers(sorted, holderName, accountNo),
    unclassifiedLargeDebits: unclassifiedLarge,
    cashDeposits: {
      total: Math.round(cashDepositTotal),
      count: cashDepositCount,
      pctOfCredits: cashPctOfCredits,
      byMonth: cashByMonth,
    },
    cashWithdrawals: {
      total: Math.round(cashWithdrawalTotal),
      count: cashWithdrawalCount,
    },
    oneOffCredits,
    totalCredits: Math.round(totalCredits),
    totalDebits: Math.round(totalDebits),
    txnPeriod: {
      start: startDate,
      end: endDate,
      totalDays,
    },
    qualityNotes: [],
  };
}
