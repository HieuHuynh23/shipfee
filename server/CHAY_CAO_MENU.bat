@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ShipFee - Cao menu tung quan
echo.
echo ========================================
echo   ShipFee - Bat dau cao menu ShopeeFood
echo ========================================
echo.
if not exist "node_modules\" (
  echo Dang npm install...
  call npm install
)
set CRAWL_TIMEOUT_MS=90000
node crawl_restaurant_menus.js --only-fallback --open-only --threads=2 --delay=2500
echo.
echo Xong. Nhan phim bat ky de dong...
pause >nul
