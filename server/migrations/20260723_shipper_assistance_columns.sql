-- Fix: cột SOS / GPS thiếu trên shipper_profiles → lỗi sync Supabase khi hỗ trợ tìm đơn
-- Chạy trên Supabase SQL Editor (production) nếu chưa có các cột này.

ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT true;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS assistance_requested BOOLEAN DEFAULT false;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS assistance_limit_today INTEGER DEFAULT 0;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_assistance_date TEXT;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;
