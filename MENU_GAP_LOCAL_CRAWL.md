# Menu gap — danh sách crawl local

> Snapshot: **2026-07-25 17:21 UTC**  
> Tiêu chí giống **Làm Hơi**: local `hasRealMenu=true` nhưng Supabase **không có menu body thật**  
> (rỗng / thiếu row / chỉ còn menu Unsplash template → hydrate Render trả `unavailable`).

## Tóm tắt

| Nhóm | Số lượng |
|------|----------|
| Tổng cần crawl | **51** |
| Đang mở (ưu tiên) | **18** |
| Đang đóng | **33** |
| `empty_menu_body` | 1 |
| `missing_on_supabase` | 1 |
| `template_menu` (Unsplash) | 49 |

File kèm:
- `ids-open.txt` — chỉ quán đang mở (chạy trước)
- `ids-all.txt` — cả mở + đóng
- `restaurants.json` / `restaurants.csv` — chi tiết
- `crawl-menu-gap.sh` — script chạy hàng loạt

## Cách chạy local / VPS

```bash
cd server

# 1) Ưu tiên quán đang mở (khuyến nghị)
while IFS= read -r id; do
  [ -z "$id" ] && continue
  echo "===== CRAWL $id ====="
  node crawl_restaurant_menus.js --id="$id" --force --threads=1 --delay=2000
  sleep 2
done < ../docs/menu-gap/ids-open.txt

# 2) (Tuỳ chọn) toàn bộ gồm quán đóng
# while IFS= read -r id; do
#   node crawl_restaurant_menus.js --id="$id" --force --threads=1 --delay=2000
# done < ../docs/menu-gap/ids-all.txt

# Hoặc dùng script:
chmod +x ../docs/menu-gap/crawl-menu-gap.sh
../docs/menu-gap/crawl-menu-gap.sh open    # chỉ mở
../docs/menu-gap/crawl-menu-gap.sh all     # tất cả
```

Yêu cầu:
- Có Chrome/Chromium
- `server/.env` có `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (để sync lên cloud; bỏ `--skip-supabase`)
- Không chạy hàng loạt trên free Render (OOM)

Sau khi crawl xong, mở thử trên production:

`GET https://shipfee-eo5s.onrender.com/api/restaurants/<id>?lat=10.0345&lon=105.7876`

Kỳ vọng: `menuStatus=ready`, `menu.length > 0`, `source` chứa `supabase_menu` hoặc `disk_menu` / `memory_menu`.

## Danh sách ưu tiên — quán ĐANG MỞ (18)

