#!/usr/bin/env python3
"""Vision uygulama ikonunu (1024x1024 PNG) saf Python ile üretir: python3 build/make_icon.py"""
import math
import os
import struct
import zlib

S = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")

# macOS ikon ızgarası: 824px kare, köşe yarıçapı ~185
M, R = 100, 185
X0, Y0, X1, Y1 = M, M, S - M, S - M

# "V" çizgileri
A = (352, 352)
B = (512, 690)
C = (672, 352)
W = 46  # yarı kalınlık


def seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def rrect_sdf(px, py):
    cx, cy = (X0 + X1) / 2, (Y0 + Y1) / 2
    hx, hy = (X1 - X0) / 2 - R, (Y1 - Y0) / 2 - R
    qx, qy = abs(px - cx) - hx, abs(py - cy) - hy
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - R


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


rows = []
for y in range(S):
    row = bytearray([0])
    for x in range(S):
        px, py = x + 0.5, y + 0.5
        d = rrect_sdf(px, py)
        alpha = clamp(0.5 - d)
        if alpha <= 0:
            row += b"\x00\x00\x00\x00"
            continue
        # arka plan: koyu mor degrade + merkez parıltı
        t = (py - Y0) / (Y1 - Y0)
        col = mix((46, 24, 84), (10, 7, 20), clamp(t))
        g = math.exp(-(((px - 512) / 300) ** 2 + ((py - 560) / 300) ** 2))
        col = mix(col, (88, 40, 170), g * 0.55)
        # cam kenar parlaması
        edge = clamp(1 - abs(d + 6) / 6)
        top = clamp((560 - py) / 460)
        col = mix(col, (220, 205, 255), edge * (0.15 + 0.45 * top))
        # V ve neon parıltı
        vd = min(seg_dist(px, py, A, B), seg_dist(px, py, C, B))
        glow = math.exp(-max(vd - W, 0) / 34) * 0.85
        col = mix(col, (139, 92, 246), clamp(glow))
        inside = clamp(W + 0.75 - vd)
        if inside > 0:
            vt = clamp((py - 352) / 340)
            vcol = mix((240, 232, 255), (150, 105, 250), vt)
            core = clamp(1 - vd / W)
            vcol = mix(vcol, (255, 255, 255), core * 0.25 * (1 - vt))
            col = mix(col, vcol, inside)
        row += bytes((int(clamp(col[0], 0, 255)), int(clamp(col[1], 0, 255)), int(clamp(col[2], 0, 255)), int(alpha * 255)))
    rows.append(bytes(row))

raw = b"".join(rows)


def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
with open(OUT, "wb") as f:
    f.write(png)
print("ikon yazıldı:", OUT)
