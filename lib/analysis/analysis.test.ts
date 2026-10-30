import { describe, it } from "node:test";
import assert from "node:assert";
import { Txn } from "../types";
import {
  CASH_DEPOSIT_REGEX,
  BOUNCE_REGEX,
  BROKER_REGEX,
} from "../keywords";
import { detectSalary } from "./salary";
import { analyzeObligations } from "./obligations";
import { classifyOtherCredits } from "./otherCredits";
import { detectRoundTrips } from "./roundTrip";
import { analyzeBalances } from "./balances";
import { analyze } from "./index";
import { calcEmi, checkNewLoan } from "../loanCheck";
import { getMonthInfoList, selectMonthsForAverage } from "./months";

describe("Phase 4 - Keywords, Salary & Obligations", () => {
  it("verifies keyword regexes: cash deposits, bounces, and word-boundary safety (LICENSE vs NSE)", () => {
    assert.strictEqual(CASH_DEPOSIT_REGEX.test("BY CASH DEPOSIT AT BRANCH"), true);
    assert.strictEqual(CASH_DEPOSIT_REGEX.test("ATM DEP MACHINE NO 12"), true);
    assert.strictEqual(CASH_DEPOSIT_REGEX.test("BNADEP CASH INWARD"), true);

    assert.strictEqual(BOUNCE_REGEX.test("ACH RTN--05-10-2026"), true);
    assert.strictEqual(BOUNCE_REGEX.test("CHQ RET INSUFFICIENT FUNDS"), true);

    // Safety: "LICENSE" must NOT match NSE
    assert.strictEqual(BROKER_REGEX.test("DRIVING LICENSE VERIFICATION"), false);
    assert.strictEqual(BROKER_REGEX.test("TRANSFER TO NSE CLEARING LTD"), true);
    assert.strictEqual(BROKER_REGEX.test("ZERODHA BROKING LTD"), true);
  });

  it("detects salary by keyword (Salary Transfer, TREASURY)", () => {
    const txns: Txn[] = [
      { date: new Date(2026, 0, 1), narration: "TREASURY SALARY CR", debit: 0, credit: 50000, balance: 50000 },
      { date: new Date(2026, 1, 1), narration: "Salary Transfer Ref 123", debit: 0, credit: 50000, balance: 60000 },
      { date: new Date(2026, 2, 1), narration: "Monthly Salary Credit", debit: 0, credit: 50000, balance: 70000 },
    ];
    const res = detectSalary(txns);
    assert.strictEqual(res.method, "keyword");
    assert.strictEqual(res.avgSalary, 50000);
    assert.strictEqual(res.credits.length, 3);
  });

  it("detects recurring salary via employer NEFT sender, ignores UPI, handles 40000+1950, and puts arrears into extraCredits", () => {
    const txns: Txn[] = [
      // Month 1: 40000 salary + 1950 reimbursement in same month from same employer
      { date: new Date(2026, 0, 2), narration: "NEFT-TECHSOLUTIONS PVT LTD-EXPENSE", debit: 0, credit: 1950, balance: 1950 },
      { date: new Date(2026, 0, 5), narration: "NEFT-TECHSOLUTIONS PVT LTD-CREDIT", debit: 0, credit: 40000, balance: 41950 },
      // Month 2: regular 40000
      { date: new Date(2026, 1, 5), narration: "NEFT-TECHSOLUTIONS PVT LTD-CREDIT", debit: 0, credit: 40000, balance: 50000 },
      // Month 3: regular 40000
      { date: new Date(2026, 2, 5), narration: "NEFT-TECHSOLUTIONS PVT LTD-CREDIT", debit: 0, credit: 40000, balance: 60000 },
      // Month 4: massive bonus/arrears (85000) outside +/-40% of median
      { date: new Date(2026, 3, 5), narration: "NEFT-TECHSOLUTIONS PVT LTD-CREDIT", debit: 0, credit: 85000, balance: 100000 },
      // UPI credit (must NEVER be treated as salary)
      { date: new Date(2026, 1, 10), narration: "UPI/DR/123/TECHSOLUTIONS", debit: 0, credit: 40000, balance: 80000 },
    ];

    const res = detectSalary(txns);
    assert.strictEqual(res.method, "recurring");
    assert.strictEqual(res.avgSalary, 40000);
    // Month 1 largest credit was 40000; 1950 went into extraCredits
    assert.strictEqual(res.credits.some((c) => c.credit === 40000), true);
    assert.strictEqual(res.extraCredits.some((c) => c.credit === 85000), true);
    assert.strictEqual(res.extraCredits.some((c) => c.credit === 1950), true);
  });

  it("excludes holder name from recurring salary sender and returns none for random senders", () => {
    const txns: Txn[] = [
      { date: new Date(2026, 0, 1), narration: "NEFT-RAJESH SHARMA-TRANSFER", debit: 0, credit: 30000, balance: 30000 },
      { date: new Date(2026, 1, 1), narration: "NEFT-RAJESH SHARMA-TRANSFER", debit: 0, credit: 30000, balance: 35000 },
      { date: new Date(2026, 2, 1), narration: "NEFT-RAJESH SHARMA-TRANSFER", debit: 0, credit: 30000, balance: 40000 },
    ];
    // With holderName "RAJESH SHARMA", self-transfers must not be picked as salary
    const res = detectSalary(txns, { holderName: "RAJESH SHARMA" });
    assert.strictEqual(res.method, "none");
    assert.strictEqual(res.avgSalary, 0);
  });

  it("accurately groups loan obligations, separates LIC insurance, detects partial recovery and cash-before-EMI", () => {
    const txns: Txn[] = [
      // Cash deposit 2 days before EMI
      { date: new Date(2026, 0, 3), narration: "BY CASH ATM DEP", debit: 0, credit: 15000, balance: 15000 },
      // Obligation with loan account
      { date: new Date(2026, 0, 5), narration: "Loan Recovery For -036120NB00000710", debit: 12000, credit: 0, balance: 3000 },
      // Glued lender
      { date: new Date(2026, 0, 6), narration: "ACH/HDBFINANCIALSERLTD/123", debit: 5000, credit: 0, balance: 1000 },
      // Bajaj Finance ACH
      { date: new Date(2026, 0, 7), narration: "ACH/BAJAJ FINANCE LTD", debit: 4000, credit: 0, balance: 500 },
      // Another loan account
      { date: new Date(2026, 0, 8), narration: "D18746270CR TO036120NB00000729", debit: 8000, credit: 0, balance: 200 },
      // Insurance (must NOT be treated as EMI)
      { date: new Date(2026, 0, 9), narration: "ACH/LIC OF INDIA PREMIUM", debit: 2500, credit: 0, balance: 100 },
      // Partial recovery scenario: loan debit 1 drains balance to <= 1, second debit 2 days later
      { date: new Date(2026, 1, 5), narration: "ACH/BAJAJ FINANCE LTD", debit: 447.06, credit: 0, balance: 0.5 },
      { date: new Date(2026, 1, 7), narration: "ACH/BAJAJ FINANCE LTD", debit: 3552.94, credit: 0, balance: 50 },
    ];

    const obs = analyzeObligations(txns);

    // Grouping check
    assert.ok(obs.items.some((it) => it.key === "036120NB00000710"));
    assert.ok(obs.items.some((it) => it.key === "036120NB00000729"));
    assert.ok(obs.items.some((it) => it.key === "BAJAJ FINANCE LTD"));
    assert.ok(obs.items.some((it) => it.key.includes("HDB")));

    // Insurance check
    assert.strictEqual(obs.insuranceItems.length, 1);
    assert.strictEqual(obs.totalInsurance, 2500);

    // Partial recovery check
    assert.ok(obs.partialRecoveries.length >= 1);
    assert.strictEqual(obs.partialRecoveries[0].key, "BAJAJ FINANCE LTD");

    // Cash before EMI check
    assert.ok(obs.cashBeforeEmiCount >= 1);
  });
});

