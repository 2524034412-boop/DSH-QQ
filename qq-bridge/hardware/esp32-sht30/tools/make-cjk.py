# 生成 12x12 的中文点阵（只做屏幕上要用的几个字），给 GC9A01 直接画。
# 输出 cjk24.h：每个字 12 行，每行一个 uint32_t，bit19..bit0 对应 x=0..19。
from PIL import Image, ImageDraw, ImageFont

GLYPHS = "温度湿有人没"          # 顺序即索引：0 温 1 度 2 湿 3 有 4 人 5 没
OUT = r"D:\DSH\qq-bridge\hardware\esp32-sht30\esp32-sht30-display\cjk24.h"
SIZE = 20
SS = 1          # 直接 16px 渲染；超采样再缩会把笔画削没

font = None
for path in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"):
    try:
        font = ImageFont.truetype(path, SIZE)
        print("font:", path)
        break
    except Exception:
        continue
if font is None:
    raise SystemExit("找不到中文字体")

rows_all = []
for ch in GLYPHS:
    big = Image.new("L", (SIZE * SS, SIZE * SS), 0)
    bd = ImageDraw.Draw(big)
    bbox = bd.textbbox((0, 0), ch, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    bd.text(((SIZE * SS - w) // 2 - bbox[0], (SIZE * SS - h) // 2 - bbox[1]), ch, font=font, fill=255)
    img = big.resize((SIZE, SIZE), Image.LANCZOS)      # 超采样降下来，笔画才不会糊成一团
    px = img.load()
    rows = []
    for y in range(SIZE):
        bits = 0
        for x in range(SIZE):
            if px[x, y] >= 128:            # 阈值：中等以上算亮
                bits |= (1 << (SIZE - 1 - x))
        rows.append(bits)
    rows_all.append(rows)
    # 控制台用 # 打出来看一眼
    print("---", ch)
    for y in range(SIZE):
        print("  " + "".join("#" if px[x, y] >= 128 else "." for x in range(SIZE)))

lines = [
    "// 自动生成，别手改：D:\\DSH\\tmp\\make-cjk12.py",
    "// 20x20 中文点阵，只含屏幕上用到的字：温 度 湿 有 人 没",
    "#pragma once",
    "#include <stdint.h>",
    "",
    f"#define CJK_W {SIZE}",
    f"#define CJK_H {SIZE}",
    f"#define CJK_COUNT {len(GLYPHS)}",
    "// 索引：0 温 1 度 2 湿 3 有 4 人 5 没",
    f"static const uint32_t CJK24[{len(GLYPHS)}][{SIZE}] = {{",
]
for rows in rows_all:
    lines.append("  { " + ", ".join("0x%06X" % r for r in rows) + " },")
lines.append("};")

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(lines) + "\n")

import os
print("out:", OUT, round(os.path.getsize(OUT) / 1024, 1), "KB")