import { Txn, CreditCategory, OtherCreditItem, OtherCreditsResult } from "../types";
import {
  LOAN_APP_REGEX,
  CASH_DEPOSIT_REGEX,
  LOAN_LIKE_REGEX,
  WALLET_REGEX,
  BROKER_REGEX,
  REFUND_REGEX,
  INTEREST_REGEX,
} from "../keywords";
import { isSelfTransfer } from "./counterparty";

const CATEGORY_ORDER: CreditCategory[] = [
  "LENDING_APP",
  "CASH",
  "LOAN_LIKE",
  "SELF_TRANSFER",
  "WALLET",
  "BROKER",
  "REFUND",
  "INTEREST",
  "UPI_PERSON",
  "OTHER",
];

export function classifyOtherCredits(
  txns: Txn[],
  salaryCreditSet: Set<Txn>,
  avgSalary: number,
  holderName?: string,
  accountNo?: string
): OtherCreditsResult {
  const credits = txns.filter((t) => t.credit > 0);
  const debits = txns.filter((t) => t.debit > 0);

  const nonSalaryCredits = credits.filter((t) => !salaryCreditSet.has(t));

  const items: OtherCreditItem[] = [];
  const byCategory: Record<CreditCategory, { count: number; total: number }> = {
    LENDING_APP: { count: 0, total: 0 },
    CASH: { count: 0, total: 0 },
    LOAN_LIKE: { count: 0, total: 0 },
    SELF_TRANSFER: { count: 0, total: 0 },
    WALLET: { count: 0, total: 0 },
    BROKER: { count: 0, total: 0 },
    REFUND: { count: 0, total: 0 },
    INTEREST: { count: 0, total: 0 },
    UPI_PERSON: { count: 0, total: 0 },
    OTHER: { count: 0, total: 0 },
  };

  for (const t of nonSalaryCredits) {
    const n = t.narration;
    let cat: CreditCategory = "OTHER";
    let risk: "high" | "medium" | "low" = "low";
    let reason = "Unclassified credit";

    // 1. LENDING_APP (high)
    if (LOAN_APP_REGEX.test(n)) {
      cat = "LENDING_APP";
      risk = "high";
      reason = "Deposit from fintech lending app";
    }
    // 2. CASH (medium)
    else if (CASH_DEPOSIT_REGEX.test(n)) {
      cat = "CASH";
      risk = "medium";
      reason = "Cash deposit (ATM/CDM/Branch)";
    }
    // 3. LOAN_LIKE (high)
    else if (
      (avgSalary > 0 && t.credit >= 2 * avgSalary) ||
      LOAN_LIKE_REGEX.test(n)
    ) {
      cat = "LOAN_LIKE";
      risk = "high";
      reason = LOAN_LIKE_REGEX.test(n)
        ? "Loan disbursement keyword detected"
        : "Large credit >= 2x salary";
    }
    // 4. SELF_TRANSFER (medium) (Wallet credits like PPIW/MBK stay separate)
    else if (WALLET_REGEX.test(n)) {
      cat = "WALLET";
      risk = "medium";
      reason = "Wallet topup or reversal";
    } else if (isSelfTransfer(n, holderName, accountNo)) {
      cat = "SELF_TRANSFER";
      risk = "medium";
      reason = "Transfer from own account / self prefix";
    }
    // 5. BROKER (medium)
    else if (BROKER_REGEX.test(n)) {
      cat = "BROKER";
      risk = "medium";
      reason = "Trading / broker payout";
    }
    // 6. REFUND (low)
    else if (REFUND_REGEX.test(n)) {
      cat = "REFUND";
      risk = "low";
      reason = "Refund or cashback";
    }
    // 7. INTEREST (low)
    else if (INTEREST_REGEX.test(n)) {
      cat = "INTEREST";
      risk = "low";
      reason = "Bank interest paid";
    }
    // 8. UPI_PERSON (medium)
    else if (/^UPI[\/:]/i.test(n)) {
      cat = "UPI_PERSON";
      risk = "medium";
      reason = "UPI transfer from individual/merchant";
    }
    // 9. OTHER (low)
    else {
      cat = "OTHER";
      risk = "low";
      reason = "Other general credit";
    }

    byCategory[cat].count++;
    byCategory[cat].total += t.credit;

    items.push({
      txn: t,
      category: cat,
      risk,
      reason,
    });
  }

  // Sort items: high risk first, then medium, then low; within same risk, by amount descending
  const riskWeight = { high: 3, medium: 2, low: 1 };
  items.sort((a, b) => {
    const rw = riskWeight[b.risk] - riskWeight[a.risk];
    if (rw !== 0) return rw;
    return b.txn.credit - a.txn.credit;
  });

  const totalOther = items.reduce((s, it) => s + it.txn.credit, 0);
  const totalAllCredits = credits.reduce((s, t) => s + t.credit, 0);
  const totalSalaryCredits = Array.from(salaryCreditSet).reduce((s, t) => s + t.credit, 0);

  const pctOfTotalCredit =
    totalAllCredits > 0 ? Math.round((totalOther / totalAllCredits) * 100) : 0;
  const salaryPct =
    totalAllCredits > 0 ? Math.round((totalSalaryCredits / totalAllCredits) * 100) : 0;

  // Calculate selfIn, selfOut, selfNet
  let selfIn = 0;
  for (const t of credits) {
    if (WALLET_REGEX.test(t.narration)) continue;
    if (isSelfTransfer(t.narration, holderName, accountNo)) {
      selfIn += t.credit;
    }
  }

  let selfOut = 0;
  for (const t of debits) {
    if (WALLET_REGEX.test(t.narration)) continue;
    if (isSelfTransfer(t.narration, holderName, accountNo)) {
      selfOut += t.debit;
    }
  }

  const selfNet = selfOut - selfIn;
  const totalWalletCredit = byCategory.WALLET.total;

  const realAdjustedCredit = Math.max(
    0,
    totalAllCredits - selfIn - totalWalletCredit
  );

  return {
    items,
    byCategory,
    totalOther: Math.round(totalOther),
    pctOfTotalCredit,
    salaryPct,
    selfIn: Math.round(selfIn),
    selfOut: Math.round(selfOut),
    selfNet: Math.round(selfNet),
    realAdjustedCredit: Math.round(realAdjustedCredit),
  };
}
