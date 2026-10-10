import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from './storage';
import type { Category, Profile, Session, Transaction, TransactionType } from './types';

/* ---------- ชนิดข้อมูลจากเซิร์ฟเวอร์ ---------- */

export interface ServerTransfer {
  id: number;
  type: TransactionType; // มุมมองของเรา: เราเป็นผู้โอน = expense, เป็นผู้รับ = income
  amount: number;
  date: string;
  note: string;
  counterpart: string;
  categoryId: string | null;
  uploadedByMe: boolean;
}

export interface FoundUser {
  username: string;
  displayName: string;
}

export interface CreateTransferInput {
  role: 'sender' | 'receiver';
  counterpart: string;
  amount: number;
  date: string;
  ref?: string;
  note?: string;
  categoryId?: string;
  force?: boolean;
}

export class DuplicateTransferError extends Error {
  canForce: boolean;
  constructor(message: string, canForce: boolean) {
    super(message);
    this.canForce = canForce;
  }
}

/* ---------- เรียก API ---------- */

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบว่าเปิดเซิร์ฟเวอร์ด้วยคำสั่ง pnpm server อยู่', 0);
  }
  const body = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    if (response.status === 409 && body.duplicate) throw new DuplicateTransferError(String(body.error ?? 'บันทึกซ้ำ'), body.canForce === true);
    throw new ApiError(String(body.error ?? 'เกิดข้อผิดพลาด'), response.status);
  }
  return body as T;
}

export const apiFindUsers = async (input: { name?: string; username?: string }) =>
  (await call<{ users: FoundUser[] }>('/api/users/find', { method: 'POST', body: JSON.stringify(input) })).users;

export const apiCreateTransfer = async (input: CreateTransferInput) =>
  (await call<{ transfer: ServerTransfer; restored?: boolean }>('/api/transfers', { method: 'POST', body: JSON.stringify(input) }));

/* ---------- ใช้ร่วมกับหน้าจอหลัก ---------- */

const TRANSFER_PREFIX = 'tf-';
export const TRANSFER_EVENT = 'bahtflow:transfers-changed';
export const isTransferId = (id: string) => id.startsWith(TRANSFER_PREFIX);

const pickCategory = (categories: Category[], type: TransactionType, wanted: string | null) => {
  const sameType = categories.filter((category) => category.type === type);
  if (wanted && sameType.some((category) => category.id === wanted)) return wanted;
  if (type === 'expense' && sameType.some((category) => category.id === 'other')) return 'other';
  return sameType[0]?.id ?? 'other';
};

/**
 * โหลดรายการโอนระหว่างผู้ใช้จากเซิร์ฟเวอร์ แล้วแปลงเป็น Transaction ธรรมดา
 * เพื่อให้ภาพรวม / รายการ / สรุปผล นับรวมได้เลย (id ขึ้นต้นด้วย "tf-")
 * และซิงก์ชื่อโปรไฟล์ขึ้นเซิร์ฟเวอร์ เพื่อให้อีกฝ่ายค้นหาเราจากชื่อบนสลิปได้
 */
export function useTransfers(session: Session | null, profile: Pick<Profile, 'nameThai' | 'nameEnglish'>, categories: Category[]) {
  const [items, setItems] = useState<ServerTransfer[]>([]);
  const active = !!session && !session.isDemo;
  const username = session?.username;

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      setItems((await call<{ transfers: ServerTransfer[] }>('/api/transfers')).transfers);
    } catch {
      // เซิร์ฟเวอร์ปิดอยู่/หมดอายุ: ไม่ต้องแจ้งซ้ำ ส่วนหมดอายุ App จัดการเองอยู่แล้ว
    }
  }, [active, username]);

  useEffect(() => {
    setItems([]);
    if (!active) return;
    refresh();
    const timer = window.setInterval(refresh, 30_000); // อีกฝ่ายอัปโหลดสลิป จะขึ้นเองภายใน ~30 วินาที
    window.addEventListener('focus', refresh);
    window.addEventListener(TRANSFER_EVENT, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(TRANSFER_EVENT, refresh);
    };
  }, [active, username, refresh]);

  useEffect(() => {
    if (!active) return;
    // ไม่ส่งชื่อว่างขึ้นไปทับ (เช่น ล็อกอินจากเบราว์เซอร์ใหม่ที่ยังไม่มีโปรไฟล์ในเครื่อง)
    if (!profile.nameThai.trim() && !profile.nameEnglish.trim()) return;
    call('/api/profile', { method: 'PUT', body: JSON.stringify({ nameThai: profile.nameThai, nameEnglish: profile.nameEnglish }) }).catch(() => undefined);
  }, [active, username, profile.nameThai, profile.nameEnglish]);

  const transfers = useMemo<Transaction[]>(() => items.map((item) => ({
    id: `${TRANSFER_PREFIX}${item.id}`,
    amount: item.amount,
    type: item.type,
    date: item.date,
    note: `${item.type === 'expense' ? 'โอนให้' : 'รับจาก'} ${item.counterpart}${item.note ? ` · ${item.note}` : ''}`,
    categoryId: pickCategory(categories, item.type, item.categoryId),
  })), [items, categories]);

  const hide = useCallback(async (id: string) => {
    await call('/api/transfers/hide', { method: 'POST', body: JSON.stringify({ id: Number(id.slice(TRANSFER_PREFIX.length)) }) });
    await refresh();
  }, [refresh]);

  return { transfers, hide };
}