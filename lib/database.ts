"use client";

import Dexie, { type EntityTable } from "dexie";
import type { Account, Budget, Category, FinanceTransaction, ImportBatch, RecurringTransaction, Setting } from "./models";

export class FinanceDatabase extends Dexie {
  transactions!: EntityTable<FinanceTransaction, "id">;
  categories!: EntityTable<Category, "id">;
  accounts!: EntityTable<Account, "id">;
  budgets!: EntityTable<Budget, "id">;
  recurring!: EntityTable<RecurringTransaction, "id">;
  settings!: EntityTable<Setting, "key">;
  importBatches!: EntityTable<ImportBatch, "id">;

  constructor() {
    super("finanze-db");
    this.version(1).stores({
      transactions: "id, originalId, date, categoryId, accountId, type, source, importBatchId, fingerprint, deletedAt, [source+originalId]",
      categories: "id, name, type, archived, parentCategoryId, position",
      accounts: "id, name, type, archived",
      budgets: "id, categoryId, period, active",
      recurring: "id, nextDate, active, categoryId, accountId",
      settings: "key",
      importBatches: "id, source, importedAt",
    });
  }
}

export const db = new FinanceDatabase();

const now = () => new Date().toISOString();
const defaults: Category[] = [
  ["food", "Ristoranti e bar", "Utensils", "#ff8a4c"],
  ["shopping", "Shopping", "ShoppingBag", "#9b72ef"],
  ["transport", "Trasporti", "Car", "#4c86f7"],
  ["subscriptions", "Abbonamenti", "Repeat2", "#31a67a"],
  ["health", "Salute", "HeartPulse", "#ef5d72"],
  ["home", "Casa", "House", "#e0a22b"],
  ["salary", "Stipendio", "Landmark", "#2da66f"],
  ["other", "Altro", "Shapes", "#7d8793"],
].map(([id, name, icon, color], position) => ({
  id, name, icon, color, type: id === "salary" ? "income" : "expense", archived: false, createdAt: now(), updatedAt: now(), position,
} as Category));

export async function ensureDefaults() {
  if (await db.accounts.count() === 0) {
    await db.accounts.add({ id: "main", name: "Conto principale", type: "current", initialBalanceCents: 0, archived: false, createdAt: now(), updatedAt: now() });
  }
  if (await db.categories.count() === 0) await db.categories.bulkAdd(defaults);
  if (!(await db.settings.get("theme"))) await db.settings.bulkPut([
    { key: "theme", value: "system" }, { key: "privacyMode", value: "false" }, { key: "currency", value: "EUR" },
  ]);
}

export async function clearAllData() {
  await db.transaction("rw", db.tables, async () => Promise.all(db.tables.map((table) => table.clear())));
}

