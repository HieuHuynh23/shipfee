# test_system.ps1
# Bo kiem tra toan bo he thong ShipFree
# Chay: powershell.exe -ExecutionPolicy Bypass -File test_system.ps1
# (Yeu cau server dang chay: node server/server.js & frontend server)

param(
    [int]$ApiPort      = 3001,
    [int]$FrontendPort = 8000
)

$API       = "http://localhost:$ApiPort"
$FRONTEND  = "http://localhost:$FrontendPort"
$passed    = 0
$failed    = 0
$warnings  = 0

# ─── Helpers ─────────────────────────────────────────────────────────────────
function Write-Pass  { param($msg) Write-Host "  [PASS] $msg" -ForegroundColor Green;  $global:passed++ }
function Write-Fail  { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red;    $global:failed++ }
function Write-Warn  { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow; $global:warnings++ }
function Write-Info  { param($msg) Write-Host "  [INFO] $msg" -ForegroundColor Cyan }
function Write-Sep   { param($title) Write-Host ""; Write-Host "  --- $title ---" -ForegroundColor Magenta }

function Invoke-Test {
    param(
        [string]$Name,
        [string]$Url,
        [string]$Method = "GET",
        [hashtable]$Body = $null,
        [int]$ExpectStatus = 200,
        [string]$ExpectBodyContains = "",
        [int]$TimeoutSec = 10
    )
    try {
        $splat = @{
            Uri             = $Url
            Method          = $Method
            UseBasicParsing = $true
            TimeoutSec      = $TimeoutSec
            ErrorAction     = "Stop"
        }
        if ($Body -and $Method -eq "POST") {
            $splat.Body        = ($Body | ConvertTo-Json)
            $splat.ContentType = "application/json"
        }

        $resp = Invoke-WebRequest @splat

        if ($resp.StatusCode -ne $ExpectStatus) {
            Write-Fail "$Name — Status $($resp.StatusCode) (expected $ExpectStatus) [$Url]"
            return $null
        }
        if ($ExpectBodyContains -and -not $resp.Content.Contains($ExpectBodyContains)) {
            Write-Fail "$Name — Body khong chua '$ExpectBodyContains' [$Url]"
            return $null
        }
        Write-Pass "$Name [HTTP $($resp.StatusCode)]"
        return $resp

    } catch [System.Net.WebException] {
        $statusCode = [int]$_.Exception.Response.StatusCode
        if ($statusCode -eq $ExpectStatus) {
            Write-Pass "$Name [HTTP $statusCode - expected]"
            return $null
        }
        Write-Fail "$Name — $($_.Exception.Message) [$Url]"
        return $null
    } catch {
        Write-Fail "$Name — $($_.Exception.Message) [$Url]"
        return $null
    }
}

function Parse-Json {
    param([string]$Content)
    try { return $Content | ConvertFrom-Json } catch { return $null }
}

# ─── Header ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "      ShipFree -- Kiem Tra Toan Bo He Thong" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   API      : $API" -ForegroundColor Yellow
Write-Host "   Frontend : $FRONTEND" -ForegroundColor Yellow
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""

# ─── 1. KIEM TRA KET NOI ─────────────────────────────────────────────────────
Write-Sep "1. KIEM TRA KET NOI SERVER"

# 1a. API Health
$statusResp = Invoke-Test -Name "API Health check GET /api/status" `
    -Url "$API/api/status" -ExpectBodyContains "online"

if ($statusResp) {
    $json = Parse-Json $statusResp.Content
    if ($json -and $json.status -eq "online") {
        Write-Info "API version : $($json.version)"
        Write-Info "City        : $($json.city)"
        if ($json.cache) {
            Write-Info "Cache       : $($json.cache.ageMinutes) phut (valid=$($json.cache.valid), $($json.cache.restaurants) quan)"
        } else {
            Write-Info "Cache       : Chua co cache"
        }
    }
}

# 1b. Frontend
Invoke-Test -Name "Frontend GET / -> index.html" `
    -Url "$FRONTEND/customer-app/index.html" -ExpectBodyContains "ShipFree" | Out-Null

