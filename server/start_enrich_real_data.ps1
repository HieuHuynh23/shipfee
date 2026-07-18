# ShipFee - Pipeline lay them quan THAT (FULL coverage) + cao menu
# Chay:  powershell -ExecutionPolicy Bypass -File server\start_enrich_real_data.ps1
# Full:  .\start_enrich_real_data.ps1 -Full -Threads 4

param(
  [int]$Threads = 4,
  [int]$DelayMs = 1500,
  [int]$MenuLimit = 0,
  [switch]$Full,
  [switch]$SkipDiscover,
  [switch]$SkipPortals,
  [switch]$SkipMenus,
  [switch]$SkipShopeeFood,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "node_modules")) {
  Write-Host ">> npm install..." -ForegroundColor Cyan
  npm install
}

if (-not $env:CRAWL_TIMEOUT_MS) { $env:CRAWL_TIMEOUT_MS = "90000" }

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  ShipFee Enrich REAL restaurant data" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# Foody truoc (phu rong + gap-fill), roi ShopeeFood
if (-not $SkipDiscover) {
  Write-Host ""
  Write-Host "[1/4] Discover Foody FULL (mon/duong/ho/prefix + gap-fill)..." -ForegroundColor Cyan
  $foodyArgs = @("discover_foody_shopeefood.js", "--gap-fill", "--concurrency=4")
  if ($Full) {
    $foodyArgs += @("--full", "--pages=20", "--detail-limit=0")
  } else {
    $foodyArgs += @("--pages=18", "--detail-limit=8000")
  }
  if ($DryRun) { $foodyArgs += "--dry-run" }
  node @foodyArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if (-not $SkipShopeeFood) {
    Write-Host ""
    Write-Host "[2/4] Discover ShopeeFood Can Tho (keyword + category)..." -ForegroundColor Cyan
    $discoverArgs = @("discover_shopeefood_restaurants.js")
    if ($DryRun) { $discoverArgs += "--dry-run" }
    node @discoverArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } else {
    Write-Host "[2/4] Skip ShopeeFood discover" -ForegroundColor Yellow
  }
} else {
  Write-Host "[1-2/4] Skip discover" -ForegroundColor Yellow
}

if (-not $SkipPortals) {
  Write-Host ""
  Write-Host "[3/4] Expand portal He thong -> chi nhanh..." -ForegroundColor Cyan
  $portalArgs = @(
    "crawl_restaurant_menus.js",
    "--portals-only",
    "--expand-only",
    "--threads=1",
    "--skip-supabase"
  )
  if ($DryRun) { $portalArgs += "--dry-run" }
  node @portalArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host "[3/4] Skip portals" -ForegroundColor Yellow
}

if (-not $SkipMenus) {
  Write-Host ""
  Write-Host "[4/4] Crawl menus (sf-priority, open-only)..." -ForegroundColor Cyan
  $menuArgs = @(
    "crawl_restaurant_menus.js",
    "--only-fallback",
    "--open-only",
    "--sf-priority",
    "--threads=$Threads",
    "--delay=$DelayMs"
  )
  if ($MenuLimit -gt 0) { $menuArgs += "--limit=$MenuLimit" }
  if ($DryRun) { $menuArgs += "--dry-run" }
  node @menuArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host "[4/4] Skip menus" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "DONE - kiem tra hasRealMenu trong DB / log crawl_restaurant_menus.log" -ForegroundColor Green
exit 0
