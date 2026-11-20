# SyncFlow Studio — Cloud Quickstart

The app runs 24/7 on Railway, so scheduled clips post even when your PC is off.

## Everyday use
1. Open the cloud URL (double-click `launchers/open-cloud.bat`) and sign in once. The browser remembers you for 30 days.
2. Upload a clip (or pick one from the library), choose the time slots, and press the schedule button. You can then close the page and turn off your PC.
3. Clips made in SyncCut Studio: double-click `launchers/push-synccut.bat`. The newest exported episode (video, cover and brief) appears in the cloud app as a draft.

## Maintenance
| Task | How |
| --- | --- |
| Ship a code change to the cloud | `launchers/update-cloud.bat` (build, test, push, restart) |
| Copy local settings/accounts to the cloud | `npm run cloud:sync-db` |

## Notes
- The cloud app owns the schedule. Do not run a local copy at the same time, or the same clip could post twice.
- `cloud-bundle/cloud-connection.json` holds the cloud URL and password. It is git-ignored; keep it private.
- `release` is the deploy branch. The Railway service re-pulls it on every start, so a restart is a deploy.
