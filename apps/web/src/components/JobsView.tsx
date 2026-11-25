import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  Film,
  History,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  ContentItem,
  JobLog,
  JobStatus,
  Platform,
  PublishJob,
} from '@clipflow/shared';
import { api, type ChannelWithAccounts } from '../api';
import { SegmentedControl } from './AppleUI';
import {
  FORMAT_LABELS,
  JobStatusBadge,
  PlatformPill,
  StrategyBadge,
  formatLocalDateTimeFromIso,
} from './PlatformBadge';

interface Props {
  channel: ChannelWithAccounts;
  jobs: PublishJob[];
  contents?: ContentItem[];
  onRefresh: () => Promise<void>;
  onNotify?: (type: 'success' | 'error', text: string) => void;
}

type ScopeTab = 'QUEUE' | 'HISTORY' | 'ALL';

type StatusFilter =
  | 'ALL'
  | 'PENDING_PIPELINE'
  | 'NATIVE_SCHEDULED'
  | 'PUBLISHED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED';

const TERMINAL_STATUSES = new Set<JobStatus>(['PUBLISHED', 'FAILED', 'CANCELLED']);
const ACTIVE_PIPELINE_STATUSES = new Set<JobStatus>([
  'DRAFT',
  'QUEUED',
  'PREUPLOADING',
  'PREWARMING',
  'READY_TO_PUBLISH',
  'PUBLISHING',
  'UPLOADED',
  'PROCESSING',
  'PUBLISH_REQUESTED',
]);

function isQueueJob(job: PublishJob): boolean {
  return job.status !== 'PUBLISHED' && job.status !== 'CANCELLED';
}

function isHistoryJob(job: PublishJob): boolean {
  return TERMINAL_STATUSES.has(job.status);
}

function localizeIsoInText(text: string, timezone = 'Asia/Bangkok'): string {
  return text.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
    (iso) => formatLocalDateTimeFromIso(iso, timezone)
  );
}

function formatThaiDateOnly(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return dateStr;
  try {
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(dt);
  } catch {
    return dateStr;
  }
}

