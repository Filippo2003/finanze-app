import type { FinanceTransaction } from "./models";

export function newId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  webCrypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

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

