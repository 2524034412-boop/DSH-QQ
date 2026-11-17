# deepseek娘.png → GC9A01 (240x240 RGB565) 背景 + 两块「数字擦除区」贴片。
#
# 设计目标：照片和数字是**一张画面**，不是"左边照片右边黑盒子"。
#   1. 背景：原图放大裁切 + 高斯模糊 + 压暗 → 铺满整个圆，替代突兀的渐变
#   2. 前景：她按高度 240 缩放，居中
#   3. 底部：一条平滑渐隐的暗色 scrim，让数字能压在照片上还看得清
#   4. 固件只重画「数字区」这一小块（贴片来自背景本身），所以不会有残影、
#      也不会有方块边界 —— 数字看起来就是浮在照片上的
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SRC = r"D:\DSH\qq-bridge\assets\deepseek娘.png"
OUT_H = r"D:\DSH\qq-bridge\hardware\esp32-sht30\esp32-sht30-display\girl240.h"
OUT_PREVIEW = r"D:\DSH\tmp\esp32-screen\预览-屏上布局.png"
W = H = 240

# ── 1) 背景：铺满 + 模糊 + 压暗 ─────────────────────────────────────────
src = Image.open(SRC).convert("RGBA")
scale_cover = max(W / src.width, H / src.height)
cover = src.resize((max(W, int(src.width * scale_cover)), max(H, int(src.height * scale_cover))), Image.LANCZOS)
left = (cover.width - W) // 2
top = (cover.height - H) // 2
bg = cover.crop((left, top, left + W, top + H)).filter(ImageFilter.GaussianBlur(14))
dark = Image.new("RGB", (W, H), (8, 10, 20))
bg = Image.blend(bg.convert("RGB"), dark, 0.55)

# ── 1.5) 她身后的暖光晕（让主体从背景里"亮"出来，而不是贴上去） ────────
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
for r in range(150, 0, -6):
    a = int(38 * (1 - r / 150) ** 1.6)
    gd.ellipse([120 - r, 104 - r, 120 + r, 104 + r], fill=(a, int(a * 0.72), int(a * 0.55)))
glow = glow.filter(ImageFilter.GaussianBlur(18))
bg = Image.blend(bg, Image.blend(bg, glow, 0.5), 0.55)

# ── 2) 前景：她按高度缩放、居中、底部对齐 ──────────────────────────────
# 铺满：按宽度放大到 240，从顶部对齐（头在上、身体自然裁到屏外）
girl = src.copy()
gw = 240
girl = girl.resize((gw, max(1, int(girl.height * gw / girl.width))), Image.LANCZOS)
gx = 0
gy = 0
canvas = bg.convert("RGBA")
canvas.alpha_composite(girl, (gx, gy))

# ── 3) 底部渐隐 scrim（平滑，没有硬边） ────────────────────────────────
# 文字带：数字从 y≈90 到 170，所以在这条横带上加一层柔和的暗色，
# 上下都平滑收掉（不是底部渐隐），数字才有底色可依，又不显得是块黑板。
scrim = Image.new("L", (W, H), 0)
sd = ImageDraw.Draw(scrim)
def band_alpha(y):
    if y < 18 or y > 126:
        return 0.0
    if y < 38:                      # 18 -> 38 渐入
        return ((y - 18) / 20.0) ** 1.4
    if y > 100:                     # 100 -> 126 渐出
        return max(0.0, 1.0 - (y - 100) / 26.0) ** 1.4
    return 1.0
for y in range(H):
    sd.line([(0, y), (W, y)], fill=int(255 * band_alpha(y)))
overlay = Image.new("RGBA", (W, H), (6, 8, 16, 255))
overlay.putalpha(scrim.point(lambda v: int(v * 0.62)))
canvas = Image.alpha_composite(canvas, overlay)
bg = canvas.convert("RGB")

# ── 3.5) 边缘暗角：让圆屏边缘自然收进黑色 bezel ────────────────────────
vig = Image.new("L", (W, H), 0)
vd = ImageDraw.Draw(vig)
for r in range(120, 70, -2):
    vd.ellipse([120 - r, 120 - r, 120 + r, 120 + r], fill=int(255 * max(0.0, (r - 70) / 50.0) ** 1.5))
vig = vig.filter(ImageFilter.GaussianBlur(10))
voverlay = Image.new("RGBA", (W, H), (4, 5, 12, 255))
voverlay.putalpha(vig.point(lambda v: int(v * 0.55)))
bg = Image.alpha_composite(bg.convert("RGBA"), voverlay).convert("RGB")

# ── 4) 数字区坐标（固件必须一致） ──────────────────────────────────────
# GFX 默认字体：size 3 每字符 18px 宽（5*3 笔画 + 3 间隔），size 2 每字符 12px
# 三行紧凑排布（整块上移，避开她的脸）
#  行1  温度 + 22.5(size3)   行2  湿度 + 51%(size3)   行3  ● 有人/没人
LBL = 40                      # 两个汉字 20px*2
GAP = 6
ZONE_TEMP = (57, 28, 118, 26)
ZONE_HUM  = (66, 56, 102, 26)
ZONE_PIR  = (89, 82, 60, 26)
TEMP_LBL_X, ROW1_Y = 61, 32
TEMP_VAL_X = TEMP_LBL_X + LBL + GAP          # 107
HUM_LBL_X, ROW2_Y = 70, 60
HUM_VAL_X = HUM_LBL_X + LBL + GAP            # 116
PIR_TEXT_X, ROW3_Y = 105, 86
PIR_DOT_X, PIR_DOT_Y, PIR_DOT_R = 97, 96, 4

