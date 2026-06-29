<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **shipfee** (1301 symbols, 2314 relationships, 109 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

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
| `gitnexus://repo/shipfee/context` | Codebase overview, check index freshness |
| `gitnexus://repo/shipfee/clusters` | All functional areas |
| `gitnexus://repo/shipfee/processes` | All execution flows |
| `gitnexus://repo/shipfee/process/{name}` | Step-by-step execution trace |

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

# ShipFee — Hướng Dẫn Dự Án

## Kiến Trúc Hệ Thống

```
d:\FOOD DELIVERY\
├── customer-app/          # Frontend Khách hàng (HTML/CSS/JS)
│   ├── index.html         # Trang chủ — danh sách quán ăn, chọn địa chỉ (Leaflet map)
│   ├── restaurant.html    # Chi tiết quán ăn + thêm vào giỏ
│   ├── checkout.html      # Xác nhận đơn hàng (Leaflet map giao hàng)
│   ├── tracking.html      # Theo dõi đơn hàng (Leaflet map + shipper simulation)
│   ├── app.js             # State management, cart, order logic (localStorage)
│   └── style.css          # Design system tokens + components
│
├── shipper-app/           # Frontend Tài xế (HTML/CSS/JS)
│   ├── index.html         # Giao diện tài xế - Trực tuyến, nhận đơn, live map và chat nhanh
│   ├── app.js             # Logic vuốt kéo, Audio chime synth, nhắn tin nhanh và AR/CR rates
│   └── style.css          # Design system HUD dark theme, slider cảm ứng mobile-first
│
├── server/                # Backend Node.js Express (port 3001)
│   ├── server.js          # API server — phục vụ trực tiếp từ Local DB, quản lý đồng bộ nền
│   ├── menuScraper.js     # Puppeteer scraper dùng để đối chiếu & đồng bộ giá món ăn với ShopeeFood
│   ├── restaurants-local.json  # Database độc lập chứa thông tin quán + thực đơn đầy đủ
│   └── package.json       # Dependencies: express, compression, cors, puppeteer-core...
│
├── start_server.ps1       # Launcher: API + http-server frontend (hỗ trợ 1000+ user)
├── test_system.ps1        # Automated API test (PASS:33/FAIL:0)
├── test_checkout_tracking.js  # Puppeteer E2E test checkout→tracking (PASS:27/FAIL:0)
└── bulk_crawl.js          # Script đối chiếu và đồng bộ giá món ăn hàng loạt với ShopeeFood
```

## Tính Năng Chính

### Độc Lập Dữ Liệu & Xem Thực Đơn
- **Phục vụ từ Database Độc lập (ShopeeFood-Independent)**: Giao diện và API chi tiết quán (`/api/restaurants/:id`) phục vụ thực đơn trực tiếp 100% từ cơ sở dữ liệu local `restaurants-local.json`, phản hồi tức thời (<5ms) và hoạt động bền vững không bị ảnh hưởng bởi lỗi mạng hay chính sách chặn IP của ShopeeFood.
- **Đặt cho bản thân** hoặc **Đặt cho người thân** (bắt buộc chọn).
- Khi đặt cho người thân: nhập tên, SĐT người thân + SĐT người đặt.
- **Ghim vị trí trên bản đồ Leaflet** để shipper giao chính xác (hỗ trợ nút "Sử dụng vị trí GPS hiện tại").
- **Duyệt thực đơn quán đóng cửa**: Xem thực đơn ở chế độ chỉ đọc (Read-only, hiển thị trạng thái "TẠM ĐÓNG") thay vì ẩn quán, giúp tăng trải nghiệm khách hàng.

### Đối Chiếu & Đồng Bộ Giá Món Ăn (ShopeeFood Price Sync)
- **ShopeeFood làm dữ liệu đối chiếu**: Hệ thống không phụ thuộc vào ShopeeFood để hiển thị món ăn, nhưng sử dụng dữ liệu ShopeeFood để đối chiếu, kiểm tra chênh lệch và cập nhật giá bán.
- **Tự động đồng bộ ngầm**: Tiến trình chạy ngầm (Sweep Worker / Bulk Scraper) sẽ định kỳ lấy menu từ ShopeeFood, so khớp với món ăn hiện tại để cập nhật giá gốc (`inStorePrice`) tại quán nếu có thay đổi từ phía ShopeeFood.
- **Tính toán tự động giá App**: Giá bán trên ứng dụng (`appPrice`) được tự động cập nhật theo công thức: `appPrice = inStorePrice * (1 + 28% Markup)`.

### Phí Ship Ẩn Theo Khoảng Cách (Hidden Shipping Fee)
- **Tự động tích hợp phí ship vào giá món**: Tự động tính khoảng cách từ khách hàng đến quán. Nếu khoảng cách $> 2$ km, hệ thống tự động cộng phụ phí ẩn vào giá bán ứng dụng (`appPrice`) của từng món ăn:
  - Khoảng cách từ 2km đến 10km: $+5.000$đ / km / món cho mỗi km vượt quá 2km.
  - Khoảng cách trên 10km: $+40.000$đ $+$ $8.000$đ / km / món cho mỗi km vượt quá 10km.
- **Giữ vững cam kết "Free Ship"**: Toàn bộ giao diện giỏ hàng, thanh toán và theo dõi đều hiển thị phí vận chuyển là "Miễn phí" (Free Shipping).
- **Bảo vệ thu nhập tài xế**: Tài xế nhận trọn vẹn phụ phí khoảng cách vì `shipperEarning` được tính bằng chênh lệch `appTotal - storeTotal`.

### Theo Dõi Đơn Hàng
- Bản đồ Leaflet hiển thị 3 markers: Quán (🏪) / Điểm giao (🏠) / Shipper (🛵)
- **Lộ trình đường phố thực tế (Real Street Routing)**: Bản đồ kết nối lộ trình thực tế qua đường bộ bằng OSRM API thay vì đường chim bay.
- **Mô phỏng chuyển động mượt mà (Smooth Animation)**: Shipper di chuyển mượt mà dọc theo các cung đường phố thực tế trong suốt quá trình giao nhận.
- Shipper di chuyển qua các bước: PENDING → ACCEPTED (đi đến quán) → PURCHASED (đang giao) → DELIVERED.
- Timeline 4 bước với timestamp chi tiết.

### Web App Tài Xế (Shipper Web App)
- **Thiết kế giao diện HUD Dark Mode thể thao**: Giao diện tối HUD tối ưu hóa độ tương phản cao, giao diện trực quan và chuyên nghiệp.
- **Thanh vuốt cảm ứng Swipe to Action**: Tích hợp các thao tác vuốt kéo thả mượt mà trên cả PC và thiết bị di động (Touch / Mouse drag physics). Hỗ trợ "Vuốt để nhận đơn" (Swipe to Accept) và "Vuốt để đổi trạng thái" (Swipe to Advance) giúp giảm thiểu các thao tác nhấp nhầm và tự động snap-back nếu kéo chưa đạt 90%.
- **Hệ thống nhạc chuông chimes báo đơn mới**: Tích hợp Web Audio API tự tổng hợp âm thanh chuông bíp cảnh báo tài xế tức thì khi có đơn hàng mới xuất hiện mà không cần tải file `.mp3` tĩnh.
- **Thống kê chất lượng tài xế (AR/CR Metrics)**: Hệ thống tự động lưu trữ và tính toán Tỷ lệ nhận đơn (AR - Acceptance Rate) và Tỷ lệ hoàn thành đơn (CR - Completion Rate) trong `localStorage` để phân tích chất lượng phục vụ của shipper.
- **Đồng bộ hóa Ghi chú & Trò chuyện hai chiều**: Hiển thị nổi bật ghi chú của khách hàng (note) tại Job Modal và Active Trip Card. Hỗ trợ hệ thống nhắn tin nhanh (Quick message) và nhắn tin gõ tay (Custom message) đồng bộ hai chiều thời gian thực giữa Khách hàng (trang Tracking) và Tài xế thông qua API, tự cập nhật qua polling 3 giây.

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

- `restaurants-local.json` là database chính độc lập — **không xóa**. Đây là nguồn dữ liệu chính chứa thông tin quán và thực đơn đã được cào sẵn từ trước.
- **Quy trình Đối chiếu & Làm sạch**: Hệ thống định kỳ chạy Sweep Worker để đối chiếu thực đơn local với ShopeeFood nhằm cập nhật giá gốc (`inStorePrice`) và phát hiện các quán đã đóng cửa hoàn toàn để cập nhật trạng thái hoạt động trên database local thay vì cào đồng bộ.
- Sweep Worker daemon tự động chạy ngầm để thực hiện đối chiếu giá món ăn và tình trạng hoạt động mỗi 30 giây.
- Puppeteer dùng Chrome tại `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`.
- GitNexus dùng `--skip-git` vì project không dùng git truyền thống.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **FOOD DELIVERY** (949 symbols, 1494 relationships, 84 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

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
