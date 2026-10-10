/** ดึง "เลขที่รายการ / รหัสอ้างอิง" จากข้อความ OCR ของสลิป ใช้กันการบันทึกสลิปใบเดียวกันซ้ำ */
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const normalizeDigits = (value: string) => value.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));

const REF_LABEL = /(เลขที่รายการ|รหัสอ้างอิง|หมายเลขอ้างอิง|เลขอ้างอิง|transaction\s*(?:id|no)|reference(?:\s*(?:no|number|id))?|ref(?:\.|\s*no\.?|\s*id)?)\s*[:：]?/i;
const REF_VALUE = /[A-Za-z0-9]{8,40}/;

export function extractSlipRef(text: string): string | undefined {
  const lines = normalizeDigits(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const label = REF_LABEL.exec(lines[i]);
    if (!label) continue;
    const afterLabel = lines[i].slice(label.index + label[0].length);
    // เลขอ้างอิงอาจอยู่บรรทัดเดียวกับป้าย หรือบรรทัดถัดไป
    for (const candidate of [afterLabel, lines[i + 1] ?? '']) {
      const match = REF_VALUE.exec(candidate.replace(/\s+/g, ''));
      if (match && /\d/.test(match[0])) return match[0].toUpperCase();
    }
  }
  return undefined;
}