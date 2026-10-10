// สแกนหน้าเพื่อเข้าสู่ระบบ (WebAuthn / Passkey)
// ใช้ Face ID / Windows Hello / การปลดล็อกด้วยใบหน้าของอุปกรณ์ — ภาพใบหน้าไม่ออกจากเครื่อง ส่งมาเซิร์ฟเวอร์เฉพาะลายเซ็นดิจิทัล
import { request } from './storage';
import type { Session } from './types';

const toB64u = (buffer: ArrayBuffer) => {
  let binary = '';
  new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64u = (value: string): ArrayBuffer => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
};

interface CreateOptionsJSON extends Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials: { type: 'public-key'; id: string }[];
}

interface RequestOptionsJSON extends Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> {
  challenge: string;
  allowCredentials: { type: 'public-key'; id: string }[];
}

export interface FaceDevice {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type FaceSupport = { ok: true } | { ok: false; reason: string };

/** ตรวจว่าเครื่องนี้สแกนหน้า/ปลดล็อกด้วยเครื่องได้ไหม ถ้าไม่ได้จะบอกสาเหตุ */
export const checkFaceSupport = async (): Promise<FaceSupport> => {
  if (!window.isSecureContext) return { ok: false, reason: 'ที่อยู่เว็บนี้ไม่ปลอดภัยตามเกณฑ์เบราว์เซอร์ ต้องเปิดผ่าน https หรือ http://localhost เท่านั้น' };
  if (!window.PublicKeyCredential) return { ok: false, reason: 'เบราว์เซอร์นี้ไม่รองรับการสแกนหน้า ลองใช้ Chrome, Edge หรือ Safari รุ่นใหม่' };
  try {
    if (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) return { ok: true };
  } catch {
    // ตกไปที่ข้อความด้านล่าง
  }
  return { ok: false, reason: 'เครื่องนี้ยังไม่ได้ตั้งค่าการปลดล็อกด้วยใบหน้า/ลายนิ้วมือ/PIN บน Windows ไปที่ ตั้งค่า > บัญชี > ตัวเลือกการลงชื่อเข้าใช้ แล้วตั้งค่า Windows Hello' };
};

export const isFaceLoginSupported = async (): Promise<boolean> => (await checkFaceSupport()).ok;

const assertWebAuthn = () => {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('เบราว์เซอร์นี้สแกนหน้าไม่ได้ที่ที่อยู่เว็บนี้ ต้องเปิดผ่าน https หรือ http://localhost');
  }
};

const deviceLabel = () => {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac/i.test(ua)) return 'Mac';
  return 'อุปกรณ์นี้';
};

const friendlyError = (error: unknown): Error => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return new Error('ยกเลิกหรือสแกนหน้าไม่สำเร็จ ลองใหม่อีกครั้ง');
    if (error.name === 'InvalidStateError') return new Error('อุปกรณ์นี้เปิดใช้การสแกนหน้ากับบัญชีนี้แล้ว');
    if (error.name === 'SecurityError') return new Error('เบราว์เซอร์ไม่อนุญาตให้สแกนหน้าที่ที่อยู่เว็บนี้ (ต้องเป็น https หรือ localhost)');
    if (error.name === 'NotSupportedError') return new Error('อุปกรณ์นี้ยังไม่รองรับการสแกนหน้าเพื่อเข้าสู่ระบบ');
  }
  return error instanceof Error ? error : new Error('เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
};

/** เปิดใช้การสแกนหน้าบนอุปกรณ์นี้ (ต้องล็อกอินอยู่ เช่น เพิ่งสมัครเสร็จ) */
export async function enrollFace(): Promise<void> {
  assertWebAuthn();
  const { challengeId, options } = await request<{ challengeId: string; options: CreateOptionsJSON }>('/api/webauthn/register/options', { method: 'POST', body: '{}' });
  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: fromB64u(options.challenge),
        user: { ...options.user, id: fromB64u(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((item) => ({ ...item, id: fromB64u(item.id) })),
      },
    }) as PublicKeyCredential | null;
  } catch (error) {
    throw friendlyError(error);
  }
  if (!credential) throw new Error('สแกนหน้าไม่สำเร็จ ลองใหม่อีกครั้ง');
  const response = credential.response as AuthenticatorAttestationResponse;
  await request('/api/webauthn/register/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      label: deviceLabel(),
      credential: {
        id: credential.id,
        response: { clientDataJSON: toB64u(response.clientDataJSON), attestationObject: toB64u(response.attestationObject) },
      },
    }),
  });
}

/** เข้าสู่ระบบด้วยการสแกนหน้า (ไม่ต้องกรอก Username/Password) */
export async function loginWithFace(): Promise<Session> {
  assertWebAuthn();
  const { challengeId, options } = await request<{ challengeId: string; options: RequestOptionsJSON }>('/api/webauthn/login/options', { method: 'POST', body: '{}' });
  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: { ...options, challenge: fromB64u(options.challenge), allowCredentials: [] },
    }) as PublicKeyCredential | null;
  } catch (error) {
    throw friendlyError(error);
  }
  if (!credential) throw new Error('สแกนหน้าไม่สำเร็จ ลองใหม่อีกครั้ง');
  const response = credential.response as AuthenticatorAssertionResponse;
  const result = await request<{ user: Session }>('/api/webauthn/login/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      credential: {
        id: credential.id,
        response: {
          clientDataJSON: toB64u(response.clientDataJSON),
          authenticatorData: toB64u(response.authenticatorData),
          signature: toB64u(response.signature),
          userHandle: response.userHandle ? toB64u(response.userHandle) : undefined,
        },
      },
    }),
  });
  return result.user;
}

export const listFaceDevices = async () => (await request<{ devices: FaceDevice[] }>('/api/webauthn/credentials')).devices;

export const removeFaceDevice = (id: string) => request<{ ok: boolean }>('/api/webauthn/credentials/delete', { method: 'POST', body: JSON.stringify({ id }) });