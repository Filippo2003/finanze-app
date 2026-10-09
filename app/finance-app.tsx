"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BarChart3, CalendarDays, Check, ChevronRight, CircleDollarSign, Cloud, CloudOff, Download, Eye, EyeOff, FileArchive, FileJson, House, Landmark, ListFilter, Moon, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Trash2, Upload, Utensils, WalletCards, X } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast, Toaster } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { db, ensureDefaults, clearAllData, deduplicateCategories } from "@/lib/database";
import { downloadFile, eur, monthKey, monthLabel, newId, parseEuroInput, percentChange, shortDate, totals } from "@/lib/finance";
import { parseMmBackup, type LegacyPreview } from "@/lib/legacy-importer";
import { queueCloudSync, syncNow, wipeCloud, type SyncStatus } from "@/lib/cloud-sync";
import type { Budget, Category, FinanceBackup, FinanceTransaction, TransactionType } from "@/lib/models";

type View = "home" | "transactions" | "stats" | "more";
const today = () => new Date().toLocaleDateString("sv-SE");
const nowTime = () => new Date().toTimeString().slice(0, 5);

function iconFor(category?: Category) {
  const name = category?.icon?.toLowerCase() || "";
  if (/food|cafe|burger|wine|products/.test(name)) return Utensils;
  if (/bank|prepaid/.test(name) || category?.type === "income") return Landmark;
  return CircleDollarSign;
}

export function FinanceApp() {
  const [view, setView] = useState<View>("home");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<FinanceTransaction | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("syncing");
  useEffect(() => {
    let cancelled = false;
    const onStatus = (event: Event) => setSyncStatus((event as CustomEvent<SyncStatus>).detail);
    const onOnline = () => void syncNow();
    window.addEventListener("finanze-sync-status", onStatus);
    window.addEventListener("online", onOnline);
    void (async () => {
      try {
        const status = await syncNow();
        if (cancelled) return;
        setSyncStatus(status);
        const cleaned = await deduplicateCategories();
        await ensureDefaults();
        if (cleaned) queueCloudSync(100);
        setPrivacy((await db.settings.get("privacyMode"))?.value === "true");
      } catch {
        if (!cancelled) setSyncStatus("error");
      }
    })();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => registration.update()).catch(() => undefined);
    return () => { cancelled = true; window.removeEventListener("finanze-sync-status", onStatus); window.removeEventListener("online", onOnline); };
  }, []);
  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: "create_finance_transaction", title: "Registra movimento", description: "Registra una spesa o un'entrata nell'archivio locale Finanze.",
      inputSchema: { type: "object", properties: { type: { enum: ["expense", "income"] }, amountCents: { type: "integer", minimum: 1 }, categoryId: { type: "string" }, accountId: { type: "string" }, description: { type: "string" }, date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, required: ["type", "amountCents", "categoryId", "accountId", "description"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input: unknown) {
        const value = input as Partial<FinanceTransaction>;
        if ((value.type !== "expense" && value.type !== "income") || !Number.isInteger(value.amountCents) || Number(value.amountCents) <= 0 || !value.categoryId || !value.accountId) throw new Error("Dati del movimento non validi");
        if (!(await db.categories.get(value.categoryId)) || !(await db.accounts.get(value.accountId))) throw new Error("Categoria o conto inesistente");
        const stamp = new Date().toISOString(); const id = newId();
        await db.transactions.add({ id, type: value.type, amountCents: Number(value.amountCents), date: value.date || today(), time: nowTime(), categoryId: value.categoryId, accountId: value.accountId, description: String(value.description || ""), notes: "", createdAt: stamp, updatedAt: stamp, source: "manual" }); queueCloudSync();
        return { id, status: "saved" };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);
  const transactions = useLiveQuery(() => db.transactions.orderBy("date").reverse().toArray(), [], []) || [];
  const categories = useLiveQuery(() => db.categories.orderBy("position").toArray(), [], []) || [];
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], []) || [];
  const budgets = useLiveQuery(() => db.budgets.toArray(), [], []) || [];
  const togglePrivacy = async () => { const next = !privacy; setPrivacy(next); await db.settings.put({ key: "privacyMode", value: String(next) }); };
  return <div className="app-shell"><main className="main-content">
    {view === "home" && <Dashboard transactions={transactions} categories={categories} budgets={budgets} privacy={privacy} onTogglePrivacy={togglePrivacy} onOpenTransaction={setEditing} />}
    {view === "transactions" && <Transactions transactions={transactions} categories={categories} accounts={accounts} privacy={privacy} onOpen={setEditing} />}
    {view === "stats" && <Statistics transactions={transactions} categories={categories} privacy={privacy} />}
    {view === "more" && <More categories={categories} transactions={transactions} budgets={budgets} privacy={privacy} onTogglePrivacy={togglePrivacy} syncStatus={syncStatus} onSync={() => void syncNow()} />}
  </main><nav className="bottom-nav" aria-label="Navigazione principale">
    <NavButton active={view === "home"} label="Home" onClick={() => setView("home")}><House /></NavButton>
    <NavButton active={view === "transactions"} label="Movimenti" onClick={() => setView("transactions")}><WalletCards /></NavButton>
    <button type="button" className="add-button" aria-label="Aggiungi movimento" onClick={() => { if (!categories.some((category) => !category.archived) || !accounts.length) { toast.info("Sto caricando categorie e conto…"); void syncNow(); return; } setAddOpen(true); }}><Plus /></button>
    <NavButton active={view === "stats"} label="Statistiche" onClick={() => setView("stats")}><BarChart3 /></NavButton>
    <NavButton active={view === "more"} label="Altro" onClick={() => setView("more")}><MoreHorizontal /></NavButton>
  </nav>{(addOpen || editing) && <TransactionDialog key={editing?.id || "new-transaction"} transaction={editing} categories={categories} accounts={accounts} onClose={() => { setAddOpen(false); setEditing(null); }} />}<Toaster position="top-center" richColors /></div>;
}

function NavButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) { return <button type="button" className={active ? "nav-item active" : "nav-item"} aria-current={active ? "page" : undefined} onClick={onClick}>{children}<span>{label}</span></button>; }

function ActivityRings({ expense, income, budget }: { expense: number; income: number; budget?: Budget }) {
  const expenseProgress = budget ? Math.min(1, expense / budget.limitCents) : Math.min(1, expense / 150000);
  const savingProgress = income ? Math.max(0, Math.min(1, (income - expense) / income)) : 0;
  const incomeProgress = Math.min(1, income / 250000);
  const ring = (radius: number, progress: number, color: string, width: number) => {
    const circumference = 2 * Math.PI * radius;
    return <><circle cx="70" cy="70" r={radius} fill="none" stroke={`${color}24`} strokeWidth={width}/><circle cx="70" cy="70" r={radius} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} transform="rotate(-90 70 70)"/></>;
  };
  return <svg className="activity-rings" viewBox="0 0 140 140" role="img" aria-label="Riepilogo attività finanziaria">{ring(54, expenseProgress, "#ff2d55", 11)}{ring(39, savingProgress, "#b8f600", 10)}{ring(25, incomeProgress, "#00d7ff", 9)}</svg>;
}

function Dashboard({ transactions, categories, budgets, privacy, onTogglePrivacy, onOpenTransaction }: { transactions: FinanceTransaction[]; categories: Category[]; budgets: Budget[]; privacy: boolean; onTogglePrivacy: () => void; onOpenTransaction: (t: FinanceTransaction) => void }) {
  const active = transactions.filter((t) => !t.deletedAt); const all = totals(active); const key = monthKey(); const monthItems = active.filter((t) => t.date.startsWith(key)); const month = totals(monthItems);
  const previousDate = new Date(); previousDate.setMonth(previousDate.getMonth() - 1); const previous = totals(active.filter((t) => t.date.startsWith(monthKey(previousDate)))); const change = percentChange(month.expense, previous.expense);
  const categoryMap = new Map(categories.map((c) => [c.id, c])); const top = Object.entries(monthItems.filter((t) => t.type === "expense").reduce<Record<string, number>>((a, t) => { a[t.categoryId] = (a[t.categoryId] || 0) + t.amountCents; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const generalBudget = budgets.find((b) => !b.categoryId && b.active); const used = generalBudget ? Math.min(100, Math.round(month.expense / generalBudget.limitCents * 100)) : 0;
  return <><header className="topbar"><div><p className="eyebrow">{monthLabel()}</p><h1>Riepilogo</h1></div><button className="icon-button" onClick={onTogglePrivacy} aria-label={privacy ? "Mostra importi" : "Nascondi importi"}>{privacy ? <EyeOff /> : <Eye />}</button></header>
    <section className="balance-hero fitness-summary"><div className="fitness-copy"><div className="balance-top"><span>Saldo totale</span><span className="balance-badge">{active.length} movimenti</span></div><strong>{eur(all.net, privacy)}</strong><p>La tua attività finanziaria di {monthLabel().split(" ")[0]}</p></div><ActivityRings expense={month.expense} income={month.income} budget={generalBudget}/><div className="flow-grid"><div><span><i className="fitness-dot pink"/>Uscite</span><b>{eur(month.expense, privacy)}</b></div><div><span><i className="fitness-dot green"/>Risparmio</span><b>{eur(month.net, privacy)}</b></div><div><span><i className="fitness-dot cyan"/>Entrate</span><b>{eur(month.income, privacy)}</b></div></div></section>
    <section className="insight-row"><article className="insight-card"><span className="mini-icon coral"><Sparkles /></span><div><p>Risparmio del mese</p><strong>{eur(month.net, privacy)}</strong><small>{month.income ? `${Math.round(month.net / month.income * 100)}% delle entrate` : "Aggiungi un’entrata"}</small></div></article><article className="insight-card"><span className="mini-icon violet"><BarChart3 /></span><div><p>Rispetto al mese scorso</p><strong>{change === null ? "Nuovo periodo" : `${Math.abs(Math.round(change))}% ${change <= 0 ? "in meno" : "in più"}`}</strong><small>{previous.count ? `${eur(Math.abs(month.expense - previous.expense), privacy)} di differenza` : "Nessun dato precedente"}</small></div></article></section>
    <section className="section-block"><div className="section-heading"><div><span className="eyebrow">IN EVIDENZA</span><h2>Budget mensile</h2></div></div>{generalBudget ? <div className="budget-panel"><div><strong>{eur(month.expense, privacy)}</strong><span> di {eur(generalBudget.limitCents, privacy)}</span></div><div className="progress-track"><i style={{ width: `${used}%` }} /></div><small>{used}% utilizzato · {eur(Math.max(0, generalBudget.limitCents - month.expense), privacy)} disponibili</small></div> : <div className="empty-action"><span>Nessun budget generale</span><ChevronRight /></div>}</section>
    <section className="section-block"><div className="section-heading"><div><span className="eyebrow">DOVE STAI SPENDENDO</span><h2>Categorie principali</h2></div></div>{top.length ? <div className="category-bars">{top.map(([id, value], i) => <div className="category-bar" key={id}><div className="category-rank" style={{ background: categoryMap.get(id)?.color }}>{i + 1}</div><div><div className="bar-label"><span>{categoryMap.get(id)?.name || "Senza categoria"}</span><b>{eur(value, privacy)}</b></div><div className="progress-track subtle"><i style={{ width: `${Math.round(value / top[0][1] * 100)}%`, background: categoryMap.get(id)?.color }} /></div></div></div>)}</div> : <EmptyState text="Le categorie compariranno qui appena aggiungi una spesa." />}</section>
    <section className="section-block recent-section"><div className="section-heading"><div><span className="eyebrow">ULTIMI MOVIMENTI</span><h2>Recenti</h2></div></div><TransactionList items={active.slice(0, 6)} categories={categoryMap} privacy={privacy} onOpen={onOpenTransaction} /></section></>;
}

function Transactions({ transactions, categories, accounts, privacy, onOpen }: { transactions: FinanceTransaction[]; categories: Category[]; accounts: {id:string;name:string}[]; privacy: boolean; onOpen: (t: FinanceTransaction) => void }) {
  const [query, setQuery] = useState(""); const [type, setType] = useState<"all" | TransactionType>("all"); const [visibleCount, setVisibleCount] = useState(60); const categoryMap = new Map(categories.map((c) => [c.id, c])); const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
  const filtered = transactions.filter((t) => !t.deletedAt).filter((t) => type === "all" || t.type === type).filter((t) => `${t.description} ${t.notes} ${categoryMap.get(t.categoryId)?.name} ${(t.amountCents / 100).toFixed(2)}`.toLowerCase().includes(query.toLowerCase()));
  const grouped = filtered.slice(0, visibleCount).reduce<Record<string, FinanceTransaction[]>>((a, t) => { (a[t.date] ||= []).push(t); return a; }, {});
  const changeType = (next: "all" | TransactionType) => { setType(next); setVisibleCount(60); };
  return <><header className="topbar"><div><p className="eyebrow">ARCHIVIO</p><h1>Movimenti</h1></div><ListFilter className="muted-icon" /></header><div className="search-box"><Search /><input value={query} onChange={(e) => { setQuery(e.target.value); setVisibleCount(60); }} placeholder="Cerca descrizione, categoria o importo" aria-label="Cerca movimenti" />{query && <button onClick={() => setQuery("")}><X /></button>}</div><div className="segmented"><button className={type === "all" ? "active" : ""} onClick={() => changeType("all")}>Tutti</button><button className={type === "expense" ? "active" : ""} onClick={() => changeType("expense")}>Spese</button><button className={type === "income" ? "active" : ""} onClick={() => changeType("income")}>Entrate</button></div><div className="grouped-list">{Object.entries(grouped).map(([date, items]) => <section key={date}><div className="date-label"><span>{date === today() ? "Oggi" : shortDate(date)}</span><b>{eur(totals(items).net, privacy)}</b></div><TransactionList items={items} categories={categoryMap} privacy={privacy} accounts={accountMap} onOpen={onOpen} /></section>)}</div>{visibleCount < filtered.length && <button className="load-more" onClick={() => setVisibleCount((count) => count + 60)}>Mostra altri movimenti</button>}{!filtered.length && <EmptyState text={query ? "Nessun movimento corrisponde alla ricerca." : "Non ci sono ancora movimenti."} />}</>;
}

function TransactionList({ items, categories, accounts, privacy, onOpen }: { items: FinanceTransaction[]; categories: Map<string, Category>; accounts?: Map<string, string>; privacy: boolean; onOpen: (t: FinanceTransaction) => void }) {
  if (!items.length) return <EmptyState text="Nessun movimento recente." />;
  return <div className="transaction-list">{items.map((t) => { const category = categories.get(t.categoryId); const Icon = iconFor(category); return <button className="transaction-row" key={t.id} onClick={() => onOpen(t)}><span className="transaction-icon" style={{ color: category?.color, background: `${category?.color || "#7d8793"}18` }}><Icon /></span><span className="transaction-main"><b>{t.description || category?.name || "Movimento"}</b><small>{category?.name || "Senza categoria"}{accounts ? ` · ${accounts.get(t.accountId) || "Conto"}` : ` · ${shortDate(t.date)}`}</small></span><strong className={t.type}>{t.type === "expense" ? "−" : "+"}{eur(t.amountCents, privacy)}</strong></button>; })}</div>;
}

function Statistics({ transactions, categories, privacy }: { transactions: FinanceTransaction[]; categories: Category[]; privacy: boolean }) {
  type StatsPeriod = "month" | "year" | "all" | "custom";
  const active = transactions.filter((transaction) => !transaction.deletedAt);
  const availableDates = active.map((transaction) => transaction.date).sort();
  const [period, setPeriod] = useState<StatsPeriod>("month");
  const [customFrom, setCustomFrom] = useState(availableDates[0] || `${new Date().getFullYear()}-01-01`);
  const [customTo, setCustomTo] = useState(today());
  const currentYear = String(new Date().getFullYear());
  const firstAvailable = availableDates[0] || today();
  const lastAvailable = availableDates.at(-1) || today();
  const from = period === "month" ? `${monthKey()}-01` : period === "year" ? `${currentYear}-01-01` : period === "all" ? firstAvailable : customFrom;
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toLocaleDateString("sv-SE");
  const to = period === "month" ? monthEnd : period === "year" ? `${currentYear}-12-31` : period === "all" ? lastAvailable : customTo;
  const rangeValid = Boolean(from && to && from <= to);
  const filtered = rangeValid ? active.filter((transaction) => transaction.date >= from && transaction.date <= to) : [];
  const sum = totals(filtered);
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const dayMs = 86_400_000;
  const rangeDays = rangeValid ? Math.max(1, Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / dayMs) + 1) : 0;
  const previousEndDate = new Date(`${from}T12:00:00`); previousEndDate.setDate(previousEndDate.getDate() - 1);
  const previousStartDate = new Date(previousEndDate); previousStartDate.setDate(previousStartDate.getDate() - Math.max(0, rangeDays - 1));
  const previousFrom = previousStartDate.toLocaleDateString("sv-SE");
  const previousTo = previousEndDate.toLocaleDateString("sv-SE");
  const previous = totals(active.filter((transaction) => rangeValid && transaction.date >= previousFrom && transaction.date <= previousTo));
  const expenseChange = percentChange(sum.expense, previous.expense);
  const activeDays = new Set(filtered.map((transaction) => transaction.date)).size;
  const savingRate = sum.income ? Math.round((sum.net / sum.income) * 100) : null;
  const dailyAverage = activeDays ? Math.round(sum.expense / activeDays) : 0;
  const biggestExpense = filtered.filter((transaction) => transaction.type === "expense").sort((a, b) => b.amountCents - a.amountCents)[0];
  const expenseGroups = filtered.filter((transaction) => transaction.type === "expense").reduce<Record<string, { value: number; count: number }>>((result, transaction) => {
    result[transaction.categoryId] ||= { value: 0, count: 0 };
    result[transaction.categoryId].value += transaction.amountCents;
    result[transaction.categoryId].count += 1;
    return result;
  }, {});
  const pie = Object.entries(expenseGroups).map(([id, data]) => ({ id, name: categoryMap.get(id)?.name || "Altro", value: data.value, count: data.count, color: categoryMap.get(id)?.color || "#7d8793", percent: sum.expense ? Math.round(data.value / sum.expense * 100) : 0 })).sort((a, b) => b.value - a.value);
  const useMonths = rangeDays > 93;
  const trend = Object.entries(filtered.reduce<Record<string, { expense: number; income: number }>>((result, transaction) => {
    const key = useMonths ? transaction.date.slice(0, 7) : transaction.date;
    result[key] ||= { expense: 0, income: 0 };
    result[key][transaction.type] += transaction.amountCents / 100;
    return result;
  }, {})).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ date: useMonths ? new Intl.DateTimeFormat("it-IT", { month: "short", year: "2-digit" }).format(new Date(`${key}-15T12:00:00`)) : new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "short" }).format(new Date(`${key}T12:00:00`)), ...values }));
  const periodLabel = rangeValid ? `${shortDate(from)} ${from.slice(0, 4) !== to.slice(0, 4) ? from.slice(0, 4) : ""} – ${shortDate(to)} ${to.slice(0, 4)}` : "Intervallo non valido";
  const selectPeriod = (next: StatsPeriod) => setPeriod(next);
  return <><header className="topbar"><div><p className="eyebrow">ANALISI DETTAGLIATA</p><h1>Statistiche</h1></div><CalendarDays className="muted-icon" /></header>
    <div className="segmented stats-period"><button type="button" className={period === "month" ? "active" : ""} onClick={() => selectPeriod("month")}>Mese</button><button type="button" className={period === "year" ? "active" : ""} onClick={() => selectPeriod("year")}>Anno</button><button type="button" className={period === "all" ? "active" : ""} onClick={() => selectPeriod("all")}>Tutto</button><button type="button" className={period === "custom" ? "active" : ""} onClick={() => selectPeriod("custom")}>Periodo</button></div>
    {period === "custom" && <section className="date-filter" aria-label="Periodo personalizzato"><label><span>Da</span><input type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)}/></label><label><span>A</span><input type="date" value={customTo} min={customFrom || undefined} max={today()} onChange={(event) => setCustomTo(event.target.value)}/></label></section>}
    <div className="period-summary"><span>{periodLabel}</span><b>{rangeDays} {rangeDays === 1 ? "giorno" : "giorni"}</b></div>
    {!rangeValid && <div className="range-error">La data iniziale deve precedere quella finale.</div>}
    <div className="stats-grid detailed"><article><span>Spese</span><strong>{eur(sum.expense, privacy)}</strong><small>{expenseChange === null ? "Nessun confronto" : `${Math.abs(Math.round(expenseChange))}% ${expenseChange <= 0 ? "in meno" : "in più"} del periodo prima`}</small></article><article><span>Entrate</span><strong>{eur(sum.income, privacy)}</strong><small>{filtered.filter((transaction) => transaction.type === "income").length} accrediti</small></article><article><span>Risparmio netto</span><strong>{eur(sum.net, privacy)}</strong><small>{savingRate === null ? "Aggiungi un’entrata" : `${savingRate}% delle entrate`}</small></article><article><span>Media giornaliera</span><strong>{eur(dailyAverage, privacy)}</strong><small>su {activeDays} {activeDays === 1 ? "giorno con movimenti" : "giorni con movimenti"}</small></article></div>
    <section className="stats-insights"><article><span>Movimenti</span><strong>{sum.count}</strong><small>{activeDays} {activeDays === 1 ? "giorno attivo" : "giorni attivi"}</small></article><article><span>Spesa maggiore</span><strong>{biggestExpense ? eur(biggestExpense.amountCents, privacy) : "—"}</strong><small>{biggestExpense?.description || (biggestExpense ? categoryMap.get(biggestExpense.categoryId)?.name : "Nessuna spesa")}</small></article><article><span>Categoria principale</span><strong>{pie[0]?.name || "—"}</strong><small>{pie[0] ? `${pie[0].percent}% delle spese` : "Nessun dato"}</small></article></section>
    <section className="chart-card"><div className="section-heading"><div><span className="eyebrow">ANDAMENTO</span><h2>Entrate e uscite</h2></div></div>{trend.length ? <ResponsiveContainer width="100%" height={250}><AreaChart data={trend} margin={{ left: -18, right: 4 }}><defs><linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ff2d55" stopOpacity={.28}/><stop offset="95%" stopColor="#ff2d55" stopOpacity={0}/></linearGradient><linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#00d7ff" stopOpacity={.2}/><stop offset="95%" stopColor="#00d7ff" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)"/><XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={25} tick={{ fontSize: 11 }}/><YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }}/><Tooltip formatter={(value) => eur(Number(value) * 100, privacy)} contentStyle={{ background: "#1c1c1e", border: "1px solid #ffffff18", borderRadius: 14 }}/><Area type="monotone" dataKey="expense" name="Spese" stroke="#ff2d55" strokeWidth={3} fill="url(#expenseFill)"/><Area type="monotone" dataKey="income" name="Entrate" stroke="#00d7ff" strokeWidth={2} fill="url(#incomeFill)"/></AreaChart></ResponsiveContainer> : <EmptyState text="Nessun movimento nel periodo selezionato." />}</section>
    <section className="chart-card category-chart"><div className="section-heading"><div><span className="eyebrow">COMPOSIZIONE</span><h2>Spese per categoria</h2></div></div>{pie.length ? <><div className="donut-layout"><ResponsiveContainer width="44%" height={220}><PieChart><Pie data={pie} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3}>{pie.map((entry) => <Cell key={entry.id} fill={entry.color}/>)}</Pie><Tooltip formatter={(value) => eur(Number(value), privacy)} contentStyle={{ background: "#1c1c1e", border: "1px solid #ffffff18", borderRadius: 14 }}/></PieChart></ResponsiveContainer><div className="legend">{pie.slice(0, 5).map((entry) => <div key={entry.id}><i style={{ background: entry.color }}/><span>{entry.name}</span><b>{entry.percent}%</b></div>)}</div></div><div className="category-breakdown">{pie.map((entry) => <article key={entry.id}><div className="category-breakdown-title"><span><i style={{ background: entry.color }}/>{entry.name}</span><b>{eur(entry.value, privacy)}</b></div><div className="progress-track subtle"><i style={{ width: `${entry.percent}%`, background: entry.color }}/></div><small>{entry.percent}% · {entry.count} {entry.count === 1 ? "movimento" : "movimenti"} · media {eur(Math.round(entry.value / entry.count), privacy)}</small></article>)}</div></> : <EmptyState text="Nessuna spesa nel periodo selezionato." />}</section></>;
}