# ── 5) 预览（用系统字体近似，位置和固件一致） ──────────────────────────
prev = bg.copy()
p = ImageDraw.Draw(prev)
try:
    f3 = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", 22)
    f2 = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", 15)
except Exception:
    f3 = f2 = ImageFont.load_default()
def zh(xylist, text, color, fnt):
    for (x, y, ch) in xylist:
        p.text((x + 1, y + 1), ch, font=fnt, fill=(0, 0, 0))
        p.text((x, y), ch, font=fnt, fill=color)

fzh = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
zh([(TEMP_LBL_X, ROW1_Y, "温"), (TEMP_LBL_X + 20, ROW1_Y, "度")], "", (150, 165, 200), fzh)
p.text((TEMP_VAL_X + 1, ROW1_Y + 1), "22.5", font=f3, fill=(0, 0, 0))
p.text((TEMP_VAL_X, ROW1_Y + 1), "22.5", font=f3, fill=(255, 236, 214))
zh([(HUM_LBL_X, ROW2_Y, "湿"), (HUM_LBL_X + 20, ROW2_Y, "度")], "", (150, 165, 200), fzh)
p.text((HUM_VAL_X + 1, ROW2_Y + 1), "51%", font=f3, fill=(0, 0, 0))
p.text((HUM_VAL_X, ROW2_Y + 1), "51%", font=f3, fill=(196, 226, 255))
p.ellipse([PIR_DOT_X - PIR_DOT_R, PIR_DOT_Y - PIR_DOT_R, PIR_DOT_X + PIR_DOT_R, PIR_DOT_Y + PIR_DOT_R], fill=(90, 220, 140))
zh([(PIR_TEXT_X, ROW3_Y, "有"), (PIR_TEXT_X + 20, ROW3_Y, "人")], "", (120, 230, 160), fzh)
prev.save(OUT_PREVIEW)
print("preview:", OUT_PREVIEW)

# ── 6) 转 RGB565 大端 ─────────────────────────────────────────────────
def to565(img):
    px = img.load()
    out = []
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = px[x, y][:3]
            out.append(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3))
    return out

def zone(img, box):
    x, y, w, h = box
    return img.crop((x, y, x + w, y + h))

girl_vals = to565(bg)
zt = zone(bg, ZONE_TEMP)
zh = zone(bg, ZONE_HUM)
zp = zone(bg, ZONE_PIR)
zt_vals = to565(zt)
zh_vals = to565(zh)
zp_vals = to565(zp)

def emit_array(name, vals, width):
    lines = [f"static const uint16_t {name}[{len(vals)}] = {{"]
    for i in range(0, len(vals), 12):
        lines.append("  " + ", ".join("0x%04X" % v for v in vals[i:i + 12]) + ",")
    lines.append("};")
    return lines

hdr = [
    "// 自动生成，别手改：D:\\DSH\\tmp\\make-girl240.py",
    "// 240x240 RGB565 背景 + 两块数字擦除贴片（贴片就是背景的一部分，所以数字压在照片上没有方块）",
    "#pragma once",
    "#include <stdint.h>",
    "",
    f"#define ZONE_TEMP_X {ZONE_TEMP[0]}",
    f"#define ZONE_TEMP_Y {ZONE_TEMP[1]}",
    f"#define ZONE_TEMP_W {ZONE_TEMP[2]}",
    f"#define ZONE_TEMP_H {ZONE_TEMP[3]}",
    f"#define ZONE_HUM_X {ZONE_HUM[0]}",
    f"#define ZONE_HUM_Y {ZONE_HUM[1]}",
    f"#define ZONE_HUM_W {ZONE_HUM[2]}",
    f"#define ZONE_HUM_H {ZONE_HUM[3]}",
    f"#define ZONE_PIR_X {ZONE_PIR[0]}",
    f"#define ZONE_PIR_Y {ZONE_PIR[1]}",
    f"#define ZONE_PIR_W {ZONE_PIR[2]}",
    f"#define ZONE_PIR_H {ZONE_PIR[3]}",
    f"#define TEMP_LBL_X {TEMP_LBL_X}",
    f"#define TEMP_VAL_X {TEMP_VAL_X}",
    f"#define HUM_LBL_X {HUM_LBL_X}",
    f"#define HUM_VAL_X {HUM_VAL_X}",
    f"#define ROW1_Y {ROW1_Y}",
    f"#define ROW2_Y {ROW2_Y}",
    f"#define PIR_TEXT_X {PIR_TEXT_X}",
    f"#define PIR_DOT_X {PIR_DOT_X}",
    f"#define PIR_DOT_Y {PIR_DOT_Y}",
    f"#define PIR_DOT_R {PIR_DOT_R}",
    f"#define ROW3_Y {ROW3_Y}",
    "",
]
hdr += emit_array("GIRL240", girl_vals, W)
hdr += [""]
hdr += emit_array("ZONE_TEMP", zt_vals, ZONE_TEMP[2])
hdr += [""]
hdr += emit_array("ZONE_HUM", zh_vals, ZONE_HUM[2])
hdr += [""]
hdr += emit_array("ZONE_PIR", zp_vals, ZONE_PIR[2])

with open(OUT_H, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(hdr) + "\n")

import os
print("header:", OUT_H, round(os.path.getsize(OUT_H) / 1024), "KB")
print("girl:", girl.size, "bg blurred from cover", (cover.width, cover.height))
print("zones:", ZONE_TEMP, ZONE_HUM)