import { useEffect, useState } from 'react';
import {
  Ban,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCcw,
  Terminal,
} from 'lucide-react';
import type { JobLog, JobStatus, PublishJob } from '@clipflow/shared';
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
  onRefresh: () => Promise<void>;
  onNotify?: (type: 'success' | 'error', text: string) => void;
}

type FilterOption =
  | 'ALL'
  | 'NATIVE_SCHEDULED'
  | 'QUEUED'
  | 'PUBLISHED'
  | 'FAILED';

export function JobsView({ channel, jobs, onRefresh, onNotify }: Props) {
  const [filter, setFilter] = useState<FilterOption>('ALL');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedJobId) return;
    void api.getJobLogs(selectedJobId).then((res) => setLogs(res.logs));
  }, [selectedJobId, jobs]);

  const filtered =
    filter === 'ALL'
      ? jobs
      : jobs.filter((j) => j.status === (filter as JobStatus));

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="apple-title text-[22px] text-apple-label">
            คิวงาน & บันทึกการทำงาน
          </h2>
          <p className="text-[12.5px] text-apple-secondary">
            ติดตามสถานะ Pre-upload ล่วงหน้าและ JIT Publish ของทั้งหมด {jobs.length} งาน
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl<FilterOption>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'ALL', label: 'ทั้งหมด' },
              { value: 'NATIVE_SCHEDULED', label: 'Pre-uploaded' },
              { value: 'QUEUED', label: 'รอคิว' },
              { value: 'PUBLISHED', label: 'สำเร็จ' },
              { value: 'FAILED', label: 'ล้มเหลว' },
            ]}
          />

          <button
            type="button"
            onClick={() =>
              void api.tickScheduler().then(async (r) => {
                await onRefresh();
                onNotify?.(
                  'success',
                  `ตรวจสอบคิวงานแล้ว (ประมวลผล ${r.processed} รายการ)`
                );
              })
            }
            className="apple-btn-secondary"
          >
            <RefreshCw className="h-3.5 w-3.5 text-apple-blue" />
            อัปเดตคิวทันที
          </button>
        </div>
      </div>

      {/* Apple Master-Detail Console Split */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="apple-card overflow-hidden lg:col-span-8">
          <div className="divide-y divide-[var(--separator)] bg-apple-window">
            {filtered.length === 0 ? (
              <div className="px-4 py-14 text-center text-[13px] text-apple-tertiary">
                ยังไม่มีคิวงานในสถานะนี้
              </div>
            ) : (
              filtered.map((job) => {
                const selected = selectedJobId === job.id;
                return (
                  <div
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    className={`flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition ${
                      selected ? 'bg-apple-blue/10' : 'hover:bg-apple-hover'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <PlatformPill platform={job.platform} compact />
                        <span className="text-[13px] font-semibold text-apple-label">
                          {FORMAT_LABELS[job.format]}
                        </span>
                        <StrategyBadge strategy={job.strategy} />
                        <JobStatusBadge status={job.status} />
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5 text-[11.5px] text-apple-secondary tabular-nums">
                        <span>
                          กำหนดลง:{' '}
                          {formatLocalDateTimeFromIso(
                            job.scheduledAt,
                            channel.timezone
                          )}
                        </span>
                        <span>• {job.accountName}</span>
                        {job.externalUrl && (
                          <a
                            href={job.externalUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 font-medium text-apple-blue hover:underline"
                          >
                            เปิดลิงก์ <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      {job.lastError && (
                        <p className="text-[11.5px] text-apple-red">
                          {job.lastError}
                        </p>
                      )}
                    </div>

                    <div
                      className="flex items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {job.status !== 'PUBLISHED' &&
                        job.status !== 'CANCELLED' && (
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
                      {job.status === 'FAILED' && (
                        <button
                          type="button"
                          disabled={busyId === job.id}
                          onClick={() =>
                            void runAction(
                              job.id,
                              () => api.retryJob(job.id),
                              'ส่งกลับเข้าคิว Retry แล้ว'
                            )
                          }
                          className="apple-btn-secondary py-1 px-2.5 text-[11.5px]"
                          title="Retry"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                      {job.status !== 'PUBLISHED' &&
                        job.status !== 'CANCELLED' && (
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
              })
            )}
          </div>
        </div>

        {/* Execution Timeline Inspector */}
        <div className="apple-card flex flex-col p-4 lg:col-span-4">
          <div
            className="mb-3 flex items-center gap-2 border-b pb-2.5"
            style={{ borderColor: 'var(--separator)' }}
          >
            <Terminal className="h-4 w-4 text-apple-blue" />
            <h3 className="apple-headline text-[13px] text-apple-label">
              Execution Timeline
            </h3>
          </div>

          {!selectedJobId ? (
            <p className="py-12 text-center text-[12px] text-apple-tertiary">
              เลือกรายการคิวงานด้านซ้ายเพื่อดูขั้นตอนการทำงาน
            </p>
          ) : logs.length === 0 ? (
            <p className="py-12 text-center text-[12px] text-apple-tertiary">
              ยังไม่มีบันทึกการทำงาน
            </p>
          ) : (
            <div className="max-h-[480px] space-y-2.5 overflow-y-auto pr-1">
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
                      {l.stage}
                    </span>
                    <span className="text-[10.5px] text-apple-tertiary tabular-nums">
                      {formatLocalDateTimeFromIso(
                        l.createdAt,
                        channel.timezone
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-apple-label">{l.message}</p>
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
      </div>
    </div>
  );
}
