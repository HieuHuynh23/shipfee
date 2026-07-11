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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