Invoke-Test -Name "Frontend GET /customer-app/style.css" `
    -Url "$FRONTEND/customer-app/style.css" -ExpectBodyContains "{" | Out-Null

Invoke-Test -Name "Frontend GET /customer-app/app.js" `
    -Url "$FRONTEND/customer-app/app.js" | Out-Null

Invoke-Test -Name "Frontend GET /customer-app/restaurants-data.js" `
    -Url "$FRONTEND/customer-app/restaurants-data.js" | Out-Null

# ─── 2. KIEM TRA API /api/restaurants ────────────────────────────────────────
Write-Sep "2. API /api/restaurants"

$restResp = Invoke-Test -Name "GET /api/restaurants" `
    -Url "$API/api/restaurants"

$firstId = $null
if ($restResp) {
    $json = Parse-Json $restResp.Content
    if ($json -and $json.data) {
        $count = @($json.data).Count
        Write-Info "So quan tra ve : $count"
        Write-Info "Nguon du lieu  : $($json.source)"
        if ($count -gt 0) {
            Write-Pass "Co du lieu (khong rong)"
            $firstId = $json.data[0].id
            $firstName = $json.data[0].name

            # Kiem tra cau truc mot phan tu
            $r = $json.data[0]
            if ($r.id -and $r.name -and $r.menu) { Write-Pass "Cau truc phan tu hop le (id, name, menu)" }
            else { Write-Fail "Thieu truong du lieu: id/name/menu" }

            if ($r.rating -and $r.distance) { Write-Pass "Co rating va distance" }
            else { Write-Warn "Thieu rating hoac distance" }

            $menuCount = @($r.menu).Count
            if ($menuCount -gt 0) { Write-Pass "Menu co $menuCount mon an" }
            else { Write-Warn "Menu trong" }

            Write-Info "Quan dau tien : $firstName (ID: $firstId)"
        } else {
            Write-Warn "Danh sach quan an trong"
        }
    } else {
        Write-Fail "Response JSON khong hop le hoac thieu truong 'data'"
    }
}

# ─── 3. KIEM TRA TIM KIEM ────────────────────────────────────────────────────
Write-Sep "3. API TIM KIEM ?q="

