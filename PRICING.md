# Hệ Thống Tính Giá ShipFee — Tài Liệu Thiết Kế (Chính thức)

Tài liệu này mô tả chi tiết cách hệ thống ShipFee tự động tính toán giá bán ứng dụng (`appPrice`), phụ thu khoảng cách, sàn thu nhập của shipper và các chương trình ưu đãi tự động.

---

## 1. Các Cấu Hình Hệ Thống (Config Constants)

Các tham số này được định nghĩa tập trung ở backend (`server.js`) và có thể mở rộng thành trang Admin Panel để điều chỉnh thời gian thực trong tương lai:

*   **MARKUP_RATE**: `0.28` (Cộng 28% cố định trên giá gốc tại quán `inStorePrice`).
*   **FREE_DISTANCE_KM**: `1.5` (Miễn phí phụ thu khoảng cách cho khách hàng trong bán kính dưới 1.5 km).
*   **SURCHARGE_COEFFICIENT**: `7000` (Hệ số tính phụ thu khoảng cách dựa trên hàm căn bậc hai).
*   **MIN_SHIPPER_EARNING**: `15000` (Thu nhập tối thiểu của tài xế nhận được trên mỗi đơn hàng là 15.000đ).
*   **MULTI_ITEM_DISCOUNT**: `0.15` (Ưu đãi mua nhiều: giảm 15% phụ thu khoảng cách cho món thứ 2 trở đi trong giỏ hàng, tối thiểu giảm 2.000đ cho mỗi món thêm).

---

## 2. Công Thức Tính Giá

### A. Giá Món Ăn Trên Menu (App Price)
Giá món hiển thị cho khách hàng khi xem thực đơn của một quán cách khách hàng $d$ km:

$$\text{appPrice} = \text{round100}(\text{inStorePrice} \times 1.28) + \text{distanceSurcharge}$$

Trong đó, toàn bộ số tiền đều được làm tròn đến **100đ gần nhất**.

### B. Phụ Thu Khoảng Cách (Distance Surcharge)
Khoảng cách $d$ được tính theo công thức Haversine đường chim bay giữa tọa độ ghim của khách hàng và quán ăn, sau đó lộ trình thực tế được dẫn đường bằng OSRM API. Phụ thu được tính như sau:

*   Nếu $d \le 1.5 \text{ km}$:
    $$\text{distanceSurcharge} = 0đ$$
*   Nếu $d > 1.5 \text{ km}$:
    $$\text{distanceSurcharge} = \text{round100}(7000 \times \sqrt{d - 1.5})$$

### C. Ưu Đãi Đặt Nhiều Món
Khi khách hàng đặt nhiều món ăn trong cùng một đơn hàng, hệ thống tự động áp dụng ưu đãi giảm giá mà không cần nhập mã code:

*   Nếu tổng số lượng món ăn trong giỏ hàng $N \ge 2$:
    $$\text{discountValue} = (N - 1) \times \max(2000, \text{round100}(\text{distanceSurchargePerItem} \times 0.15))$$
*   Có nghĩa là mỗi món ăn thêm từ món thứ 2 trở đi luôn được **giảm tối thiểu 2.000đ** (ngay cả khi giao gần dưới 1.5 km và phụ thu bằng 0đ). Điều này đảm bảo dòng giảm giá luôn được hiển thị trên trang thanh toán khi khách đặt từ 2 món trở lên.
*   Giá trị giảm giá này được trừ trực tiếp vào tổng tiền thanh toán của khách hàng, tạo trải nghiệm mua sắm tự nhiên, kích thích đặt nhiều món.

### D. Sàn Thu Nhập Shipper & Phí Đơn Hàng Nhỏ
Để đảm bảo mỗi chuyến giao hàng shipper luôn thu về tối thiểu **15.000đ** (bảo vệ thu nhập tài xế):

*   Hệ thống tính thu nhập ban đầu của shipper:
    $$\text{shipperEarning}_{\text{raw}} = \text{appTotal} - \text{storeTotal} - \text{discountValue}$$
*   Nếu $\text{shipperEarning}_{\text{raw}} < 15.000đ$:
    Hệ thống tự động thu thêm một khoản **"Phí đơn hàng nhỏ" (Small Order Fee)** để bù đắp chênh lệch:
    $$\text{minServiceFee} = 15.000đ - \text{shipperEarning}_{\text{raw}}$$
    Khoản phí này được cộng vào tổng tiền thanh toán (`appTotal`) hiển thị tại checkout, đồng thời hiển thị thông báo gợi ý: *"Thêm 1 món nữa để MIỄN phí đơn hàng nhỏ này!"*.

---

## 3. Bảng Giá Tham Chiếu (Ví dụ)

Bảng dưới đây minh họa giá món trên ứng dụng tùy thuộc vào giá gốc và khoảng cách giao hàng:

| Giá gốc tại quán | Giá App cơ bản (28%) | Tại chỗ ($\le 1.5$ km) | Khoảng cách 3.0 km (+8.600đ) | Khoảng cách 5.0 km (+13.100đ) | Khoảng cách 10 km (+20.400đ) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **20.000đ** | 25.600đ | 25.600đ | 34.200đ | 38.700đ | 46.000đ |
| **35.000đ** | 44.800đ | 44.800đ | 53.400đ | 57.900đ | 65.200đ |
| **50.000đ** | 64.000đ | 64.000đ | 72.600đ | 77.100đ | 84.400đ |

