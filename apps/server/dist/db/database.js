import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SecretCipher } from './crypto.js';
function plain(row) {
    if (!row || typeof row !== 'object')
        return null;
    return { ...row };
}
function plainList(rows) {
    return rows.map((r) => ({ ...r }));
}
function parseJson(raw, fallback) {
    if (typeof raw !== 'string' || !raw)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
export class FacebookReelDuplicateError extends Error {
}
export class ClipFlowDb {
    sqlite;
    cipher;
    constructor(dbPath, keyPathOrHex) {
        if (dbPath !== ':memory:') {
            const dir = path.dirname(dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        this.sqlite = new DatabaseSync(dbPath);
        this.cipher = new SecretCipher(keyPathOrHex);
        this.sqlite.exec('PRAGMA journal_mode = WAL;');
        this.sqlite.exec('PRAGMA foreign_keys = ON;');
        this.sqlite.exec('PRAGMA busy_timeout = 5000;');
        this.migrate();
    }
    checkpoint() {
        try {
            this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        }
        catch {
            // Ignore if in-memory or already closing
        }
    }
    close() {
        this.checkpoint();
        this.sqlite.close();
    }
    importDatabaseFile(sourceDbPath) {
        if (!fs.existsSync(sourceDbPath)) {
            throw new Error(`Source SQLite file not found: ${sourceDbPath}`);
        }
        const escaped = sourceDbPath.replace(/'/g, "''");
        const childFirstTables = [
            'job_logs',
            'publish_jobs',
            'content_items',
            'media_assets',
            'metadata_templates',
            'schedule_rules',
            'social_accounts',
            'channels',
            'app_settings',
        ];
        this.sqlite.exec('PRAGMA foreign_keys = OFF;');
        this.sqlite.exec(`ATTACH DATABASE '${escaped}' AS incoming;`);
        let inTx = false;
        try {
            this.sqlite.exec('BEGIN IMMEDIATE;');
            inTx = true;
            for (const tbl of childFirstTables) {
                this.sqlite.exec(`DELETE FROM main.${tbl};`);
            }
            for (const tbl of [...childFirstTables].reverse()) {
                const mainCols = plainList(this.sqlite.prepare(`PRAGMA main.table_info(${tbl})`).all()).map((c) => c.name);
                const incomingCols = new Set(plainList(this.sqlite.prepare(`PRAGMA incoming.table_info(${tbl})`).all()).map((c) => c.name));
                const commonCols = mainCols.filter((c) => incomingCols.has(c));
                if (commonCols.length > 0) {
                    const colList = commonCols.map((c) => `"${c}"`).join(', ');
                    this.sqlite.exec(`INSERT INTO main.${tbl} (${colList}) SELECT ${colList} FROM incoming.${tbl};`);
                }
            }
            this.sqlite.exec('COMMIT;');
            inTx = false;
        }
        catch (err) {
            if (inTx) {
                try {
                    this.sqlite.exec('ROLLBACK;');
                }
                catch {
                    // ignore
                }
            }
            throw err;
        }
        finally {
            try {
                this.sqlite.exec('DETACH DATABASE incoming;');
            }
            catch {
                // ignore
            }
            this.sqlite.exec('PRAGMA foreign_keys = ON;');
            this.checkpoint();
        }
        return {
            channels: this.listChannels().length,
            accounts: this.listAccounts().length,
            rules: this.sqlite.prepare('SELECT count(*) as c FROM schedule_rules').get().c,
            templates: this.listTemplates().length,
            assets: this.listMediaAssets().length,
            contents: this.listContents({}).length,
            jobs: this.listJobs().length,
        };
    }
    migrate() {
        this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#6366f1',
        timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok',
        description TEXT NOT NULL DEFAULT '',
        default_tone TEXT NOT NULL DEFAULT 'FRIENDLY',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS social_accounts (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        account_name TEXT NOT NULL,
        external_account_id TEXT NOT NULL DEFAULT '',
        connection_mode TEXT NOT NULL DEFAULT 'SIMULATION',
        config_json TEXT NOT NULL DEFAULT '{}',
        encrypted_access_token TEXT,
        encrypted_refresh_token TEXT,
        token_expires_at TEXT,
        creator_info_json TEXT,
        status TEXT NOT NULL DEFAULT 'CONNECTED',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedule_rules (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        social_account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        clip_type TEXT NOT NULL DEFAULT 'ANY',
        slot_order INTEGER NOT NULL DEFAULT 1,
        local_time TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata_templates (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        format TEXT NOT NULL,
        name TEXT NOT NULL,
        title_prefix TEXT NOT NULL DEFAULT '',
        title_suffix TEXT NOT NULL DEFAULT '',
        description_header TEXT NOT NULL DEFAULT '',
        description_footer TEXT NOT NULL DEFAULT '',
        default_hashtags_json TEXT NOT NULL DEFAULT '[]',
        default_tags_json TEXT NOT NULL DEFAULT '[]',
        default_cta TEXT NOT NULL DEFAULT '',
        platform_defaults_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, format)
      );

      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        original_filename TEXT NOT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'LOCAL',
        storage_key TEXT NOT NULL,
        optimized_storage_key TEXT,
        public_url TEXT,
        thumbnail_paths_json TEXT NOT NULL DEFAULT '[]',
        mime_type TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        probe_json TEXT NOT NULL,
        orientation TEXT NOT NULL,
        clip_category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'READY',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_items (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
        target_date TEXT NOT NULL,
        master_brief_json TEXT NOT NULL,
        platform_metadata_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'SCHEDULED',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS publish_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        content_item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        social_account_id TEXT NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        format TEXT NOT NULL,
        strategy TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        prewarm_at TEXT,
        status TEXT NOT NULL,
        external_post_id TEXT,
        external_container_id TEXT,
        external_url TEXT,
        metadata_snapshot_json TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        next_retry_at TEXT,
        last_error TEXT,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_encrypted TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_due ON publish_jobs(status, scheduled_at, prewarm_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_content ON publish_jobs(content_item_id);
      CREATE INDEX IF NOT EXISTS idx_content_date ON content_items(channel_id, target_date);
      CREATE INDEX IF NOT EXISTS idx_rules_channel ON schedule_rules(channel_id, day_of_week);
      CREATE INDEX IF NOT EXISTS idx_logs_job ON job_logs(job_id, created_at);
    `);
        const cols = plainList(this.sqlite.prepare('PRAGMA table_info(media_assets)').all()).map((c) => c.name);
        if (!cols.includes('custom_cover_key')) {
            this.sqlite.exec('ALTER TABLE media_assets ADD COLUMN custom_cover_key TEXT;');
        }
        if (!cols.includes('custom_cover_public_url')) {
            this.sqlite.exec('ALTER TABLE media_assets ADD COLUMN custom_cover_public_url TEXT;');
        }
        if (!cols.includes('source_meta_json')) {
            this.sqlite.exec('ALTER TABLE media_assets ADD COLUMN source_meta_json TEXT;');
        }
        const jobColumns = this.sqlite.prepare('PRAGMA table_info(publish_jobs)').all();
        if (!jobColumns.some((column) => column.name === 'facebook_reel_json')) {
            this.sqlite.exec('ALTER TABLE publish_jobs ADD COLUMN facebook_reel_json TEXT;');
        }
        // Old live Reel rows used the Video ID as the Post ID and treated a due
        // schedule or a successful POST as publication. Reconcile by GET only.
        const legacyReels = this.sqlite.prepare(`SELECT j.id, j.external_post_id, j.content_item_id, a.external_account_id
       FROM publish_jobs j JOIN social_accounts a ON a.id = j.social_account_id
       WHERE j.format = 'FACEBOOK_REELS' AND a.connection_mode = 'LIVE_OFFICIAL'
         AND j.facebook_reel_json IS NULL
         AND (j.external_post_id IS NOT NULL OR j.status IN ('PREUPLOADING', 'PUBLISHING', 'PUBLISHED', 'FAILED')
              OR j.retry_count > 0)
         AND j.status != 'CANCELLED'`).all();
        const migrateReel = this.sqlite.prepare(`UPDATE publish_jobs SET facebook_reel_json = ?, status = ?, external_post_id = NULL,
         external_url = NULL, next_retry_at = NULL, locked_until = NULL, last_error = ?
       WHERE id = ? AND facebook_reel_json IS NULL`);
        for (const row of legacyReels) {
            const videoId = /^\d+$/.test(String(row.external_post_id)) ? String(row.external_post_id) : undefined;
            const status = videoId ? 'PUBLISH_REQUESTED' : 'UNKNOWN';
            const receipt = {
                graphVersion: 'v22.0', pageId: String(row.external_account_id), legacy: true, videoId,
            };
            const note = videoId ? null : 'Legacy Facebook Reel has no recorded Video ID. Check the Page before creating another job.';
            migrateReel.run(JSON.stringify(receipt), status, note, String(row.id));
            this.recomputeContentStatus(String(row.content_item_id));
        }
        // Auto-heal LIVE_OFFICIAL accounts whose account_name still carries the seed "(Simulation)" suffix
        const simNamedLiveRows = plainList(this.sqlite
            .prepare(`SELECT id, platform, account_name, creator_info_json
           FROM social_accounts
           WHERE connection_mode = 'LIVE_OFFICIAL' AND account_name LIKE '%Simulation%'`)
            .all());
        for (const r of simNamedLiveRows) {
            const info = parseJson(r.creator_info_json, null);
            const nick = info?.creatorNickname?.trim();
            const user = info?.creatorUsername?.trim().replace(/^@/, '');
            const healedName = nick && user && nick.toLowerCase() !== user.toLowerCase()
                ? `${nick} (@${user})`
                : nick || (user ? `@${user}` : String(r.account_name).replace(/\s*\(Simulation\)/i, '').trim());
            if (healedName && healedName !== String(r.account_name)) {
                this.sqlite
                    .prepare('UPDATE social_accounts SET account_name = ? WHERE id = ?')
                    .run(healedName, String(r.id));
            }
        }
    }
    // ---------- Channels ----------
    listChannels() {
        const rows = plainList(this.sqlite.prepare('SELECT * FROM channels ORDER BY created_at ASC').all());
        return rows.map((r) => this.mapChannel(r));
    }
    getChannel(id) {
        const row = plain(this.sqlite.prepare('SELECT * FROM channels WHERE id = ?').get(id));
        return row ? this.mapChannel(row) : null;
    }
    createChannel(input) {
        const existingCount = this.listChannels().length;
        const maxChannels = this.getSettingsFull().maxChannels;
        if (existingCount >= maxChannels) {
            throw new Error(`จำกัดสูงสุด ${maxChannels} ช่อง (Channels) ตามที่ตั้งค่าไว้ หากต้องการเพิ่มโปรดลบช่องเดิมหรือปรับ MAX_CHANNELS`);
        }
        const now = new Date().toISOString();
        const id = input.id ?? `ch_${randomUUID().slice(0, 8)}`;
        const baseSlug = input.slug?.trim() ||
            input.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '') ||
            id;
        const slug = this.sqlite
            .prepare('SELECT id FROM channels WHERE slug = ?')
            .get(baseSlug)
            ? `${baseSlug}-${id.slice(-4)}`
            : baseSlug;
        this.sqlite
            .prepare(`INSERT INTO channels (id, name, slug, color, timezone, description, default_tone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, input.name.trim(), slug, input.color ?? '#6366f1', input.timezone ?? 'Asia/Bangkok', input.description ?? '', input.defaultTone ?? 'FRIENDLY', now, now);
        return this.getChannel(id);
    }
    updateChannel(id, patch) {
        const cur = this.getChannel(id);
        if (!cur)
            return null;
        const now = new Date().toISOString();
        this.sqlite
            .prepare(`UPDATE channels SET name = ?, color = ?, timezone = ?, description = ?, default_tone = ?, updated_at = ? WHERE id = ?`)
            .run(patch.name ?? cur.name, patch.color ?? cur.color, patch.timezone ?? cur.timezone, patch.description ?? cur.description, patch.defaultTone ?? cur.defaultTone, now, id);
        return this.getChannel(id);
    }
    deleteChannel(id) {
        const res = this.sqlite.prepare('DELETE FROM channels WHERE id = ?').run(id);
        return Number(res.changes) > 0;
    }
    mapChannel(r) {
        return {
            id: String(r.id),
            name: String(r.name),
            slug: String(r.slug),
            color: String(r.color),
            timezone: String(r.timezone),
            description: String(r.description ?? ''),
            defaultTone: r.default_tone ?? 'FRIENDLY',
            createdAt: String(r.created_at),
            updatedAt: String(r.updated_at),
        };
    }
    // ---------- Social Accounts ----------
    listAccounts(channelId) {
        const rows = channelId
            ? plainList(this.sqlite
                .prepare('SELECT * FROM social_accounts WHERE channel_id = ? ORDER BY created_at ASC')
                .all(channelId))
            : plainList(this.sqlite
                .prepare('SELECT * FROM social_accounts ORDER BY created_at ASC')
                .all());
        return rows.map((r) => this.mapAccount(r));
    }
    getAccount(id) {
        const row = plain(this.sqlite.prepare('SELECT * FROM social_accounts WHERE id = ?').get(id));
        return row ? this.mapAccount(row) : null;
    }
    getAccountWithSecrets(id) {
        const row = plain(this.sqlite.prepare('SELECT * FROM social_accounts WHERE id = ?').get(id));
        if (!row)
            return null;
        return {
            account: this.mapAccount(row),
            accessToken: this.cipher.decrypt(row.encrypted_access_token),
            refreshToken: this.cipher.decrypt(row.encrypted_refresh_token),
        };
    }
    createAccount(input) {
        const now = new Date().toISOString();
        const id = input.id ?? `acc_${randomUUID().slice(0, 8)}`;
        this.sqlite
            .prepare(`INSERT INTO social_accounts (
          id, channel_id, platform, account_name, external_account_id, connection_mode,
          config_json, encrypted_access_token, encrypted_refresh_token, token_expires_at,
          creator_info_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, input.channelId, input.platform, input.accountName, input.externalAccountId ?? '', input.connectionMode ?? 'SIMULATION', JSON.stringify(input.config ?? {}), this.cipher.encrypt(input.accessToken ?? null), this.cipher.encrypt(input.refreshToken ?? null), input.tokenExpiresAt ?? null, input.creatorInfo ? JSON.stringify(input.creatorInfo) : null, input.status ?? 'CONNECTED', now, now);
        return this.getAccount(id);
    }
    updateAccount(id, patch) {
        const row = plain(this.sqlite.prepare('SELECT * FROM social_accounts WHERE id = ?').get(id));
        if (!row)
            return null;
        const cur = this.mapAccount(row);
        const now = new Date().toISOString();
        const effectiveMode = patch.connectionMode ?? cur.connectionMode;
        const effectiveCreatorInfo = patch.creatorInfo !== undefined ? patch.creatorInfo : cur.creatorInfo;
        let resolvedAccountName = patch.accountName ?? cur.accountName;
        if (effectiveMode === 'LIVE_OFFICIAL' &&
            /simulation/i.test(resolvedAccountName) &&
            effectiveCreatorInfo) {
            const nick = effectiveCreatorInfo.creatorNickname?.trim();
            const user = effectiveCreatorInfo.creatorUsername?.trim().replace(/^@/, '');
            if (nick && user && nick.toLowerCase() !== user.toLowerCase()) {
                resolvedAccountName = `${nick} (@${user})`;
            }
            else if (nick) {
                resolvedAccountName = nick;
            }
            else if (user) {
                resolvedAccountName = `@${user}`;
            }
        }
        const encAccess = patch.accessToken !== undefined
            ? this.cipher.encrypt(patch.accessToken)
            : row.encrypted_access_token;
        const encRefresh = patch.refreshToken !== undefined
            ? this.cipher.encrypt(patch.refreshToken)
            : row.encrypted_refresh_token;
        this.sqlite
            .prepare(`UPDATE social_accounts SET
          account_name = ?, external_account_id = ?, connection_mode = ?,
          config_json = ?, encrypted_access_token = ?, encrypted_refresh_token = ?,
          token_expires_at = ?, creator_info_json = ?, status = ?, updated_at = ?
         WHERE id = ?`)
            .run(resolvedAccountName, patch.externalAccountId ?? cur.externalAccountId, effectiveMode, JSON.stringify(patch.config ?? cur.config), encAccess, encRefresh, patch.tokenExpiresAt !== undefined
            ? patch.tokenExpiresAt
            : cur.tokenExpiresAt, patch.creatorInfo !== undefined
            ? patch.creatorInfo
                ? JSON.stringify(patch.creatorInfo)
                : null
            : typeof row.creator_info_json === 'string'
                ? row.creator_info_json
                : null, patch.status ?? cur.status, now, id);
        return this.getAccount(id);
    }
    deleteAccount(id) {
        const res = this.sqlite
            .prepare('DELETE FROM social_accounts WHERE id = ?')
            .run(id);
        return Number(res.changes) > 0;
    }
    mapAccount(r) {
        return {
            id: String(r.id),
            channelId: String(r.channel_id),
            platform: r.platform,
            accountName: String(r.account_name),
            externalAccountId: String(r.external_account_id ?? ''),
            connectionMode: r.connection_mode ?? 'SIMULATION',
            config: parseJson(r.config_json, {}),
            hasAccessToken: Boolean(r.encrypted_access_token),
            hasRefreshToken: Boolean(r.encrypted_refresh_token),
            tokenExpiresAt: r.token_expires_at ? String(r.token_expires_at) : null,
            creatorInfo: parseJson(r.creator_info_json, null),
            status: r.status ??
                'CONNECTED',
            createdAt: String(r.created_at),
            updatedAt: String(r.updated_at),
        };
    }
    // ---------- Schedule Rules ----------
    listScheduleRules(channelId) {
        const rows = plainList(this.sqlite
            .prepare('SELECT * FROM schedule_rules WHERE channel_id = ? ORDER BY day_of_week ASC, slot_order ASC, local_time ASC')
            .all(channelId));
        return rows.map((r) => ({
            id: String(r.id),
            channelId: String(r.channel_id),
            socialAccountId: String(r.social_account_id),
            dayOfWeek: Number(r.day_of_week),
            clipType: r.clip_type ?? 'ANY',
            slotOrder: Number(r.slot_order),
            localTime: String(r.local_time),
            isActive: Boolean(r.is_active),
            createdAt: String(r.created_at),
        }));
    }
    replaceScheduleRules(channelId, rules) {
        const now = new Date().toISOString();
        this.sqlite.exec('BEGIN IMMEDIATE;');
        try {
            this.sqlite
                .prepare('DELETE FROM schedule_rules WHERE channel_id = ?')
                .run(channelId);
            const stmt = this.sqlite.prepare(`INSERT INTO schedule_rules (id, channel_id, social_account_id, day_of_week, clip_type, slot_order, local_time, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const r of rules) {
                stmt.run(r.id ?? `rule_${randomUUID().slice(0, 8)}`, channelId, r.socialAccountId, r.dayOfWeek, r.clipType ?? 'ANY', r.slotOrder ?? 1, r.localTime, r.isActive === false ? 0 : 1, now);
            }
            this.sqlite.exec('COMMIT;');
        }
        catch (err) {
            this.sqlite.exec('ROLLBACK;');
            throw err;
        }
        return this.listScheduleRules(channelId);
    }
    // ---------- Metadata Templates ----------
    listTemplates(channelId) {
        const rows = channelId
            ? plainList(this.sqlite
                .prepare('SELECT * FROM metadata_templates WHERE channel_id = ? ORDER BY format ASC')
                .all(channelId))
            : plainList(this.sqlite
                .prepare('SELECT * FROM metadata_templates ORDER BY format ASC')
                .all());
        return rows.map((r) => this.mapTemplate(r));
    }
    upsertTemplate(input) {
        const now = new Date().toISOString();
        const existing = plain(this.sqlite
            .prepare('SELECT id FROM metadata_templates WHERE channel_id = ? AND format = ?')
            .get(input.channelId, input.format));
        const id = existing
            ? String(existing.id)
            : input.id ?? `tpl_${randomUUID().slice(0, 8)}`;
        this.sqlite
            .prepare(`INSERT INTO metadata_templates (
          id, channel_id, format, name, title_prefix, title_suffix,
          description_header, description_footer, default_hashtags_json,
          default_tags_json, default_cta, platform_defaults_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, format) DO UPDATE SET
          name = excluded.name,
          title_prefix = excluded.title_prefix,
          title_suffix = excluded.title_suffix,
          description_header = excluded.description_header,
          description_footer = excluded.description_footer,
          default_hashtags_json = excluded.default_hashtags_json,
          default_tags_json = excluded.default_tags_json,
          default_cta = excluded.default_cta,
          platform_defaults_json = excluded.platform_defaults_json,
          updated_at = excluded.updated_at`)
            .run(id, input.channelId, input.format, input.name, input.titlePrefix ?? '', input.titleSuffix ?? '', input.descriptionHeader ?? '', input.descriptionFooter ?? '', JSON.stringify(input.defaultHashtags ?? []), JSON.stringify(input.defaultTags ?? []), input.defaultCta ?? '', JSON.stringify(input.platformDefaults ?? {}), now);
        const row = plain(this.sqlite
            .prepare('SELECT * FROM metadata_templates WHERE id = ?')
            .get(id));
        return this.mapTemplate(row);
    }
    mapTemplate(r) {
        return {
            id: String(r.id),
            channelId: String(r.channel_id),
            format: r.format,
            name: String(r.name),
            titlePrefix: String(r.title_prefix ?? ''),
            titleSuffix: String(r.title_suffix ?? ''),
            descriptionHeader: String(r.description_header ?? ''),
            descriptionFooter: String(r.description_footer ?? ''),
            defaultHashtags: parseJson(r.default_hashtags_json, []),
            defaultTags: parseJson(r.default_tags_json, []),
            defaultCta: String(r.default_cta ?? ''),
            platformDefaults: parseJson(r.platform_defaults_json, {}),
            updatedAt: String(r.updated_at),
        };
    }
    // ---------- Media Assets ----------
    createMediaAsset(input) {
        const now = new Date().toISOString();
        this.sqlite
            .prepare(`INSERT INTO media_assets (
          id, channel_id, original_filename, storage_provider, storage_key,
          optimized_storage_key, public_url, thumbnail_paths_json, custom_cover_key,
          custom_cover_public_url, source_meta_json, mime_type,
          file_size_bytes, probe_json, orientation, clip_category, status, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.id, input.channelId, input.originalFilename, input.storageProvider, input.storageKey, input.publicUrl ?? null, JSON.stringify(input.thumbnailPaths), input.customCoverKey ?? null, input.customCoverPublicUrl ?? null, input.sourceMeta ? JSON.stringify(input.sourceMeta) : null, input.mimeType, input.fileSizeBytes, JSON.stringify(input.probe), input.orientation, input.clipCategory, input.status ?? 'READY', now);
        return this.getMediaAsset(input.id);
    }
    updateMediaAssetCover(id, customCoverKey, customCoverPublicUrl = null) {
        this.sqlite
            .prepare(`UPDATE media_assets SET custom_cover_key = ?, custom_cover_public_url = ? WHERE id = ?`)
            .run(customCoverKey, customCoverPublicUrl, id);
        return this.getMediaAsset(id);
    }
    getMediaAsset(id) {
        const row = plain(this.sqlite.prepare('SELECT * FROM media_assets WHERE id = ?').get(id));
        return row ? this.mapMediaAsset(row) : null;
    }
    listMediaAssets(channelId) {
        const rows = channelId
            ? plainList(this.sqlite
                .prepare('SELECT * FROM media_assets WHERE channel_id = ? ORDER BY created_at DESC')
                .all(channelId))
            : plainList(this.sqlite
                .prepare('SELECT * FROM media_assets ORDER BY created_at DESC')
                .all());
        return rows.map((r) => this.mapMediaAsset(r));
    }
    updateMediaAssetOptimized(id, optimizedStorageKey, probe, fileSizeBytes, publicUrl) {
        this.sqlite
            .prepare(`UPDATE media_assets SET
          optimized_storage_key = ?, probe_json = ?, file_size_bytes = ?,
          public_url = COALESCE(?, public_url), status = 'OPTIMIZED'
         WHERE id = ?`)
            .run(optimizedStorageKey, JSON.stringify(probe), fileSizeBytes, publicUrl ?? null, id);
        return this.getMediaAsset(id);
    }
    mapMediaAsset(r) {
        return {
            id: String(r.id),
            channelId: String(r.channel_id),
            originalFilename: String(r.original_filename),
            storageProvider: r.storage_provider ?? 'LOCAL',
            storageKey: String(r.storage_key),
            optimizedStorageKey: r.optimized_storage_key
                ? String(r.optimized_storage_key)
                : null,
            publicUrl: r.public_url ? String(r.public_url) : null,
            thumbnailPaths: parseJson(r.thumbnail_paths_json, []),
            customCoverKey: r.custom_cover_key ? String(r.custom_cover_key) : null,
            customCoverPublicUrl: r.custom_cover_public_url
                ? String(r.custom_cover_public_url)
                : null,
            sourceMeta: parseJson(r.source_meta_json, null),
            mimeType: String(r.mime_type),
            fileSizeBytes: Number(r.file_size_bytes),
            probe: parseJson(r.probe_json, {
                durationSec: 0,
                width: 0,
                height: 0,
                rotation: 0,
                fps: 30,
                videoCodec: 'h264',
                audioCodec: 'aac',
                audioSampleRate: 48000,
                bitrateKbps: 0,
                fileSizeBytes: Number(r.file_size_bytes),
                hasFaststartMoov: null,
            }),
            orientation: r.orientation,
            clipCategory: r.clip_category,
            status: r.status ?? 'READY',
            createdAt: String(r.created_at),
        };
    }
    // ---------- Content Items & Publish Jobs ----------
    listContents(params) {
        const conditions = [];
        const args = [];
        if (params.channelId) {
            conditions.push('channel_id = ?');
            args.push(params.channelId);
        }
        if (params.fromDate) {
            conditions.push('target_date >= ?');
            args.push(params.fromDate);
        }
        if (params.toDate) {
            conditions.push('target_date <= ?');
            args.push(params.toDate);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = plainList(this.sqlite
            .prepare(`SELECT * FROM content_items ${where} ORDER BY target_date ASC, created_at DESC`)
            .all(...args));
        return rows.map((r) => this.hydrateContent(this.mapContent(r)));
    }
    getContent(id) {
        const row = plain(this.sqlite.prepare('SELECT * FROM content_items WHERE id = ?').get(id));
        if (!row)
            return null;
        return this.hydrateContent(this.mapContent(row));
    }
    createContentWithJobs(input) {
        const now = new Date().toISOString();
        let contentId = input.id ?? `cnt_${randomUUID().slice(0, 8)}`;
        this.sqlite.exec('BEGIN IMMEDIATE;');
        try {
            let reusingDraft = false;
            if (input.draftContentId) {
                const draftRow = plain(this.sqlite
                    .prepare('SELECT id, status FROM content_items WHERE id = ?')
                    .get(input.draftContentId));
                const existingJobsRow = plain(this.sqlite
                    .prepare('SELECT COUNT(*) AS cnt FROM publish_jobs WHERE content_item_id = ?')
                    .get(input.draftContentId));
                if (draftRow && draftRow.status === 'DRAFT' && Number(existingJobsRow?.cnt ?? 0) === 0) {
                    contentId = draftRow.id;
                    reusingDraft = true;
                }
            }
            for (const target of input.jobs) {
                if (target.format !== 'FACEBOOK_REELS')
                    continue;
                const account = this.getAccount(target.socialAccountId);
                if (account?.connectionMode !== 'LIVE_OFFICIAL')
                    continue;
                const duplicate = this.sqlite.prepare(`SELECT j.id FROM publish_jobs j
           JOIN content_items c ON c.id = j.content_item_id
           JOIN social_accounts a ON a.id = j.social_account_id
           JOIN media_assets existing_asset ON existing_asset.id = c.media_asset_id
           JOIN media_assets requested_asset ON requested_asset.id = ?
           WHERE a.platform = 'FACEBOOK'
             AND (
               existing_asset.id = requested_asset.id OR (
                 json_extract(existing_asset.source_meta_json, '$.sourceApp') = 'SyncCut Studio'
                 AND json_extract(requested_asset.source_meta_json, '$.sourceApp') = 'SyncCut Studio'
                 AND json_extract(existing_asset.source_meta_json, '$.episodeId') =
                       json_extract(requested_asset.source_meta_json, '$.episodeId')
                 AND json_extract(existing_asset.source_meta_json, '$.exportId') =
                       json_extract(requested_asset.source_meta_json, '$.exportId')
                 AND json_extract(existing_asset.source_meta_json, '$.exportId') != ''
               )
             )
             AND (a.id = ? OR a.external_account_id = ? OR json_extract(j.facebook_reel_json, '$.pageId') = ?)
             AND j.format = 'FACEBOOK_REELS' AND j.status != 'CANCELLED'
             AND (j.facebook_reel_json IS NOT NULL OR a.connection_mode = 'LIVE_OFFICIAL')
             AND (
               julianday(j.scheduled_at) = julianday(?)
               OR j.status IN ('NATIVE_SCHEDULED', 'PREUPLOADING', 'UPLOADED', 'PROCESSING', 'PUBLISH_REQUESTED', 'UNKNOWN')
             )
           LIMIT 1`).get(input.mediaAssetId, account.id, account.externalAccountId, account.externalAccountId, target.scheduledAt);
                if (duplicate)
                    throw new FacebookReelDuplicateError('มีงาน Facebook Reel สำหรับคลิปและเพจนี้อยู่แล้ว ตรวจสอบคิวเดิมก่อน');
            }
            if (reusingDraft) {
                this.sqlite
                    .prepare(`UPDATE content_items
             SET channel_id = ?, media_asset_id = ?, target_date = ?, master_brief_json = ?,
                 platform_metadata_json = ?, status = ?, updated_at = ?
             WHERE id = ?`)
                    .run(input.channelId, input.mediaAssetId, input.targetDate, JSON.stringify(input.masterBrief), JSON.stringify(input.platformMetadata), input.jobs.length > 0 ? 'SCHEDULED' : 'DRAFT', now, contentId);
            }
            else {
                this.sqlite
                    .prepare(`INSERT INTO content_items (
              id, channel_id, media_asset_id, target_date, master_brief_json,
              platform_metadata_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(contentId, input.channelId, input.mediaAssetId, input.targetDate, JSON.stringify(input.masterBrief), JSON.stringify(input.platformMetadata), input.jobs.length > 0 ? 'SCHEDULED' : 'DRAFT', now, now);
            }
            const jobStmt = this.sqlite.prepare(`INSERT INTO publish_jobs (
          id, idempotency_key, content_item_id, channel_id, social_account_id,
          platform, format, strategy, scheduled_at, prewarm_at, status,
          metadata_snapshot_json, retry_count, max_retries, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, 0, 3, ?, ?)`);
            for (const j of input.jobs) {
                const jobId = `job_${randomUUID().slice(0, 8)}`;
                const idempotencyKey = `${contentId}:${j.socialAccountId}:${j.format}`;
                jobStmt.run(jobId, idempotencyKey, contentId, input.channelId, j.socialAccountId, j.platform, j.format, j.strategy, j.scheduledAt, j.prewarmAt, JSON.stringify(j.metadataSnapshot), now, now);
            }
            this.sqlite.exec('COMMIT;');
        }
        catch (err) {
            this.sqlite.exec('ROLLBACK;');
            throw err;
        }
        return this.getContent(contentId);
    }
    updateContentFields(id, patch) {
        const cur = this.getContent(id);
        if (!cur)
            return null;
        const now = new Date().toISOString();
        this.sqlite
            .prepare(`UPDATE content_items SET target_date = ?, master_brief_json = ?, platform_metadata_json = ?, status = ?, updated_at = ? WHERE id = ?`)
            .run(patch.targetDate ?? cur.targetDate, JSON.stringify(patch.masterBrief ?? cur.masterBrief), JSON.stringify(patch.platformMetadata ?? cur.platformMetadata), patch.status ?? cur.status, now, id);
        return this.getContent(id);
    }
    recomputeContentStatus(contentItemId) {
        const jobs = this.listJobs({ contentItemId });
        if (jobs.length === 0)
            return;
        const activeJobs = jobs.filter((j) => j.status !== 'CANCELLED');
        if (activeJobs.length === 0) {
            this.sqlite
                .prepare("UPDATE content_items SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
                .run(new Date().toISOString(), contentItemId);
            return;
        }
        const allPublished = activeJobs.every((j) => j.status === 'PUBLISHED');
        const anyPublished = activeJobs.some((j) => j.status === 'PUBLISHED');
        const anyFailed = activeJobs.some((j) => j.status === 'FAILED');
        let status = 'SCHEDULED';
        if (allPublished)
            status = 'COMPLETED';
        else if (anyFailed && anyPublished)
            status = 'PARTIAL';
        else if (anyFailed)
            status = 'FAILED';
        this.sqlite
            .prepare('UPDATE content_items SET status = ?, updated_at = ? WHERE id = ?')
            .run(status, new Date().toISOString(), contentItemId);
    }
    deleteContent(id) {
        const res = this.sqlite
            .prepare('DELETE FROM content_items WHERE id = ?')
            .run(id);
        return Number(res.changes) > 0;
    }
    mapContent(r) {
        return {
            id: String(r.id),
            channelId: String(r.channel_id),
            mediaAssetId: String(r.media_asset_id),
            targetDate: String(r.target_date),
            masterBrief: parseJson(r.master_brief_json, {
                topic: '',
                hook: '',
                summary: '',
                keyPoints: [],
                cta: '',
                coreHashtags: [],
                language: 'th',
                tone: 'FRIENDLY',
            }),
            platformMetadata: parseJson(r.platform_metadata_json, {}),
            status: r.status ?? 'SCHEDULED',
            createdAt: String(r.created_at),
            updatedAt: String(r.updated_at),
        };
    }
    hydrateContent(item) {
        item.mediaAsset = this.getMediaAsset(item.mediaAssetId) ?? undefined;
        item.jobs = this.listJobs({ contentItemId: item.id });
        return item;
    }
    // ---------- Publish Jobs & Atomic Locking ----------
    listJobs(filter) {
        const cond = [];
        const args = [];
        if (filter?.channelId) {
            cond.push('j.channel_id = ?');
            args.push(filter.channelId);
        }
        if (filter?.contentItemId) {
            cond.push('j.content_item_id = ?');
            args.push(filter.contentItemId);
        }
        if (filter?.status) {
            cond.push('j.status = ?');
            args.push(filter.status);
        }
        const where = cond.length > 0 ? `WHERE ${cond.join(' AND ')}` : '';
        const rows = plainList(this.sqlite
            .prepare(`SELECT j.*, a.account_name, a.connection_mode,
                  c.target_date AS content_target_date,
                  c.master_brief_json AS content_master_brief_json,
                  c.media_asset_id AS content_media_asset_id,
                  m.original_filename AS media_original_filename,
                  m.custom_cover_key AS media_custom_cover_key,
                  m.thumbnail_paths_json AS media_thumbnail_paths_json
           FROM publish_jobs j
           LEFT JOIN social_accounts a ON a.id = j.social_account_id
           LEFT JOIN content_items c ON c.id = j.content_item_id
           LEFT JOIN media_assets m ON m.id = c.media_asset_id
           ${where}
           ORDER BY j.scheduled_at ASC`)
            .all(...args));
        return rows.map((r) => this.mapJob(r));
    }
    getJob(id) {
        const row = plain(this.sqlite
            .prepare(`SELECT j.*, a.account_name, a.connection_mode,
                  c.target_date AS content_target_date,
                  c.master_brief_json AS content_master_brief_json,
                  c.media_asset_id AS content_media_asset_id,
                  m.original_filename AS media_original_filename,
                  m.custom_cover_key AS media_custom_cover_key,
                  m.thumbnail_paths_json AS media_thumbnail_paths_json
           FROM publish_jobs j
           LEFT JOIN social_accounts a ON a.id = j.social_account_id
           LEFT JOIN content_items c ON c.id = j.content_item_id
           LEFT JOIN media_assets m ON m.id = c.media_asset_id
           WHERE j.id = ?`)
            .get(id));
        return row ? this.mapJob(row) : null;
    }
    /**
     * Atomically claims due jobs using BEGIN IMMEDIATE so concurrent ticks never duplicate work.
     */
    claimDueJobs(nowIso, limit = 10, allowLiveFacebookReels = true) {
        const leaseUntil = new Date(new Date(nowIso).getTime() + 5 * 60_000).toISOString();
        this.sqlite.exec('BEGIN IMMEDIATE;');
        try {
            const candidates = plainList(this.sqlite
                .prepare(`SELECT * FROM publish_jobs
             WHERE (locked_until IS NULL OR locked_until < ?)
               AND (next_retry_at IS NULL OR next_retry_at <= ?)
               AND (? = 1 OR format != 'FACEBOOK_REELS' OR (
                 facebook_reel_json IS NULL AND NOT EXISTS (
                   SELECT 1 FROM social_accounts a WHERE a.id = publish_jobs.social_account_id
                     AND a.connection_mode = 'LIVE_OFFICIAL'
                 )
               ))
               AND (
                 (status = 'QUEUED' AND strategy IN ('NATIVE_PREUPLOAD', 'INBOX_DRAFT'))
                 OR (status = 'QUEUED' AND strategy = 'JIT_PUBLISH' AND (prewarm_at IS NULL OR prewarm_at <= ?))
                 OR (status = 'READY_TO_PUBLISH' AND scheduled_at <= ?)
                 OR (status = 'NATIVE_SCHEDULED' AND scheduled_at <= ?)
                 OR (format != 'FACEBOOK_REELS' AND status IN ('PREUPLOADING', 'PREWARMING', 'PUBLISHING')
                     AND locked_until IS NOT NULL AND locked_until < ?)
                 OR (format = 'FACEBOOK_REELS' AND facebook_reel_json IS NOT NULL
                     AND status IN ('PREUPLOADING', 'UPLOADED', 'PROCESSING', 'PUBLISH_REQUESTED'))
               )
             ORDER BY scheduled_at ASC
             LIMIT ?`)
                .all(nowIso, nowIso, Number(allowLiveFacebookReels), nowIso, nowIso, nowIso, nowIso, limit));
            const claimed = [];
            const lockStmt = this.sqlite.prepare(`UPDATE publish_jobs SET locked_until = ?, updated_at = ? WHERE id = ?`);
            for (const row of candidates) {
                lockStmt.run(leaseUntil, nowIso, String(row.id));
                const mapped = this.getJob(String(row.id));
                if (mapped)
                    claimed.push(mapped);
            }
            this.sqlite.exec('COMMIT;');
            return claimed;
        }
        catch (err) {
            this.sqlite.exec('ROLLBACK;');
            throw err;
        }
    }
    facebookReelRateLimitedUntil(pageId, nowIso) {
        const row = this.sqlite.prepare(`SELECT MAX(json_extract(facebook_reel_json, '$.rateLimitedUntil')) AS until
       FROM publish_jobs WHERE format = 'FACEBOOK_REELS' AND facebook_reel_json IS NOT NULL
         AND json_extract(facebook_reel_json, '$.pageId') = ?
         AND json_extract(facebook_reel_json, '$.rateLimitedUntil') > ?`).get(pageId, nowIso);
        return typeof row?.until === 'string' ? row.until : null;
    }
    claimSpecificJob(jobId, nowIso) {
        const leaseUntil = new Date(new Date(nowIso).getTime() + 5 * 60_000).toISOString();
        this.sqlite.exec('BEGIN IMMEDIATE;');
        try {
            const row = plain(this.sqlite
                .prepare(`SELECT * FROM publish_jobs WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)
             AND status != 'PUBLISHED'
             AND (facebook_reel_json IS NULL OR next_retry_at IS NULL OR next_retry_at <= ?)`)
                .get(jobId, nowIso, nowIso));
            if (!row) {
                this.sqlite.exec('COMMIT;');
                return null;
            }
            this.sqlite
                .prepare('UPDATE publish_jobs SET locked_until = ?, updated_at = ? WHERE id = ?')
                .run(leaseUntil, nowIso, jobId);
            this.sqlite.exec('COMMIT;');
            return this.getJob(jobId);
        }
        catch (err) {
            this.sqlite.exec('ROLLBACK;');
            throw err;
        }
    }
    updateJob(id, patch, expectedLock) {
        const cur = this.getJob(id);
        if (!cur)
            return null;
        const now = new Date().toISOString();
        const result = this.sqlite
            .prepare(`UPDATE publish_jobs SET
          status = ?, strategy = ?, scheduled_at = ?, prewarm_at = ?,
          external_post_id = ?, external_container_id = ?, external_url = ?,
          metadata_snapshot_json = ?, retry_count = ?, next_retry_at = ?,
          last_error = ?, locked_until = ?, updated_at = ?, facebook_reel_json = ?
         WHERE id = ? AND (? IS NULL OR locked_until = ?)`)
            .run(patch.status ?? cur.status, patch.strategy ?? cur.strategy, patch.scheduledAt ?? cur.scheduledAt, patch.prewarmAt !== undefined ? patch.prewarmAt : cur.prewarmAt, patch.externalPostId !== undefined
            ? patch.externalPostId
            : cur.externalPostId, patch.externalContainerId !== undefined
            ? patch.externalContainerId
            : cur.externalContainerId, patch.externalUrl !== undefined ? patch.externalUrl : cur.externalUrl, patch.metadataSnapshot !== undefined
            ? JSON.stringify(patch.metadataSnapshot)
            : JSON.stringify(cur.metadataSnapshot), patch.retryCount !== undefined ? patch.retryCount : cur.retryCount, patch.nextRetryAt !== undefined ? patch.nextRetryAt : cur.nextRetryAt, patch.lastError !== undefined ? patch.lastError : cur.lastError, patch.lockedUntil !== undefined ? patch.lockedUntil : cur.lockedUntil, now, (patch.facebookReel ?? cur.facebookReel) ? JSON.stringify(patch.facebookReel ?? cur.facebookReel) : null, id, expectedLock ?? null, expectedLock ?? null);
        if (!result.changes)
            return null;
        this.recomputeContentStatus(cur.contentItemId);
        return this.getJob(id);
    }
    addJobLog(jobId, level, stage, message, details = null) {
        const id = `log_${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        this.sqlite
            .prepare(`INSERT INTO job_logs (id, job_id, level, stage, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(id, jobId, level, stage, message, details ? JSON.stringify(details) : null, now);
        return {
            id,
            jobId,
            level,
            stage,
            message,
            details,
            createdAt: now,
        };
    }
    listJobLogs(jobId) {
        const rows = plainList(this.sqlite
            .prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY created_at ASC')
            .all(jobId));
        return rows.map((r) => ({
            id: String(r.id),
            jobId: String(r.job_id),
            level: r.level,
            stage: String(r.stage),
            message: String(r.message),
            details: parseJson(r.details_json, null),
            createdAt: String(r.created_at),
        }));
    }
    mapJob(r) {
        const brief = parseJson(r.content_master_brief_json, {});
        const thumbs = parseJson(r.media_thumbnail_paths_json, []);
        const fallbackFilename = r.media_original_filename
            ? String(r.media_original_filename)
            : undefined;
        const topic = (typeof brief.topic === 'string' && brief.topic.trim()) ||
            (typeof brief.coverHeadline === 'string' && brief.coverHeadline.trim()) ||
            fallbackFilename;
        return {
            id: String(r.id),
            idempotencyKey: String(r.idempotency_key),
            contentItemId: String(r.content_item_id),
            channelId: String(r.channel_id),
            socialAccountId: String(r.social_account_id),
            platform: r.platform,
            format: r.format,
            strategy: r.strategy,
            scheduledAt: String(r.scheduled_at),
            prewarmAt: r.prewarm_at ? String(r.prewarm_at) : null,
            status: r.status,
            externalPostId: r.external_post_id ? String(r.external_post_id) : null,
            facebookReel: parseJson(r.facebook_reel_json, null),
            externalContainerId: r.external_container_id
                ? String(r.external_container_id)
                : null,
            externalUrl: r.external_url ? String(r.external_url) : null,
            metadataSnapshot: parseJson(r.metadata_snapshot_json, {}),
            retryCount: Number(r.retry_count ?? 0),
            maxRetries: Number(r.max_retries ?? 3),
            nextRetryAt: r.next_retry_at ? String(r.next_retry_at) : null,
            lastError: r.last_error ? String(r.last_error) : null,
            lockedUntil: r.locked_until ? String(r.locked_until) : null,
            createdAt: String(r.created_at),
            updatedAt: String(r.updated_at),
            accountName: r.account_name ? String(r.account_name) : undefined,
            connectionMode: r.connection_mode
                ? r.connection_mode
                : undefined,
            contentTopic: topic,
            contentTargetDate: r.content_target_date
                ? String(r.content_target_date)
                : undefined,
            mediaAssetId: r.content_media_asset_id
                ? String(r.content_media_asset_id)
                : undefined,
            hasCustomCover: Boolean(r.media_custom_cover_key),
            thumbnailFilename: thumbs[0] ?? null,
        };
    }
    // ---------- App Settings ----------
    getSettingRaw(key, envFallback = '') {
        const row = plain(this.sqlite
            .prepare('SELECT value_encrypted FROM app_settings WHERE key = ?')
            .get(key));
        if (row && typeof row.value_encrypted === 'string') {
            const dec = this.cipher.decrypt(row.value_encrypted);
            if (dec !== null)
                return dec;
        }
        return envFallback;
    }
    setSettingRaw(key, value) {
        const enc = this.cipher.encrypt(value) ?? '';
        const now = new Date().toISOString();
        this.sqlite
            .prepare(`INSERT INTO app_settings (key, value_encrypted, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`)
            .run(key, enc, now);
    }
    getSettingsFull() {
        const envProvider = (process.env.AI_PROVIDER || '').toUpperCase();
        const aiProvider = (this.getSettingRaw('aiProvider', envProvider) ||
            'NONE');
        return {
            aiProvider: aiProvider === 'GEMINI' || aiProvider === 'OPENAI' ? aiProvider : 'NONE',
            aiModel: this.getSettingRaw('aiModel', process.env.AI_MODEL ||
                (aiProvider === 'GEMINI' ? 'gemini-3.8-flash' : 'gpt-4o-mini')),
            aiBaseUrl: this.getSettingRaw('aiBaseUrl', process.env.AI_BASE_URL || ''),
            aiApiKey: this.getSettingRaw('aiApiKey', process.env.AI_API_KEY || ''),
            r2AccountId: this.getSettingRaw('r2AccountId', process.env.R2_ACCOUNT_ID || ''),
            r2AccessKeyId: this.getSettingRaw('r2AccessKeyId', process.env.R2_ACCESS_KEY_ID || ''),
            r2SecretAccessKey: this.getSettingRaw('r2SecretAccessKey', process.env.R2_SECRET_ACCESS_KEY || ''),
            r2BucketName: this.getSettingRaw('r2BucketName', process.env.R2_BUCKET_NAME || ''),
            r2PublicBaseUrl: this.getSettingRaw('r2PublicBaseUrl', process.env.R2_PUBLIC_BASE_URL || ''),
            unifiedApiBaseUrl: this.getSettingRaw('unifiedApiBaseUrl', process.env.UNIFIED_API_BASE_URL || ''),
            unifiedApiKey: this.getSettingRaw('unifiedApiKey', process.env.UNIFIED_API_KEY || ''),
            notificationWebhookUrl: this.getSettingRaw('notificationWebhookUrl', process.env.NOTIFICATION_WEBHOOK_URL || ''),
            maxChannels: Number(this.getSettingRaw('maxChannels', process.env.MAX_CHANNELS || '3') || 3),
            synccutDataDir: this.getSettingRaw('synccutDataDir', process.env.SYNCCUT_DATA_DIR ||
                'C:\\Users\\iamgr\\Desktop\\SyncCut\\.studio-data'),
            googleClientId: this.getSettingRaw('googleClientId', process.env.GOOGLE_CLIENT_ID || ''),
            googleClientSecret: this.getSettingRaw('googleClientSecret', process.env.GOOGLE_CLIENT_SECRET || ''),
            metaAppId: this.getSettingRaw('metaAppId', process.env.META_APP_ID || ''),
            metaAppSecret: this.getSettingRaw('metaAppSecret', process.env.META_APP_SECRET || ''),
            tiktokClientKey: this.getSettingRaw('tiktokClientKey', process.env.TIKTOK_CLIENT_KEY || ''),
            tiktokClientSecret: this.getSettingRaw('tiktokClientSecret', process.env.TIKTOK_CLIENT_SECRET || ''),
        };
    }
    getSettingsPublic() {
        const full = this.getSettingsFull();
        const synccutDbExists = Boolean(full.synccutDataDir &&
            fs.existsSync(path.join(full.synccutDataDir, 'studio.sqlite')));
        return {
            aiProvider: full.aiProvider,
            aiModel: full.aiModel,
            aiBaseUrl: full.aiBaseUrl,
            hasAiApiKey: Boolean(full.aiApiKey),
            hasR2Config: Boolean(full.r2AccountId &&
                full.r2AccessKeyId &&
                full.r2SecretAccessKey &&
                full.r2BucketName),
            r2AccountId: full.r2AccountId,
            r2BucketName: full.r2BucketName,
            r2PublicBaseUrl: full.r2PublicBaseUrl,
            unifiedApiBaseUrl: full.unifiedApiBaseUrl,
            hasUnifiedApiKey: Boolean(full.unifiedApiKey),
            notificationWebhookUrl: full.notificationWebhookUrl,
            maxChannels: full.maxChannels,
            synccutDataDir: full.synccutDataDir,
            synccutConnected: synccutDbExists,
            googleClientId: full.googleClientId,
            hasGoogleClientSecret: Boolean(full.googleClientSecret),
            metaAppId: full.metaAppId,
            hasMetaAppSecret: Boolean(full.metaAppSecret),
            tiktokClientKey: full.tiktokClientKey,
            hasTiktokClientSecret: Boolean(full.tiktokClientSecret),
        };
    }
    listExpiredMediaAssets(olderThanDays = 30) {
        const cutoffIso = new Date(Date.now() - Math.max(1, olderThanDays) * 24 * 60 * 60_000).toISOString();
        const rows = plainList(this.sqlite
            .prepare(`SELECT m.* FROM media_assets m
           WHERE m.created_at < ?
             AND EXISTS (
               SELECT 1 FROM content_items c
               JOIN publish_jobs j ON j.content_item_id = c.id
               WHERE c.media_asset_id = m.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM content_items c
               WHERE c.media_asset_id = m.id AND c.status IN ('DRAFT', 'SCHEDULED')
             )
             AND NOT EXISTS (
               SELECT 1 FROM content_items c
               JOIN publish_jobs j ON j.content_item_id = c.id
               WHERE c.media_asset_id = m.id
                 AND j.status NOT IN ('PUBLISHED', 'CANCELLED')
             )
             AND NOT EXISTS (
               SELECT 1 FROM content_items c
               JOIN publish_jobs j ON j.content_item_id = c.id
               WHERE c.media_asset_id = m.id
                 AND j.updated_at >= ?
             )`)
            .all(cutoffIso, cutoffIso));
        return rows.map((r) => this.mapMediaAsset(r));
    }
    backupToFile(destPath) {
        const escaped = destPath.replace(/'/g, "''");
        this.sqlite.exec(`VACUUM INTO '${escaped}'`);
    }
    updateSettings(patch) {
        const entries = Object.entries(patch);
        for (const [k, v] of entries) {
            if (v === undefined)
                continue;
            // Do not overwrite existing secret if UI sends empty string for secret field unless explicitly cleared
            this.setSettingRaw(k, String(v));
        }
        return this.getSettingsPublic();
    }
}
//# sourceMappingURL=database.js.map