| # | ID | Tên | TT | Issue | Menu# | Slug |
|---|----|-----|----|-------|-------|------|
| 1 | `r_ct_bep_nha_co_tien_an_uong_nguyen_viet_hong.sld8zr` | Bếp Nhà Cô Tiên - Ăn Uống - Nguyễn Việt Hồng | Mở | `empty_menu_body` | 0 | `bep-nha-co-tien-an-uong-nguyen-viet-hong.sld8zr` |
| 2 | `r_ct_%E9%95%BF%E9%B2%8D%E9%B1%BC_truong_bao_ngu_sup_bao_ngu_vi_ca_tam_bo_phan_dang_luu` | 长鲍鱼 Trường Bào Ngư - Súp Bào Ngư Vi Cá Tẩm Bổ - Phan Đăng Lưu | Mở | `missing_on_supabase` | 0 | `长鲍鱼-truong-bao-ngu-sup-bao-ngu-vi-ca-tam-bo-phan-dang-luu` |
| 3 | `r_ct_banh_bot_loc_co_be_huynh_cuong.yapvj8` | Bánh Bột Lộc Cô Bé - Huỳnh Cương | Mở | `template_menu` | 4 | `banh-bot-loc-co-be-huynh-cuong.yapvj8` |
| 4 | `r_ct_bun_xao_cha_gio_68_bun_xao_thuc_an.odpoth` | Bún Xào Chả Giò 68 - Bún Xào & Thức Ăn | Mở | `template_menu` | 5 | `bun-xao-cha-gio-68-bun-xao-thuc-an.odpoth` |
| 5 | `r_ct_bo_s_yogurt_sua_chua_chung_cu_nam_long_2.sfzjpc` | Bơ's Yogurt - Sữa Chua - Chung Cư Nam Long 2 | Mở | `template_menu` | 4 | `bo-s-yogurt-sua-chua-chung-cu-nam-long-2.sfzjpc` |
| 6 | `r_ct_bep_anh_bey_banh_tam_chay_nguyen_trai.fudihk` | Bếp Anh Bẻy - Bánh Tằm Chay - Nguyễn Trãi | Mở | `template_menu` | 4 | `bep-anh-bey-banh-tam-chay-nguyen-trai.fudihk` |
| 7 | `r_ct_bep_ma_hong_banh_tam_bi_xiu_mai_banh_hoi_thit_kim_tien_com_suon_bun_kim_tien_goi_cuon_67_3_15_nguyen_thong.fgx6au` | Bếp Má Hồng - Bánh Tằm Bì Xíu Mại, Bánh Hỏi Thịt Kim Tiền & Cơm Sườn - Nguyễn Thông | Mở | `template_menu` | 5 | `bep-ma-hong-banh-tam-bi-xiu-mai-banh-hoi-thit-kim-tien-com-suon-bun-kim-tien-goi-cuon-67-3-15-nguyen-thong.fgx6au` |
| 8 | `r_ct_com_me_nau_com_tam_suon_muoi_xa_ot_nuong_phan_dang_luu.gidw0s` | Cơm Mẹ Nấu - Cơm Tấm Sườn Muối Xã Ớt Nướng - Phan Đăng Lưu | Mở | `template_menu` | 5 | `com-me-nau-com-tam-suon-muoi-xa-ot-nuong-phan-dang-luu.gidw0s` |
| 9 | `r_ct_com_tam_cay_sung_cu_com_ga_ta_phan_dinh_phung.p70zdc` | Cơm Tấm Cây Sung ( Cũ ) - Cơm Gà Ta - Phan Đình Phùng | Mở | `template_menu` | 5 | `com-tam-cay-sung-cu-com-ga-ta-phan-dinh-phung.p70zdc` |
| 10 | `r_ct_ga_u_muoi_thai_shipper_ga_u_muoi_nguyen_thi_minh_khai.mfrr9q` | Gà Ủ Muối Thái Shipper - Nguyễn Thị Minh Khai | Mở | `template_menu` | 4 | `ga-u-muoi-thai-shipper-ga-u-muoi-nguyen-thi-minh-khai.mfrr9q` |
| 11 | `r_ct_phuoc_com_suon_huynh_cuong.glabqc` | Phước - Cơm Sườn - Huỳnh Cương | Mở | `template_menu` | 5 | `phuoc-com-suon-huynh-cuong.glabqc` |
| 12 | `r_ct_quan_banh_beo_chung_cu_banh_beo_truong_dinh.opfacs` | Quán Bánh Bèo Chung Cư - Bánh Bèo - Trương Định | Mở | `template_menu` | 4 | `quan-banh-beo-chung-cu-banh-beo-truong-dinh.opfacs` |
| 13 | `r_ct_tiem_nha_chidi_sua_tuoi_thot_not_rim_duong_16.mzbjni` | TIỆM NHÀ CHIDI - Sữa Tươi Thốt Nốt Rim - Đường 16 | Mở | `template_menu` | 4 | `tiem-nha-chidi-sua-tuoi-thot-not-rim-duong-16.mzbjni` |
| 14 | `r_ct_tiem_nha_ann_tra_sua_nguyen_van_cu.s2vavg` | Tiệm Nhà Ann - Trà Sữa - Nguyễn Văn Cừ | Mở | `template_menu` | 5 | `tiem-nha-ann-tra-sua-nguyen-van-cu.s2vavg` |
| 15 | `r_ct_tram_dung_chan_ut_duong_bun_bo_com_suon_com_ga_ba_lang_cai_rang_can_tho.xfzuep` | Trạm Dừng Chân Út Dương - Bún Bò, Cơm Sườn & Cơm Gà - QL1A | Mở | `template_menu` | 5 | `tram-dung-chan-ut-duong-bun-bo-com-suon-com-ga-ba-lang-cai-rang-can-tho.xfzuep` |
| 16 | `r_ct_xuxu_milk_tea_tra_sua_30_thang_4.vuvucb` | Xuxu Milk & Tea - Trà Sữa - 30 Tháng 4 | Mở | `template_menu` | 5 | `xuxu-milk-tea-tra-sua-30-thang-4.vuvucb` |
| 17 | `r_ct_i_vi_banh_trang_tron_25_tran_viet_chau.7nlpnj` | Ì Ví - Bánh Tráng Trộn - 25 Trần Việt Châu | Mở | `template_menu` | 5 | `i-vi-banh-trang-tron-25-tran-viet-chau.7nlpnj` |
| 18 | `r_ct_ech_nuong_campuchia_an_vat_3_2.szpprr` | Ếch Nướng Campuchia - Ăn Vặt - 3/2 | Mở | `template_menu` | 5 | `ech-nuong-campuchia-an-vat-3-2.szpprr` |

