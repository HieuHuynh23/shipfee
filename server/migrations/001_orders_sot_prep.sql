-- =============================================================================
-- ShipFee — Prep Source-of-Truth (orders + shipper CCCD)
-- Chạy trong Supabase SQL Editor (service role / postgres). An toàn chạy lại.
-- =============================================================================

-- ── Orders (đủ field runtime: token, chat, dispatch, pin, rating…) ───────────
CREATE TABLE IF NOT EXISTS public.orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  restaurant_name TEXT DEFAULT '',
  restaurant_address TEXT DEFAULT '',
  restaurant_lat DOUBLE PRECISION,
  restaurant_lon DOUBLE PRECISION,
  restaurant_coords_exact BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'PENDING',
  app_total NUMERIC DEFAULT 0,
  store_total NUMERIC DEFAULT 0,
  shipper_earning NUMERIC DEFAULT 0,
  discount_value NUMERIC DEFAULT 0,
  min_service_fee NUMERIC DEFAULT 0,
  surcharge_per_item NUMERIC DEFAULT 0,
  promo_code TEXT,
  promo_discount NUMERIC DEFAULT 0,
  shipper_id TEXT,
  shipper_name TEXT,
  shipper_phone TEXT,
  assigned_shipper_phone TEXT,
  offer_expires_at BIGINT,
  declined_shippers JSONB DEFAULT '[]'::jsonb,
  delivery_name TEXT DEFAULT '',
  delivery_phone TEXT DEFAULT '',
  delivery_address TEXT DEFAULT '',
  orderer_phone TEXT DEFAULT '',
  pinned_lat DOUBLE PRECISION,
  pinned_lon DOUBLE PRECISION,
  is_relative BOOLEAN DEFAULT false,
  note TEXT DEFAULT '',
  items JSONB DEFAULT '[]'::jsonb,
  messages JSONB DEFAULT '[]'::jsonb,
  tracking_token TEXT,
  rating NUMERIC,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  purchased_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cột bổ sung nếu bảng orders đã tồn tại (production cũ)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS restaurant_lat DOUBLE PRECISION;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS restaurant_lon DOUBLE PRECISION;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS restaurant_coords_exact BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS min_service_fee NUMERIC DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS surcharge_per_item NUMERIC DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS promo_discount NUMERIC DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS assigned_shipper_phone TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS offer_expires_at BIGINT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS declined_shippers JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pinned_lat DOUBLE PRECISION;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pinned_lon DOUBLE PRECISION;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_relative BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS messages JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tracking_token TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS rating NUMERIC;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS orders_status_created_idx ON public.orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_shipper_phone_idx ON public.orders (shipper_phone);
CREATE INDEX IF NOT EXISTS orders_assigned_phone_idx ON public.orders (assigned_shipper_phone);
CREATE INDEX IF NOT EXISTS orders_tracking_token_idx ON public.orders (tracking_token);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'orders' AND policyname = 'orders_service_role_all'
  ) THEN
    CREATE POLICY orders_service_role_all ON public.orders
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── Shipper CCCD trên SoT (không chỉ local JSON / Auth metadata) ─────────────
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS cccd TEXT;
ALTER TABLE public.shipper_profiles ADD COLUMN IF NOT EXISTS email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS shipper_profiles_cccd_unique
  ON public.shipper_profiles (cccd)
  WHERE cccd IS NOT NULL AND length(trim(cccd)) > 0;

-- ── Restaurants: cột hỗ trợ boot catalog (không bắt buộc menu trong list) ───
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS coords_source TEXT;
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS foody_slug TEXT;
