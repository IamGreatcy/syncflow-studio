import {
  buildThailandScheduleRulesForAccounts,
  type ContentFormat,
} from '@clipflow/shared';
import type { ClipFlowDb } from './database.js';

export function seedDefaultChannelData(db: ClipFlowDb, channelId: string): void {
  const existingAccounts = db.listAccounts(channelId);
  if (existingAccounts.length > 0) return;

  const yt = db.createAccount({
    channelId,
    platform: 'YOUTUBE',
    accountName: 'YouTube Channel (Simulation)',
    externalAccountId: 'UC_DEMO_CHANNEL',
    connectionMode: 'SIMULATION',
    config: { defaultCategoryId: '22', defaultPrivacy: 'public' },
  });

  const tt = db.createAccount({
    channelId,
    platform: 'TIKTOK',
    accountName: 'TikTok Account (Simulation)',
    externalAccountId: '@demo_tiktok',
    connectionMode: 'SIMULATION',
    config: { tiktokMode: 'DIRECT_POST' },
    creatorInfo: {
      creatorUsername: 'demo_tiktok',
      creatorNickname: 'Demo Creator',
      privacyLevelOptions: [
        'PUBLIC_TO_EVERYONE',
        'MUTUAL_FOLLOW_FRIENDS',
        'SELF_ONLY',
      ],
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
      maxVideoPostDurationSec: 600,
      fetchedAt: new Date().toISOString(),
    },
  });

  const ig = db.createAccount({
    channelId,
    platform: 'INSTAGRAM',
    accountName: 'Instagram Business (Simulation)',
    externalAccountId: 'ig_demo_12345',
    connectionMode: 'SIMULATION',
  });

  const fb = db.createAccount({
    channelId,
    platform: 'FACEBOOK',
    accountName: 'Facebook Page (Simulation)',
    externalAccountId: 'fb_page_demo_12345',
    connectionMode: 'SIMULATION',
  });

  // Per-platform, per-day-of-week & clip-type Thailand optimal prime-time schedule
  const rules = buildThailandScheduleRulesForAccounts([yt, fb, tt, ig]);
  db.replaceScheduleRules(channelId, rules);

  const templateDefaults: Array<{
    format: ContentFormat;
    name: string;
    titlePrefix: string;
    titleSuffix: string;
    descriptionHeader: string;
    descriptionFooter: string;
    defaultHashtags: string[];
    defaultTags: string[];
    defaultCta: string;
  }> = [
    {
      format: 'YOUTUBE_SHORTS',
      name: 'ค่าเริ่มต้น YouTube Shorts',
      titlePrefix: '',
      titleSuffix: '',
      descriptionHeader: '',
      descriptionFooter: '',
      defaultHashtags: ['#Shorts'],
      defaultTags: ['ความรู้รอบตัว', 'สาระน่ารู้'],
      defaultCta: '',
    },
    {
      format: 'YOUTUBE_LONG',
      name: 'ค่าเริ่มต้น YouTube คลิปยาว',
      titlePrefix: '',
      titleSuffix: '',
      descriptionHeader: '',
      descriptionFooter: '───────────────\nขอบคุณที่รับชมครับ มีคำถามคอมเมนต์ไว้ได้เลย',
      defaultHashtags: ['#ความรู้รอบตัว', '#สาระดีๆ'],
      defaultTags: ['สาระความรู้', 'อธิบายเข้าใจง่าย'],
      defaultCta: '',
    },
    {
      format: 'TIKTOK',
      name: 'ค่าเริ่มต้น TikTok',
      titlePrefix: '',
      titleSuffix: '',
      descriptionHeader: '',
      descriptionFooter: '',
      defaultHashtags: ['#สาระน่ารู้', '#ความรู้รอบตัว'],
      defaultTags: [],
      defaultCta: '',
    },
    {
      format: 'INSTAGRAM_REELS',
      name: 'ค่าเริ่มต้น Instagram Reels',
      titlePrefix: '',
      titleSuffix: '',
      descriptionHeader: '',
      descriptionFooter: '',
      defaultHashtags: ['#สาระน่ารู้', '#แชร์ความรู้'],
      defaultTags: [],
      defaultCta: '',
    },
    {
      format: 'FACEBOOK_REELS',
      name: 'ค่าเริ่มต้น Facebook Reels',
      titlePrefix: '',
      titleSuffix: '',
      descriptionHeader: '',
      descriptionFooter: '',
      defaultHashtags: ['#สาระน่ารู้', '#เล่าเรื่องน่ารู้'],
      defaultTags: [],
      defaultCta: '',
    },
    {
      format: 'FACEBOOK_VIDEO',
      name: 'ค่าเริ่มต้น Facebook วิดีโอเพจ',
      titlePrefix: '',
      titleSuffix: '',
      descriptionHeader: '',
      descriptionFooter: 'กดติดตามเพจไว้เพื่อไม่พลาดเรื่องราวน่ารู้ตอนใหม่ครับ',
      defaultHashtags: ['#สาระดีๆ', '#เรื่องน่ารู้'],
      defaultTags: [],
      defaultCta: '',
    },
  ];

  for (const t of templateDefaults) {
    db.upsertTemplate({
      channelId,
      ...t,
    });
  }
}

export function ensureInitialSeed(db: ClipFlowDb): void {
  const channels = db.listChannels();
  if (channels.length > 0) return;

  const mainChannel = db.createChannel({
    name: 'ช่องหลัก (Main Studio)',
    slug: 'main-studio',
    color: '#6366f1',
    timezone: 'Asia/Bangkok',
    description: 'ช่องหลักสำหรับคลิปสั้นแนวตั้งและคลิปยาวไม่เกิน 15 นาที',
    defaultTone: 'FRIENDLY',
  });

  seedDefaultChannelData(db, mainChannel.id);
}
