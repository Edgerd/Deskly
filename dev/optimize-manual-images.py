"""
dev/optimize-manual-images.py — 把知识库 PNG 压成手册插件内的 WebP

原图 docs/iMac-2024-macOS15-知识库/images 共 43MB，而应用商店的插件 ZIP
上限是 10MB，所以插件只带压缩副本 mods/manual/images/*.webp（约 6MB）。
图片本身不改名、不裁切，只限制最大边并按质量 85 编码。

依赖 Pillow（pip install pillow）。用法：
    python dev/optimize-manual-images.py
    python dev/optimize-manual-images.py --quality 88 --max-size 1400
"""

import argparse
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    raise SystemExit("需要 Pillow：pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "iMac-2024-macOS15-知识库" / "images"
OUT = ROOT / "mods" / "manual" / "images"
EXTS = {".png", ".jpg", ".jpeg"}


def main():
    parser = argparse.ArgumentParser(description="知识库插图 → 手册 WebP")
    parser.add_argument("--quality", type=int, default=85, help="WebP 质量（默认 85）")
    parser.add_argument("--max-size", type=int, default=1600, help="最大边长（默认 1600px）")
    args = parser.parse_args()

    files = sorted(p for p in SRC.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        raise SystemExit(f"源目录没有图片：{SRC}")

    OUT.mkdir(parents=True, exist_ok=True)
    total_in = total_out = 0
    for source in files:
        with Image.open(source) as image:
            copy = image.copy()
            if max(copy.size) > args.max_size:
                copy.thumbnail((args.max_size, args.max_size), Image.LANCZOS)
            if copy.mode not in ("RGB", "RGBA"):
                copy = copy.convert("RGBA")
            target = OUT / f"{source.stem}.webp"
            copy.save(target, "WEBP", quality=args.quality, method=6)
            total_in += source.stat().st_size
            total_out += target.stat().st_size

    print(
        f"{len(files)} 张：{total_in / 1048576:.1f} MB → "
        f"{total_out / 1048576:.1f} MB（quality={args.quality}, max={args.max_size}px）"
    )


if __name__ == "__main__":
    main()
