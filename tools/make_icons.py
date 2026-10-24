"""Generates the extension icons (icons/icon{16,32,48,128}.png).

Usage: python3 tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
SCALE = 8  # Supersampling factor for smooth edges.
RED = (255, 0, 51, 255)
WHITE = (255, 255, 255, 255)
LIGHT = (255, 255, 255, 190)


def draw_icon(size: int) -> Image.Image:
    """Red rounded tile with a large and a small caption bar."""
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, big * 0.1, big - 1, big * 0.9), radius=big * 0.2, fill=RED)
    # Primary line (larger) and secondary line (smaller, lighter).
    d.rounded_rectangle((big * 0.18, big * 0.33, big * 0.82, big * 0.48), radius=big * 0.04, fill=WHITE)
    d.rounded_rectangle((big * 0.28, big * 0.57, big * 0.72, big * 0.67), radius=big * 0.03, fill=LIGHT)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / "icons"
    out_dir.mkdir(exist_ok=True)
    for size in SIZES:
        draw_icon(size).save(out_dir / f"icon{size}.png")


if __name__ == "__main__":
    main()
