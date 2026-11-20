@echo off
rem Opens the SyncFlow Studio cloud app in your default browser.
cd /d "%~dp0.."
for /f "usebackq delims=" %%U in (`node -e "console.log(require('./cloud-bundle/cloud-connection.json').cloudUrl)"`) do set CLOUD_URL=%%U
if "%CLOUD_URL%"=="" (
  echo Could not read cloud-bundle\cloud-connection.json
  pause
  exit /b 1
)
start "" "%CLOUD_URL%"
