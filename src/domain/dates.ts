import type { DateKey } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

/** `2026-11-04` -> `2026-11` */
export function toMonthKey(key: DateKey): string {
  return key.slice(0, 7);
}

export function monthKeyOf(year: number, monthIndex: number): string {
  return `${year}-${pad(monthIndex + 1)}`;
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: DateKey, to: DateKey): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Monday-based weekday (0 = Monday … 6 = Sunday) of the 1st of a month. */
export function mondayOffset(year: number, monthIndex: number): number {
  return (new Date(year, monthIndex, 1).getDay() + 6) % 7;
}

export function formatMonthName(monthIndex: number, style: "long" | "short" = "long"): string {
  return new Date(2000, monthIndex, 1).toLocaleDateString("en-US", { month: style });
}

/** Local-time calendar day for a Date. */
export function toDateKey(date: Date): DateKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parse(key: DateKey): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  // Noon avoids DST edge cases when shifting days.
  return new Date(y, m - 1, d, 12);
}

export function addDays(key: DateKey, days: number): DateKey {
  const date = parse(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export function formatDayLabel(key: DateKey): string {
  return parse(key).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function formatMonthDay(key: DateKey): string {
  return parse(key).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatShortDay(key: DateKey): string {
  return parse(key).toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
}
