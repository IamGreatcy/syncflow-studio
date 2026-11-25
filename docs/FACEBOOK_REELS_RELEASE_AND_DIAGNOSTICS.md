# Facebook Reels release and diagnostics checklist

The previous [incident follow-up and experiment](./FACEBOOK_REELS_FOLLOWUP_2026-11-25.md) is the baseline. Use its randomized manual-versus-API plan only after production verification. A promotion decision and an organic recommendation decision are separate.

## Release approval

1. Sign in to Railway and select the SyncFlow production service and environment. Record the active deployment ID, commit or image, Git branch, replica count, and current scheduler owner. Confirm a **single replica** and a persistent volume whose mount contains DATA_DIR. Confirm the active database filename and encryption key continuity using the dashboard or a trusted session. Keep credential values private. [Railway variables](https://docs.railway.com/variables/reference) · [Volumes](https://docs.railway.com/volumes)
2. Confirm that Railway is the designated live Facebook Reel publisher and that the local scheduler is stopped or on the new release with Live Facebook Reel publishing disabled. On both environments, check waiting jobs and existing native schedules before handing off. Existing Meta native schedules can publish even with both workers stopped. Do not duplicate or import those jobs as a migration strategy. The databases are separate by design. SyncCut's configured import destination determines where media/drafts appear. Verify SyncCut's active destination and use Railway as the publication queue after cutover.
3. Take a Railway volume backup and record its ID. Validate the SQLite migration on an isolated protected copy of that production snapshot with network dispatch disabled. After building the candidate, run node scripts/check-facebook-reel-migration.mjs PATH_TO_SNAPSHOT. This performs a read-only SQLite backup, checks integrity before and after migration, compares row counts and unaffected jobs, checks receipt conversion and repeats the migration to verify idempotence. It starts no scheduler and prints aggregate results. Retain the original production backup in Railway. [Railway backups](https://docs.railway.com/volumes/backups)
4. Release an explicitly reviewed commit from a clean release branch. Deploy with SYNCFLOW_FACEBOOK_REEL_OWNER=disabled for the first check. The authenticated GET /api/runtime/facebook must identify the new verifier, show the expected deployment identity, report the persistent mount configuration, and show an advancing scheduler tick with live Facebook writes disabled. Validate the read-only job diagnostic on an existing receipt if one is available. Then set the production instance to owner railway and confirm the local instance reports writes disabled. Unset owner defaults to disabled. In this installation, the local runtime cannot acquire live Facebook publishing ownership even if its owner setting is changed. Use one production Railway replica and preserve the owner setting during deployment.
5. Confirm the app dashboard for Meta App 1463250842680625 in Settings → Advanced → Upgrade API Version. Capture the all-call and developer/admin settings without credentials. New Reel requests explicitly target the observed effective v27.0. The report shows requested and effective versions. Historical reconciliation retains the version stored on its receipt. Instagram and YouTube workflows use their existing code paths. [Meta app upgrade controls](https://developers.facebook.com/docs/graph-api/advanced/api-upgrade/) · [Version schedule](https://developers.facebook.com/docs/graph-api/changelog/versions/)

### Stop and rollback

Set the Facebook owner to disabled and confirm the runtime endpoint reports writes disabled. Wait for work already in flight and reconcile outstanding Video IDs with GET before re-enabling publishing. Keep the migrated database and its receipts. Prefer a rollback build that understands the migrated receipts and retains disabled ownership. The older publisher can interpret unresolved work incorrectly and ignores the ownership setting. Only run it with dispatch independently isolated. Restore the Railway backup only if a data rollback is necessary and only after reconciling any Meta actions that happened after the backup. Never restore the local SQLite file onto Railway. [Railway deployment actions](https://docs.railway.com/deployments/deployment-actions)

## Diagnostic triage

From the Jobs inspector select the Meta report for a live Reel with a stored Video ID. The report reads Meta using the Page credential and leaves the publication job untouched. Its states mean the following.

| State | Meaning |
| --- | --- |
| available | Meta returned a usable result. False and zero are valid results. Publication has its own outcome and phase values. |
| unsupported | No supported field was identified for this question in the checked APIs. Use the dashboard where available. |
| unavailable | The receipt or credential is missing, access was denied, or Meta rejected the field for this object. |
| unknown | The read returned insufficient or conflicting evidence. |
| failed | The diagnostic request timed out or failed, or Meta explicitly reported a failure of the checked operation. |

Capture the time, video and Page post IDs, actual publication outcome, visibility, promotion flags and copyright status. Use the reported non-ad versus ad media views, follower split, initial plays, replays and unique media viewers. Collect organic unique reach from the dashboard if shown. Unique media viewers do not count everyone who saw the Reel. The Page-level and post-level promotion flags cannot establish an organic recommendation decision. [Meta video insights](https://developers.facebook.com/docs/graph-api/reference/video/video_insights/) · [Post media insights](https://developers.facebook.com/docs/graph-api/reference/insights/)

### Manual Meta checks

- **Facebook Account Status and Page Status / Recommendations** — check the exact Page and Reel for a recommendation or distribution notice.
- **Business Support Home** — select the actual portfolio, Page, operator, and ad account. Record any advertising restriction or appeal reference.
- **Ads Manager** — confirm the selected account's status, billing restriction notices, and operator's permissions without opening an ad creation flow.
- **Business Suite → Content → Published → exact Reel** — save the Boost tooltip and any visibility, rights, review, or content-specific notice. In Insights, capture organic reach and measurement period if available. If Boost wording conflicts with a confirmed public post, ask Meta Support for its eligibility reason and provide the composite Page Post ID, timestamp and permalink.

