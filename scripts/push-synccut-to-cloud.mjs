import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { extractBriefFromSyncCutEpisode } from '../apps/server/dist/services/synccut-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bundleDir = path.join(repoRoot, 'cloud-bundle');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--episode' && argv[i + 1]) args.episodeId = argv[++i];
    else if (argv[i] === '--channel' && argv[i + 1]) args.channelId = argv[++i];
    else if (argv[i] === '--date' && argv[i + 1]) args.targetDate = argv[++i];
  }
  return args;
}

function loadConnectionConfig() {
  const connFile = path.join(bundleDir, 'cloud-connection.json');
  let fileCfg = {};
  if (fs.existsSync(connFile)) {
    fileCfg = JSON.parse(fs.readFileSync(connFile, 'utf8'));
  }
  const cloudUrl = (process.env.CLOUD_URL || fileCfg.cloudUrl || '').replace(/\/+$/, '');
  const passcode = process.env.STUDIO_PASSCODE || fileCfg.passcode || '';
  if (!cloudUrl || !passcode) {
    throw new Error(
      'Missing CLOUD_URL / STUDIO_PASSCODE (set env vars or populate cloud-bundle/cloud-connection.json)'
    );
  }
  return { cloudUrl, passcode };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { cloudUrl, passcode } = loadConnectionConfig();

  const synccutDir = path.resolve(
    process.env.SYNCCUT_DATA_DIR || 'C:\\Users\\iamgr\\Desktop\\SyncCut\\data'
  );
  const studioDbPath = path.join(synccutDir, 'studio.sqlite');
  if (!fs.existsSync(studioDbPath)) {
    throw new Error(`SyncCut database not found at ${studioDbPath}`);
  }

  const db = new DatabaseSync(studioDbPath, { readOnly: true });
  let episodes = [];
  let exportsList = [];
  const filesById = new Map();
  try {
    episodes = db
      .prepare('SELECT data FROM records WHERE kind = ? ORDER BY rowid DESC')
      .all('episode')
      .map((r) => JSON.parse(r.data));
    exportsList = db
      .prepare('SELECT data FROM records WHERE kind = ? ORDER BY rowid DESC')
      .all('export')
      .map((r) => JSON.parse(r.data));
    for (const r of db.prepare('SELECT id, data FROM records WHERE kind = ?').all('file')) {
      filesById.set(r.id, JSON.parse(r.data));
    }
  } finally {
    db.close();
  }

  const targetEp = opts.episodeId
    ? episodes.find((e) => e.id === opts.episodeId)
    : episodes.find((e) =>
        exportsList.some((x) => x.episodeId === e.id && x.file && fs.existsSync(x.file))
      );

  if (!targetEp) {
    throw new Error('No exported SyncCut episode with an existing video file was found.');
  }

  const bestExp = exportsList
    .filter((x) => x.episodeId === targetEp.id && x.file && fs.existsSync(x.file))
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];

  if (!bestExp?.file || !fs.existsSync(bestExp.file)) {
    throw new Error(`Exported MP4 missing for episode ${targetEp.id}`);
  }

  const coverFile = bestExp.coverId ? filesById.get(bestExp.coverId) : null;
  const coverPath = coverFile?.file && fs.existsSync(coverFile.file) ? coverFile.file : null;

  const brief = extractBriefFromSyncCutEpisode(targetEp, bestExp);
  const manifest = {
    projectTitle: brief.topic,
    language: brief.language,
    tone: brief.tone,
    content: {
      topic: brief.topic,
      hook: brief.hook,
      summary: brief.summary,
      keyPoints: brief.keyPoints,
      transcriptText: brief.transcriptText,
      keywords: brief.coreHashtags,
      cta: brief.cta,
      sources: brief.sources,
    },
    cover: {
      kicker: brief.coverKicker,
      headline: brief.coverHeadline,
      subline: brief.coverSubline,
      timestampMs: brief.coverTimestampMs,
    },
    schedulingHint: opts.targetDate ? { targetDate: opts.targetDate } : undefined,
  };

  const form = new FormData();
  if (opts.channelId) form.append('channelId', opts.channelId);
  form.append('createDraft', 'true');
  if (opts.targetDate) form.append('targetDate', opts.targetDate);
  form.append('manifest', JSON.stringify(manifest));

  const videoBuf = fs.readFileSync(bestExp.file);
  form.append(
    'video',
    new Blob([videoBuf], { type: 'video/mp4' }),
    path.basename(bestExp.file)
  );
  if (coverPath) {
    const coverBuf = fs.readFileSync(coverPath);
    form.append(
      'cover',
      new Blob([coverBuf], { type: 'image/png' }),
      path.basename(coverPath)
    );
  }

  console.log(
    `Pushing SyncCut episode "${brief.topic}" (${path.basename(bestExp.file)}) to ${cloudUrl}...`
  );
  const res = await fetch(`${cloudUrl}/api/integrations/synccut/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${passcode}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Push failed (${res.status}): ${text}`);
  }
  const parsed = JSON.parse(text);
  console.log('Pushed to Cloud successfully!');
  console.log('- Asset ID:', parsed.asset?.id);
  console.log('- Draft Content ID:', parsed.draftContentId);
  console.log('- Open URL:', parsed.openUrl);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
