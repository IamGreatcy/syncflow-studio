import type {
  AppSettingsPublic,
  Channel,
  ContentFormat,
  ContentItem,
  JobLog,
  JobStatus,
  MasterBrief,
  MediaAsset,
  MetadataTemplate,
  MetaDiscoveredPage,
  PlatformMetadataMap,
  PublishJob,
  ResolvedSlot,
  ScheduleRule,
  SocialAccount,
  SyncCutEpisodeSummary,
  SyncCutImportResponse,
  ToneStyle,
  ValidationIssue,
} from '@clipflow/shared';

export interface ChannelWithAccounts extends Channel {
  accounts: SocialAccount[];
}

export interface MediaUploadResponse {
  asset: MediaAsset;
  detection: {
    orientation: 'VERTICAL' | 'SQUARE' | 'HORIZONTAL';
    clipCategory: 'SHORT' | 'LONG';
    recommendedFormats: ContentFormat[];
  };
  warningsByFormat: Record<ContentFormat, ValidationIssue[]>;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(
        res.ok
          ? `เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง: ${text.slice(0, 120)}`
          : `เซิร์ฟเวอร์ตอบกลับ (${res.status}): ${text.slice(0, 120)} — หากเพิ่งอัปเดตโปรแกรม กรุณารีสตาร์ทเซิร์ฟเวอร์`
      );
    }
  }
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : data.error
          ? JSON.stringify(data.error)
          : `Request failed (${res.status})`
    );
  }
  return data as T;
}

