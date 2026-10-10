// สแกนหน้าด้วยกล้อง: โหลด face-api (โหลดเมื่อเปิดกล้องเท่านั้น) + เรียก API ของเซิร์ฟเวอร์
import { request } from './storage';
import type { Session } from './types';

const MODEL_URL = '/models';

let loading: Promise<any> | null = null;

/** โหลด @vladmandic/face-api และโมเดลจาก public/models (โหลดครั้งเดียว) */
export const loadFaceApi = (): Promise<any> => {
  if (!loading) {
    loading = (async () => {
      const faceapi: any = await import('@vladmandic/face-api');
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      return faceapi;
    })().catch((error) => {
      loading = null;
      console.error('โหลด face-api ไม่สำเร็จ', error);
      throw new Error('โหลดโมเดลสแกนหน้าไม่สำเร็จ ตรวจว่าติดตั้งแพ็กเกจและคัดลอกโมเดลไปที่ public/models แล้ว (ดูคอนโซลของเบราว์เซอร์)');
    });
  }
  return loading;
};

export const canUseCamera = () => window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);

export const apiFaceStatus = async () => (await request<{ enrolled: boolean }>('/api/face/status')).enrolled;

export const apiFaceEnroll = (descriptors: number[][]) =>
  request<{ ok: boolean }>('/api/face/enroll', { method: 'POST', body: JSON.stringify({ descriptors }) });

export const apiFaceDelete = () => request<{ ok: boolean }>('/api/face/delete', { method: 'POST', body: '{}' });

export const apiFaceLogin = async (username: string, descriptor: number[]) =>
  (await request<{ user: Session }>('/api/face/login', { method: 'POST', body: JSON.stringify({ username, descriptor }) })).user;