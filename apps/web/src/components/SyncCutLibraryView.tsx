import { useState } from 'react';
import {
  Clapperboard,
  FolderOpen,
  Image as ImageIcon,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type {
  SyncCutEpisodeSummary,
  SyncCutImportResponse,
} from '@clipflow/shared';
import { api, type ChannelWithAccounts } from '../api';

interface Props {
  channel: ChannelWithAccounts;
  connected: boolean;
  dataDir: string;
  episodes: SyncCutEpisodeSummary[];
  onRefresh: () => Promise<void>;
  onImported: (result: SyncCutImportResponse, targetDate: string) => void;
  onOpenSettings: () => void;
  onNotify?: (type: 'success' | 'error', text: string) => void;
}

export function SyncCutLibraryView({
  channel,
  connected,
  dataDir,
  episodes,
  onRefresh,
  onImported,
  onOpenSettings,
  onNotify,
}: Props) {
  const [targetDate, setTargetDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [importingId, setImportingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const readyEpisodes = episodes.filter((e) => e.hasVideo);
  const pendingEpisodes = episodes.filter((e) => !e.hasVideo);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleImport(ep: SyncCutEpisodeSummary) {
    setImportingId(ep.episodeId);
    try {
      const res = await api.importSyncCutEpisode({
        channelId: channel.id,
        episodeId: ep.episodeId,
        exportId: ep.exportId ?? undefined,
      });
      onImported(res, targetDate);
    } catch (err) {
      onNotify?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setImportingId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="apple-title text-[22px] text-apple-label">
            นำเข้าคลิป & หน้าปกจาก SyncCut Studio
          </h2>
          <p className="text-[12.5px] text-apple-secondary">
            ดึงวิดีโอที่ตัดต่อเสร็จ พร้อมหน้าปก (cover.png), บทพูด, Sources และ Timestamp เพื่อสร้างชื่อและคำอธิบายทุกแพลตฟอร์มอัตโนมัติ
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2 rounded-full border bg-apple-card px-3 py-1.5 text-[12px]" style={{ borderColor: 'var(--separator)' }}>
            <span className="text-apple-secondary">วันลงเป้าหมาย:</span>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="bg-transparent font-semibold text-apple-label tabular-nums focus:outline-none"
            />
          </label>

          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="apple-btn-secondary"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-apple-blue ${
                refreshing ? 'animate-spin' : ''
              }`}
            />
            รีเฟรช
          </button>
        </div>
      </div>

      {/* Connection Banner */}
      <div className="apple-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5 text-[12.5px]">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: connected
                ? 'var(--apple-green)'
                : 'var(--apple-orange)',
            }}
          />
          <span className="font-medium text-apple-label">
            {connected
              ? `เชื่อมต่อ SyncCut Studio แล้ว (${readyEpisodes.length} คลิปพร้อมเผยแพร่)`
              : 'ไม่พบฐานข้อมูล SyncCut Studio (studio.sqlite)'}
          </span>
          <span className="hidden text-apple-tertiary sm:inline">
            • {dataDir}
          </span>
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-apple-blue hover:underline"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          ตั้งค่าโฟลเดอร์ SyncCut
        </button>
      </div>

      {!connected ? (
        <div className="apple-card p-10 text-center space-y-2">
          <Clapperboard className="mx-auto h-9 w-9 text-apple-tertiary" />
          <p className="apple-headline text-[15px] text-apple-label">
            ยังไม่ได้เชื่อมต่อโฟลเดอร์ SyncCut Studio
          </p>
          <p className="text-[12.5px] text-apple-secondary">
            ตรวจสอบพาธของ <code>.studio-data</code> ในหน้าตั้งค่าเพื่อให้ SyncFlow Studio อ่านคลิปที่ตัดต่อเสร็จแบบอัตโนมัติ
          </p>
        </div>
      ) : readyEpisodes.length === 0 ? (
        <div className="apple-card p-10 text-center space-y-2">
          <Clapperboard className="mx-auto h-9 w-9 text-apple-tertiary" />
          <p className="apple-headline text-[15px] text-apple-label">
            ยังไม่มีคลิปที่ Export เสร็จใน SyncCut Studio
          </p>
          <p className="text-[12.5px] text-apple-secondary">
            เมื่อ Export คลิปใน SyncCut Studio เสร็จแล้ว กดปุ่มรีเฟรชเพื่อนำเข้าได้ทันที
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {readyEpisodes.map((ep) => {
            const isBusy = importingId === ep.episodeId;
            return (
              <div
                key={ep.episodeId}
                className="apple-card flex flex-col overflow-hidden transition hover:shadow-apple-popover"
              >
                {/* Cover Artwork Preview */}
                <div className="relative h-52 w-full bg-black/90">
                  {ep.hasCover ? (
                    <img
                      src={`/api/integrations/synccut/episodes/${ep.episodeId}/cover${
                        ep.exportId
                          ? `?exportId=${encodeURIComponent(ep.exportId)}`
                          : ''
                      }`}
                      alt={ep.cleanTitle}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-400">
                      <ImageIcon className="h-8 w-8" />
                    </div>
                  )}

                  <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
                    <span className="apple-glass rounded-full border px-2 py-0.5 text-[10.5px] font-semibold text-apple-label tabular-nums">
                      {ep.aspectRatio}
                    </span>
                    {ep.durationSec !== null && (
                      <span className="apple-glass rounded-full border px-2 py-0.5 text-[10.5px] font-semibold text-apple-label tabular-nums">
                        {Math.round(ep.durationSec)}s
                      </span>
                    )}
                  </div>

                  {ep.hasCover && (
                    <span
                      className="absolute right-2.5 top-2.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold text-white"
                      style={{ backgroundColor: 'rgba(52, 199, 89, 0.9)' }}
                    >
                      มีหน้าปก ✓
                    </span>
                  )}
                </div>

                {/* Episode Info */}
                <div className="flex flex-1 flex-col justify-between space-y-3 p-4">
                  <div className="space-y-1.5">
                    {ep.coverKicker && (
                      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-apple-blue">
                        {ep.coverKicker}
                      </span>
                    )}
                    <h3 className="apple-headline line-clamp-2 text-[14px] text-apple-label">
                      {ep.cleanTitle}
                    </h3>
                    {ep.coverSubline && (
                      <p className="text-[11.5px] font-medium text-apple-secondary">
                        {ep.coverSubline}
                      </p>
                    )}
                    {ep.narrationPreview && (
                      <p className="line-clamp-2 text-[11.5px] text-apple-tertiary">
                        “{ep.narrationPreview}”
                      </p>
                    )}
                  </div>

                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between text-[11px] text-apple-tertiary tabular-nums">
                      <span>{ep.shotCount} ช็อต</span>
                      {ep.version && <span>Export v{ep.version}</span>}
                    </div>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleImport(ep)}
                      className="apple-btn-primary w-full"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {isBusy
                        ? 'กำลังนำเข้า & สร้างคำอธิบาย...'
                        : 'นำเข้า & สร้างคำอธิบายทุกแพลตฟอร์ม'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingEpisodes.length > 0 && (
        <p className="text-[11.5px] text-apple-tertiary">
          มีอีก {pendingEpisodes.length} ตอนใน SyncCut Studio ที่ยังไม่ได้ Export วิดีโอเสร็จสมบูรณ์
        </p>
      )}
    </div>
  );
}
