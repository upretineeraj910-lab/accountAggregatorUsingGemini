export type Txn = {
  date: Date;
  narration: string;
  debit: number;
  credit: number;
  balance: number;
};

export type RawAiRow = {
  date: string;
  narration: string;
  amount: number;
  type: "DEBIT" | "CREDIT";
  balance: number;
};

export type AiQuality = {
  ok: boolean;
  rows: number;
  expectedRows: number;
  dropped: number;
  chainMismatches: number;
  flippedByChain: number;
  firstRowUncertain: boolean;
  notes: string[];
};

export type Profile = {
  name?: string;
  branch?: string;
  accountNo?: string;
  ifsc?: string;
};

export type SalaryResult = {
  credits: Txn[];
  avgSalary: number;
  months: number;
  method: "keyword" | "recurring" | "none";
  extraCredits: Txn[];
  sender?: string;
  monthlyCredits: Record<string, number>;
};

export type ObligationItem = {
  key: string;
  label: string;
  monthlyTotals: Record<string, number>;
  typicalAmount: number;
  monthsSeen: number;
  lastDate: Date;
};

export type ObligationResult = {
  items: ObligationItem[];
  monthlyEmi: number;
  partialRecoveries: {
    key: string;
    count: number;
    dates: Date[];
  }[];
  cashBeforeEmiCount: number;
  totalEmiDebits: number;
  insuranceItems: {
    label: string;
    amount: number;
    date: Date;
  }[];
  totalInsurance: number;
};

export type CreditCategory =
  | "LENDING_APP"
  | "CASH"
  | "LOAN_LIKE"
  | "SELF_TRANSFER"
  | "WALLET"
  | "BROKER"
  | "REFUND"
  | "INTEREST"
  | "UPI_PERSON"
  | "OTHER";

export type OtherCreditItem = {
  txn: Txn;
  category: CreditCategory;
  risk: "high" | "medium" | "low";
  reason: string;
};

export type OtherCreditsResult = {
  items: OtherCreditItem[];
  byCategory: Record<CreditCategory, { count: number; total: number }>;
  totalOther: number;
  pctOfTotalCredit: number;
  salaryPct: number;
  selfIn: number;
  selfOut: number;
  selfNet: number;
  realAdjustedCredit: number;
};

export type RoundTripPair = {
  debit: Txn;
  credit: Txn;
  amount: number;
  daysDiff: number;
};

export type RoundTripResult = {
  pairs: RoundTripPair[];
  count: number;
  volume: number;
  pctOfCredits: number;
  suspected: boolean;
};

export type BalancesResult = {
  medianDailyBalance: number;
  minBalance: number;
  daysAtOrBelow500: number;
  monthEndAvgBalance: number;
  avgTxnBalance: number;
  preSalaryBalances: { date: Date; balance: number }[];
  avgPreSalaryBalance: number;
  passThroughPct: number;
  passThroughMonthsCount: number;
  salaryRegularity: number;
};

export type CounterpartyItem = {
  name: string;
  count: number;
  total: number;
};

export type MonthlyBreakdown = {
  monthKey: string;
  label: string;
  credit: number;
  debit: number;
  closingBalance: number;
  isPartial: boolean;
};

export type MarketResult = {
  invested: number;
  withdrawn: number;
  net: number;
  transfers: number;
  sip: number;
  isActive: boolean;
  isHeavy: boolean;
};

export type RiskSignals = {
  passThrough: boolean;
  passThroughPct: number;
  lowPreSalaryBalance: boolean;
  salaryRegularity: number;
  lendingAppsCount: number;
  lendingAppsTotal: number;
  oneOffCreditsCount: number;
  oneOffCreditsTotal: number;
  creditCardPaymentsTotal: number;
  cardLikeTotal: number;
  bettingCount: number;
  bouncesCount: number;
  bounces: { date: Date; amount: number; narration: string }[];
  market: MarketResult;
  walletIn: number;
  walletOut: number;
  walletCreditPct: number;
  walletDebitPct: number;
};

export type FactorItem = {
  type: "positive" | "negative" | "info";
  text: string;
  points?: number;
};

export type AnalysisResult = {
  score: number;
  verdict: "Strong" | "Average" | "Weak";
  factors: FactorItem[];
  foir: number;
  currentEmi: number;
  avgSalary: number;
  isSalaryIdentified: boolean;
  salaryShareLow: boolean;
  salary: SalaryResult;
  obligations: ObligationResult;
  credits: OtherCreditsResult;
  balances: BalancesResult;
  roundTrip: RoundTripResult;
  risks: RiskSignals;
  monthly: MonthlyBreakdown[];
  monthsUsed: string[];
  topCreditSenders: CounterpartyItem[];
  topDebitReceivers: CounterpartyItem[];
  largeDebitsToOthers: Txn[];
  unclassifiedLargeDebits: Txn[];
  cashDeposits: {
    total: number;
    count: number;
    pctOfCredits: number;
    byMonth: Record<string, number>;
  };
  cashWithdrawals: {
    total: number;
    count: number;
  };
  oneOffCredits: Txn[];
  totalCredits: number;
  totalDebits: number;
  txnPeriod: {
    start: Date;
    end: Date;
    totalDays: number;
  };
  qualityNotes: string[];
};

export type NewLoanCheckInput = {
  avgSalary: number;
  monthlyEmi: number;
  amount: number;
  ratePct: number;
  tenureMonths: number;
};

export type NewLoanCheckResult = {
  currentFoir: number;
  newEmi: number;
  totalEmi: number;
  newFoir: number;
  status: "Pass" | "Borderline" | "Fail";
  maxEmiRoom: number;
  maxLoanAmount: number;
};
