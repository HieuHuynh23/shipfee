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
$$(N-1) \times \max\big(2000,\ \text{round100}(\text{surchargePerItem}\times 0.15 + \text{avgUnit}\times 0.03)\big)$$
Không được kéo `feePool` dưới 15.000đ.

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
| feePool thô | 19.600 − ưu đãi món 2 ≈ **17.600** |
| Phí nền tảng / giao | ~10.600 / ~7.000 |
| Khách trả | **~87.600đ** (Shopee không voucher ~88k) |
| Shipper | 15.000 + 70%×2.600 ≈ **16.800đ** (> sàn) |

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

## 5. Chiến lược thu hút & đặt lại

| Giai đoạn | Cách | Bảo vệ ship |
|---|---|---|
| Khách mới | Giá món = giá quán; phí 60/40 minh bạch | Không copy voucher 50–90% Shopee |
| Tăng món/đơn | Banner thiếu **Xđ** / giảm **Yđ**; ưu đãi từ món 2 | Clamp feePool ≥ 15k |
| Đơn 2+ | `secondOrderDiscountRate` 10% + loyalty điểm | Sau giảm: tính lại ship = 15k + 70% dư trên fee còn lại |
| Thương hiệu | Không “Free ship” giả; khoe giá thật + tài xế đủ sống và tăng theo đơn | — |

---

## 6. Changelog

*   **1.3 (Hiện tại)**: Menu = inStore; feePool checkout tách 60/40; shipper = sàn 15k + 70% phần dư; slogan số tiền; ngưỡng miễn phí nền tảng 79k / ≥3 món; giảm 50% phí giao 120k / ≥3 món; bỏ nhồi markup + Free ship giả trên UI.
*   **1.2**: Markup 28% trên món; Free ship hiển thị; sàn 15k qua phí đơn nhỏ; ưu đãi món 2+; đơn 2+ giảm 10%.
