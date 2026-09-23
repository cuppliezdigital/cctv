@echo off
title CCTV Central Hub - Hikvision
color 0A
echo ====================================================
echo    CCTV CENTRAL HUB - HIKVISION VMS & DOWNLOADER
echo ====================================================
echo Membuka dashboard di browser web...
echo URL: http://localhost:3000
echo.
timeout /t 2 >nul
start http://localhost:3000
node server.js
pause

