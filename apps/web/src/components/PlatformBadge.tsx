import type {
  ContentFormat,
  JobStatus,
  Platform,
  PublishStrategy,
} from '@clipflow/shared';

const PLATFORM_META: Record<
  Platform,
  { short: string; label: string; colorVar: string; softBg: string }
> = {
  YOUTUBE: {
    short: 'YT',
    label: 'YouTube',
    colorVar: 'var(--apple-red)',
    softBg: 'rgba(255, 59, 48, 0.12)',
  },
  TIKTOK: {
    short: 'TT',
    label: 'TikTok',
    colorVar: 'var(--apple-teal)',
    softBg: 'rgba(0, 163, 181, 0.13)',
  },
  INSTAGRAM: {
    short: 'IG',
    label: 'Instagram',
    colorVar: 'var(--apple-pink)',
    softBg: 'rgba(255, 45, 85, 0.12)',
  },
  FACEBOOK: {
    short: 'FB',
    label: 'Facebook',
    colorVar: 'var(--apple-blue)',
    softBg: 'rgba(0, 122, 255, 0.12)',
  },
};

export const FORMAT_LABELS: Record<ContentFormat, string> = {
  YOUTUBE_SHORTS: 'YouTube Shorts',
  YOUTUBE_LONG: 'YouTube คลิปยาว',
  TIKTOK: 'TikTok',
  INSTAGRAM_REELS: 'IG Reels',
  FACEBOOK_REELS: 'FB Reels',
  FACEBOOK_VIDEO: 'FB วิดีโอเพจ',
};

export function PlatformDot({ platform }: { platform: Platform }) {
  return (
    <span
      className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ backgroundColor: PLATFORM_META[platform].colorVar }}
    />
  );
}

export function PlatformPill({
  platform,
  compact = false,
}: {
  platform: Platform;
  compact?: boolean;
}) {
  const s = PLATFORM_META[platform];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{
        backgroundColor: s.softBg,
        color: s.colorVar,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: s.colorVar }}
      />
      {compact ? s.short : s.label}
    </span>
  );
}

export function StrategyBadge({
  strategy,
  isPastDue = false,
}: {
  strategy: PublishStrategy;
  isPastDue?: boolean;
}) {
  if (isPastDue) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{
          backgroundColor: 'rgba(255, 59, 48, 0.14)',
          color: 'var(--apple-red)',
        }}
      >
        เลยเวลาแล้ว (จะโพสต์ทันที)
      </span>
    );
  }
  if (strategy === 'NATIVE_PREUPLOAD') {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{
          backgroundColor: 'rgba(52, 199, 89, 0.14)',
          color: 'var(--apple-green)',
        }}
      >
        Pre-upload ล่วงหน้า
      </span>
    );
  }
  if (strategy === 'INBOX_DRAFT') {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{
          backgroundColor: 'rgba(255, 149, 0, 0.14)',
          color: 'var(--apple-orange)',
        }}
      >
        Inbox Draft ล่วงหน้า
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        backgroundColor: 'rgba(88, 86, 214, 0.13)',
        color: 'var(--apple-indigo)',
      }}
    >
      JIT โพสต์ตรงเวลา
    </span>
  );
}

const STATUS_META: Record<
  JobStatus,
  { label: string; color: string; bg: string }
> = {
  DRAFT: {
    label: 'ร่าง',
    color: 'var(--label-secondary)',
    bg: 'var(--bg-grouped)',
  },
  QUEUED: {
    label: 'รอคิว',
    color: 'var(--label-secondary)',
    bg: 'var(--bg-grouped)',
  },
  PREUPLOADING: {
    label: 'กำลังอัปโหลดล่วงหน้า',
    color: 'var(--apple-blue)',
    bg: 'rgba(0, 122, 255, 0.12)',
  },
  NATIVE_SCHEDULED: {
    label: 'อัปโหลดรอเวลาบนแพลตฟอร์มแล้ว',
    color: 'var(--apple-green)',
    bg: 'rgba(52, 199, 89, 0.14)',
  },
  PREWARMING: {
    label: 'กำลังเตรียม Container',
    color: 'var(--apple-indigo)',
    bg: 'rgba(88, 86, 214, 0.13)',
  },
  READY_TO_PUBLISH: {
    label: 'พร้อมโพสต์',
    color: 'var(--apple-indigo)',
    bg: 'rgba(88, 86, 214, 0.14)',
  },
  PUBLISHING: {
    label: 'กำลังเผยแพร่',
    color: 'var(--apple-orange)',
    bg: 'rgba(255, 149, 0, 0.14)',
  },
  PUBLISHED: {
    label: 'เผยแพร่สำเร็จ',
    color: 'var(--apple-green)',
    bg: 'rgba(52, 199, 89, 0.16)',
  },
  FAILED: {
    label: 'ล้มเหลว',
    color: 'var(--apple-red)',
    bg: 'rgba(255, 59, 48, 0.13)',
  },
  CANCELLED: {
    label: 'ยกเลิกแล้ว',
    color: 'var(--label-tertiary)',
    bg: 'var(--bg-grouped)',
  },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS_META[status] ?? STATUS_META.QUEUED;
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{
        backgroundColor: s.bg,
        color: s.color,
      }}
    >
      {s.label}
    </span>
  );
}

export function formatLocalTimeFromIso(
  iso: string,
  timezone = 'Asia/Bangkok'
): string {
  try {
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

export function formatLocalDateTimeFromIso(
  iso: string,
  timezone = 'Asia/Bangkok'
): string {
  try {
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
