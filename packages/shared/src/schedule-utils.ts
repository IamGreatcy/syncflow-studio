import type {
  ClipCategory,
  ContentFormat,
  Platform,
  PublishStrategy,
  ResolvedSlot,
  ScheduleRule,
  SocialAccount,
} from './types.js';

const DEFAULT_TIME_BY_PLATFORM: Record<Platform, string> = {
  YOUTUBE: '18:00',
  FACEBOOK: '18:30',
  TIKTOK: '19:30',
  INSTAGRAM: '20:00',
};

/**
 * Parses YYYY-MM-DD + HH:mm in a specific IANA timezone (e.g. Asia/Bangkok) into UTC ISO-8601 string.
 * Accurate across DST and fixed-offset zones using Intl.DateTimeFormat parts.
 */
export function zonedDateTimeToUtcIso(
  dateStr: string,
  localTime: string,
  timezone = 'Asia/Bangkok'
): string {
  const [yStr, mStr, dStr] = dateStr.split('-');
  const [hStr, minStr] = localTime.split(':');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(minStr);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    throw new Error(`Invalid date/time: ${dateStr} ${localTime}`);
  }

  // Initial UTC guess treating wall clock as UTC
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const getOffsetMs = (ts: number): number => {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(new Date(ts));
    const lookup: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') {
        lookup[p.type] = Number(p.value);
      }
    }
    const asUtc = Date.UTC(
      lookup.year,
      lookup.month - 1,
      lookup.day,
      lookup.hour,
      lookup.minute,
      lookup.second,
      0
    );
    return asUtc - ts;
  };

  // Two-pass offset adjustment handles DST boundaries cleanly
  const offset1 = getOffsetMs(utcGuess);
  const adjusted1 = utcGuess - offset1;
  const offset2 = getOffsetMs(adjusted1);
  const finalUtc = utcGuess - offset2;
  return new Date(finalUtc).toISOString();
}

export function getDayOfWeekFromDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Day of calendar date is invariant when evaluated at noon UTC
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

/**
 * Returns today's or next day's YYYY-MM-DD in the channel's local IANA timezone (avoids UTC off-by-1).
 */
export function getLocalTodayDateStr(
  timezone = 'Asia/Bangkok',
  now: Date = new Date()
): string {
  return getLocalDateTimeParts(now, timezone).dateStr;
}

export function getNextDayDateStr(
  timezone = 'Asia/Bangkok',
  now: Date = new Date()
): string {
  return addDaysToDateStr(getLocalTodayDateStr(timezone, now), 1);
}

/**
 * Formats a Date into { dateStr: "YYYY-MM-DD", localTime: "HH:mm" } in the given IANA timezone.
 */
export function getLocalDateTimeParts(
  date: Date,
  timezone = 'Asia/Bangkok'
): { dateStr: string; localTime: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const lookup: Record<string, string> = {};
  for (const p of formatter.formatToParts(date)) {
    if (p.type !== 'literal') {
      lookup[p.type] = p.value;
    }
  }
  return {
    dateStr: `${lookup.year}-${lookup.month}-${lookup.day}`,
    localTime: `${lookup.hour}:${lookup.minute}`,
  };
}

export function determinePublishStrategy(
  format: ContentFormat,
  scheduledAtIso: string,
  account: Pick<SocialAccount, 'config' | 'connectionMode'>,
  now: Date = new Date()
): PublishStrategy {
  const targetMs = new Date(scheduledAtIso).getTime();
  const diffMin = (targetMs - now.getTime()) / 60_000;
  const diffDays = diffMin / (60 * 24);

  if (format === 'YOUTUBE_SHORTS' || format === 'YOUTUBE_LONG') {
    // YouTube supports native publishAt for future uploads (>= 5 mins ahead)
    return diffMin >= 5 ? 'NATIVE_PREUPLOAD' : 'JIT_PUBLISH';
  }

  if (format === 'FACEBOOK_VIDEO') {
    // Facebook /videos supports native scheduled_publish_time between 10 mins and 6 months
    return diffMin >= 10 && diffDays <= 180 ? 'NATIVE_PREUPLOAD' : 'JIT_PUBLISH';
  }

  if (format === 'FACEBOOK_REELS') {
    // Facebook /video_reels supports native scheduled_publish_time between 10 mins and 29 days
    return diffMin >= 10 && diffDays <= 29 ? 'NATIVE_PREUPLOAD' : 'JIT_PUBLISH';
  }

  if (format === 'INSTAGRAM_REELS') {
    // IG media containers strictly expire after 24h -> must use JIT pre-warm (T-12m) + publish at T
    return 'JIT_PUBLISH';
  }

  if (format === 'TIKTOK') {
    if (account.config?.tiktokMode === 'INBOX_DRAFT') {
      return 'INBOX_DRAFT';
    }
    return 'JIT_PUBLISH';
  }

  return 'JIT_PUBLISH';
}

