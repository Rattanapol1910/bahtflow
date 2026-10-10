// สแกนหน้าด้วยกล้อง: เก็บ "ค่าลักษณะใบหน้า" (face descriptor 128 ตัวเลขจาก face-api) แล้วเทียบฝั่งเซิร์ฟเวอร์
// ไม่เก็บภาพถ่ายใบหน้า — เบราว์เซอร์ประมวลผลภาพในเครื่องแล้วส่งมาเฉพาะตัวเลข
// ข้อควรรู้: เซิร์ฟเวอร์ตรวจไม่ได้ว่าตัวเลขมาจากกล้องสดหรือรูปถ่าย (ดูหมายเหตุใน README ของการสแกนหน้า)
import { createHash } from 'node:crypto';

const DESCRIPTOR_SIZE = 128;
const MATCH_THRESHOLD = 0.45; // ระยะห่างแบบ Euclidean: คนเดียวกันมักต่ำกว่า ~0.4, คนละคนมักสูงกว่า ~0.6 (ยิ่งต่ำยิ่งเข้มงวด)
const SCAN_THRESHOLD = 0.38; // เกณฑ์ตอนไม่ระบุ username (1:N) เข้มกว่า 1:1
const SCAN_MARGIN = 0.08;    // บัญชีที่ใกล้เป็นอันดับสองต้องห่างจากอันดับหนึ่งอย่างน้อยเท่านี้ ไม่งั้นปฏิเสธ
const ENROLL_MIN = 3;
const ENROLL_MAX = 5;
const ENROLL_MAX_SPREAD = 0.5; // ตัวอย่างตอนลงทะเบียนต้องเป็นหน้าเดียวกัน (ระยะห่างระหว่างกันต้องไม่เกินค่านี้)

const fail = (status, message) => Object.assign(new Error(message), { status });

const parseDescriptor = (value) => {
  if (!Array.isArray(value) || value.length !== DESCRIPTOR_SIZE) throw fail(400, 'ข้อมูลใบหน้าไม่ถูกต้อง');
  const out = new Array(DESCRIPTOR_SIZE);
  for (let i = 0; i < DESCRIPTOR_SIZE; i += 1) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 5) throw fail(400, 'ข้อมูลใบหน้าไม่ถูกต้อง');
    out[i] = n;
  }
  return out;
};

const distance = (a, b) => {
  let sum = 0;
  for (let i = 0; i < DESCRIPTOR_SIZE; i += 1) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
};

export function createFaceRoutes({ db, currentUser, send, readJson, startSession, lockedFor, recordFailure, failures }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS face_templates (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      descriptors TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const q = {
    get: db.prepare('SELECT * FROM face_templates WHERE user_id = ?'),
    upsert: db.prepare("INSERT INTO face_templates (user_id, descriptors, created_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET descriptors = excluded.descriptors, created_at = excluded.created_at"),
    remove: db.prepare('DELETE FROM face_templates WHERE user_id = ?'),
    userByLower: db.prepare('SELECT * FROM users WHERE username_lower = ?'),
    all: db.prepare('SELECT user_id, descriptors FROM face_templates'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  };

  const requireUser = (req) => {
    const user = currentUser(req);
    if (!user) throw fail(401, 'ยังไม่ได้เข้าสู่ระบบ');
    return user;
  };

  return {
    'GET /api/face/status': async (req, res) => {
      const user = requireUser(req);
      return send(res, 200, { enrolled: Boolean(q.get.get(user.id)) });
    },

    // ลงทะเบียนใบหน้า (ต้องล็อกอินอยู่ เช่น เพิ่งสมัครเสร็จ) ส่งตัวอย่าง 3–5 ภาพ
    'POST /api/face/enroll': async (req, res) => {
      const user = requireUser(req);
      const body = await readJson(req);
      if (!Array.isArray(body.descriptors) || body.descriptors.length < ENROLL_MIN || body.descriptors.length > ENROLL_MAX) {
        throw fail(400, `ต้องส่งตัวอย่างใบหน้า ${ENROLL_MIN}–${ENROLL_MAX} ภาพ`);
      }
      const descriptors = body.descriptors.map(parseDescriptor);
      for (let i = 0; i < descriptors.length; i += 1) {
        for (let j = i + 1; j < descriptors.length; j += 1) {
          if (distance(descriptors[i], descriptors[j]) > ENROLL_MAX_SPREAD) throw fail(400, 'ภาพใบหน้าไม่นิ่งพอหรือมีหลายคน กรุณาสแกนใหม่');
        }
      }
      q.upsert.run(user.id, JSON.stringify(descriptors));
      return send(res, 201, { ok: true });
    },

    'POST /api/face/delete': async (req, res) => {
      const user = requireUser(req);
      q.remove.run(user.id);
      return send(res, 200, { ok: true });
    },

    // เข้าสู่ระบบ: ระบุ username = เทียบ 1:1 / ไม่ระบุ = ค้นหาจากทุกบัญชีที่ลงทะเบียนใบหน้า (1:N)
    'POST /api/face/login': async (req, res) => {
      const body = await readJson(req);
      const username = String(body.username ?? '').trim().toLowerCase();
      const descriptor = parseDescriptor(body.descriptor);
      const who = username ? createHash('sha256').update(username).digest('hex').slice(0, 16) : 'any';
      const limitKey = `${req.socket.remoteAddress}|face|${who}`;
      const wait = lockedFor(limitKey);
      if (wait) throw fail(429, `ลองผิดหลายครั้งเกินไป กรุณารอ ${wait} วินาที`);

      const bestOf = (row) => {
        try {
          return Math.min(...JSON.parse(row.descriptors).map((item) => distance(item, descriptor)));
        } catch {
          return Infinity;
        }
      };

      let user = null;
      if (username) {
        const candidate = q.userByLower.get(username);
        const row = candidate ? q.get.get(candidate.id) : null;
        if (row && bestOf(row) < MATCH_THRESHOLD) user = candidate;
      } else {
        const ranked = q.all.all()
          .map((row) => ({ userId: row.user_id, dist: bestOf(row) }))
          .sort((a, b) => a.dist - b.dist);
        const [first, second] = ranked;
        if (first && first.dist < SCAN_THRESHOLD && (!second || second.dist - first.dist >= SCAN_MARGIN)) {
          user = q.userById.get(first.userId) ?? null;
        }
      }

      if (!user) {
        recordFailure(limitKey);
        throw fail(401, 'สแกนหน้าไม่ตรงกับที่ลงทะเบียนไว้ หรือบัญชีนี้ยังไม่ได้เปิดใช้ ลองใหม่ หรือเข้าสู่ระบบด้วยรหัสผ่าน');
      }
      failures.delete(limitKey);
      return startSession(req, res, 200, user);
    },
  };
}