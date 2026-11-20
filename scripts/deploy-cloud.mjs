import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const connFile = path.join(repoRoot, 'cloud-bundle', 'cloud-connection.json');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { cwd: repoRoot, stdio: 'inherit', ...opts });
}

function loadConnection() {
  const fileCfg = fs.existsSync(connFile) ? JSON.parse(fs.readFileSync(connFile, 'utf8')) : {};
  const cloudUrl = (process.env.CLOUD_URL || fileCfg.cloudUrl || '').replace(/\/+$/, '');
  const passcode = process.env.STUDIO_PASSCODE || fileCfg.passcode || '';
  if (!cloudUrl || !passcode) {
    throw new Error('Missing CLOUD_URL / STUDIO_PASSCODE (see cloud-bundle/cloud-connection.json)');
  }
  return { cloudUrl, passcode };
}

async function readHealth(cloudUrl) {
  try {
    const res = await fetch(`${cloudUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const { cloudUrl, passcode } = loadConnection();

  console.log('1/4 Build + test');
  run('npm run build');
  run('npm test');

  console.log('2/4 Commit and push the release branch (Railway pulls this branch on every start)');
  run('git add -A');
  run('git add -f packages/shared/dist apps/server/dist apps/web/dist');
  let hasChanges = true;
  try {
    execSync('git diff --cached --quiet', { cwd: repoRoot });
    hasChanges = false;
  } catch {
    hasChanges = true;
  }
  if (hasChanges) {
    run(`git commit -m "Cloud update ${new Date().toISOString()}"`);
  } else {
    console.log('No source changes to commit.');
  }
  run('git push origin HEAD:release --force');

  console.log('3/4 Restart the cloud service so it pulls the latest release');
  const before = await readHealth(cloudUrl);
  const res = await fetch(`${cloudUrl}/api/admin/restart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${passcode}` },
  });
  if (!res.ok) {
    throw new Error(`Restart request failed (${res.status}): ${await res.text()}`);
  }

  console.log('4/4 Waiting for the cloud service to come back…');
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, 8000));
  while (Date.now() - startedAt < 240_000) {
    const health = await readHealth(cloudUrl);
    if (health?.ok && (!before || health.schedulerLastTickAt !== before.schedulerLastTickAt)) {
      console.log(`Cloud is back online and running the latest release: ${cloudUrl}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Cloud did not come back within 4 minutes — check the Railway dashboard logs.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
