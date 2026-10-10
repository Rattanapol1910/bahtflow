// BahtFlow API server (ขั้นที่ 1: สมัคร / ล็อกอิน / ล็อกเอาต์)
// ไม่ต้องติดตั้งแพ็กเกจเพิ่ม: ใช้ node:http, node:sqlite, node:crypto ในตัว (ต้องใช้ Node 22.13 ขึ้นไป)
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createTransferRoutes } from './transfers.js';
import { createWebAuthnRoutes } from './webauthn.js';
import { createFaceRoutes } from './face.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const DB_FILE = process.env.DB_FILE ?? path.join(__dirname, 'data.db');
const SESSION_DAYS = 30;
const COOKIE_NAME = 'bf_session';
const MAX_BODY = 100 * 1024;

/* ---------- ฐานข้อมูล ---------- */
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);

const q = {
  userByLower: db.prepare('SELECT * FROM users WHERE username_lower = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (username, username_lower, display_name, password_hash) VALUES (?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

/* ---------- รหัสผ่าน / session ---------- */
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
};

const verifyPassword = (password, stored) => {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

// รหัสปลอมไว้เทียบเวลาเมื่อไม่พบ username (กันเดา username จากเวลาตอบ)
const DUMMY_HASH = hashPassword('bahtflow-dummy-password');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const createSession = (userId) => {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), userId, Date.now() + SESSION_DAYS * 86_400_000);
  return token;
};

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }),
);

const currentUser = (req) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const session = q.sessionByHash.get(sha256(token), Date.now());
  return session ? q.userById.get(session.user_id) ?? null : null;
};

const publicUser = (user) => ({ username: user.username, displayName: user.display_name });

/* ---------- กันเดารหัส (ในหน่วยความจำ) ---------- */
const failures = new Map(); // key -> { count, last, until }
const LIMIT = 5;
const LOCK_MS = 60_000;
const WINDOW_MS = 10 * 60_000;
const lockedFor = (key) => {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (entry.until > Date.now()) return Math.ceil((entry.until - Date.now()) / 1000);
  if (entry.until) failures.delete(key); // ล็อกหมดเวลาแล้ว เริ่มนับใหม่
  return 0;
};
const recordFailure = (key) => {
  const now = Date.now();
  const entry = failures.get(key);
  const count = entry && now - entry.last < WINDOW_MS ? entry.count + 1 : 1;
  failures.set(key, { count, last: now, until: count >= LIMIT ? now + LOCK_MS : 0 });
};

/* ---------- ตัวช่วย HTTP ---------- */
const send = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
};

const readJson = (req) => new Promise((resolve, reject) => {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    reject(Object.assign(new Error('ต้องส่งข้อมูลแบบ JSON'), { status: 415 }));
    return;
  }
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { reject(Object.assign(new Error('ข้อมูลใหญ่เกินไป'), { status: 413 })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
    catch { reject(Object.assign(new Error('รูปแบบข้อมูลไม่ถูกต้อง'), { status: 400 })); }
  });
  req.on('error', reject);
});

const sessionCookie = (req, token, maxAgeSeconds) => {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
};

// ออก session + คุกกี้ให้ผู้ใช้ (ใช้ร่วมกับการล็อกอินด้วยสแกนหน้า)
const startSession = (req, res, status, user) => {
  const token = createSession(user.id);
  return send(res, status, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
};

const clientKey = (req, username) => `${req.socket.remoteAddress}|${username.toLowerCase()}`;

/* ---------- เส้นทาง API ---------- */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

const routes = {
  'POST /api/register': async (req, res) => {
    const body = await readJson(req);
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const displayName = String(body.displayName ?? '').trim().slice(0, 80) || username;
    if (!USERNAME_RE.test(username)) return send(res, 400, { error: 'Username ต้องยาว 3–32 ตัว ใช้ได้เฉพาะ A-Z a-z 0-9 _ . -' });
    if (password.length < 6 || password.length > 200) return send(res, 400, { error: 'Password ต้องยาวอย่างน้อย 6 ตัวอักษร' });
    if (q.userByLower.get(username.toLowerCase())) return send(res, 409, { error: 'Username นี้ถูกใช้งานแล้ว' });
    let user;
    try {
      const result = q.insertUser.run(username, username.toLowerCase(), displayName, hashPassword(password));
      user = q.userById.get(Number(result.lastInsertRowid));
    } catch {
      return send(res, 409, { error: 'Username นี้ถูกใช้งานแล้ว' });
    }
    const token = createSession(user.id);
    return send(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  },

  'POST /api/login': async (req, res) => {
    const body = await readJson(req);
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const key = clientKey(req, username);
    const wait = lockedFor(key);
    if (wait) return send(res, 429, { error: `ลองผิดหลายครั้งเกินไป กรุณารอ ${wait} วินาที` });
    const user = q.userByLower.get(username.toLowerCase());
    const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && Boolean(user);
    if (!ok) {
      recordFailure(key);
      return send(res, 401, { error: 'Username หรือ Password ไม่ถูกต้อง' });
    }
    failures.delete(key);
    const token = createSession(user.id);
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  },

  'POST /api/logout': async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) q.deleteSession.run(sha256(token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  },

  'GET /api/me': async (req, res) => {
    const user = currentUser(req);
    return user ? send(res, 200, { user: publicUser(user) }) : send(res, 401, { error: 'ยังไม่ได้เข้าสู่ระบบ' });
  },
};

Object.assign(routes, createTransferRoutes({ db, currentUser, send, readJson }));
Object.assign(routes, createWebAuthnRoutes({ db, currentUser, send, readJson, startSession, lockedFor, recordFailure, failures }));
Object.assign(routes, createFaceRoutes({ db, currentUser, send, readJson, startSession, lockedFor, recordFailure, failures }));

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) return send(res, 404, { error: 'ไม่พบเส้นทางนี้' });
  try {
    await handler(req, res);
  } catch (error) {
    const status = error?.status ?? 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'เซิร์ฟเวอร์ขัดข้อง' : error.message });
  }
});

setInterval(() => q.purgeSessions.run(Date.now()), 3_600_000).unref();

// ฟังเฉพาะเครื่องตัวเอง: เว็บ (Vite :3000) จะ proxy /api มาที่นี่ จึงไม่เปิดพอร์ตนี้ออก LAN โดยตรง
server.listen(PORT, '127.0.0.1', () => console.log(`BahtFlow API พร้อมที่ http://127.0.0.1:${PORT}`));