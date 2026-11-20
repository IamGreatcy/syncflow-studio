import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import {
  CONTENT_FORMATS,
  type AppSettingsPublic,
  type ContentFormat,
  type MetadataTemplate,
} from '@clipflow/shared';
import { api, type ChannelWithAccounts } from '../api';
import { InsetGroup, InsetRow, SegmentedControl } from './AppleUI';
import { FORMAT_LABELS } from './PlatformBadge';

interface Props {
  channel: ChannelWithAccounts;
  onSettingsUpdated: () => Promise<void>;
  onNotify?: (type: 'success' | 'error', text: string) => void;
}

export function TemplatesSettingsView({
  channel,
  onSettingsUpdated,
  onNotify,
}: Props) {
  const [subTab, setSubTab] = useState<'templates' | 'preferences'>(
    'templates'
  );
  const [templates, setTemplates] = useState<MetadataTemplate[]>([]);
  const [selectedFmt, setSelectedFmt] =
    useState<ContentFormat>('YOUTUBE_SHORTS');
  const [settings, setSettings] = useState<AppSettingsPublic | null>(null);

  const [aiApiKey, setAiApiKey] = useState('');
  const [r2AccessKeyId, setR2AccessKeyId] = useState('');
  const [r2SecretAccessKey, setR2SecretAccessKey] = useState('');
  const [unifiedApiKey, setUnifiedApiKey] = useState('');

  useEffect(() => {
    void api.listTemplates(channel.id).then((res) => setTemplates(res.templates));
    void api.getSettings().then((res) => setSettings(res.settings));
  }, [channel.id]);

  const activeTemplate = templates.find((t) => t.format === selectedFmt) ?? {
    id: '',
    channelId: channel.id,
    format: selectedFmt,
    name: `เทมเพลต ${FORMAT_LABELS[selectedFmt]}`,
    titlePrefix: '',
    titleSuffix: '',
    descriptionHeader: '',
    descriptionFooter: '',
    defaultHashtags: [],
    defaultTags: [],
    defaultCta: '',
    platformDefaults: {},
    updatedAt: '',
  };

  function updateLocalTemplate(patch: Partial<MetadataTemplate>) {
    setTemplates((prev) => {
      const idx = prev.findIndex((t) => t.format === selectedFmt);
      const next = { ...activeTemplate, ...patch };
      if (idx === -1) return [...prev, next];
      return prev.map((t, i) => (i === idx ? next : t));
    });
  }

  async function saveTemplate() {
    try {
      await api.saveTemplate({
        channelId: channel.id,
        format: selectedFmt,
        name: activeTemplate.name,
        titlePrefix: activeTemplate.titlePrefix,
        titleSuffix: activeTemplate.titleSuffix,
        descriptionHeader: activeTemplate.descriptionHeader,
        descriptionFooter: activeTemplate.descriptionFooter,
        defaultHashtags: activeTemplate.defaultHashtags,
        defaultTags: activeTemplate.defaultTags,
        defaultCta: activeTemplate.defaultCta,
      });
      onNotify?.(
        'success',
        `บันทึกเทมเพลต ${FORMAT_LABELS[selectedFmt]} เรียบร้อย`
      );
    } catch (err) {
      onNotify?.('error', err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    try {
      const payload: Record<string, unknown> = {
        aiProvider: settings.aiProvider,
        aiModel: settings.aiModel,
        aiBaseUrl: settings.aiBaseUrl,
        r2AccountId: settings.r2AccountId,
        r2BucketName: settings.r2BucketName,
        r2PublicBaseUrl: settings.r2PublicBaseUrl,
        unifiedApiBaseUrl: settings.unifiedApiBaseUrl,
        notificationWebhookUrl: settings.notificationWebhookUrl,
        maxChannels: settings.maxChannels,
        synccutDataDir: settings.synccutDataDir,
      };
      if (aiApiKey) payload.aiApiKey = aiApiKey;
      if (r2AccessKeyId) payload.r2AccessKeyId = r2AccessKeyId;
      if (r2SecretAccessKey) payload.r2SecretAccessKey = r2SecretAccessKey;
      if (unifiedApiKey) payload.unifiedApiKey = unifiedApiKey;

      const res = await api.updateSettings(payload);
      setSettings(res.settings);
      setAiApiKey('');
      setR2AccessKeyId('');
      setR2SecretAccessKey('');
      setUnifiedApiKey('');
      await onSettingsUpdated();
      onNotify?.('success', 'บันทึกการตั้งค่าระบบเรียบร้อย');
    } catch (err) {
      onNotify?.('error', err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="apple-title text-[22px] text-apple-label">
            เทมเพลต & การตั้งค่า
          </h2>
          <p className="text-[12.5px] text-apple-secondary">
            กำหนดรูปแบบคำอธิบายประจำช่อง และเชื่อมต่อ AI / Cloudflare R2 / Webhook
          </p>
        </div>

        <SegmentedControl
          size="sm"
          value={subTab}
          onChange={setSubTab}
          options={[
            { value: 'templates', label: 'เทมเพลตคำอธิบาย' },
            { value: 'preferences', label: 'AI, Storage & แจ้งเตือน' },
          ]}
        />
      </div>

      {subTab === 'templates' && (
        <div className="space-y-4">
          <SegmentedControl
            size="sm"
            value={selectedFmt}
            onChange={setSelectedFmt}
            options={CONTENT_FORMATS.map((fmt) => ({
              value: fmt,
              label: FORMAT_LABELS[fmt],
            }))}
          />

          <InsetGroup title={`เทมเพลต ${FORMAT_LABELS[selectedFmt]} — ${channel.name}`}>
            <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-apple-secondary">
                  Title Prefix (คำนำหน้าชื่อ)
                </label>
                <input
                  value={activeTemplate.titlePrefix}
                  onChange={(e) =>
                    updateLocalTemplate({ titlePrefix: e.target.value })
                  }
                  placeholder="เช่น [EP.1] "
                  className="apple-input"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-apple-secondary">
                  Title Suffix (คำต่อท้ายชื่อ)
                </label>
                <input
                  value={activeTemplate.titleSuffix}
                  onChange={(e) =>
                    updateLocalTemplate({ titleSuffix: e.target.value })
                  }
                  placeholder="เช่น | ชื่อช่อง"
                  className="apple-input"
                />
              </div>
            </InsetRow>
            <InsetRow className="space-y-1.5">
              <label className="text-[12px] font-medium text-apple-secondary">
                ส่วนหัวคำอธิบาย (Header)
              </label>
              <textarea
                rows={2}
                value={activeTemplate.descriptionHeader}
                onChange={(e) =>
                  updateLocalTemplate({ descriptionHeader: e.target.value })
                }
                className="apple-input"
              />
            </InsetRow>
            <InsetRow className="space-y-1.5">
              <label className="text-[12px] font-medium text-apple-secondary">
                ส่วนท้ายคำอธิบาย / ลิงก์ติดต่องาน (Footer)
              </label>
              <textarea
                rows={3}
                value={activeTemplate.descriptionFooter}
                onChange={(e) =>
                  updateLocalTemplate({ descriptionFooter: e.target.value })
                }
                className="apple-input"
              />
            </InsetRow>
            <InsetRow className="space-y-1.5">
              <label className="text-[12px] font-medium text-apple-secondary">
                Default Call to Action
              </label>
              <input
                value={activeTemplate.defaultCta}
                onChange={(e) =>
                  updateLocalTemplate({ defaultCta: e.target.value })
                }
                className="apple-input"
              />
            </InsetRow>
            <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-apple-secondary">
                  Default Hashtags (เว้นวรรค)
                </label>
                <input
                  value={activeTemplate.defaultHashtags.join(' ')}
                  onChange={(e) =>
                    updateLocalTemplate({
                      defaultHashtags: e.target.value
                        .split(/\s+/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  className="apple-input"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-apple-secondary">
                  Default Tags (คั่นด้วย ,)
                </label>
                <input
                  value={activeTemplate.defaultTags.join(', ')}
                  onChange={(e) =>
                    updateLocalTemplate({
                      defaultTags: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  className="apple-input"
                />
              </div>
            </InsetRow>
          </InsetGroup>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void saveTemplate()}
              className="apple-btn-primary"
            >
              <Save className="h-4 w-4" />
              บันทึกเทมเพลตนี้
            </button>
          </div>
        </div>
      )}

      {subTab === 'preferences' && settings && (
        <form onSubmit={(e) => void saveSettings(e)} className="space-y-5">
          <InsetGroup title="AI Metadata Generator (เข้ารหัส AES-256-GCM)">
            <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-apple-secondary">
                  ผู้ให้บริการ AI
                </label>
                <select
                  value={settings.aiProvider}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      aiProvider: e.target.value as AppSettingsPublic['aiProvider'],
                    })
                  }
                  className="apple-input"
                >
                  <option value="NONE">Smart Rule Engine (ออฟไลน์ 100%)</option>
                  <option value="GEMINI">Google Gemini API</option>
                  <option value="OPENAI">OpenAI / Compatible API</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-apple-secondary">
                  Model
                </label>
                <input
                  value={settings.aiModel}
                  onChange={(e) =>
                    setSettings({ ...settings, aiModel: e.target.value })
                  }
                  placeholder="เช่น gemini-3.8-flash"
                  className="apple-input"
                />
              </div>
            </InsetRow>
            <InsetRow className="space-y-1">
              <label className="text-[12px] font-medium text-apple-secondary">
                API Key
              </label>
              <input
                type="password"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder={
                  settings.hasAiApiKey
                    ? '•••••••• (มีคีย์บันทึกไว้แล้ว — พิมพ์ใหม่เพื่อเปลี่ยน)'
                    : 'ใส่ Gemini หรือ OpenAI API Key'
                }
                className="apple-input"
              />
            </InsetRow>
          </InsetGroup>

          <InsetGroup title="Cloudflare R2 Storage (Optional — Egress \$0)">
            <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                value={settings.r2AccountId}
                onChange={(e) =>
                  setSettings({ ...settings, r2AccountId: e.target.value })
                }
                placeholder="R2 Account ID"
                className="apple-input"
              />
              <input
                value={settings.r2BucketName}
                onChange={(e) =>
                  setSettings({ ...settings, r2BucketName: e.target.value })
                }
                placeholder="Bucket Name"
                className="apple-input"
              />
            </InsetRow>
            <InsetRow>
              <input
                value={settings.r2PublicBaseUrl}
                onChange={(e) =>
                  setSettings({ ...settings, r2PublicBaseUrl: e.target.value })
                }
                placeholder="Public URL (เช่น https://media.yourdomain.com)"
                className="apple-input"
              />
            </InsetRow>
            <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                type="password"
                value={r2AccessKeyId}
                onChange={(e) => setR2AccessKeyId(e.target.value)}
                placeholder={
                  settings.hasR2Config ? 'Access Key (ตั้งไว้แล้ว)' : 'Access Key ID'
                }
                className="apple-input"
              />
              <input
                type="password"
                value={r2SecretAccessKey}
                onChange={(e) => setR2SecretAccessKey(e.target.value)}
                placeholder={
                  settings.hasR2Config ? 'Secret Key (ตั้งไว้แล้ว)' : 'Secret Access Key'
                }
                className="apple-input"
              />
            </InsetRow>
          </InsetGroup>

          <InsetGroup title="SyncCut Studio Integration">
            <InsetRow className="space-y-1.5">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-medium text-apple-secondary">
                  โฟลเดอร์ข้อมูล SyncCut (.studio-data)
                </span>
                <span
                  className="font-semibold"
                  style={{
                    color: settings.synccutConnected
                      ? 'var(--apple-green)'
                      : 'var(--apple-orange)',
                  }}
                >
                  {settings.synccutConnected ? 'เชื่อมต่อแล้ว ✓' : 'ไม่พบไฟล์'}
                </span>
              </div>
              <input
                value={settings.synccutDataDir}
                onChange={(e) =>
                  setSettings({ ...settings, synccutDataDir: e.target.value })
                }
                placeholder="C:\Users\...\SyncCut\.studio-data"
                className="apple-input"
              />
            </InsetRow>
          </InsetGroup>

          <InsetGroup title="Unified API & Webhook แจ้งเตือน">
            <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                value={settings.unifiedApiBaseUrl}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    unifiedApiBaseUrl: e.target.value,
                  })
                }
                placeholder="Unified API Base URL"
                className="apple-input"
              />
              <input
                type="password"
                value={unifiedApiKey}
                onChange={(e) => setUnifiedApiKey(e.target.value)}
                placeholder={
                  settings.hasUnifiedApiKey ? 'Key (ตั้งไว้แล้ว)' : 'Unified API Key'
                }
                className="apple-input"
              />
            </InsetRow>
            <InsetRow>
              <input
                value={settings.notificationWebhookUrl}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    notificationWebhookUrl: e.target.value,
                  })
                }
                placeholder="Discord / Slack / Custom Webhook URL เมื่อเกิด Error"
                className="apple-input"
              />
            </InsetRow>
          </InsetGroup>

          <div className="flex justify-end">
            <button type="submit" className="apple-btn-primary">
              <Save className="h-4 w-4" />
              บันทึกการตั้งค่าระบบ
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
