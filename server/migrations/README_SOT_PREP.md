# Prep: Supabase gần đủ để bỏ JSON đơn (chưa cutover)

## 1. Chạy migration SQL

Trong [Supabase SQL Editor](https://supabase.com/dashboard) → project ShipFee → SQL:

1. Mở file `server/migrations/001_orders_sot_prep.sql`
2. Run toàn bộ script (an toàn chạy lại)
3. Kiểm tra Table Editor: `orders` có cột `tracking_token`, `messages`, `assigned_shipper_phone`, `pinned_lat`, …
4. `shipper_profiles` có cột `cccd`, `email`

## 2. Deploy backend (PR này)

Sau deploy Render:

- Mỗi đơn upsert **đủ field** (token, chat, offer, pin, rating…)
- Boot hydrate merge remote → local **không xóa** các field đó
- Sync shipper đọc/ghi `cccd` từ `shipper_profiles`
- Boot catalog quán: thử Supabase (không kèm menu nặng) → nếu ≥ ngưỡng thì dùng; không đủ thì fallback chunk git

Env tùy chọn:

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `BOOT_RESTAURANTS_FROM_SUPABASE` | `true` (khi có Supabase) | `false` = luôn boot từ chunk |
| `BOOT_RESTAURANTS_MIN_COUNT` | `500` | Dưới ngưỡng → giữ chunk seed |

## 3. Smoke round-trip (local)

```bash
cd server
node -e "const p=require('./orderPersist'); const o={id:'T1',trackingToken:'abc',status:'PENDING',appTotal:10000,storeTotal:8000,shipperEarning:2000,assignedShipperPhone:'0901',offerExpiresAt:Date.now()+60000,pinnedLat:10.03,pinnedLon:105.78,messages:[{sender:'customer',text:'hi',timestamp:1}],rating:5,isRelative:false,note:'x',ordererPhone:'0902',items:[]}; console.log(p.assertRoundTrip(o));"
```

Kỳ vọng: `{ ok: true, missing: [] }`.

## 4. Chưa làm trong bước này

- Tắt ghi `orders-local.json` / đọc trực tiếp Postgres mỗi request
- Multi-instance không dùng RAM dispatch chung

Local JSON **vẫn là runtime SoT**; Supabase đã là backup/recover **đủ field**.
