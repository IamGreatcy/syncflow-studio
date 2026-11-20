@echo off
rem Sends the latest exported SyncCut episode (video + cover + brief) to the cloud app as a draft.
cd /d "%~dp0.."
call npm run cloud:push-synccut
echo.
echo Done. Open the cloud app and finish scheduling the draft.
pause
