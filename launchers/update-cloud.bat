@echo off
rem One-click update: build, test, push the latest code and restart the cloud service.
cd /d "%~dp0.."
call npm run cloud:deploy
echo.
pause
