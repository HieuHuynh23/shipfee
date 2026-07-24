-- Bảng profiles shipper (liên kết với Supabase Auth users)
CREATE TABLE IF NOT EXISTS public.shipper_profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE', 'OFFLINE')),
  last_check_in TIMESTAMPTZ,
  last_check_out TIMESTAMPTZ,
  total_orders INTEGER DEFAULT 0,
  total_earnings NUMERIC DEFAULT 0,
  acceptance_rate NUMERIC DEFAULT 100,
  completion_rate NUMERIC DEFAULT 100,
  is_approved BOOLEAN DEFAULT true,
  assistance_requested BOOLEAN DEFAULT false,
  assistance_limit_today INTEGER DEFAULT 0,
  last_assistance_date TEXT,
  last_lat DOUBLE PRECISION,
  last_lon DOUBLE PRECISION,
  last_location_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration an toàn cho DB đã tạo trước đó (thiếu cột → lỗi sync SOS / CRM)
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT true;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS assistance_requested BOOLEAN DEFAULT false;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS assistance_limit_today INTEGER DEFAULT 0;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_assistance_date TEXT;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS cccd TEXT;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS email TEXT;

-- Bật Row Level Security
ALTER TABLE public.shipper_profiles ENABLE ROW LEVEL SECURITY;

-- Tạo Policies
CREATE POLICY "Cho phép đọc công khai thông tin shipper" 
  ON public.shipper_profiles 
  FOR SELECT 
  USING (true);

CREATE POLICY "Cho phép chính shipper cập nhật profile của mình" 
  ON public.shipper_profiles 
  FOR UPDATE 
  USING (auth.uid() = id);

CREATE POLICY "Cho phép dịch vụ service_role (Admin) thực hiện mọi quyền" 
  ON public.shipper_profiles 
  FOR ALL 
  USING (true) 
  WITH CHECK (true);
-- Bảng lưu trữ thông tin quán ăn và thực đơn chi tiết (dạng JSONB để tối ưu truy cập)
CREATE TABLE IF NOT EXISTS public.restaurants (
    id text PRIMARY KEY,
    name text NOT NULL,
    address text,
    lat double precision,
    lon double precision,
    rating double precision DEFAULT 4.5,
    image_url text,
    is_closed boolean DEFAULT false,
    closed_reason text,
    has_real_menu boolean DEFAULT false,
    dish_names text[],
    menu jsonb DEFAULT '[]'::jsonb,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now())
);

-- Bật Row Level Security (RLS)
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;

-- Tạo chính sách cho phép đọc công khai (Public Read)
CREATE POLICY "Allow public read access to restaurants" 
    ON public.restaurants 
    FOR SELECT 
    USING (true);

-- Tạo chính sách cho phép admin/service_role thực hiện mọi quyền
CREATE POLICY "Allow admin write access to restaurants" 
    ON public.restaurants 
    FOR ALL 
    USING (true)
    WITH CHECK (true);

-- Bảng lưu trữ thông báo biến động hệ thống (giá món, đóng cửa, mở lại)
CREATE TABLE IF NOT EXISTS public.system_notifications (
    id text PRIMARY KEY,
    type text NOT NULL,
    restaurant_id text,
    restaurant_name text,
    title text,
    message text,
    created_at bigint,
    read boolean DEFAULT false
);

-- Bật Row Level Security (RLS)
ALTER TABLE public.system_notifications ENABLE ROW LEVEL SECURITY;

-- Tạo chính sách cho phép đọc công khai (Public Read)
CREATE POLICY "Allow public read access to system_notifications" 
    ON public.system_notifications 
    FOR SELECT 
    USING (true);

-- Tạo chính sách cho phép admin/service_role thực hiện mọi quyền
CREATE POLICY "Allow admin write access to system_notifications" 
    ON public.system_notifications 
    FOR ALL 
    USING (true)
    WITH CHECK (true);


-- Orders: bảng tối thiểu — chạy thêm migrations/001_orders_sot_prep.sql để đủ cột runtime
CREATE TABLE IF NOT EXISTS public.orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  restaurant_name TEXT DEFAULT '',
  restaurant_address TEXT DEFAULT '',
  status TEXT DEFAULT 'PENDING',
  app_total NUMERIC DEFAULT 0,
  store_total NUMERIC DEFAULT 0,
  shipper_earning NUMERIC DEFAULT 0,
  shipper_id TEXT,
  shipper_name TEXT,
  shipper_phone TEXT,
  delivery_name TEXT DEFAULT '',
  delivery_phone TEXT DEFAULT '',
  delivery_address TEXT DEFAULT '',
  orderer_phone TEXT DEFAULT '',
  items JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  purchased_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT
);
