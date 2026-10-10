import { useEffect, useState } from 'react';
import { Camera, CircleAlert, ScanFace, Trash2 } from 'lucide-react';
import { FaceCameraModal } from './FaceCamera';
import { apiFaceDelete, apiFaceEnroll, apiFaceStatus, canUseCamera } from './faceApi';
import { checkFaceSupport, enrollFace, listFaceDevices, removeFaceDevice, type FaceDevice, type FaceSupport } from './webauthn';

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');

/** ขั้นตอนหลังกดลงทะเบียนสำเร็จ: ถามว่าจะเปิดสแกนหน้าสำหรับเข้าสู่ระบบครั้งต่อไปไหม */
export function FaceOffer({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [camera, setCamera] = useState(false);
  const [support, setSupport] = useState<FaceSupport | null>(null);
  useEffect(() => { checkFaceSupport().then(setSupport); }, []);
  const enablePasskey = async () => {
    setError('');
    setBusy(true);
    try {
      await enrollFace();
      onDone();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };
  return (
    <div className="face-offer">
      <div className="auth-icon face-offer__icon"><ScanFace size={24} /></div>
      <h2>สร้างบัญชีสำเร็จแล้ว</h2>
      <p className="face-offer__lead">เปิดการสแกนหน้า เพื่อเข้าสู่ระบบครั้งต่อไปได้ในไม่กี่วินาที โดยไม่ต้องพิมพ์รหัสผ่าน และยังเข้าสู่ระบบด้วยรหัสผ่านได้เสมอ</p>
      {error && <div className="auth-error"><CircleAlert size={17} />{error}</div>}
      <button type="button" className="primary-button auth-submit" onClick={() => setCamera(true)} disabled={busy || !canUseCamera()}>
        <Camera size={19} />สแกนหน้าด้วยกล้อง
      </button>
      <p className="face-offer__note">เปิดกล้องในหน้านี้แล้วสแกนใบหน้า ระบบเก็บเฉพาะค่าลักษณะใบหน้า (ตัวเลข) ไม่เก็บรูปถ่าย</p>
      <button type="button" className="outline-button face-offer__alt" onClick={enablePasskey} disabled={busy}>
        <ScanFace size={18} />{busy ? 'กำลังรอการสแกน...' : 'ใช้ Face ID / Windows Hello แทน'}
      </button>
      {support && !support.ok && <p className="face-offer__note">ตัวเลือกนี้ยังใช้ไม่ได้: {support.reason}</p>}
      <button type="button" className="secondary-button face-offer__skip" onClick={onDone} disabled={busy}>ไว้ทีหลัง</button>
      {camera && (
        <FaceCameraModal
          mode="enroll"
          onClose={() => setCamera(false)}
          onCapture={async (descriptors) => { await apiFaceEnroll(descriptors); setCamera(false); onDone(); }}
        />
      )}
    </div>
  );
}

const formatDate = (value: string | null) => {
  if (!value) return '';
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** หน้าตั้งค่า: ดู / เพิ่ม / ลบ อุปกรณ์ที่เปิดสแกนหน้า (ไม่แสดงในโหมดเดโมหรือเมื่อไม่ได้ล็อกอินกับเซิร์ฟเวอร์) */
export function FaceSettingsPanel({ onNotify }: { onNotify: (text: string) => void }) {
  const [devices, setDevices] = useState<FaceDevice[] | null>(null);
  const [support, setSupport] = useState<FaceSupport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [faceEnrolled, setFaceEnrolled] = useState<boolean | null>(null);
  const [camera, setCamera] = useState(false);

  const refresh = () => listFaceDevices().then(setDevices).catch(() => setDevices(null));
  useEffect(() => {
    refresh();
    apiFaceStatus().then(setFaceEnrolled).catch(() => setFaceEnrolled(null));
    checkFaceSupport().then(setSupport);
  }, []);

  if (devices === null) return null;

  const add = async () => {
    setError('');
    setBusy(true);
    try {
      await enrollFace();
      await refresh();
      onNotify('เปิดใช้การสแกนหน้าบนอุปกรณ์นี้แล้ว');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (device: FaceDevice) => {
    if (!window.confirm(`ปิดการสแกนหน้าบน “${device.label}” ใช่ไหม? อุปกรณ์นี้จะต้องเข้าสู่ระบบด้วยรหัสผ่าน`)) return;
    try {
      await removeFaceDevice(device.id);
      await refresh();
      onNotify('ปิดการสแกนหน้าเรียบร้อย');
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const removeCamera = async () => {
    if (!window.confirm('ลบข้อมูลใบหน้าที่ลงทะเบียนไว้ใช่ไหม? จะสแกนหน้าด้วยกล้องเข้าสู่ระบบไม่ได้จนกว่าจะลงทะเบียนใหม่')) return;
    try {
      await apiFaceDelete();
      setFaceEnrolled(false);
      onNotify('ลบข้อมูลใบหน้าเรียบร้อย');
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <section className="panel face-settings">
      <div className="panel-header">
        <div><p className="section-kicker">ความปลอดภัย</p><h3>เข้าสู่ระบบด้วยการสแกนหน้า</h3></div>
        <div className="settings-icon"><ScanFace size={20} /></div>
      </div>
      <p className="muted">เข้าสู่ระบบโดยไม่ต้องพิมพ์รหัสผ่าน เลือกได้ 2 วิธี</p>
      <div className="face-devices">
        <div>
          <Camera size={18} />
          <div><strong>สแกนหน้าด้วยกล้อง</strong><span>{faceEnrolled ? 'ลงทะเบียนใบหน้าแล้ว (เก็บเฉพาะค่าตัวเลข ไม่เก็บรูป)' : 'ยังไม่ได้ลงทะเบียน'}</span></div>
          {faceEnrolled && <button type="button" className="icon-button danger" onClick={removeCamera} aria-label="ลบข้อมูลใบหน้า"><Trash2 size={15} /></button>}
        </div>
      </div>
      <button type="button" className="outline-button" onClick={() => setCamera(true)} disabled={!canUseCamera()}><Camera size={17} />{faceEnrolled ? 'สแกนใบหน้าใหม่ด้วยกล้อง' : 'ลงทะเบียนใบหน้าด้วยกล้อง'}</button>
      {!canUseCamera() && <p className="muted">ใช้กล้องไม่ได้: ต้องเปิดเว็บผ่าน https หรือ http://localhost</p>}
      {camera && (
        <FaceCameraModal
          mode="enroll"
          onClose={() => setCamera(false)}
          onCapture={async (descriptors) => { await apiFaceEnroll(descriptors); setFaceEnrolled(true); setCamera(false); onNotify('ลงทะเบียนใบหน้าเรียบร้อย'); }}
        />
      )}
      <p className="muted face-settings__sub">Face ID / Windows Hello (passkey) ใช้ระบบยืนยันตัวตนของเครื่อง</p>
      {devices.length > 0 && (
        <div className="face-devices">
          {devices.map((device) => (
            <div key={device.id}>
              <ScanFace size={18} />
              <div><strong>{device.label}</strong><span>เปิดใช้เมื่อ {formatDate(device.createdAt)}</span></div>
              <button type="button" className="icon-button danger" onClick={() => remove(device)} aria-label={`ปิดการสแกนหน้าบน ${device.label}`}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="auth-error"><CircleAlert size={17} />{error}</div>}
      {support?.ok
        ? <button type="button" className="outline-button" onClick={add} disabled={busy}><ScanFace size={17} />{busy ? 'กำลังรอการสแกน...' : 'เปิดใช้บนอุปกรณ์นี้'}</button>
        : support && <p className="muted">เปิดใช้บนอุปกรณ์นี้ไม่ได้: {support.reason}</p>}
    </section>
  );
}