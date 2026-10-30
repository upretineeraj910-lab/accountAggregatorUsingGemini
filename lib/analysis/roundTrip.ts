import { Txn, RoundTripPair, RoundTripResult } from "../types";

export function detectRoundTrips(txns: Txn[]): RoundTripResult {
  const debits = txns
    .filter((t) => t.debit >= 100)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const credits = txns
    .filter((t) => t.credit >= 100)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const usedCreditIndices = new Set<number>();
  const pairs: RoundTripPair[] = [];

  for (const deb of debits) {
    const debTime = deb.date.getTime();
    let bestCreditIdx = -1;
    let minDaysDiff = Infinity;

    for (let cIdx = 0; cIdx < credits.length; cIdx++) {
      if (usedCreditIndices.has(cIdx)) continue;
      const cred = credits[cIdx];

      // Exact amount match
      if (Math.abs(deb.debit - cred.credit) > 0.01) continue;

      const diffMs = cred.date.getTime() - debTime;
      const diffDays = Math.abs(diffMs) / (1000 * 60 * 60 * 24);

      // Same day or next day (<= 1.5 days tolerance for noon timestamps)
      if (diffDays <= 1.5 && diffDays < minDaysDiff) {
        minDaysDiff = diffDays;
        bestCreditIdx = cIdx;
      }
    }

    if (bestCreditIdx !== -1) {
      usedCreditIndices.add(bestCreditIdx);
      pairs.push({
        debit: deb,
        credit: credits[bestCreditIdx],
        amount: deb.debit,
        daysDiff: Math.round(minDaysDiff),
      });
    }
  }

  const count = pairs.length;
  const volume = pairs.reduce((s, p) => s + p.amount, 0);

  const totalCreditAmount = txns.reduce((s, t) => s + t.credit, 0);
  const pctOfCredits =
    totalCreditAmount > 0 ? Math.round((volume / totalCreditAmount) * 100) : 0;

  const suspected = count >= 5 || (totalCreditAmount > 0 && pctOfCredits >= 20);

  return {
    pairs,
    count,
    volume: Math.round(volume),
    pctOfCredits,
    suspected,
  };
}
