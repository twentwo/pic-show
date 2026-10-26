#!/usr/bin/env python3
"""生成 PicShow 所需的 Tauri 图标（纯标准库，无需 Pillow）。

产物:
  src-tauri/icons/32x32.png
  src-tauri/icons/128x128.png
  src-tauri/icons/128x128@2x.png
  src-tauri/icons/icon.png          (512)
  src-tauri/icons/icon.icns         (macOS)
  src-tauri/icons/icon.ico          (Windows)
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "src-tauri", "icons")

SS = 3  # 超采样倍数，用于抗锯齿


# --------------------------------------------------------------------------- #
# 形状
# --------------------------------------------------------------------------- #
def rounded_rect_sdf(x, y, w, h, r):
    """>0 在矩形外。返回到圆角矩形边界的近似有符号距离（像素为单位）。"""
    cx = max(0.0, min(x, w))
    cy = max(0.0, min(y, h))
    dx = x - cx
    dy = y - cy
    return math.hypot(dx, dy) - r


def point_in_triangle(px, py, ax, ay, bx, by, cx, cy):
    def sign(x1, y1, x2, y2, x3, y3):
        return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)

    d1 = sign(px, py, ax, ay, bx, by)
    d2 = sign(px, py, bx, by, cx, cy)
    d3 = sign(px, py, cx, cy, ax, ay)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def render(size):
    """返回 RGBA 行列表（每行 bytes，长度 size*4）。"""
    rows = []
    radius = size * 0.22

    # 图形坐标（归一化 0..1，左上角为原点）
    sun_cx, sun_cy, sun_r = 0.655, 0.335, 0.115
    # 山：主峰 + 次峰
    m1 = (0.10, 0.79, 0.33, 0.40, 0.60, 0.79)
    m2 = (0.42, 0.79, 0.62, 0.51, 0.86, 0.79)

    for py in range(size):
        row = bytearray()
        for px in range(size):
            # 超采样累积
            ar = ag = ab = aa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = px + (sx + 0.5) / SS
                    fy = py + (sy + 0.5) / SS

                    d = -rounded_rect_sdf(fx, fy, size, size, radius)
                    cov = max(0.0, min(1.0, d + 0.5))
                    if cov <= 0.0:
                        continue

                    # 背景：从左上 #333a4a 到右下 #0c0e13
                    t = (fx / size + fy / size) * 0.5
                    r = 0x33 + (0x0C - 0x33) * t
                    g = 0x3A + (0x0E - 0x3A) * t
                    b = 0x4A + (0x13 - 0x4A) * t

                    nx, ny = fx / size, fy / size

                    # 太阳
                    if math.hypot(nx - sun_cx, ny - sun_cy) <= sun_r:
                        r, g, b = 0xFF, 0xD3, 0x66

                    # 远山（次峰，颜色略暗）
                    if point_in_triangle(nx, ny, m2[0], m2[1], m2[2], m2[3], m2[4], m2[5]):
                        r, g, b = 0x7C, 0x87, 0x9E

                    # 近山（主峰）
                    if point_in_triangle(nx, ny, m1[0], m1[1], m1[2], m1[3], m1[4], m1[5]):
                        r, g, b = 0xF2, 0xF5, 0xFA

                    ar += r * cov
                    ag += g * cov
                    ab += b * cov
                    aa += cov

            n = SS * SS
            if aa > 0:
                row += bytes((int(ar / aa), int(ag / aa), int(ab / aa),
                              int(255 * aa / n)))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


# --------------------------------------------------------------------------- #
# 编码
# --------------------------------------------------------------------------- #
def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size):
    rows = render(size)
    raw = b"".join(b"\x00" + r for r in rows)
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + _chunk(b"IDAT", zlib.compress(raw, 9))
           + _chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return png


def write_icns(path):
    entries = []
    # (图标类型, 像素尺寸)
    for ostype, px in [("ic11", 32), ("ic12", 64), ("ic07", 128),
                       ("ic08", 256), ("ic09", 512), ("ic10", 1024)]:
        png = write_png(f"/tmp/picshow-{px}.png", px)
        entries.append(ostype.encode() + struct.pack(">I", len(png) + 8) + png)
    body = b"".join(entries)
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def write_ico(path):
    png = write_png("/tmp/picshow-ico.png", 256)
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    with open(path, "wb") as f:
        f.write(header + entry + png)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    write_png(os.path.join(OUT, "32x32.png"), 32)
    write_png(os.path.join(OUT, "128x128.png"), 128)
    write_png(os.path.join(OUT, "128x128@2x.png"), 256)
    write_png(os.path.join(OUT, "icon.png"), 512)
    write_icns(os.path.join(OUT, "icon.icns"))
    write_ico(os.path.join(OUT, "icon.ico"))
    for n in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, n)
        print(f"  {n:20s} {os.path.getsize(p):>8,d} bytes")
