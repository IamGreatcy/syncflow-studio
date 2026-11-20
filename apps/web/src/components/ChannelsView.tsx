import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { ConnectionMode, Platform, SocialAccount, ToneStyle } from '@clipflow/shared';
import { api, type ChannelWithAccounts } from '../api';
import { InsetGroup, InsetRow } from './AppleUI';
import { ConnectAccountModal } from './ConnectAccountModal';
import { PlatformPill } from './PlatformBadge';

interface Props {
  channels: ChannelWithAccounts[];
  activeChannel: ChannelWithAccounts;
  maxChannels: number;
  onSelectChannel: (id: string) => void;
  onReload: () => Promise<void>;
  onNotify?: (type: 'success' | 'error', text: string) => void;
}

export function ChannelsView({
  channels,
  activeChannel,
  maxChannels,
  onSelectChannel,
  onReload,
  onNotify,
}: Props) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#34C759');
  const [newTone, setNewTone] = useState<ToneStyle>('FRIENDLY');
  const [showAuditGuide, setShowAuditGuide] = useState(false);
  const [connectModalAccount, setConnectModalAccount] = useState<SocialAccount | null>(
    null
  );

  useEffect(() => {
    function handleOAuthMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        platform?: string;
        accountId?: string;
      } | null;
      if (data?.type === 'syncflow_oauth_done') {
        setConnectModalAccount(null);
        void Promise.resolve(onReload());
        onNotify?.(
          'success',
          `เชื่อมต่อ ${data.platform ?? 'แพลตฟอร์ม'} เรียบร้อยแล้ว`
        );
      }
    }
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [onReload, onNotify]);

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const res = await api.createChannel({
        name: newName.trim(),
        color: newColor,
        defaultTone: newTone,
      });
      setNewName('');
      await onReload();
      onSelectChannel(res.channel.id);
      onNotify?.('success', `สร้างช่อง "${res.channel.name}" เรียบร้อย`);
    } catch (error) {
      onNotify?.(
        'error',
        error instanceof Error ? error.message : String(error)
      );
    }
  }



  async function handleSyncTikTok(accountId: string) {
    try {
      await api.syncTikTokCreatorInfo(accountId);
      await onReload();
      onNotify?.('success', 'ซิงก์ข้อมูล TikTok Creator Info สำเร็จ');
    } catch (error) {
      onNotify?.(
        'error',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function handleAddAccount(platform: Platform) {
    await api.createAccount({
      channelId: activeChannel.id,
      platform,
      accountName: `${platform} (${activeChannel.name})`,
      connectionMode: 'SIMULATION',
    });
    await onReload();
    onNotify?.('success', `เพิ่มบัญชี ${platform} แล้ว`);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2 className="apple-title text-[22px] text-apple-label">
          ช่อง & การเชื่อมต่อ API
        </h2>
        <p className="text-[12.5px] text-apple-secondary">
          จัดการได้สูงสุด {maxChannels} ช่อง โดยแต่ละช่องมีชุดบัญชี ตารางเวลา และเทมเพลตแยกจากกัน
        </p>
      </div>

      {/* Channels Cards */}
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {channels.map((ch) => {
            const selected = ch.id === activeChannel.id;
            return (
              <div
                key={ch.id}
                onClick={() => onSelectChannel(ch.id)}
                className="apple-card cursor-pointer p-4 transition"
                style={{
                  borderColor: selected
                    ? 'var(--apple-blue)'
                    : 'var(--separator)',
                  boxShadow: selected
                    ? '0 0 0 2px rgba(0, 122, 255, 0.18)'
                    : undefined,
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: ch.color }}
                    />
                    <span className="text-[14px] font-semibold text-apple-label">
                      {ch.name}
                    </span>
                  </div>
                  {channels.length > 1 && (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api.deleteChannel(ch.id);
                        await onReload();
                        onNotify?.('success', `ลบช่อง "${ch.name}" แล้ว`);
                      }}
                      className="rounded-full p-1 text-apple-tertiary transition hover:text-apple-red"
                      title="ลบช่อง"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-[12px] text-apple-secondary">
                  {ch.timezone} • {ch.accounts.length} แพลตฟอร์ม
                </p>
              </div>
            );
          })}
        </div>

        {channels.length < maxChannels && (
          <form
            onSubmit={(e) => void handleCreateChannel(e)}
            className="apple-card flex flex-wrap items-end gap-3 p-4"
          >
            <div className="min-w-[200px] flex-1 space-y-1">
              <label className="text-[11.5px] font-medium text-apple-secondary">
                สร้างช่องใหม่ ({channels.length}/{maxChannels})
              </label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="เช่น ช่องที่ 2 — รีวิวไอที"
                className="apple-input"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11.5px] font-medium text-apple-secondary">
                สีประจำช่อง
              </label>
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                className="h-[34px] w-12 cursor-pointer rounded-[10px] border bg-apple-window p-0.5"
                style={{ borderColor: 'var(--separator-strong)' }}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11.5px] font-medium text-apple-secondary">
                โทนคำอธิบาย
              </label>
              <select
                value={newTone}
                onChange={(e) => setNewTone(e.target.value as ToneStyle)}
                className="apple-input w-auto"
              >
                <option value="FRIENDLY">Friendly</option>
                <option value="EDUCATIONAL">Educational</option>
                <option value="ENTERTAINING">Entertaining</option>
                <option value="PROFESSIONAL">Professional</option>
              </select>
            </div>
            <button type="submit" className="apple-btn-primary">
              <Plus className="h-4 w-4" />
              เพิ่มช่อง
            </button>
          </form>
        )}
      </div>

      {/* Connected Social Accounts */}
      <InsetGroup
        title={`การเชื่อมต่อแพลตฟอร์มของ "${activeChannel.name}"`}
        action={
          <div className="flex flex-wrap gap-1.5">
            {(['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'] as Platform[]).map(
              (p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void handleAddAccount(p)}
                  className="apple-btn-secondary py-1 px-2.5 text-[11px]"
                >
                  + {p}
                </button>
              )
            )}
          </div>
        }
      >
        {activeChannel.accounts.map((acc) => (
          <InsetRow
            key={acc.id}
            className="flex flex-wrap items-center justify-between gap-4"
          >
            <div className="space-y-1.5">
              <div className="flex items-center gap-2.5">
                <PlatformPill platform={acc.platform} />
                <input
                  defaultValue={acc.accountName}
                  onBlur={async (e) => {
                    if (e.target.value !== acc.accountName) {
                      await api.updateAccount(acc.id, {
                        accountName: e.target.value,
                      });
                      await onReload();
                    }
                  }}
                  className="rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-[13.5px] font-semibold text-apple-label transition hover:border-[var(--separator)] focus:border-apple-blue focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-apple-secondary">
                <label className="flex items-center gap-1.5">
                  <span>Account ID:</span>
                  <input
                    defaultValue={acc.externalAccountId}
                    onBlur={async (e) => {
                      if (e.target.value !== acc.externalAccountId) {
                        await api.updateAccount(acc.id, {
                          externalAccountId: e.target.value,
                        });
                        await onReload();
                      }
                    }}
                    className="apple-input w-36 py-0.5 px-2 text-[11.5px]"
                  />
                </label>
                <span>
                  OAuth:{' '}
                  {acc.hasAccessToken ? (
                    <strong className="text-apple-green">เชื่อมต่อแล้ว</strong>
                  ) : (
                    <span className="text-apple-tertiary">
                      โหมดทดสอบ (Simulation)
                    </span>
                  )}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={acc.connectionMode}
                onChange={async (e) => {
                  await api.updateAccount(acc.id, {
                    connectionMode: e.target.value as ConnectionMode,
                  });
                  await onReload();
                }}
                className="apple-input w-auto py-1.5 text-[12px]"
              >
                <option value="SIMULATION">Simulation (ทดสอบ)</option>
                <option value="LIVE_OFFICIAL">Official API (ตรง)</option>
                <option value="UNIFIED_API">Unified API (ตัวกลาง)</option>
              </select>

              {acc.platform === 'TIKTOK' && (
                <select
                  value={acc.config.tiktokMode ?? 'DIRECT_POST'}
                  onChange={async (e) => {
                    await api.updateAccount(acc.id, {
                      config: { ...acc.config, tiktokMode: e.target.value },
                    });
                    await onReload();
                  }}
                  className="apple-input w-auto py-1.5 text-[12px]"
                >
                  <option value="DIRECT_POST">Direct Post (JIT)</option>
                  <option value="INBOX_DRAFT">Inbox Draft (ล่วงหน้า)</option>
                </select>
              )}

              <button
                type="button"
                onClick={() => setConnectModalAccount(acc)}
                className="apple-btn-secondary py-1.5 px-3 text-[12px]"
              >
                <Link2 className="h-3.5 w-3.5 text-apple-blue" />
                เชื่อมต่อบัญชี
              </button>

              {acc.platform === 'TIKTOK' && (
                <button
                  type="button"
                  onClick={() => void handleSyncTikTok(acc.id)}
                  className="apple-btn-secondary p-1.5"
                  title="Sync TikTok Creator Info"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              )}

              <button
                type="button"
                onClick={async () => {
                  await api.deleteAccount(acc.id);
                  await onReload();
                }}
                className="rounded-full p-1.5 text-apple-tertiary transition hover:text-apple-red"
                title="ลบบัญชี"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </InsetRow>
        ))}
      </InsetGroup>

      {/* Collapsible Audit Guide */}
      <div className="apple-card overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAuditGuide((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3.5 text-left transition hover:bg-apple-hover"
        >
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-apple-green" />
            <span className="apple-headline text-[14px] text-apple-label">
              คู่มือเตรียมผ่าน Official API Audit (YouTube • Meta • TikTok)
            </span>
          </div>
          {showAuditGuide ? (
            <ChevronUp className="h-4 w-4 text-apple-secondary" />
          ) : (
            <ChevronDown className="h-4 w-4 text-apple-secondary" />
          )}
        </button>

        {showAuditGuide && (
          <div
            className="grid grid-cols-1 gap-3 border-t p-4 text-[12px] md:grid-cols-2"
            style={{ borderColor: 'var(--separator)' }}
          >
            <div className="rounded-[12px] bg-apple-grouped/60 p-3.5 space-y-1">
              <p className="font-semibold text-apple-red">YouTube Data API v3</p>
              <p className="text-apple-secondary">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-apple-green" />
                Resumable Upload + <code>publishAt</code> ตั้งเวลาล่วงหน้าได้ 100 คลิป/วัน (ยื่น Verification/Audit เพื่อปลดล็อกสถานะ Public)
              </p>
            </div>
            <div className="rounded-[12px] bg-apple-grouped/60 p-3.5 space-y-1">
              <p className="font-semibold text-apple-teal">
                TikTok Content Posting API v2
              </p>
              <p className="text-apple-secondary">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-apple-green" />
                หน้าจอครบตาม TikTok UX Guidelines และสลับเป็น <code>INBOX_DRAFT</code> หรือ <code>UNIFIED_API</code> ระหว่างรอ Audit ได้
              </p>
            </div>
            <div className="rounded-[12px] bg-apple-grouped/60 p-3.5 space-y-1">
              <p className="font-semibold text-apple-pink">
                Instagram Graph API
              </p>
              <p className="text-apple-secondary">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-apple-green" />
                Container หมดอายุใน 24 ชม. ระบบจึงทำ JIT Pre-warm ล่วงหน้า 12 นาทีให้โดยอัตโนมัติ
              </p>
            </div>
            <div className="rounded-[12px] bg-apple-grouped/60 p-3.5 space-y-1">
              <p className="font-semibold text-apple-blue">
                Facebook Graph API
              </p>
              <p className="text-apple-secondary">
                <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-apple-green" />
                Pre-upload Reels ได้สูงสุด 29 วัน (ไม่เกิน 90 วิ) และ Page Video ได้ถึง 6 เดือน
              </p>
            </div>
          </div>
        )}
      </div>

      {connectModalAccount && (
        <ConnectAccountModal
          account={connectModalAccount}
          onClose={() => setConnectModalAccount(null)}
          onSuccess={onReload}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}
