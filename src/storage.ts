import { createEmptyData } from './data';
import type { AppData, Session } from './types';

const DATA_KEY_PREFIX = 'bahtflow:data:v1';
const SESSION_KEY = 'bahtflow:session:v1';

const dataKey = (username?: string) => `${DATA_KEY_PREFIX}:${(username ?? 'guest').trim().toLowerCase()}`;

export const loadData = (username?: string): AppData => {
  try {
    const parsed = localStorage.getItem(dataKey(username));
    return parsed ? { ...createEmptyData(), ...JSON.parse(parsed) } : createEmptyData();
  } catch {
    return createEmptyData();
  }
};

export const saveData = (data: AppData, username?: string) => localStorage.setItem(dataKey(username), JSON.stringify(data));

export const loadSession = (): Session | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) as Session : null;
  } catch {
    return null;
  }
};

export const saveSession = (session: Session | null) => {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
};

/* ---------- เรียก API ของเซิร์ฟเวอร์ (บัญชีผู้ใช้อยู่ฝั่งเซิร์ฟเวอร์) ---------- */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const UNREACHABLE = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบว่าเปิดเซิร์ฟเวอร์ด้วยคำสั่ง pnpm server อยู่';

export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }
  const body = await response.json().catch(() => ({} as { error?: string }));
  if (!response.ok) {
    const fallback = response.status >= 500 ? UNREACHABLE : 'เกิดข้อผิดพลาด';
    throw new ApiError(body.error ?? fallback, response.status);
  }
  return body as T;
}

export const apiRegister = async (username: string, password: string, displayName: string) =>
  (await request<{ user: Session }>('/api/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) })).user;

export const apiLogin = async (username: string, password: string) =>
  (await request<{ user: Session }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) })).user;

export const apiLogout = () => request<{ ok: boolean }>('/api/logout', { method: 'POST', body: '{}' });

export const apiMe = async () => (await request<{ user: Session }>('/api/me')).user;