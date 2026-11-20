import type { ClipCategory, ContentFormat, Platform, PublishStrategy, ResolvedSlot, ScheduleRule, SocialAccount } from './types.js';
/**
 * Parses YYYY-MM-DD + HH:mm in a specific IANA timezone (e.g. Asia/Bangkok) into UTC ISO-8601 string.
 * Accurate across DST and fixed-offset zones using Intl.DateTimeFormat parts.
 */
export declare function zonedDateTimeToUtcIso(dateStr: string, localTime: string, timezone?: string): string;
export declare function getDayOfWeekFromDateStr(dateStr: string): number;
export declare function addDaysToDateStr(dateStr: string, days: number): string;
/**
 * Formats a Date into { dateStr: "YYYY-MM-DD", localTime: "HH:mm" } in the given IANA timezone.
 */
export declare function getLocalDateTimeParts(date: Date, timezone?: string): {
    dateStr: string;
    localTime: string;
};
export declare function determinePublishStrategy(format: ContentFormat, scheduledAtIso: string, account: Pick<SocialAccount, 'config' | 'connectionMode'>, now?: Date): PublishStrategy;
export declare function defaultFormatForPlatform(platform: Platform, clipCategory: ClipCategory): ContentFormat;
export declare function resolveScheduledTimesForDate(params: {
    dateStr: string;
    timezone: string;
    rules: ScheduleRule[];
    accounts: SocialAccount[];
    clipCategory: ClipCategory;
    now?: Date;
    /** When true (default), slots whose target time has already passed `now` automatically advance to the next future slot so they never accidentally publish immediately. */
    autoAdvancePastSlots?: boolean;
    minLeadMinutes?: number;
}): ResolvedSlot[];
export declare function computePrewarmIso(scheduledAtIso: string, minutesBefore?: number): string;
/**
 * Thailand (Asia/Bangkok, ICT UTC+7) prime-time posting windows per platform & day of week (0=Sun..6=Sat),
 * synthesized from Thai digital audience habits (commute, lunch break, after-work, weekend leisure).
 * Each platform gets its primary ('ANY', optimized for Shorts/Reels/short video) slot plus a dedicated
 * 'LONG' watch-time slot on YouTube Long and Facebook Video.
 */
export declare const THAILAND_OPTIMAL_SCHEDULE: Record<Platform, Record<number, {
    primary: string;
    long?: string;
}>>;
export declare function buildThailandScheduleRulesForAccounts(accounts: Array<Pick<SocialAccount, 'id' | 'platform'>>): Array<{
    socialAccountId: string;
    dayOfWeek: number;
    clipType: 'ANY' | 'SHORT' | 'LONG';
    slotOrder: number;
    localTime: string;
    isActive: boolean;
}>;
//# sourceMappingURL=schedule-utils.d.ts.map