function formatRelativeDiff(iso: string, nowMs: number): string {
  const targetMs = new Date(iso).getTime();
  if (!Number.isFinite(targetMs)) return '';
  const diffMin = Math.round((targetMs - nowMs) / 60_000);
  const absMin = Math.abs(diffMin);
  if (absMin < 1) return diffMin >= 0 ? 'ถึงกำหนดแล้ว' : 'เพิ่งผ่านมา';
  const days = Math.floor(absMin / (60 * 24));
  const hours = Math.floor((absMin % (60 * 24)) / 60);
  const mins = absMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} วัน`);
  if (hours > 0) parts.push(`${hours} ชม.`);
  if (days === 0 && mins > 0) parts.push(`${mins} นาที`);
  const span = parts.join(' ');
  return diffMin >= 0 ? `อีก ${span}` : `ผ่านกำหนด ${span}`;
}

function getJobSnapshotSnippet(job: PublishJob): string {
  const snap = job.metadataSnapshot || {};
  const title = typeof snap.title === 'string' ? snap.title.trim() : '';
  if (title) return title;
  const caption = typeof snap.caption === 'string' ? snap.caption.trim() : '';
  if (caption) return caption.split(/\r?\n/)[0] || caption;
  const desc = typeof snap.description === 'string' ? snap.description.trim() : '';
  if (desc) return desc.split(/\r?\n/)[0] || desc;
  return '';
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    JOB_CREATED: 'สร้างคิวงาน',
    JIT_PREWARM_READY: 'เตรียมไฟล์พร้อมยิง (Pre-warm)',
    FB_REELS_COVER_FRAME_INJECTED: 'ฝังหน้าปก Reels',
    FB_THUMBNAIL_SET: 'อัปโหลดหน้าปก FB',
    FB_NATIVE_VERIFY: 'ครบกำหนดเวลาที่ตั้งไว้',
    FB_REEL_PAGE_IDENTITY: 'ตรวจสอบบัญชีเพจ Facebook',
    FB_REEL_START: 'เปิดเซสชันอัปโหลด Reel',
    FB_REEL_UPLOAD: 'ส่งไฟล์ Reel',
    FB_REEL_FINISH: 'ส่งคำขอเผยแพร่ Reel',
    FB_REEL_STATUS: 'อ่านสถานะ Reel จาก Meta',
    FB_REEL_METADATA: 'อ่านข้อมูลโพสต์จาก Meta',
    FB_REEL_PHASE_FAILED: 'Meta รายงานข้อผิดพลาดของ Reel',
    FB_REEL_PUBLISHED: 'Meta ยืนยันการเผยแพร่ Reel',
    YT_UPLOADED: 'อัปโหลดขึ้น YouTube',
    PUBLISHED: 'เผยแพร่สำเร็จ',
    UNIFIED_PUBLISHED: 'เผยแพร่ผ่าน Unified API',
    RETRY_SCHEDULED: 'ตั้งเวลารอลองใหม่',
    NETWORK_WAIT_RETRY: 'รอเครือข่ายเพื่อลองใหม่',
    JOB_FAILED: 'งานล้มเหลว',
    JOB_CANCELLED: 'ยกเลิกคิวงาน',
    CANCEL_REMOTE_WARN: 'เตือนการยกเลิกบนแพลตฟอร์ม',
    MANUAL_RETRY: 'ผู้ใช้สั่งเข้าคิวใหม่',
    RESCHEDULED_NATIVE: 'เลื่อนเวลาบนแพลตฟอร์ม',
    RESCHEDULED_QUEUE: 'เลื่อนเวลาในคิว',
  };
  return labels[stage] || stage;
}

export function JobsView({
  channel,
  jobs,
  contents = [],
  onRefresh,
  onNotify,
}: Props) {
  const [scope, setScope] = useState<ScopeTab>(() =>
    jobs.some(isQueueJob) ? 'QUEUE' : 'ALL'
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [platformFilter, setPlatformFilter] = useState<'ALL' | Platform>('ALL');
  const [searchText, setSearchText] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tickBusy, setTickBusy] = useState(false);
  const [confirmDeleteClipId, setConfirmDeleteClipId] = useState<string | null>(
    null
  );

  const nowMs = Date.now();

  const contentMap = useMemo(() => {
    const map = new Map<string, ContentItem>();
    for (const c of contents) map.set(c.id, c);
    return map;
  }, [contents]);

  const counts = useMemo(() => {
    let activePending = 0;
    let nativeScheduled = 0;
    let published = 0;
    let failed = 0;
    let cancelled = 0;
    let queueTotal = 0;
    let historyTotal = 0;

    for (const j of jobs) {
      if (isQueueJob(j)) queueTotal++;
      if (isHistoryJob(j)) historyTotal++;
      if (j.status === 'NATIVE_SCHEDULED') nativeScheduled++;
      else if (j.status === 'PUBLISHED') published++;
      else if (j.status === 'FAILED') failed++;
      else if (j.status === 'CANCELLED') cancelled++;
      else if (ACTIVE_PIPELINE_STATUSES.has(j.status)) activePending++;
    }
    return {
      total: jobs.length,
      queueTotal,
      historyTotal,
      activePending,
      nativeScheduled,
      published,
      failed,
      cancelled,
    };
  }, [jobs]);

  const nextUpcomingJob = useMemo(() => {
    return (
      jobs
        .filter(
          (j) =>
            !TERMINAL_STATUSES.has(j.status) &&
            new Date(j.scheduledAt).getTime() >= nowMs - 60_000
        )
        .sort(
          (a, b) =>
            new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
        )[0] ?? null
    );
  }, [jobs, nowMs]);

  const scopeJobs = useMemo(() => {
    if (scope === 'QUEUE') return jobs.filter(isQueueJob);
    if (scope === 'HISTORY') return jobs.filter(isHistoryJob);
    return jobs;
  }, [jobs, scope]);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = scopeJobs.filter((job) => {
      if (statusFilter === 'PENDING_PIPELINE') {
        if (!ACTIVE_PIPELINE_STATUSES.has(job.status)) return false;
      } else if (statusFilter !== 'ALL' && job.status !== statusFilter) {
        return false;
      }
      if (platformFilter !== 'ALL' && job.platform !== platformFilter) {
        return false;
      }
      if (q) {
        const content = contentMap.get(job.contentItemId);
        const haystack = [
          job.contentTopic,
          content?.masterBrief?.topic,
          job.accountName,
          FORMAT_LABELS[job.format],
          getJobSnapshotSnippet(job),
          job.lastError,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (scope === 'HISTORY') {
        return (
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
          new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime()
        );
      }
      if (scope === 'QUEUE') {
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      }
      // ALL: active upcoming jobs first (earliest first), then history (latest first)
      const aQueue = isQueueJob(a);
      const bQueue = isQueueJob(b);
      if (aQueue !== bQueue) return aQueue ? -1 : 1;
      if (aQueue) {
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [scopeJobs, statusFilter, platformFilter, searchText, contentMap, scope]);

  // Group filtered jobs by content clip while preserving sort order
  const groupedByClip = useMemo(() => {
    const groups: Array<{
      contentItemId: string;
      topic: string;
      targetDate: string;
      coverUrl: string | null;
      jobs: PublishJob[];
      allContentJobs: PublishJob[];
    }> = [];
    const byId = new Map<string, (typeof groups)[number]>();

    for (const job of filtered) {
      let group = byId.get(job.contentItemId);
      if (!group) {
        const content = contentMap.get(job.contentItemId);
        const assetId = job.mediaAssetId || content?.mediaAsset?.id;
        const hasCover = Boolean(
          job.hasCustomCover || content?.mediaAsset?.customCoverKey
        );
        const hasThumb = Boolean(
          job.thumbnailFilename ||
            (content?.mediaAsset?.thumbnailPaths?.length ?? 0) > 0
        );
        const coverUrl = assetId
          ? hasCover
            ? `/api/media/${assetId}/custom-cover`
            : hasThumb
              ? `/api/media/${assetId}/thumbnail/0`
              : null
          : null;

        group = {
          contentItemId: job.contentItemId,
          topic:
            job.contentTopic ||
            content?.masterBrief?.topic ||
            content?.mediaAsset?.originalFilename ||
            getJobSnapshotSnippet(job) ||
            `คลิป (${job.contentItemId})`,
          targetDate: job.contentTargetDate || content?.targetDate || '',
          coverUrl,
          jobs: [],
          allContentJobs:
            content?.jobs ?? jobs.filter((x) => x.contentItemId === job.contentItemId),
        };
        byId.set(job.contentItemId, group);
        groups.push(group);
      }
      group.jobs.push(job);
    }
    return groups;
  }, [filtered, contentMap, jobs]);

  const selectedJob = useMemo(
    () =>
      (selectedJobId ? filtered.find((j) => j.id === selectedJobId) : null) ??
      filtered[0] ??
      null,
    [filtered, selectedJobId]
  );

  useEffect(() => {
    if (!selectedJob) {
      setLogs([]);
      return;
    }
    void api.getJobLogs(selectedJob.id).then((res) => setLogs(res.logs));
  }, [selectedJob, jobs]);

  async function runAction(
    jobId: string,
    fn: () => Promise<unknown>,
    successMsg: string
  ) {
    setBusyId(jobId);
    try {
      await fn();
      await onRefresh();
      if (selectedJobId === jobId) {
        const l = await api.getJobLogs(jobId);
        setLogs(l.logs);
      }
      onNotify?.('success', successMsg);
    } catch (err) {
      onNotify?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteClipHistory(contentItemId: string) {
    setBusyId(contentItemId);
    try {
      await api.deleteContent(contentItemId);
      setConfirmDeleteClipId(null);
      await onRefresh();
      onNotify?.('success', 'ลบประวัติคลิปออกจากระบบแล้ว');
    } catch (err) {
      onNotify?.('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="apple-title text-[22px] text-apple-label">
            คิวงาน & ประวัติ
          </h2>
          <p className="text-[12.5px] text-apple-secondary">
            คิวรอดำเนินการ {counts.queueTotal} งาน • ประวัติย้อนหลัง {counts.historyTotal} งาน (ทั้งหมด {counts.total} งาน)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl<ScopeTab>
            size="sm"
            value={scope}
            onChange={(val) => {
              setScope(val);
              setStatusFilter('ALL');
            }}
            options={[
              { value: 'QUEUE', label: `คิวรอดำเนินการ (${counts.queueTotal})` },
              { value: 'HISTORY', label: `ประวัติย้อนหลัง (${counts.historyTotal})` },
              { value: 'ALL', label: `ทั้งหมด (${counts.total})` },
            ]}
          />

          <button
            type="button"
            disabled={tickBusy}
            onClick={() => {
              setTickBusy(true);
              void api
                .tickScheduler()
                .then(async (r) => {
                  await onRefresh();
                  onNotify?.(
                    'success',
                    `ตรวจสอบคิวงานแล้ว (ประมวลผล ${r.processed} รายการ)`
                  );
                })
                .catch((err) => {
                  onNotify?.(
                    'error',
                    err instanceof Error ? err.message : String(err)
                  );
                })
                .finally(() => setTickBusy(false));
            }}
            className="apple-btn-secondary"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-apple-blue ${
                tickBusy ? 'animate-spin' : ''
              }`}
            />
            อัปเดตคิวทันที
          </button>
        </div>
      </div>

      {/* 4 Accurate Summary Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => {
            setScope('QUEUE');
            setStatusFilter('PENDING_PIPELINE');
          }}
          className="apple-card flex flex-col justify-between p-3.5 text-left transition hover:shadow-sm"
        >
          <div className="flex items-center justify-between text-[11.5px] font-medium text-apple-secondary">
            <span>รอคิว / กำลังเตรียมงาน</span>
            <Clock className="h-4 w-4 text-apple-blue" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-apple-label tabular-nums">
              {counts.activePending}
            </span>
            <span className="text-[11px] text-apple-tertiary truncate">
              {nextUpcomingJob
                ? formatRelativeDiff(nextUpcomingJob.scheduledAt, nowMs)
                : 'ไม่มีคิวถัดไป'}
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setScope('QUEUE');
            setStatusFilter('NATIVE_SCHEDULED');
          }}
          className="apple-card flex flex-col justify-between p-3.5 text-left transition hover:shadow-sm"
        >
          <div className="flex items-center justify-between text-[11.5px] font-medium text-apple-secondary">
            <span>Pre-uploaded บนแพลตฟอร์ม</span>
            <CheckCircle2 className="h-4 w-4 text-apple-green" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-apple-green tabular-nums">
              {counts.nativeScheduled}
            </span>
            <span className="text-[11px] text-apple-tertiary">
              ตั้งเวลาล่วงหน้าไว้แล้ว
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setScope('HISTORY');
            setStatusFilter('PUBLISHED');
          }}
          className="apple-card flex flex-col justify-between p-3.5 text-left transition hover:shadow-sm"
        >
          <div className="flex items-center justify-between text-[11.5px] font-medium text-apple-secondary">
            <span>เผยแพร่สำเร็จ</span>
            <CheckCircle2 className="h-4 w-4 text-apple-green" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[22px] font-bold text-apple-label tabular-nums">
              {counts.published}
            </span>
            <span className="text-[11px] text-apple-tertiary">คลิปที่ลงแล้ว</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setScope('HISTORY');
            setStatusFilter(counts.failed > 0 ? 'FAILED' : 'CANCELLED');
          }}
          className="apple-card flex flex-col justify-between p-3.5 text-left transition hover:shadow-sm"
        >
          <div className="flex items-center justify-between text-[11.5px] font-medium text-apple-secondary">
            <span>ล้มเหลว / ยกเลิกแล้ว</span>
            <XCircle
              className="h-4 w-4"
              style={{
                color:
                  counts.failed > 0
                    ? 'var(--apple-red)'
                    : 'var(--label-tertiary)',
              }}
            />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2.5 tabular-nums">
            <span
              className="text-[22px] font-bold"
              style={{
                color:
                  counts.failed > 0 ? 'var(--apple-red)' : 'var(--label-primary)',
              }}
            >
              {counts.failed}
            </span>
            <span className="text-[11.5px] text-apple-tertiary">
              ล้มเหลว • {counts.cancelled} ยกเลิก
            </span>
          </div>
        </button>
      </div>

      {/* Filter Bar: Status + Platform + Search */}
      <div className="apple-card flex flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'ALL', label: 'ทั้งหมด' },
              ...(scope !== 'HISTORY'
                ? [
                    { id: 'PENDING_PIPELINE', label: 'รอคิว / เตรียมไฟล์' },
                    { id: 'NATIVE_SCHEDULED', label: 'Pre-uploaded' },
                    { id: 'UNKNOWN', label: 'ยืนยันไม่ได้' },
                  ]
                : []),
              ...(scope !== 'QUEUE'
                ? [
                    { id: 'PUBLISHED', label: 'สำเร็จ' },
                    { id: 'CANCELLED', label: 'ยกเลิกแล้ว' },
                  ]
                : []),
              { id: 'FAILED', label: 'ล้มเหลว' },
            ] as Array<{ id: StatusFilter; label: string }>
          ).map((f) => {
            const active = statusFilter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium transition ${
                  active
                    ? 'bg-apple-blue text-white shadow-sm'
                    : 'bg-apple-grouped text-apple-secondary hover:text-apple-label'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {(['ALL', 'YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'] as const).map(
              (pf) => {
                const active = platformFilter === pf;
                const label =
                  pf === 'ALL'
                    ? 'ทุกแอป'
                    : pf === 'YOUTUBE'
                      ? 'YT'
                      : pf === 'TIKTOK'
                        ? 'TT'
                        : pf === 'INSTAGRAM'
                          ? 'IG'
                          : 'FB';
                return (
                  <button
                    key={pf}
                    type="button"
                    onClick={() => setPlatformFilter(pf)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold transition ${
                      active
                        ? 'border-apple-blue bg-apple-blue/10 text-apple-blue'
                        : 'border-transparent bg-apple-grouped text-apple-secondary hover:text-apple-label'
                    }`}
                  >
                    {label}
                  </button>
                );
              }
            )}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-apple-tertiary" />
            <input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="ค้นหาชื่อคลิป / บัญชี..."
              className="apple-input w-48 py-1 pl-8 pr-2.5 text-[12px]"
            />
          </div>
        </div>
      </div>

      {/* Master-Detail Split */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-8">
          {groupedByClip.length === 0 ? (
            <div className="apple-card px-4 py-14 text-center text-[13px] text-apple-tertiary">
              {scope === 'QUEUE'
                ? 'ไม่มีคิวงานที่กำลังรอดำเนินการ — ดูรายการย้อนหลังได้ที่แท็บ "ประวัติย้อนหลัง"'
                : 'ไม่พบคิวงานที่ตรงกับตัวกรอง'}
            </div>
          ) : (
            groupedByClip.map((group) => {
              const pubCount = group.allContentJobs.filter(
                (j) => j.status === 'PUBLISHED'
              ).length;
              const activeCount = group.allContentJobs.filter(isQueueJob).length;
              const cancelCount = group.allContentJobs.filter(
                (j) => j.status === 'CANCELLED'
              ).length;

              return (
                <div key={group.contentItemId} className="apple-card overflow-hidden">
                  {/* Clip Header */}
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 border-b bg-apple-grouped/50 px-4 py-2.5"
                    style={{ borderColor: 'var(--separator)' }}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-[9px] bg-black/80">
                        {group.coverUrl ? (
                          <img
                            src={group.coverUrl}
                            alt={group.topic}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-slate-400">
                            <Film className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <h3 className="apple-headline truncate text-[13.5px] text-apple-label">
                          {group.topic}
                        </h3>
                        <p className="text-[11px] text-apple-secondary tabular-nums">
                          {group.targetDate
                            ? `วันเป้าหมาย: ${formatThaiDateOnly(group.targetDate)}`
                            : 'ไม่ระบุวันเป้าหมาย'}
                          {' • '}
                          <span>
                            ทั้งหมด {group.allContentJobs.length} แพลตฟอร์ม
                            {pubCount > 0 ? ` • สำเร็จ ${pubCount}` : ''}
                            {activeCount > 0 ? ` • รอดำเนินการ ${activeCount}` : ''}
                            {cancelCount > 0 ? ` • ยกเลิก ${cancelCount}` : ''}
                          </span>
                        </p>
                      </div>
                    </div>

                    {activeCount === 0 && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {confirmDeleteClipId === group.contentItemId ? (
                          <>
                            <span className="text-[11px] font-medium text-red-600">
                              ลบประวัตินี้?
                            </span>
                            <button
                              type="button"
                              disabled={busyId === group.contentItemId}
                              onClick={() => void deleteClipHistory(group.contentItemId)}
                              className="inline-flex items-center gap-1 rounded-[7px] bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                            >
                              {busyId === group.contentItemId ? 'กำลังลบ...' : 'ยืนยันลบ'}
                            </button>
                            <button
                              type="button"
                              disabled={busyId === group.contentItemId}
                              onClick={() => setConfirmDeleteClipId(null)}
                              className="inline-flex items-center rounded-[7px] border border-[var(--separator)] bg-apple-window px-2 py-1 text-[11px] font-medium text-apple-secondary transition hover:text-apple-label disabled:opacity-50"
                            >
                              ยกเลิก
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={busyId === group.contentItemId}
                            onClick={() => setConfirmDeleteClipId(group.contentItemId)}
                            title="ลบประวัติคลิปนี้ออกจากระบบ"
                            className="inline-flex items-center gap-1 rounded-[7px] border border-[var(--separator)] bg-apple-window px-2.5 py-1 text-[11px] font-medium text-apple-secondary transition hover:border-red-500/30 hover:bg-red-500/5 hover:text-red-600 disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" />
                            ลบประวัติ
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Platform Jobs in Clip */}
                  <div className="divide-y divide-[var(--separator)] bg-apple-window">
                    {group.jobs.map((job) => {
                      const selected = selectedJob?.id === job.id;
                      const isActive = !TERMINAL_STATUSES.has(job.status);
                      const isPastDue =
                        isActive && new Date(job.scheduledAt).getTime() < nowMs;
                      const snippet = getJobSnapshotSnippet(job);
                      const relText = isActive
                        ? formatRelativeDiff(job.scheduledAt, nowMs)
                        : '';

                      return (
                        <div
                          key={job.id}
                          onClick={() => setSelectedJobId(job.id)}
                          className={`flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3 transition ${
                            selected
                              ? 'bg-apple-blue/10'
                              : 'hover:bg-apple-hover'
                          } ${job.status === 'CANCELLED' ? 'opacity-75' : ''}`}
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <PlatformPill platform={job.platform} compact />
                              <span className="text-[12.5px] font-semibold text-apple-label">
                                {FORMAT_LABELS[job.format]}
                              </span>
                              <StrategyBadge
                                strategy={job.strategy}
                                isPastDue={isPastDue}
                              />
                              <JobStatusBadge status={job.status} />
                            </div>

                            {snippet && snippet !== group.topic && (
                              <p className="truncate text-[12px] text-apple-label">
                                “{snippet}”
                              </p>
                            )}

                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-apple-secondary tabular-nums">
                              <span>
                                กำหนดลง:{' '}
                                <strong className="font-semibold text-apple-label">
                                  {formatLocalDateTimeFromIso(
                                    job.scheduledAt,
                                    channel.timezone
                                  )}
                                </strong>
                              </span>

                              {relText && (
                                <span
                                  className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-medium ${
                                    isPastDue
                                      ? 'bg-apple-red/10 text-apple-red'
                                      : 'bg-apple-grouped text-apple-secondary'
                                  }`}
                                >
                                  {relText}
                                </span>
                              )}

                              {job.accountName && (
                                <span className="text-apple-tertiary">
                                  • {job.accountName}
                                </span>
                              )}

                              {job.strategy === 'JIT_PUBLISH' &&
                                job.prewarmAt &&
                                isActive && (
                                  <span className="text-apple-indigo">
                                    • เตรียมไฟล์{' '}
                                    {formatLocalDateTimeFromIso(
                                      job.prewarmAt,
                                      channel.timezone
                                    )}
                                  </span>
                                )}

                              {job.status === 'PUBLISHED' && (
                                <span className="text-apple-green">
                                  • ลงจริง{' '}
                                  {formatLocalDateTimeFromIso(
                                    job.updatedAt,
                                    channel.timezone
                                  )}
                                </span>
                              )}

                              {job.status === 'CANCELLED' && (
                                <span className="text-apple-tertiary">
                                  • ยกเลิกเมื่อ{' '}
                                  {formatLocalDateTimeFromIso(
                                    job.updatedAt,
                                    channel.timezone
                                  )}
                                </span>
                              )}

                              {job.status === 'PUBLISHED' && job.externalUrl && (
                                <a
                                  href={job.externalUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 font-medium text-apple-blue hover:underline"
                                >
                                  เปิดโพสต์ <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>

                            {job.nextRetryAt && isActive && (
                              <p className="text-[11px] font-medium text-apple-orange tabular-nums">
                                จะลองใหม่อัตโนมัติเวลา{' '}
                                {formatLocalDateTimeFromIso(
                                  job.nextRetryAt,
                                  channel.timezone
                                )}{' '}
                                (ครั้งที่ {job.retryCount}/{job.maxRetries})
                              </p>
                            )}

                            {job.lastError && (
                              <p
                                className={`text-[11.5px] ${
                                  job.status === 'CANCELLED'
                                    ? 'text-apple-tertiary'
                                    : 'text-apple-red'
                                }`}
                              >
                                {job.status === 'CANCELLED'
                                  ? `สาเหตุเดิมก่อนยกเลิก: ${job.lastError}`
                                  : `ข้อผิดพลาด: ${job.lastError}`}
                              </p>
                            )}
                          </div>

                          {/* Row Actions (accurate by status) */}
                          <div
                            className="flex shrink-0 items-center gap-1.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {job.facebookReel?.videoId && ['UNKNOWN', 'FAILED'].includes(job.status) && (
                              <button
                                type="button"
                                disabled={busyId === job.id || Boolean(job.nextRetryAt && Date.parse(job.nextRetryAt) > nowMs)}
                                onClick={() => void runAction(job.id, () => api.verifyFacebookReel(job.id), 'ตรวจสอบสถานะกับ Meta แล้ว')}
                                className="apple-btn-secondary py-1 px-2.5 text-[11.5px]"
                              >
                                <RefreshCw className="h-3 w-3" />
                                ตรวจสถานะ
                              </button>
                            )}
                            {!job.facebookReel?.startRequestedAt && !job.facebookReel?.legacy &&
                              !job.facebookReel?.videoId && job.status !== 'UNKNOWN' &&
                              job.status !== 'PUBLISHED' && job.status !== 'CANCELLED' &&
                              job.status !== 'PUBLISHING' &&
                              !(job.format === 'FACEBOOK_REELS' && job.connectionMode === 'LIVE_OFFICIAL' && job.status === 'PREUPLOADING') && (
                                <button
                                  type="button"
                                  disabled={busyId === job.id}
                                  onClick={() =>
                                    void runAction(
                                      job.id,
                                      () => api.runJobNow(job.id),
                                      `สั่งโพสต์ ${FORMAT_LABELS[job.format]} แล้ว`
                                    )
                                  }
                                  className="apple-btn-secondary py-1 px-2.5 text-[11.5px]"
                                  title="โพสต์ทันที"
                                >
                                  <Play className="h-3 w-3 text-apple-blue" />
                                  โพสต์ทันที
                                </button>
                              )}
                            {!job.facebookReel?.startRequestedAt && !job.facebookReel?.legacy &&
                              !job.facebookReel?.videoId && (job.status === 'FAILED' || job.status === 'CANCELLED') && (
                              <button
                                type="button"
                                disabled={busyId === job.id}
                                onClick={() =>
                                  void runAction(
                                    job.id,
                                    () => api.retryJob(job.id),
                                    'ส่งกลับเข้าคิวใหม่แล้ว'
                                  )
                                }
                                className="apple-btn-secondary py-1 px-2.5 text-[11.5px]"
                                title="ส่งกลับเข้าคิวใหม่ (Retry)"
                              >
                                <RotateCcw className="h-3 w-3" />
                                เข้าคิวใหม่
                              </button>
                            )}
                            {job.status !== 'PUBLISHED' && job.status !== 'CANCELLED' &&
                              (job.status === 'NATIVE_SCHEDULED' ||
                               (!job.facebookReel?.startRequestedAt && !job.facebookReel?.legacy &&
                                !job.facebookReel?.videoId && job.status !== 'UNKNOWN')) && (
                                <button
                                  type="button"
                                  disabled={busyId === job.id}
                                  onClick={() =>
                                    void runAction(
                                      job.id,
                                      () => api.cancelJob(job.id),
                                      'ยกเลิกคิวงานแล้ว'
                                    )
                                  }
                                  className="apple-btn-destructive py-1 px-2.5 text-[11.5px]"
                                  title="ยกเลิกงาน"
                                >
                                  <Ban className="h-3 w-3" />
                                </button>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Column: Job Summary + Execution Timeline Inspector */}
        <div className="apple-card flex flex-col p-4 lg:col-span-4">
          <div
            className="mb-3 flex items-center justify-between gap-2 border-b pb-2.5"
            style={{ borderColor: 'var(--separator)' }}
          >
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-apple-blue" />
              <h3 className="apple-headline text-[13px] text-apple-label">
                รายละเอียด & Execution Timeline
              </h3>
            </div>
            {selectedJob && (
              <span className="font-mono text-[10.5px] text-apple-tertiary">
                {selectedJob.id}
              </span>
            )}
          </div>

          {!selectedJob ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-[12px] text-apple-tertiary">
              <History className="h-6 w-6 opacity-50" />
              <p>เลือกรายการคิวงานด้านซ้ายเพื่อดูรายละเอียดและประวัติการทำงานทีละขั้น</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Structured Job Metadata */}
              <div
                className="space-y-2 rounded-[12px] border bg-apple-grouped/50 p-3 text-[11.5px]"
                style={{ borderColor: 'var(--separator)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-apple-label">
                    {FORMAT_LABELS[selectedJob.format]}
                  </span>
                  <JobStatusBadge status={selectedJob.status} />
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] tabular-nums">
                  <span className="text-apple-tertiary">กำหนดลง:</span>
                  <span className="text-right font-medium text-apple-label">
                    {formatLocalDateTimeFromIso(
                      selectedJob.scheduledAt,
                      channel.timezone
                    )}
                  </span>

                  <span className="text-apple-tertiary">อัปเดตล่าสุด:</span>
                  <span className="text-right text-apple-secondary">
                    {formatLocalDateTimeFromIso(
                      selectedJob.updatedAt,
                      channel.timezone
                    )}
                  </span>

                  <span className="text-apple-tertiary">ลองซ้ำ (Retry):</span>
                  <span className="text-right text-apple-secondary">
                    {selectedJob.retryCount} / {selectedJob.maxRetries} ครั้ง
                  </span>

                  {selectedJob.facebookReel?.videoId && (
                    <>
                      <span className="text-apple-tertiary">Video ID</span>
                      <span className="break-all text-right font-mono text-apple-secondary">{selectedJob.facebookReel.videoId}</span>
                    </>
                  )}
                  {selectedJob.facebookReel?.statusCheckedAt && (
                    <>
                      <span className="text-apple-tertiary">ตรวจสถานะล่าสุด</span>
                      <span className="text-right text-apple-secondary">
                        {formatLocalDateTimeFromIso(selectedJob.facebookReel.statusCheckedAt, channel.timezone)}
                      </span>
                    </>
                  )}
                  {(selectedJob.externalPostId || selectedJob.facebookReel?.postId) && (
                    <>
                      <span className="text-apple-tertiary">
                        {selectedJob.status === 'CANCELLED'
                          ? 'Post ID เดิม:'
                          : 'Post ID:'}
                      </span>
                      <span className="truncate text-right font-mono text-[10.5px] text-apple-secondary">
                        {selectedJob.externalPostId || selectedJob.facebookReel?.postId}
                      </span>
                    </>
                  )}
                </div>

                {selectedJob.facebookReel?.videoId && (
                  <a
                    href={'/api/jobs/' + encodeURIComponent(selectedJob.id) + '/facebook-diagnostics'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-apple-blue"
                  >
                    <ExternalLink className="h-3 w-3" />
                    รายงานสถานะจาก Meta
                  </a>
                )}

                {getJobSnapshotSnippet(selectedJob) && (
                  <div
                    className="border-t pt-2 text-[11px]"
                    style={{ borderColor: 'var(--separator)' }}
                  >
                    <p className="text-apple-tertiary">ข้อความที่ตั้งค่าไว้:</p>
                    <p className="mt-0.5 line-clamp-3 text-apple-label">
                      {typeof selectedJob.metadataSnapshot?.title === 'string' &&
                      selectedJob.metadataSnapshot.title.trim()
                        ? selectedJob.metadataSnapshot.title
                        : String(
                            selectedJob.metadataSnapshot?.caption ||
                              selectedJob.metadataSnapshot?.description ||
                              ''
                          )}
                    </p>
                  </div>
                )}
              </div>

              {/* Execution Logs */}
              {logs.length === 0 ? (
                <p className="py-8 text-center text-[12px] text-apple-tertiary">
                  ยังไม่มีบันทึกการทำงาน
                </p>
              ) : (
                <div className="max-h-[440px] space-y-2.5 overflow-y-auto pr-1">
                  {logs.map((l) => (
                    <div
                      key={l.id}
                      className="rounded-[12px] border bg-apple-grouped/60 p-3 text-[11.5px]"
                      style={{ borderColor: 'var(--separator)' }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="font-semibold"
                          style={{
                            color:
                              l.level === 'ERROR'
                                ? 'var(--apple-red)'
                                : l.level === 'WARN'
                                  ? 'var(--apple-orange)'
                                  : 'var(--apple-green)',
                          }}
                        >
                          {stageLabel(l.stage)}
                        </span>
                        <span className="text-[10.5px] text-apple-tertiary tabular-nums">
                          {formatLocalDateTimeFromIso(
                            l.createdAt,
                            channel.timezone
                          )}
                        </span>
                      </div>
                      <p className="mt-1 text-apple-label">
                        {localizeIsoInText(l.message, channel.timezone)}
                      </p>
                      {l.details && (
                        <pre className="mt-2 overflow-x-auto rounded-[8px] bg-apple-window p-2 text-[10px] text-apple-secondary">
                          {JSON.stringify(l.details, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
