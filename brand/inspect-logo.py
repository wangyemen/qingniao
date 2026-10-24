from PIL import Image
import os

SRC = r"assets\logo-source.png"
img = Image.open(SRC)
print("size:", img.size, "mode:", img.mode)

im = img.convert("RGBA")
w, h = im.size
px = im.load()

# 采样统计
def sample(x0, y0, x1, y1, step=12):
    tot = 0
    teal = 0
    dark = 0
    light = 0
    for y in range(y0, y1, step):
        for x in range(x0, x1, step):
            r, g, b, a = px[x, y]
            tot += 1
            if a < 20:
                continue
            if g > 120 and g > r + 30 and b > 110:
                teal += 1
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum < 70:
                dark += 1
            elif lum > 200:
                light += 1
    return tot, teal, dark, light

tot, teal, dark, light = sample(0, 0, w, h)
print(f"全图采样 {tot}: 青绿 {teal/tot:.1%}  深色 {dark/tot:.1%}  亮色 {light/tot:.1%}")

# 四角与中心
for name, (x, y) in {
    "左上": (int(w * 0.04), int(h * 0.04)),
    "右上": (int(w * 0.96), int(h * 0.04)),
    "左下": (int(w * 0.04), int(h * 0.96)),
    "右下": (int(w * 0.96), int(h * 0.96)),
    "中心": (int(w * 0.5), int(h * 0.5)),
}.items():
    r, g, b, a = px[x, y]
    print(f"  {name} 像素: rgba({r},{g},{b},{a})")

# 中心区域的青绿占比（标志主体应在中心）
ct, cteal, _, _ = sample(int(w * 0.2), int(h * 0.2), int(w * 0.8), int(h * 0.8))
print(f"中心区域青绿占比: {cteal/ct:.1%}")