export function defaultFormatForPlatform(
  platform: Platform,
  clipCategory: ClipCategory
): ContentFormat {
  switch (platform) {
    case 'YOUTUBE':
      return clipCategory === 'SHORT' ? 'YOUTUBE_SHORTS' : 'YOUTUBE_LONG';
    case 'TIKTOK':
      return 'TIKTOK';
    case 'INSTAGRAM':
      return 'INSTAGRAM_REELS';
    case 'FACEBOOK':
      return clipCategory === 'SHORT' ? 'FACEBOOK_REELS' : 'FACEBOOK_VIDEO';
  }
}

function getAccountRulesForDay(params: {
  accountId: string;
  dayOfWeek: number;
  clipCategory: ClipCategory;
  rules: ScheduleRule[];
}): ScheduleRule[] {
  const { accountId, dayOfWeek, clipCategory, rules } = params;
  return rules
    .filter(
      (r) =>
        r.socialAccountId === accountId &&
        r.dayOfWeek === dayOfWeek &&
        r.isActive &&
        (r.clipType === clipCategory || r.clipType === 'ANY')
    )
    .sort((a, b) => {
      if (a.clipType !== b.clipType) {
        return a.clipType === clipCategory ? -1 : 1;
      }
      return a.slotOrder - b.slotOrder;
    });
}

function resolveCandidateForDate(params: {
  dateStr: string;
  timezone: string;
  account: SocialAccount;
  clipCategory: ClipCategory;
  rules: ScheduleRule[];
  minTimestampMs: number;
}): {
  targetDate: string;
  dayOfWeek: number;
  localTime: string;
  scheduledAtIso: string;
  sourceRuleId: string | null;
  isFallbackDefault: boolean;
  isFuture: boolean;
  nominalLocalTime: string;
} {
  const { dateStr, timezone, account, clipCategory, rules, minTimestampMs } = params;
  const dayOfWeek = getDayOfWeekFromDateStr(dateStr);
  const accountRules = getAccountRulesForDay({
    accountId: account.id,
    dayOfWeek,
    clipCategory,
    rules,
  });

  if (accountRules.length === 0) {
    const localTime = DEFAULT_TIME_BY_PLATFORM[account.platform];
    const scheduledAtIso = zonedDateTimeToUtcIso(dateStr, localTime, timezone);
    return {
      targetDate: dateStr,
      dayOfWeek,
      localTime,
      scheduledAtIso,
      sourceRuleId: null,
      isFallbackDefault: true,
      isFuture: new Date(scheduledAtIso).getTime() > minTimestampMs,
      nominalLocalTime: localTime,
    };
  }

  const nominalRule = accountRules[0];
  // Prefer the earliest valid rule slot on this date that is still in the future
  for (const rule of accountRules) {
    const scheduledAtIso = zonedDateTimeToUtcIso(dateStr, rule.localTime, timezone);
    if (new Date(scheduledAtIso).getTime() > minTimestampMs) {
      return {
        targetDate: dateStr,
        dayOfWeek,
        localTime: rule.localTime,
        scheduledAtIso,
        sourceRuleId: rule.id,
        isFallbackDefault: false,
        isFuture: true,
        nominalLocalTime: nominalRule.localTime,
      };
    }
  }

  const fallbackScheduled = zonedDateTimeToUtcIso(
    dateStr,
    nominalRule.localTime,
    timezone
  );
  return {
    targetDate: dateStr,
    dayOfWeek,
    localTime: nominalRule.localTime,
    scheduledAtIso: fallbackScheduled,
    sourceRuleId: nominalRule.id,
    isFallbackDefault: false,
    isFuture: false,
    nominalLocalTime: nominalRule.localTime,
  };
}

