import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CalendarDays,
  Clapperboard,
  Clock,
  Layers,
  Plus,
  Settings,
  Sparkles,
} from 'lucide-react';
import type {
  ContentItem,
  PublishJob,
  SyncCutEpisodeSummary,
} from '@clipflow/shared';
import { api, type ChannelWithAccounts } from './api';
import { SegmentedControl, ToastBanner } from './components/AppleUI';
import { CalendarView } from './components/CalendarView';
import { SyncCutLibraryView } from './components/SyncCutLibraryView';
import { ScheduleMatrixView } from './components/ScheduleMatrixView';
import { JobsView } from './components/JobsView';
import { ChannelsView } from './components/ChannelsView';
import { TemplatesSettingsView } from './components/TemplatesSettingsView';
import {
  ContentPlannerModal,
  type PlannerPrefill,
} from './components/ContentPlannerModal';

type NavTab =
  | 'calendar'
  | 'synccut'
  | 'schedule'
  | 'jobs'
  | 'channels'
  | 'settings';
type ThemeMode = 'light' | 'dark';

export function App() {
  const [tab, setTab] = useState<NavTab>('calendar');
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('syncflow_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [channels, setChannels] = useState<ChannelWithAccounts[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [contents, setContents] = useState<ContentItem[]>([]);
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [maxChannels, setMaxChannels] = useState(3);
  const [healthOk, setHealthOk] = useState(false);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [synccutState, setSynccutState] = useState<{
    connected: boolean;
    dataDir: string;
    episodes: SyncCutEpisodeSummary[];
  }>({ connected: false, dataDir: '', episodes: [] });
  const [toast, setToast] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [plannerState, setPlannerState] = useState<{
    open: boolean;
    dateStr: string;
    file?: File | null;
    prefill?: PlannerPrefill | null;
  }>({ open: false, dateStr: new Date().toISOString().slice(0, 10) });

  const notify = useCallback((type: 'success' | 'error', text: string) => {
    setToast({ type, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Apply light/dark mode class cleanly on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('syncflow_theme', theme);
  }, [theme]);

  const loadSyncCut = useCallback(async () => {
    try {
      const res = await api.listSyncCutEpisodes();
      setSynccutState(res);
    } catch {
      // Ignore if SyncCut path unconfigured
    }
  }, []);

  const loadChannelsAndHealth = useCallback(async () => {
    const [chRes, hRes, setRes] = await Promise.all([
      api.listChannels(),
      api.health(),
      api.getSettings(),
    ]);
    setChannels(chRes.channels);
    setHealthOk(hRes.ok);
    setFfmpegReady(Boolean(hRes.tools.ffmpeg && hRes.tools.ffprobe));
    setMaxChannels(setRes.settings.maxChannels);

    setActiveChannelId((prev) => {
      if (prev && chRes.channels.some((c) => c.id === prev)) return prev;
      return chRes.channels[0]?.id ?? '';
    });
    void loadSyncCut();
  }, [loadSyncCut]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const draftId = params.get('draftId');
    if (!draftId) return;
    void api
      .getContent(draftId)
      .then((res) => {
        if (res.content.mediaAsset) {
          setActiveChannelId(res.content.channelId);
          setPlannerState({
            open: true,
            dateStr: res.content.targetDate,
            file: null,
            prefill: {
              asset: res.content.mediaAsset,
              brief: res.content.masterBrief,
              metadata: res.content.platformMetadata,
              engineUsed: 'SyncCut Push',
              startStep: '3',
            },
          });
          window.history.replaceState({}, '', window.location.pathname);
        }
      })
      .catch(() => {});
  }, []);

  const loadChannelWork = useCallback(async () => {
    if (!activeChannelId) return;
    const [cntRes, jobRes] = await Promise.all([
      api.listContents(activeChannelId),
      api.listJobs(activeChannelId),
    ]);
    setContents(cntRes.contents);
    setJobs(jobRes.jobs);
  }, [activeChannelId]);

  useEffect(() => {
    void loadChannelsAndHealth();
  }, [loadChannelsAndHealth]);

  useEffect(() => {
    void loadChannelWork();
    const timer = setInterval(() => {
      void loadChannelWork();
    }, 10_000);
    return () => clearInterval(timer);
  }, [loadChannelWork]);

  // Keyboard shortcuts: 'N' = New clip sheet, 'Escape' = Close sheet
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setPlannerState({
          open: true,
          dateStr: new Date().toISOString().slice(0, 10),
          file: null,
        });
      } else if (e.key === 'Escape' && plannerState.open) {
        setPlannerState((s) => ({ ...s, open: false }));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plannerState.open]);

  const activeChannel =
    channels.find((c) => c.id === activeChannelId) ?? channels[0] ?? null;

  const readySynccutCount = synccutState.episodes.filter(
    (e) => e.hasVideo
  ).length;

  const navItems: Array<{
    id: NavTab;
    label: string;
    icon: typeof CalendarDays;
    badge?: number;
  }> = [
    { id: 'calendar', label: 'ปฏิทินลงคลิป', icon: CalendarDays },
    {
      id: 'synccut',
      label: 'นำเข้าจาก SyncCut',
      icon: Clapperboard,
      badge: readySynccutCount,
    },
    { id: 'schedule', label: 'ตารางเวลาแต่ละแพลตฟอร์ม', icon: Clock },
    {
      id: 'jobs',
      label: 'คิวงาน & ประวัติ',
      icon: Activity,
      badge: jobs.length,
    },
    { id: 'channels', label: 'ช่อง & การเชื่อมต่อ API', icon: Layers },
    { id: 'settings', label: 'เทมเพลต & ตั้งค่า', icon: Settings },
  ];

  const activeNav = navItems.find((n) => n.id === tab) ?? navItems[0];

  return (
    <div className="flex min-h-screen flex-col bg-apple-canvas text-apple-label md:flex-row">
      <ToastBanner toast={toast} onDismiss={() => setToast(null)} />

      {/* Translucent macOS Vibrancy Sidebar */}
      <aside
        className="apple-sidebar flex w-full shrink-0 flex-col border-b md:w-[264px] md:border-b-0 md:border-r"
        style={{ borderColor: 'var(--separator)' }}
      >
        {/* App Identity */}
        <div className="flex items-center gap-3 px-4 py-4">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] text-white shadow-sm"
            style={{
              background:
                'linear-gradient(145deg, #007AFF 0%, #5856D6 100%)',
            }}
          >
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h1 className="apple-headline text-[15px] text-apple-label">
              SyncFlow Studio
            </h1>
            <p className="text-[11px] text-apple-secondary">
              Hybrid Video Publisher
            </p>
          </div>
        </div>

        {/* Channels Source List (Apple Calendar style) */}
        <div className="px-3 pb-3">
          <div className="mb-1.5 flex items-center justify-between px-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-apple-tertiary">
              ช่องของฉัน ({channels.length}/{maxChannels})
            </span>
          </div>
          <div className="space-y-0.5">
            {channels.map((ch) => {
              const selected = ch.id === activeChannel?.id;
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => setActiveChannelId(ch.id)}
                  className={`flex w-full items-center justify-between rounded-[9px] px-2.5 py-1.5 text-left text-[13px] transition ${
                    selected
                      ? 'bg-apple-card font-semibold text-apple-label shadow-sm'
                      : 'text-apple-secondary hover:bg-apple-hover hover:text-apple-label'
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: ch.color }}
                    />
                    <span className="truncate">{ch.name}</span>
                  </span>
                  <span className="text-[11px] text-apple-tertiary tabular-nums">
                    {ch.accounts.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          className="mx-4 border-t"
          style={{ borderColor: 'var(--separator)' }}
        />

        {/* Workspace Navigation Source List */}
        <nav className="flex flex-row gap-1 overflow-x-auto p-3 md:flex-1 md:flex-col">
          <span className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-apple-tertiary md:block">
            เมนูหลัก
          </span>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex shrink-0 items-center justify-between gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[13px] transition ${
                  active
                    ? 'bg-apple-blue font-semibold text-white shadow-sm'
                    : 'font-medium text-apple-secondary hover:bg-apple-hover hover:text-apple-label'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums ${
                      active
                        ? 'bg-white/25 text-white'
                        : 'bg-apple-grouped text-apple-secondary'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Footer Appearance Toggle & Quiet System Status */}
        <div
          className="hidden space-y-3 border-t p-3.5 md:block"
          style={{ borderColor: 'var(--separator)' }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-apple-secondary">
              โหมดสี
            </span>
            <SegmentedControl<ThemeMode>
              size="sm"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: 'สว่าง' },
                { value: 'dark', label: 'มืด' },
              ]}
            />
          </div>

          <div className="space-y-1 text-[11px] text-apple-secondary">
            <div className="flex items-center justify-between">
              <span>Scheduler Engine</span>
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: healthOk
                      ? 'var(--apple-green)'
                      : 'var(--apple-red)',
                  }}
                />
                {healthOk ? 'พร้อมทำงาน' : 'ออฟไลน์'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>FFmpeg / FFprobe</span>
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: ffmpegReady
                      ? 'var(--apple-green)'
                      : 'var(--apple-orange)',
                  }}
                />
                {ffmpegReady ? 'พร้อมใช้' : 'ไม่พบ'}
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Sticky Liquid Glass Toolbar */}
        <header
          className="apple-glass sticky top-0 z-30 flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: 'var(--separator)' }}
        >
          <div className="flex items-center gap-2.5">
            {activeChannel && (
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: activeChannel.color }}
              />
            )}
            <span className="apple-headline text-[14px] text-apple-label">
              {activeNav.label}
            </span>
            {activeChannel && (
              <span className="text-[12px] text-apple-tertiary">
                / {activeChannel.name}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="md:hidden">
              <SegmentedControl<ThemeMode>
                size="sm"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'light', label: 'สว่าง' },
                  { value: 'dark', label: 'มืด' },
                ]}
              />
            </div>
            <button
              type="button"
              onClick={() =>
                setPlannerState({
                  open: true,
                  dateStr: new Date().toISOString().slice(0, 10),
                  file: null,
                })
              }
              className="apple-btn-primary"
              title="วางคลิปใหม่ (กด N)"
            >
              <Plus className="h-4 w-4" />
              วางคลิปใหม่
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-5 md:p-7">
          {!activeChannel ? (
            <div className="apple-card p-8 text-center text-[13px] text-apple-secondary">
              กำลังโหลดข้อมูลช่อง...
            </div>
          ) : (
            <>
              {tab === 'calendar' && (
                <CalendarView
                  channel={activeChannel}
                  contents={contents}
                  onOpenPlanner={(dateStr, file) =>
                    setPlannerState({
                      open: true,
                      dateStr,
                      file: file ?? null,
                    })
                  }
                  onRescheduleContent={async (contentId, newDateStr) => {
                    await api.rescheduleContent(contentId, newDateStr);
                    await loadChannelWork();
                    notify(
                      'success',
                      `ย้ายคลิปไปวันที่ ${newDateStr} และอัปเดตเวลาใหม่ตามตารางวันนั้นแล้ว`
                    );
                  }}
                  onDeleteContent={async (contentId) => {
                    await api.deleteContent(contentId);
                    await loadChannelWork();
                    notify('success', 'ลบคลิปและคิวงานเรียบร้อย');
                  }}
                  onRunJobNow={async (jobId) => {
                    await api.runJobNow(jobId);
                    await loadChannelWork();
                    notify('success', 'สั่งเผยแพร่คลิปเรียบร้อย');
                  }}
                />
              )}

              {tab === 'synccut' && (
                <SyncCutLibraryView
                  channel={activeChannel}
                  connected={synccutState.connected}
                  dataDir={synccutState.dataDir}
                  episodes={synccutState.episodes}
                  onRefresh={loadSyncCut}
                  onOpenSettings={() => setTab('settings')}
                  onNotify={notify}
                  onImported={(res, targetDate) => {
                    setPlannerState({
                      open: true,
                      dateStr: targetDate,
                      file: null,
                      prefill: {
                        asset: res.asset,
                        brief: res.brief,
                        metadata: res.metadata,
                        engineUsed: res.engineUsed,
                        startStep: '3',
                      },
                    });
                    notify(
                      'success',
                      `นำเข้าคลิป & หน้าปกจาก SyncCut และสร้างคำอธิบายทุกแพลตฟอร์มแล้ว`
                    );
                  }}
                />
              )}

              {tab === 'schedule' && (
                <ScheduleMatrixView
                  channel={activeChannel}
                  onNotify={notify}
                />
              )}

              {tab === 'jobs' && (
                <JobsView
                  channel={activeChannel}
                  jobs={jobs}
                  onRefresh={loadChannelWork}
                  onNotify={notify}
                />
              )}

              {tab === 'channels' && (
                <ChannelsView
                  channels={channels}
                  activeChannel={activeChannel}
                  maxChannels={maxChannels}
                  onSelectChannel={setActiveChannelId}
                  onReload={loadChannelsAndHealth}
                  onNotify={notify}
                />
              )}

              {tab === 'settings' && (
                <TemplatesSettingsView
                  channel={activeChannel}
                  onSettingsUpdated={loadChannelsAndHealth}
                  onNotify={notify}
                />
              )}
            </>
          )}
        </main>
      </div>

      {plannerState.open && activeChannel && (
        <ContentPlannerModal
          channel={activeChannel}
          initialDate={plannerState.dateStr}
          initialFile={plannerState.file}
          prefill={plannerState.prefill}
          onClose={() =>
            setPlannerState({
              open: false,
              dateStr: plannerState.dateStr,
              prefill: null,
            })
          }
          onCreated={async () => {
            await loadChannelWork();
            notify('success', 'วางคลิปและเริ่มตารางเผยแพร่อัตโนมัติแล้ว');
          }}
        />
      )}
    </div>
  );
}
export default App;
