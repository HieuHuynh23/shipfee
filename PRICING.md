# Hệ Thống Tính Giá ShipFee — Tài Liệu Thiết Kế (Chính thức)

Tài liệu mô tả cách ShipFee tính giá món, phí checkout (60/40), sàn thu nhập shipper và ưu đãi khuyến khích đặt thêm / đặt lại.

**Nguyên tắc:** Menu = **giá thật tại quán** (giống chuỗi đối tác ShopeeFood). Phí chỉ hiện ở checkout — không nhồi markup vào thẻ món.

---

## 1. Cấu Hình Hệ Thống

| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `markupRate` | `0.28` | 28% trên `storeTotal` → góp vào **feePool** (không hiện trên menu) |
| `freeDistanceKm` | `1.5` | Dưới 1.5 km: không phụ thu khoảng cách |
| `surchargeCoefficient` | `7000` | Phụ thu/món khi `d > 1.5`: `round100(7000 × √(d−1.5))` |
| `minShipperEarning` | `15000` | **Sàn tối thiểu** shipper/đơn (không phải mức cố định mọi đơn) |
| `shipperSurplusShare` | `0.70` | Shipper nhận **70% phần dư** trên sàn |
| `platformFeeShare` | `0.60` | Hiển thị: 60% feePool = phí nền tảng |
| `deliveryFeeShare` | `0.40` | Hiển thị: 40% feePool = phí giao hàng |
| `multiItemDiscount` | `0.15` | Cơ sở ưu đãi phí từ món thứ 2 |
| `waivePlatformMinStoreTotal` | `79000` | Đủ tiền món → giảm/miễn phí nền tảng (clamp sàn) |
| `waivePlatformMinItems` | `3` | Hoặc đủ số món → giảm/miễn phí nền tảng |
| `halfDeliveryMinStoreTotal` | `120000` | Đủ tiền → giảm 50% phí giao (clamp sàn) |
| `halfDeliveryMinItems` | `3` | Hoặc đủ món → giảm 50% phí giao |
| `secondOrderDiscountRate` | `0.10` | Khách quay lại (cùng `ordererPhone`): giảm 10% trên `appTotal`, vẫn clamp ship ≥ 15k |

---

## 2. Công Thức

### A. Giá món trên menu
$$\text{giá hiển thị} = \text{inStorePrice}$$
(Không cộng 28% vào thẻ món.)

### B. Phí gom ở checkout (`feePool`)
$$\text{feePoolRaw} = \text{round100}(\text{storeTotal} \times 0.28) + \text{surchargePerItem} \times N$$

### C. Ưu đãi từ món thứ 2 (trừ trên phí)
Mỗi món từ món thứ 2 trở đi (sau món đắt nhất) được giảm **15% giá quán** của món đó:

$$\text{perExtra} = \max\big(2000,\ \text{round100}(\text{inStoreUnit} \times 0.15)\big)$$

$$\text{discountValue} = \sum \text{perExtra}\ \text{(món 2, 3, …)}$$

Ví dụ: 2 burger 35.000đ → giảm `round100(35000×0.15) = 5.250đ` (không còn kẹt sàn 2.000đ do công thức phụ thu cũ).

Ưu đãi trừ vào `feePool`; không được kéo `feePool` dưới 15.000đ (nếu vượt thì chỉ giảm phần dư trên sàn).

### D. Sàn shipper (top-up)
Nếu `feePool < 15.000` → cộng top-up đến đúng 15.000đ (khách thấy trong phí).

### E. Miễn / giảm phí theo ngưỡng
- Đủ **79.000đ món** hoặc **≥3 món** → giảm phí nền tảng (tối đa phần dư trên 15k).
- Đủ **120.000đ món** hoặc **≥3 món** → giảm thêm 50% phí giao (cùng clamp).
- `saveAmount` trên banner = số tiền khách **thật sự** bớt sau clamp.

### F. Hiển thị 60/40
$$\text{platformFee} = \text{round100}(\text{feePool} \times 0.60),\quad \text{deliveryFee} = \text{feePool} - \text{platformFee}$$

### G. Chi trả shipper (hưởng lợi, không kẹt sàn)
$$
\text{shipperEarning} =
\begin{cases}
15.000 & \text{nếu feePool} = 15.000 \\
15.000 + \text{round100}(0.70 \times (\text{feePool} - 15.000)) & \text{nếu feePool} > 15.000
\end{cases}
$$
Nền tảng giữ phần còn lại của `feePool`.

### H. Tổng khách trả
$$\text{appTotal} = \text{storeTotal} + \text{feePool}$$

---

## 3. Ví dụ cụ thể

### Ví dụ A — Đơn nhỏ (1 trà sữa 20k, 1 km)
| | |
|---|---|
| Món | 20.000đ |
| feePool thô | 5.600 → top-up → **15.000** |
| Phí nền tảng / giao (60/40) | 9.000 / 6.000 |
| Khách trả | **35.000đ** |
| Shipper | **15.000đ** (đúng sàn) |

