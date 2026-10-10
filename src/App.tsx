import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowDownRight, ArrowUpRight, BarChart3, Bell, Briefcase, CalendarDays,
  Camera, Car, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, CircleDollarSign,
  Eye, EyeOff, FileText, Filter, Gift, House, ImagePlus, Landmark,
  LayoutDashboard, ListFilter, LockKeyhole, LogOut, Menu, Moon, PartyPopper,
  Pencil, Plus, Receipt, RotateCcw, ScanFace, ScanText, Search, Settings, ShoppingBag,
  Sparkles, Sun, Tag, Target, Trash2, TrendingUp, Upload, UserRound,
  Utensils, Wallet, X,
} from 'lucide-react';
import {
  createDemoData, createEmptyData, defaultCategories, formatMoney, formatThaiDate,
  getTypeLabel, isSameMonth, monthLabel, MONTHS_TH, toLocalDateInput,
} from './data';
import { ApiError, apiLogin, apiLogout, apiMe, apiRegister, loadData, loadSession, saveData, saveSession } from './storage';
import { analyzeSlip, buildSlipNote, suggestCategoryId, type SlipAnalysis, type SlipConfidence } from './slip';
import { isTransferId, useTransfers } from './transfers';
import { TransferSharePanel } from './TransferSharePanel';
import { FaceOffer, FaceSettingsPanel } from './FaceLogin';
import { loginWithFace } from './webauthn';
import { FaceCameraModal } from './FaceCamera';
import { apiFaceLogin, canUseCamera } from './faceApi';
import './month-detail.css';
import type { AppData, Category, CategoryIconName, Profile, Session, Transaction, TransactionType } from './types';

type View = 'dashboard' | 'transactions' | 'summary' | 'settings';
type ToastKind = 'success' | 'warning';
type Toast = { text: string; kind: ToastKind } | null;
type TransactionDraft = Omit<Transaction, 'id'>;

const iconMap: Record<CategoryIconName, LucideIcon> = {
  utensils: Utensils,
  car: Car,
  'shopping-bag': ShoppingBag,
  'file-text': FileText,
  home: House,
  tag: Tag,
  'circle-dollar-sign': CircleDollarSign,
  gift: Gift,
  'briefcase-business': Briefcase,
  'trending-up': TrendingUp,
  'party-popper': PartyPopper,
  landmark: Landmark,
};

const navItems: { id: View; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'ภาพรวม', icon: LayoutDashboard },
  { id: 'transactions', label: 'รายการ', icon: Receipt },
  { id: 'summary', label: 'สรุปผล', icon: BarChart3 },
  { id: 'settings', label: 'ตั้งค่า', icon: Settings },
];

const dateInputToday = () => toLocalDateInput();
const makeId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function getCategory(categories: Category[], id: string) {
  return categories.find((category) => category.id === id) ?? categories.find((category) => category.id === 'other') ?? defaultCategories[5];
}

function calculateTotals(transactions: Transaction[], target = new Date()) {
  const current = transactions.filter((transaction) => isSameMonth(transaction.date, target));
  const income = current.filter((transaction) => transaction.type === 'income').reduce((sum, transaction) => sum + transaction.amount, 0);
  const expense = current.filter((transaction) => transaction.type === 'expense').reduce((sum, transaction) => sum + transaction.amount, 0);
  return { income, expense, balance: income - expense, current };
}

function groupByCategory(transactions: Transaction[], type: TransactionType) {
  return transactions.filter((transaction) => transaction.type === type).reduce<Record<string, number>>((groups, transaction) => {
    groups[transaction.categoryId] = (groups[transaction.categoryId] ?? 0) + transaction.amount;
    return groups;
  }, {});
}

