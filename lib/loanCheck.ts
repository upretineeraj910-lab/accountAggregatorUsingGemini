import { NewLoanCheckInput, NewLoanCheckResult } from "./types";

export function calcEmi(principal: number, annualRatePct: number, tenureMonths: number): number {
  if (principal <= 0 || tenureMonths <= 0) return 0;
  if (annualRatePct <= 0) return Math.round(principal / tenureMonths);

  const monthlyRate = annualRatePct / 12 / 100;
  const factor = Math.pow(1 + monthlyRate, tenureMonths);
  const emi = (principal * monthlyRate * factor) / (factor - 1);
  return Math.round(emi);
}

export function maxLoanForEmi(maxEmi: number, annualRatePct: number, tenureMonths: number): number {
  if (maxEmi <= 0 || tenureMonths <= 0) return 0;
  if (annualRatePct <= 0) return Math.round(maxEmi * tenureMonths);

  const monthlyRate = annualRatePct / 12 / 100;
  const factor = Math.pow(1 + monthlyRate, tenureMonths);
  const principal = (maxEmi * (factor - 1)) / (monthlyRate * factor);
  return Math.round(principal);
}

export function checkNewLoan(input: NewLoanCheckInput): NewLoanCheckResult | null {
  const { avgSalary, monthlyEmi, amount, ratePct, tenureMonths } = input;
  if (avgSalary <= 0) {
    return null;
  }

  const currentFoir = Math.round((monthlyEmi / avgSalary) * 100);
  const newEmi = calcEmi(amount, ratePct, tenureMonths);
  const totalEmi = monthlyEmi + newEmi;
  const newFoir = Math.round((totalEmi / avgSalary) * 100);

  let status: "Pass" | "Borderline" | "Fail";
  if (newFoir <= 45) {
    status = "Pass";
  } else if (newFoir <= 50) {
    status = "Borderline";
  } else {
    status = "Fail";
  }

  const maxEmiRoom = Math.max(0, Math.round(0.5 * avgSalary - monthlyEmi));
  const maxLoanAmount = maxLoanForEmi(maxEmiRoom, ratePct, tenureMonths);

  return {
    currentFoir,
    newEmi,
    totalEmi,
    newFoir,
    status,
    maxEmiRoom,
    maxLoanAmount,
  };
}
