from PIL import Image

SRC = r"assets\logo-source.png"
im = Image.open(SRC).convert("RGBA")

# 去掉可能存在的白边：按"非纯白"边界裁一次（图标本身是深底，白边多见于生成图的留白）
def trim_white(img, tol=246):
    w, h = img.size
    px = img.load()
    left, top, right, bottom = w, h, -1, -1
    step = 4
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b, a = px[x, y]
            if a > 10 and not (r > tol and g > tol and b > tol):
                left = min(left, x); right = max(right, x)
                top = min(top, y); bottom = max(bottom, y)
    if right <= left or bottom <= top:
        return img
    return img.crop((left, top, right + 1, bottom + 1))

trimmed = trim_white(im)
print("原尺寸:", im.size, "裁白边后:", trimmed.size)

# 统一成正方形（居中），再缩放
side = min(trimmed.size)
left = (trimmed.width - side) // 2
top = (trimmed.height - side) // 2
sq = trimmed.crop((left, top, left + side, top + side))

targets = [("logo.png", 512), ("icon128.png", 128), ("icon48.png", 48), ("icon32.png", 32), ("icon16.png", 16)]
for name, size in targets:
    out = sq.resize((size, size), Image.LANCZOS)
    out.save(f"assets\\{name}")
    print(f"  {name:14s} {size}x{size}")

print("done")