Slogan mẫu: `Đặt thêm 59.000đ nữa để giảm …đ phí nền tảng.`

### Ví dụ B — 2 burger 35k (như Shopee, ~1.4 km)
| | |
|---|---|
| Món | 70.000đ (menu hiện 35k/món — khớp Shopee) |
| feePool thô | 19.600 |
| Ưu đãi món 2 (15%×35k) | 5.250đ → clamp sàn còn **4.600đ** (giữ feePool ≥ 15k) |
| feePool sau giảm | **15.000đ** |
| Phí nền tảng / giao (60/40) | 9.000 / 6.000 |
| Khách trả | **85.000đ** |
| Shipper | **15.000đ** (đúng sàn vì ưu đãi lớn trên đơn gần) |

> Đơn xa / nhiều món hơn: `feePool` lớn hơn → đủ chỗ áp đủ 15%/món và shipper vẫn > 15k.

### Ví dụ C — Đơn lớn / xa
`storeTotal` và phụ thu km lớn → `feePool` lớn → shipper tăng theo (ví dụ pool 40k → ship ~32.500đ).

---

## 4. Slogan checkout (số tiền chính xác)

Engine trả `feeWaiverHint`: `amountShort`, `itemsShort`, `currentFee`, `saveAmount`.

Mẫu:
- `Đặt thêm 44.000đ nữa để giảm 9.000đ phí nền tảng.`
- `Thêm 1 món (hoặc đặt thêm 44.000đ) để giảm 9.000đ phí nền tảng.`
- Nếu clamp: `Ưu đãi đã áp dụng: giảm 2.600đ phí nền tảng (tài xế vẫn nhận tối thiểu 15.000đ/đơn).`

Không ghi “Miễn phí giao hàng” cứng khi vẫn đang thu phí.

---

## 5. Chiến lược thu hút & đặt lại (Growth packages)

Catalog **~100 gói** tại CRM → Settings → Growth (`server/growth-packages.json`), API `/api/growth-offers`.
Mã promo **chỉ hiện app khách khi CRM Bật** (`enabled === true`). Engine/loyalty chạy nền.

### Đặc biệt — Ngày đôi (1/1 … 12/12)

Khi `ngày === tháng` (Asia/Ho_Chi_Minh):

| Mã | Giảm | Điều kiện |
|---|---|---|
| `NGAYDOI` | 25.000đ | Đơn từ 79k — mega flash mọi ngày đôi |
| `DOI15` | 15% (max 30k) | Đơn từ 50k |
| `DOI01`…`DOI12` | 11k…22k | Chỉ đúng tháng đó (vd `DOI07` chỉ 7/7) |

CRM highlight ngày đôi; bật trước 1–2 ngày. Không nhầm với `NGAY11`/`NGAY22` (ngày số đẹp hàng tháng).

### Nhóm gói chính

| Nhóm | Mục tiêu | Ví dụ mã / Engine |
|---|---|---|
| Engine | AOV / retention nền | món 2+, quay lại 10%, waive 79k, half delivery 120k |
| Welcome | Acquisition | `WELCOME10/15/20`, `MOI10`, `CHAO12` |
| Quay lại | Retention | `QUAYLAI10/15`, `BANCU12`, `RETURN8`, `LOYAL18` |
| Theo thứ | Peak theo ngày | `THU2`…`THUCN` |
| Khung giờ | Peak | `SANG8`, `TRUA10`, `TOI12`, `KHUYA15`… |
| Mốc AOV | Tăng giá trị đơn | `AOV40`…`AOV200` |
| Ngày lương / số đẹp | Calendar | `LUONG1`, `LUONG15`, `NGAY11`, `NGAY22` |
| Flash / % | Campaign | `FLASH5`…`FLASH25`, `PCT5`…`PCT20` |
| Nudge | Thêm món / niche | `THEM2`, `THEM3`, `COMBO79`, `FREESHIPF`… |
| Cuối tuần | AOV | `CUOITUAN15`, `CUOITUAN20` |

Mọi giảm giá **clamp** `feePool ≥ 15.000đ` (sàn shipper). Nút **Rebuild 100 gói** / **Đồng bộ mã** trong CRM.

---

## 6. Changelog

*   **1.3.3**: Catalog ~100 gói chiến lược + **Ngày đôi** (`NGAYDOI`, `DOI15`, `DOI01`–`DOI12`); CRM lọc/phân trang; mã mặc định OFF.
*   **1.3.2**: Growth packages (CRM + app khách) — WELCOME15, deal trưa/tối/cuối tuần, UI ưu đãi checkout/home.
*   **1.3.1**: Sửa ưu đãi món 2+ — giảm **15% giá quán**/món.
*   **1.3**: Menu = inStore; feePool checkout tách 60/40; shipper = sàn 15k + 70% phần dư.
*   **1.2**: Markup 28% trên món; Free ship hiển thị; sàn 15k; ưu đãi món 2+; đơn 2+ giảm 10%.