export function resolveScheduledTimesForDate(params: {
  dateStr: string;
  timezone: string;
  rules: ScheduleRule[];
  accounts: SocialAccount[];
  clipCategory: ClipCategory;
  now?: Date;
  /** When true (default), slots whose target time has already passed `now` automatically advance to the next future slot so they never accidentally publish immediately. */
  autoAdvancePastSlots?: boolean;
  minLeadMinutes?: number;
}): ResolvedSlot[] {
  const {
    dateStr,
    timezone,
    rules,
    accounts,
    clipCategory,
    now = new Date(),
    autoAdvancePastSlots = true,
    minLeadMinutes = 0,
  } = params;
  const minTimestampMs = now.getTime() + minLeadMinutes * 60_000;
  const todayDateStr = getLocalDateTimeParts(now, timezone).dateStr;

  const slots: ResolvedSlot[] = [];

  for (const account of accounts) {
    if (account.status === 'DISCONNECTED') continue;
    const format = defaultFormatForPlatform(account.platform, clipCategory);

    const initial = resolveCandidateForDate({
      dateStr,
      timezone,
      account,
      clipCategory,
      rules,
      minTimestampMs,
    });

    let chosen = initial;
    const wasPastSlot = !initial.isFuture;

    if (!initial.isFuture && autoAdvancePastSlots) {
      let foundFuture: typeof initial | null = null;
      for (let offset = 1; offset <= 7; offset++) {
        const candidateDate = addDaysToDateStr(dateStr, offset);
        const candidate = resolveCandidateForDate({
          dateStr: candidateDate,
          timezone,
          account,
          clipCategory,
          rules,
          minTimestampMs,
        });
        if (candidate.isFuture) {
          foundFuture = candidate;
          break;
        }
      }
      // Fallback if requested date was >7 days in the past: search forward from today
      if (!foundFuture) {
        for (let offset = 0; offset <= 7; offset++) {
          const candidateDate = addDaysToDateStr(todayDateStr, offset);
          const candidate = resolveCandidateForDate({
            dateStr: candidateDate,
            timezone,
            account,
            clipCategory,
            rules,
            minTimestampMs,
          });
          if (candidate.isFuture) {
            foundFuture = candidate;
            break;
          }
        }
      }
      if (foundFuture) {
        chosen = foundFuture;
      }
    }

    const strategy = determinePublishStrategy(
      format,
      chosen.scheduledAtIso,
      account,
      now
    );

    slots.push({
      socialAccountId: account.id,
      accountName: account.accountName,
      platform: account.platform,
      format,
      dayOfWeek: chosen.dayOfWeek,
      localTime: chosen.localTime,
      timezone,
      scheduledAtIso: chosen.scheduledAtIso,
      strategy,
      sourceRuleId: chosen.sourceRuleId,
      isFallbackDefault: chosen.isFallbackDefault,
      targetDate: chosen.targetDate,
      wasPastSlot,
      nominalLocalTime: wasPastSlot ? initial.nominalLocalTime : undefined,
    });
  }

  return slots;
}

export function computePrewarmIso(scheduledAtIso: string, minutesBefore = 12): string {
  const target = new Date(scheduledAtIso).getTime();
  return new Date(target - minutesBefore * 60_000).toISOString();
}

/**
 * Thailand (Asia/Bangkok, ICT UTC+7) prime-time posting windows per platform & day of week (0=Sun..6=Sat),
 * synthesized from Thai digital audience habits (commute, lunch break, after-work, weekend leisure).
 * Each platform gets its primary ('ANY', optimized for Shorts/Reels/short video) slot plus a dedicated
 * 'LONG' watch-time slot on YouTube Long and Facebook Video.
 */
export const THAILAND_OPTIMAL_SCHEDULE: Record<
  Platform,
  Record<number, { primary: string; long?: string }>
