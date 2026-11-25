import {
  endpoint, FACEBOOK_REELS_GRAPH_VERSION, inspect, request, safeReelUrl,
} from '../adapters/facebook-reel.js';

type DiagnosticState = 'unsupported' | 'unavailable' | 'unknown' | 'failed';
type Diagnostic<T> = { state: 'available'; value: T } | { state: DiagnosticState; reason: string; error?: object };
type Json = Record<string, unknown>;

const available = <T>(value: T): Diagnostic<T> => ({ state: 'available', value });
const missing = (state: DiagnosticState, reason: string, error?: object) => ({ state, reason, ...(error ? { error } : {}) });
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const numericId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,32}$/.test(value);
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export async function diagnoseFacebookReel(input: {
  pageId: string;
  videoId: string;
  token: string | null;
}) {
  const now = new Date();
  const version = FACEBOOK_REELS_GRAPH_VERSION;
  const versions = new Set<string>();
  const { pageId, videoId, token } = input;
  const sourceAvailable = numericId(pageId) && numericId(videoId) && Boolean(token);
  const identityUnavailable = missing('unavailable', 'Missing a verified Page credential or Video ID.');
  async function read<T>(node: string, decode: (json: Json) => Diagnostic<T>, fields?: string, query: Json = {}): Promise<Diagnostic<T>> {
    if (!sourceAvailable || !token) return identityUnavailable;
    const url = endpoint(version, node, fields);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const reply = await request(url, 'DIAGNOSTIC', token, now, { method: 'GET' }, 6500);
    if (reply.version) versions.add(reply.version);
    if (!reply.error) return decode(reply.body);
    const { stage, code, subcode, fbtraceId, httpStatus } = reply.error;
    const evidence = { stage, code, subcode, fbtraceId, httpStatus };
    if ([10, 190, 200, 283].includes(code ?? 0) || [401, 403].includes(httpStatus ?? 0)) {
      return missing('unavailable', 'Meta denied access to this data.', evidence);
    }
    if (code === 100) {
      return missing('unavailable', 'Meta rejected this field or object for this request.', evidence);
    }
    return missing('failed', 'Meta request failed or timed out.', evidence);
  }

  function metric(node: string, name: string, breakdown?: 'is_from_ads' | 'is_from_followers') {
    return read<{ total: number } | { excluded: number; included: number }>(node, (body) => {
      const lifetime = list(body.data).map(object).find((row) => row.name === name && row.period === 'lifetime');
      const values = list(lifetime?.values).map(object);
      if (!breakdown) {
        const value = count(values[0]?.value);
        return value === undefined ? missing('unknown', 'Meta supplied no lifetime count.') : available({ total: value });
      }
      const excluded = count(values.find((row) => String(row[breakdown]) === '0')?.value);
      const included = count(values.find((row) => String(row[breakdown]) === '1')?.value);
      return excluded === undefined || included === undefined
        ? missing('unknown', 'Meta supplied no complete lifetime breakdown.')
        : available({ excluded, included });
    }, undefined, { metric: name, period: 'lifetime', ...(breakdown ? { breakdown } : {}) });
  }

  const [publication, metadata, pagePromotion, plays, initialPlays, replays] = await Promise.all([
    read(videoId, (body) => {
      const parsed = inspect(body);
      if (body.id !== videoId || !Object.values(parsed.phases).some((part) => part !== undefined)) {
        return missing('unknown', 'Meta supplied no matching publication status.');
      }
      return available({
        phases: parsed.phases, publishTime: parsed.publishTime,
        outcome: parsed.contradictory ? 'unknown' : parsed.failed ? 'failed'
          : parsed.published ? 'published' : parsed.scheduled ? 'scheduled' : 'pending',
      });
    }, 'status'),
    read(videoId, (body) => {
      if (body.id !== videoId) return missing('unknown', 'Meta supplied no matching video metadata.');
      return available({ postId: numericId(body.post_id) ? body.post_id : null, permalink: safeReelUrl(body.permalink_url, videoId) ?? null });
    }, 'id,post_id,permalink_url'),
    read(pageId, (body) => body.id === pageId && typeof body.promotion_eligible === 'boolean'
      ? available({ eligible: body.promotion_eligible, reasonReturned: typeof body.promotion_ineligible_reason === 'string' })
      : missing('unknown', 'Meta did not return Page promotion eligibility.'), 'id,promotion_eligible,promotion_ineligible_reason'),
    metric(videoId + '/video_insights', 'fb_reels_total_plays'),
    metric(videoId + '/video_insights', 'blue_reels_play_count'),
    metric(videoId + '/video_insights', 'fb_reels_replay_count'),
  ]);
  const postId = metadata.state === 'available' && metadata.value.postId ? pageId + '_' + metadata.value.postId : null;
  const noPost = missing('unavailable', 'No matching Page post ID is available on the Video node.');
  const [visibility, postPromotion, mediaViewsFromAds, mediaViewsFromFollowers, uniqueMediaViewers, copyright] = await Promise.all([
    postId ? read(postId, (body) => {
      const privacy = object(body.privacy).value;
      if (body.id !== postId || typeof body.is_published !== 'boolean' ||
          typeof body.is_hidden !== 'boolean' || typeof privacy !== 'string') {
        return missing('unknown', 'Meta supplied no complete visibility fields for this post.');
      }
      return available({
        published: body.is_published, hidden: body.is_hidden, publicAudience: privacy === 'EVERYONE',
        permalink: safeReelUrl(body.permalink_url, videoId) ?? null,
      });
    }, 'id,is_published,is_hidden,privacy,permalink_url') : noPost,
    postId ? read(postId, (body) => body.id === postId && typeof body.is_eligible_for_promotion === 'boolean'
      ? available({ eligible: body.is_eligible_for_promotion })
      : missing('unknown', 'Meta did not return post promotion eligibility.'), 'id,is_eligible_for_promotion') : noPost,
    postId ? metric(postId + '/insights', 'post_media_view', 'is_from_ads') : noPost,
    postId ? metric(postId + '/insights', 'post_media_view', 'is_from_followers') : noPost,
    postId ? metric(postId + '/insights', 'post_total_media_view_unique') : noPost,
    read(videoId, (body) => {
      const check = object(object(body.copyright_check_information).status);
      if (body.id !== videoId || !['complete', 'completed', 'in_progress', 'not_started', 'error'].includes(String(check.status))) {
        return missing('unknown', 'Meta supplied no matching copyright check.');
      }
      if (check.status === 'error') return missing('failed', 'Meta reported a copyright check error.');
      return available({ checkStatus: String(check.status), matchesFound: typeof check.matches_found === 'boolean' ? check.matches_found : null });
    }, 'id,copyright_check_information'),
  ]);
  return {
    observedAt: now.toISOString(), pageId, videoId, postId, requestedGraphVersion: version, effectiveGraphVersions: [...versions].sort(),
    publication, metadata, visibility, pagePromotion, postPromotion, copyright,
    promotionReason: missing('unsupported', 'The documented Post API exposes eligibility without a Facebook Boost reason.'),
    recommendationEligibility: missing('unsupported', 'Check the Page and Reel in Facebook Account Status and Business Suite.'),
    metrics: {
      plays, initialPlays, replays, mediaViewsFromAds, mediaViewsFromFollowers, uniqueMediaViewers,
      organicUniqueReach: missing('unsupported', 'The older unique organic impressions metric is deprecated. Use the dashboard when available.'),
    },
  };
}