$searchTerms = @("pho", "bun", "com", "ca phe", "tra sua")
foreach ($term in $searchTerms) {
    $searchResp = Invoke-Test -Name "Tim kiem: '$term'" `
        -Url "$API/api/restaurants?q=$([uri]::EscapeDataString($term))"
    if ($searchResp) {
        $sjson = Parse-Json $searchResp.Content
        if ($sjson -and $null -ne $sjson.total) {
            Write-Info "  '$term' -> $($sjson.total) ket qua (nguon: $($sjson.source))"
        }
    }
}

# Tim kiem khong ky tu
$emptySearch = Invoke-Test -Name "Tim kiem rong (q=)" `
    -Url "$API/api/restaurants?q="
if ($emptySearch) {
    $sj = Parse-Json $emptySearch.Content
    if ($sj -and $sj.data) { Write-Info "  Tra ve $($sj.total) quan" }
}

# ─── 4. KIEM TRA CHI TIET QUAN AN ────────────────────────────────────────────
Write-Sep "4. API /api/restaurants/:id"

if ($firstId) {
    $detailResp = Invoke-Test -Name "GET /api/restaurants/$firstId" `
        -Url "$API/api/restaurants/$firstId" -TimeoutSec 30

    if ($detailResp) {
        $dj = Parse-Json $detailResp.Content
        if ($dj -and $dj.data) {
            Write-Pass "Tra ve chi tiet quan: $($dj.data.name)"
            $menuLen = @($dj.data.menu).Count
            if ($menuLen -gt 0) { Write-Pass "Menu co $menuLen mon an" }
            else { Write-Warn "Menu trong" }
        }
    }
} else {
    Write-Warn "Bo qua kiem tra chi tiet (khong co ID)"
}

# ID khong ton tai
Invoke-Test -Name "GET /api/restaurants/id_khong_ton_tai -> 404" `
    -Url "$API/api/restaurants/id_khong_ton_tai" -ExpectStatus 404 | Out-Null

# ─── 5. KIEM TRA CACHE ───────────────────────────────────────────────────────
Write-Sep "5. API CACHE"

$clearResp = Invoke-Test -Name "POST /api/cache/clear" `
    -Url "$API/api/cache/clear" -Method "POST" -Body @{}
if ($clearResp) {
    $cj = Parse-Json $clearResp.Content
    if ($cj -and $cj.success) { Write-Pass "Cache cleared thanh cong" }
    else { Write-Warn "Cache clear tra ve ket qua khong ro rang" }
}

# Sau khi xoa cache, goi lai status
$statusAfter = Invoke-Test -Name "GET /api/status sau khi xoa cache" `
    -Url "$API/api/status"
if ($statusAfter) {
    $sj = Parse-Json $statusAfter.Content
    if ($sj -and $sj.status -eq "online") { Write-Pass "Server van online sau khi xoa cache" }
}

# ─── 6. KIEM TRA PAGES FRONTEND ──────────────────────────────────────────────
Write-Sep "6. FRONTEND PAGES"

$pages = @(
    @{ path = "/customer-app/index.html";      expect = "ShipFree" },
    @{ path = "/customer-app/restaurant.html"; expect = "ShipFree" },
    @{ path = "/customer-app/checkout.html";   expect = "checkout" },
    @{ path = "/customer-app/tracking.html";   expect = "tracking" }
)

foreach ($page in $pages) {
    $url = "$FRONTEND$($page.path)"
    Invoke-Test -Name "Frontend $($page.path)" -Url $url | Out-Null
}

# 404 cho file khong ton tai
Invoke-Test -Name "Frontend 404 cho file khong ton tai" `
    -Url "$FRONTEND/khong-ton-tai.html" -ExpectStatus 404 | Out-Null

# ─── 7. KIEM TRA CORS ────────────────────────────────────────────────────────
Write-Sep "7. CORS HEADERS"

try {
    $corsResp = Invoke-WebRequest -Uri "$API/api/restaurants" `
        -Headers @{ "Origin" = "http://localhost:$FrontendPort" } `
        -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    if ($corsResp.Headers["Access-Control-Allow-Origin"]) {
        Write-Pass "CORS header co mat: $($corsResp.Headers['Access-Control-Allow-Origin'])"
    } else {
        Write-Warn "CORS header khong co (co the frontend van chay duoc qua same-origin)"
    }
} catch {
    Write-Warn "Khong kiem tra duoc CORS: $($_.Exception.Message)"
}

# ─── 8. KIEM TRA TINH NANG TICH HOP ─────────────────────────────────────────
Write-Sep "8. TICH HOP: FRONTEND -> API"

Write-Info "Gia lap frontend goi API va lay danh sach quan..."
$integResp = Invoke-Test -Name "Frontend co the goi API /api/restaurants" `
    -Url "$API/api/restaurants" -TimeoutSec 15
if ($integResp) {
    $ij = Parse-Json $integResp.Content
    if ($ij -and $ij.data -and @($ij.data).Count -gt 0) {
        Write-Pass "Tich hop du lieu thanh cong: $($ij.total) quan"
        # Test lay chi tiet mot quan
        $sampleId = $ij.data[0].id
        $sampleResp = Invoke-Test -Name "Lay chi tiet tu ID trong danh sach" `
            -Url "$API/api/restaurants/$sampleId" -TimeoutSec 30
        if ($sampleResp) {
            $sr = Parse-Json $sampleResp.Content
            if ($sr -and $sr.data -and $sr.data.id -eq $sampleId) {
                Write-Pass "ID tu danh sach trung khop voi chi tiet"
            }
        }
    }
}

# ─── SUMMARY ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "      KET QUA KIEM TRA" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   PASS    : $passed" -ForegroundColor Green
Write-Host "   FAIL    : $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Green" })
Write-Host "   WARNING : $warnings" -ForegroundColor $(if ($warnings -gt 0) { "Yellow" } else { "Green" })
Write-Host "  ============================================================" -ForegroundColor Cyan

if ($failed -eq 0) {
    Write-Host "   HE THONG HOAT DONG TOT!" -ForegroundColor Green
} elseif ($failed -le 2) {
    Write-Host "   CO MOT SO VAN DE NHO - Xem FAIL ben tren." -ForegroundColor Yellow
} else {
    Write-Host "   NHIEU LOI - Hay kiem tra lai server." -ForegroundColor Red
}
Write-Host ""

exit $failed
