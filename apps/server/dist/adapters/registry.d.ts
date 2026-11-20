import type { Platform } from '@clipflow/shared';
import type { PlatformAdapter } from './types.js';
import { YouTubeAdapter } from './youtube.js';
import { FacebookAdapter } from './facebook.js';
import { InstagramAdapter } from './instagram.js';
import { TikTokAdapter } from './tiktok.js';
export declare const youtubeAdapter: YouTubeAdapter;
export declare const facebookAdapter: FacebookAdapter;
export declare const instagramAdapter: InstagramAdapter;
export declare const tiktokAdapter: TikTokAdapter;
export declare function getAdapter(platform: Platform): PlatformAdapter;
//# sourceMappingURL=registry.d.ts.map