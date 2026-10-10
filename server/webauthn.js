// สแกนหน้าเพื่อเข้าสู่ระบบ (WebAuthn / Passkey)
// เบราว์เซอร์ให้อุปกรณ์ยืนยันตัวตนด้วย Face ID / Windows Hello / ปลดล็อกด้วยใบหน้า แล้วส่งมาเฉพาะ "ลายเซ็น"
// เซิร์ฟเวอร์เก็บแค่ public key ของอุปกรณ์ ไม่เคยได้รับหรือเก็บภาพ/ข้อมูลใบหน้า
// ไม่ต้องติดตั้งแพ็กเกจเพิ่ม: ใช้ node:crypto ในตัว
import crypto from 'node:crypto';

const RP_NAME = 'BahtFlow';
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 2000;
const MAX_DEVICES_PER_USER = 5;

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified (สแกนหน้า/นิ้ว/PIN ของเครื่องสำเร็จ)
const FLAG_AT = 0x40; // มีข้อมูล credential แนบมา

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (value) => Buffer.from(String(value ?? ''), 'base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const fail = (status, message) => Object.assign(new Error(message), { status });

/* ---------- CBOR แบบย่อ (พอสำหรับ attestationObject / COSE key) ---------- */
function readCbor(buf, start, depth = 0) {
  if (depth > 8 || start >= buf.length) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
  let pos = start;
  const initial = buf[pos++];
  const major = initial >> 5;
  const info = initial & 31;
  if (major === 7) {
    if (info === 20) return [false, pos];
    if (info === 21) return [true, pos];
    if (info === 22 || info === 23) return [null, pos];
    throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
  }
  let arg;
  if (info < 24) arg = info;
  else if (info === 24) { arg = buf.readUInt8(pos); pos += 1; }
  else if (info === 25) { arg = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { arg = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) { arg = Number(buf.readBigUInt64BE(pos)); pos += 8; }
  else throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
  if (major === 0) return [arg, pos];
  if (major === 1) return [-1 - arg, pos];
  if (major === 2 || major === 3) {
    if (pos + arg > buf.length) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
    const slice = buf.subarray(pos, pos + arg);
    return [major === 2 ? Buffer.from(slice) : slice.toString('utf-8'), pos + arg];
  }
  if (arg > buf.length) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
  if (major === 4) {
    const items = [];
    for (let i = 0; i < arg; i += 1) { const [value, next] = readCbor(buf, pos, depth + 1); items.push(value); pos = next; }
    return [items, pos];
  }
  if (major === 5) {
    const map = new Map();
    for (let i = 0; i < arg; i += 1) {
      const [key, afterKey] = readCbor(buf, pos, depth + 1);
      const [value, afterValue] = readCbor(buf, afterKey, depth + 1);
      map.set(key, value);
      pos = afterValue;
    }
    return [map, pos];
  }
  throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
}

/* ---------- authenticator data ---------- */
function parseAuthData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
  const parsed = {
    rpIdHash: authData.subarray(0, 32),
    flags: authData[32],
    counter: authData.readUInt32BE(33),
    credentialId: null,
    cose: null,
  };
  if (parsed.flags & FLAG_AT) {
    if (authData.length < 55) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
    const idLength = authData.readUInt16BE(53);
    if (55 + idLength > authData.length) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
    parsed.credentialId = authData.subarray(55, 55 + idLength);
    [parsed.cose] = readCbor(authData, 55 + idLength);
  }
  return parsed;
}

// COSE key -> JWK (รองรับ ES256 = -7 และ RS256 = -257 ซึ่งครอบคลุม Face ID / Windows Hello / Android)
function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw fail(400, 'ข้อมูลกุญแจจากอุปกรณ์ไม่ถูกต้อง');
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw fail(400, 'ข้อมูลกุญแจจากอุปกรณ์ไม่ถูกต้อง');
    jwk = { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) };
  } else if (kty === 3 && alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw fail(400, 'ข้อมูลกุญแจจากอุปกรณ์ไม่ถูกต้อง');
    jwk = { kty: 'RSA', n: b64u(n), e: b64u(e) };
  } else {
    throw fail(400, 'อุปกรณ์นี้ใช้รูปแบบกุญแจที่ระบบยังไม่รองรับ');
  }
  try { crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw fail(400, 'ข้อมูลกุญแจจากอุปกรณ์ไม่ถูกต้อง'); }
  return { jwk, alg };
}

function verifySignature(jwk, alg, data, signature) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (alg === -7) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
  if (alg === -257) return crypto.verify('sha256', data, key, signature);
  return false;
}