export const api = {
  health: () =>
    req<{
      ok: boolean;
      tools: { ffmpeg: string | null; ffprobe: string | null };
      stats: {
        channels: number;
        totalJobs: number;
        queuedJobs: number;
        nativeScheduledJobs: number;
        publishedJobs: number;
        failedJobs: number;
      };
      schedulerLastTickAt: string | null;
    }>('/api/health'),

  listChannels: () => req<{ channels: ChannelWithAccounts[] }>('/api/channels'),

  createChannel: (payload: {
    name: string;
    color?: string;
    timezone?: string;
    description?: string;
    defaultTone?: ToneStyle;
  }) =>
    req<{ channel: ChannelWithAccounts }>('/api/channels', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateChannel: (id: string, payload: Partial<Channel>) =>
    req<{ channel: Channel }>(`/api/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteChannel: (id: string) =>
    req<{ ok: boolean }>(`/api/channels/${id}`, { method: 'DELETE' }),

  createAccount: (payload: Record<string, unknown>) =>
    req<{ account: SocialAccount }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateAccount: (id: string, payload: Record<string, unknown>) =>
    req<{ account: SocialAccount }>(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteAccount: (id: string) =>
    req<{ ok: boolean }>(`/api/accounts/${id}`, { method: 'DELETE' }),

  getOAuthUrl: (id: string, redirectUri?: string) => {
    const qs = redirectUri
      ? `?redirectUri=${encodeURIComponent(redirectUri)}`
      : '';
    return req<{ url: string; callbackUrl: string }>(
      `/api/accounts/${id}/oauth-url${qs}`
    );
  },

  completeOAuthUrl: (
    id: string,
    payload: { redirectedUrl: string; redirectUri?: string }
  ) =>
    req<{ connected: boolean; account: SocialAccount; accounts: SocialAccount[] }>(
      `/api/accounts/${id}/oauth-complete-url`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  connectAccountToken: (
    id: string,
    payload: {
      accessToken: string;
      refreshToken?: string;
      alsoLinkPairedMeta?: boolean;
    }
  ) =>
    req<{
      connected?: boolean;
      needsPageSelection?: boolean;
      sessionId?: string;
      pages?: MetaDiscoveredPage[];
      linked?: string[];
      accounts?: SocialAccount[];
    }>(`/api/accounts/${id}/connect-token`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  selectMetaPage: (
    id: string,
    payload: {
      sessionId: string;
      pageId: string;
      alsoLinkPairedMeta?: boolean;
    }
  ) =>
    req<{
      connected: boolean;
      linked: string[];
      accounts: SocialAccount[];
    }>(`/api/accounts/${id}/select-meta-page`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  syncTikTokCreatorInfo: (id: string) =>
    req<{ creatorInfo: unknown; account: SocialAccount }>(
      `/api/accounts/${id}/creator-info`,
      { method: 'POST' }
    ),

  refreshAccountToken: (id: string) =>
    req<{ ok: boolean; account?: SocialAccount }>(
      `/api/accounts/${id}/refresh-token`,
      { method: 'POST' }
    ),

  getScheduleRules: (channelId: string) =>
    req<{ rules: ScheduleRule[] }>(
      `/api/channels/${channelId}/schedule-rules`
    ),

  saveScheduleRules: (
    channelId: string,
    rules: Array<Omit<ScheduleRule, 'id' | 'channelId' | 'createdAt'>>
  ) =>
    req<{ rules: ScheduleRule[] }>(
      `/api/channels/${channelId}/schedule-rules`,
      {
        method: 'PUT',
        body: JSON.stringify({ rules }),
      }
    ),

  resolveSlots: (
    channelId: string,
    targetDate: string,
    clipCategory: 'SHORT' | 'LONG'
  ) =>
    req<{ slots: ResolvedSlot[] }>(`/api/channels/${channelId}/resolve-slots`, {
      method: 'POST',
      body: JSON.stringify({ targetDate, clipCategory }),
    }),

  listTemplates: (channelId: string) =>
    req<{ templates: MetadataTemplate[] }>(
      `/api/templates?channelId=${encodeURIComponent(channelId)}`
    ),

  saveTemplate: (payload: Partial<MetadataTemplate> & { channelId: string; format: ContentFormat; name: string }) =>
    req<{ template: MetadataTemplate }>('/api/templates', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  listMedia: (channelId: string) =>
    req<{ assets: MediaAsset[] }>(
      `/api/media?channelId=${encodeURIComponent(channelId)}`
    ),

  uploadMediaWithProgress: (
    channelId: string,
    file: File,
    onProgress: (pct: number) => void
  ): Promise<MediaUploadResponse> => {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('channelId', channelId);
      form.append('video', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media/upload');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          onProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed as MediaUploadResponse);
          } else {
            reject(new Error(parsed.error || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error while uploading video'));
      xhr.send(form);
    });
  },

  optimizeMedia: (id: string) =>
    req<{
      action: string;
      asset: MediaAsset;
      detection: MediaUploadResponse['detection'];
      warningsByFormat: Record<ContentFormat, ValidationIssue[]>;
    }>(`/api/media/${id}/optimize`, { method: 'POST' }),

  generateMetadata: (payload: {
    channelId: string;
    mediaAssetId?: string;
    formats: ContentFormat[];
    brief: MasterBrief;
  }) =>
    req<{
      metadata: PlatformMetadataMap;
      engineUsed: string;
      warning?: string;
      issues: ValidationIssue[];
    }>('/api/metadata/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  validateMetadata: (payload: {
    mediaAssetId?: string;
    formats: ContentFormat[];
    platformMetadata: PlatformMetadataMap;
  }) =>
    req<{ issues: ValidationIssue[] }>('/api/metadata/validate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listContents: (channelId: string, fromDate?: string, toDate?: string) => {
    const qs = new URLSearchParams({ channelId });
    if (fromDate) qs.set('fromDate', fromDate);
    if (toDate) qs.set('toDate', toDate);
    return req<{ contents: ContentItem[] }>(`/api/contents?${qs.toString()}`);
  },

  getContent: (id: string) =>
    req<{ content: ContentItem }>(`/api/contents/${id}`),

  uploadCustomCover: async (assetId: string, file: File) => {
    const form = new FormData();
    form.append('cover', file);
    const res = await fetch(`/api/media/${assetId}/cover`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Cover upload failed');
    return data as { asset: MediaAsset };
  },

  listSyncCutEpisodes: () =>
    req<{
      connected: boolean;
      dataDir: string;
      episodes: SyncCutEpisodeSummary[];
    }>('/api/integrations/synccut/episodes'),

  importSyncCutEpisode: (payload: {
    channelId: string;
    episodeId: string;
    exportId?: string;
  }) =>
    req<SyncCutImportResponse>('/api/integrations/synccut/import-episode', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  createContent: (payload: {
    channelId: string;
    mediaAssetId: string;
    targetDate: string;
    masterBrief: MasterBrief;
    platformMetadata: PlatformMetadataMap;
    targets: Array<{
      socialAccountId: string;
      format: ContentFormat;
      localTime: string;
      targetDate?: string;
      scheduledAtIso?: string;
      allowImmediate?: boolean;
    }>;
    allowImmediate?: boolean;
  }) =>
    req<{ content: ContentItem }>('/api/contents', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  rescheduleContent: (id: string, targetDate: string) =>
    req<{ content: ContentItem }>(`/api/contents/${id}/reschedule`, {
      method: 'PATCH',
      body: JSON.stringify({ targetDate }),
    }),

  deleteContent: (id: string) =>
    req<{ ok: boolean }>(`/api/contents/${id}`, { method: 'DELETE' }),

  listJobs: (channelId?: string, status?: JobStatus) => {
    const qs = new URLSearchParams();
    if (channelId) qs.set('channelId', channelId);
    if (status) qs.set('status', status);
    return req<{ jobs: PublishJob[] }>(`/api/jobs?${qs.toString()}`);
  },

  getJobLogs: (jobId: string) =>
    req<{ logs: JobLog[] }>(`/api/jobs/${jobId}/logs`),

  runJobNow: (jobId: string) =>
    req<{ job: PublishJob; logs: JobLog[] }>(`/api/jobs/${jobId}/run-now`, {
      method: 'POST',
    }),

  retryJob: (jobId: string) =>
    req<{ job: PublishJob }>(`/api/jobs/${jobId}/retry`, { method: 'POST' }),

  cancelJob: (jobId: string) =>
    req<{ job: PublishJob }>(`/api/jobs/${jobId}/cancel`, { method: 'POST' }),

  tickScheduler: () =>
    req<{ processed: number; results: Array<{ jobId: string; status: string }> }>(
      '/api/scheduler/tick',
      { method: 'POST' }
    ),

  getSettings: () => req<{ settings: AppSettingsPublic }>('/api/settings'),

  updateSettings: (payload: Record<string, unknown>) =>
    req<{ settings: AppSettingsPublic }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
};
