"use client";

import { db } from "./database";

export type SyncStatus = "disabled" | "syncing" | "synced" | "offline" | "not-configured" | "error";
type CloudKind = "transaction" | "category" | "account" | "budget" | "recurring" | "importBatch";
type CloudRecord = { kind: CloudKind; id: string; data: Record<string, unknown>; updatedAt: string };

let timer: ReturnType<typeof setTimeout> | undefined;
const notify = (status: SyncStatus) => window.dispatchEvent(new CustomEvent("finanze-sync-status", { detail: status }));

async function tokenFromLink() {
  const match = window.location.hash.match(/(?:^#|&)access=([a-f0-9]{64})/i);
  if (match) {
    await db.settings.put({ key: "cloudAccessToken", value: match[1] });
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return match[1];
  }
  return (await db.settings.get("cloudAccessToken"))?.value;
}

export async function importBundledBackup() {
  const token = await tokenFromLink();
  if (!token) return 0;
  const importedVersion = (await db.settings.get("bundledSeedVersion"))?.value;
  const storedTransactions = await db.transactions.count();
  if (importedVersion === "mmbackup-2026-09-28-v2" && storedTransactions >= 847) return 0;
  try {
    const response = await fetch("/initial-backup.fnc", { cache: "no-store" });
    if (!response.ok) throw new Error("seed unavailable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 4)) !== "FNC1") throw new Error("invalid seed");
    const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(4, 16) }, key, bytes.slice(16));
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as {
      version: string; transactions: Array<Record<string, unknown> & { id: string }>; categories: Array<Record<string, unknown> & { id: string }>;
      accounts: Array<Record<string, unknown> & { id: string }>; recurring: Array<Record<string, unknown> & { id: string }>;
      categoryMigration: Array<{ id: string; categoryId: string }>; importBatch: Record<string, unknown> & { id: string };
    };
    if (payload.version !== "mmbackup-2026-09-28-v2" || payload.transactions.length !== 847 || !Array.isArray(payload.categoryMigration)) throw new Error("unexpected seed");
    const onlyMissing = async <T extends { id: string }>(items: T[], existing: Array<T | undefined>) => items.filter((_, index) => !existing[index]);
    const missingTransactions = await onlyMissing(payload.transactions, await db.transactions.bulkGet(payload.transactions.map((item) => item.id)) as unknown as Array<(Record<string, unknown> & { id: string }) | undefined>);
    const categoryUpsertIds = new Set(["5a6f8f4e-263c-4643-b43a-00f38fbe2b98", "split-aperitivi-analcolici"]);
    const categoryUpserts = payload.categories.filter((item) => categoryUpsertIds.has(item.id));
    const otherCategories = payload.categories.filter((item) => !categoryUpsertIds.has(item.id));
    const missingCategories = await onlyMissing(otherCategories, await db.categories.bulkGet(otherCategories.map((item) => item.id)) as unknown as Array<(Record<string, unknown> & { id: string }) | undefined>);
    const missingAccounts = await onlyMissing(payload.accounts, await db.accounts.bulkGet(payload.accounts.map((item) => item.id)) as unknown as Array<(Record<string, unknown> & { id: string }) | undefined>);
    const missingRecurring = await onlyMissing(payload.recurring, await db.recurring.bulkGet(payload.recurring.map((item) => item.id)) as unknown as Array<(Record<string, unknown> & { id: string }) | undefined>);
    const migrationRecords = await db.transactions.bulkGet(payload.categoryMigration.map((item) => item.id));
    const migrationTimestamp = new Date().toISOString();
    const migratedTransactions = migrationRecords.flatMap((transaction, index) => transaction && transaction.categoryId !== payload.categoryMigration[index].categoryId
      ? [{ ...transaction, categoryId: payload.categoryMigration[index].categoryId, updatedAt: migrationTimestamp }] : []);
    await db.transaction("rw", [db.transactions, db.categories, db.accounts, db.recurring, db.importBatches, db.settings], async () => {
      if (missingTransactions.length) await db.transactions.bulkAdd(missingTransactions as never[]);
      if (missingCategories.length) await db.categories.bulkAdd(missingCategories as never[]);
      if (categoryUpserts.length) await db.categories.bulkPut(categoryUpserts as never[]);
      if (missingAccounts.length) await db.accounts.bulkAdd(missingAccounts as never[]);
      if (missingRecurring.length) await db.recurring.bulkAdd(missingRecurring as never[]);
      if (migratedTransactions.length) await db.transactions.bulkPut(migratedTransactions);
      if (!(await db.importBatches.get(payload.importBatch.id))) await db.importBatches.add(payload.importBatch as never);
      await db.settings.put({ key: "bundledSeedVersion", value: payload.version });
    });
    return missingTransactions.length + migratedTransactions.length;
  } catch { return 0; }
}

const recordDate = (data: Record<string, unknown>) => String(data.updatedAt || data.createdAt || "1970-01-01T00:00:00.000Z");

async function localRecords(): Promise<CloudRecord[]> {
  const groups: Array<[CloudKind, Array<Record<string, unknown> & { id: string }>]> = [
    ["transaction", await db.transactions.toArray() as unknown as Array<Record<string, unknown> & { id: string }>],
    ["category", await db.categories.toArray() as unknown as Array<Record<string, unknown> & { id: string }>],
    ["account", await db.accounts.toArray() as unknown as Array<Record<string, unknown> & { id: string }>],
    ["budget", await db.budgets.toArray() as unknown as Array<Record<string, unknown> & { id: string }>],
    ["recurring", await db.recurring.toArray() as unknown as Array<Record<string, unknown> & { id: string }>],
    ["importBatch", await db.importBatches.toArray() as unknown as Array<Record<string, unknown> & { id: string }>],
  ];
  return groups.flatMap(([kind, items]) => items.map((data) => ({ kind, id: data.id, data, updatedAt: recordDate(data) })));
}

async function applyRemote(records: CloudRecord[]) {
  const byKind = <T>(kind: CloudKind) => records.filter((r) => r.kind === kind).map((r) => r.data as T);
  await db.transaction("rw", [db.transactions, db.categories, db.accounts, db.budgets, db.recurring, db.importBatches], async () => {
    await db.transactions.bulkPut(byKind("transaction"));
    await db.categories.bulkPut(byKind("category"));
    await db.accounts.bulkPut(byKind("account"));
    await db.budgets.bulkPut(byKind("budget"));
    await db.recurring.bulkPut(byKind("recurring"));
    await db.importBatches.bulkPut(byKind("importBatch"));
  });
}

export async function syncNow(): Promise<SyncStatus> {
  const token = await tokenFromLink();
  if (!token) { notify("disabled"); return "disabled"; }
  if (!navigator.onLine) { notify("offline"); return "offline"; }
  notify("syncing");
  try {
    const hasRealData = (await db.transactions.count()) > 0;
    const response = await fetch("/api/sync", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation: "sync", records: hasRealData ? await localRecords() : [] }),
    });
    if (response.status === 503) { notify("not-configured"); return "not-configured"; }
    if (!response.ok) throw new Error("sync rejected");
    const payload = await response.json() as { records: CloudRecord[] };
    await applyRemote(payload.records || []);
    await db.settings.put({ key: "lastCloudSync", value: new Date().toISOString() });
    notify("synced"); return "synced";
  } catch { notify("error"); return "error"; }
}

export function queueCloudSync(delay = 350) {
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

export async function wipeCloud() {
  const token = await tokenFromLink();
  if (!token || !navigator.onLine) return;
  await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: "wipe" }) });
}
