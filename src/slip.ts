import type { Profile, TransactionType } from './types';

export type SlipConfidence = 'high' | 'medium' | 'low';

export interface SlipAnalysis {
  amount?: number;
  date?: string; // YYYY-MM-DD (ค.ศ.)
  bankName?: string;
  type: TransactionType;
  confidence: SlipConfidence;
  /** เหตุผลที่ระบบตัดสินว่าเป็นรายรับ/รายจ่าย (แสดงให้ผู้ใช้ตรวจสอบ) */
  reason: string;
  sender?: string;
  receiver?: string;
  memo?: string;
  /** true เมื่อผู้ใช้ยังไม่ได้ตั้งชื่อในโปรไฟล์ จึงเทียบชื่อกับสลิปไม่ได้ */
  profileMissing: boolean;
  rawText: string;
}

/* ---------- ตัวช่วยจัดข้อความ ---------- */

const normalizeDigits = (value: string) => value.replace(/[๐-๙]/g, (d) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)));

/** ตัดช่องว่างและเครื่องหมาย เพื่อให้เทียบข้อความไทยที่ OCR แทรกช่องว่างผิดตำแหน่งได้ */
const compact = (value: string) => normalizeDigits(value).toLowerCase().replace(/[\s.,:;|_\-'"()[\]{}*•·]+/g, '');

/* ---------- ยอดเงิน ---------- */

const FEE_LINE = /ค่าธรรมเนียม|ค่าบริการ|fee|charge/i;
const AMOUNT_LABEL = /จำนวนเงิน|จำนวน|ยอดเงิน|ยอดโอน|ยอดชำระ|ยอดรวม|รวมทั้งสิ้น|amount|total/i;
// ตัวเลขที่ไม่ติดกับวันที่/เวลา/เลขบัญชี
const NUMBER_RE = /(?<![\d.\/:-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d\/:]|\.\d)/g;
const DECIMAL_RE = /(?<![\d.\/:-])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d.\/:])/g;

const toAmount = (whole: string, decimals?: string) => Number(`${whole.replaceAll(',', '')}${decimals ? `.${decimals}` : ''}`);
const validAmount = (value: number) => Number.isFinite(value) && value > 0 && value < 10_000_000;

function extractAmount(lines: string[]): number | undefined {
  // 1) บรรทัดที่มีป้ายกำกับ "จำนวนเงิน/จำนวน/amount" (ตัดบรรทัดค่าธรรมเนียมออก) รวมบรรทัดถัดไปเผื่อ OCR แยกบรรทัด
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!AMOUNT_LABEL.test(line) || FEE_LINE.test(line)) continue;
    for (const candidate of [line, lines[i + 1] ?? '']) {
      if (FEE_LINE.test(candidate)) continue;
      for (const match of candidate.matchAll(NUMBER_RE)) {
        const value = toAmount(match[1], match[2]);
        if (validAmount(value)) return value;
      }
    }
  }
  // 2) ตัวเลขทศนิยม 2 ตำแหน่งที่ตามด้วยบาท/THB
  for (const line of lines) {
    if (FEE_LINE.test(line)) continue;
    for (const match of line.matchAll(/(?<![\d.\/:-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:บาท|thb|baht)/gi)) {
      const value = toAmount(match[1], match[2]);
      if (validAmount(value)) return value;
    }
  }
  // 3) ตัวเลขทศนิยม 2 ตำแหน่งตัวแรกที่ไม่ใช่ค่าธรรมเนียม
  for (const line of lines) {
    if (FEE_LINE.test(line)) continue;
    for (const match of line.matchAll(DECIMAL_RE)) {
      const value = toAmount(match[1], match[2]);
      if (validAmount(value)) return value;
    }
  }
  return undefined;
}

/* ---------- วันที่ ---------- */

