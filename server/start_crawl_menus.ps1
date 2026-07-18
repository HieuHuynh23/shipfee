# ShipFee - Kich hoat cao menu tung quan (Windows local)
# Chay:  powershell -ExecutionPolicy Bypass -File server\start_crawl_menus.ps1
# Tuy chon:  .\start_crawl_menus.ps1 -Threads 4 -Limit 100

param(
  [int]$Threads = 4,
  [int]$DelayMs = 1500,
  [int]$Limit = 0,
  [string]$Id = "",
  [switch]$Force,
  [switch]$DryRun,
  [switch]$IncludeClosed,
  [switch]$PortalsOnly,
  [switch]$SfPriority
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "node_modules")) {
  Write-Host ">> npm install..." -ForegroundColor Cyan
  npm install
}

$argsList = @("crawl_restaurant_menus.js", "--only-fallback", "--threads=$Threads", "--delay=$DelayMs")

if (-not $IncludeClosed) { $argsList += "--open-only" }
if ($Limit -gt 0) { $argsList += "--limit=$Limit" }
if ($Id) { $argsList = @("crawl_restaurant_menus.js", "--id=$Id", "--threads=1") }
if ($Force) { $argsList += "--force" }
if ($DryRun) { $argsList += "--dry-run" }
if ($PortalsOnly) { $argsList += "--portals-only" }
if ($SfPriority) { $argsList += "--sf-priority" }

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  ShipFee Menu Crawler - STARTING ($Threads Threads)" -ForegroundColor Green
Write-Host "  node $($argsList -join ' ')" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

if (-not $env:CRAWL_TIMEOUT_MS) {
  $env:CRAWL_TIMEOUT_MS = "90000"
}

node @argsList
exit $LASTEXITCODE
