"""Apply ShipFee brand icon + ShipFee wordmark across all apps."""
from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(r"d:\FOOD DELIVERY")
SOURCE = Path(
    r"C:\Users\Hieu Huynh\.cursor\projects\d-FOOD-DELIVERY\assets"
    r"\c__Users_Hieu_Huynh_AppData_Roaming_Cursor_User_workspaceStorage"
    r"_b61e857126ac264b75628cfa0f0c3700_images_image-b5de90ab-cf7a-4d0f-acb0-0a00f1fd1bd2.png"
)
BRAND_DIR = ROOT / "assets" / "brand"
APPS = ["customer-app", "shipper-app", "admin-app"]
PNG_SIZES = {
    "favicon-32.png": 32,
    "icon-48.png": 48,
    "icon-72.png": 72,
    "icon-96.png": 96,
    "icon-144.png": 144,
    "icon-152.png": 152,
    "icon-167.png": 167,
    "icon-180.png": 180,
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-256.png": 256,
    "icon-512.png": 512,
    "icon-512-maskable.png": 512,
}


def is_near_white(r: int, g: int, b: int, a: int = 255) -> bool:
    return a < 10 or (r > 245 and g > 245 and b > 245)


def content_bbox(img: Image.Image, pad: int = 0):
    pix = img.load()
    w, h = img.size
    minx, miny, maxx, maxy = w, h, 0, 0
    found = False
    for y in range(h):
        for x in range(w):
            r, g, b, a = pix[x, y]
            if not is_near_white(r, g, b, a):
                found = True
                minx = min(minx, x)
                maxx = max(maxx, x)
                miny = min(miny, y)
                maxy = max(maxy, y)
    if not found:
        return (0, 0, w, h)
    return (
        max(0, minx - pad),
        max(0, miny - pad),
        min(w, maxx + 1 + pad),
        min(h, maxy + 1 + pad),
    )


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def prepare_mark(src: Image.Image) -> Image.Image:
    img = src.convert("RGBA")
    box = content_bbox(img, pad=2)
    icon = img.crop(box)
    cw, ch = icon.size
    side = max(cw, ch)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(icon, ((side - cw) // 2, (side - ch) // 2))

    radius = int(side * 0.22)
    tile_mask = rounded_mask(side, radius)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(canvas, (0, 0))
    existing = out.split()[3]
    outside = Image.new("L", (side, side), 0)
    alpha = Image.composite(existing, outside, tile_mask)
    out.putalpha(alpha)
    return out.resize((1024, 1024), Image.Resampling.LANCZOS)


def png_to_svg(img: Image.Image, out_path: Path, label: str, view=None):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    vw, vh = view or img.size
    out_path.write_text(
        f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vw} {vh}" role="img" aria-label="{label}">
  <image href="data:image/png;base64,{b64}" width="{vw}" height="{vh}" preserveAspectRatio="xMidYMid meet"/>
</svg>
''',
        encoding="utf-8",
    )


def write_shipfee_full_svg(mark_embed: Image.Image, out_path: Path):
    """Horizontal lockup: mark + ShipFee wordmark."""
    buf = io.BytesIO()
    mark_embed.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    # viewBox: mark 64 + gap 12 + text ~180
    out_path.write_text(
        f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 72" role="img" aria-label="ShipFee">
  <defs>
    <linearGradient id="sfWord" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FB923C"/>
      <stop offset="55%" stop-color="#F97316"/>
      <stop offset="100%" stop-color="#EA580C"/>
    </linearGradient>
  </defs>
  <image href="data:image/png;base64,{b64}" x="0" y="4" width="64" height="64" preserveAspectRatio="xMidYMid meet"/>
  <text
    x="80"
    y="50"
    fill="url(#sfWord)"
    font-family="Geist, Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    font-size="42"
    font-weight="800"
    letter-spacing="-0.04em"
  >ShipFee</text>
</svg>
''',
        encoding="utf-8",
    )


def make_maskable(icon: Image.Image, size: int = 512) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (255, 107, 0, 255))
    inset = int(size * 0.80)
    scaled = icon.resize((inset, inset), Image.Resampling.LANCZOS)
    offset = (size - inset) // 2
    canvas.paste(scaled, (offset, offset), scaled)
    return canvas


def flatten_on_orange(icon: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (255, 107, 0, 255))
    scaled = icon.resize((size, size), Image.Resampling.LANCZOS)
    canvas.paste(scaled, (0, 0), scaled)
    return canvas.convert("RGB").convert("RGBA")


def main():
    BRAND_DIR.mkdir(parents=True, exist_ok=True)
    src = Image.open(SOURCE).convert("RGBA")
    mark = prepare_mark(src)
    mark.save(BRAND_DIR / "shipfee-mark-master.png")
    src.save(BRAND_DIR / "shipfee-icon-source.png")
    print("master:", mark.size)

    mark_embed = mark.resize((256, 256), Image.Resampling.LANCZOS)

    for app in APPS:
        icons_dir = ROOT / app / "icons"
        icons_dir.mkdir(parents=True, exist_ok=True)

        png_to_svg(mark_embed, icons_dir / "shipfee-mark.svg", "ShipFee", (256, 256))
        png_to_svg(mark_embed, icons_dir / "shipfee-logo.svg", "ShipFee", (256, 256))
        write_shipfee_full_svg(mark_embed.resize((128, 128), Image.Resampling.LANCZOS), icons_dir / "shipfee-logo-full.svg")

        for name, size in PNG_SIZES.items():
            if name == "icon-512-maskable.png":
                make_maskable(mark, 512).save(icons_dir / name)
            elif name in ("apple-touch-icon.png", "favicon-32.png"):
                flatten_on_orange(mark, size).save(icons_dir / name)
            else:
                mark.resize((size, size), Image.Resampling.LANCZOS).save(icons_dir / name)
            print(f"  {app}/{name}")

    print("OK")


if __name__ == "__main__":
    main()