function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [data, setData] = useState<AppData>(() => {
    const storedSession = loadSession();
    const storedData = loadData(storedSession?.username);
    return storedSession?.isDemo && storedData.transactions.length === 0 ? createDemoData() : storedData;
  });
  const [view, setView] = useState<View>('dashboard');
  const [toast, setToast] = useState<Toast>(null);
  const [transactionModal, setTransactionModal] = useState<{ open: boolean; transaction?: Transaction; prefill?: Partial<TransactionDraft> }>({ open: false });
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [categoryModal, setCategoryModal] = useState<{ open: boolean; category?: Category; type?: TransactionType }>({ open: false });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => new Date());
  // รายการโอนระหว่างผู้ใช้ (จากเซิร์ฟเวอร์) นับรวมกับรายการในเครื่องทุกหน้าจอ
  const { transfers, hide: hideTransfer } = useTransfers(session, data.profile, data.categories);
  const allTransactions = useMemo(() => [...data.transactions, ...transfers], [data.transactions, transfers]);
  const viewData = useMemo(() => ({ ...data, transactions: allTransactions }), [data, allTransactions]);

  const updateData = (next: AppData) => {
    setData(next);
    saveData(next, session?.username);
  };

  const notify = (text: string, kind: ToastKind = 'success') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 3400);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = data.settings.darkMode ? 'dark' : 'light';
  }, [data.settings.darkMode]);

  // ตรวจว่าเซสชันบนเซิร์ฟเวอร์ยังใช้ได้อยู่ (หมดอายุ/ถูกล็อกเอาต์จากที่อื่น = กลับหน้าล็อกอิน) ถ้าเซิร์ฟเวอร์ปิดอยู่จะไม่เด้งออก
  useEffect(() => {
    if (!session || session.isDemo) return;
    apiMe().catch((error) => {
      if (error instanceof ApiError && error.status === 401) {
        saveSession(null);
        setSession(null);
        setData(createEmptyData());
      }
    });
  }, []);

  const totals = useMemo(() => calculateTotals(allTransactions), [allTransactions]);
  const expenseByCategory = useMemo(() => groupByCategory(totals.current, 'expense'), [totals.current]);
  // ยอดของ "เดือนที่เลือกดู" (ภาพรวม/สรุปผล) ส่วน totals ด้านบนคือเดือนปัจจุบันจริง ใช้กับงบประมาณและกระดิ่งเตือน
  const viewTotals = useMemo(() => calculateTotals(allTransactions, viewDate), [allTransactions, viewDate]);
  const viewExpenseByCategory = useMemo(() => groupByCategory(viewTotals.current, 'expense'), [viewTotals.current]);
  const viewMonthName = monthLabel(viewDate);
  const viewIsCurrent = isSameMonth(toLocalDateInput(viewDate));

  const saveTransaction = (draft: TransactionDraft, editingId?: string) => {
    const previousTotals = calculateTotals(allTransactions);
    const previousCategoryExpense = groupByCategory(previousTotals.current, 'expense')[draft.categoryId] ?? 0;
    const transaction: Transaction = { ...draft, id: editingId ?? makeId() };
    const transactions = editingId
      ? data.transactions.map((item) => item.id === editingId ? transaction : item)
      : [transaction, ...data.transactions];
    const next = { ...data, transactions };
    updateData(next);
    setTransactionModal({ open: false });
    const savedDate = new Date(`${transaction.date}T12:00:00`);
    const monthChanged = savedDate.getFullYear() !== viewDate.getFullYear() || savedDate.getMonth() !== viewDate.getMonth();
    if (monthChanged) setViewDate(savedDate);
    const updatedTotals = calculateTotals([...transactions, ...transfers]);
    const currentExpense = updatedTotals.expense;
    const categoryBudget = next.budgets.byCategory[transaction.categoryId];
    const categoryExpense = groupByCategory(updatedTotals.current, 'expense')[transaction.categoryId] ?? 0;
    const isCurrentMonthExpense = transaction.type === 'expense' && isSameMonth(transaction.date);
    if (isCurrentMonthExpense && next.budgets.overall && previousTotals.expense < next.budgets.overall && currentExpense >= next.budgets.overall) {
      notify('รายการนี้ทำให้ยอดใช้จ่ายรวมเกินงบประมาณแล้ว', 'warning');
    } else if (isCurrentMonthExpense && next.budgets.overall && previousTotals.expense < next.budgets.overall * .8 && currentExpense >= next.budgets.overall * .8) {
      notify('ยอดใช้จ่ายรวมเดือนนี้ใกล้ถึงงบประมาณที่ตั้งไว้แล้ว', 'warning');
    } else if (isCurrentMonthExpense && categoryBudget && previousCategoryExpense < categoryBudget && categoryExpense >= categoryBudget) {
      notify(`ยอดหมวด ${getCategory(next.categories, transaction.categoryId).name} เกินงบที่ตั้งไว้แล้ว`, 'warning');
    } else if (isCurrentMonthExpense && categoryBudget && previousCategoryExpense < categoryBudget * .8 && categoryExpense >= categoryBudget * .8) {
      notify(`ยอดหมวด ${getCategory(next.categories, transaction.categoryId).name} ใกล้ถึงงบแล้ว`, 'warning');
    } else {
      notify(monthChanged ? `บันทึกเรียบร้อย · แสดงยอดของเดือน${monthLabel(savedDate)}` : editingId ? 'บันทึกการแก้ไขเรียบร้อย' : 'บันทึกรายการเรียบร้อย');
    }
  };

  const deleteTransaction = (id: string) => {
    if (isTransferId(id)) {
      if (!window.confirm('ลบรายการโอนนี้ออกจากบัญชีของคุณใช่ไหม? (อีกฝ่ายยังเห็นรายการของเขาอยู่)')) return;
      hideTransfer(id).then(() => notify('ลบรายการเรียบร้อย'), () => notify('ลบไม่สำเร็จ ลองใหม่อีกครั้ง', 'warning'));
      return;
    }
    if (!window.confirm('ต้องการลบรายการนี้ใช่ไหม? การดำเนินการนี้ไม่สามารถกู้คืนได้')) return;
    updateData({ ...data, transactions: data.transactions.filter((transaction) => transaction.id !== id) });
    notify('ลบรายการเรียบร้อย');
  };

  const startDemo = () => {
    const demo = createDemoData();
    const nextSession: Session = { username: 'demo', displayName: 'สมชาย', isDemo: true };
    setData(demo);
    saveData(demo, nextSession.username);
    setSession(nextSession);
    saveSession(nextSession);
  };

  const handleLogout = () => {
    if (!session?.isDemo) apiLogout().catch(() => undefined);
    saveSession(null);
    setSession(null);
    setData(createEmptyData());
    setView('dashboard');
  };

  if (!session) {
    return <AuthScreen onDemo={startDemo} onLogin={(next) => { setData(loadData(next.username)); setSession(next); saveSession(next); }} onRegister={(next, profile) => {
      const nextData = { ...createEmptyData(), profile };
      setData(nextData);
      saveData(nextData, next.username);
      setSession(next);
      saveSession(next);
    }} />;
  }

  const editTransaction = (transaction: Transaction) => {
    if (isTransferId(transaction.id)) { notify('รายการโอนระหว่างผู้ใช้แก้ไขไม่ได้ (ลบออกจากบัญชีของคุณได้)', 'warning'); return; }
    setTransactionModal({ open: true, transaction });
  };
  const openAdd = (prefill?: Partial<TransactionDraft>) => setTransactionModal({ open: true, prefill });
  const title = navItems.find((item) => item.id === view)?.label ?? 'ภาพรวม';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar--open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Wallet size={23} /></div>
          <div><strong>BahtFlow</strong><span>เงินชัด ชีวิตไหลลื่น</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileMenuOpen(false)} aria-label="ปิดเมนู"><X size={20} /></button>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`nav-item ${view === item.id ? 'nav-item--active' : ''}`} onClick={() => { setView(item.id); setMobileMenuOpen(false); }}><Icon size={20} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-profile"><div className="avatar">{session.displayName.slice(0, 1)}</div><div><strong>{session.displayName}</strong><span>{session.isDemo ? 'โหมดทดลองใช้งาน' : session.username}</span></div></div>
          <button className="nav-item nav-item--logout" onClick={handleLogout}><LogOut size={19} /><span>ออกจากระบบ</span></button>
        </div>
      </aside>
      {mobileMenuOpen && <button className="backdrop" aria-label="ปิดเมนู" onClick={() => setMobileMenuOpen(false)} />}

      <main className="main-content">
        <header className="topbar">
          <div className="topbar-title"><button className="icon-button mobile-menu" onClick={() => setMobileMenuOpen(true)} aria-label="เมนู"><Menu size={22} /></button><div>{view === 'dashboard' || view === 'summary' ? <MonthSwitcher date={viewDate} onChange={setViewDate} /> : <p className="eyebrow">{monthLabel()}</p>}<h1>{title}</h1></div></div>
          <div className="topbar-actions">
            <button className="icon-button notification" title="สถานะงบประมาณ" onClick={() => setView('settings')}><Bell size={20} />{data.budgets.overall && totals.expense / data.budgets.overall >= .8 && <i />}</button>
            <button className="theme-toggle" onClick={() => updateData({ ...data, settings: { darkMode: !data.settings.darkMode } })}>{data.settings.darkMode ? <Sun size={17} /> : <Moon size={17} />}<span>{data.settings.darkMode ? 'สว่าง' : 'มืด'}</span></button>
          </div>
        </header>

        {view === 'dashboard' && <Dashboard data={viewData} totals={viewTotals} expenseByCategory={viewExpenseByCategory} monthName={viewMonthName} isCurrent={viewIsCurrent} onAdd={() => openAdd()} onReceipt={() => setReceiptModalOpen(true)} onTransactions={() => setView('transactions')} />}
        {view === 'transactions' && <TransactionsScreen data={viewData} onEdit={editTransaction} onDelete={deleteTransaction} onAdd={() => openAdd()} />}
        {view === 'summary' && <SummaryScreen data={viewData} totals={viewTotals} monthName={viewMonthName} />}
        {view === 'settings' && <SettingsScreen data={data} totals={totals} expenseByCategory={expenseByCategory} onChange={updateData} onNotify={notify} onCategory={(category, type) => setCategoryModal({ open: true, category, type })} onLogout={handleLogout} />}
      </main>

      <nav className="mobile-nav">
        {navItems.slice(0, 2).map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><Icon size={20} /><span>{item.label}</span></button>; })}
        <button className="mobile-add" onClick={() => openAdd()} aria-label="เพิ่มรายการ"><Plus size={24} /></button>
        {navItems.slice(2).map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><Icon size={20} /><span>{item.label}</span></button>; })}
      </nav>

      {transactionModal.open && <TransactionModal categories={data.categories} transaction={transactionModal.transaction} prefill={transactionModal.prefill} onClose={() => setTransactionModal({ open: false })} onSave={saveTransaction} />}
      {receiptModalOpen && <ReceiptModal profile={data.profile} categories={data.categories} onClose={() => setReceiptModalOpen(false)} onProceed={(prefill) => { setReceiptModalOpen(false); openAdd(prefill); }} onSave={(draft) => { setReceiptModalOpen(false); saveTransaction(draft); }} />}
      {categoryModal.open && <CategoryModal category={categoryModal.category} type={categoryModal.type ?? 'expense'} onClose={() => setCategoryModal({ open: false })} onSave={(category) => {
        const categories = categoryModal.category ? data.categories.map((item) => item.id === category.id ? category : item) : [...data.categories, category];
        updateData({ ...data, categories });
        setCategoryModal({ open: false });
        notify(categoryModal.category ? 'แก้ไขหมวดหมู่เรียบร้อย' : 'เพิ่มหมวดหมู่เรียบร้อย');
      }} />}
      {toast && <div className={`toast toast--${toast.kind}`}>{toast.kind === 'success' ? <CheckCircle2 size={19} /> : <CircleAlert size={19} />}<span>{toast.text}</span></div>}
    </div>
  );
}

