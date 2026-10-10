import { useEffect, useRef, useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import { canUseCamera, loadFaceApi } from './faceApi';

/* ค่าปรับความไวของการตรวจ (ถ้าสแกนยากหรือง่ายเกินไป ปรับตรงนี้) */
const TURN_THRESHOLD = 0.13;   // หันหน้าออกจากกึ่งกลางอย่างน้อยเท่านี้ถึงนับว่า "หันแล้ว"
const STRAIGHT_THRESHOLD = 0.06; // หันกลับมามองตรง
const CAPTURE_THRESHOLD = 0.09;  // ระหว่างเก็บภาพต้องมองตรงไม่เกินเท่านี้
const MIN_FACE_RATIO = 0.22;     // ใบหน้าต้องกว้างอย่างน้อยกี่ส่วนของภาพ (กันอยู่ไกลเกินไป)
const TIMEOUT_MS = 45_000;
const SAMPLES = { enroll: 3, login: 1 } as const;

type Phase = 'loading' | 'turn' | 'straight' | 'capture' | 'sending' | 'error';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * เปิดกล้อง → ให้หันหน้า 1 ครั้งแล้วกลับมามองตรง (กันการยกรูปนิ่ง ๆ มาจ่อกล้องแบบง่าย ๆ) → เก็บค่าลักษณะใบหน้า
 * หมายเหตุ: ขั้นตอนหันหน้านี้เป็นเพียงด่านกันง่าย ๆ ฝั่งเบราว์เซอร์ ไม่ใช่การพิสูจน์ว่าเป็นคนจริง
 */
export function FaceCameraModal({ mode, onClose, onCapture }: {
  mode: 'enroll' | 'login';
  onClose: () => void;
  onCapture: (descriptors: number[][]) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const total = SAMPLES[mode];
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('กำลังเปิดกล้องและโหลดโมเดล...');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    const stopCamera = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };

    const run = async () => {
      try {
        setError(''); setProgress(0); setPhase('loading'); setMessage('กำลังเปิดกล้องและโหลดโมเดล...');
        if (!canUseCamera()) throw new Error('เปิดกล้องไม่ได้ ต้องเปิดเว็บผ่าน https หรือ http://localhost');
        const [faceapi, media] = await Promise.all([
          loadFaceApi(),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
            .catch(() => { throw new Error('เปิดกล้องไม่ได้ กรุณาอนุญาตให้เว็บใช้กล้องในเบราว์เซอร์'); }),
        ]);
        stream = media;
        const video = videoRef.current;
        if (cancelled || !video) { stopCamera(); return; }
        video.srcObject = media;
        await video.play();

        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
        const started = Date.now();
        const samples: number[][] = [];
        let stage: 'turn' | 'straight' | 'capture' = 'turn';
        let stable = 0;
        let lastSample = 0;
        setPhase('turn'); setMessage('หันหน้าไปทางซ้ายหรือขวาช้า ๆ');

        while (!cancelled && samples.length < total) {
          if (Date.now() - started > TIMEOUT_MS) throw new Error('หมดเวลา กรุณาลองอีกครั้ง');
          await sleep(100);
          if (video.readyState < 2) continue;

          const detection = faceapi.detectAllFaces(video, options).withFaceLandmarks();
          const results = stage === 'capture' ? await detection.withFaceDescriptors() : await detection;
          if (cancelled) return;
          if (results.length === 0) { stable = 0; setMessage('ไม่พบใบหน้า ขยับให้ใบหน้าอยู่กลางภาพ'); continue; }
          if (results.length > 1) { stable = 0; setMessage('พบหลายใบหน้าในภาพ ให้เหลือเฉพาะคุณคนเดียว'); continue; }

          const face = results[0];
          const points = face.landmarks.positions;
          // 0 และ 16 = ขอบกรามซ้าย/ขวา, 30 = ปลายจมูก → อัตราส่วน ≈ 0.5 เมื่อมองตรง
          const ratio = (points[30].x - points[0].x) / (points[16].x - points[0].x);
          const off = Math.abs(ratio - 0.5);
          if (face.detection.box.width / video.videoWidth < MIN_FACE_RATIO) { stable = 0; setMessage('เข้าใกล้กล้องอีกนิด'); continue; }

          if (stage === 'turn') {
            if (off > TURN_THRESHOLD) { stage = 'straight'; setPhase('straight'); setMessage('ดีมาก! หันกลับมามองกล้องตรง ๆ'); }
            continue;
          }
          if (stage === 'straight') {
            stable = off < STRAIGHT_THRESHOLD ? stable + 1 : 0;
            if (stable >= 3) { stage = 'capture'; setPhase('capture'); setMessage('นิ่งไว้สักครู่...'); }
            continue;
          }
          if (off > CAPTURE_THRESHOLD) { setMessage('มองกล้องตรง ๆ และนิ่งไว้'); continue; }
          if (Date.now() - lastSample < 500) continue;
          samples.push(Array.from(face.descriptor as ArrayLike<number>));
          lastSample = Date.now();
          setProgress(samples.length);
        }
        if (cancelled) return;

        stopCamera();
        setPhase('sending'); setMessage('กำลังตรวจสอบ...');
        await onCaptureRef.current(samples);
      } catch (caught) {
        stopCamera();
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
        setPhase('error');
        setMessage('สแกนไม่สำเร็จ');
      }
    };
    run();
    return () => { cancelled = true; stopCamera(); };
  }, [mode, total, attempt]);

  const title = mode === 'enroll' ? 'ลงทะเบียนใบหน้า' : 'สแกนหน้าเพื่อเข้าสู่ระบบ';
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button className="modal-backdrop" aria-label="ปิด" onClick={onClose} />
      <div className="modal-card face-camera">
        <div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="ปิด"><X size={20} /></button></div>
        <div className="face-camera__frame" data-phase={phase}>
          <video ref={videoRef} playsInline muted autoPlay />
          <div className="face-camera__ring" />
        </div>
        <p className="face-camera__message" aria-live="polite">{message}{phase === 'capture' && total > 1 ? ` (${progress}/${total})` : ''}</p>
        {error && <div className="auth-error"><CircleAlert size={17} />{error}</div>}
        {phase === 'error' && <button type="button" className="primary-button" onClick={() => setAttempt((value) => value + 1)}>ลองอีกครั้ง</button>}
        <p className="face-camera__note">ภาพจากกล้องถูกประมวลผลในเครื่องของคุณและไม่ถูกบันทึก ระบบส่งเฉพาะค่าลักษณะใบหน้า (ชุดตัวเลข) ไปยังเซิร์ฟเวอร์</p>
      </div>
    </div>
  );
}