from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def parse_color(value: str) -> tuple[int, int, int]:
    normalized = value.strip()
    if normalized.startswith("#"):
        normalized = normalized[1:]
    if len(normalized) != 6:
        raise argparse.ArgumentTypeError("color must be in #rrggbb format")
    try:
        return (
            int(normalized[0:2], 16),
            int(normalized[2:4], 16),
            int(normalized[4:6], 16),
        )
    except ValueError as error:
        raise argparse.ArgumentTypeError("color must be hexadecimal") from error


def parse_box(value: str) -> tuple[int, int, int, int]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("box must be left,top,right,bottom")
    try:
        left, top, right, bottom = (int(part) for part in parts)
    except ValueError as error:
        raise argparse.ArgumentTypeError("box values must be integers") from error
    if right <= left or bottom <= top:
        raise argparse.ArgumentTypeError("box right/bottom must exceed left/top")
    return left, top, right, bottom


def near_background(
    color: tuple[int, int, int],
    background: tuple[int, int, int],
    tolerance: int,
) -> bool:
    return all(abs(channel - target) <= tolerance for channel, target in zip(color, background))


def near_magenta_family(color: tuple[int, int, int], green_max: int) -> bool:
    red, green, blue = color
    return red >= 200 and blue >= 200 and green <= green_max


def clamp_box(box: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    return max(0, left), max(0, top), min(width, right), min(height, bottom)


def count_exact(
    pixels,
    box: tuple[int, int, int, int],
    color: tuple[int, int, int, int],
) -> tuple[int, int]:
    left, top, right, bottom = box
    total = max(0, right - left) * max(0, bottom - top)
    exact = 0
    for y in range(top, bottom):
        for x in range(left, right):
            if pixels[x, y] == color:
                exact += 1
    return exact, total


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Normalize a Gemini-generated anchored image by snapping the background "
            "to a chroma color, clearing the anchor safe zone, and redrawing a pixel-exact anchor."
        )
    )
    parser.add_argument("--input", required=True, type=Path, help="Input PNG/JPEG/WebP image")
    parser.add_argument("--out", required=True, type=Path, help="Output normalized PNG image")
    parser.add_argument("--report", type=Path, help="Optional JSON report path")
    parser.add_argument("--background-color", default="#ff00ff", type=parse_color)
    parser.add_argument("--anchor-color", default="#00ffff", type=parse_color)
    parser.add_argument(
        "--anchor-box",
        default="24,24,80,80",
        type=parse_box,
        help="Anchor box as left,top,right,bottom. Default draws a 56x56 anchor at x=24,y=24.",
    )
    parser.add_argument(
        "--safe-clear-box",
        default="0,0,200,200",
        type=parse_box,
        help="Box to clear before redrawing the anchor. Use at least the 160x160 safe zone.",
    )
    parser.add_argument(
        "--background-tolerance",
        default=18,
        type=int,
        help="Snap pixels close to the exact background color before magenta-family cleanup.",
    )
    parser.add_argument(
        "--magenta-green-max",
        default=90,
        type=int,
        help="Snap AI-softened magenta background pixels where R/B are high and G is below this value.",
    )
    args = parser.parse_args()

    image = Image.open(args.input).convert("RGBA")
    width, height = image.size
    pixels = image.load()

    background_rgb = args.background_color
    anchor_rgb = args.anchor_color
    background_rgba = (*background_rgb, 255)
    anchor_rgba = (*anchor_rgb, 255)

    snapped_background = 0
    transparent_pixels = 0
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                transparent_pixels += 1
                pixels[x, y] = background_rgba
                snapped_background += 1
                continue
            rgb = (red, green, blue)
            if near_background(rgb, background_rgb, args.background_tolerance) or near_magenta_family(
                rgb, args.magenta_green_max
            ):
                if pixels[x, y] != background_rgba:
                    snapped_background += 1
                pixels[x, y] = background_rgba

    safe_box = clamp_box(args.safe_clear_box, width, height)
    safe_left, safe_top, safe_right, safe_bottom = safe_box
    safe_cleared = 0
    for y in range(safe_top, safe_bottom):
        for x in range(safe_left, safe_right):
            if pixels[x, y] != background_rgba:
                safe_cleared += 1
            pixels[x, y] = background_rgba

    anchor_box = clamp_box(args.anchor_box, width, height)
    anchor_left, anchor_top, anchor_right, anchor_bottom = anchor_box
    for y in range(anchor_top, anchor_bottom):
        for x in range(anchor_left, anchor_right):
            pixels[x, y] = anchor_rgba

    args.out.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.out)

    anchor_exact, anchor_total = count_exact(pixels, anchor_box, anchor_rgba)
    safe_check_box = clamp_box((0, 0, 160, 160), width, height)
    safe_left, safe_top, safe_right, safe_bottom = safe_check_box
    safe_total = 0
    safe_background = 0
    for y in range(safe_top, safe_bottom):
        for x in range(safe_left, safe_right):
            if anchor_left <= x < anchor_right and anchor_top <= y < anchor_bottom:
                continue
            safe_total += 1
            if pixels[x, y] == background_rgba:
                safe_background += 1

    report = {
        "input": str(args.input),
        "out": str(args.out),
        "size": [width, height],
        "backgroundColor": f"#{background_rgb[0]:02x}{background_rgb[1]:02x}{background_rgb[2]:02x}",
        "anchorColor": f"#{anchor_rgb[0]:02x}{anchor_rgb[1]:02x}{anchor_rgb[2]:02x}",
        "anchorBox": list(anchor_box),
        "safeClearBox": list(safe_box),
        "snappedBackgroundPixels": snapped_background,
        "transparentPixels": transparent_pixels,
        "safeClearedPixels": safe_cleared,
        "anchorExactPixels": anchor_exact,
        "anchorTotalPixels": anchor_total,
        "safeBackgroundPixels": safe_background,
        "safeTotalPixels": safe_total,
        "passes": anchor_exact == anchor_total and safe_background == safe_total,
    }

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["passes"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
