#!/usr/bin/env python3
"""Android başlatıcı ikonları ve Android TV banner'ı üretir (Pillow gerekir):
   python3 build/make_android_icons.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
SRC = Image.open(os.path.join(ROOT, "build", "icon.png")).convert("RGBA")

# macOS ikonu 1024 tuvalin içinde 824px'lik yuvarlak kare; Android için kenar boşluğunu kırp
CROP = SRC.crop((100, 100, 924, 924))

DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def save(img, folder, name):
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    img.save(os.path.join(d, name), optimize=True)


# Eski tip (API < 26) ikonlar: 48dp
for k, f in DENS.items():
    s = int(48 * f)
    icon = CROP.resize((int(s * 0.92), int(s * 0.92)), Image.LANCZOS)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(icon, ((s - icon.width) // 2, (s - icon.height) // 2), icon)
    save(canvas, f"mipmap-{k}", "ic_launcher.png")
    save(canvas, f"mipmap-{k}", "ic_launcher_round.png")

# Uyarlanabilir ikon (API 26+): 108dp tuval, ön plan V harfi güvenli alan (66dp) içinde
for k, f in DENS.items():
    s = int(108 * f)
    # arka plan: ikonun koyu mor dokusu tüm alana yayılsın
    bg = Image.new("RGB", (s, s))
    bp = bg.load()
    for y in range(s):
        for x in range(s):
            t = y / s
            g = math.exp(-(((x - s / 2) / (s * 0.36)) ** 2 + ((y - s * 0.53) / (s * 0.36)) ** 2)) * 0.55
            c = [46 + (10 - 46) * t, 24 + (7 - 24) * t, 84 + (20 - 84) * t]
            c = [c[0] + (88 - c[0]) * g, c[1] + (40 - c[1]) * g, c[2] + (170 - c[2]) * g]
            bp[x, y] = tuple(int(v) for v in c)
    save(bg, f"mipmap-{k}", "ic_launcher_background.png")
    # ön plan: yalnızca parlak "V" (arka plandan ayrıştır)
    px = CROP.load()
    fg = Image.new("RGBA", CROP.size, (0, 0, 0, 0))
    fp = fg.load()
    for y in range(CROP.height):
        for x in range(CROP.width):
            r, g, b, a = px[x, y]
            lum = (r + g + b) / 3
            if lum > 120 and a > 0:
                fp[x, y] = (r, g, b, int(min(255, (lum - 120) * 2.2)))
    fg = fg.resize((int(s * 0.80), int(s * 0.80)), Image.LANCZOS)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(fg, ((s - fg.width) // 2, (s - fg.height) // 2), fg)
    save(canvas, f"mipmap-{k}", "ic_launcher_foreground.png")

adaptive = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
os.makedirs(os.path.join(RES, "mipmap-anydpi-v26"), exist_ok=True)
for n in ("ic_launcher.xml", "ic_launcher_round.xml"):
    with open(os.path.join(RES, "mipmap-anydpi-v26", n), "w") as fh:
        fh.write(adaptive)

# Android TV banner: 320x180 (xhdpi) — degrade arka plan + ikon + VISION yazısı
W, H = 640, 360
ban = Image.new("RGBA", (W, H))
d = ImageDraw.Draw(ban)
for y in range(H):
    for x in range(0, W, 4):
        t = y / H
        u = x / W
        r = int(30 * (1 - t) + 9 * t + 40 * (1 - abs(u - 0.3)) * (1 - t))
        g = int(16 * (1 - t) + 8 * t + 10 * (1 - abs(u - 0.3)) * (1 - t))
        b = int(60 * (1 - t) + 14 * t + 90 * (1 - abs(u - 0.3)) * (1 - t))
        d.rectangle([x, y, x + 3, y], fill=(r, g, b, 255))
icon = CROP.resize((230, 230), Image.LANCZOS)
ban.paste(icon, (50, (H - 230) // 2), icon)
font = None
for cand in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf"):
    if os.path.exists(cand):
        try:
            font = ImageFont.truetype(cand, 76)
            break
        except Exception:
            pass
font = font or ImageFont.load_default()
text = "VISION"
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
x0, y0 = 310, H // 2 - 46
spacing = 14
cx = x0
for ch in text:
    gd.text((cx, y0), ch, font=font, fill=(139, 92, 246, 255))
    cx += gd.textlength(ch, font=font) + spacing
glow = glow.filter(ImageFilter.GaussianBlur(14))
ban = Image.alpha_composite(ban, glow)
d = ImageDraw.Draw(ban)
cx = x0
for ch in text:
    d.text((cx, y0), ch, font=font, fill=(237, 233, 254, 255))
    cx += d.textlength(ch, font=font) + spacing
save(ban.resize((320, 180), Image.LANCZOS).convert("RGB"), "drawable-xhdpi", "banner.png")
print("Android ikonları ve TV banner'ı üretildi:", RES)
