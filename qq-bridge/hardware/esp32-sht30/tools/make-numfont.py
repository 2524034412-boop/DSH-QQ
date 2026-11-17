# 给屏幕做一个好看的数码字体点阵（只含数字和 . - %），替代 GFX 那个 5x7 方块字。
from PIL import Image, ImageDraw, ImageFont

CHARS = "0123456789.-%"
SIZE = 24                      # 渲染字号（最后会被裁到字形高度）
OUT = r"D:\DSH\qq-bridge\hardware\esp32-sht30\esp32-sht30-display\numfont.h"
PAD = 0

candidates = [
    r"C:\Windows\Fonts\bahnschrift.ttf",
    r"C:\Windows\Fonts\seguisb.ttf",
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]
font = None
for p in candidates:
    try:
        font = ImageFont.truetype(p, SIZE)
        print("font:", p)
        break
    except Exception:
        continue
if font is None:
    raise SystemExit("找不到字体")

# 先量一遍：所有字形共用一个格子，宽度取最大，高度取最大（tabular，数字跳动时不会左右晃）
probe = Image.new("L", (SIZE * 2, SIZE * 2), 0)
pd = ImageDraw.Draw(probe)
boxes = []
for ch in CHARS:
    b = pd.textbbox((0, 0), ch, font=font)
    boxes.append(b)
cell_w = max(b[2] - b[0] for b in boxes) + PAD * 2
cell_h = max(b[3] - b[1] for b in boxes) + PAD * 2
print("cell:", cell_w, "x", cell_h)

rows_all = []
for ch, b in zip(CHARS, boxes):
    img = Image.new("L", (cell_w, cell_h), 0)
    d = ImageDraw.Draw(img)
    w = b[2] - b[0]
    h = b[3] - b[1]
    # 水平居中；垂直方向按 bbox 对齐，"." 这种矮字形也落在基线上
    d.text(((cell_w - w) // 2 - b[0], (cell_h - h) - b[1] - PAD), ch, font=font, fill=255)
    px = img.load()
    rows = []
    for y in range(cell_h):
        bits = 0
        for x in range(cell_w):
            if px[x, y] >= 110:
                bits |= (1 << (cell_w - 1 - x))
        rows.append(bits)
    rows_all.append(rows)

lines = [
    "// 自动生成，别手改：D:\\DSH\\tmp\\make-numfont.py",
    f"// 数码字体点阵 {cell_w}x{cell_h}，字符表：{CHARS}",
    "#pragma once",
    "#include <stdint.h>",
    "",
    f"#define NUMF_W {cell_w}",
    f"#define NUMF_H {cell_h}",
    f'#define NUMF_CHARS "{CHARS}"',
    f"static const uint32_t NUMF[{len(CHARS)}][{cell_h}] = {{",
]
for rows in rows_all:
    lines.append("  { " + ", ".join("0x%04X" % r for r in rows) + " },")
lines.append("};")

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(lines) + "\n")

import os
print("out:", OUT, round(os.path.getsize(OUT) / 1024, 1), "KB")