---

## 4. Các Ví Dụ Thực Tế

### Ví dụ 1: Khách đặt 1 bát Phở giá gốc 35.000đ, khoảng cách 3.0 km
*   **Giá gốc tại quán**: 35.000đ
*   **Giá App cơ bản (28% markup)**: $35.000 \times 1.28 = 44.800đ$
*   **Phụ thu khoảng cách**: $7000 \times \sqrt{3.0 - 1.5} = 7000 \times 1.2247 = 8.573đ \rightarrow$ làm tròn thành **8.600đ**.
*   **Giá món trên App hiển thị**: $44.800đ + 8.600đ = 53.400đ$.
*   **Đơn hàng 1 món nên không có ưu đãi đặt nhiều**: $\text{discountValue} = 0đ$.
*   **Thu nhập shipper thô**: $53.400đ - 35.000đ = 18.400đ$.
*   **Kiểm tra sàn shipper**: $18.400đ \ge 15.000đ \rightarrow$ Đạt yêu cầu. Không thu thêm phí đơn nhỏ.
*   **Khách trả**: **53.400đ** | **Shipper nhận**: **18.400đ** (đã bao gồm phụ thu khoảng cách).

### Ví dụ 2: Khách đặt 1 ly Trà sữa giá gốc 20.000đ, khoảng cách 1.0 km
*   **Giá gốc tại quán**: 20.000đ
*   **Giá App cơ bản (28% markup)**: $20.000 \times 1.28 = 25.600đ$
*   **Phụ thu khoảng cách**: $0đ$ (khoảng cách dưới 1.5 km).
*   **Giá món trên App hiển thị**: $25.600đ$.
*   **Thu nhập shipper thô**: $25.600đ - 20.000đ = 5.600đ$.
*   **Kiểm tra sàn shipper**: $5.600đ < 15.000đ \rightarrow$ Chưa đạt sàn!
*   **Phí đơn hàng nhỏ cần thu**: $15.000đ - 5.600đ = 9.400đ$.
*   **Khách trả**: $25.600đ + 9.400đ = 35.000đ$.
*   **Shipper nhận**: **15.000đ** (đảm bảo sàn tối thiểu).
*   *Giao diện checkout sẽ hiện:* Phí đơn hàng nhỏ là 9.400đ. Nhắc nhở: *"Thêm 1 món để miễn phí này!"*.

### Ví dụ 3: Khách đặt 2 bát Phở giá gốc 35.000đ/bát, khoảng cách 3.0 km
*   **Giá gốc tại quán**: $35.000 \times 2 = 70.000đ$.
*   **Giá App món 1 (đầy đủ)**: $44.800đ + 8.600đ = 53.400đ$.
*   **Giá App món 2 (chưa giảm)**: $44.800đ + 8.600đ = 53.400đ$.
*   **Ưu đãi đặt nhiều (giảm 15% phụ thu món 2, tối thiểu 2.000đ)**: $(2 - 1) \times \max(2000, \text{round100}(8.600 \times 0.15)) = 2.000đ$.
*   **Tổng cộng appTotal**: $(53.400 \times 2) - 2.000 = 104.800đ$.
*   **Thu nhập shipper thực tế**: $104.800đ - 70.000đ = 34.800đ \ge 15.000đ$ (Đạt sàn).
*   **Khách trả**: **104.800đ** | **Shipper nhận**: **34.800đ**.

### Ví dụ 4: Khách đặt 2 bát Phở giá gốc 35.000đ/bát, khoảng cách 1.0 km (Giao gần dưới 1.5 km)
*   **Giá gốc tại quán**: $35.000 \times 2 = 70.000đ$.
*   **Giá App món 1 (markup 28%, không surcharge)**: $44.800đ$.
*   **Giá App món 2**: $44.800đ$.
*   **Ưu đãi đặt nhiều (tối thiểu 2.000đ cho mỗi món thêm từ món thứ 2)**: $1 \times 2.000đ = 2.000đ$.
*   **Tổng cộng appTotal**: $(44.800 \times 2) - 2.000 = 87.600đ$.
*   **Thu nhập shipper thực tế**: $87.600đ - 70.000đ = 17.600đ \ge 15.000đ$ (Đạt sàn).
*   **Khách trả**: **87.600đ** | **Shipper nhận**: **17.600đ**.

---

## 5. Nhật Ký Thay Đổi (Changelog)

*   **Phiên bản 1.2 (Hiện tại)**:
    *   Nâng mức markup cơ sở lên cố định **28%** (thay vì random 25% - 35%) nhằm ổn định trải nghiệm giá.
    *   Hạ ngưỡng miễn phụ thu khoảng cách xuống **1.5 km** (trước đây là 2.0 km) nhằm tăng độ phủ thu nhập.
    *   Áp dụng **sàn thu nhập tài xế 15.000đ** qua hình thức phí đơn hàng nhỏ động.
    *   Thay đổi ưu đãi mua nhiều thành **giảm 15%** phụ thu khoảng cách cho món thứ 2+ (trước đây là 20%).
    *   Làm tròn toàn bộ số tiền thanh toán đến **100đ** (trước đây làm tròn 1.000đ).