function MonthSwitcher({ date, onChange }: { date: Date; onChange: (date: Date) => void }) {
  const isCurrent = isSameMonth(toLocalDateInput(date));
  const shift = (offset: number) => onChange(new Date(date.getFullYear(), date.getMonth() + offset, 1, 12));
  return <div className="month-switcher"><button className="icon-button" onClick={() => shift(-1)} aria-label="เดือนก่อนหน้า"><ChevronLeft size={16} /></button><span>{monthLabel(date)}</span><button className="icon-button" onClick={() => shift(1)} aria-label="เดือนถัดไป"><ChevronRight size={16} /></button>{!isCurrent && <button className="month-today" onClick={() => onChange(new Date())}>เดือนนี้</button>}</div>;
}

function Dashboard({ data, totals, expenseByCategory, monthName, isCurrent, onAdd, onReceipt, onTransactions }: { data: AppData; totals: ReturnType<typeof calculateTotals>; expenseByCategory: Record<string, number>; monthName: string; isCurrent: boolean; onAdd: () => void; onReceipt: () => void; onTransactions: () => void }) {
  const recent = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const budgetPercent = data.budgets.overall ? Math.min(100, totals.expense / data.budgets.overall * 100) : 0;
  const budgetState = !data.budgets.overall ? 'unset' : budgetPercent >= 100 ? 'over' : budgetPercent >= 80 ? 'near' : 'safe';
  const daily = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(); date.setDate(date.getDate() - (6 - index));
    const key = toLocalDateInput(date);
    return { label: date.toLocaleDateString('th-TH', { weekday: 'narrow' }), value: data.transactions.filter((item) => item.date === key && item.type === 'expense').reduce((sum, item) => sum + item.amount, 0) };
  });
  const when = isCurrent ? 'เดือนนี้' : `เดือน${monthName}`;
  const maxDaily = Math.max(...daily.map((item) => item.value), 1);
  const topCategories = Object.entries(expenseByCategory).sort((a, b) => b[1] - a[1]).slice(0, 4);

  return <div className="page dashboard-page">
    <section className="welcome-row"><div><h2>สวัสดี, {data.profile.nameThai.split(' ')[0] || 'คุณ'} <span>วันนี้เงินของคุณเป็นอย่างไรบ้าง?</span></h2><p>ภาพรวมกระแสเงินสดของ{when} พร้อมให้คุณจัดการได้ทันที</p></div><div className="welcome-actions"><button className="outline-button" onClick={onReceipt}><ScanText size={18} />อ่านสลิป</button><button className="primary-button" onClick={onAdd}><Plus size={19} />เพิ่มรายการ</button></div></section>
    <section className="metric-grid">
      <MetricCard label={`รายรับ${when}`} amount={totals.income} tone="income" icon={ArrowUpRight} helper="เงินที่เข้ามา" />
      <MetricCard label={`รายจ่าย${when}`} amount={totals.expense} tone="expense" icon={ArrowDownRight} helper="เงินที่ใช้ไป" />
      <article className="metric-card metric-card--balance"><div className="metric-card-head"><span>คงเหลือสุทธิ</span><span className="metric-icon"><Wallet size={19} /></span></div><strong>฿{formatMoney(totals.balance)}</strong><p><TrendingUp size={15} /> วางแผนได้ชัดขึ้นทุกวัน</p><div className="balance-orb orb-one" /><div className="balance-orb orb-two" /></article>
    </section>
    <section className="dashboard-grid">
      <article className="panel spending-panel"><div className="panel-header"><div><p className="section-kicker">กระแสเงิน</p><h3>ภาพรวมการใช้จ่าย</h3></div><span className="soft-tag"><CalendarDays size={15} />{isCurrent ? 'เดือนนี้' : monthName}</span></div><div className="spending-visual"><ExpenseRing income={totals.income} expense={totals.expense} /><div className="spending-legend"><Legend color="var(--income)" label="ได้รับมา" amount={totals.income} /><Legend color="var(--expense)" label="ใช้ไปแล้ว" amount={totals.expense} /><div className="net-line"><span>ยอดคงเหลือ</span><strong className={totals.balance >= 0 ? 'positive' : 'negative'}>{totals.balance >= 0 ? '+' : '-'}฿{formatMoney(Math.abs(totals.balance))}</strong></div></div></div></article>
      <article className="panel budget-panel"><div className="panel-header"><div><p className="section-kicker">งบประมาณ</p><h3>สถานะงบ{when}</h3></div><span className={`budget-chip budget-chip--${budgetState}`}>{budgetState === 'unset' ? 'ยังไม่ได้ตั้งงบ' : budgetState === 'over' ? 'เกินงบแล้ว' : budgetState === 'near' ? 'ใกล้ถึงงบ' : 'อยู่ในงบ'}</span></div>{data.budgets.overall ? <><div className="budget-amount"><strong>฿{formatMoney(totals.expense, 0)}</strong><span> / ฿{formatMoney(data.budgets.overall, 0)}</span></div><div className="progress-track"><div className={`progress-fill progress-fill--${budgetState}`} style={{ width: `${budgetPercent}%` }} /></div><p className="muted">ใช้ไป {budgetPercent.toFixed(0)}% ของงบทั้งหมด {budgetState === 'safe' && `เหลือ ฿${formatMoney(Math.max(0, data.budgets.overall - totals.expense), 0)}`}</p></> : <EmptyBudget />}</article>
      <article className="panel trend-panel"><div className="panel-header"><div><p className="section-kicker">7 วันล่าสุด</p><h3>แนวโน้มรายจ่าย</h3></div><span className="trend-total">฿{formatMoney(daily.reduce((sum, item) => sum + item.value, 0), 0)}</span></div><div className="bar-chart">{daily.map((item, index) => <div className="bar-column" key={`${item.label}-${index}`}><span className="bar-value">{item.value ? `฿${formatMoney(item.value, 0)}` : ''}</span><div className="bar-wrap"><i style={{ height: `${Math.max(item.value ? 12 : 4, item.value / maxDaily * 100)}%` }} /></div><small>{item.label}</small></div>)}</div></article>
      <article className="panel category-panel"><div className="panel-header"><div><p className="section-kicker">หมวดหมู่</p><h3>ใช้จ่ายสูงสุด</h3></div><button className="text-button" onClick={onTransactions}>ดูรายการ <ChevronRight size={16} /></button></div>{topCategories.length ? <div className="category-breakdown">{topCategories.map(([id, amount]) => { const category = getCategory(data.categories, id); return <CategoryBreakdown key={id} category={category} amount={amount} total={totals.expense} />; })}</div> : <EmptyState title={`ยังไม่มีรายจ่ายใน${when}`} detail="เพิ่มรายการเพื่อดูสัดส่วนการใช้จ่าย" />}</article>
    </section>
    <section className="panel recent-panel"><div className="panel-header"><div><p className="section-kicker">ธุรกรรม</p><h3>รายการล่าสุด</h3></div><button className="text-button" onClick={onTransactions}>ดูทั้งหมด <ChevronRight size={16} /></button></div>{recent.length ? <div className="transaction-list">{recent.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} category={getCategory(data.categories, transaction.categoryId)} />)}</div> : <EmptyState title="เริ่มต้นบันทึกเงินของคุณ" detail="เพิ่มรายรับหรือรายจ่ายรายการแรกได้เลย" />}</section>
  </div>;
}

