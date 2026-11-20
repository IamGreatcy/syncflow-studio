import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcDataDir = path.resolve(process.env.DATA_DIR || path.join(repoRoot, 'data'));
const outDir = path.join(repoRoot, 'cloud-bundle');
const outDataDir = path.join(outDir, 'data');

const syncflowDb = path.join(srcDataDir, 'syncflow.sqlite');
const legacyDb = path.join(srcDataDir, 'clipflow.sqlite');
const sourceDbPath = fs.existsSync(syncflowDb) ? syncflowDb : legacyDb;

if (!fs.existsSync(sourceDbPath)) {
  console.error(`Source database not found in ${srcDataDir}`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDataDir, { recursive: true });

// Snapshot live WAL database safely into one clean single-file SQLite database
const outDbPath = path.join(outDataDir, 'syncflow.sqlite');
const escapedTarget = outDbPath.replace(/'/g, "''");
const db = new DatabaseSync(sourceDbPath);
try {
  db.exec(`VACUUM INTO '${escapedTarget}';`);
} finally {
  db.close();
}

// Copy .master.key (needed to decrypt OAuth tokens, Gemini & R2 keys stored in SQLite)
const masterKeySrc = path.join(srcDataDir, '.master.key');
let masterKeyHex = '';
if (fs.existsSync(masterKeySrc)) {
  masterKeyHex = fs.readFileSync(masterKeySrc, 'utf8').trim();
  fs.copyFileSync(masterKeySrc, path.join(outDataDir, '.master.key'));
}

// Copy thumbnails / custom covers if present locally (videos stay safely on Cloudflare R2)
const thumbSrc = path.join(srcDataDir, 'thumbnails');
if (fs.existsSync(thumbSrc)) {
  fs.cpSync(thumbSrc, path.join(outDataDir, 'thumbnails'), { recursive: true });
}

fs.writeFileSync(
  path.join(outDir, 'cloud.env.template'),
  [
    '# วางค่าเหล่านี้ใน Environment Variables บน Cloud (Railway / Render / VPS .env)',
    'NODE_ENV=production',
    'HOST=0.0.0.0',
    'PORT=3001',
    'DATA_DIR=/app/data',
    '# ตั้งรหัสผ่านก่อนเปิดใช้งานบน Public Cloud เพื่อป้องกันคนนอกเข้าถึงหน้าจัดการ:',
    'STUDIO_PASSCODE=change-me-strong-passcode',
    '# เปลี่ยนเป็น URL จริงของ Cloud เช่น https://syncflow.up.railway.app:',
    'APP_BASE_URL=https://YOUR-CLOUD-DOMAIN',
    'WEB_BASE_URL=https://YOUR-CLOUD-DOMAIN',
    masterKeyHex
      ? `# Master key เดิมของคุณ (ใช้ถอดรหัส Token/API Keys ใน SQLite):`
      : '# ENCRYPTION_KEY=...',
    masterKeyHex ? `ENCRYPTION_KEY=${masterKeyHex}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n'),
  'utf8'
);

const stat = fs.statSync(outDbPath);
console.log(`Cloud migration bundle created at: ${outDir}`);
console.log(`- Clean snapshot DB: ${outDbPath} (${stat.size.toLocaleString()} bytes)`);
console.log(`- Master key included: ${masterKeyHex ? 'YES (.master.key + ENCRYPTION_KEY template)' : 'NO'}`);
console.log('Next: Upload cloud-bundle/data/* into your Cloud persistent volume (/app/data).');
