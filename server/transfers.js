// BahtFlow: โอนเงินระหว่างผู้ใช้ — สลิปใบเดียว แสดงทั้งฝั่งผู้โอน (รายจ่าย) และฝั่งผู้รับ (รายรับ)
// ไฟล์นี้ถูกเรียกจาก server/index.js ผ่าน createTransferRoutes(...)

const compactName = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[\s.,:;|_\-'"()[\]{}*•·]+/g, '')
  .replace(/^(นางสาว|นาง|นาย|นส|ดช|ดญ|mister|miss|mrs|mr|ms)/, '');

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function createTransferRoutes({ db, currentUser, send, readJson }) {
  /* ---------- ตาราง ---------- */
  const columns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  if (!columns.includes('name_thai')) db.exec("ALTER TABLE users ADD COLUMN name_thai TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('name_english')) db.exec("ALTER TABLE users ADD COLUMN name_english TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      ref TEXT,
      note TEXT NOT NULL DEFAULT '',
      category_from TEXT,
      category_to TEXT,
      hidden_from INTEGER NOT NULL DEFAULT 0,
      hidden_to INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_user_id);
  `);

  const q = {
    allUsers: db.prepare('SELECT id, username, username_lower, display_name, name_thai, name_english FROM users'),
    userByLower: db.prepare('SELECT id, username, display_name FROM users WHERE username_lower = ?'),
    updateNames: db.prepare('UPDATE users SET name_thai = ?, name_english = ? WHERE id = ?'),
    byRef: db.prepare('SELECT * FROM transfers WHERE from_user_id = ? AND to_user_id = ? AND ref = ?'),
    bySame: db.prepare('SELECT * FROM transfers WHERE from_user_id = ? AND to_user_id = ? AND amount = ? AND date = ?'),
    insert: db.prepare('INSERT INTO transfers (from_user_id, to_user_id, uploaded_by, amount, date, ref, note, category_from, category_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    unhideFrom: db.prepare('UPDATE transfers SET hidden_from = 0 WHERE id = ?'),
    unhideTo: db.prepare('UPDATE transfers SET hidden_to = 0 WHERE id = ?'),
    hideFrom: db.prepare('UPDATE transfers SET hidden_from = 1 WHERE id = ? AND from_user_id = ?'),
    hideTo: db.prepare('UPDATE transfers SET hidden_to = 1 WHERE id = ? AND to_user_id = ?'),
    listForUser: db.prepare(`
      SELECT t.*, uf.display_name AS from_name, ut.display_name AS to_name
      FROM transfers t
      JOIN users uf ON uf.id = t.from_user_id
      JOIN users ut ON ut.id = t.to_user_id
      WHERE (t.from_user_id = ? AND t.hidden_from = 0) OR (t.to_user_id = ? AND t.hidden_to = 0)
      ORDER BY t.date DESC, t.id DESC
      LIMIT 2000
    `),
    oneWithNames: db.prepare(`
      SELECT t.*, uf.display_name AS from_name, ut.display_name AS to_name
      FROM transfers t
      JOIN users uf ON uf.id = t.from_user_id
      JOIN users ut ON ut.id = t.to_user_id
      WHERE t.id = ?
    `),
  };

  /* ---------- ตัวช่วย ---------- */
  const requireUser = (req, res) => {
    const user = currentUser(req);
    if (!user) send(res, 401, { error: 'ยังไม่ได้เข้าสู่ระบบ' });
    return user;
  };

  // แปลงแถวในฐานข้อมูลเป็นรายการ "ในมุมมองของผู้ใช้คนนี้": เป็นผู้โอน = รายจ่าย, เป็นผู้รับ = รายรับ
  const toClient = (row, me) => {
    const isFrom = row.from_user_id === me.id;
    return {
      id: row.id,
      type: isFrom ? 'expense' : 'income',
      amount: row.amount,
      date: row.date,
      note: row.note,
      counterpart: isFrom ? row.to_name : row.from_name,
      categoryId: (isFrom ? row.category_from : row.category_to) || null,
      uploadedByMe: row.uploaded_by === me.id,
    };
  };

  /* ---------- เส้นทาง API ---------- */
  return {
    // เก็บชื่อโปรไฟล์ไว้ที่เซิร์ฟเวอร์ เพื่อให้ค้นหาผู้ใช้จากชื่อบนสลิปได้
    'PUT /api/profile': async (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const nameThai = String(body.nameThai ?? '').trim().slice(0, 100);
      const nameEnglish = String(body.nameEnglish ?? '').trim().slice(0, 100);
      q.updateNames.run(nameThai, nameEnglish, user.id);
      return send(res, 200, { ok: true });
    },

    // ค้นหาบัญชีอีกฝ่าย: จากชื่อบนสลิป (name) หรือ username ที่พิมพ์เอง (username)
    'POST /api/users/find': async (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const username = String(body.username ?? '').trim().toLowerCase();
      const name = compactName(String(body.name ?? '').slice(0, 100));
      if (!username && name.length < 3) return send(res, 200, { users: [] });
      const users = q.allUsers.all().filter((candidate) => candidate.id !== user.id).filter((candidate) => {
        if (username) return candidate.username_lower === username;
        return [candidate.name_thai, candidate.name_english, candidate.display_name]
          .map(compactName)
          .some((value) => value.length >= 3 && (value.includes(name) || name.includes(value)));
      });
      return send(res, 200, { users: users.slice(0, 5).map((u) => ({ username: u.username, displayName: u.display_name })) });
    },

    'GET /api/transfers': async (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      const rows = q.listForUser.all(user.id, user.id);
      return send(res, 200, { transfers: rows.map((row) => toClient(row, user)) });
    },

    // สร้างรายการโอน 1 รายการ ที่ทั้งสองฝ่ายเห็น
    'POST /api/transfers': async (req, res) => {
      const me = requireUser(req, res);
      if (!me) return;
      const body = await readJson(req);

      const role = body.role === 'sender' || body.role === 'receiver' ? body.role : null;
      const other = q.userByLower.get(String(body.counterpart ?? '').trim().toLowerCase());
      const amount = Math.round(Number(body.amount) * 100) / 100;
      const date = String(body.date ?? '');
      const ref = String(body.ref ?? '').trim().slice(0, 64) || null;
      const note = String(body.note ?? '').trim().slice(0, 200);
      const categoryId = String(body.categoryId ?? '').trim().slice(0, 60) || null;

      if (!role) return send(res, 400, { error: 'ต้องระบุว่าคุณเป็นผู้โอนหรือผู้รับ' });
      if (!other) return send(res, 404, { error: 'ไม่พบบัญชีของอีกฝ่าย' });
      if (other.id === me.id) return send(res, 400, { error: 'ผู้โอนและผู้รับต้องเป็นคนละบัญชี' });
      if (!Number.isFinite(amount) || amount <= 0 || amount >= 10_000_000) return send(res, 400, { error: 'จำนวนเงินไม่ถูกต้อง' });
      if (!validDate(date)) return send(res, 400, { error: 'วันที่ไม่ถูกต้อง' });

      const iAmSender = role === 'sender';
      const fromId = iAmSender ? me.id : other.id;
      const toId = iAmSender ? other.id : me.id;

      // กันบันทึกซ้ำ: เลขอ้างอิงเดียวกัน = สลิปเดียวกันแน่นอน, ส่วนยอด+วันที่เดียวกันอนุญาตให้ยืนยันซ้ำได้ (force)
      const sameRef = ref ? q.byRef.get(fromId, toId, ref) : undefined;
      const sameAmount = q.bySame.get(fromId, toId, amount, date);
      const existing = sameRef ?? (body.force === true ? undefined : sameAmount);
      if (existing) {
        const mine = iAmSender ? existing.hidden_from : existing.hidden_to;
        if (mine) {
          // เคยลบออกจากฝั่งตัวเอง แล้วอัปโหลดอีก = เอากลับมาแสดง
          (iAmSender ? q.unhideFrom : q.unhideTo).run(existing.id);
          return send(res, 200, { restored: true, transfer: toClient(q.oneWithNames.get(existing.id), me) });
        }
        return send(res, 409, { error: 'สลิปนี้ถูกบันทึกไว้แล้ว (อาจเป็นอีกฝ่ายที่อัปโหลดไว้)', duplicate: true, canForce: !sameRef });
      }

      const result = q.insert.run(
        fromId, toId, me.id, amount, date, ref, note,
        iAmSender ? categoryId : null,
        iAmSender ? null : categoryId,
      );
      const row = q.oneWithNames.get(Number(result.lastInsertRowid));
      return send(res, 201, { transfer: toClient(row, me) });
    },

    // "ลบ" = ซ่อนจากบัญชีของตัวเองเท่านั้น อีกฝ่ายยังเห็นรายการของเขาอยู่
    'POST /api/transfers/hide': async (req, res) => {
      const me = requireUser(req, res);
      if (!me) return;
      const body = await readJson(req);
      const id = Number(body.id);
      if (!Number.isInteger(id)) return send(res, 400, { error: 'รหัสรายการไม่ถูกต้อง' });
      const changes = Number(q.hideFrom.run(id, me.id).changes) + Number(q.hideTo.run(id, me.id).changes);
      return changes ? send(res, 200, { ok: true }) : send(res, 404, { error: 'ไม่พบรายการนี้' });
    },
  };
}