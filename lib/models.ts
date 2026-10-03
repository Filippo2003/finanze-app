export type TransactionType = "expense" | "income";

export interface FinanceTransaction {
  id: string;
  originalId?: string;
  type: TransactionType;
  amountCents: number;
  date: string;
  time: string;
  categoryId: string;
  accountId: string;
  description: string;
  notes: string;
  recurringId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  source: "manual" | "mmbackup" | "csv" | "future_import";
  importBatchId?: string;
  fingerprint?: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  type: TransactionType | "both";
  parentCategoryId?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  position?: number;
}

export interface Account {
  id: string;
  name: string;
  type: "current" | "card" | "cash" | "saving" | "other";
  initialBalanceCents: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Budget {
  id: string;
  categoryId?: string;
  period: "monthly" | "weekly" | "yearly";
  limitCents: number;
  startDate: string;
  endDate?: string;
  active: boolean;
  updatedAt?: string;
}

export interface RecurringTransaction {
  id: string;
  type: TransactionType;
  amountCents: number;
  categoryId: string;
  accountId: string;
  description: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly" | "custom";
  interval: number;
  nextDate: string;
  endDate?: string;
  active: boolean;
  updatedAt?: string;
}

export interface Setting { key: string; value: string }
export interface ImportBatch { id: string; source: string; fileName: string; importedAt: string; total: number; skipped: number }

export interface FinanceBackup {
  schemaVersion: number;
  createdAt: string;
  transactions: FinanceTransaction[];
  categories: Category[];
  accounts: Account[];
  budgets: Budget[];
  recurring: RecurringTransaction[];
  settings: Setting[];
}