/* ---------- origin / rpId ---------- */
// ค่า origin ต้องตรงกับที่เบราว์เซอร์ใช้จริง (เช่น http://localhost:3000 หรือ https://xxx.trycloudflare.com)
// ตั้งค่าตายตัวได้ด้วย WEBAUTHN_ORIGIN=https://โดเมนของคุณ
const expectedOrigin = (req) => {
  if (process.env.WEBAUTHN_ORIGIN) return process.env.WEBAUTHN_ORIGIN.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
};

const checkClientData = (clientDataJSON, type, challenge, origin) => {
  let data;
  try { data = JSON.parse(clientDataJSON.toString('utf-8')); } catch { throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง'); }
  if (data.type !== type || data.challenge !== challenge || data.origin !== origin || data.crossOrigin === true) {
    throw fail(400, 'ตรวจสอบคำขอไม่ผ่าน กรุณาลองใหม่อีกครั้ง');
  }
};

const checkAuthData = (parsed, rpId) => {
  if (!parsed.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw fail(400, 'ที่อยู่เว็บไม่ตรงกับที่ลงทะเบียนไว้');
  if (!(parsed.flags & FLAG_UP) || !(parsed.flags & FLAG_UV)) throw fail(400, 'อุปกรณ์ยังไม่ได้ยืนยันตัวตนด้วยการสแกนหน้า');
};

/* ---------- routes ---------- */
export function createWebAuthnRoutes({ db, currentUser, send, readJson, startSession, lockedFor, recordFailure, failures }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key TEXT NOT NULL,
      alg INTEGER NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);
  `);

  const q = {
    byId: db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?'),
    byUser: db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at'),
    insert: db.prepare('INSERT INTO webauthn_credentials (id, user_id, public_key, alg, counter, label) VALUES (?, ?, ?, ?, ?, ?)'),
    touch: db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?"),
    remove: db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
  };

  // challenge ใช้ได้ครั้งเดียว หมดอายุใน 5 นาที
  const challenges = new Map();
  const putChallenge = (entry) => {
    const now = Date.now();
    for (const [key, value] of challenges) if (value.expires <= now) challenges.delete(key);
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
    const id = b64u(crypto.randomBytes(16));
    const challenge = b64u(crypto.randomBytes(32));
    challenges.set(id, { ...entry, challenge, expires: now + CHALLENGE_TTL_MS });
    return { id, challenge };
  };
  const takeChallenge = (id, kind, userId = null) => {
    const entry = challenges.get(String(id ?? ''));
    challenges.delete(String(id ?? ''));
    if (!entry || entry.expires <= Date.now() || entry.kind !== kind || entry.userId !== userId) {
      throw fail(400, 'คำขอหมดอายุแล้ว กรุณาลองใหม่อีกครั้ง');
    }
    return entry;
  };

  const requireUser = (req) => {
    const user = currentUser(req);
    if (!user) throw fail(401, 'ยังไม่ได้เข้าสู่ระบบ');
    return user;
  };

  return {
    // 1) เริ่มลงทะเบียนอุปกรณ์ (ต้องล็อกอินอยู่ เช่น เพิ่งสมัครเสร็จ)
    'POST /api/webauthn/register/options': async (req, res) => {
      const user = requireUser(req);
      const existing = q.byUser.all(user.id);
      if (existing.length >= MAX_DEVICES_PER_USER) throw fail(400, `เปิดใช้การสแกนหน้าได้สูงสุด ${MAX_DEVICES_PER_USER} อุปกรณ์ ลบอุปกรณ์เดิมออกก่อน`);
      const rpId = new URL(expectedOrigin(req)).hostname;
      const { id, challenge } = putChallenge({ kind: 'register', userId: user.id });
      return send(res, 200, {
        challengeId: id,
        options: {
          rp: { name: RP_NAME, id: rpId },
          user: { id: b64u(Buffer.from(`bf:${user.id}`)), name: user.username, displayName: user.display_name },
          challenge,
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          excludeCredentials: existing.map((row) => ({ type: 'public-key', id: row.id })),
          timeout: 60_000,
          attestation: 'none',
        },
      });
    },

    // 2) ตรวจผลลงทะเบียน แล้วเก็บ public key
    'POST /api/webauthn/register/verify': async (req, res) => {
      const user = requireUser(req);
      const body = await readJson(req);
      const entry = takeChallenge(body.challengeId, 'register', user.id);
      const origin = expectedOrigin(req);
      const rpId = new URL(origin).hostname;
      const response = body.credential?.response ?? {};

      const clientDataJSON = fromB64u(response.clientDataJSON);
      checkClientData(clientDataJSON, 'webauthn.create', entry.challenge, origin);

      const [attestation] = readCbor(fromB64u(response.attestationObject), 0);
      const authData = attestation instanceof Map ? attestation.get('authData') : null;
      const parsed = parseAuthData(authData);
      checkAuthData(parsed, rpId);
      if (!parsed.credentialId || !parsed.cose) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');

      const credentialId = b64u(parsed.credentialId);
      if (body.credential?.id && body.credential.id !== credentialId) throw fail(400, 'ข้อมูลจากอุปกรณ์ไม่ถูกต้อง');
      if (q.byId.get(credentialId)) throw fail(409, 'อุปกรณ์นี้ถูกลงทะเบียนไว้แล้ว');
      if (q.byUser.all(user.id).length >= MAX_DEVICES_PER_USER) throw fail(400, `เปิดใช้การสแกนหน้าได้สูงสุด ${MAX_DEVICES_PER_USER} อุปกรณ์`);

      const { jwk, alg } = coseToJwk(parsed.cose);
      const label = String(body.label ?? '').trim().slice(0, 60) || 'อุปกรณ์ของฉัน';
      q.insert.run(credentialId, user.id, JSON.stringify(jwk), alg, parsed.counter, label);
      return send(res, 201, { ok: true });
    },

    // 3) เริ่มเข้าสู่ระบบด้วยการสแกนหน้า (ไม่ต้องกรอก username: ใช้ discoverable credential)
    'POST /api/webauthn/login/options': async (req, res) => {
      const rpId = new URL(expectedOrigin(req)).hostname;
      const { id, challenge } = putChallenge({ kind: 'login', userId: null });
      return send(res, 200, {
        challengeId: id,
        options: { challenge, rpId, timeout: 60_000, userVerification: 'required', allowCredentials: [] },
      });
    },

    // 4) ตรวจลายเซ็น แล้วออก session เหมือนการล็อกอินด้วยรหัสผ่าน
    'POST /api/webauthn/login/verify': async (req, res) => {
      const body = await readJson(req);
      const entry = takeChallenge(body.challengeId, 'login');
      const origin = expectedOrigin(req);
      const rpId = new URL(origin).hostname;
      const credential = body.credential ?? {};
      const response = credential.response ?? {};
      const genericError = 'สแกนหน้าไม่สำเร็จ ลองใหม่อีกครั้ง หรือเข้าสู่ระบบด้วยรหัสผ่าน';

      const credentialId = String(credential.id ?? '');
      const row = q.byId.get(credentialId);
      const limitKey = `${req.socket.remoteAddress}|webauthn|${credentialId.slice(0, 40)}`;
      const wait = lockedFor(limitKey);
      if (wait) throw fail(429, `ลองผิดหลายครั้งเกินไป กรุณารอ ${wait} วินาที`);
      if (!row) throw fail(401, 'ยังไม่พบการสแกนหน้านี้ในระบบ กรุณาเข้าสู่ระบบด้วยรหัสผ่านแล้วเปิดใช้ในหน้าตั้งค่า');

      const clientDataJSON = fromB64u(response.clientDataJSON);
      const authData = fromB64u(response.authenticatorData);
      const signature = fromB64u(response.signature);

      let ok = false;
      try {
        checkClientData(clientDataJSON, 'webauthn.get', entry.challenge, origin);
        const parsed = parseAuthData(authData);
        checkAuthData(parsed, rpId);
        const signedData = Buffer.concat([authData, sha256(clientDataJSON)]);
        ok = verifySignature(JSON.parse(row.public_key), row.alg, signedData, signature);
        // ตัวนับต้องเพิ่มขึ้นเสมอ (ถ้าไม่ใช่ศูนย์) เพื่อกันกุญแจที่ถูกคัดลอก — passkey ที่ซิงก์ข้ามเครื่องจะส่ง 0 ตลอด ซึ่งยอมรับได้
        if (ok && (parsed.counter !== 0 || row.counter !== 0) && parsed.counter <= row.counter) ok = false;
        if (ok && response.userHandle) {
          if (!fromB64u(response.userHandle).equals(Buffer.from(`bf:${row.user_id}`))) ok = false;
        }
        if (ok) q.touch.run(parsed.counter, row.id);
      } catch {
        ok = false;
      }
      if (!ok) {
        recordFailure(limitKey);
        throw fail(401, genericError);
      }
      failures.delete(limitKey);
      const user = q.user.get(row.user_id);
      if (!user) throw fail(401, genericError);
      return startSession(req, res, 200, user);
    },

    // รายการอุปกรณ์ที่เปิดใช้สแกนหน้า (ใช้ในหน้าตั้งค่า)
    'GET /api/webauthn/credentials': async (req, res) => {
      const user = requireUser(req);
      const devices = q.byUser.all(user.id).map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
      return send(res, 200, { devices });
    },

    'POST /api/webauthn/credentials/delete': async (req, res) => {
      const user = requireUser(req);
      const body = await readJson(req);
      q.remove.run(String(body.id ?? ''), user.id);
      return send(res, 200, { ok: true });
    },
  };
}