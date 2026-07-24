# Prep + cutover nhẹ: Supabase là SoT bền; JSON local là cache nóng

## 1. Chạy migration SQL

Trong [Supabase SQL Editor](https://supabase.com/dashboard) → project ShipFee → SQL:

1. Mở file `server/migrations/001_orders_sot_prep.sql`
2. Run toàn bộ script (an toàn chạy lại)
3. Kiểm tra Table Editor: `orders` có cột `tracking_token`, `messages`, `assigned_shipper_phone`, `pinned_lat`, …
4. `shipper_profiles` có cột `cccd`, `email`

## 2. Hành vi runtime (sau deploy)

| Luồng | Hành vi |
|-------|---------|
| Ghi đơn (status/gán/chat/…) | Ghi `orders-local.json` rồi **await** upsert Supabase (cùng queue) |
| Đọc chi tiết đơn | Local trước; miss → Supabase → ghi lại cache |
| Boot | Hydrate active + lịch sử retention từ Supabase |
| GPS location spam | Không upsert mỗi tick GPS (fingerprint persist) |

Env tùy chọn:

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `BOOT_RESTAURANTS_FROM_SUPABASE` | `true` (khi có Supabase) | `false` = luôn boot từ chunk |
| `BOOT_RESTAURANTS_MIN_COUNT` | `500` | Dưới ngưỡng → giữ chunk seed |
| `ADMIN_EMAIL_ALLOWLIST` | `admin@shipfee.vn` | Email bootstrap admin nếu chưa có `app_metadata.role` |

## 3. Smoke round-trip (local)

```bash
cd server
node -e "const p=require('./orderPersist'); const o={id:'T1',trackingToken:'abc',status:'PENDING',appTotal:10000,storeTotal:8000,shipperEarning:2000,assignedShipperPhone:'0901',offerExpiresAt:Date.now()+60000,pinnedLat:10.03,pinnedLon:105.78,messages:[{sender:'customer',text:'hi',timestamp:1}],rating:5,isRelative:false,note:'x',ordererPhone:'0902',items:[]}; console.log(p.assertRoundTrip(o));"
```

Kỳ vọng: `{ ok: true, missing: [] }`.

## 4. Chưa làm (multi-instance)

- Bỏ hẳn file JSON / đọc Postgres mỗi request
- Dispatch offer trên nhiều instance Render (cần Redis/DB lock)

Local JSON **vẫn là cache nóng** để latency thấp; Supabase là nguồn bền sau redeploy.
