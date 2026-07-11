# Phân Tích Dữ Liệu Quán & Menu — Kế Hoạch Xử Lý

## 📊 Thực Trạng Dữ Liệu

| Chỉ số | Số lượng | Tỷ lệ |
|--------|---------|--------|
| **Tổng quán** | 7.429 | 100% |
| **Quán đã đóng cửa** (`isClosed=true`) | **5.890** | **79.3%** ❌ |
| **Quán còn hoạt động** | 1.539 | 20.7% |
| **Có menu thực tế** (`hasRealMenu=true`) | 3.927 | 52.9% |
| **Menu fallback (giả lập)** (`hasRealMenu=false`) | **3.502** | **47.1%** ❌ |
| **Không có ShopeeFood slug** | 7.314 | 98.5% |
| **Dung lượng chunks** | 10.46 MB | — |
| **Dung lượng menus** | 25.03 MB | — |
| **Tổng dung lượng** | **35.49 MB** | — |

> [!CAUTION]
> **79.3% quán ăn** trong database đã đóng cửa nhưng vẫn hiển thị trên webapp! Đây là nguyên nhân chính khiến app load chậm (trả về 7.429 quán thay vì ~1.500 quán).

---

## 🔍 3 Vấn Đề Chính

### Vấn đề 1: Quán đóng cửa vẫn hiển thị (5.890 quán)
- API `GET /api/restaurants` trả về **toàn bộ 7.429 quán** — không lọc `isClosed`
- Frontend nhận payload khổng lồ (~10MB response), render DOM hàng nghìn card → **chậm**
- Quán đóng cửa cần **ẩn khỏi danh sách chính**, chỉ hiển thị khi tìm kiếm cụ thể

### Vấn đề 2: Menu fallback không chính xác (3.502 quán)
- 47% quán có menu được sinh tự động bởi `generateMenuForRestaurant()` — **menu giả, không phải món thực tế**
- Chỉ dựa vào tên quán để đoán loại hình (trà sữa, cơm, bún...) → rất thiếu chính xác
- Giá hoàn toàn không chính xác vì không dựa trên giá thực tế từ ShopeeFood

### Vấn đề 3: Tải chậm do dữ liệu khổng lồ
- 7.429 quán × metadata = **~10MB payload** cho API list
- Memory cache giữ toàn bộ 7.429 quán trong RAM
- Frontend render DOM cho tất cả kết quả cùng lúc

---

## 🛠️ Proposed Changes

### Phase 1: Backend — Lọc quán đóng cửa & Tối ưu API

#### [MODIFY] [server.js](file:///d:/FOOD%20DELIVERY/server/server.js)

**1a. Lọc quán đóng cửa khỏi danh sách chính:**
- `GET /api/restaurants` (không có `?q=`): Chỉ trả về quán `isClosed !== true`
- `GET /api/restaurants?q=keyword`: Tìm kiếm vẫn bao gồm quán đóng (nhưng đánh dấu rõ)
- Thêm query param `?includeAll=true` cho CRM Admin khi cần xem toàn bộ
- **Kết quả**: Response giảm từ 7.429 → ~1.500 quán (giảm 80%)

**1b. Tạo danh sách "cào sau" cho quán tạm đóng cửa:**
- Tạo endpoint `GET /api/admin/crawl-queue` — danh sách quán tạm đóng, cần kiểm tra lại
- Quán `isClosed=true` nhưng không có `closedReason='permanent'` → thêm vào queue cào
- Lưu vào file `server/crawl-queue.json` để crawl_scheduler.js sử dụng

**1c. Phân trang (Pagination):**
- Thêm `?page=1&limit=50` cho API restaurants list
- Mặc định trả 50 quán/trang, sắp xếp theo rating và khoảng cách

### Phase 2: Frontend — Tối ưu tải và hiển thị

#### [MODIFY] [customer-app/app.js](file:///d:/FOOD%20DELIVERY/customer-app/app.js) + [index.html](file:///d:/FOOD%20DELIVERY/customer-app/index.html)
- Lazy loading: Chỉ render 20 quán đầu, scroll thêm sẽ load thêm
- Hiển thị badge "TẠM ĐÓNG" rõ ràng cho quán đóng khi tìm kiếm
- Bỏ render quán đóng cửa ở trang chủ

### Phase 3: Dọn dẹp dữ liệu

#### [MODIFY] [dbHelper.js](file:///d:/FOOD%20DELIVERY/server/dbHelper.js)
- Thêm function `readActive()` — chỉ đọc quán `isClosed !== true`
- Thêm function `getCrawlQueue()` — lấy danh sách quán cần cào lại

---

## Open Questions

> [!IMPORTANT]
> **Q1**: Có muốn xóa hẳn 5.890 quán đóng cửa khỏi database không? Hay chỉ ẩn và giữ lại để kiểm tra cào lại sau?
> 
> **Q2**: Đối với 3.502 quán có menu fallback — muốn xóa menu giả và để trống (hiển thị "Chưa cập nhật menu") hay giữ menu giả làm placeholder?
> 
> **Q3**: Quán tạm đóng cửa — muốn crawl_scheduler.js tự động kiểm tra lại mỗi ngày hay chỉ chạy thủ công qua CRM Admin?

---

## Verification Plan
1. Đo thời gian response API trước/sau khi lọc
2. Kiểm tra frontend load speed trước/sau
3. Xác nhận CRM Admin vẫn hiển thị đầy đủ quán khi cần