> = {
  YOUTUBE: {
    0: { primary: '12:00', long: '09:30' }, // อาทิตย์: Shorts เที่ยง-บ่าย, คลิปยาว 09:30 นาทีทองเช้าวันหยุด
    1: { primary: '18:00', long: '19:30' }, // จันทร์: เลิกงาน-เรียน, ค่ำดูคลิปยาว
    2: { primary: '17:45', long: '19:30' }, // อังคาร
    3: { primary: '17:30', long: '19:00' }, // พุธ
    4: { primary: '17:30', long: '19:00' }, // พฤหัส
    5: { primary: '16:30', long: '18:30' }, // ศุกร์: เลิกเรียน/เลิกงานเร็ว
    6: { primary: '13:00', long: '10:00' }, // เสาร์: สาย-บ่ายวันเสาร์
  },
  FACEBOOK: {
    0: { primary: '19:00', long: '10:30' }, // อาทิตย์: ค่ำอยู่บ้านก่อนวันจันทร์, คลิปยาวสายวันอาทิตย์
    1: { primary: '12:00', long: '20:00' }, // จันทร์: พักเที่ยง + ค่ำ
    2: { primary: '11:30', long: '20:00' }, // อังคาร: พีคก่อนเที่ยง-เที่ยง
    3: { primary: '12:00', long: '20:00' }, // พุธ: กลางสัปดาห์พีคเที่ยง + ค่ำ
    4: { primary: '18:30', long: '20:00' }, // พฤหัส: หลังเลิกงาน + ค่ำ
    5: { primary: '11:30', long: '19:30' }, // ศุกร์: พักเที่ยงก่อนเดินทาง/สังสรรค์เย็น
    6: { primary: '10:30', long: '11:30' }, // เสาร์: ตื่นสายไถฟีดช่วงสาย
  },
  TIKTOK: {
    0: { primary: '19:30' }, // อาทิตย์: ค่ำพักผ่อนอยู่บ้านยาว
    1: { primary: '19:30' }, // จันทร์: พีคค่ำหลังเลิกงานวันแรก
    2: { primary: '19:00' }, // อังคาร: พีคหัวค่ำ-ดึก
    3: { primary: '18:45' }, // พุธ: ขึ้นฟีด FYP เสถียรช่วงหัวค่ำ
    4: { primary: '19:15' }, // พฤหัส: วันพีค Engagement สูงของไทย
    5: { primary: '17:30' }, // ศุกร์: เลิกงานเร็ว เคลื่อนที่ก่อนออกข้างนอก
    6: { primary: '11:30' }, // เสาร์: ตื่นสายไถฟีดช่วงสาย-เที่ยง
  },
  INSTAGRAM: {
    0: { primary: '11:00' }, // อาทิตย์: เช็ก Reels/Stories ช่วงสายสบายๆ
    1: { primary: '20:00' }, // จันทร์: หลังเลิกงาน-ก่อนนอน
    2: { primary: '12:30' }, // อังคาร: ช่วงกลางวัน 10:00-14:00 พีคสุดของ IG ไทย
    3: { primary: '12:30' }, // พุธ: ช่วงเที่ยงวันพุธพีคสุดของ IG ไทย
    4: { primary: '20:15' }, // พฤหัส: ผ่อนคลายช่วงค่ำ
    5: { primary: '18:30' }, // ศุกร์: คอนเทนต์ไลฟ์สไตล์เย็นวันศุกร์
    6: { primary: '18:00' }, // เสาร์: เย็นวันเสาร์ไลฟ์สไตล์/บันเทิง
  },
};

export function buildThailandScheduleRulesForAccounts(
  accounts: Array<Pick<SocialAccount, 'id' | 'platform'>>
): Array<{
  socialAccountId: string;
  dayOfWeek: number;
  clipType: 'ANY' | 'SHORT' | 'LONG';
  slotOrder: number;
  localTime: string;
  isActive: boolean;
}> {
  const rules: Array<{
    socialAccountId: string;
    dayOfWeek: number;
    clipType: 'ANY' | 'SHORT' | 'LONG';
    slotOrder: number;
    localTime: string;
    isActive: boolean;
  }> = [];

  for (const acc of accounts) {
    const byDay = THAILAND_OPTIMAL_SCHEDULE[acc.platform];
    for (let day = 0; day <= 6; day++) {
      const spec = byDay[day];
      if (!spec) continue;
      rules.push({
        socialAccountId: acc.id,
        dayOfWeek: day,
        clipType: 'ANY',
        slotOrder: 1,
        localTime: spec.primary,
        isActive: true,
      });
      if (spec.long) {
        rules.push({
          socialAccountId: acc.id,
          dayOfWeek: day,
          clipType: 'LONG',
          slotOrder: 2,
          localTime: spec.long,
          isActive: true,
        });
      }
    }
  }
  return rules;
}
