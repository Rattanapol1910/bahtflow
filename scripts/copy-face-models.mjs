// คัดลอกโมเดลสแกนหน้าจากแพ็กเกจ @vladmandic/face-api ไปที่ public/models
// ใช้: node scripts/copy-face-models.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'node_modules', '@vladmandic', 'face-api', 'model');
const to = path.join(root, 'public', 'models');
const needed = ['tiny_face_detector_model', 'face_landmark_68_model', 'face_recognition_model'];

if (!fs.existsSync(from)) {
  console.error('ไม่พบ node_modules/@vladmandic/face-api/model — รัน pnpm add @vladmandic/face-api ก่อน');
  process.exit(1);
}
fs.mkdirSync(to, { recursive: true });
fs.cpSync(from, to, { recursive: true });

const files = fs.readdirSync(to);
const missing = needed.filter((name) => !files.includes(`${name}-weights_manifest.json`));
if (missing.length) {
  console.error('คัดลอกแล้ว แต่ไม่พบไฟล์โมเดลที่ต้องใช้:', missing.map((n) => `${n}-weights_manifest.json`).join(', '));;
  console.error('ไฟล์ที่มีใน public/models:', files.join(', '));
  process.exit(1);
}
console.log(`คัดลอกโมเดลไปที่ public/models แล้ว (${files.length} ไฟล์) พร้อมใช้งาน`);
