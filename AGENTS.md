<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **FOOD DELIVERY** (493 symbols, 638 relationships, 20 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze --skip-git` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/FOOD DELIVERY/context` | Codebase overview, check index freshness |
| `gitnexus://repo/FOOD DELIVERY/clusters` | All functional areas |
| `gitnexus://repo/FOOD DELIVERY/processes` | All execution flows |
| `gitnexus://repo/FOOD DELIVERY/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

---

# ShipFree — Hướng Dẫn Dự Án

## Kiến Trúc Hệ Thống

```
d:\FOOD DELIVERY\
├── customer-app/          # Frontend (HTML/CSS/JS)
│   ├── index.html         # Trang chủ — danh sách quán ăn, chọn địa chỉ (Leaflet map)
│   ├── restaurant.html    # Chi tiết quán ăn + thêm vào giỏ
│   ├── checkout.html      # Xác nhận đơn hàng (Leaflet map giao hàng)
│   ├── tracking.html      # Theo dõi đơn hàng (Leaflet map + shipper simulation)
│   ├── app.js             # State management, cart, order logic (localStorage)
│   └── style.css          # Design system tokens + components
│
├── server/                # Backend Node.js Express (port 3001)
│   ├── server.js          # API server — routes, caching, scraper orchestration
│   ├── menuScraper.js     # Puppeteer scraper lấy menu từ ShopeeFood
│   ├── restaurants-local.json  # Database 435 quán ăn Cần Thơ
│   └── package.json       # Dependencies: express, compression, cors, puppeteer-core...
│
├── start_server.ps1       # Launcher: API + http-server frontend (hỗ trợ 1000+ user)
├── test_system.ps1        # Automated API test (PASS:33/FAIL:0)
├── test_checkout_tracking.js  # Puppeteer E2E test checkout→tracking (PASS:25/FAIL:0)
└── bulk_crawl.js          # Script crawl menu ShopeeFood hàng loạt
```

## Tính Năng Chính

### Đặt Hàng
- **Đặt cho bản thân** hoặc **Đặt cho người thân** (bắt buộc chọn)
- Khi đặt cho người thân: nhập tên, SĐT người thân + SĐT người đặt
- **Ghim vị trí trên bản đồ Leaflet** để shipper giao chính xác
- Nút "Sử dụng vị trí GPS hiện tại"

### Theo Dõi Đơn Hàng
- Bản đồ Leaflet hiển thị 3 markers: Quán (🏪) / Điểm giao (🏠) / Shipper (🛵)
- Shipper di chuyển theo từng bước: PENDING → ACCEPTED → PURCHASED → DELIVERED
- Timeline 4 bước với timestamp

## Hiệu Năng (sau khi nâng cấp)

| Thành phần | Trước | Sau |
|-----------|-------|-----|
| Frontend server | PowerShell HttpListener (single-thread) | **http-server** (async Node.js) |
| Gzip compression | ❌ Không có | ✅ `compression` middleware (level 6) |
| Cache-Control API | ❌ Không có | ✅ `public, max-age=30, stale-while-revalidate=60` |
| CORS | Cơ bản | ✅ Origin whitelist cụ thể |
| Khả năng chịu tải | ~10 user/lúc | **1000–5000+ user/lúc** |
| Payload Size (List API) | 9.7 MB (kèm menus) | **~150 KB** (lược bỏ menu ở list endpoint, giảm 98.5%) |
| LocalStorage Quota | ❌ Lỗi QuotaExceededError (không lưu được) | ✅ Đạt chuẩn lưu trữ mượt mà dưới 5MB |

## Server API Endpoints

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/restaurants` | GET | Danh sách quán (có filter ?q=, ?lat=, ?lon=) |
| `/api/restaurants/:id` | GET | Chi tiết quán + auto-scrape menu nếu cần |
| `/api/status` | GET | Health check + trạng thái cache |
| `/api/cache/clear` | POST | Xóa cache thủ công |

## Chạy Dự Án

```powershell
# Khởi động toàn bộ hệ thống
powershell -ExecutionPolicy Bypass -File start_server.ps1

# Test API
powershell -ExecutionPolicy Bypass -File test_system.ps1

# Test E2E Checkout→Tracking
node test_checkout_tracking.js

# Crawl menu ShopeeFood hàng loạt
node bulk_crawl.js --concurrency=2
```

## Lưu Ý Quan Trọng

- `restaurants-local.json` là database chính — **không xóa**
- Sweep Worker daemon tự động crawl lại menu mỗi 30 giây
- Puppeteer dùng Chrome tại `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
- GitNexus dùng `--skip-git` vì project không dùng git truyền thống
