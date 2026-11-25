# Facebook Reel incident on 25 November 2026

The Reel was published publicly. SyncFlow recorded publication about 11 seconds too early because its native-schedule branch returned the saved Video ID when the scheduled time arrived. The scheduler interpreted that return as confirmation and did not read Meta's status. Meta separately reported that the post was ineligible for promotion. The reason for that eligibility decision and the cause of the low organic reach are undetermined.

## Evidence

The local SyncFlow SQLite database associates Facebook job `job_20b1bd97` with content `cnt_e29847ed` and Reel `1470345195026026`. The same content item contains the Instagram and YouTube jobs. The authenticated Railway API did not return this content item, job, or its logs. The timeline below comes from the local job and publication logs.

| UTC | Record |
| --- | --- |
| Nov 24 15:53:06.881 | Local Facebook job created with `NATIVE_PREUPLOAD`. |
| Nov 24 15:53:10 | Meta's video creation time. |
| Nov 24 15:53:48.587 | Local `FB_THUMBNAIL_SET` for Video ID `1470345195026026`. |
| Nov 25 05:00:00 | Scheduled publication time. |
| Nov 25 05:00:02.377 | Local `FB_NATIVE_VERIFY` logged the existing Video ID. |
| Nov 25 05:00:02.380 | Local `PUBLISHED` event. |
| Nov 25 05:00:13 | Meta's publication time, independently matched by the Page post creation time. |

The old adapter called `POST /{page_id}/video_reels` with `upload_phase=start`, sent the binary to the returned `rupload.facebook.com` URL with OAuth, offset and file-size headers, and called `POST /{page_id}/video_reels` again with `upload_phase=finish`, the Video ID and `video_state=PUBLISHED` for immediate publication. Native scheduling used `video_state=SCHEDULED` and `scheduled_publish_time`. This job's schedule, creation time and native-verify log match the scheduled code path. The historical start, upload and finish response bodies were unavailable. The old code checked HTTP status and did not inspect the upload or finish response body. It also built a permalink from the Video ID and stored that ID in the Post ID field. [Meta Reels Publishing API](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)

The adapter requests Graph API `v22.0`. In the live checks, Meta returned `facebook-api-version: v27.0` on the versioned status response. `GET /me` identified Tuenpidyuk, Page `1275578025632532`, and `GET /debug_token` confirmed a valid `PAGE` token for that ID with `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`. The authorization flow obtains Page credentials from `/me/accounts` or the account token setup route. The exact historical token and Page task assignment were not logged. [Meta token debugging](https://developers.facebook.com/docs/graph-api/reference/debug_token/)

### Selected Meta responses

`GET /1470345195026026?fields=status` returned HTTP 200.

```json
{
  "id": "1470345195026026",
  "status": {
    "video_status": "ready",
    "uploading_phase": { "status": "complete", "bytes_transferred": 15468326 },
    "processing_phase": { "status": "complete" },
    "publishing_phase": {
      "status": "complete",
      "publish_status": "published",
      "publish_time": "2026-11-25T05:00:13+0000"
    },
    "copyright_check_status": { "status": "complete", "matches_found": false }
  }
}
```

HTTP 200 video metadata returned Post ID `122131140435415526`, `published: true`, and the [Reel permalink](https://www.facebook.com/reel/1470345195026026/). The composite Page Post ID `1275578025632532_122131140435415526` returned HTTP 200 and the following selected fields across the visibility and promotion reads. The Page's published posts contained the same post with this exact Video ID as its attachment target. The Page feed separately returned the same promotion result. [Meta Post reference](https://developers.facebook.com/docs/graph-api/reference/post/)

```json
{
  "id": "1275578025632532_122131140435415526",
  "is_published": true,
  "is_hidden": false,
  "privacy": { "value": "EVERYONE" },
  "permalink_url": "https://www.facebook.com/reel/1470345195026026/",
  "is_eligible_for_promotion": false
}
```

A signed-out fetch returned HTTP 200 from the canonical route and only a generic Facebook shell. Public scope was verified through the Page post fields. Signed-out playback was unverified.

Meta's Reel Insights returned six total plays, three initial plays and three replays. The attempted unique reach metric returned code 100, so the two unique viewers remain the figure from Business Suite. The higher Instagram and YouTube counts describe separate distribution on those platforms. Meta's public-post and advertising eligibility fields do not expose a post-level organic recommendation decision or the reason for failing promotion eligibility. [Meta Video Insights](https://developers.facebook.com/docs/graph-api/reference/video/video_insights/) · [Meta Recommendation Guidelines](https://about.fb.com/news/2020/08/recommendation-guidelines/)

## Fix

The normal SyncCut export bridge sends the MP4, manifest and optional cover and subtitles to SyncFlow's import endpoint. Its receipt denotes an import. When the user schedules publication, SyncFlow creates a SQLite job for each destination. The scheduler now sends live Facebook Reel jobs through a dedicated verifier. It records the Video ID and upload state before continuing, persists finish intent before the only finish POST, and confirms publication with a separate GET. When Meta returns the Post ID or permalink, the verifier stores those separately. An incomplete upload resumes only at a reported offset for the same source bytes. An ambiguous finish stays attached to the same Video ID. If the worker stops between recording finish intent and sending the request, the result may require manual verification.

The database and Jobs UI distinguish uploaded, processing, publish requested, published, failed and unknown. Verification has bounded exponential backoff, per-Page throttling, a deadline, and a read-only recheck for unresolved IDs. Existing live Reel receipts are reconciled by GET. The migration preserves old event logs for audit. The automatic and manual retries guard against a second finish or upload session when the original attempt may already exist. [Meta Graph rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)

The new verifier classified the existing Reel as published in an integration check restricted to two GET requests. No publishing, boosting or test Reel creation occurred on Meta.