function MetricCard({ label, amount, tone, icon: Icon, helper }: { label: string; amount: number; tone: 'income' | 'expense'; icon: LucideIcon; helper: string }) {
  return <article className={`metric-card metric-card--${tone}`}><div className="metric-card-head"><span>{label}</span><span className="metric-icon"><Icon size={19} /></span></div><strong>฿{formatMoney(amount)}</strong><p>{helper}</p></article>;
}

function ExpenseRing({ income, expense }: { income: number; expense: number }) {
  const total = Math.max(income + expense, 1);
  const expensePercent = expense / total * 100;
  return <div className="expense-ring" style={{ background: `conic-gradient(var(--expense) 0 ${expensePercent}%, var(--income) ${expensePercent}% 100%)` }}><div><span>สุทธิ</span><strong>฿{formatMoney(income - expense, 0)}</strong></div></div>;
}

function Legend({ color, label, amount }: { color: string; label: string; amount: number }) { return <div className="legend-row"><i style={{ background: color }} /><span>{label}</span><strong>฿{formatMoney(amount, 0)}</strong></div>; }
function EmptyBudget() { return <div className="empty-budget"><Target size={24} /><div><strong>ยังไม่ได้ตั้งงบเดือนนี้</strong><p>ไปที่ตั้งค่าเพื่อเริ่มวางแผนการใช้จ่าย</p></div></div>; }
function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><Wallet size={28} /><strong>{title}</strong><p>{detail}</p></div>; }

function CategoryBreakdown({ category, amount, total }: { category: Category; amount: number; total: number }) {
  const Icon = iconMap[category.icon];
  const percent = total ? amount / total * 100 : 0;
  return <div className="category-breakdown-row"><div className="category-symbol" style={{ background: `${category.color}18`, color: category.color }}><Icon size={18} /></div><div className="category-progress"><div><span>{category.name}</span><strong>฿{formatMoney(amount, 0)}</strong></div><div className="thin-track"><i style={{ width: `${percent}%`, background: category.color }} /></div></div><small>{percent.toFixed(0)}%</small></div>;
}

function TransactionRow({ transaction, category, onEdit, onDelete }: { transaction: Transaction; category: Category; onEdit?: () => void; onDelete?: () => void }) {
  const Icon = iconMap[category.icon];
  const expense = transaction.type === 'expense';
  return <div className="transaction-row"><div className="category-symbol" style={{ background: `${category.color}18`, color: category.color }}><Icon size={19} /></div><div className="transaction-description"><strong>{category.name}</strong><span>{transaction.note || 'ไม่มีหมายเหตุ'} · {formatThaiDate(transaction.date)}</span></div><div className={`transaction-amount ${expense ? 'is-expense' : 'is-income'}`}>{expense ? '-' : '+'}฿{formatMoney(transaction.amount, 0)}</div>{onEdit && <div className="row-actions"><button className="icon-button" onClick={onEdit} aria-label="แก้ไข"><Pencil size={16} /></button><button className="icon-button danger" onClick={onDelete} aria-label="ลบ"><Trash2 size={16} /></button></div>}</div>;
}

function TransactionsScreen({ data, onEdit, onDelete, onAdd }: { data: AppData; onEdit: (transaction: Transaction) => void; onDelete: (id: string) => void; onAdd: () => void }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | TransactionType>('all');
  const [categoryId, setCategoryId] = useState('all');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const filtered = data.transactions.filter((transaction) => {
    const category = getCategory(data.categories, transaction.categoryId);
    const matchesQuery = `${category.name} ${transaction.note}`.toLowerCase().includes(query.toLowerCase());
    const matchesType = type === 'all' || transaction.type === type;
    const matchesCategory = categoryId === 'all' || transaction.categoryId === categoryId;
    const matchesStart = !dateRange.start || transaction.date >= dateRange.start;
    const matchesEnd = !dateRange.end || transaction.date <= dateRange.end;
    return matchesQuery && matchesType && matchesCategory && matchesStart && matchesEnd;
  }).sort((a, b) => b.date.localeCompare(a.date));

  return <div className="page transactions-page"><section className="page-intro"><div><h2>ประวัติรายการ</h2><p>ค้นหา กรอง และจัดการทุกรายรับรายจ่ายของคุณ</p></div><button className="primary-button" onClick={onAdd}><Plus size={19} />เพิ่มรายการ</button></section><section className="filter-panel"><div className="search-field"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาหมวดหมู่หรือหมายเหตุ" /></div><div className="filter-row"><div className="segmented"><button className={type === 'all' ? 'active' : ''} onClick={() => setType('all')}>ทั้งหมด</button><button className={type === 'expense' ? 'active expense' : ''} onClick={() => setType('expense')}>รายจ่าย</button><button className={type === 'income' ? 'active income' : ''} onClick={() => setType('income')}>รายรับ</button></div><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="กรองหมวดหมู่"><option value="all">ทุกหมวดหมู่</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><div className="date-range"><CalendarDays size={17} /><input type="date" value={dateRange.start} onChange={(event) => setDateRange({ ...dateRange, start: event.target.value })} /><span>ถึง</span><input type="date" value={dateRange.end} onChange={(event) => setDateRange({ ...dateRange, end: event.target.value })} /></div><button className="clear-filter" onClick={() => { setQuery(''); setType('all'); setCategoryId('all'); setDateRange({ start: '', end: '' }); }} title="ล้างตัวกรอง"><RotateCcw size={17} /></button></div></section><section className="panel transaction-table-panel"><div className="table-head"><span>พบ {filtered.length} รายการ</span><span><ListFilter size={15} /> ตัวกรองแบบละเอียด</span></div>{filtered.length ? <div className="transaction-list transaction-list--full">{filtered.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} category={getCategory(data.categories, transaction.categoryId)} onEdit={() => onEdit(transaction)} onDelete={() => onDelete(transaction.id)} />)}</div> : <EmptyState title="ไม่พบรายการที่ตรงกับตัวกรอง" detail="ลองเปลี่ยนคำค้นหาหรือล้างตัวกรองอีกครั้ง" />}</section></div>;
}

