import type { AppData, Category, Transaction, TransactionType } from './types';

export const MONTHS_TH = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

export const defaultCategories: Category[] = [
  { id: 'food', name: 'ค่าอาหาร', icon: 'utensils', color: '#F59E0B', type: 'expense', isDefault: true },
  { id: 'transport', name: 'ค่ารถ', icon: 'car', color: '#3B82F6', type: 'expense', isDefault: true },
  { id: 'shopping', name: 'ค่าช็อป', icon: 'shopping-bag', color: '#EC4899', type: 'expense', isDefault: true },
  { id: 'bills', name: 'ค่าบิล', icon: 'file-text', color: '#14B8A6', type: 'expense', isDefault: true },
  { id: 'home', name: 'ที่อยู่อาศัย', icon: 'home', color: '#8B5CF6', type: 'expense', isDefault: true },
  { id: 'other', name: 'อื่น ๆ', icon: 'tag', color: '#64748B', type: 'expense', isDefault: true },
  { id: 'salary', name: 'เงินเดือน', icon: 'circle-dollar-sign', color: '#22C55E', type: 'income', isDefault: true },
  { id: 'bonus', name: 'โบนัส', icon: 'gift', color: '#EAB308', type: 'income', isDefault: true },
  { id: 'business', name: 'ธุรกิจ/ฟรีแลนซ์', icon: 'briefcase-business', color: '#6366F1', type: 'income', isDefault: true },
  { id: 'investment', name: 'ดอกเบี้ย/เงินปันผล', icon: 'trending-up', color: '#14B8A6', type: 'income', isDefault: true },
  { id: 'gift', name: 'ได้รับเป็นของขวัญ', icon: 'party-popper', color: '#F472B6', type: 'income', isDefault: true },
];

export const toLocalDateInput = (value = new Date()) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const iso = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return toLocalDateInput(date);
};

export const createDemoData = (): AppData => {
  const transactions: Transaction[] = [
    { id: 'tx-1', amount: 32500, type: 'income', date: iso(-12), note: 'เงินเดือนประจำเดือน', categoryId: 'salary' },
    { id: 'tx-2', amount: 1680, type: 'expense', date: iso(-10), note: 'ซื้อของเข้าบ้าน', categoryId: 'shopping' },
    { id: 'tx-3', amount: 120, type: 'expense', date: iso(-7), note: 'กาแฟและอาหารกลางวัน', categoryId: 'food' },
    { id: 'tx-4', amount: 750, type: 'expense', date: iso(-5), note: 'เติมน้ำมัน', categoryId: 'transport' },
    { id: 'tx-5', amount: 499, type: 'expense', date: iso(-3), note: 'ค่าอินเทอร์เน็ต', categoryId: 'bills' },
    { id: 'tx-6', amount: 2400, type: 'income', date: iso(-1), note: 'งานออกแบบเว็บไซต์', categoryId: 'business' },
    { id: 'tx-7', amount: 290, type: 'expense', date: iso(0), note: 'อาหารเย็น', categoryId: 'food' },
  ];
  return {
    transactions,
    categories: defaultCategories,
    budgets: { overall: 12000, byCategory: { food: 3000, transport: 2500, shopping: 2500, bills: 1800 } },
    profile: { nameThai: 'สมชาย ใจดี', nameEnglish: 'Somchai Jaidee' },
    settings: { darkMode: false },
  };
};

export const createEmptyData = (): AppData => ({
  transactions: [],
  categories: defaultCategories,
  budgets: { overall: null, byCategory: {} },
  profile: { nameThai: '', nameEnglish: '' },
  settings: { darkMode: false },
});

export const formatMoney = (value: number, fraction = 2) => new Intl.NumberFormat('th-TH', {
  minimumFractionDigits: fraction,
  maximumFractionDigits: fraction,
}).format(value);

export const formatThaiDate = (value: string) => {
  const date = new Date(`${value}T12:00:00`);
  return `${date.getDate()} ${MONTHS_TH[date.getMonth()]} ${date.getFullYear() + 543}`;
};

export const monthLabel = (date = new Date()) => `${MONTHS_TH[date.getMonth()]} ${date.getFullYear() + 543}`;

export const isSameMonth = (dateValue: string, target = new Date()) => {
  const date = new Date(`${dateValue}T12:00:00`);
  return date.getMonth() === target.getMonth() && date.getFullYear() === target.getFullYear();
};

export const getTypeLabel = (type: TransactionType) => type === 'expense' ? 'รายจ่าย' : 'รายรับ';
