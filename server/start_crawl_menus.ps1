# ShipFee — Kích hoạt cào menu từng quán (Windows local)
# Chạy:  powershell -ExecutionPolicy Bypass -File server\start_crawl_menus.ps1
# Tuỳ chọn:  .\start_crawl_menus.ps1 -Threads 2 -Limit 100

param(
  [int]$Threads = 2,
  [int]$Limit = 0,
  [string]$Id = "",
  [switch]$Force,
  [switch]$DryRun,
  [switch]$IncludeClosed
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "node_modules")) {
  Write-Host ">> npm install..." -ForegroundColor Cyan
  npm install
}

$argsList = @("crawl_restaurant_menus.js", "--only-fallback", "--threads=$Threads", "--delay=2500")

if (-not $IncludeClosed) { $argsList += "--open-only" }
if ($Limit -gt 0) { $argsList += "--limit=$Limit" }
if ($Id) { $argsList = @("crawl_restaurant_menus.js", "--id=$Id", "--threads=1") }
if ($Force) { $argsList += "--force" }
if ($DryRun) { $argsList += "--dry-run" }

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  ShipFee Menu Crawler — STARTING" -ForegroundColor Green
Write-Host "  node $($argsList -join ' ')" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Load .env if present (dotenv in script also loads it)
$env:CRAWL_TIMEOUT_MS = if ($env:CRAWL_TIMEOUT_MS) { $env:CRAWL_TIMEOUT_MS } else { "90000" }

node @argsList
exit $LASTEXITCODE