function SummaryScreen({ data, totals, monthName }: { data: AppData; totals: ReturnType<typeof calculateTotals>; monthName: string }) {
  const [summaryType, setSummaryType] = useState<TransactionType>('expense');
  const [detailMonth, setDetailMonth] = useState<string | null>(null);
  const breakdown = groupByCategory(totals.current, summaryType);
  const total = summaryType === 'expense' ? totals.expense : totals.income;
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const colorStops = entries.map(([id, amount], index) => { const start = entries.slice(0, index).reduce((sum, [, value]) => sum + value, 0) / Math.max(total, 1) * 100; const end = start + amount / Math.max(total, 1) * 100; return `${getCategory(data.categories, id).color} ${start}% ${end}%`; }).join(', ');
  const months = Array.from(new Set(data.transactions.map((item) => item.date.slice(0, 7)))).sort().reverse().slice(0, 5);
  return <div className="page summary-page"><section className="page-intro"><div><h2>สรุปผล</h2><p>วิเคราะห์ภาพรวมและสัดส่วนการเงินในแต่ละหมวดหมู่</p></div><span className="soft-tag"><CalendarDays size={15} />{monthName}</span></section><section className="summary-grid"><article className="panel category-summary"><div className="summary-tabs"><button className={summaryType === 'expense' ? 'active expense' : ''} onClick={() => setSummaryType('expense')}>รายจ่าย</button><button className={summaryType === 'income' ? 'active income' : ''} onClick={() => setSummaryType('income')}>รายรับ</button></div><div className="summary-total"><p>{summaryType === 'expense' ? 'ยอดใช้จ่ายรวม' : 'ยอดรายรับรวม'}</p><strong className={summaryType === 'expense' ? 'is-expense' : 'is-income'}>฿{formatMoney(total)}</strong></div>{entries.length ? <div className="donut-section"><div className="category-donut" style={{ background: `conic-gradient(${colorStops})` }}><div><span>ทั้งหมด</span><strong>{entries.length} หมวด</strong></div></div><div className="donut-legend">{entries.map(([id, amount]) => { const category = getCategory(data.categories, id); const Icon = iconMap[category.icon]; return <div key={id}><span style={{ color: category.color }}><Icon size={16} />{category.name}</span><strong>฿{formatMoney(amount, 0)} <small>{(amount / total * 100).toFixed(1)}%</small></strong></div>; })}</div></div> : <EmptyState title={`ยังไม่มี${getTypeLabel(summaryType)}`} detail="เพิ่มรายการเพื่อดูสรุปแบบละเอียด" />}</article><article className="panel monthly-history"><div className="panel-header"><div><p className="section-kicker">ย้อนหลัง</p><h3>ภาพรวมรายเดือน</h3></div></div><div className="month-history-list">{months.length ? months.map((month) => { const date = new Date(`${month}-01T12:00:00`); const monthly = calculateTotals(data.transactions, date); return <button type="button" className="month-history-row month-history-row--clickable" key={month} onClick={() => setDetailMonth(month)} aria-label={`ดูรายละเอียด ${MONTHS_TH[date.getMonth()]} ${date.getFullYear() + 543}`}><div><strong>{MONTHS_TH[date.getMonth()]} {date.getFullYear() + 543}</strong><span>รายรับ ฿{formatMoney(monthly.income, 0)} · รายจ่าย ฿{formatMoney(monthly.expense, 0)}</span></div><strong className={monthly.balance >= 0 ? 'positive' : 'negative'}>{monthly.balance >= 0 ? '+' : ''}฿{formatMoney(monthly.balance, 0)}</strong><ChevronRight size={16} className="month-history-chevron" /></button>; }) : <EmptyState title="ยังไม่มีข้อมูลย้อนหลัง" detail="บันทึกรายการเพื่อเริ่มติดตามภาพรวม" />}</div></article></section>{detailMonth && <MonthDetailModal data={data} month={detailMonth} onClose={() => setDetailMonth(null)} />}</div>;
}

function MonthDetailModal({ data, month, onClose }: { data: AppData; month: string; onClose: () => void }) {
  const date = new Date(`${month}-01T12:00:00`);
  const monthly = calculateTotals(data.transactions, date);
  const title = `${MONTHS_TH[date.getMonth()]} ${date.getFullYear() + 543}`;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <Modal title={title} onClose={onClose}>
    <div className="md-balance"><span>คงเหลือสุทธิ</span><strong className={monthly.balance >= 0 ? 'positive' : 'negative'}>{monthly.balance >= 0 ? '+' : ''}฿{formatMoney(monthly.balance, 0)}</strong></div>
    <CategoryDonutBlock categories={data.categories} transactions={monthly.current} type="income" />
    <CategoryDonutBlock categories={data.categories} transactions={monthly.current} type="expense" />
  </Modal>;
}

function CategoryDonutBlock({ categories, transactions, type }: { categories: Category[]; transactions: Transaction[]; type: TransactionType }) {
  const entries = Object.entries(groupByCategory(transactions, type)).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, amount]) => sum + amount, 0);
  const colorStops = entries.map(([id, amount], index) => {
    const start = entries.slice(0, index).reduce((sum, [, value]) => sum + value, 0) / Math.max(total, 1) * 100;
    const end = start + amount / Math.max(total, 1) * 100;
    return `${getCategory(categories, id).color} ${start}% ${end}%`;
  }).join(', ');
  return <section className={`md-block md-block--${type}`}>
    <div className="md-block-head"><span>{type === 'expense' ? 'รายจ่ายมาจากหมวดไหน' : 'รายรับมาจากหมวดไหน'}</span><strong>฿{formatMoney(total)}</strong></div>
    {entries.length ? <div className="md-donut">
      <div className="category-donut" style={{ background: `conic-gradient(${colorStops})` }}><div><span>ทั้งหมด</span><strong>{entries.length} หมวด</strong></div></div>
      <div className="donut-legend">{entries.map(([id, amount]) => { const category = getCategory(categories, id); const Icon = iconMap[category.icon]; return <div key={id}><span style={{ color: category.color }}><Icon size={16} />{category.name}</span><strong>฿{formatMoney(amount, 0)} <small>{(amount / total * 100).toFixed(1)}%</small></strong></div>; })}</div>
    </div> : <EmptyState title={`ไม่มี${getTypeLabel(type)}ในเดือนนี้`} detail="ยังไม่มีรายการในเดือนนี้" />}
  </section>;
}

