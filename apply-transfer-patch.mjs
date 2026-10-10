// รันครั้งเดียวที่โฟลเดอร์โปรเจกต์:  node apply-transfer-patch.mjs
// แก้ server/index.js และ src/App.tsx เพื่อเปิดใช้ฟังก์ชัน "สลิปเดียว แสดงทั้งผู้โอนและผู้รับ"
// ถ้าหาจุดที่ต้องแก้ไม่เจอ สคริปต์จะหยุดโดยไม่แก้ไฟล์ใดเลย
import fs from 'node:fs';

const edits = {
  'server/index.js': [
    {
      find: "import { DatabaseSync } from 'node:sqlite';",
      replace: "import { DatabaseSync } from 'node:sqlite';\nimport { createTransferRoutes } from './transfers.js';",
    },
    {
      find: 'const server = http.createServer(',
      replace: 'Object.assign(routes, createTransferRoutes({ db, currentUser, send, readJson }));\n\nconst server = http.createServer(',
    },
  ],
  'src/App.tsx': [
    {
      find: "import { analyzeSlip, buildSlipNote, suggestCategoryId, type SlipAnalysis, type SlipConfidence } from './slip';",
      replace: "import { analyzeSlip, buildSlipNote, suggestCategoryId, type SlipAnalysis, type SlipConfidence } from './slip';\nimport { isTransferId, useTransfers } from './transfers';\nimport { TransferSharePanel } from './TransferSharePanel';",
    },
    {
      find: 'const [viewDate, setViewDate] = useState(() => new Date());',
      replace: "const [viewDate, setViewDate] = useState(() => new Date());\n  // รายการโอนระหว่างผู้ใช้ (จากเซิร์ฟเวอร์) นับรวมกับรายการในเครื่องทุกหน้าจอ\n  const { transfers, hide: hideTransfer } = useTransfers(session, data.profile, data.categories);\n  const allTransactions = useMemo(() => [...data.transactions, ...transfers], [data.transactions, transfers]);\n  const viewData = useMemo(() => ({ ...data, transactions: allTransactions }), [data, allTransactions]);",
    },
    {
      find: 'const totals = useMemo(() => calculateTotals(data.transactions), [data.transactions]);',
      replace: 'const totals = useMemo(() => calculateTotals(allTransactions), [allTransactions]);',
    },
    {
      find: 'const viewTotals = useMemo(() => calculateTotals(data.transactions, viewDate), [data.transactions, viewDate]);',
      replace: 'const viewTotals = useMemo(() => calculateTotals(allTransactions, viewDate), [allTransactions, viewDate]);',
    },
    {
      find: 'const previousTotals = calculateTotals(data.transactions);',
      replace: 'const previousTotals = calculateTotals(allTransactions);',
    },
    {
      find: 'const updatedTotals = calculateTotals(transactions);',
      replace: 'const updatedTotals = calculateTotals([...transactions, ...transfers]);',
    },
    {
      find: 'const deleteTransaction = (id: string) => {',
      replace: "const deleteTransaction = (id: string) => {\n    if (isTransferId(id)) {\n      if (!window.confirm('ลบรายการโอนนี้ออกจากบัญชีของคุณใช่ไหม? (อีกฝ่ายยังเห็นรายการของเขาอยู่)')) return;\n      hideTransfer(id).then(() => notify('ลบรายการเรียบร้อย'), () => notify('ลบไม่สำเร็จ ลองใหม่อีกครั้ง', 'warning'));\n      return;\n    }",
    },
    {
      find: 'const openAdd = (prefill?: Partial<TransactionDraft>) =>',
      replace: "const editTransaction = (transaction: Transaction) => {\n    if (isTransferId(transaction.id)) { notify('รายการโอนระหว่างผู้ใช้แก้ไขไม่ได้ (ลบออกจากบัญชีของคุณได้)', 'warning'); return; }\n    setTransactionModal({ open: true, transaction });\n  };\n  const openAdd = (prefill?: Partial<TransactionDraft>) =>",
    },
    { find: '<Dashboard data={data} ', replace: '<Dashboard data={viewData} ' },
    {
      find: '<TransactionsScreen data={data} onEdit={(transaction) => setTransactionModal({ open: true, transaction })}',
      replace: '<TransactionsScreen data={viewData} onEdit={editTransaction}',
    },
    { find: '<SummaryScreen data={data} ', replace: '<SummaryScreen data={viewData} ' },
    {
      find: '<div className="slip-actions">',
      replace: '<TransferSharePanel result={result} type={type} draft={draft} onDone={onClose} />\n              <div className="slip-actions">',
    },
  ],
};

const loaded = [];
for (const [file, list] of Object.entries(edits)) {
  if (!fs.existsSync(file)) { console.error(`ไม่พบไฟล์ ${file} — ต้องรันคำสั่งนี้ในโฟลเดอร์โปรเจกต์ (ที่มี package.json)`); process.exit(1); }
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.replace(/\r\n/g, '\n');
  let applied = 0;
  for (const { find, replace } of list) {
    if (text.includes(replace)) continue; // เคยแก้จุดนี้แล้ว
    const count = text.split(find).length - 1;
    if (count !== 1) { console.error(`หยุดทำงาน: ใน ${file} พบข้อความที่ต้องแก้ ${count} จุด (ควรเป็น 1)\n  ${find.slice(0, 90)}\nยังไม่มีไฟล์ไหนถูกแก้ไข`); process.exit(1); }
    text = text.replace(find, () => replace);
    applied += 1;
  }
  loaded.push({ file, text: text.replace(/\n/g, eol), applied });
}
for (const { file, text, applied } of loaded) {
  if (applied) fs.writeFileSync(file, text, 'utf8');
  console.log(`${applied ? 'แก้แล้ว' : 'ข้าม (เคยแก้ไว้แล้ว)'}: ${file} (${applied} จุด)`);
}
console.log('เสร็จแล้ว');