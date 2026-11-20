import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Film,
  ImagePlus,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import {
  calculateYouTubeTagsLength,
  determinePublishStrategy,
  extractHashtags,
  extractMentions,
  getLocalDateTimeParts,
  utf8ByteLength,
  validateFormatMetadata,
  zonedDateTimeToUtcIso,
  type ContentFormat,
  type FacebookReelsMetadata,
  type FacebookVideoMetadata,
  type InstagramReelsMetadata,
  type MasterBrief,
  type MediaAsset,
  type PlatformMetadataMap,
  type ResolvedSlot,
  type SyncCutEpisodeSummary,
  type TikTokMetadata,
  type ToneStyle,
  type ValidationIssue,
  type YouTubeMetadata,
} from '@clipflow/shared';
import { api, type ChannelWithAccounts, type MediaUploadResponse } from '../api';
import {
  AppleSwitch,
  InsetGroup,
  InsetRow,
  SegmentedControl,
} from './AppleUI';
import { FORMAT_LABELS, PlatformPill, StrategyBadge } from './PlatformBadge';

export interface PlannerPrefill {
  asset: MediaAsset;
  brief: MasterBrief;
  metadata: PlatformMetadataMap;
  engineUsed?: string;
  startStep?: '1' | '2' | '3';
}

interface Props {
  channel: ChannelWithAccounts;
  initialDate: string;
  initialFile?: File | null;
  prefill?: PlannerPrefill | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

interface TargetDraft {
  socialAccountId: string;
  accountName: string;
  platform: ResolvedSlot['platform'];
  format: ContentFormat;
  targetDate: string;
  localTime: string;
  strategy: ResolvedSlot['strategy'];
  enabled: boolean;
  wasPastSlot?: boolean;
  nominalLocalTime?: string;
  allowImmediate?: boolean;
}

type SheetStep = '1' | '2' | '3';

export function ContentPlannerModal({
  channel,
  initialDate,
  initialFile,
  prefill,
  onClose,
  onCreated,
}: Props) {
  const [step, setStep] = useState<SheetStep>(prefill?.startStep ?? '1');
  const [sourceTab, setSourceTab] = useState<'upload' | 'synccut' | 'library'>('upload');
  const [targetDate, setTargetDate] = useState(initialDate);
  const [asset, setAsset] = useState<MediaAsset | null>(prefill?.asset ?? null);
  const [coverVersion, setCoverVersion] = useState(1);
  const [existingMedia, setExistingMedia] = useState<MediaAsset[]>([]);
  const [synccutEpisodes, setSynccutEpisodes] = useState<SyncCutEpisodeSummary[]>([]);
  const [importingEpId, setImportingEpId] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [targets, setTargets] = useState<TargetDraft[]>([]);
  const [brief, setBrief] = useState<MasterBrief>(
    prefill?.brief ?? {
      topic: '',
      hook: '',
      summary: '',
      keyPoints: [],
      cta: '',
      coreHashtags: [],
      language: 'th',
      tone: channel.defaultTone || 'FRIENDLY',
      timestampsText: '',
    }
  );
  const [keyPointsText, setKeyPointsText] = useState(
    (prefill?.brief?.keyPoints ?? []).join('\n')
  );
  const [hashtagsText, setHashtagsText] = useState(
    (prefill?.brief?.coreHashtags ?? []).join(' ')
  );

  const [platformMeta, setPlatformMeta] = useState<PlatformMetadataMap>(
    prefill?.metadata ?? {}
  );
  const [activeTab, setActiveTab] = useState<ContentFormat>('YOUTUBE_SHORTS');
  const [generating, setGenerating] = useState(false);
  const [engineUsedMsg, setEngineUsedMsg] = useState<string | null>(
    prefill?.engineUsed
      ? `นำเข้าจาก SyncCut Studio และสร้างคำอธิบายด้วย ${prefill.engineUsed}`
      : null
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void api.listMedia(channel.id).then((res) => setExistingMedia(res.assets));
    void api
      .listSyncCutEpisodes()
      .then((res) => setSynccutEpisodes(res.episodes.filter((e) => e.hasVideo)))
      .catch(() => {});
  }, [channel.id]);

