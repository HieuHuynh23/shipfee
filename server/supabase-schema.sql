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