function More({ categories, transactions, budgets, privacy, onTogglePrivacy, syncStatus, onSync }: { categories: Category[]; transactions: FinanceTransaction[]; budgets: Budget[]; privacy: boolean; onTogglePrivacy: () => void; syncStatus: SyncStatus; onSync: () => void }) {
  const mmInput = useRef<HTMLInputElement>(null); const restoreInput = useRef<HTMLInputElement>(null); const [preview, setPreview] = useState<LegacyPreview | null>(null); const [importing, setImporting] = useState(false); const [budgetOpen, setBudgetOpen] = useState(false); const [categoriesOpen, setCategoriesOpen] = useState(false); const [wipeOpen, setWipeOpen] = useState(false);
  const handleMm = async (file?: File) => { if (!file) return; try { setImporting(true); setPreview(await parseMmBackup(file)); } catch (e) { toast.error(e instanceof Error ? e.message : "Backup non leggibile"); } finally { setImporting(false); } };
  const commitImport = async () => { if (!preview) return; const existing = new Set((await db.transactions.where("source").equals("mmbackup").toArray()).map((t) => t.originalId)); const fresh = preview.transactions.filter((t) => !existing.has(t.originalId)); await db.transaction("rw", [db.categories, db.accounts, db.transactions, db.recurring, db.importBatches], async () => { await db.categories.bulkPut(preview.categories); await db.accounts.bulkPut(preview.accounts); await db.transactions.bulkPut(fresh); await db.recurring.bulkPut(preview.recurring.map((r) => ({ ...r, updatedAt: new Date().toISOString() }))); await db.importBatches.put({ id: preview.transactions[0]?.importBatchId || newId(), source: "mmbackup", fileName: preview.fileName, importedAt: new Date().toISOString(), total: fresh.length, skipped: preview.transactions.length - fresh.length }); }); queueCloudSync(); toast.success(`Importati ${fresh.length} movimenti${fresh.length !== preview.transactions.length ? ` · ${preview.transactions.length - fresh.length} già presenti` : ""}`); setPreview(null); };
  const exportJson = async () => { const backup: FinanceBackup = { schemaVersion: 1, createdAt: new Date().toISOString(), transactions: await db.transactions.toArray(), categories: await db.categories.toArray(), accounts: await db.accounts.toArray(), budgets: await db.budgets.toArray(), recurring: await db.recurring.toArray(), settings: await db.settings.toArray() }; downloadFile(`finanze-backup-${today()}.json`, "application/json", JSON.stringify(backup, null, 2)); toast.success("Backup JSON creato"); };
  const exportCsv = () => { const header = ["Data", "Ora", "Tipo", "Importo", "Categoria", "Conto", "Descrizione", "Note", "Fonte"]; const map = new Map(categories.map((c) => [c.id, c.name])); const lines = transactions.filter((t) => !t.deletedAt).map((t) => [t.date, t.time, t.type, (t.amountCents / 100).toFixed(2).replace(".", ","), map.get(t.categoryId) || "", t.accountId, t.description, t.notes, t.source].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(";")); downloadFile(`finanze-${today()}.csv`, "text/csv;charset=utf-8", `\uFEFF${header.join(";")}\n${lines.join("\n")}`); toast.success("CSV esportato"); };
  const restore = async (file?: File) => { if (!file) return; try { const data = JSON.parse(await file.text()) as FinanceBackup; if (data.schemaVersion !== 1 || !Array.isArray(data.transactions) || !Array.isArray(data.categories)) throw new Error("Formato backup non valido"); if (!confirm(`Ripristinare ${data.transactions.length} movimenti? I dati attuali verranno sostituiti.`)) return; await wipeCloud(); await clearAllData(); await db.transaction("rw", db.tables, async () => { await db.transactions.bulkPut(data.transactions); await db.categories.bulkPut(data.categories); await db.accounts.bulkPut(data.accounts); await db.budgets.bulkPut((data.budgets || []).map((b) => ({ ...b, updatedAt: new Date().toISOString() }))); await db.recurring.bulkPut((data.recurring || []).map((r) => ({ ...r, updatedAt: new Date().toISOString() }))); await db.settings.bulkPut(data.settings || []); }); queueCloudSync(); toast.success("Backup ripristinato"); } catch (e) { toast.error(e instanceof Error ? e.message : "Ripristino non riuscito"); } };
  const syncText: Record<SyncStatus, string> = { syncing: "Sincronizzazione…", synced: "Cloud aggiornato", offline: "Offline · dati locali", "not-configured": "In attesa di Neon", error: "Errore di sincronizzazione" };
  const SyncIcon = syncStatus === "synced" ? Cloud : syncStatus === "syncing" ? RefreshCw : CloudOff;
  return <><header className="topbar"><div><p className="eyebrow">CONTROLLO E SICUREZZA</p><h1>Altro</h1></div><Settings2 className="muted-icon" /></header><section className="settings-card"><h2>Cloud e dispositivo</h2><SettingRow icon={<SyncIcon className={syncStatus === "syncing" ? "spin" : ""} />} title="Neon Cloud" detail={syncText[syncStatus]}><button className="text-action" onClick={onSync}>Sincronizza</button></SettingRow><SettingRow icon={<ShieldCheck />} title="Modalità offline" detail="Le modifiche restano sul dispositivo"><Check className="success-icon" /></SettingRow></section><section className="settings-card"><h2>Aspetto e privacy</h2><SettingRow icon={<Eye />} title="Nascondi importi" detail="Protegge i dati quando sei in pubblico"><button className={privacy ? "switch on" : "switch"} onClick={onTogglePrivacy} aria-pressed={privacy}><i /></button></SettingRow><SettingRow icon={<Moon />} title="Tema" detail="Segue il sistema"><span className="value">Sistema</span></SettingRow></section><section className="settings-card"><h2>Organizzazione</h2><SettingRow icon={<Pencil />} title="Categorie" detail={`${categories.filter((category) => !category.archived).length} categorie attive`}><button className="text-action" onClick={() => setCategoriesOpen(true)}>Modifica</button></SettingRow><SettingRow icon={<BarChart3 />} title="Budget mensile" detail={budgets[0] ? eur(budgets[0].limitCents, privacy) : "Non impostato"}><button className="text-action" onClick={() => setBudgetOpen(true)}>Configura</button></SettingRow></section><section className="settings-card"><h2>Importa</h2><SettingRow icon={<FileArchive />} title="Budget e Finanze" detail="Importa un file .mmbackup"><button className="text-action" onClick={() => mmInput.current?.click()}>{importing ? "Analisi…" : "Scegli"}</button></SettingRow><input hidden ref={mmInput} type="file" accept=".mmbackup,.zip" onChange={(e) => handleMm(e.target.files?.[0])}/><SettingRow icon={<FileJson />} title="Ripristina backup" detail="Da un backup Finanze JSON"><button className="text-action" onClick={() => restoreInput.current?.click()}>Scegli</button></SettingRow><input hidden ref={restoreInput} type="file" accept="application/json,.json" onChange={(e) => restore(e.target.files?.[0])}/></section><section className="settings-card"><h2>Esporta</h2><SettingRow icon={<Download />} title="Backup completo" detail="Dati, categorie, budget e impostazioni"><button className="text-action" onClick={exportJson}>JSON</button></SettingRow><SettingRow icon={<Upload />} title="Esporta movimenti" detail="Formato universale, leggibile con Excel"><button className="text-action" onClick={exportCsv}>CSV</button></SettingRow></section><section className="settings-card"><h2>Sicurezza dei dati</h2><SettingRow icon={<ShieldCheck />} title="Archivio locale" detail={`${transactions.filter((t) => !t.deletedAt).length} movimenti sul dispositivo`}><Check className="success-icon" /></SettingRow><SettingRow icon={<Trash2 />} title="Cancella tutti i dati" detail="Elimina anche la copia cloud"><button className="danger-action" onClick={() => setWipeOpen(true)}>Cancella</button></SettingRow></section><p className="app-version">Finanze 1.6 · Database locale v1 · Cloud Neon</p><ImportPreview preview={preview} onClose={() => setPreview(null)} onConfirm={commitImport} />{budgetOpen && <BudgetDialog budget={budgets.find((b) => !b.categoryId)} onClose={() => setBudgetOpen(false)} />}{categoriesOpen && <CategoryManager categories={categories} onClose={() => setCategoriesOpen(false)} />}<AlertDialog open={wipeOpen} onOpenChange={setWipeOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancellare tutti i dati?</AlertDialogTitle><AlertDialogDescription>Crea prima un backup JSON. Questa operazione elimina i dati dal dispositivo e da Neon Cloud.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Annulla</AlertDialogCancel><AlertDialogAction className="danger-button" onClick={async () => { await wipeCloud(); await clearAllData(); await ensureDefaults(); toast.success("Dati locali e cloud cancellati"); }}>Cancella tutto</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></>;
}

function SettingRow({ icon, title, detail, children }: { icon: React.ReactNode; title: string; detail: string; children: React.ReactNode }) { return <div className="setting-row"><span className="setting-icon">{icon}</span><div><b>{title}</b><small>{detail}</small></div><div className="setting-control">{children}</div></div>; }

function CategoryManager({ categories, initialType = "all", onClose }: { categories: Category[]; initialType?: "all" | TransactionType; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | TransactionType>(initialType);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const visible = categories.filter((category) => !category.archived && (type === "all" || category.type === type || category.type === "both") && category.name.toLocaleLowerCase("it-IT").includes(query.trim().toLocaleLowerCase("it-IT")));
  const startEdit = (category: Category) => { setEditingId(category.id); setDraftName(category.name); };
  const save = async () => {
    if (!editingId || saving) return;
    const name = draftName.trim().replace(/\s+/g, " ");
    if (!name) return toast.error("Inserisci un nome per la categoria");
    const duplicate = categories.some((category) => !category.archived && category.id !== editingId && category.name.trim().toLocaleLowerCase("it-IT") === name.toLocaleLowerCase("it-IT"));
    if (duplicate) return toast.error("Esiste già una categoria con questo nome");
    setSaving(true);
    try {
      await db.categories.update(editingId, { name, updatedAt: new Date().toISOString() });
      queueCloudSync(50);
      setEditingId(null);
      toast.success("Categoria rinominata");
    } catch {
      toast.error("Non sono riuscito a rinominare la categoria");
    } finally { setSaving(false); }
  };
  return <div className="category-manager-modal"><button type="button" className="transaction-modal-backdrop" aria-label="Chiudi gestione categorie" onClick={onClose}/><section className="category-manager" role="dialog" aria-modal="true" aria-labelledby={titleId}><header><div><p className="eyebrow">ORGANIZZAZIONE</p><h2 id={titleId}>Modifica categorie</h2><span>Il nuovo nome verrà applicato a tutto lo storico.</span></div><button type="button" className="transaction-close" aria-label="Chiudi" onClick={onClose}><X /></button></header><div className="search-box category-search"><Search/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca categoria" aria-label="Cerca categoria"/>{query && <button type="button" aria-label="Cancella ricerca" onClick={() => setQuery("")}><X/></button>}</div><div className="segmented category-type"><button type="button" className={type === "all" ? "active" : ""} onClick={() => setType("all")}>Tutte</button><button type="button" className={type === "expense" ? "active" : ""} onClick={() => setType("expense")}>Spese</button><button type="button" className={type === "income" ? "active" : ""} onClick={() => setType("income")}>Entrate</button></div><div className="category-manager-list">{visible.map((category) => <article key={category.id}>{editingId === category.id ? <><span className="category-color" style={{ background: category.color }}/><input autoFocus value={draftName} maxLength={40} aria-label={`Nuovo nome per ${category.name}`} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); if (event.key === "Escape") setEditingId(null); }}/><button type="button" className="category-cancel" onClick={() => setEditingId(null)}>Annulla</button><button type="button" className="category-save" disabled={saving} onClick={() => void save()}>{saving ? "…" : "Salva"}</button></> : <><span className="category-color" style={{ background: category.color }}/><div><b>{category.name}</b><small>{category.type === "income" ? "Entrata" : category.type === "expense" ? "Spesa" : "Spesa ed entrata"}</small></div><button type="button" className="category-edit" aria-label={`Rinomina ${category.name}`} onClick={() => startEdit(category)}><Pencil/></button></>}</article>)}</div>{!visible.length && <EmptyState text="Nessuna categoria corrisponde alla ricerca." />}</section></div>;
}

function TransactionDialog({ transaction, categories, accounts, onClose }: { transaction: FinanceTransaction | null; categories: Category[]; accounts: {id:string;name:string}[]; onClose: () => void }) {
  const [type, setType] = useState<TransactionType>(transaction?.type || "expense");
  const [amount, setAmount] = useState(transaction ? (transaction.amountCents / 100).toFixed(2).replace(".", ",") : "");
  const [categoryId, setCategoryId] = useState(transaction?.categoryId || "");
  const [accountId, setAccountId] = useState(transaction?.accountId || accounts[0]?.id || "main");
  const [date, setDate] = useState(transaction?.date || today());
  const [time, setTime] = useState(transaction?.time || nowTime());
  const [description, setDescription] = useState(transaction?.description || "");
  const [notes, setNotes] = useState(transaction?.notes || "");
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !deleteOpen) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [deleteOpen, onClose]);
  const seenNames = new Set<string>();
  const visible = categories.filter((category) => {
    if (category.archived || (category.type !== type && category.type !== "both")) return false;
    const key = category.name.trim().toLocaleLowerCase("it-IT");
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return key.includes(categoryQuery.trim().toLocaleLowerCase("it-IT"));
  });
  const save = async () => {
    if (saving) return;
    const amountCents = parseEuroInput(amount);
    if (amountCents <= 0) return toast.error("Inserisci un importo maggiore di zero");
    if (!categoryId) return toast.error("Scegli una categoria");
    if (!date || !time || !accountId) return toast.error("Controlla data, ora e conto");
    setSaving(true);
    try {
      const stamp = new Date().toISOString();
      await db.transactions.put({ id: transaction?.id || newId(), originalId: transaction?.originalId, type, amountCents, date, time, categoryId, accountId, description: description.trim(), notes: notes.trim(), recurringId: transaction?.recurringId, createdAt: transaction?.createdAt || stamp, updatedAt: stamp, source: transaction?.source || "manual", importBatchId: transaction?.importBatchId, fingerprint: transaction?.fingerprint });
      queueCloudSync();
      try { navigator.vibrate?.(15); } catch {}
      toast.success(transaction ? "Movimento aggiornato" : "Movimento salvato");
      onClose();
    } catch (error) {
      console.error("Unable to save transaction", error);
      toast.error("Salvataggio non riuscito. Riprova.");
      setSaving(false);
    }
  };
  const remove = async () => { if (!transaction) return; await db.transactions.update(transaction.id, { deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); queueCloudSync(); toast.success("Movimento eliminato", { action: { label: "Annulla", onClick: () => { void db.transactions.update(transaction.id, { deletedAt: undefined, updatedAt: new Date().toISOString() }); queueCloudSync(); } } }); setDeleteOpen(false); onClose(); };
  return <><div className="transaction-modal"><button type="button" className="transaction-modal-backdrop" aria-label="Chiudi finestra" onClick={onClose}/><section className="transaction-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="transaction-modal-header"><div><h2 id={titleId}>{transaction ? "Modifica movimento" : "Nuovo movimento"}</h2><p>{transaction ? "Aggiorna i dati oppure elimina il movimento." : "Importo, categoria e salva. Il resto è facoltativo."}</p></div><button type="button" className="transaction-close" aria-label="Chiudi" onClick={onClose}><X /></button></div><div className="segmented"><button type="button" className={type === "expense" ? "active expense-tab" : ""} onClick={() => { setType("expense"); setCategoryId(""); setCategoryQuery(""); }}>Spesa</button><button type="button" className={type === "income" ? "active income-tab" : ""} onClick={() => { setType("income"); setCategoryId(""); setCategoryQuery(""); }}>Entrata</button></div><label className="amount-input"><span>€</span><input inputMode="decimal" placeholder="0,00" aria-label="Importo" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9,.]/g, ""))}/></label><div className="category-section"><div className="field-heading"><label className="field-label">Categoria</label><button type="button" onClick={() => setCategoriesOpen(true)}><Pencil/>Modifica nomi</button></div><div className="search-box category-search compact"><Search/><input value={categoryQuery} onChange={(event) => setCategoryQuery(event.target.value)} placeholder="Cerca categoria" aria-label="Cerca categoria"/>{categoryQuery && <button type="button" aria-label="Cancella ricerca" onClick={() => setCategoryQuery("")}><X/></button>}</div><div className="category-picker">{visible.map((category) => <button type="button" key={category.id} className={categoryId === category.id ? "category-chip selected" : "category-chip"} style={{ "--chip": category.color } as React.CSSProperties} onClick={() => setCategoryId(category.id)}><i />{category.name}</button>)}</div>{!visible.length && <small className="no-categories">Nessuna categoria trovata.</small>}</div><div className="form-grid"><label><span>Data</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)}/></label><label><span>Ora</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)}/></label></div><label className="full-field"><span>Conto</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label className="full-field"><span>Descrizione</span><input placeholder="Es. Cena, benzina, stipendio…" value={description} onChange={(event) => setDescription(event.target.value)}/></label><label className="full-field"><span>Note</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)}/></label><div className="dialog-actions">{transaction && <button type="button" className="delete-icon" onClick={() => setDeleteOpen(true)} aria-label="Elimina movimento"><Trash2 /></button>}<button type="button" className="save-button" disabled={saving} onClick={() => void save()}>{saving ? "Salvataggio…" : "Salva movimento"}</button></div></section></div>{categoriesOpen && <CategoryManager categories={categories} initialType={type} onClose={() => setCategoriesOpen(false)} />}<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Eliminare il movimento?</AlertDialogTitle><AlertDialogDescription>Potrai annullare subito l’operazione.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Annulla</AlertDialogCancel><AlertDialogAction className="danger-button" onClick={remove}>Elimina</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></>;
}

function ImportPreview({ preview, onClose, onConfirm }: { preview: LegacyPreview | null; onClose: () => void; onConfirm: () => void }) { return <Dialog open={Boolean(preview)} onOpenChange={(v) => !v && onClose()}><DialogContent className="import-dialog"><DialogHeader><DialogTitle>Anteprima importazione</DialogTitle><DialogDescription>Il file originale non verrà mai modificato.</DialogDescription></DialogHeader>{preview && <><div className="import-success"><FileArchive/><div><b>{preview.fileName}</b><span>Backup Budget e Finanze riconosciuto</span></div></div><div className="preview-grid"><div><strong>{preview.transactions.length}</strong><span>Movimenti attivi</span></div><div><strong>{preview.expenseCount}</strong><span>Spese</span></div><div><strong>{preview.incomeCount}</strong><span>Entrate</span></div><div><strong>{preview.deletedCount}</strong><span>Eliminati esclusi</span></div><div><strong>{preview.categories.length}</strong><span>Categorie</span></div><div><strong>{preview.accounts.length}</strong><span>Conti</span></div></div><div className="date-range"><CalendarDays/><div><span>Intervallo rilevato</span><b>{shortDate(preview.minDate)} – {shortDate(preview.maxDate)}</b></div></div><button className="save-button full" onClick={onConfirm}>Importa senza duplicati</button></>}</DialogContent></Dialog>; }
function BudgetDialog({ budget, onClose }: { budget?: Budget; onClose: () => void }) { const [value, setValue] = useState(budget ? String(budget.limitCents / 100) : ""); const save = async () => { const limitCents = parseEuroInput(value); if (!limitCents) return toast.error("Inserisci un budget valido"); await db.budgets.put({ id: budget?.id || "general-monthly", period: "monthly", limitCents, startDate: `${monthKey()}-01`, active: true, updatedAt: new Date().toISOString() }); queueCloudSync(); toast.success("Budget aggiornato"); onClose(); }; return <Dialog open onOpenChange={(v) => !v && onClose()}><DialogContent><DialogHeader><DialogTitle>Budget mensile</DialogTitle><DialogDescription>Imposta il limite complessivo delle spese per ogni mese.</DialogDescription></DialogHeader><label className="amount-input compact"><span>€</span><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="1.500"/></label><button type="button" className="save-button full" onClick={() => void save()}>Salva budget</button></DialogContent></Dialog>; }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span><WalletCards /></span><p>{text}</p></div>; }
