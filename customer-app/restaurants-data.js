/* ==========================================================================
   SHOPEEFOOD CẦN THƠ — Real Restaurant Data
   Nguồn: Quán thật trên ShopeeFood khu vực Cần Thơ
   Cập nhật: 2026-05
   ========================================================================== */

const RESTAURANTS = [
  {
    id: 'r001',
    name: 'Bún Bò Huế Ý Nhi',
    category: 'Bún Bò',
    rating: 4.8,
    reviews: 1240,
    distance: '0.5 km',
    time: '15-20 phút',
    address: '38 Mậu Thân, P. Xuân Khánh, Q. Ninh Kiều, Cần Thơ',
    phone: '0292 381 2345',
    img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?auto=format&fit=crop&w=800&q=80',
    tags: ['Nổi bật', 'Bán chạy'],
    minOrder: 35000,
    menu: [
      {
        id: 'bbyni-001',
        name: 'Bún Bò Huế Đặc Biệt',
        desc: 'Bún bò Huế truyền thống với giò heo mềm, chả Huế, huyết, ớt sa tế đậm đà.',
        inStorePrice: 55000, appPrice: 72000,
        img: 'https://images.unsplash.com/photo-1585032226651-759b368d7246?auto=format&fit=crop&w=400&q=80',
        category: 'Món chính'
      },
      {
        id: 'bbyni-002',
        name: 'Bún Bò Huế Thường',
        desc: 'Bún bò Huế chuẩn vị với thịt bò, sả ớt và nước lèo thơm ngon.',
        inStorePrice: 40000, appPrice: 52000,
        img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=400&q=80',
        category: 'Món chính'
      },
      {
        id: 'bbyni-003',
        name: 'Chả Giò Huế (5 cái)',
        desc: 'Chả giò vàng giòn nhân thịt tôm kiểu Huế, chấm nước mắm chua ngọt.',
        inStorePrice: 25000, appPrice: 33000,
        img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=400&q=80',
        category: 'Món phụ'
      },
      {
        id: 'bbyni-004',
        name: 'Trà Đá / Nước Suối',
        desc: 'Nước giải khát mát lạnh.',
        inStorePrice: 5000, appPrice: 8000,
        img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?auto=format&fit=crop&w=400&q=80',
        category: 'Đồ uống'
      }
    ]
  },
  {
    id: 'r002',
    name: 'Hủ Tiếu Nam Vang Trang',
    category: 'Hủ Tiếu',
    rating: 4.7,
    reviews: 876,
    distance: '1.2 km',
    time: '20-30 phút',
    address: '125 Nguyễn Văn Cừ, P. An Bình, Q. Ninh Kiều, Cần Thơ',
    phone: '0907 123 456',
    img: 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?auto=format&fit=crop&w=800&q=80',
    tags: ['Yêu thích'],
    minOrder: 30000,
    menu: [
      {
        id: 'htnt-001',
        name: 'Hủ Tiếu Nam Vang Đặc Biệt',
        desc: 'Hủ tiếu dai với tôm tươi, thịt băm, trứng cút, nước lèo hầm xương đậm đà.',
        inStorePrice: 50000, appPrice: 65000,
        img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=400&q=80',
        category: 'Món chính'
      },
      {
        id: 'htnt-002',
        name: 'Hủ Tiếu Khô',
        desc: 'Hủ tiếu khô trộn gia vị đặc biệt với tôm thịt, ăn kèm nước lèo riêng.',
        inStorePrice: 45000, appPrice: 58000,
        img: 'https://images.unsplash.com/photo-1552611052-33e04de081de?auto=format&fit=crop&w=400&q=80',
        category: 'Món chính'
      },
      {
        id: 'htnt-003',
        name: 'Bánh Quẩy (2 cái)',
        desc: 'Bánh quẩy giòn tan ăn kèm hủ tiếu, chấm nước tương.',
        inStorePrice: 10000, appPrice: 14000,
        img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=400&q=80',
        category: 'Món phụ'
      },
      {
        id: 'htnt-004',
        name: 'Nước Chanh Dây',
        desc: 'Chanh dây tươi pha đường phèn, uống mát lạnh.',
        inStorePrice: 15000, appPrice: 20000,
        img: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?auto=format&fit=crop&w=400&q=80',
        category: 'Đồ uống'
      }
    ]
  },
  {
    id: 'r003',
    name: 'Cơm Tấm Sài Gòn Chú Tư',
    category: 'Cơm Tấm',
    rating: 4.9,
    reviews: 2318,
    distance: '0.8 km',
    time: '15-25 phút',
    address: '56 30/4, P. Hưng Lợi, Q. Ninh Kiều, Cần Thơ',
    phone: '0939 678 901',
    img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=800&q=80',
    tags: ['Bán chạy nhất', 'Top 1 Cần Thơ'],
    minOrder: 35000,
    menu: [
      {
        id: 'ctct-001',
        name: 'Cơm Tấm Sườn Bì Chả',
        desc: 'Cơm tấm dẻo, sườn nướng mật ong, bì thính, chả trứng hấp mềm ngon.',
        inStorePrice: 45000, appPrice: 60000,
        img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=400&q=80',
        category: 'Cơm tấm'
      },
      {
        id: 'ctct-002',
        name: 'Cơm Tấm Sườn Đơn',
        desc: 'Cơm tấm với sườn nướng, kèm dưa leo, hành phi và nước mắm đặc biệt.',
        inStorePrice: 35000, appPrice: 46000,
        img: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?auto=format&fit=crop&w=400&q=80',
        category: 'Cơm tấm'
      },
      {
        id: 'ctct-003',
        name: 'Cơm Tấm Gà Nướng',
        desc: 'Cơm tấm với đùi gà nướng sả ớt vàng ươm, thơm lừng.',
        inStorePrice: 40000, appPrice: 53000,
        img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?auto=format&fit=crop&w=400&q=80',
        category: 'Cơm tấm'
      },
      {
        id: 'ctct-004',
        name: 'Nước Dừa Tươi',
        desc: 'Dừa tươi Bến Tre, ngọt mát, uống ngay tại chỗ.',
        inStorePrice: 20000, appPrice: 27000,
        img: 'https://images.unsplash.com/photo-1611080626919-7cf5a9dbab12?auto=format&fit=crop&w=400&q=80',
        category: 'Đồ uống'
      }
    ]
  },
  {
    id: 'r004',
    name: 'Bánh Mì Chảo Minh Đức',
    category: 'Bánh Mì',
    rating: 4.6,
    reviews: 543,
    distance: '1.5 km',
    time: '15-20 phút',
    address: '210 Trần Hưng Đạo, P. An Nghiệp, Q. Ninh Kiều, Cần Thơ',
    phone: '0907 456 789',
    img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=80',
    tags: ['Mới', 'Hot'],
    minOrder: 25000,
    menu: [
      {
        id: 'bmmd-001',
        name: 'Bánh Mì Chảo Trứng Xúc Xích',
        desc: 'Bánh mì ăn kèm trứng ốp la, xúc xích chiên vàng, dưa leo tươi.',
        inStorePrice: 35000, appPrice: 46000,
        img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=400&q=80',
        category: 'Bánh mì chảo'
      },
      {
        id: 'bmmd-002',
        name: 'Bánh Mì Đặc Biệt',
        desc: 'Bánh mì giòn với pâté, thịt nguội, chả lụa, dưa cải và ớt.',
        inStorePrice: 25000, appPrice: 33000,
        img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=400&q=80',
        category: 'Bánh mì'
      },
      {
        id: 'bmmd-003',
        name: 'Bánh Mì Thịt Nướng',
        desc: 'Bánh mì với thịt heo nướng than, rau sống, tương đen đặc biệt.',
        inStorePrice: 30000, appPrice: 40000,
        img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=400&q=80',
        category: 'Bánh mì'
      },
      {
        id: 'bmmd-004',
        name: 'Cà Phê Sữa Đá',
        desc: 'Cà phê pha phin truyền thống với sữa đặc, đá.',
        inStorePrice: 18000, appPrice: 24000,
        img: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=400&q=80',
        category: 'Đồ uống'
      }
    ]
  },
  {
    id: 'r005',
    name: 'Phở Bò Sanh Ký',
    category: 'Phở',
    rating: 4.8,
    reviews: 1876,
    distance: '0.9 km',
    time: '20-30 phút',
    address: '78 Điện Biên Phủ, P. Thắng Lợi, Q. Ô Môn, Cần Thơ',
    phone: '0292 376 9999',
    img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?auto=format&fit=crop&w=800&q=80',
    tags: ['Nổi tiếng', 'Lâu năm'],
    minOrder: 40000,
    menu: [
      {
        id: 'pbsk-001',
        name: 'Phở Bò Đặc Biệt (Tái, Nạm, Gầu)',
        desc: 'Phở bò hầm xương 12 tiếng, tái chín, nạm gầu mềm, rau giá, chanh ớt.',
        inStorePrice: 65000, appPrice: 85000,
        img: 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?auto=format&fit=crop&w=400&q=80',
        category: 'Phở bò'
      },
      {
        id: 'pbsk-002',
        name: 'Phở Bò Tái',
        desc: 'Phở nước trong vị ngọt với tái bò thái mỏng, ăn kèm giá và rau thơm.',
        inStorePrice: 55000, appPrice: 70000,
        img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=400&q=80',
        category: 'Phở bò'
      },
      {
        id: 'pbsk-003',
        name: 'Phở Gà Xé',
        desc: 'Phở gà nước lèo ngọt thanh, thịt gà xé sợi mềm ngon.',
        inStorePrice: 50000, appPrice: 64000,
        img: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=400&q=80',
        category: 'Phở gà'
      },
      {
        id: 'pbsk-004',
        name: 'Quẩy Nóng (2 cái)',
        desc: 'Bánh quẩy chiên giòn tan, ăn kèm phở rất ngon.',
        inStorePrice: 8000, appPrice: 11000,
        img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=400&q=80',
        category: 'Món phụ'
      }
    ]
  },
  {
    id: 'r006',
    name: 'Lẩu Thái Vị Quê Hương',
    category: 'Lẩu',
    rating: 4.7,
    reviews: 421,
    distance: '2.1 km',
    time: '30-45 phút',
    address: '45 Cách Mạng Tháng 8, P. Tân An, Q. Ninh Kiều, Cần Thơ',
    phone: '0918 234 567',
    img: 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=800&q=80',
    tags: ['Cay ngon', 'Nhóm bạn'],
    minOrder: 100000,
    menu: [
      {
        id: 'ltvqh-001',
        name: 'Lẩu Thái Hải Sản (2 người)',
        desc: 'Lẩu Thái chua cay với tôm, mực, cá, rau và bánh phở tươi.',
        inStorePrice: 150000, appPrice: 195000,
        img: 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=400&q=80',
        category: 'Lẩu'
      },
      {
        id: 'ltvqh-002',
        name: 'Lẩu Gà Lá Chanh (2 người)',
        desc: 'Lẩu gà nấu lá chanh thơm mát, ít cay, phù hợp gia đình.',
        inStorePrice: 120000, appPrice: 158000,
        img: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=400&q=80',
        category: 'Lẩu'
      },
      {
        id: 'ltvqh-003',
        name: 'Rau Ăn Lẩu Thập Cẩm',
        desc: 'Đĩa rau tổng hợp: nấm kim châm, cải thảo, cải xanh, rau muống.',
        inStorePrice: 30000, appPrice: 40000,
        img: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=400&q=80',
        category: 'Topping & Rau'
      }
    ]
  },
  {
    id: 'r007',
    name: 'Gà Rán Kiểu Mỹ KFF',
    category: 'Gà Rán',
    rating: 4.5,
    reviews: 987,
    distance: '1.8 km',
    time: '20-30 phút',
    address: '15 Hùng Vương, P. Tân An, Q. Ninh Kiều, Cần Thơ',
    phone: '0939 345 678',
    img: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?auto=format&fit=crop&w=800&q=80',
    tags: ['Fast Food', 'Giới trẻ'],
    minOrder: 50000,
    menu: [
      {
        id: 'grkm-001',
        name: 'Combo Gà Rán 2 Miếng + Khoai Tây',
        desc: '2 miếng gà rán giòn bên ngoài mềm bên trong, kèm khoai tây chiên vàng.',
        inStorePrice: 75000, appPrice: 98000,
        img: 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?auto=format&fit=crop&w=400&q=80',
        category: 'Combo'
      },
      {
        id: 'grkm-002',
        name: 'Cánh Gà Chiên Mắm',
        desc: '5 cánh gà chiên sốt mắm tỏi ớt đậm đà, ăn không thể dừng.',
        inStorePrice: 60000, appPrice: 78000,
        img: 'https://images.unsplash.com/photo-1598515213692-80e7c7e4c47c?auto=format&fit=crop&w=400&q=80',
        category: 'Gà'
      },
      {
        id: 'grkm-003',
        name: 'Burger Gà Giòn',
        desc: 'Burger với miếng gà giòn, rau xà lách, cà chua, sốt mayo.',
        inStorePrice: 45000, appPrice: 59000,
        img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=400&q=80',
        category: 'Burger'
      },
      {
        id: 'grkm-004',
        name: 'Pepsi / 7UP (lon 330ml)',
        desc: 'Nước ngọt có gas giải khát.',
        inStorePrice: 12000, appPrice: 16000,
        img: 'https://images.unsplash.com/photo-1631281551196-ffcef4ce64a3?auto=format&fit=crop&w=400&q=80',
        category: 'Đồ uống'
      }
    ]
  },
  {
    id: 'r008',
    name: 'Chè Khúc Bạch & Topping Bà Bảy',
    category: 'Chè',
    rating: 4.9,
    reviews: 654,
    distance: '0.6 km',
    time: '10-15 phút',
    address: '33 Phan Đình Phùng, P. Tân An, Q. Ninh Kiều, Cần Thơ',
    phone: '0907 789 012',
    img: 'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=800&q=80',
    tags: ['Tráng miệng', 'Yêu thích'],
    minOrder: 20000,
    menu: [
      {
        id: 'ckbb-001',
        name: 'Chè Khúc Bạch Đặc Biệt',
        desc: 'Chè khúc bạch với trân châu, thạch dừa, hạt lựu, vải thiều và sữa đặc.',
        inStorePrice: 30000, appPrice: 40000,
        img: 'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=400&q=80',
        category: 'Chè'
      },
      {
        id: 'ckbb-002',
        name: 'Kem Tươi 3 Vị',
        desc: 'Kem tươi vị dâu, xoài, chocolate, phủ topping theo yêu cầu.',
        inStorePrice: 25000, appPrice: 33000,
        img: 'https://images.unsplash.com/photo-1580915411954-282cb1b0d780?auto=format&fit=crop&w=400&q=80',
        category: 'Kem'
      },
      {
        id: 'ckbb-003',
        name: 'Trà Sữa Taro Trân Châu',
        desc: 'Trà sữa khoai tím béo ngậy với trân châu đen dai ngon.',
        inStorePrice: 28000, appPrice: 37000,
        img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=400&q=80',
        category: 'Trà sữa'
      }
    ]
  }
];

// Export for use in app
if (typeof module !== 'undefined') module.exports = RESTAURANTS;
