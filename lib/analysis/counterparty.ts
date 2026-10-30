import { Txn, CounterpartyItem } from "../types";
import {
  isObligation,
  CASH_WITHDRAWAL_REGEX,
  CARD_LIKE_REGEX,
  CC_PAYMENT_REGEX,
  WALLET_REGEX,
} from "../keywords";
import { extractSenderKey } from "./salary";

export function getCounterparty(narration: string): string {
  const clean = narration.trim();

  // UPI pattern: UPI/DR/ref/NAME or UPI/CR/ref/NAME or UPI/ref/NAME or UPI/NAME
  const upiMatch = clean.match(/^UPI[\/:-](?:DR|CR)?[0-9\/\-_]*([A-Za-z\s.]+)/i);
  if (upiMatch && upiMatch[1]) {
    const rawName = upiMatch[1].replace(/[\/].*$/, "").trim();
    if (rawName.length >= 3) {
      return rawName.toUpperCase();
    }
  }

  // General UPI with slash segments
  if (/^UPI[\/:-]/i.test(clean)) {
    const parts = clean.split(/[\/:-]+/);
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i].trim();
      const alphaCount = (part.match(/[A-Za-z]/g) || []).length;
      if (alphaCount >= 3 && alphaCount / part.length >= 0.6) {
        return part.toUpperCase();
      }
    }
  }

  // NEFT / IMPS sender/receiver segment
  if (/(?:NEFT|IMPS|RTGS)/i.test(clean)) {
    const sender = extractSenderKey(clean);
    if (sender) return sender;
  }

  // Fallback: first 24 chars cleaned
  return clean.slice(0, 24).trim().toUpperCase();
}

export function topCounterparties(
  txns: Txn[],
  type: "credit" | "debit",
  limit = 8
): CounterpartyItem[] {
  const filtered = txns.filter((t) => (type === "credit" ? t.credit > 0 : t.debit > 0));
  const map = new Map<string, { count: number; total: number }>();

  for (const t of filtered) {
    const name = getCounterparty(t.narration);
    const amt = type === "credit" ? t.credit : t.debit;
    const existing = map.get(name) || { count: 0, total: 0 };
    existing.count++;
    existing.total += amt;
    map.set(name, existing);
  }

  const items: CounterpartyItem[] = Array.from(map.entries()).map(([name, data]) => ({
    name,
    count: data.count,
    total: Math.round(data.total),
  }));

  items.sort((a, b) => b.total - a.total);
  return items.slice(0, limit);
}

export function isSelfTransfer(narration: string, holderName?: string, accountNo?: string): boolean {
  if (/(?:SELF|OWN ACC|TRANSFER TO OWN|SELF TRANSFER)/i.test(narration)) {
    return true;
  }

  if (accountNo && accountNo.length >= 6) {
    // If account number appears in narration
    const cleanAcc = accountNo.replace(/[^0-9]/g, "");
    if (cleanAcc.length >= 6 && narration.includes(cleanAcc)) {
      return true;
    }
  }

  if (holderName && holderName.trim().length >= 4) {
    // First token prefix (min 5 chars, e.g. "JOYDE" from "JOYDEEP")
    const firstWord = holderName.trim().toUpperCase().split(/\s+/)[0];
    const prefixLen = Math.min(5, firstWord.length);
    if (prefixLen >= 4) {
      const prefix = firstWord.slice(0, prefixLen);
      if (narration.toUpperCase().includes(prefix)) {
        return true;
      }
    }
  }

  return false;
}

export function findLargeDebitsToOthers(
  txns: Txn[],
  holderName?: string,
  accountNo?: string
): Txn[] {
  return txns.filter((t) => {
    if (t.debit < 5000) return false;
    if (isSelfTransfer(t.narration, holderName, accountNo)) return false;
    if (isObligation(t.narration)) return false;
    if (CASH_WITHDRAWAL_REGEX.test(t.narration)) return false;
    if (CARD_LIKE_REGEX.test(t.narration) || CC_PAYMENT_REGEX.test(t.narration)) return false;
    if (WALLET_REGEX.test(t.narration)) return false;
    return true;
  });
}

export function findUnclassifiedLargeDebits(
  txns: Txn[],
  holderName?: string,
  accountNo?: string
): Txn[] {
  return txns.filter((t) => {
    if (t.debit < 5000) return false;
    const n = t.narration;
    if (isSelfTransfer(n, holderName, accountNo)) return false;
    if (isObligation(n)) return false;
    if (CASH_WITHDRAWAL_REGEX.test(n)) return false;
    if (CARD_LIKE_REGEX.test(n) || CC_PAYMENT_REGEX.test(n)) return false;
    if (WALLET_REGEX.test(n)) return false;

    // Check if it's standard UPI, NEFT, IMPS
    if (/^(?:UPI|NEFT|RTGS|IMPS|POS|ATM|CHEQUE|CHQ)/i.test(n)) {
      return false;
    }

    // Unclassified / unusual narration like "COPT DEDUC"
    return true;
  });
}
