# ShipFee — GrabFood enrich: purge delist Shopee → discover Grab → crawl menus → sync Supabase
# Usage:
#   powershell -ExecutionPolicy Bypass -File server/start_grabfood_enrich.ps1
#   powershell -ExecutionPolicy Bypass -File server/start_grabfood_enrich.ps1 -Full
#   powershell -ExecutionPolicy Bypass -File server/start_grabfood_enrich.ps1 -SkipPurge

param(
  [switch]$Full,
  [switch]$SkipPurge,
  [switch]$SkipDiscover,
  [switch]$SkipCrawl,
  [switch]$SkipSync,
  [int]$MenuLimit = 0,
  [int]$Concurrency = 4
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$log = Join-Path $PSScriptRoot "grabfood_enrich.log"
function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Log "=== GrabFood enrich start Full=$Full ==="

if (-not $SkipPurge) {
  Log "1/4 Purge delisted ShopeeFood..."
  node purge_delisted_shopeefood.js --apply 2>&1 | Tee-Object -FilePath $log -Append
}

if (-not $SkipDiscover) {
  Log "2/4 Discover GrabFood (add-missing)..."
  $discoverArgs = @()
  if ($Full) { $discoverArgs += "--full" }
  node discover_grabfood_restaurants.js @discoverArgs 2>&1 | Tee-Object -FilePath $log -Append
}

if (-not $SkipCrawl) {
  Log "3/4 Crawl GrabFood menus..."
  $crawlArgs = @("--concurrency=$Concurrency")
  if ($MenuLimit -gt 0) { $crawlArgs += "--limit=$MenuLimit" }
  node crawl_grabfood_menus.js @crawlArgs 2>&1 | Tee-Object -FilePath $log -Append
}

if (-not $SkipSync) {
  Log "4/4 Sync menus → Supabase (--only-real)..."
  node sync_menus_to_supabase.js --only-real 2>&1 | Tee-Object -FilePath $log -Append
}

Log "=== GrabFood enrich done ==="
