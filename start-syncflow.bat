@echo off
title SyncFlow Studio
cd /d "C:\Users\iamgr\.gemini\antigravity\scratch\clipflow-studio"

:: Check if port 3001 is already listening
netstat -ano | findstr ":3001 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo SyncFlow Studio is already running! Opening browser...
    start "" "http://localhost:3001"
    exit /b 0
)

echo Starting SyncFlow Studio Server...
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start "" "http://localhost:3001""
node apps\server\dist\index.js
