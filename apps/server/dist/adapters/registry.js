import { YouTubeAdapter } from './youtube.js';
import { FacebookAdapter } from './facebook.js';
import { InstagramAdapter } from './instagram.js';
import { TikTokAdapter } from './tiktok.js';
export const youtubeAdapter = new YouTubeAdapter();
export const facebookAdapter = new FacebookAdapter();
export const instagramAdapter = new InstagramAdapter();
export const tiktokAdapter = new TikTokAdapter();
export function getAdapter(platform) {
    switch (platform) {
        case 'YOUTUBE':
            return youtubeAdapter;
        case 'FACEBOOK':
            return facebookAdapter;
        case 'INSTAGRAM':
            return instagramAdapter;
        case 'TIKTOK':
            return tiktokAdapter;
    }
}
//# sourceMappingURL=registry.js.map