## Quán ĐANG ĐÓNG (33) — crawl sau nếu cần

| # | ID | Tên | TT | Issue | Menu# | Slug |
|---|----|-----|----|-------|-------|------|
| 1 | `r_ct_ang_pizza_va_tra_sua_28_tran_chien.zpwimb` | ANG - Pizza Và Trà Sữa - Trần Chiên | Đóng | `template_menu` | 5 | `ang-pizza-va-tra-sua-28-tran-chien.zpwimb` |
| 2 | `r_ct_an_coffee_and_tea_hem_2_nguyen_viet_hong.rj7ua9` | An - Coffee & Tea - Lý Tự Trọng | Đóng | `template_menu` | 5 | `an-coffee-and-tea-hem-2-nguyen-viet-hong.rj7ua9` |
| 3 | `r_ct_butino_coffee_sinh_to_tra_sua_nuoc_ep_27_huynh_cuong.efjgv7` | Butino Coffee - Sinh Tố, Trà Sữa & Nước Ép - 27 Huỳnh Cương | Đóng | `template_menu` | 5 | `butino-coffee-sinh-to-tra-sua-nuoc-ep-27-huynh-cuong.efjgv7` |
| 4 | `r_ct_bun_real_132_bun_rieu_cua_bun_thit_xao_132_26g_hem_132_duong_3_2_hung_loi_ninh_kieu_tpct.oghhlj` | Bún Real 132 - Bún Riêu Cua, Bún Thịt Xào - Đường 3/2 | Đóng | `template_menu` | 5 | `bun-real-132-bun-rieu-cua-bun-thit-xao-132-26g-hem-132-duong-3-2-hung-loi-ninh-kieu-tpct.oghhlj` |
| 5 | `r_ct_bun_dau_mam_tom_a_lu_bun_dau_mam_tom_tran_nam_phu.hs8oz1` | Bún Đậu Mắm Tôm A Lử - Bún Đậu Mắm Tôm - Trần Nam Phú | Đóng | `template_menu` | 5 | `bun-dau-mam-tom-a-lu-bun-dau-mam-tom-tran-nam-phu.hs8oz1` |
| 6 | `r_ct_bep_me_dau_com_ga_nuong_cay_nguyen_van_cu_noi_dai.nbr9jt` | Bếp Mẹ Dâu - Cơm Gà Nướng Cay - Nguyễn Văn Cừ | Đóng | `template_menu` | 5 | `bep-me-dau-com-ga-nuong-cay-nguyen-van-cu-noi-dai.nbr9jt` |
| 7 | `r_ct_cota_mi_y_nui_xo_viet_nghe_tinh.nf8xn1` | COTA - Mì Ý & Nui - Xô Viết Nghệ Tĩnh | Đóng | `template_menu` | 5 | `cota-mi-y-nui-xo-viet-nghe-tinh.nf8xn1` |
| 8 | `r_ct_chao_family_banh_my_hambuger_ong_tay_thuc_an_mang_di_to_hien_thanh.jl5tuq` | Cháo Family Bánh Mỳ Hambuger Ông Tây - Thức Ăn Mang Đi - Tô Hiến Thành | Đóng | `template_menu` | 5 | `chao-family-banh-my-hambuger-ong-tay-thuc-an-mang-di-to-hien-thanh.jl5tuq` |
| 9 | `r_ct_ca_phe_hat_pha_may_an_phat_coffee_ca_phe_pha_may_tran_nam_phu.pszh7i` | Cà Phê Hạt Pha Máy An Phát Coffee - Cà Phê Pha Máy - Trần Nam Phú | Đóng | `template_menu` | 5 | `ca-phe-hat-pha-may-an-phat-coffee-ca-phe-pha-may-tran-nam-phu.pszh7i` |
| 10 | `r_ct_ca_ri_cha_banh_mi_crc_nguyen_van_cu_noi_dai.8tfw7w` | Cà Ri Chà - Bánh Mì CRC - Nguyễn Văn Cừ Nối Dài | Đóng | `template_menu` | 5 | `ca-ri-cha-banh-mi-crc-nguyen-van-cu-noi-dai.8tfw7w` |
| 11 | `r_ct_co_buoi_nuoc_ep_sinh_to_trai_cay_nguyen_van_linh.ii8a28` | Cô Bưởi - Nước Ép & Sinh Tố Trái Cây - Nguyễn Văn Linh | Đóng | `template_menu` | 5 | `co-buoi-nuoc-ep-sinh-to-trai-cay-nguyen-van-linh.ii8a28` |
| 12 | `r_ct_com_ngon_quan_com_ba_thang_hai.rwhhzi` | Cơm Ngon Quán - Cơm - Ba Tháng Hai | Đóng | `template_menu` | 5 | `com-ngon-quan-com-ba-thang-hai.rwhhzi` |
| 13 | `r_ct_com_tam_thanh_thu_com_tam_suon_bi_cha_tinh_lo_925.idzzap` | Cơm Tấm Thanh Thư - Cơm Tấm Sườn Bì Chả - Tỉnh Lộ 925 | Đóng | `template_menu` | 5 | `com-tam-thanh-thu-com-tam-suon-bi-cha-tinh-lo-925.idzzap` |
| 14 | `r_ct_de_feau_cakes_drinks_mac_thien_tich.0fp0xk` | De Féau - Cakes & Drinks - Mạc Thiên Tích | Đóng | `template_menu` | 4 | `de-feau-cakes-drinks-mac-thien-tich.0fp0xk` |
| 15 | `r_ct_destiny_fruits_395_nguyen_van_cu_noi_dai.l5dszp` | Destiny - Fruits - 395 Nguyễn Văn Cừ Nối Dài | Đóng | `template_menu` | 4 | `destiny-fruits-395-nguyen-van-cu-noi-dai.l5dszp` |
| 16 | `r_ct_h_p_tea_milk_tea_coffee_74_76_hai_ba_trung.5x5vw3` | H&P Tea - Milk Tea & Coffee - 74/76 Hai Bà Trưng | Đóng | `template_menu` | 5 | `h-p-tea-milk-tea-coffee-74-76-hai-ba-trung.5x5vw3` |
| 17 | `r_ct_hoang_du_chao_thap_cam_nguyen_van_cu.hybpo3` | Hoàng Du - Cháo Thập Cẩm - Nguyễn Văn Cừ | Đóng | `template_menu` | 4 | `hoang-du-chao-thap-cam-nguyen-van-cu.hybpo3` |
| 18 | `r_ct_khoai_lac_banh_trang_tron_30_4.zm4sdh` | Khoai Lắc Và Bánh Tráng Trộn - Đường 30/4 | Đóng | `template_menu` | 5 | `khoai-lac-banh-trang-tron-30-4.zm4sdh` |
| 19 | `r_ct_kifa_garden_coffee_ca_phe_diem_tam_com_van_phong_nguyen_minh_quang.yzkham` | Kifa Garden Coffee - Điểm Tâm & Cơm Văn Phòng - Nguyễn Minh Quang | Đóng | `template_menu` | 5 | `kifa-garden-coffee-ca-phe-diem-tam-com-van-phong-nguyen-minh-quang.yzkham` |
| 20 | `r_ct_lani_tra_sua_138_tran_hung_dao.txg8br` | Lani - Trà Sữa - 138 Trần Hưng Đạo | Đóng | `template_menu` | 5 | `lani-tra-sua-138-tran-hung-dao.txg8br` |
| 21 | `r_ct_nha_bo_tau_hu_singapore_nguyen_van_linh.wsktkx` | Nhà Bơ - Tàu Hủ Singapore - Nguyễn Văn Linh | Đóng | `template_menu` | 4 | `nha-bo-tau-hu-singapore-nguyen-van-linh.wsktkx` |
| 22 | `r_ct_nhat_anh_coffee_house_ca_phe_tra_cookie_khu_dan_cu_an_khanh.xuhx5k` | Nhất Anh Coffee House - Cà Phê, Trà & Cookie - Khu Dân Cư An Khánh | Đóng | `template_menu` | 5 | `nhat-anh-coffee-house-ca-phe-tra-cookie-khu-dan-cu-an-khanh.xuhx5k` |
| 23 | `r_ct_no_7_tea_bread_tran_binh_trong.8kifat` | No.7 - Tea & Bread - Trần Bình Trọng | Đóng | `template_menu` | 4 | `no-7-tea-bread-tran-binh-trong.8kifat` |
| 24 | `r_ct_phinh_an_vat_milo_dam.rwlndt` | Phính - Ăn Vặt & Milo Dầm | Đóng | `template_menu` | 5 | `phinh-an-vat-milo-dam.rwlndt` |
| 25 | `r_ct_quan_bun_72_bun_rieu_cua_nguyen_van_cu_noi_dai.yc5f8j` | Quán Bún 72 - Bún Riêu Cua - Nguyễn Văn Cừ Nối Dài | Đóng | `template_menu` | 5 | `quan-bun-72-bun-rieu-cua-nguyen-van-cu-noi-dai.yc5f8j` |
| 26 | `r_ct_shooga_base_cafe_bar_phan_chu_trinh.tnizlt` | Shooga Base - Cafe & Bar - Phan Chu Trinh | Đóng | `template_menu` | 4 | `shooga-base-cafe-bar-phan-chu-trinh.tnizlt` |
| 27 | `r_ct_so_lo_milktea_tran_chien.oejges` | So Lô - MilkTea - Trần Chiên | Đóng | `template_menu` | 4 | `so-lo-milktea-tran-chien.oejges` |
| 28 | `r_ct_sua_bap_doka_132_nguyen_van_cu.we7jbu` | SỮA BẮP DOKA - 132 Nguyễn Văn Cừ | Đóng | `template_menu` | 4 | `sua-bap-doka-132-nguyen-van-cu.we7jbu` |
| 29 | `r_ct_tiem_nha_mon_an_vat_va_coffee_nguyen_van_linh.az7tho` | Tiệm Nhà Mon - Ăn Vặt Và Coffee - Nguyễn Văn Linh | Đóng | `template_menu` | 5 | `tiem-nha-mon-an-vat-va-coffee-nguyen-van-linh.az7tho` |
| 30 | `r_ct_wabisabi_cakes_and_drinks_banh_mi_banh_bong_lan_trung_muoi_nguyen_minh_quang.rf12pq` | WabiSabi Cakes And Drinks - Bánh Mì & Bánh Bông Lan Trứng Muối - Nguyễn Minh Quang | Đóng | `template_menu` | 5 | `wabisabi-cakes-and-drinks-banh-mi-banh-bong-lan-trung-muoi-nguyen-minh-quang.rf12pq` |
| 31 | `r_ct_xua_nice_an_vat_tran_quang_dieu.jjgjtd` | Xưa Nice - Ăn Vặt - Trần Quang Diệu | Đóng | `template_menu` | 5 | `xua-nice-an-vat-tran-quang-dieu.jjgjtd` |
| 32 | `r_ct_ut_xinh_che_kem_dac_san_nguyen_van_cu.2f5r8p` | ÚT XINH - Chè Kem Đặc Sản - Nguyễn Văn Cừ | Đóng | `template_menu` | 5 | `ut-xinh-che-kem-dac-san-nguyen-van-cu.2f5r8p` |
| 33 | `r_ct_doi_doi_do_an_nhanh_hem_390_nguyen_van_cu.lvi4en` | Đói Đói - Đồ Ăn Nhanh - Hẻm 390 Nguyễn Văn Cừ | Đóng | `template_menu` | 4 | `doi-doi-do-an-nhanh-hem-390-nguyen-van-cu.lvi4en` |

## Ghi chú kỹ thuật

1. Catalog local (`restaurants-chunks`) có thể gắn `hasRealMenu=true` + `dishNames` dù body menu chưa lên Supabase.
2. Render không scrape mặc định; detail hydrate từ Supabase. Template Unsplash bị `analyzeMenuQuality` bỏ → UI “Chưa có thực đơn”.
3. Làm Hơi (224 Đường 3/2) **đã crawl & upsert** — không còn trong list này.