const MONTH_ALTERNATIVES: string[] = (() => {
  const dot = '\\s*\\.?\\s*';
  const abbr = (a: string, b: string) => `${a}${dot}${b}${dot}`;
  return [
    `มกราคม|${abbr('ม', 'ค')}|january|jan`,
    `กุมภาพันธ์|${abbr('ก', 'พ')}|february|feb`,
    `มีนาคม|${abbr('มี', 'ค')}|march|mar`,
    `เมษายน|${abbr('เม', 'ย')}|april|apr`,
    `พฤษภาคม|${abbr('พ', 'ค')}|may`,
    `มิถุนายน|${abbr('มิ', 'ย')}|june|jun`,
    `กรกฎาคม|${abbr('ก', 'ค')}|july|jul`,
    `สิงหาคม|${abbr('ส', 'ค')}|august|aug`,
    `กันยายน|${abbr('ก', 'ย')}|september|sept|sep`,
    `ตุลาคม|${abbr('ต', 'ค')}|october|oct`,
    `พฤศจิกายน|${abbr('พ', 'ย')}|november|nov`,
    `ธันวาคม|${abbr('ธ', 'ค')}|december|dec`,
  ];
})();

const pad = (value: number) => String(value).padStart(2, '0');

/** แปลงปี พ.ศ./ค.ศ. (รวมปี 2 หลัก) ให้เป็น ค.ศ. โดยเลือกค่าที่ใกล้วันนี้ที่สุดและไม่อยู่ในอนาคตไกล */
function resolveYear(year: number, month: number, day: number, today: Date): number {
  if (year >= 2400) return year - 543;
  if (year >= 1900) return year;
  const candidates = [2000 + year, 1957 + year]; // ค.ศ. 20xx หรือ พ.ศ. 25xx
  const limit = today.getTime() + 2 * 24 * 3600 * 1000;
  const scored = candidates.map((candidate) => ({ candidate, time: new Date(candidate, month - 1, day, 12).getTime() }));
  const notFuture = scored.filter((item) => item.time <= limit);
  if (notFuture.length) return notFuture.sort((a, b) => b.time - a.time)[0].candidate;
  return scored.sort((a, b) => a.time - b.time)[0].candidate;
}

