import type { FinanceTransaction } from "./models";

export const eur = (cents: number, hidden = false) => hidden ? "••••••" : new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(cents / 100);
export const shortDate = (date: string) => new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00`));
export const monthLabel = (date = new Date()) => new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric" }).format(date);
export const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

export function totals(items: FinanceTransaction[]) {
  const active = items.filter((item) => !item.deletedAt);
  const income = active.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amountCents, 0);
  const expense = active.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amountCents, 0);
  return { income, expense, net: income - expense, count: active.length };
}

export function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export function parseEuroInput(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function downloadFile(name: string, type: string, content: BlobPart) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