describe("Phase 4 & 5 - Partial Months, Self Transfers, Round Trips & Scoring", () => {
  it("excludes partial first/last month from average EMI and calculates FOIR only from full months", () => {
    const txns: Txn[] = [
      // Month 1: 1 day only on 28th (>= 5, partial)
      { date: new Date(2026, 0, 28), narration: "ACH/BAJAJ FINANCE LTD", debit: 10000, credit: 0, balance: 50000 },

      // Month 2: Full month (starts 1st, ends 28th)
      { date: new Date(2026, 1, 1), narration: "Salary Transfer", debit: 0, credit: 50000, balance: 100000 },
      { date: new Date(2026, 1, 10), narration: "ACH/BAJAJ FINANCE LTD", debit: 10000, credit: 0, balance: 90000 },
      { date: new Date(2026, 1, 28), narration: "Groceries", debit: 5000, credit: 0, balance: 85000 },

      // Month 3: Full month (starts 1st, ends 31st)
      { date: new Date(2026, 2, 1), narration: "Salary Transfer", debit: 0, credit: 50000, balance: 135000 },
      { date: new Date(2026, 2, 10), narration: "ACH/BAJAJ FINANCE LTD", debit: 10000, credit: 0, balance: 125000 },
      { date: new Date(2026, 2, 31), narration: "Electricity", debit: 2000, credit: 0, balance: 123000 },

      // Month 4: Partial month ending on 22nd (<= 30 - 4 = 26, partial)
      { date: new Date(2026, 3, 1), narration: "Salary Transfer", debit: 0, credit: 50000, balance: 173000 },
      { date: new Date(2026, 3, 22), narration: "ACH/BAJAJ FINANCE LTD", debit: 10000, credit: 0, balance: 163000 },
    ];

    const months = getMonthInfoList(txns);
    assert.strictEqual(months[0].isPartial, true);
    assert.strictEqual(months[months.length - 1].isPartial, true);

    const { selectedKeys, monthsUsed } = selectMonthsForAverage(months);
    assert.strictEqual(selectedKeys.size, 2);
    assert.strictEqual(monthsUsed.length, 2);

    const obs = analyzeObligations(txns);
    // Average EMI should be based on the 2 complete months = 10000
    assert.strictEqual(obs.monthlyEmi, 10000);
  });

  it("detects round trips, self-transfer prefixes (JOYDE), median daily balance and pass-through", () => {
    const txns: Txn[] = [
      // Round trip: debit 20000 on May 10, credit 20000 on May 11
      { date: new Date(2026, 4, 10), narration: "Transfer to friend", debit: 20000, credit: 0, balance: 10000 },
      { date: new Date(2026, 4, 11), narration: "Transfer from friend", debit: 0, credit: 20000, balance: 30000 },
      // Self transfers with prefix JOYDE (different amounts so they don't form a round trip pair)
      { date: new Date(2026, 4, 12), narration: "UPI/DR/123/JOYDEEP SEN", debit: 5000, credit: 0, balance: 25000 },
      { date: new Date(2026, 4, 15), narration: "UPI/CR/456/JOYDEEP SEN", debit: 0, credit: 6000, balance: 31000 },
    ];

    const rt = detectRoundTrips(txns);
    assert.strictEqual(rt.count, 1);
    assert.strictEqual(rt.volume, 20000);

    const salarySet = new Set<Txn>();
    const credits = classifyOtherCredits(txns, salarySet, 0, "JOYDEEP SEN", "12345678");
    assert.strictEqual(credits.selfIn, 6000);
    assert.strictEqual(credits.selfOut, 5000);
    assert.strictEqual(credits.selfNet, -1000);
  });

  it("validates 4 scoring scenarios, hard caps and parse quality cap", () => {
    // 1. Clean Strong Case (3+ months, regular salary 60k, low EMI, high balance, no bounces)
    const cleanTxns: Txn[] = [];
    for (let m = 0; m < 4; m++) {
      cleanTxns.push(
        { date: new Date(2026, m, 1), narration: "SALARY CREDIT", debit: 0, credit: 60000, balance: 80000 },
        { date: new Date(2026, m, 10), narration: "ACH/BAJAJ FINANCE", debit: 10000, credit: 0, balance: 70000 },
        { date: new Date(2026, m, 15), narration: "Groceries", debit: 5000, credit: 0, balance: 65000 },
        { date: new Date(2026, m, 28), narration: "Utilities", debit: 5000, credit: 0, balance: 60000 }
      );
    }
    const cleanRes = analyze(cleanTxns);
    assert.strictEqual(cleanRes.verdict, "Strong");
    assert.ok(cleanRes.score >= 75);

    // 2. Pass-through case (salary drained within 3 days >= 80%): hard capped at max 69, NEVER Strong
    const passThroughTxns: Txn[] = [];
    for (let m = 0; m < 4; m++) {
      passThroughTxns.push(
        { date: new Date(2026, m, 1), narration: "SALARY CREDIT", debit: 0, credit: 50000, balance: 50100 },
        // Drains 48000 out of 50000 on day 2
        { date: new Date(2026, m, 2), narration: "Cash withdrawal ATM", debit: 48000, credit: 0, balance: 2100 },
        { date: new Date(2026, m, 15), narration: "Tea", debit: 100, credit: 0, balance: 2000 },
        { date: new Date(2026, m, 28), narration: "Snacks", debit: 100, credit: 0, balance: 1900 }
      );
    }
    const ptRes = analyze(passThroughTxns);
    assert.ok(ptRes.score <= 69, "Pass-through score must be capped at 69");
    assert.notStrictEqual(ptRes.verdict, "Strong");

    // 3. Heavy trader case: Average or Weak, never above Average
    const traderTxns = [...cleanTxns];
    for (let i = 0; i < 8; i++) {
      traderTxns.push({
        date: new Date(2026, 1, 10 + i),
        narration: "TRANSFER TO ZERODHA BROKING LTD",
        debit: 25000,
        credit: 0,
        balance: 30000,
      });
    }
    const traderRes = analyze(traderTxns);
    assert.notStrictEqual(traderRes.verdict, "Strong");
    assert.ok(traderRes.score <= 74, "Trader score should not be above Average (<= 74)");

    // 4. Wallet-heavy case: Average or Weak, never above Average
    const walletTxns = [...cleanTxns];
    for (let i = 0; i < 6; i++) {
      walletTxns.push(
        { date: new Date(2026, 0, 10 + i), narration: "ADD MONEY PAYTM WALLET LOAD", debit: 20000, credit: 0, balance: 15000 },
        { date: new Date(2026, 0, 10 + i), narration: "REFUND PAYTM WALLET PPIW", debit: 0, credit: 20000, balance: 35000 }
      );
    }
    const walletRes = analyze(walletTxns);
    assert.notStrictEqual(walletRes.verdict, "Strong");
    assert.ok(walletRes.score <= 74, "Wallet heavy score should not be above Average (<= 74)");

    // 5. Parse quality !ok: hard cap 74
    const qualityNotOkRes = analyze(cleanTxns, { parseQualityOk: false });
    assert.ok(qualityNotOkRes.score <= 74);
  });

  it("loanCheck: tests calcEmi and checkNewLoan accurately", () => {
    // calcEmi(500000, 14, 60) should be approx 11634
    const emi = calcEmi(500000, 14, 60);
    assert.ok(Math.abs(emi - 11634) <= 2, `Expected ~11634, got ${emi}`);

    // salary 40587 + EMI 15994 + new loan 500000 -> Fail (total EMI > 50% FOIR)
    const check = checkNewLoan({
      avgSalary: 40587,
      monthlyEmi: 15994,
      amount: 500000,
      ratePct: 14,
      tenureMonths: 60,
    });
    assert.ok(check !== null);
    assert.strictEqual(check?.status, "Fail");

    // avgSalary 0 -> returns null
    const checkZero = checkNewLoan({
      avgSalary: 0,
      monthlyEmi: 10000,
      amount: 500000,
      ratePct: 14,
      tenureMonths: 60,
    });
    assert.strictEqual(checkZero, null);
  });
});