function SettingsScreen({ data, totals, expenseByCategory, onChange, onNotify, onCategory, onLogout }: { data: AppData; totals: ReturnType<typeof calculateTotals>; expenseByCategory: Record<string, number>; onChange: (data: AppData) => void; onNotify: (text: string) => void; onCategory: (category?: Category, type?: TransactionType) => void; onLogout: () => void }) {
  const [profile, setProfile] = useState(data.profile);
  const [overallBudget, setOverallBudget] = useState(data.budgets.overall?.toString() ?? '');
  const [categoryBudgets, setCategoryBudgets] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(data.budgets.byCategory).map(([key, value]) => [key, String(value)])));
  useEffect(() => {
    setProfile(data.profile);
    setOverallBudget(data.budgets.overall?.toString() ?? '');
    setCategoryBudgets(Object.fromEntries(Object.entries(data.budgets.byCategory).map(([key, value]) => [key, String(value)])));
  }, [data.profile, data.budgets, data.categories]);
  const expenses = data.categories.filter((category) => category.type === 'expense');
  const income = data.categories.filter((category) => category.type === 'income');
  const saveProfile = () => { onChange({ ...data, profile }); onNotify('บันทึกชื่อบัญชีธนาคารเรียบร้อย'); };
  const saveBudget = () => {
    const byCategory = Object.fromEntries(Object.entries(categoryBudgets).filter(([, value]) => Number(value) > 0).map(([key, value]) => [key, Number(value)]));
    onChange({ ...data, budgets: { overall: Number(overallBudget) > 0 ? Number(overallBudget) : null, byCategory } });
    onNotify('บันทึกงบประมาณเรียบร้อย');
  };
  const deleteCategory = (category: Category) => {
    if (category.isDefault) return;
    const fallback = data.categories.find((item) => item.id !== category.id && item.type === category.type && item.isDefault) ?? data.categories.find((item) => item.id !== category.id && item.type === category.type);
    if (!fallback || !window.confirm(`ลบหมวดหมู่ “${category.name}” ใช่ไหม? รายการเดิมจะย้ายไป “${fallback.name}”`)) return;
    onChange({
      ...data,
      transactions: data.transactions.map((item) => item.categoryId === category.id ? { ...item, categoryId: fallback.id } : item),
      categories: data.categories.filter((item) => item.id !== category.id),
      budgets: { ...data.budgets, byCategory: Object.fromEntries(Object.entries(data.budgets.byCategory).filter(([id]) => id !== category.id)) },
    });
    onNotify(`ลบหมวดหมู่และย้ายรายการไป “${fallback.name}” เรียบร้อย`);
  };
  const clearAll = () => { if (!window.confirm('ล้างข้อมูลธุรกรรมทั้งหมด? การดำเนินการนี้ไม่สามารถกู้คืนได้')) return; onChange({ ...data, transactions: [], budgets: { overall: null, byCategory: {} } }); onNotify('ล้างข้อมูลทั้งหมดเรียบร้อย'); };
  return <div className="page settings-page"><section className="page-intro"><div><h2>ตั้งค่า</h2><p>ปรับข้อมูลส่วนตัว งบประมาณ หมวดหมู่ และรูปแบบการใช้งาน</p></div></section><div className="settings-grid"><article className="panel settings-profile"><div className="panel-header"><div><p className="section-kicker">บัญชีธนาคาร</p><h3>ชื่อเจ้าของบัญชี</h3></div><div className="settings-icon"><UserRound size={20} /></div></div><p className="muted">ใช้เป็นข้อมูลอ้างอิงเมื่ออ่านสลิป เพื่อช่วยตรวจทานประเภทรายการ</p><div className="form-grid"><label>ชื่อ-นามสกุล (ภาษาไทย)<input value={profile.nameThai} onChange={(event) => setProfile({ ...profile, nameThai: event.target.value })} placeholder="เช่น สมชาย ใจดี" /></label><label>ชื่อภาษาอังกฤษ <input value={profile.nameEnglish} onChange={(event) => setProfile({ ...profile, nameEnglish: event.target.value })} placeholder="e.g. Somchai Jaidee" /></label></div><button className="primary-button" onClick={saveProfile}>บันทึกข้อมูล</button></article><article className="panel settings-display"><div className="panel-header"><div><p className="section-kicker">การแสดงผล</p><h3>รูปแบบหน้าจอ</h3></div><button className="theme-square" onClick={() => onChange({ ...data, settings: { darkMode: !data.settings.darkMode } })}>{data.settings.darkMode ? <Sun size={20} /> : <Moon size={20} />}</button></div><div className="preference-line"><div><strong>โหมดมืด</strong><p>ปรับธีมให้สบายตาในสภาพแสงน้อย</p></div><button className={`switch ${data.settings.darkMode ? 'switch--on' : ''}`} onClick={() => onChange({ ...data, settings: { darkMode: !data.settings.darkMode } })} aria-label="สลับโหมดมืด"><i /></button></div><div className="safe-note"><CheckCircle2 size={18} /><span>ข้อมูลของคุณถูกเก็บไว้ภายในเบราว์เซอร์นี้</span></div></article></div><FaceSettingsPanel onNotify={onNotify} /><section className="panel budget-settings"><div className="panel-header"><div><p className="section-kicker">งบประมาณ</p><h3>วางแผนค่าใช้จ่ายรายเดือน</h3></div><Target size={21} /></div><div className="overall-budget-line"><div><strong>งบรวมทั้งเดือน</strong><p>ใช้ไปแล้ว ฿{formatMoney(totals.expense, 0)} ในเดือนนี้</p></div><label className="currency-input"><span>฿</span><input type="number" min="0" value={overallBudget} onChange={(event) => setOverallBudget(event.target.value)} placeholder="ยังไม่ได้ตั้งงบ" /></label></div><div className="budget-category-list">{expenses.map((category) => { const Icon = iconMap[category.icon]; const spent = expenseByCategory[category.id] ?? 0; const budget = Number(categoryBudgets[category.id] ?? 0); const percent = budget ? Math.min(100, spent / budget * 100) : 0; return <div className="budget-category-row" key={category.id}><div className="category-symbol" style={{ background: `${category.color}18`, color: category.color }}><Icon size={18} /></div><div className="budget-category-info"><div><strong>{category.name}</strong><span>ใช้ไป ฿{formatMoney(spent, 0)}</span></div>{budget > 0 && <div className="thin-track"><i className={percent >= 100 ? 'over' : percent >= 80 ? 'near' : ''} style={{ width: `${percent}%` }} /></div>}</div><label className="currency-input small"><span>฿</span><input type="number" min="0" value={categoryBudgets[category.id] ?? ''} onChange={(event) => setCategoryBudgets({ ...categoryBudgets, [category.id]: event.target.value })} placeholder="ไม่จำกัด" /></label></div>; })}</div><button className="primary-button" onClick={saveBudget}>บันทึกงบประมาณ</button></section><section className="category-settings"><div className="section-heading"><div><p className="section-kicker">จัดการข้อมูล</p><h3>หมวดหมู่รายการ</h3></div></div><div className="category-admin-grid"><CategoryAdmin title="หมวดหมู่รายจ่าย" categories={expenses} onNew={() => onCategory(undefined, 'expense')} onEdit={(category) => onCategory(category)} onDelete={deleteCategory} /><CategoryAdmin title="หมวดหมู่รายรับ" categories={income} onNew={() => onCategory(undefined, 'income')} onEdit={(category) => onCategory(category)} onDelete={deleteCategory} /></div></section><section className="danger-zone"><div><div className="danger-icon"><CircleAlert size={21} /></div><div><strong>ล้างข้อมูลทางการเงิน</strong><p>ลบรายการและงบประมาณทั้งหมดจากเบราว์เซอร์นี้</p></div></div><button className="danger-button" onClick={clearAll}><Trash2 size={17} />ล้างข้อมูล</button></section><section className="logout-section"><button className="outline-button" onClick={onLogout}><LogOut size={18} />ออกจากระบบ</button></section></div>;
}

function CategoryAdmin({ title, categories, onNew, onEdit, onDelete }: { title: string; categories: Category[]; onNew: () => void; onEdit: (category: Category) => void; onDelete: (category: Category) => void }) { return <article className="panel category-admin"><div className="panel-header"><h3>{title}</h3><button className="small-add" onClick={onNew}><Plus size={16} />เพิ่ม</button></div><div className="admin-list">{categories.map((category) => { const Icon = iconMap[category.icon]; return <div key={category.id}><div className="category-symbol" style={{ background: `${category.color}18`, color: category.color }}><Icon size={17} /></div><strong>{category.name}</strong><div className="admin-actions"><button className="icon-button" onClick={() => onEdit(category)} aria-label="แก้ไขหมวดหมู่"><Pencil size={15} /></button>{!category.isDefault && <button className="icon-button danger" onClick={() => onDelete(category)} aria-label="ลบหมวดหมู่"><Trash2 size={15} /></button>}</div></div>; })}</div></article>; }

