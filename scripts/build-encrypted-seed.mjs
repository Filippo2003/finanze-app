import fs from "node:fs";
import crypto from "node:crypto";
import JSZip from "jszip";
import initSqlJs from "sql.js";

const backupPath = process.argv[2];
if (!backupPath) throw new Error("backup path required");

const standardNames = {
  DefaultHealth: "Salute", DefaultSalary: "Stipendio", DefaultLeisure: "Tempo libero", DefaultPresent: "Regali ricevuti",
  DefaultHome: "Casa", DefaultPercents: "Interessi", DefaultCafe: "Bar e caffè", DefaultEducation: "Istruzione",
  DefaultPresents: "Regali", DefaultProducts: "Spesa", DefaultFamily: "Famiglia", DefaultSport: "Sport",
  DefaultTransport: "Trasporti", other_expense: "Altre spese", other_income: "Altre entrate",
};
const argbToHex = (value) => `#${((Number(value) >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
const rows = (database, query) => {
  const result = database.exec(query)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
};
const readSecret = () => new Promise((resolve) => process.stdin.once("data", (chunk) => resolve(chunk.toString().trim())));

const token = await readSecret();
if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("invalid encryption token");
let archive = new Uint8Array(fs.readFileSync(backupPath));
let offset = 0;
for (let index = 0; index < Math.min(1024, archive.length - 3); index++) {
  if (archive[index] === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 0x03 && archive[index + 3] === 0x04) { offset = index; break; }
}
const zip = await JSZip.loadAsync(archive.slice(offset));
const sqliteFile = zip.file("MyFinance.db");
if (!sqliteFile) throw new Error("MyFinance.db missing");
const SQL = await initSqlJs({ locateFile: (file) => new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url).pathname });
const legacy = new SQL.Database(await sqliteFile.async("uint8array"));
const now = new Date().toISOString();
const batchId = "bundled-mmbackup-2026-09-28";
const mixedCategoryId = "5a6f8f4e-263c-4643-b43a-00f38fbe2b98";
const alcoholCategoryId = "49bd3abb-bc3b-4eae-9676-4c49834fda5a";
const softDrinkCategoryId = "split-aperitivi-analcolici";

const normalizeDescription = (value) => String(value || "").trim().toLocaleLowerCase("it-IT");
const softDrinkOverrides = new Set([
  "antonella jesolo", "avenue chicca", "avenue tommi", "baessato linda", "casabianca nico linda",
  "chiosco pav linda camilla", "chiosco pav linda e tommi", "chiosco pav linda pegna", "chiosco tango pav e ale",
  "divino linda", "pav linda", "prosciutteria tommi", "tango linda",
]);
const alcoholOverrides = new Set(["casabianca", "j44 linda"]);
const alcoholPattern = /(birra|vino|prosecco|gin tonic|spritz|lugana|pinot grigio)/i;
const softDrinkPattern = /(coca|acqua|caffe|caffè|ginseng|cioccolata|succo|\bte\b|\bthe\b|aperitivo)/i;
const splitCategory = (description) => {
  const normalized = normalizeDescription(description);
  if (softDrinkOverrides.has(normalized)) return softDrinkCategoryId;
  if (alcoholOverrides.has(normalized)) return alcoholCategoryId;
  const hasAlcohol = alcoholPattern.test(normalized);
  const hasSoftDrink = softDrinkPattern.test(normalized);
  if (hasAlcohol) return hasSoftDrink ? softDrinkCategoryId : alcoholCategoryId;
  return hasSoftDrink ? softDrinkCategoryId : mixedCategoryId;
};

const categories = rows(legacy, "SELECT uid,title,type,icon,color,isRemoved,isArchived,position,created,modified FROM category").map((row) => ({
  id: String(row.uid), name: String(row.uid) === mixedCategoryId ? "Pranzi e cene" : String(row.title || standardNames[String(row.uid)] || "Senza categoria"), icon: String(row.icon || "Shapes"),
  color: argbToHex(row.color), type: String(row.type).toLowerCase() === "income" ? "income" : "expense", archived: Boolean(row.isRemoved || row.isArchived),
  createdAt: String(row.created || now), updatedAt: String(row.uid) === mixedCategoryId ? now : String(row.modified || now), position: Number(row.position || 0),
}));
categories.push({ id: softDrinkCategoryId, name: "Aperitivi analcolici", icon: "Cafe", color: "#32ADE6", type: "expense", archived: false,
  createdAt: now, updatedAt: now, position: Math.max(...categories.map((category) => category.position || 0), 0) + 1 });
const accounts = rows(legacy, "SELECT uid,title,icon,isRemoved,isArchived,created,modified FROM account").map((row) => ({
  id: String(row.uid), name: String(row.title || "Conto principale"), type: String(row.icon) === "cash" ? "cash" : "current", initialBalanceCents: 0,
  archived: Boolean(row.isRemoved || row.isArchived), createdAt: String(row.created || now), updatedAt: String(row.modified || now),
}));
const transactionRows = rows(legacy, `SELECT t.*, MAX(CASE WHEN l.otherType='Category' AND l.isRemoved=0 THEN l.otherUid END) categoryId, MAX(CASE WHEN l.otherType='Account' AND l.isRemoved=0 THEN l.otherUid END) accountId FROM "transaction" t LEFT JOIN sync_link l ON l.entityType='Transaction' AND l.entityUid=t.uid GROUP BY t.uid`);
const transactions = transactionRows.filter((row) => !Number(row.isRemoved)).map((row) => {
  const originalId = String(row.uid); const date = String(row.date).slice(0, 10); const type = String(row.type).toLowerCase() === "income" ? "income" : "expense";
  const originalCategoryId = String(row.categoryId || (type === "income" ? "other_income" : "other_expense"));
  const description = String(row.comment || "");
  return { id: `mm-${originalId}`, originalId, type, amountCents: Math.abs(Number(row.amountInDefaultCurrency || row.amountInAccountCurrency || 0)), date, time: "12:00",
    categoryId: originalCategoryId === mixedCategoryId ? splitCategory(description) : originalCategoryId, accountId: String(row.accountId || accounts[0]?.id || "main"),
    description, notes: "", createdAt: String(row.created || now), updatedAt: String(row.modified || now), source: "mmbackup", importBatchId: batchId,
    fingerprint: `${originalId}:${date}:${row.amountInDefaultCurrency}:${row.type}` };
});
const recurring = rows(legacy, "SELECT * FROM reminding WHERE remindingType='regularPayments' AND isRemoved=0").map((row) => ({
  id: String(row.uid), type: String(row.transactionType).toLowerCase() === "income" ? "income" : "expense", amountCents: Number(row.amount || 0), categoryId: "other_expense",
  accountId: accounts[0]?.id || "main", description: String(row.title || row.text || "Ricorrenza"), frequency: String(row.period).toLowerCase() === "year" ? "yearly" : String(row.period).toLowerCase() === "week" ? "weekly" : "monthly",
  interval: 1, nextDate: String(row.startDate || now).slice(0, 10), endDate: row.endDate ? String(row.endDate).slice(0, 10) : undefined, active: Boolean(row.enabled), updatedAt: String(row.modified || now),
}));
legacy.close();

const categoryMigration = transactions.filter((transaction) => transaction.originalId && transactionRows.some((row) => String(row.uid) === transaction.originalId && String(row.categoryId) === mixedCategoryId))
  .map((transaction) => ({ id: transaction.id, categoryId: transaction.categoryId }));
const payload = Buffer.from(JSON.stringify({ version: "mmbackup-2026-09-28-v2", transactions, categories, accounts, recurring, categoryMigration, importBatch: { id: batchId, source: "mmbackup", fileName: "Budget e Finanze.mmbackup", importedAt: now, total: transactions.length, skipped: 0 } }));
const key = crypto.createHash("sha256").update(token).digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
const output = Buffer.concat([Buffer.from("FNC1"), iv, encrypted, cipher.getAuthTag()]);
fs.writeFileSync(new URL("../public/initial-backup.fnc", import.meta.url), output);
console.log(JSON.stringify({ transactions: transactions.length, categories: categories.length, accounts: accounts.length, migrated: categoryMigration.length,
  split: Object.fromEntries([[mixedCategoryId, "Pranzi e cene"], [softDrinkCategoryId, "Aperitivi analcolici"], [alcoholCategoryId, "Alcool"]].map(([id, name]) => [name, transactions.filter((transaction) => transaction.categoryId === id).length])), encryptedBytes: output.length }));
