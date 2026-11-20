import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Film,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { ContentItem } from '@clipflow/shared';
import type { ChannelWithAccounts } from '../api';
import { SegmentedControl, InsetGroup, InsetRow } from './AppleUI';
import {
  FORMAT_LABELS,
  JobStatusBadge,
  PlatformDot,
  PlatformPill,
  StrategyBadge,
  formatLocalDateTimeFromIso,
  formatLocalTimeFromIso,
} from './PlatformBadge';

interface Props {
  channel: ChannelWithAccounts;
  contents: ContentItem[];
  onOpenPlanner: (dateStr: string, droppedFile?: File) => void;
  onRescheduleContent: (contentId: string, newDateStr: string) => Promise<void>;
  onDeleteContent: (contentId: string) => Promise<void>;
  onRunJobNow: (jobId: string) => Promise<void>;
}

const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const TH_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function CalendarView({
  channel,
  contents,
  onOpenPlanner,
  onRescheduleContent,
  onDeleteContent,
  onRunJobNow,
}: Props) {
  const [viewMode, setViewMode] = useState<'month' | 'week'>('month');
  const [cursorDate, setCursorDate] = useState<Date>(() => new Date());
  const [dragHoverDate, setDragHoverDate] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<ContentItem | null>(
    null
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const todayStr = toDateStr(new Date());

  const contentByDate = useMemo(() => {
    const map = new Map<string, ContentItem[]>();
    for (const item of contents) {
      const list = map.get(item.targetDate) ?? [];
      list.push(item);
      map.set(item.targetDate, list);
    }
    return map;
  }, [contents]);

  const calendarCells = useMemo(() => {
    if (viewMode === 'week') {
      const start = new Date(cursorDate);
      start.setDate(start.getDate() - start.getDay());
      const days: Array<{ date: Date; dateStr: string; inMonth: boolean }> = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        days.push({
          date: d,
          dateStr: toDateStr(d),
          inMonth: d.getMonth() === cursorDate.getMonth(),
        });
      }
      return days;
    }

    const year = cursorDate.getFullYear();
    const month = cursorDate.getMonth();
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const days: Array<{ date: Date; dateStr: string; inMonth: boolean }> = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push({
        date: d,
        dateStr: toDateStr(d),
        inMonth: d.getMonth() === month,
      });
    }
    return days;
  }, [cursorDate, viewMode]);

  function navigate(delta: number) {
    setCursorDate((prev) => {
      const next = new Date(prev);
      if (viewMode === 'week') {
        next.setDate(next.getDate() + delta * 7);
      } else {
        next.setMonth(next.getMonth() + delta);
      }
      return next;
    });
  }

  // Keyboard navigation like Apple Calendar (ArrowLeft, ArrowRight, T = Today)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigate(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigate(1);
      } else if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey) {
        setCursorDate(new Date());
      } else if (e.key === 'Escape' && selectedContent) {
        setSelectedContent(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedContent]);

  async function handleCellDrop(
    e: React.DragEvent<HTMLDivElement>,
    dateStr: string
  ) {
    e.preventDefault();
    setDragHoverDate(null);

    const movedContentId = e.dataTransfer.getData(
      'application/x-syncflow-content-id'
    );
    if (movedContentId) {
      setBusyId(movedContentId);
      try {
        await onRescheduleContent(movedContentId, dateStr);
      } finally {
        setBusyId(null);
      }
      return;
    }

    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      onOpenPlanner(dateStr, droppedFile);
    }
  }

  const activeSelected = selectedContent
    ? contents.find((c) => c.id === selectedContent.id) ?? selectedContent
    : null;

  return (
    <div className="space-y-4">
      {/* Apple Calendar Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="apple-title text-[24px] text-apple-label">
            {TH_MONTHS[cursorDate.getMonth()]}{' '}
            <span className="font-normal text-apple-secondary tabular-nums">
              {cursorDate.getFullYear() + 543}
            </span>
          </h2>
          <p className="text-[12px] text-apple-secondary">
            ลากไฟล์วิดีโอมาวางบนวันที่ต้องการ หรือลากการ์ดคลิปเพื่อย้ายวัน (ปรับเวลาตามกฎของวันนั้นอัตโนมัติ)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl
            size="sm"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'month', label: 'เดือน' },
              { value: 'week', label: 'สัปดาห์' },
            ]}
          />

          <div
            className="inline-flex items-center overflow-hidden rounded-[10px] border bg-apple-card shadow-sm"
            style={{ borderColor: 'var(--separator)' }}
          >
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-2.5 py-1.5 text-apple-secondary transition hover:bg-apple-hover hover:text-apple-label"
              title="ก่อนหน้า (←)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCursorDate(new Date())}
              className="border-x px-3 py-1.5 text-[12px] font-medium text-apple-label transition hover:bg-apple-hover"
              style={{ borderColor: 'var(--separator)' }}
              title="กลับไปวันนี้ (T)"
            >
              วันนี้
            </button>
            <button
              type="button"
              onClick={() => navigate(1)}
              className="px-2.5 py-1.5 text-apple-secondary transition hover:bg-apple-hover hover:text-apple-label"
              title="ถัดไป (→)"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Calendar Grid Surface */}
      <div className="apple-card overflow-hidden">
        <div
          className="grid grid-cols-7 border-b bg-apple-window"
          style={{ borderColor: 'var(--separator)' }}
        >
          {TH_DAYS.map((day, idx) => (
            <div
              key={day}
              className={`py-2.5 text-center text-[11px] font-semibold tracking-wide ${
                idx === 0 || idx === 6
                  ? 'text-apple-secondary'
                  : 'text-apple-tertiary'
              }`}
            >
              {day}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 bg-apple-window">
          {calendarCells.map((cell) => {
            const items = contentByDate.get(cell.dateStr) ?? [];
            const isToday = cell.dateStr === todayStr;
            const isHover = dragHoverDate === cell.dateStr;
            const dow = cell.date.getDay();
            const isWeekend = dow === 0 || dow === 6;

            return (
              <div
                key={cell.dateStr}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragHoverDate !== cell.dateStr) {
                    setDragHoverDate(cell.dateStr);
                  }
                }}
                onDragLeave={() => {
                  if (dragHoverDate === cell.dateStr) setDragHoverDate(null);
                }}
                onDrop={(e) => void handleCellDrop(e, cell.dateStr)}
                className={`group relative flex flex-col border-b border-r p-2 transition-colors ${
                  viewMode === 'week' ? 'min-h-[380px]' : 'min-h-[134px]'
                }`}
                style={{
                  borderColor: 'var(--separator)',
                  backgroundColor: isHover
                    ? 'rgba(0, 122, 255, 0.08)'
                    : isWeekend
                      ? 'var(--bg-hover)'
                      : 'transparent',
                  boxShadow: isHover
                    ? 'inset 0 0 0 2px var(--apple-blue)'
                    : undefined,
                }}
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span
                    className={`inline-flex h-6 min-w-[24px] items-center justify-center rounded-full px-1.5 text-[12px] font-semibold tabular-nums ${
                      isToday
                        ? 'text-white'
                        : cell.inMonth
                          ? 'text-apple-label'
                          : 'text-apple-tertiary'
                    }`}
                    style={
                      isToday
                        ? { backgroundColor: 'var(--apple-red)' }
                        : undefined
                    }
                  >
                    {cell.date.getDate()}
                  </span>

                  <button
                    type="button"
                    onClick={() => onOpenPlanner(cell.dateStr)}
                    className="rounded-full p-1 text-apple-tertiary opacity-0 transition hover:bg-apple-hover hover:text-apple-blue group-hover:opacity-100"
                    title={`วางคลิปวันที่ ${cell.dateStr}`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>

                {isHover && (
                  <div className="pointer-events-none mb-1.5 rounded-lg border border-dashed border-apple-blue px-2 py-1 text-center text-[10px] font-semibold text-apple-blue">
                    วางคลิปวันที่ {cell.date.getDate()}
                  </div>
                )}

                <div className="flex-1 space-y-1.5 overflow-y-auto">
                  {items.map((item) => {
                    const allDone =
                      (item.jobs?.length ?? 0) > 0 &&
                      item.jobs!.every((j) => j.status === 'PUBLISHED');
                    const anyFailed = item.jobs?.some(
                      (j) => j.status === 'FAILED'
                    );
                    const accentBar = anyFailed
                      ? 'var(--apple-red)'
                      : allDone
                        ? 'var(--apple-green)'
                        : channel.color;

                    return (
                      <div
                        key={item.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            'application/x-syncflow-content-id',
                            item.id
                          );
                        }}
                        onClick={() => setSelectedContent(item)}
                        className={`cursor-pointer overflow-hidden rounded-[9px] border bg-apple-card px-2 py-1.5 text-left transition hover:shadow-sm ${
                          busyId === item.id ? 'opacity-45' : ''
                        }`}
                        style={{
                          borderColor: 'var(--separator)',
                          borderLeftWidth: '3px',
                          borderLeftColor: accentBar,
                        }}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <p className="line-clamp-1 text-[11.5px] font-semibold text-apple-label">
                            {item.masterBrief.topic ||
                              item.mediaAsset?.originalFilename ||
                              'คลิปใหม่'}
                          </p>
                          <span className="shrink-0 text-[9.5px] font-medium text-apple-tertiary">
                            {item.mediaAsset?.clipCategory ?? 'SHORT'}
                          </span>
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {(item.jobs ?? []).map((job) => (
                            <span
                              key={job.id}
                              title={`${FORMAT_LABELS[job.format]} • ${formatLocalTimeFromIso(job.scheduledAt, channel.timezone)} • ${job.status}`}
                              className="inline-flex items-center gap-1 text-[10.5px] text-apple-secondary tabular-nums"
                            >
                              <PlatformDot platform={job.platform} />
                              <span>
                                {formatLocalTimeFromIso(
                                  job.scheduledAt,
                                  channel.timezone
                                )}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right-Side Slide-Over Inspector (Apple Calendar / Final Cut style) */}
      {activeSelected && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/25 backdrop-blur-[2px]"
          onClick={() => setSelectedContent(null)}
        >
          <div
            className="apple-glass flex h-full w-full max-w-md flex-col border-l bg-apple-window shadow-apple-sheet"
            style={{ borderColor: 'var(--separator)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Inspector Header */}
            <div
              className="flex items-center justify-between border-b px-5 py-4"
              style={{ borderColor: 'var(--separator)' }}
            >
              <div className="flex items-center gap-2.5">
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-[10px] text-white"
                  style={{ backgroundColor: channel.color }}
                >
                  <Film className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="apple-headline truncate text-[15px] text-apple-label">
                    {activeSelected.masterBrief.topic || 'รายละเอียดคลิป'}
                  </h3>
                  <p className="text-[11px] text-apple-secondary tabular-nums">
                    กำหนดลงวันที่ {activeSelected.targetDate}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedContent(null)}
                className="rounded-full bg-apple-grouped p-1.5 text-apple-secondary hover:text-apple-label"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Inspector Body */}
            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              {activeSelected.mediaAsset && (
                <div className="overflow-hidden rounded-[14px] bg-black shadow-apple-card">
                  <video
                    src={`/api/media/${activeSelected.mediaAsset.id}/stream`}
                    controls
                    className="max-h-60 w-full object-contain"
                  />
                </div>
              )}

              <InsetGroup
                title={`คิวเผยแพร่ (${activeSelected.jobs?.length ?? 0} แพลตฟอร์ม)`}
              >
                {(activeSelected.jobs ?? []).map((job) => (
                  <InsetRow key={job.id} className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <PlatformPill platform={job.platform} />
                        <span className="text-[12px] font-medium text-apple-label">
                          {FORMAT_LABELS[job.format]}
                        </span>
                      </div>
                      <JobStatusBadge status={job.status} />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-apple-secondary">
                      <div className="flex items-center gap-1.5 tabular-nums">
                        <Clock className="h-3.5 w-3.5 text-apple-tertiary" />
                        <span>
                          {formatLocalDateTimeFromIso(
                            job.scheduledAt,
                            channel.timezone
                          )}
                        </span>
                      </div>
                      <StrategyBadge strategy={job.strategy} />
                    </div>

                    <div className="flex items-center justify-between pt-0.5">
                      {job.externalUrl ? (
                        <a
                          href={job.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-apple-blue hover:underline"
                        >
                          เปิดดูโพสต์ <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-[11px] text-apple-tertiary">
                          {job.accountName}
                        </span>
                      )}

                      {job.status !== 'PUBLISHED' &&
                        job.status !== 'CANCELLED' && (
                          <button
                            type="button"
                            onClick={() => void onRunJobNow(job.id)}
                            className="inline-flex items-center gap-1 rounded-full bg-apple-grouped px-2.5 py-1 text-[11px] font-semibold text-apple-blue hover:bg-apple-hover"
                          >
                            <Play className="h-3 w-3" />
                            โพสต์ทันที
                          </button>
                        )}
                    </div>

                    {job.lastError && (
                      <p className="text-[11px] text-apple-red">
                        {job.lastError}
                      </p>
                    )}
                  </InsetRow>
                ))}
              </InsetGroup>

              <InsetGroup title="เลื่อนวันลงคลิป">
                <InsetRow className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-apple-label">
                    ย้ายไปวันที่ใหม่
                  </span>
                  <input
                    type="date"
                    defaultValue={activeSelected.targetDate}
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      await onRescheduleContent(
                        activeSelected.id,
                        e.target.value
                      );
                    }}
                    className="apple-input w-auto tabular-nums"
                  />
                </InsetRow>
              </InsetGroup>
            </div>

            {/* Inspector Footer */}
            <div
              className="flex items-center justify-between border-t px-5 py-3.5"
              style={{ borderColor: 'var(--separator)' }}
            >
              <span className="text-[11px] text-apple-tertiary">
                {activeSelected.mediaAsset?.originalFilename}
              </span>
              <button
                type="button"
                onClick={async () => {
                  await onDeleteContent(activeSelected.id);
                  setSelectedContent(null);
                }}
                className="apple-btn-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                ลบคลิปนี้
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