  useEffect(() => {
    if (initialFile) {
      void handleUploadFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  useEffect(() => {
    const category = asset?.clipCategory ?? 'SHORT';
    void api.resolveSlots(channel.id, targetDate, category).then((res) => {
      setTargets((prev) => {
        const prevMap = new Map(prev.map((p) => [p.socialAccountId, p]));
        return res.slots.map((slot) => {
          const old = prevMap.get(slot.socialAccountId);
          let format = slot.format;
          if (
            !old &&
            format === 'FACEBOOK_REELS' &&
            asset &&
            asset.probe.durationSec > 90
          ) {
            format = 'FACEBOOK_VIDEO';
          }
          return {
            socialAccountId: slot.socialAccountId,
            accountName: slot.accountName,
            platform: slot.platform,
            format,
            targetDate: slot.targetDate ?? targetDate,
            localTime: slot.localTime,
            strategy: slot.strategy,
            enabled: old ? old.enabled : true,
            wasPastSlot: slot.wasPastSlot,
            nominalLocalTime: slot.nominalLocalTime,
            allowImmediate: false,
          };
        });
      });
    });
  }, [channel.id, targetDate, asset?.clipCategory, asset?.probe.durationSec]);

  function getTargetScheduledMs(t: TargetDraft): number {
    try {
      const iso = zonedDateTimeToUtcIso(t.targetDate, t.localTime, channel.timezone);
      return new Date(iso).getTime();
    } catch {
      return Number.NaN;
    }
  }

  function updateTargetDraft(
    socialAccountId: string,
    patch: Partial<Pick<TargetDraft, 'format' | 'targetDate' | 'localTime' | 'enabled' | 'allowImmediate'>>
  ) {
    const now = new Date();
    const accMap = new Map(channel.accounts.map((a) => [a.id, a]));
    setTargets((prev) =>
      prev.map((item) => {
        if (item.socialAccountId !== socialAccountId) return item;
        const next: TargetDraft = { ...item, ...patch };
        if (patch.targetDate !== undefined || patch.localTime !== undefined || patch.format !== undefined) {
          try {
            const iso = zonedDateTimeToUtcIso(
              next.targetDate,
              next.localTime,
              channel.timezone
            );
            const acc = accMap.get(item.socialAccountId);
            if (acc) {
              next.strategy =
                acc.connectionMode === 'UNIFIED_API'
                  ? 'JIT_PUBLISH'
                  : determinePublishStrategy(next.format, iso, acc, now);
            }
            if (new Date(iso).getTime() > now.getTime()) {
              next.allowImmediate = false;
            }
          } catch {
            // Keep existing strategy while user is typing partial time
          }
        }
        return next;
      })
    );
  }

  function scheduleTargetMinutesAhead(socialAccountId: string, minutesAhead = 15) {
    const future = new Date(Date.now() + minutesAhead * 60_000);
    const parts = getLocalDateTimeParts(future, channel.timezone);
    updateTargetDraft(socialAccountId, {
      targetDate: parts.dateStr,
      localTime: parts.localTime,
      allowImmediate: false,
    });
  }

  const pastEnabledTargets = useMemo(() => {
    const nowMs = Date.now();
    return targets.filter((t) => {
      if (!t.enabled) return false;
      const ms = getTargetScheduledMs(t);
      return Number.isFinite(ms) && ms <= nowMs;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, channel.timezone]);

  const unconfirmedPastTargets = useMemo(
    () => pastEnabledTargets.filter((t) => !t.allowImmediate),
    [pastEnabledTargets]
  );

  const hasAutoShiftedTargets = useMemo(
    () => targets.some((t) => t.enabled && t.wasPastSlot && t.targetDate !== targetDate),
    [targets, targetDate]
  );

  const enabledFormats = useMemo(
    () => targets.filter((t) => t.enabled).map((t) => t.format),
    [targets]
  );

  useEffect(() => {
    if (enabledFormats.length > 0 && !enabledFormats.includes(activeTab)) {
      setActiveTab(enabledFormats[0]);
    }
  }, [enabledFormats, activeTab]);

  const allIssues = useMemo(() => {
    const out: ValidationIssue[] = [];
    for (const fmt of enabledFormats) {
      const m = platformMeta[fmt] as Record<string, unknown> | undefined;
      out.push(...validateFormatMetadata(fmt, m, asset?.probe));
    }
    return out;
  }, [enabledFormats, platformMeta, asset?.probe]);

  const hardErrors = allIssues.filter((i) => i.severity === 'error');

  async function handleUploadFile(file: File) {
    setErrorMsg(null);
    setUploadPct(0);
    try {
      const res: MediaUploadResponse = await api.uploadMediaWithProgress(
        channel.id,
        file,
        setUploadPct
      );
      setAsset(res.asset);
      setUploadPct(null);
      if (!brief.topic) {
        const cleanTitle = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
        setBrief((b) => ({ ...b, topic: cleanTitle, hook: cleanTitle }));
      }
      setExistingMedia((list) => [res.asset, ...list]);
    } catch (err) {
      setUploadPct(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOptimizeVideo() {
    if (!asset) return;
    setOptimizing(true);
    setErrorMsg(null);
    try {
      const res = await api.optimizeMedia(asset.id);
      setAsset(res.asset);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setOptimizing(false);
    }
  }

  async function handleUploadCustomCover(file: File) {
    if (!asset) return;
    setUploadingCover(true);
    setErrorMsg(null);
    try {
      const res = await api.uploadCustomCover(asset.id, file);
      setAsset(res.asset);
      setCoverVersion((v) => v + 1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingCover(false);
    }
  }

  async function handleImportSyncCutInModal(ep: SyncCutEpisodeSummary) {
    setImportingEpId(ep.episodeId);
    setErrorMsg(null);
    try {
      const res = await api.importSyncCutEpisode({
        channelId: channel.id,
        episodeId: ep.episodeId,
        exportId: ep.exportId ?? undefined,
      });
      setAsset(res.asset);
      setBrief(res.brief);
      setKeyPointsText((res.brief.keyPoints ?? []).join('\n'));
      setHashtagsText((res.brief.coreHashtags ?? []).join(' '));
      setPlatformMeta(res.metadata);
      setEngineUsedMsg(
        `นำเข้าจาก SyncCut Studio และสร้างคำอธิบายด้วย ${res.engineUsed}`
      );
      setCoverVersion((v) => v + 1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingEpId(null);
    }
  }

  async function handleGenerateMetadata(advanceToStep3 = true) {
    if (enabledFormats.length === 0) return;
    setGenerating(true);
    setErrorMsg(null);
    try {
      const parsedBrief: MasterBrief = {
        ...brief,
        keyPoints: keyPointsText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        coreHashtags: hashtagsText
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      setBrief(parsedBrief);
      const res = await api.generateMetadata({
        channelId: channel.id,
        mediaAssetId: asset?.id,
        formats: enabledFormats,
        brief: parsedBrief,
      });
      setPlatformMeta((prev) => ({ ...prev, ...res.metadata }));
      setEngineUsedMsg(
        res.warning
          ? res.warning
          : `สร้างข้อความเฉพาะแพลตฟอร์มสำเร็จ (${res.engineUsed === 'DETERMINISTIC' ? 'Smart Rule Engine' : res.engineUsed})`
      );
      if (advanceToStep3) {
        setStep('3');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  function updateFormatMeta<K extends ContentFormat>(
    fmt: K,
    patch: Partial<NonNullable<PlatformMetadataMap[K]>>
  ) {
    setPlatformMeta((prev) => ({
      ...prev,
      [fmt]: { ...(prev[fmt] as object), ...patch },
    }));
  }

  function switchFbReelsToVideo() {
    setTargets((prev) =>
      prev.map((t) =>
        t.format === 'FACEBOOK_REELS'
          ? { ...t, format: 'FACEBOOK_VIDEO', strategy: 'NATIVE_PREUPLOAD' }
          : t
      )
    );
    const cur = platformMeta.FACEBOOK_REELS;
    if (cur && !platformMeta.FACEBOOK_VIDEO) {
      setPlatformMeta((prev) => ({
        ...prev,
        FACEBOOK_VIDEO: {
          title: cur.title || brief.topic || 'Facebook Video',
          description: cur.description || brief.summary || '',
        },
      }));
    }
    setActiveTab('FACEBOOK_VIDEO');
  }

  async function handleSubmit() {
    if (!asset) {
      setErrorMsg('กรุณาอัปโหลดหรือเลือกไฟล์วิดีโอก่อน');
      setStep('1');
      return;
    }
    const chosen = targets.filter((t) => t.enabled);
    if (chosen.length === 0) {
      setErrorMsg('กรุณาเลือกอย่างน้อย 1 แพลตฟอร์ม');
      setStep('1');
      return;
    }
    if (unconfirmedPastTargets.length > 0) {
      setErrorMsg(
        `เวลาของ ${unconfirmedPastTargets.map((t) => `${t.platform} (${t.targetDate} ${t.localTime})`).join(', ')} ผ่านมาแล้ว กรุณาเลือกเวลาล่วงหน้าหรือยืนยันโพสต์ทันทีในขั้นตอนที่ 1`
      );
      setStep('1');
      return;
    }
    if (hardErrors.length > 0) {
      setErrorMsg(hardErrors[0].message);
      setStep('3');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.createContent({
        channelId: channel.id,
        mediaAssetId: asset.id,
        targetDate,
        masterBrief: {
          ...brief,
          keyPoints: keyPointsText
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          coreHashtags: hashtagsText
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
        platformMetadata: platformMeta,
        targets: chosen.map((t) => ({
          socialAccountId: t.socialAccountId,
          format: t.format,
          targetDate: t.targetDate,
          localTime: t.localTime,
          allowImmediate: Boolean(t.allowImmediate),
        })),
      });
      await onCreated();
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const tiktokAccount = channel.accounts.find((a) => a.platform === 'TIKTOK');
  const tiktokPrivacyOpts = tiktokAccount?.creatorInfo?.privacyLevelOptions ?? [
    'PUBLIC_TO_EVERYONE',
    'MUTUAL_FOLLOW_FRIENDS',
    'SELF_ONLY',
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-3 backdrop-blur-sm md:p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-[22px] border bg-apple-window shadow-apple-sheet"
        style={{ borderColor: 'var(--separator)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sheet Header + Centered 3-Step Apple Segmented Stepper */}
        <div
          className="apple-glass flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4"
          style={{ borderColor: 'var(--separator)' }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: channel.color }}
            />
            <div>
              <h2 className="apple-headline text-[15px] text-apple-label">
                วางคลิปใหม่ — {channel.name}
              </h2>
              <p className="text-[11px] text-apple-secondary tabular-nums">
                วันที่ {targetDate}
                {hasAutoShiftedTargets ? ' (บางแพลตฟอร์มเลื่อนวันถัดไปอัตโนมัติ)' : ''} •{' '}
                {enabledFormats.length} แพลตฟอร์ม
              </p>
            </div>
          </div>

          <SegmentedControl
            size="sm"
            value={step}
            onChange={setStep}
            options={[
              { value: '1', label: '1. วิดีโอและเวลา' },
              { value: '2', label: '2. บรีฟหลัก' },
              {
                value: '3',
                label: '3. ปรับแต่งแพลตฟอร์ม',
                dot: hardErrors.length > 0,
              },
            ]}
          />

          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-apple-grouped p-1.5 text-apple-secondary transition hover:text-apple-label"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* STEP 1: Video, FFprobe Inspection, Date & Platform Times */}
          {step === '1' && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              {/* Video Picker / Preview */}
              <div className="space-y-4 lg:col-span-6">
                {!asset ? (
                  <div className="space-y-4">
                    <SegmentedControl
                      size="sm"
                      value={sourceTab}
                      onChange={setSourceTab}
                      options={[
                        { value: 'upload', label: 'อัปโหลดไฟล์' },
                        {
                          value: 'synccut',
                          label: `จาก SyncCut (${synccutEpisodes.length})`,
                        },
                        {
                          value: 'library',
                          label: `คลัง (${existingMedia.length})`,
                        },
                      ]}
                    />

                    {sourceTab === 'upload' && (
                      <>
                        <label
                          className="flex cursor-pointer flex-col items-center justify-center rounded-[18px] border-2 border-dashed bg-apple-grouped/50 p-8 text-center transition hover:border-apple-blue"
                          style={{ borderColor: 'var(--separator-strong)' }}
                        >
                          <div
                            className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-sm"
                            style={{ backgroundColor: 'var(--apple-blue)' }}
                          >
                            <Upload className="h-6 w-6" />
                          </div>
                          <span className="text-[14px] font-semibold text-apple-label">
                            เลือกไฟล์วิดีโอ (.mp4 / .mov)
                          </span>
                          <span className="mt-1 text-[12px] text-apple-secondary">
                            รองรับคลิปแนวตั้ง & คลิปยาวสูงสุด 15 นาที (วิเคราะห์สเปกด้วย FFprobe)
                          </span>
                          <input
                            type="file"
                            accept="video/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void handleUploadFile(f);
                            }}
                          />
                        </label>

                        {uploadPct !== null && (
                          <div className="apple-card p-3.5 space-y-1.5">
                            <div className="flex justify-between text-[12px] font-medium text-apple-label tabular-nums">
                              <span>กำลังอัปโหลดและวิเคราะห์วิดีโอ...</span>
                              <span>{uploadPct}%</span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-apple-grouped">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${uploadPct}%`,
                                  backgroundColor: 'var(--apple-blue)',
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {sourceTab === 'synccut' && (
                      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                        {synccutEpisodes.length === 0 ? (
                          <p className="apple-card p-6 text-center text-[12px] text-apple-tertiary">
                            ไม่พบคลิปที่ Export เสร็จใน SyncCut Studio
                          </p>
                        ) : (
                          synccutEpisodes.map((ep) => (
                            <button
                              key={ep.episodeId}
                              type="button"
                              disabled={importingEpId === ep.episodeId}
                              onClick={() => void handleImportSyncCutInModal(ep)}
                              className="apple-card flex w-full items-center gap-3 p-2.5 text-left transition hover:border-apple-blue"
                            >
                              {ep.hasCover ? (
                                <img
                                  src={`/api/integrations/synccut/episodes/${ep.episodeId}/cover`}
                                  alt={ep.cleanTitle}
                                  className="h-14 w-11 shrink-0 rounded-lg object-cover bg-black"
                                />
                              ) : (
                                <div className="flex h-14 w-11 shrink-0 items-center justify-center rounded-lg bg-apple-grouped">
                                  <Film className="h-4 w-4 text-apple-secondary" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[12.5px] font-semibold text-apple-label">
                                  {ep.cleanTitle}
                                </p>
                                <p className="text-[11px] text-apple-secondary tabular-nums">
                                  {ep.aspectRatio} •{' '}
                                  {ep.durationSec !== null
                                    ? `${Math.round(ep.durationSec)}s`
                                    : ''}{' '}
                                  • {ep.hasCover ? 'มีหน้าปก ✓' : 'ไม่มีปก'}
                                </p>
                              </div>
                              <span className="shrink-0 text-[11px] font-semibold text-apple-blue">
                                {importingEpId === ep.episodeId
                                  ? 'กำลังนำเข้า...'
                                  : 'เลือก'}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}

                    {sourceTab === 'library' && (
                      <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1">
                        {existingMedia.length === 0 ? (
                          <p className="col-span-2 apple-card p-6 text-center text-[12px] text-apple-tertiary">
                            ยังไม่มีวิดีโอในคลัง
                          </p>
                        ) : (
                          existingMedia.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setAsset(m)}
                              className="apple-card flex items-center gap-2.5 p-2 text-left transition hover:border-apple-blue"
                            >
                              {m.customCoverKey ? (
                                <img
                                  src={`/api/media/${m.id}/custom-cover`}
                                  alt={m.originalFilename}
                                  className="h-10 w-10 shrink-0 rounded-lg object-cover"
                                />
                              ) : m.thumbnailPaths[0] ? (
                                <img
                                  src={`/api/media/${m.id}/thumbnail/0`}
                                  alt={m.originalFilename}
                                  className="h-10 w-10 shrink-0 rounded-lg object-cover"
                                />
                              ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-apple-grouped">
                                  <Film className="h-4 w-4 text-apple-secondary" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <p className="truncate text-[12px] font-medium text-apple-label">
                                  {m.originalFilename}
                                </p>
                                <p className="text-[10.5px] text-apple-secondary tabular-nums">
                                  {Math.round(m.probe.durationSec)}s •{' '}
                                  {m.orientation}
                                </p>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="apple-card overflow-hidden p-3.5 space-y-3">
                    <div className="overflow-hidden rounded-[12px] bg-black">
                      <video
                        src={`/api/media/${asset.id}/stream`}
                        controls
                        className="max-h-56 w-full object-contain"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <span className="font-medium text-apple-label tabular-nums">
                        {asset.probe.width}×{asset.probe.height} •{' '}
                        {Math.round(asset.probe.durationSec)}s •{' '}
                        {asset.probe.videoCodec.toUpperCase()} •{' '}
                        {(asset.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
                      </span>
                      <button
                        type="button"
                        onClick={() => setAsset(null)}
                        className="text-[12px] font-medium text-apple-blue hover:underline"
                      >
                        เปลี่ยนไฟล์
                      </button>
                    </div>

                    {/* Custom Cover (from SyncCut or manual upload) */}
                    <div className="flex items-center justify-between gap-3 rounded-[12px] border bg-apple-grouped/50 p-2.5" style={{ borderColor: 'var(--separator)' }}>
                      <div className="flex items-center gap-2.5">
                        {asset.customCoverKey ? (
                          <img
                            src={`/api/media/${asset.id}/custom-cover?v=${coverVersion}`}
                            alt="Custom Cover"
                            className="h-12 w-10 shrink-0 rounded-lg object-cover border"
                            style={{ borderColor: 'var(--apple-green)' }}
                          />
                        ) : (
                          <div className="flex h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-apple-card border" style={{ borderColor: 'var(--separator)' }}>
                            <ImagePlus className="h-4 w-4 text-apple-tertiary" />
                          </div>
                        )}
                        <div>
                          <p className="text-[12px] font-semibold text-apple-label">
                            {asset.customCoverKey
                              ? asset.sourceMeta?.sourceApp
                                ? `หน้าปกจาก ${asset.sourceMeta.sourceApp} ✓`
                                : 'หน้าปกกำหนดเอง ✓'
                              : 'ยังไม่มีหน้าปกกำหนดเอง'}
                          </p>
                          <p className="text-[10.5px] text-apple-secondary">
                            ใช้กับ YouTube / Facebook / IG Cover URL
                          </p>
                        </div>
                      </div>

                      <label className="apple-btn-secondary cursor-pointer py-1 px-2.5 text-[11px]">
                        <ImagePlus className="h-3.5 w-3.5 text-apple-blue" />
                        {uploadingCover ? 'กำลังอัปโหลด...' : 'อัปโหลดปก'}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleUploadCustomCover(f);
                          }}
                        />
                      </label>
                    </div>

                    {asset.thumbnailPaths.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[11px] font-medium text-apple-secondary">
                          {asset.customCoverKey
                            ? 'หรือสลับเลือกเฟรมจากวิดีโอ'
                            : 'เลือกภาพปกจากวิดีโอ (Thumbnail)'}
                        </p>
                        <div className="grid grid-cols-4 gap-2">
                          {asset.thumbnailPaths.map((_, idx) => {
                            const selected =
                              (platformMeta.YOUTUBE_SHORTS?.thumbnailIndex ??
                                platformMeta.YOUTUBE_LONG?.thumbnailIndex ??
                                0) === idx;
                            return (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => {
                                  if (platformMeta.YOUTUBE_SHORTS) {
                                    updateFormatMeta('YOUTUBE_SHORTS', {
                                      thumbnailIndex: idx,
                                    });
                                  }
                                  if (platformMeta.YOUTUBE_LONG) {
                                    updateFormatMeta('YOUTUBE_LONG', {
                                      thumbnailIndex: idx,
                                    });
                                  }
                                }}
                                className={`overflow-hidden rounded-[10px] border-2 transition ${
                                  selected
                                    ? 'border-apple-blue ring-2 ring-apple-blue/25'
                                    : 'border-transparent opacity-75 hover:opacity-100'
                                }`}
                              >
                                <img
                                  src={`/api/media/${asset.id}/thumbnail/${idx}`}
                                  alt={`Thumb ${idx + 1}`}
                                  className="h-14 w-full object-cover"
                                />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between rounded-[11px] bg-apple-grouped px-3 py-2">
                      <span className="text-[11.5px] text-apple-secondary">
                        Faststart (IG/FB):{' '}
                        {asset.probe.hasFaststartMoov === true ? (
                          <strong className="text-apple-green">พร้อม ✓</strong>
                        ) : (
                          <strong className="text-apple-orange">
                            แนะนำ Optimize
                          </strong>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleOptimizeVideo()}
                        disabled={optimizing}
                        className="apple-btn-secondary py-1 px-3 text-[11.5px]"
                      >
                        <Wand2 className="h-3 w-3" />
                        {optimizing ? 'กำลัง Optimize...' : 'Optimize (FFmpeg)'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Date & Platform Targets */}
              <div className="space-y-4 lg:col-span-6">
                <InsetGroup title="วันที่ลงคลิป">
                  <InsetRow className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-apple-label">
                      วันที่เป้าหมาย
                    </span>
                    <input
                      type="date"
                      value={targetDate}
                      onChange={(e) => setTargetDate(e.target.value)}
                      className="apple-input w-auto tabular-nums"
                    />
                  </InsetRow>
                </InsetGroup>

                <InsetGroup title="แพลตฟอร์ม & เวลาแยกตามวันในสัปดาห์">
                  {targets.map((t) => {
                    const fbTooLong =
                      t.format === 'FACEBOOK_REELS' &&
                      asset &&
                      asset.probe.durationSec > 90;
                    const schedMs = getTargetScheduledMs(t);
                    const isPastDue =
                      t.enabled && Number.isFinite(schedMs) && schedMs <= Date.now();
                    const isAutoShifted =
                      t.wasPastSlot && t.targetDate !== targetDate && !isPastDue;

                    return (
                      <InsetRow key={t.socialAccountId} className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5">
                            <AppleSwitch
                              checked={t.enabled}
                              onChange={(val) =>
                                updateTargetDraft(t.socialAccountId, { enabled: val })
                              }
                            />
                            <PlatformPill platform={t.platform} />
                            <select
                              value={t.format}
                              disabled={!t.enabled}
                              onChange={(e) =>
                                updateTargetDraft(t.socialAccountId, {
                                  format: e.target.value as ContentFormat,
                                })
                              }
                              className="apple-input w-auto py-1 text-[12px]"
                            >
                              {t.platform === 'YOUTUBE' && (
                                <>
                                  <option value="YOUTUBE_SHORTS">Shorts</option>
                                  <option value="YOUTUBE_LONG">คลิปยาว</option>
                                </>
                              )}
                              {t.platform === 'TIKTOK' && (
                                <option value="TIKTOK">TikTok</option>
                              )}
                              {t.platform === 'INSTAGRAM' && (
                                <option value="INSTAGRAM_REELS">IG Reels</option>
                              )}
                              {t.platform === 'FACEBOOK' && (
                                <>
                                  <option value="FACEBOOK_REELS">
                                    Reels (≤90s)
                                  </option>
                                  <option value="FACEBOOK_VIDEO">
                                    วิดีโอเพจ
                                  </option>
                                </>
                              )}
                            </select>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <input
                              type="date"
                              value={t.targetDate}
                              disabled={!t.enabled}
                              onChange={(e) =>
                                updateTargetDraft(t.socialAccountId, {
                                  targetDate: e.target.value,
                                })
                              }
                              className="apple-input w-auto py-1 text-[11.5px] tabular-nums"
                            />
                            <input
                              type="time"
                              value={t.localTime}
                              disabled={!t.enabled}
                              onChange={(e) =>
                                updateTargetDraft(t.socialAccountId, {
                                  localTime: e.target.value,
                                })
                              }
                              className="apple-input w-auto py-1 text-[12px] font-semibold tabular-nums"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between pl-1">
                          <span className="text-[11px] text-apple-tertiary">
                            {t.accountName}
                          </span>
                          <StrategyBadge strategy={t.strategy} isPastDue={isPastDue} />
                        </div>

                        {isAutoShifted && t.enabled && (
                          <div
                            className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-[11.5px]"
                            style={{
                              backgroundColor: 'rgba(255, 149, 0, 0.12)',
                              color: 'var(--apple-orange)',
                            }}
                          >
                            <span>
                              เวลาแนะนำของวันนี้ ({t.nominalLocalTime}) ผ่านมาแล้ว • เลื่อนเป็นรอบถัดไป ({t.targetDate} {t.localTime}) เพื่อกันโพสต์ทันที
                            </span>
                            <button
                              type="button"
                              onClick={() => scheduleTargetMinutesAhead(t.socialAccountId, 15)}
                              className="font-semibold underline"
                            >
                              ตั้งเป็นวันนี้ +15 นาที
                            </button>
                          </div>
                        )}

                        {isPastDue && (
                          <div
                            className="space-y-2 rounded-[10px] px-3 py-2 text-[11.5px]"
                            style={{
                              backgroundColor: 'rgba(255, 59, 48, 0.10)',
                              color: 'var(--apple-red)',
                            }}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span>
                                ⚠️ เวลาที่เลือก ({t.targetDate} {t.localTime}) ผ่านมาแล้ว — ระบบจะโพสต์ทันทีที่กดวางคลิป
                              </span>
                              <button
                                type="button"
                                onClick={() => scheduleTargetMinutesAhead(t.socialAccountId, 15)}
                                className="font-semibold underline"
                              >
                                เลื่อนเป็น +15 นาที (ตั้งเวลาล่วงหน้า)
                              </button>
                            </div>
                            <label className="flex items-center gap-2 text-[11.5px] font-medium cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={Boolean(t.allowImmediate)}
                                onChange={(e) =>
                                  updateTargetDraft(t.socialAccountId, {
                                    allowImmediate: e.target.checked,
                                  })
                                }
                              />
                              <span>ยืนยันต้องการโพสต์คลิปนี้ทันที</span>
                            </label>
                          </div>
                        )}

                        {fbTooLong && t.enabled && (
                          <div
                            className="flex items-center justify-between rounded-[10px] px-3 py-2 text-[11.5px]"
                            style={{
                              backgroundColor: 'rgba(255, 149, 0, 0.12)',
                              color: 'var(--apple-orange)',
                            }}
                          >
                            <span>
                              ยาว {Math.round(asset.probe.durationSec)}s เกิน FB Reels (90s)
                            </span>
                            <button
                              type="button"
                              onClick={switchFbReelsToVideo}
                              className="inline-flex items-center gap-1 font-semibold underline"
                            >
                              <ArrowRightLeft className="h-3 w-3" />
                              สลับเป็นวิดีโอเพจ
                            </button>
                          </div>
                        )}
                      </InsetRow>
                    );
                  })}
                </InsetGroup>
              </div>
            </div>
          )}

          {/* STEP 2: Master Brief & 1-Click Generation */}
          {step === '2' && (
            <div className="mx-auto max-w-2xl space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="apple-headline text-[16px] text-apple-label">
                    บรีฟหลักของคลิป (Master Brief)
                  </h3>
                  <p className="text-[12.5px] text-apple-secondary">
                    กรอกเนื้อหาครั้งเดียว แล้วให้ระบบปรับแต่งชื่อและคำอธิบายให้เหมาะกับแต่ละแพลตฟอร์มอัตโนมัติ
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleGenerateMetadata(true)}
                  disabled={generating || enabledFormats.length === 0}
                  className="apple-btn-primary"
                >
                  <Sparkles className="h-4 w-4" />
                  {generating ? 'กำลังสร้าง...' : 'สร้างคำอธิบายทุกแพลตฟอร์ม'}
                </button>
              </div>

              <InsetGroup title="เนื้อหาหลัก">
                <InsetRow className="space-y-1.5">
                  <label className="text-[12px] font-medium text-apple-secondary">
                    หัวข้อคลิป (Topic)
                  </label>
                  <input
                    value={brief.topic}
                    onChange={(e) =>
                      setBrief((b) => ({ ...b, topic: e.target.value }))
                    }
                    placeholder="เช่น 5 เทคนิคประหยัดเวลาตัดต่อคลิปใน 1 นาที"
                    className="apple-input"
                  />
                </InsetRow>
                <InsetRow className="space-y-1.5">
                  <label className="text-[12px] font-medium text-apple-secondary">
                    ประโยคเปิดดึงดูด (Hook)
                  </label>
                  <input
                    value={brief.hook}
                    onChange={(e) =>
                      setBrief((b) => ({ ...b, hook: e.target.value }))
                    }
                    placeholder="เช่น อย่าเพิ่งลงคลิปถ้ายังไม่ได้ตั้งค่า 3 จุดนี้!"
                    className="apple-input"
                  />
                </InsetRow>
                <InsetRow className="space-y-1.5">
                  <label className="text-[12px] font-medium text-apple-secondary">
                    สรุปเนื้อหา (Summary)
                  </label>
                  <textarea
                    rows={3}
                    value={brief.summary}
                    onChange={(e) =>
                      setBrief((b) => ({ ...b, summary: e.target.value }))
                    }
                    placeholder="อธิบายสั้นๆ ว่าคนดูจะได้อะไรจากคลิปนี้"
                    className="apple-input"
                  />
                </InsetRow>
                <InsetRow className="space-y-1.5">
                  <label className="text-[12px] font-medium text-apple-secondary">
                    จุดเด่น / Key Points (ขึ้นบรรทัดใหม่ทีละข้อ)
                  </label>
                  <textarea
                    rows={3}
                    value={keyPointsText}
                    onChange={(e) => setKeyPointsText(e.target.value)}
                    placeholder={'ตั้งเวลาลงต่างกันตามแพลตฟอร์ม\nตรวจสัดส่วน 9:16 และ Faststart'}
                    className="apple-input"
                  />
                </InsetRow>
              </InsetGroup>

              <InsetGroup title="สไตล์ & แฮชแท็ก">
                <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-[12px] font-medium text-apple-secondary">
                      Hashtags หลัก (เว้นวรรค)
                    </label>
                    <input
                      value={hashtagsText}
                      onChange={(e) => setHashtagsText(e.target.value)}
                      placeholder="#ตัดต่อวิดีโอ #ครีเอเตอร์"
                      className="apple-input"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[12px] font-medium text-apple-secondary">
                      Call to Action
                    </label>
                    <input
                      value={brief.cta}
                      onChange={(e) =>
                        setBrief((b) => ({ ...b, cta: e.target.value }))
                      }
                      placeholder="เช่น กด Save เก็บไว้ดูได้เลย"
                      className="apple-input"
                    />
                  </div>
                </InsetRow>
                <InsetRow className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <span className="block text-[11.5px] font-medium text-apple-secondary">
                      ภาษา
                    </span>
                    <SegmentedControl
                      size="sm"
                      value={brief.language}
                      onChange={(val) =>
                        setBrief((b) => ({ ...b, language: val }))
                      }
                      options={[
                        { value: 'th', label: 'ไทย' },
                        { value: 'en', label: 'English' },
                        { value: 'bilingual', label: 'ไทย + EN' },
                      ]}
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="block text-[11.5px] font-medium text-apple-secondary">
                      โทนเสียง
                    </span>
                    <select
                      value={brief.tone}
                      onChange={(e) =>
                        setBrief((b) => ({
                          ...b,
                          tone: e.target.value as ToneStyle,
                        }))
                      }
                      className="apple-input w-auto"
                    >
                      <option value="FRIENDLY">เป็นกันเอง (Friendly)</option>
                      <option value="EDUCATIONAL">ให้ความรู้ (Educational)</option>
                      <option value="ENTERTAINING">สนุกสนาน (Entertaining)</option>
                      <option value="PROFESSIONAL">ทางการ (Professional)</option>
                      <option value="URGENT_HOOK">พาดหัวหยุดนิ้ว (Hook)</option>
                    </select>
                  </div>
                </InsetRow>
                <InsetRow className="space-y-1.5">
                  <label className="text-[12px] font-medium text-apple-secondary">
                    Chapters สำหรับคลิปยาว (ถ้ามี)
                  </label>
                  <input
                    value={brief.timestampsText || ''}
                    onChange={(e) =>
                      setBrief((b) => ({ ...b, timestampsText: e.target.value }))
                    }
                    placeholder="เช่น 00:00 เกริ่นนำ | 01:20 ขั้นตอน"
                    className="apple-input"
                  />
                </InsetRow>
              </InsetGroup>
            </div>
          )}

          {/* STEP 3: Per-Platform Metadata Refinement */}
          {step === '3' && (
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SegmentedControl
                  size="sm"
                  value={activeTab}
                  onChange={setActiveTab}
                  options={enabledFormats.map((fmt) => ({
                    value: fmt,
                    label: FORMAT_LABELS[fmt],
                    dot: allIssues.some(
                      (i) => i.format === fmt && i.severity === 'error'
                    ),
                  }))}
                />

                <button
                  type="button"
                  onClick={() => void handleGenerateMetadata(false)}
                  disabled={generating}
                  className="apple-btn-secondary text-[12px]"
                >
                  <Sparkles className="h-3.5 w-3.5 text-apple-blue" />
                  {generating ? 'กำลังสร้าง...' : 'สร้างใหม่อัตโนมัติ'}
                </button>
              </div>

              {engineUsedMsg && (
                <p className="text-[12px] font-medium text-apple-green">
                  {engineUsedMsg}
                </p>
              )}

              {(activeTab === 'YOUTUBE_SHORTS' ||
                activeTab === 'YOUTUBE_LONG') && (
                <YouTubeEditor
                  format={activeTab}
                  meta={
                    (platformMeta[activeTab] as YouTubeMetadata | undefined) ?? {
                      title: brief.topic || '',
                      description: brief.summary || '',
                      tags: [],
                      categoryId: '22',
                      privacyStatus: 'public',
                      madeForKids: false,
                      notifySubscribers: true,
                    }
                  }
                  onChange={(next) => updateFormatMeta(activeTab, next)}
                />
              )}

              {activeTab === 'TIKTOK' && (
                <TikTokEditor
                  meta={
                    (platformMeta.TIKTOK as TikTokMetadata | undefined) ?? {
                      caption: brief.hook || brief.topic || '',
                      privacyLevel:
                        tiktokPrivacyOpts[0] ?? 'PUBLIC_TO_EVERYONE',
                      allowComment: true,
                      allowDuet: true,
                      allowStitch: true,
                      brandOrganicToggle: false,
                      brandContentToggle: false,
                      isAigc: false,
                      coverTimestampMs: 0,
                    }
                  }
                  privacyOptions={tiktokPrivacyOpts}
                  creatorInfo={tiktokAccount?.creatorInfo ?? null}
                  onChange={(next) => updateFormatMeta('TIKTOK', next)}
                />
              )}

              {activeTab === 'INSTAGRAM_REELS' && (
                <InstagramEditor
                  meta={
                    (platformMeta.INSTAGRAM_REELS as
                      | InstagramReelsMetadata
                      | undefined) ?? {
                      caption: brief.hook || brief.topic || '',
                      shareToFeed: true,
                      thumbOffsetMs: 0,
                    }
                  }
                  onChange={(next) => updateFormatMeta('INSTAGRAM_REELS', next)}
                />
              )}

              {(activeTab === 'FACEBOOK_REELS' ||
                activeTab === 'FACEBOOK_VIDEO') && (
                <FacebookEditor
                  format={activeTab}
                  meta={
                    (platformMeta[activeTab] as
                      | FacebookReelsMetadata
                      | FacebookVideoMetadata
                      | undefined) ?? {
                      title: brief.topic || '',
                      description: brief.summary || '',
                    }
                  }
                  onChange={(next) => updateFormatMeta(activeTab, next)}
                />
              )}

              {allIssues.length > 0 && (
                <div className="apple-card p-3.5 space-y-1.5">
                  {allIssues.map((iss, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-2 text-[12px]"
                      style={{
                        color:
                          iss.severity === 'error'
                            ? 'var(--apple-red)'
                            : 'var(--apple-orange)',
                      }}
                    >
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        <strong>[{FORMAT_LABELS[iss.format]}]</strong>{' '}
                        {iss.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sheet Footer */}
        <div
          className="apple-glass flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3.5"
          style={{ borderColor: 'var(--separator)' }}
        >
          <div className="text-[12px]">
            {errorMsg ? (
              <span className="font-medium text-apple-red">{errorMsg}</span>
            ) : unconfirmedPastTargets.length > 0 ? (
              <span className="font-medium text-apple-red">
                มี {unconfirmedPastTargets.length} แพลตฟอร์มที่เลยเวลาแล้ว — กรุณาเลื่อนเวลาหรือยืนยันโพสต์ทันที
              </span>
            ) : hardErrors.length === 0 && asset ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-apple-green">
                <CheckCircle2 className="h-4 w-4" />
                พร้อมจัดตารางลง {enabledFormats.length} แพลตฟอร์ม
              </span>
            ) : (
              <span className="text-apple-secondary">
                ขั้นตอนที่ {step} จาก 3
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {step !== '1' && (
              <button
                type="button"
                onClick={() => setStep(step === '3' ? '2' : '1')}
                className="apple-btn-secondary"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                ย้อนกลับ
              </button>
            )}

            {step !== '3' && (
              <button
                type="button"
                onClick={() => setStep(step === '1' ? '2' : '3')}
                className="apple-btn-secondary"
              >
                ถัดไป
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || !asset || hardErrors.length > 0}
              className="apple-btn-primary"
            >
              <Film className="h-4 w-4" />
              {submitting
                ? 'กำลังบันทึก...'
                : 'วางคลิป & เริ่มระบบอัตโนมัติ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LimitBar({
  label,
  current,
  max,
  recommendedMax,
  unit,
}: {
  label: string;
  current: number;
  max: number;
  recommendedMax?: number;
  unit: string;
}) {
  const over = current > max;
  const overRec = !over && recommendedMax !== undefined && current > recommendedMax;
  const pct = Math.min(100, Math.round((current / max) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-[11.5px]">
        <span className="font-medium text-apple-secondary">{label}</span>
        <span
          className={`tabular-nums font-medium ${
            over
              ? 'text-apple-red'
              : overRec
                ? 'text-apple-orange'
                : 'text-apple-tertiary'
          }`}
        >
          {current.toLocaleString()} / {max.toLocaleString()} {unit}
          {recommendedMax !== undefined ? ` (ไม่บังคลิป ≤${recommendedMax})` : ''}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-apple-grouped">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            backgroundColor: over
              ? 'var(--apple-red)'
              : overRec
                ? 'var(--apple-orange)'
                : 'var(--apple-blue)',
          }}
        />
      </div>
    </div>
  );
}

function YouTubeEditor({
  format,
  meta,
  onChange,
}: {
  format: 'YOUTUBE_SHORTS' | 'YOUTUBE_LONG';
  meta: YouTubeMetadata;
  onChange: (patch: Partial<YouTubeMetadata>) => void;
}) {
  const descBytes = utf8ByteLength(meta.description);
  const tagsLen = calculateYouTubeTagsLength(meta.tags ?? []);

  return (
    <div className="space-y-4">
      <InsetGroup title={FORMAT_LABELS[format]}>
        <InsetRow className="space-y-2">
          <LimitBar
            label="ชื่อคลิป (Title)"
            current={meta.title.length}
            max={100}
            recommendedMax={format === 'YOUTUBE_SHORTS' ? 55 : 72}
            unit="ตัวอักษร"
          />
          <input
            value={meta.title}
            onChange={(e) => onChange({ title: e.target.value })}
            className="apple-input"
          />
        </InsetRow>
        <InsetRow className="space-y-2">
          <LimitBar
            label="คำอธิบาย (YouTube นับเป็น UTF-8 Bytes)"
            current={descBytes}
            max={5000}
            unit="bytes"
          />
          <textarea
            rows={5}
            value={meta.description}
            onChange={(e) => onChange({ description: e.target.value })}
            className="apple-input"
          />
        </InsetRow>
        <InsetRow className="space-y-2">
          <LimitBar
            label="Tags (คั่นด้วย ,)"
            current={tagsLen}
            max={500}
            unit="chars"
          />
          <input
            value={(meta.tags ?? []).join(', ')}
            onChange={(e) =>
              onChange({
                tags: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className="apple-input"
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">
            แจ้งเตือนผู้ติดตาม (Notify Subscribers)
          </span>
          <AppleSwitch
            checked={meta.notifySubscribers}
            onChange={(v) => onChange({ notifySubscribers: v })}
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">
            คลิปนี้สร้างมาเพื่อเด็ก (Made for Kids)
          </span>
          <AppleSwitch
            checked={meta.madeForKids}
            onChange={(v) => onChange({ madeForKids: v })}
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">
            เนื้อหาสร้าง/ดัดแปลงด้วย AI (Synthetic Media)
          </span>
          <AppleSwitch
            checked={Boolean(meta.containsSyntheticMedia)}
            onChange={(v) => onChange({ containsSyntheticMedia: v })}
          />
        </InsetRow>
      </InsetGroup>
    </div>
  );
}

function TikTokEditor({
  meta,
  privacyOptions,
  creatorInfo,
  onChange,
}: {
  meta: TikTokMetadata;
  privacyOptions: TikTokMetadata['privacyLevel'][];
  creatorInfo: ChannelWithAccounts['accounts'][number]['creatorInfo'];
  onChange: (patch: Partial<TikTokMetadata>) => void;
}) {
  return (
    <div className="space-y-4">
      <InsetGroup title="TikTok แคปชั่น">
        <InsetRow className="space-y-2">
          <LimitBar
            label="แคปชั่น & Hashtags"
            current={meta.caption.length}
            max={2200}
            recommendedMax={180}
            unit="ตัวอักษร"
          />
          <textarea
            rows={4}
            value={meta.caption}
            onChange={(e) => onChange({ caption: e.target.value })}
            className="apple-input"
          />
        </InsetRow>
      </InsetGroup>

      <InsetGroup title="การตั้งค่าตามข้อกำหนด TikTok Audit UX">
        <InsetRow className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-[11.5px] font-medium text-apple-secondary">
              Privacy Level
            </label>
            <select
              value={meta.privacyLevel}
              onChange={(e) =>
                onChange({
                  privacyLevel: e.target.value as TikTokMetadata['privacyLevel'],
                })
              }
              className="apple-input"
            >
              {privacyOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11.5px] font-medium text-apple-secondary">
              Cover Timestamp (ms)
            </label>
            <input
              type="number"
              min={0}
              step={500}
              value={meta.coverTimestampMs}
              onChange={(e) =>
                onChange({ coverTimestampMs: Number(e.target.value) || 0 })
              }
              className="apple-input tabular-nums"
            />
          </div>
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">Allow Comment</span>
          <AppleSwitch
            disabled={creatorInfo?.commentDisabled}
            checked={meta.allowComment}
            onChange={(v) => onChange({ allowComment: v })}
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">Allow Duet</span>
          <AppleSwitch
            disabled={creatorInfo?.duetDisabled}
            checked={meta.allowDuet}
            onChange={(v) => onChange({ allowDuet: v })}
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">Allow Stitch</span>
          <AppleSwitch
            disabled={creatorInfo?.stitchDisabled}
            checked={meta.allowStitch}
            onChange={(v) => onChange({ allowStitch: v })}
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">
            โปรโมตแบรนด์ตัวเอง (Your Brand)
          </span>
          <AppleSwitch
            checked={meta.brandOrganicToggle}
            onChange={(v) => onChange({ brandOrganicToggle: v })}
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">
            คอนเทนต์สปอนเซอร์ (Branded Content)
          </span>
          <AppleSwitch
            checked={meta.brandContentToggle}
            onChange={(v) => onChange({ brandContentToggle: v })}
          />
        </InsetRow>
        <InsetRow className="flex items-center justify-between">
          <span className="text-[13px] text-apple-label">
            สร้างด้วย AI (AIGC)
          </span>
          <AppleSwitch
            checked={meta.isAigc}
            onChange={(v) => onChange({ isAigc: v })}
          />
        </InsetRow>
      </InsetGroup>
    </div>
  );
}

function InstagramEditor({
  meta,
  onChange,
}: {
  meta: InstagramReelsMetadata;
  onChange: (patch: Partial<InstagramReelsMetadata>) => void;
}) {
  const hashCount = extractHashtags(meta.caption).length;
  const mentionCount = extractMentions(meta.caption).length;

  return (
    <InsetGroup title="Instagram Reels">
      <InsetRow className="space-y-2">
        <div className="flex items-center justify-between text-[11.5px]">
          <span className="font-medium text-apple-secondary">แคปชั่น</span>
          <span
            className={`tabular-nums ${
              meta.caption.length > 200
                ? 'font-medium text-apple-orange'
                : 'text-apple-tertiary'
            }`}
          >
            {meta.caption.length}/2,200 (ไม่บังคลิป ≤180) • #{hashCount}/30 • @{mentionCount}/20
          </span>
        </div>
        <textarea
          rows={5}
          value={meta.caption}
          onChange={(e) => onChange({ caption: e.target.value })}
          className="apple-input"
        />
      </InsetRow>
      <InsetRow className="flex items-center justify-between">
        <span className="text-[13px] text-apple-label">
          แชร์ขึ้นหน้า Profile Feed ด้วย
        </span>
        <AppleSwitch
          checked={meta.shareToFeed}
          onChange={(v) => onChange({ shareToFeed: v })}
        />
      </InsetRow>
      <InsetRow className="flex items-center justify-between">
        <span className="text-[13px] text-apple-label">
          สร้างด้วย AI (AI Info / is_ai_generated)
        </span>
        <AppleSwitch
          checked={Boolean(meta.isAiGenerated)}
          onChange={(v) => onChange({ isAiGenerated: v })}
        />
      </InsetRow>
      <InsetRow className="flex items-center justify-between">
        <span className="text-[13px] text-apple-label">Cover Offset (ms)</span>
        <input
          type="number"
          min={0}
          step={500}
          value={meta.thumbOffsetMs}
          onChange={(e) =>
            onChange({ thumbOffsetMs: Number(e.target.value) || 0 })
          }
          className="apple-input w-28 tabular-nums"
        />
      </InsetRow>
    </InsetGroup>
  );
}

function FacebookEditor({
  format,
  meta,
  onChange,
}: {
  format: 'FACEBOOK_REELS' | 'FACEBOOK_VIDEO';
  meta: FacebookReelsMetadata | FacebookVideoMetadata;
  onChange: (patch: Partial<FacebookVideoMetadata>) => void;
}) {
  const maxDesc = format === 'FACEBOOK_REELS' ? 2200 : 63206;
  return (
    <InsetGroup title={FORMAT_LABELS[format]}>
      <InsetRow className="space-y-2">
        <LimitBar
          label="หัวข้อคลิป"
          current={meta.title.length}
          max={255}
          recommendedMax={format === 'FACEBOOK_REELS' ? 50 : 80}
          unit="ตัวอักษร"
        />
        <input
          value={meta.title}
          onChange={(e) => onChange({ title: e.target.value })}
          className="apple-input"
        />
      </InsetRow>
      <InsetRow className="space-y-2">
        <LimitBar
          label="คำอธิบาย"
          current={meta.description.length}
          max={maxDesc}
          recommendedMax={format === 'FACEBOOK_REELS' ? 180 : undefined}
          unit="ตัวอักษร"
        />
        <textarea
          rows={5}
          value={meta.description}
          onChange={(e) => onChange({ description: e.target.value })}
          className="apple-input"
        />
      </InsetRow>
      <InsetRow className="flex items-center justify-between">
        <span className="text-[13px] text-apple-label">
          สร้างด้วย AI (AI Info / is_ai_generated)
        </span>
        <AppleSwitch
          checked={Boolean(meta.isAiGenerated)}
          onChange={(v) => onChange({ isAiGenerated: v })}
        />
      </InsetRow>
    </InsetGroup>
  );
}
