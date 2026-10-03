"use client";

import JSZip from "jszip";
import initSqlJs from "sql.js";
import type { Account, Category, FinanceTransaction, RecurringTransaction } from "./models";

export interface LegacyPreview {
  fileName: string;
  transactions: FinanceTransaction[];
  categories: Category[];
  accounts: Account[];
  recurring: RecurringTransaction[];
  deletedCount: number;
  expenseCount: number;
  incomeCount: number;
  minDate: string;
  maxDate: string;
  warnings: string[];
}

const standardNames: Record<string, string> = {
  DefaultHealth: "Salute", DefaultSalary: "Stipendio", DefaultLeisure: "Tempo libero", DefaultPresent: "Regali ricevuti",
  DefaultHome: "Casa", DefaultPercents: "Interessi", DefaultCafe: "Bar e caffè", DefaultEducation: "Istruzione",
  DefaultPresents: "Regali", DefaultProducts: "Spesa", DefaultFamily: "Famiglia", DefaultSport: "Sport",
  DefaultTransport: "Trasporti", other_expense: "Altre spese", other_income: "Altre entrate",
};

const argbToHex = (value: unknown) => {
  const n = Number(value) >>> 0;
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
};

const rows = (database: initSqlJs.Database, query: string) => {
  const result = database.exec(query)[0];
  if (!result) return [] as Record<string, unknown>[];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, i) => [column, values[i]])));
};

const zipPayload = (data: Uint8Array) => {
  for (let i = 0; i < Math.min(data.length - 3, 1024); i++) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x03 && data[i + 3] === 0x04) return data.slice(i);
  }
  return data;
};

export async function parseMmBackup(file: File): Promise<LegacyPreview> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const zip = await JSZip.loadAsync(zipPayload(raw));
  const dbFile = zip.file("MyFinance.db");
  if (!dbFile) throw new Error("Il backup non contiene MyFinance.db");
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const legacy = new SQL.Database(await dbFile.async("uint8array"));
  try {
    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const categoryRows = rows(legacy, "SELECT uid,title,type,icon,color,isRemoved,isArchived,position,created,modified FROM category");
    const categories: Category[] = categoryRows.map((r) => ({
      id: String(r.uid), name: String(r.title || standardNames[String(r.uid)] || "Senza categoria"), icon: String(r.icon || "Shapes"),
      color: argbToHex(r.color), type: String(r.type).toLowerCase() === "income" ? "income" : "expense",
      archived: Boolean(r.isRemoved || r.isArchived), createdAt: String(r.created || now), updatedAt: String(r.modified || now), position: Number(r.position || 0),
    }));
    const accountRows = rows(legacy, "SELECT uid,title,icon,isRemoved,isArchived,created,modified FROM account");
    const accounts: Account[] = accountRows.map((r) => ({
      id: String(r.uid), name: String(r.title || "Conto principale"), type: String(r.icon) === "cash" ? "cash" : "current", initialBalanceCents: 0,
      archived: Boolean(r.isRemoved || r.isArchived), createdAt: String(r.created || now), updatedAt: String(r.modified || now),
    }));
    const transactionRows = rows(legacy, `SELECT t.*, MAX(CASE WHEN l.otherType='Category' AND l.isRemoved=0 THEN l.otherUid END) categoryId, MAX(CASE WHEN l.otherType='Account' AND l.isRemoved=0 THEN l.otherUid END) accountId FROM "transaction" t LEFT JOIN sync_link l ON l.entityType='Transaction' AND l.entityUid=t.uid GROUP BY t.uid`);
    let deletedCount = 0;
    const transactions: FinanceTransaction[] = [];
    for (const r of transactionRows) {
      if (Number(r.isRemoved)) { deletedCount++; continue; }
      const originalId = String(r.uid);
      const date = String(r.date).slice(0, 10);
      const type = String(r.type).toLowerCase() === "income" ? "income" : "expense";
      transactions.push({
        id: `mm-${originalId}`, originalId, type, amountCents: Math.abs(Number(r.amountInDefaultCurrency || r.amountInAccountCurrency || 0)), date,
        time: "12:00", categoryId: String(r.categoryId || (type === "income" ? "other_income" : "other_expense")), accountId: String(r.accountId || accounts[0]?.id || "main"),
        description: String(r.comment || ""), notes: "", createdAt: String(r.created || now), updatedAt: String(r.modified || now), source: "mmbackup", importBatchId: batchId,
        fingerprint: `${originalId}:${date}:${r.amountInDefaultCurrency}:${r.type}`,
      });
    }
    const recurringRows = rows(legacy, "SELECT * FROM reminding WHERE remindingType='regularPayments' AND isRemoved=0");
    const recurring: RecurringTransaction[] = recurringRows.map((r) => ({
      id: String(r.uid), type: String(r.transactionType).toLowerCase() === "income" ? "income" : "expense", amountCents: Number(r.amount || 0),
      categoryId: "other_expense", accountId: accounts[0]?.id || "main", description: String(r.title || r.text || "Ricorrenza"),
      frequency: String(r.period).toLowerCase() === "year" ? "yearly" : String(r.period).toLowerCase() === "week" ? "weekly" : "monthly",
      interval: 1, nextDate: String(r.startDate || now).slice(0, 10), endDate: r.endDate ? String(r.endDate).slice(0, 10) : undefined, active: Boolean(r.enabled),
    }));
    const dates = transactions.map((t) => t.date).sort();
    return {
      fileName: file.name, transactions, categories, accounts, recurring, deletedCount,
      expenseCount: transactions.filter((t) => t.type === "expense").length, incomeCount: transactions.filter((t) => t.type === "income").length,
      minDate: dates[0] || "", maxDate: dates.at(-1) || "", warnings: transactions.some((t) => !t.categoryId) ? ["Alcuni movimenti non hanno una categoria."] : [],
    };
  } finally { legacy.close(); }
}