function TransactionModal({ categories, transaction, prefill, onClose, onSave }: { categories: Category[]; transaction?: Transaction; prefill?: Partial<TransactionDraft>; onClose: () => void; onSave: (draft: TransactionDraft, editingId?: string) => void }) {
  const initial = transaction ?? { amount: prefill?.amount ?? 0, type: prefill?.type ?? 'expense', date: prefill?.date ?? dateInputToday(), note: prefill?.note ?? '', categoryId: prefill?.categoryId ?? 'food' };
  const [draft, setDraft] = useState<TransactionDraft>({ amount: initial.amount, type: initial.type, date: initial.date, note: initial.note, categoryId: initial.categoryId });
  const availableCategories = categories.filter((category) => category.type === draft.type);
  const submit = (event: FormEvent) => { event.preventDefault(); if (draft.amount <= 0) return; onSave({ ...draft, categoryId: availableCategories.some((category) => category.id === draft.categoryId) ? draft.categoryId : availableCategories[0]?.id ?? 'other' }, transaction?.id); };
  return <Modal title={transaction ? 'แก้ไขรายการ' : 'เพิ่มรายการ'} onClose={onClose}><form className="transaction-form" onSubmit={submit}><div className="type-toggle"><button type="button" className={draft.type === 'expense' ? 'active expense' : ''} onClick={() => setDraft({ ...draft, type: 'expense', categoryId: categories.find((category) => category.type === 'expense')?.id ?? '' })}><ArrowDownRight size={18} />รายจ่าย</button><button type="button" className={draft.type === 'income' ? 'active income' : ''} onClick={() => setDraft({ ...draft, type: 'income', categoryId: categories.find((category) => category.type === 'income')?.id ?? '' })}><ArrowUpRight size={18} />รายรับ</button></div><label className="large-money-field"><span>จำนวนเงิน</span><div><b>฿</b><input autoFocus type="number" min="0" step="0.01" value={draft.amount || ''} onChange={(event) => setDraft({ ...draft, amount: Number(event.target.value) })} placeholder="0.00" /></div></label><div className="form-grid"><label>วันที่<input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label><label>หมวดหมู่<select value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}>{availableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label></div><label>หมายเหตุ (ถ้ามี)<input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="เช่น ค่าอาหารกลางวัน" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>ยกเลิก</button><button className="primary-button" type="submit"><CheckCircle2 size={18} />{transaction ? 'บันทึกการแก้ไข' : 'บันทึกรายการ'}</button></div></form></Modal>;
}

const CONFIDENCE_LABEL: Record<SlipConfidence, string> = { high: 'มั่นใจสูง', medium: 'ปานกลาง', low: 'ควรตรวจสอบ' };

function ReceiptModal({ profile, categories, onClose, onProceed, onSave }: { profile: Profile; categories: Category[]; onClose: () => void; onProceed: (prefill: Partial<TransactionDraft>) => void; onSave: (draft: TransactionDraft) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<SlipAnalysis | null>(null);
  const [typeOverride, setTypeOverride] = useState<TransactionType | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pickFile = (next: File | null) => { setFile(next); setResult(null); setTypeOverride(null); setError(''); setProgress(0); };

  const readSlip = async () => {
    if (!file) return;
    setProcessing(true); setError(''); setProgress(3);
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker(['tha', 'eng'], 1, { logger: (message: any) => { if (message.status === 'recognizing text') setProgress(Math.max(5, Math.round(message.progress * 100))); } });
      const { data } = await worker.recognize(file);
      await worker.terminate();
      setResult(analyzeSlip(data.text, profile)); setTypeOverride(null); setProgress(100);
    } catch {
      setError('ไม่สามารถอ่านภาพอัตโนมัติได้ในขณะนี้ คุณยังสามารถกดไปกรอกรายการเองได้');
      setResult(analyzeSlip('', profile));
    } finally { setProcessing(false); }
  };

  const type: TransactionType = typeOverride ?? result?.type ?? 'expense';
  const hasText = !!result?.rawText.trim();

  // รายการที่จะบันทึก (ใช้ทั้งปุ่ม "บันทึกเลย" และปุ่ม "แก้ไขก่อนบันทึก")
  const draft: TransactionDraft | null = (() => {
    if (!result) return null;
    const sameType = categories.filter((category) => category.type === type);
    const hinted = suggestCategoryId(result.rawText, type);
    const categoryId = sameType.some((category) => category.id === hinted) ? hinted! : sameType.some((category) => category.id === 'other') ? 'other' : sameType[0]?.id ?? '';
    return { amount: result.amount ?? 0, type, date: result.date ?? dateInputToday(), categoryId, note: buildSlipNote(result, type) };
  })();
  const category = draft ? categories.find((item) => item.id === draft.categoryId) : undefined;
  const counterparty = type === 'expense' ? result?.receiver : result?.sender;
  const outsideThisMonth = !!result?.date && !isSameMonth(result.date);

  return <Modal title="อ่านข้อมูลจากสลิป" onClose={onClose}>
    <div className="receipt-flow">
      {!file ? (
        <div className="dropzone">
          <input type="file" accept="image/*" onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />
          <Upload size={28} /><strong>เลือกภาพสลิป</strong><span>รองรับ JPG, PNG และ HEIC</span>
        </div>
      ) : (
        <div className="slip-file">
          {previewUrl && <img src={previewUrl} alt="ตัวอย่างสลิป" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
          <div className="slip-file-info"><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB</span></div>
          <label className="slip-change"><input type="file" accept="image/*" onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />เปลี่ยนรูป</label>
        </div>
      )}

      {file && !result && (
        <button className="primary-button full" onClick={readSlip} disabled={processing}>
          {processing ? <><Sparkles className="spin" size={18} />กำลังอ่านข้อมูล {progress}%</> : <><ScanText size={18} />เริ่มอ่านข้อมูลจากภาพ</>}
        </button>
      )}
      {processing && <div className="ocr-progress"><i style={{ width: `${progress}%` }} /></div>}
      {error && <div className="notice warning"><CircleAlert size={17} />{error}</div>}

      {result && draft && (
        <div className="receipt-result">
          {hasText ? (
            <>
              <div className={`slip-hero slip-hero--${type}`}>
                <div className="slip-hero-top">
                  <span className="slip-type-badge">{type === 'income' ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}{type === 'income' ? 'รายรับ' : 'รายจ่าย'}</span>
                  {!typeOverride && <em className={`confidence confidence--${result.confidence}`}>{CONFIDENCE_LABEL[result.confidence]}</em>}
                </div>
                <div className="slip-amount">{result.amount ? `฿${formatMoney(result.amount)}` : <span className="slip-amount--missing">ไม่พบยอดเงิน</span>}</div>
                <p className="slip-reason">{typeOverride ? 'คุณเปลี่ยนประเภทเอง' : result.reason}</p>
                <div className="slip-switch-label">ประเภทไม่ถูกต้อง? เลือกใหม่ได้ที่นี่</div>
                <div className="type-toggle">
                  <button type="button" className={type === 'expense' ? 'active expense' : ''} onClick={() => setTypeOverride('expense')}><ArrowDownRight size={18} />รายจ่าย</button>
                  <button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => setTypeOverride('income')}><ArrowUpRight size={18} />รายรับ</button>
                </div>
              </div>

              {result.profileMissing && <div className="notice warning"><CircleAlert size={17} />ยังไม่ได้ตั้งชื่อในโปรไฟล์ (หน้าตั้งค่า) ระบบจึงแยกจากคำในสลิปเท่านั้น ตั้งชื่อแล้วจะแม่นขึ้นมาก</div>}
              {!result.amount && <div className="notice warning"><CircleAlert size={17} />ไม่พบยอดเงินที่ชัดเจน กดปุ่ม "แก้ไขรายละเอียด" เพื่อกรอกยอดเอง</div>}
              {outsideThisMonth && <div className="notice warning"><CalendarDays size={17} />สลิปนี้ลงวันที่ {formatThaiDate(result.date!)} จะนับในยอดของเดือนนั้น ไม่ใช่เดือนนี้</div>}

              <dl className="slip-details">
                <div><dt><CalendarDays size={15} />วันที่</dt><dd>{result.date ? formatThaiDate(result.date) : 'ไม่พบ (ใช้วันนี้)'}</dd></div>
                <div><dt><Landmark size={15} />ธนาคาร</dt><dd>{result.bankName ?? 'ไม่พบ'}</dd></div>
                <div><dt><UserRound size={15} />{type === 'expense' ? 'ผู้รับเงิน' : 'ผู้โอน'}</dt><dd>{counterparty ?? '-'}</dd></div>
                <div><dt><Tag size={15} />หมวดหมู่</dt><dd>{category ? <><i className="slip-category-dot" style={{ background: category.color }} />{category.name}</> : '-'}</dd></div>
              </dl>

              <TransferSharePanel result={result} type={type} draft={draft} onDone={onClose} />
              <div className="slip-actions">
                <button className="primary-button full" onClick={() => onSave(draft)} disabled={!result.amount}><CheckCircle2 size={18} />บันทึกรายการนี้เลย</button>
                <button className="secondary-button full" onClick={() => onProceed(draft)}><Pencil size={16} />แก้ไขรายละเอียดก่อนบันทึก</button>
              </div>
            </>
          ) : (
            <button className="primary-button full" onClick={() => onProceed({ type: 'expense' })}>กรอกรายการเอง <ChevronRight size={18} /></button>
          )}
        </div>
      )}

      <p className="privacy-hint"><LockKeyhole size={14} />รูปสลิปประมวลผลในเบราว์เซอร์และไม่ถูกบันทึกถาวร</p>
    </div>
  </Modal>;
}

