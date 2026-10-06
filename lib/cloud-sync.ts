"use client";

import { db } from "./database";

export type SyncStatus = "syncing" | "synced" | "offline" | "not-configured" | "error";
type CloudKind = "transaction" | "category" | "account" | "budget" | "recurring" | "importBatch";
type CloudRecord = { kind: CloudKind; id: string; data: Record<string, unknown>; updatedAt: string };

let timer: ReturnType<typeof setTimeout> | undefined;
const notify = (status: SyncStatus) => window.dispatchEvent(new CustomEvent("finanze-sync-status", { detail: status }));

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
  if (!navigator.onLine) { notify("offline"); return "offline"; }
  notify("syncing");
  try {
    const hasRealData = (await db.transactions.count()) > 0;
    const response = await fetch("/api/sync", {
      method: "POST", headers: { "content-type": "application/json" },
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
  if (!navigator.onLine) return;
  await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "wipe" }) });
}
