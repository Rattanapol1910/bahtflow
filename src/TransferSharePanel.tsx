import { useEffect, useState, type CSSProperties } from 'react';
import { CheckCircle2, CircleAlert, Users } from 'lucide-react';
import { ApiError } from './storage';
import { extractSlipRef } from './slipRef';
import type { SlipAnalysis } from './slip';
import type { TransactionType } from './types';
import { DuplicateTransferError, TRANSFER_EVENT, apiCreateTransfer, apiFindUsers, type FoundUser } from './transfers';

interface Props {
  result: SlipAnalysis;
  type: TransactionType;
  draft: { amount: number; date: string; categoryId: string };
  onDone: () => void;
}

const box: CSSProperties = { display: 'grid', gap: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface-soft)' };
const inputStyle: CSSProperties = { flex: 1, minWidth: 0 };

/** แสดงในหน้าอ่านสลิป: ถ้าอีกฝ่ายมีบัญชี BahtFlow จะบันทึกสลิปนี้เป็นรายการเดียวที่ทั้งสองฝ่ายเห็น */
export function TransferSharePanel({ result, type, draft, onDone }: Props) {
  const counterpartName = (type === 'expense' ? result.receiver : result.sender) ?? '';
  const [candidates, setCandidates] = useState<FoundUser[]>([]);
  const [selected, setSelected] = useState('');
  const [manual, setManual] = useState('');
  const [available, setAvailable] = useState(true); // false = ยังไม่ได้ล็อกอินกับเซิร์ฟเวอร์ (เช่นโหมดทดลอง) จึงซ่อนทั้งส่วน
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<{ canForce: boolean } | null>(null);
  const [done, setDone] = useState('');

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { setAvailable(false); return; }
    setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาด');
  };

  // ค้นหาอีกฝ่ายจากชื่อบนสลิปอัตโนมัติ
  useEffect(() => {
    let cancelled = false;
    setCandidates([]); setSelected(''); setSearched(false); setError(''); setDuplicate(null);
    if (!counterpartName) { setSearched(true); return; }
    apiFindUsers({ name: counterpartName })
      .then((users) => { if (cancelled) return; setCandidates(users); setSelected(users.length === 1 ? users[0].username : ''); setSearched(true); })
      .catch((err) => { if (!cancelled) { handleError(err); setSearched(true); } });
    return () => { cancelled = true; };
  }, [counterpartName]);

  const searchByUsername = async () => {
    const username = manual.trim();
    if (!username) return;
    setError('');
    try {
      const users = await apiFindUsers({ username });
      if (!users.length) { setError(`ไม่พบ Username "${username}"`); return; }
      setCandidates((current) => [...users, ...current.filter((item) => !users.some((user) => user.username === item.username))]);
      setSelected(users[0].username);
      setManual('');
    } catch (err) { handleError(err); }
  };

  const share = async (force = false) => {
    if (!selected || draft.amount <= 0) return;
    setBusy(true); setError(''); setDuplicate(null);
    try {
      const { transfer, restored } = await apiCreateTransfer({
        role: type === 'expense' ? 'sender' : 'receiver',
        counterpart: selected,
        amount: draft.amount,
        date: draft.date,
        ref: extractSlipRef(result.rawText),
        note: result.memo ?? '',
        categoryId: draft.categoryId,
        force,
      });
      window.dispatchEvent(new Event(TRANSFER_EVENT));
      setDone(restored ? 'นำรายการนี้กลับมาแสดงในบัญชีของคุณแล้ว' : `บันทึกแล้ว — ${transfer.counterpart} จะเห็นรายการนี้ในบัญชีของเขาด้วย`);
      window.setTimeout(onDone, 1600);
    } catch (err) {
      if (err instanceof DuplicateTransferError) { setDuplicate({ canForce: err.canForce }); setError(err.message); }
      else handleError(err);
    } finally { setBusy(false); }
  };

  if (!available) return null;

  if (done) return <div className="notice success"><CheckCircle2 size={17} />{done}</div>;

  const otherLabel = type === 'expense' ? 'ผู้รับเงิน' : 'ผู้โอน';

  return (
    <div style={box}>
      <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}><Users size={16} />{otherLabel}มีบัญชี BahtFlow ไหม?</strong>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        ถ้ามี สลิปนี้จะถูกบันทึกเป็นรายการเดียวที่ทั้งสองฝ่ายเห็น (ฝั่งคุณเป็น{type === 'expense' ? 'รายจ่าย' : 'รายรับ'} อีกฝ่ายเป็น{type === 'expense' ? 'รายรับ' : 'รายจ่าย'})
      </span>

      {candidates.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {candidates.map((user) => (
            <label key={user.username} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="radio" name="transfer-counterpart" checked={selected === user.username} onChange={() => setSelected(user.username)} />
              <span><strong>{user.displayName}</strong> <small style={{ color: 'var(--muted)' }}>@{user.username}</small></span>
            </label>
          ))}
        </div>
      )}
      {searched && candidates.length === 0 && counterpartName && (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>ไม่พบบัญชีที่ชื่อตรงกับ "{counterpartName}" — ถ้าอีกฝ่ายมีบัญชี ใส่ Username ของเขาด้านล่างได้เลย</span>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <input style={inputStyle} value={manual} onChange={(event) => setManual(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); searchByUsername(); } }} placeholder="พิมพ์ Username ของอีกฝ่าย" />
        <button type="button" className="secondary-button" onClick={searchByUsername} disabled={!manual.trim()}>ค้นหา</button>
      </div>

      {error && <div className="notice warning"><CircleAlert size={17} />{error}</div>}

      <button type="button" className="primary-button full" onClick={() => share(false)} disabled={busy || !selected || draft.amount <= 0}>
        <Users size={18} />บันทึกให้ทั้งสองฝ่าย
      </button>
      {duplicate?.canForce && (
        <button type="button" className="secondary-button full" onClick={() => share(true)} disabled={busy}>เป็นการโอนอีกครั้ง บันทึกซ้ำได้</button>
      )}
    </div>
  );
}