function CategoryModal({ category, type, onClose, onSave }: { category?: Category; type: TransactionType; onClose: () => void; onSave: (category: Category) => void }) {
  const [name, setName] = useState(category?.name ?? '');
  const [icon, setIcon] = useState<CategoryIconName>(category?.icon ?? (type === 'expense' ? 'tag' : 'circle-dollar-sign'));
  const [color, setColor] = useState(category?.color ?? '#6C4AB6');
  const options: CategoryIconName[] = ['utensils', 'car', 'shopping-bag', 'file-text', 'home', 'tag', 'circle-dollar-sign', 'gift', 'briefcase-business', 'trending-up', 'party-popper'];
  const colors = ['#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#8B5CF6', '#EF4444', '#22C55E', '#64748B'];
  const submit = (event: FormEvent) => { event.preventDefault(); if (!name.trim()) return; onSave({ id: category?.id ?? makeId(), name: name.trim(), icon, color, type: category?.type ?? type, isDefault: category?.isDefault }); };
  return <Modal title={category ? 'แก้ไขหมวดหมู่' : `เพิ่มหมวดหมู่${getTypeLabel(type)}`} onClose={onClose}><form className="category-form" onSubmit={submit}><label>ชื่อหมวดหมู่<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="เช่น ค่าเดินทาง" /></label><span className="form-label">เลือกไอคอน</span><div className="icon-picks">{options.map((option) => { const Icon = iconMap[option]; return <button type="button" className={icon === option ? 'selected' : ''} onClick={() => setIcon(option)} key={option} style={{ '--selected-color': color } as React.CSSProperties}><Icon size={19} /></button>; })}</div><span className="form-label">เลือกสี</span><div className="color-picks">{colors.map((choice) => <button type="button" className={color === choice ? 'selected' : ''} style={{ background: choice }} onClick={() => setColor(choice)} key={choice}>{color === choice && <CheckCircle2 size={15} />}</button>)}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>ยกเลิก</button><button className="primary-button" type="submit">{category ? 'บันทึกการแก้ไข' : 'เพิ่มหมวดหมู่'}</button></div></form></Modal>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-layer" role="dialog" aria-modal="true" aria-label={title}><button className="modal-backdrop" aria-label="ปิด" onClick={onClose} /><div className="modal-card"><div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="ปิด"><X size={20} /></button></div>{children}</div></div>; }

function AuthScreen({ onDemo, onLogin, onRegister }: { onDemo: () => void; onLogin: (session: Session) => void; onRegister: (session: Session, profile: AppData['profile']) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cameraLogin, setCameraLogin] = useState(false);
  const [offer, setOffer] = useState<{ account: Session; profile: AppData['profile'] } | null>(null);
  const openCameraLogin = () => {
    setError('');
    setCameraLogin(true);
  };
  const faceLogin = async () => {
    setError('');
    setLoading(true);
    try {
      onLogin(await loginWithFace());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เกิดข้อผิดพลาด');
    } finally {
      setLoading(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (mode === 'register') {
      if (username.trim().length < 3 || password.length < 6) { setError('Username อย่างน้อย 3 ตัวอักษร และ Password อย่างน้อย 6 ตัวอักษร'); return; }
      if (password !== confirm) { setError('Password ทั้งสองช่องไม่ตรงกัน'); return; }
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        onLogin(await apiLogin(username.trim(), password));
      } else {
        const account = await apiRegister(username.trim(), password, name.trim());
        const profile = { nameThai: name.trim(), nameEnglish: '' };
        setOffer({ account, profile }); // เสนอให้เปิดสแกนหน้าก่อนเข้าแอป
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เกิดข้อผิดพลาด');
    } finally {
      setLoading(false);
    }
  };
  return <div className="auth-shell"><section className="auth-story"><div className="auth-brand"><div className="brand-mark"><Wallet size={23} /></div><strong>BahtFlow</strong></div><div className="auth-copy"><p className="eyebrow">เงินชัด ชีวิตไหลลื่น</p><h1>รู้ทุกการเคลื่อนไหว<br />ของเงินคุณ</h1><p>บันทึกรายรับรายจ่าย วางแผนงบ และเข้าใจภาพรวมการเงินได้ในพื้นที่เดียว</p></div><div className="auth-points"><span><CheckCircle2 size={17} />สรุปผลแบบเข้าใจง่าย</span><span><CheckCircle2 size={17} />อ่านข้อมูลจากสลิป</span><span><CheckCircle2 size={17} />ข้อมูลอยู่ในเบราว์เซอร์ของคุณ</span></div><div className="auth-decoration decoration-one" /><div className="auth-decoration decoration-two" /></section><section className="auth-form-wrap"><div className="auth-form-card">{offer ? <FaceOffer onDone={() => onRegister(offer.account, offer.profile)} /> : <><div className="auth-form-heading"><div className="auth-icon"><LockKeyhole size={23} /></div><h2>{mode === 'login' ? 'ยินดีต้อนรับกลับมา' : 'สร้างบัญชีใหม่'}</h2><p>{mode === 'login' ? 'เข้าสู่ระบบเพื่อจัดการภาพรวมทางการเงิน' : 'เริ่มต้นจัดระเบียบการเงินของคุณวันนี้'}</p></div><form onSubmit={submit}><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="กรอก Username" autoComplete="username" required /></label>{mode === 'register' && <label>ชื่อ-นามสกุล (ภาษาไทย)<input value={name} onChange={(event) => setName(event.target.value)} placeholder="เช่น สมชาย ใจดี" /></label>}<label>Password<div className="password-field"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="กรอก Password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label="แสดงรหัสผ่าน">{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>{mode === 'register' && <label>ยืนยัน Password<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="กรอก Password อีกครั้ง" autoComplete="new-password" required /></label>}{error && <div className="auth-error"><CircleAlert size={17} />{error}</div>}<button className="primary-button auth-submit" disabled={loading}>{loading ? 'กำลังดำเนินการ...' : mode === 'login' ? 'เข้าสู่ระบบ' : 'ลงทะเบียน'}</button></form>{mode === 'login' && <><button type="button" className="face-button" onClick={openCameraLogin} disabled={loading || !canUseCamera()}><Camera size={19} />สแกนหน้าด้วยกล้อง</button></>}<p className="auth-switch">{mode === 'login' ? 'ยังไม่มีบัญชี?' : 'มีบัญชีอยู่แล้ว?'} <button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'ลงทะเบียน' : 'เข้าสู่ระบบ'}</button></p></>}{cameraLogin && <FaceCameraModal mode="login" onClose={() => setCameraLogin(false)} onCapture={async (descriptors) => { const user = await apiFaceLogin(username.trim(), descriptors[0]); setCameraLogin(false); onLogin(user); }} />}</div></section></div>;
}
export default App;