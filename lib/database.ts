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

export async function deduplicateCategories() {
  if ((await db.settings.get("categoryDedupVersion"))?.value === "v2") return 0;
  const categories = await db.categories.toArray();
  const transactions = await db.transactions.toArray();
  const usage = new Map<string, number>();
  for (const transaction of transactions) usage.set(transaction.categoryId, (usage.get(transaction.categoryId) || 0) + 1);
  const groups = new Map<string, Category[]>();
  for (const category of categories) {
    if (category.archived) continue;
    const key = `${category.type}:${category.name.trim().toLocaleLowerCase("it-IT")}`;
    groups.set(key, [...(groups.get(key) || []), category]);
  }
  const replacements = new Map<string, string>();
  const archived: Category[] = [];
  const timestamp = now();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0));
    const keep = sorted[0];
    for (const duplicate of sorted.slice(1)) {
      replacements.set(duplicate.id, keep.id);
      archived.push({ ...duplicate, archived: true, updatedAt: timestamp });
    }
  }
  const migrated = transactions.flatMap((transaction) => {
    const categoryId = replacements.get(transaction.categoryId);
    return categoryId ? [{ ...transaction, categoryId, updatedAt: timestamp }] : [];
  });
  await db.transaction("rw", [db.transactions, db.categories, db.settings], async () => {
    if (migrated.length) await db.transactions.bulkPut(migrated);
    if (archived.length) await db.categories.bulkPut(archived);
    await db.settings.put({ key: "categoryDedupVersion", value: "v2" });
  });
  return migrated.length + archived.length;
}

export async function clearAllData() {
  await db.transaction("rw", db.tables, async () => Promise.all(db.tables.map((table) => table.clear())));
}

