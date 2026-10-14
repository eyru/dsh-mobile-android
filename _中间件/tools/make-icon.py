#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 DSH 手机版的旧版启动图标（PNG 回退，API 24-25 无 adaptive-icon）。"""
from PIL import Image, ImageDraw
import os

OUT = r"D:\蓝色大肥鱼工作区\写出\DSH手机版\app\src\main\res"

BG = (26, 26, 26, 255)
BLUE = (77, 107, 254, 255)
BLUE_DIM = (58, 84, 214, 255)


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    # 画布坐标按 108x108 viewport 等比缩放
    k = size / 108.0

    def P(pts):
        return [(x * k, y * k) for x, y in pts]

    # 身体（椭圆近似原矢量路径）
    cx, cy = 54.0, 52.5
    rx, ry = 26.0 * k, 14.5 * k
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=BLUE)

    # 尾鳍上叶
    d.polygon(P([(50, 38), (62, 22), (63, 32), (52, 40)]), fill=BLUE)
    # 尾鳍下叶
    d.polygon(P([(62, 22), (74, 22), (63, 32)]), fill=BLUE_DIM)

    # 喷水点（半透明）
    d.ellipse([37 * k, 23 * k, 43 * k, 29 * k], fill=(77, 107, 254, 140))
    d.ellipse([50 * k, 18 * k, 54 * k, 22 * k], fill=(77, 107, 254, 90))

    # 眼睛（挖孔成深色）
    ex, ey, er = 44 * k, 52 * k, 3.2 * k
    d.ellipse([ex - er, ey - er, ex + er, ey + er], fill=BG)

    return img


# mipmap-mdpi=48, hdpi=72, xhdpi=96, xxhdpi=144, xxxhdpi=192
for name, px in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
                 ("xxhdpi", 144), ("xxxhdpi", 192)):
    d = os.path.join(OUT, "mipmap-" + name)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "ic_launcher.png")
    draw_icon(px).save(p, "PNG", optimize=True)
    print(f"[OK] {p}  ({px}x{px}, {os.path.getsize(p)} bytes)")