function buildDate(day: number, month: number, rawYear: number, today: Date): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const year = resolveYear(rawYear, month, day, today);
  const check = new Date(year, month - 1, day, 12);
  if (check.getMonth() !== month - 1) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function extractDate(text: string, today: Date): string | undefined {
  const source = normalizeDigits(text);
  // รูปแบบ "12 ม.ค. 69", "12 มกราคม 2569", "12 Jan 2026"
  let best: { index: number; date: string } | undefined;
  MONTH_ALTERNATIVES.forEach((alt, monthIndex) => {
    const regex = new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:${alt})\\s*(?:พ\\.?\\s*ศ\\.?\\s*)?(\\d{4}|\\d{2})(?!\\d)`, 'i');
    const match = regex.exec(source);
    if (!match) return;
    const date = buildDate(Number(match[1]), monthIndex + 1, Number(match[2]), today);
    if (date && (!best || match.index < best.index)) best = { index: match.index, date };
  });
  if (best) return best.date;
  // รูปแบบตัวเลข 12/01/2569, 12-01-69, 12.01.2026
  for (const match of source.matchAll(/(?<!\d)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})(?!\d)/g)) {
    const date = buildDate(Number(match[1]), Number(match[2]), Number(match[3]), today);
    if (date) return date;
  }
  return undefined;
}

/* ---------- ธนาคาร ---------- */

const BANKS: [string, RegExp][] = [
  ['KBank', /kbank|k\s*plus|kplus|กสิกร/i],
  ['SCB', /\bscb\b|ไทยพาณิชย์/i],
  ['Krungthai', /krungthai|krung\s*thai|กรุงไทย/i],
  ['Bangkok Bank', /bangkok\s*bank|bualuang|กรุงเทพ/i],
  ['ttb', /\bttb\b|ทีทีบี|ทหารไทย/i],
  ['Krungsri', /krungsri|kma\b|กรุงศรี/i],
  ['GSB', /\bgsb\b|mymo|ออมสิน/i],
  ['BAAC', /baac|ธ\.ก\.ส\.|เพื่อการเกษตร/i],
  ['UOB', /\buob\b|ยูโอบี/i],
  ['CIMB Thai', /cimb|ซีไอเอ็มบี/i],
  ['LH Bank', /lh\s*bank|แลนด์\s*แอนด์\s*เฮ้าส์/i],
  ['TrueMoney', /truemoney|ทรูมันนี่/i],
];

function extractBank(text: string): string | undefined {
  let best: { index: number; name: string } | undefined;
  for (const [name, regex] of BANKS) {
    const match = regex.exec(text);
    if (match && (!best || match.index < best.index)) best = { index: match.index, name };
  }
  return best?.name;
}

/* ---------- ผู้โอน / ผู้รับ ---------- */

const TITLE_RE = /^(นางสาว|นาง|นาย|นส|ดช|ดญ|mister|miss|mrs|mr|ms)/;
const PARTY_START_RE = /^(นางสาว|นาง|นาย|นส|ดช|ดญ|mister|miss|mrs|mr|ms|บจก|หจก|บริษัท|ร้าน|ห้าง|มูลนิธิ)/;
const FROM_MARKER_RE = /^(จาก|from|ผู้โอน|ผู้ส่ง|บัญชีต้นทาง)/;
const TO_MARKER_RE = /^(ไปยัง|ถึง|to|ผู้รับ|บัญชีปลายทาง)/;
const STOP_RE = /^(จำนวน|ยอด|amount|total|ค่าธรรมเนียม|fee|เลขที่รายการ|รหัสอ้างอิง|ref|memo|บันทึก|วันที่|date|หมายเหตุ|สแกน|qr)/;
const MARKER_STRIP_RE = /^\s*(จาก|from|ผู้โอน|ผู้ส่ง|บัญชีต้นทาง|ไปยัง|ถึง|to|ผู้รับเงิน|ผู้รับ|บัญชีปลายทาง)\s*[:：]?\s*/i;

interface Parties { from: string[]; to: string[]; viaMarkers: boolean }

function extractParties(lines: string[]): Parties {
  const blocks: Record<'from' | 'to', string[]> = { from: [], to: [] };
  let current: 'from' | 'to' | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const c = compact(trimmed);
    const isEnglishFrom = /^from\b/i.test(trimmed);
    const isEnglishTo = /^to\b/i.test(trimmed);
    const isFrom = isEnglishFrom || (!/^to\b/i.test(trimmed) && FROM_MARKER_RE.test(c) && !/^from/.test(c));
    const isTo = isEnglishTo || (TO_MARKER_RE.test(c) && !/^to/.test(c));
    if (isFrom || isTo) {
      current = isFrom ? 'from' : 'to';
      const rest = trimmed.replace(MARKER_STRIP_RE, '').trim();
      if (rest) blocks[current].push(rest);
      continue;
    }
    if (STOP_RE.test(c)) { current = null; continue; }
    if (current && blocks[current].length < 4) blocks[current].push(trimmed);
  }
  if (blocks.from.length || blocks.to.length) return { ...blocks, viaMarkers: true };

  // สลิปที่ไม่มีป้าย "จาก/ไปยัง" (เช่นแอปที่แสดงการ์ดผู้โอน แล้วตามด้วยการ์ดผู้รับ):
  // บรรทัดที่ขึ้นต้นด้วยคำนำหน้าชื่อ/บริษัทบรรทัดแรก = ผู้โอน, บรรทัดที่สอง = ผู้รับ
  const named = lines.map((line) => line.trim()).filter((line) => line && PARTY_START_RE.test(compact(line)));
  return { from: named[0] ? [named[0]] : [], to: named[1] ? [named[1]] : [], viaMarkers: false };
}

/** แยกชื่อในโปรไฟล์เป็นโทเค็น (เก็บทั้งแบบมี/ไม่มีคำนำหน้า เผื่อชื่อที่ขึ้นต้นเหมือนคำนำหน้า) */
function nameTokens(name: string): string[][] {
  const raw = name.trim().split(/\s+/).map(compact).filter(Boolean);
  const tokens: string[][] = [];
  raw.forEach((token, index) => {
    if (index === 0) {
      const stripped = token.replace(TITLE_RE, '');
      if (stripped === '') return; // โทเค็นแรกเป็นคำนำหน้าล้วน ๆ
      tokens.push(stripped === token ? [token] : [stripped, token]);
    } else tokens.push([token]);
  });
  return tokens.filter((group) => group.some((item) => item.length >= 2));
}

/** คืนค่าจำนวนโทเค็นชื่อที่พบในข้อความ (0 = ไม่ตรง) โดยบังคับให้ชื่อต้นต้องตรงก่อน */
function matchName(blockText: string, names: string[][][]): { score: number; firstLength: number } {
  let best = { score: 0, firstLength: 0 };
  for (const tokens of names) {
    if (!tokens.length) continue;
    const firstMatch = tokens[0].find((item) => item.length >= 2 && blockText.includes(item));
    if (!firstMatch) continue;
    const score = tokens.filter((group) => group.some((item) => item.length >= 2 && blockText.includes(item))).length;
    if (score > best.score) best = { score, firstLength: firstMatch.length };
  }
  return best;
}

/* ---------- คำบอกทิศทางเงิน ---------- */

const INCOME_KEYWORDS = /(?<!ผู้)รับเงิน|(?<!ผู้)รับโอน|เงินเข้า|เงินโอนเข้า|ฝากเงิน|deposit|received|refund|คืนเงิน|เงินคืน/;
const EXPENSE_KEYWORDS = /ชำระเงิน|ชำระค่า|ชำระบิล|จ่ายบิล|จ่ายเงิน|จ่ายค่า|ถอนเงิน|billpayment|payment|paid|withdraw|เติมเงิน|topup|ซื้อ/;

function extractMemo(lines: string[]): string | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(?:บันทึกช่วยจำ|บันทึก|memo|note|หมายเหตุ)\s*[:：]?\s*(.*)$/i.exec(lines[i]);
    if (!match) continue;
    const value = (match[1] || lines[i + 1] || '').trim();
    if (value && value.length <= 60) return value;
  }
  return undefined;
}

const partyLabel = (block: string[]) => block.find((line) => !/\d/.test(line) && line.trim().length >= 2)?.trim().slice(0, 40);

/* ---------- ตัวหลัก ---------- */

export function analyzeSlip(text: string, profile: Pick<Profile, 'nameThai' | 'nameEnglish'>, today = new Date()): SlipAnalysis {
  const lines = normalizeDigits(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const whole = compact(text);

  const amount = extractAmount(lines);
  const date = extractDate(text, today);
  const bankName = extractBank(text);
  const memo = extractMemo(lines);
  const parties = extractParties(lines);
  const sender = partyLabel(parties.from);
  const receiver = partyLabel(parties.to);

  const names = [profile.nameThai, profile.nameEnglish].filter((value) => value?.trim()).map(nameTokens).filter((tokens) => tokens.length);
  const profileMissing = names.length === 0;

  const base = { amount, date, bankName, sender, receiver, memo, profileMissing, rawText: text };

  // 1) เทียบชื่อผู้ใช้กับฝั่งผู้โอน/ผู้รับ — สัญญาณที่แม่นที่สุด
  const fromMatch = matchName(compact(parties.from.join(' ')), names);
  const toMatch = matchName(compact(parties.to.join(' ')), names);

  const incomeHit = INCOME_KEYWORDS.exec(whole)?.[0];
  const expenseHit = EXPENSE_KEYWORDS.exec(whole)?.[0];
  const keywordType: TransactionType | null = incomeHit && !expenseHit ? 'income' : expenseHit && !incomeHit ? 'expense' : null;
  const keywordText = keywordType === 'income' ? incomeHit : expenseHit;

  if (fromMatch.score > 0 && toMatch.score > 0) {
    return { ...base, type: 'expense', confidence: 'low', reason: 'พบชื่อของคุณทั้งฝั่งผู้โอนและผู้รับ (อาจเป็นการโอนระหว่างบัญชีตัวเอง) กรุณาเลือกประเภทเอง' };
  }
  if (toMatch.score > 0 || fromMatch.score > 0) {
    const type: TransactionType = toMatch.score > 0 ? 'income' : 'expense';
    const strong = Math.max(toMatch.score, fromMatch.score) >= 2 || Math.max(toMatch.firstLength, fromMatch.firstLength) >= 3;
    const side = type === 'income' ? 'ผู้รับเงิน จึงเป็นรายรับ' : 'ผู้โอน จึงเป็นรายจ่าย';
    if (keywordType && keywordType !== type) {
      return { ...base, type, confidence: 'medium', reason: `พบชื่อของคุณในฝั่ง${side} แต่สลิปมีคำว่า "${keywordText}" ที่สื่อความหมายตรงข้าม โปรดตรวจสอบ` };
    }
    return { ...base, type, confidence: strong ? 'high' : 'medium', reason: `พบชื่อของคุณในฝั่ง${side}` };
  }

  // 2) ไม่พบชื่อ — ใช้คำบอกทิศทางเงินในสลิป
  if (keywordType) {
    return { ...base, type: keywordType, confidence: 'medium', reason: `พบคำว่า "${keywordText}" ในสลิป จึงเป็น${keywordType === 'income' ? 'รายรับ' : 'รายจ่าย'}` };
  }

  // 3) ไม่มีหลักฐาน — สลิปส่วนใหญ่ที่ผู้ใช้เก็บไว้คือรายจ่าย
  const why = profileMissing
    ? 'ยังไม่ได้ตั้งชื่อในโปรไฟล์ และไม่พบคำบอกทิศทางเงินในสลิป'
    : parties.viaMarkers || parties.from.length || parties.to.length
      ? 'ชื่อในสลิปไม่ตรงกับชื่อในโปรไฟล์ของคุณ'
      : 'อ่านชื่อผู้โอน/ผู้รับจากสลิปไม่ได้';
  return { ...base, type: 'expense', confidence: 'low', reason: `${why} จึงตั้งเป็นรายจ่ายไว้ก่อน โปรดตรวจสอบ` };
}

/* ---------- หมายเหตุและหมวดหมู่ที่แนะนำ ---------- */

export function buildSlipNote(slip: SlipAnalysis, type: TransactionType): string {
  if (slip.memo) return slip.memo;
  if (type === 'expense' && slip.receiver) return `โอนให้ ${slip.receiver}`;
  if (type === 'income' && slip.sender) return `รับจาก ${slip.sender}`;
  return slip.bankName ? `สลิป ${slip.bankName}` : '';
}

const EXPENSE_HINTS: [string, RegExp][] = [
  ['bills', /ค่าไฟ|ค่าน้ำ|ค่าโทร|ค่าเน็ต|บิล|bill|\bais\b|\btrue\b|dtac|การไฟฟ้า|การประปา|กฟน|กฟภ|กปภ|\bmea\b|\bpea\b/i],
  ['food', /อาหาร|กาแฟ|ร้านข้าว|คาเฟ่|cafe|coffee|restaurant|food|lineman|grabfood/i],
  ['transport', /ทางด่วน|easypass|ค่ารถ|แท็กซี่|taxi|\bbts\b|\bmrt\b|น้ำมัน|ปตท|\bptt\b|bangchak|บางจาก|grab(?!food)/i],
  ['shopping', /shopee|lazada|ช้อป|7-?eleven|เซเว่น|โลตัส|lotus|big\s*c|tops|central|เซ็นทรัล/i],
  ['home', /ค่าเช่า|ค่าห้อง|rent|คอนโด|ผ่อนบ้าน|ค่าส่วนกลาง/i],
];
const INCOME_HINTS: [string, RegExp][] = [
  ['salary', /เงินเดือน|salary/i],
  ['bonus', /โบนัส|bonus/i],
  ['investment', /ดอกเบี้ย|ปันผล|interest|dividend/i],
  ['gift', /ของขวัญ|อั่งเปา|gift/i],
];

/** แนะนำ id หมวดหมู่ตั้งต้นจากคำในสลิป (คืน undefined ถ้าไม่มั่นใจ) */
export function suggestCategoryId(text: string, type: TransactionType): string | undefined {
  const hints = type === 'income' ? INCOME_HINTS : EXPENSE_HINTS;
  return hints.find(([, regex]) => regex.test(text))?.[0];
}