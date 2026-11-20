import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { AdapterContext, PublishResult } from './types.js';

/**
 * Optional bridge for accounts set to UNIFIED_API (e.g., Upload-Post / Zernio)
 * while waiting for official YouTube/TikTok/Meta Compliance Audits.
 */
export async function publishViaUnifiedApi(
  ctx: AdapterContext
): Promise<PublishResult> {
  const baseUrl = ctx.settings.unifiedApiBaseUrl.replace(/\/+$/, '');
  const apiKey = ctx.settings.unifiedApiKey;

  if (!baseUrl || !apiKey) {
    const simId = `uni_${randomBytes(4).toString('hex')}`;
    ctx.log(
      'WARN',
      'UNIFIED_API_UNCONFIGURED',
      'ยังไม่ได้ตั้งค่า Unified API URL/Key — ทำงานในโหมด Dry-Run Simulation แทน'
    );
    return { externalPostId: simId, externalUrl: null };
  }

  const form = new FormData();
  const fileBuf = await fs.promises.readFile(ctx.localFilePath);
  form.append(
    'video',
    new Blob([fileBuf], { type: ctx.asset.mimeType || 'video/mp4' }),
    ctx.asset.originalFilename || 'video.mp4'
  );
  form.append('platform', ctx.job.platform.toLowerCase());
  form.append('format', ctx.job.format);
  form.append(
    'profile_id',
    ctx.account.config.unifiedAccountId || ctx.account.externalAccountId
  );
  form.append('metadata', JSON.stringify(ctx.job.metadataSnapshot));

  const res = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Unified API HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { id?: string; url?: string };
  return {
    externalPostId: json.id || `uni_${randomBytes(4).toString('hex')}`,
    externalUrl: json.url || null,
  };
}
