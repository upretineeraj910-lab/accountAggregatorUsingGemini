import { Txn } from "../types";

export interface MonthInfo {
  year: number;
  month: number; // 0-indexed
  key: string; // YYYY-MM
  label: string;
  isPartial: boolean;
  firstDate: Date;
  lastDate: Date;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

export function getMonthInfoList(txns: Txn[]): MonthInfo[] {
  if (txns.length === 0) return [];

  // Sort txns by date
  const sorted = [...txns].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Group by year-month
  const map = new Map<string, { year: number; month: number; firstDate: Date; lastDate: Date }>();

  for (const t of sorted) {
    const y = t.date.getFullYear();
    const m = t.date.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, { year: y, month: m, firstDate: t.date, lastDate: t.date });
    } else {
      if (t.date.getTime() < existing.firstDate.getTime()) existing.firstDate = t.date;
      if (t.date.getTime() > existing.lastDate.getTime()) existing.lastDate = t.date;
    }
  }

  const keys = Array.from(map.keys()).sort();
  const result: MonthInfo[] = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const data = map.get(key)!;
    const daysInMonth = new Date(data.year, data.month + 1, 0).getDate();

    let isPartial = false;

    // First month is partial if first txn date is >= 5
    if (i === 0) {
      if (data.firstDate.getDate() >= 5) {
        isPartial = true;
      }
    }

    // Last month is partial if last txn date is <= (daysInMonth - 4)
    if (i === keys.length - 1) {
      if (data.lastDate.getDate() <= daysInMonth - 4) {
        isPartial = true;
      }
    }

    const label = `${MONTH_NAMES[data.month]} ${data.year}`;

    result.push({
      year: data.year,
      month: data.month,
      key,
      label,
      isPartial,
      firstDate: data.firstDate,
      lastDate: data.lastDate,
    });
  }

  return result;
}

export function selectMonthsForAverage(months: MonthInfo[]): {
  selectedKeys: Set<string>;
  monthsUsed: string[];
} {
  const completeMonths = months.filter((m) => !m.isPartial);
  if (completeMonths.length >= 2) {
    return {
      selectedKeys: new Set(completeMonths.map((m) => m.key)),
      monthsUsed: completeMonths.map((m) => m.label),
    };
  }

  return {
    selectedKeys: new Set(months.map((m) => m.key)),
    monthsUsed: months.map((m) => m.label),
  };
}
