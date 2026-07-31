from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter


PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXPECTED = {
    "assets/motion/duck-idle.png": 10,
    "assets/motion/duck-argue.png": 10,
    "assets/motion/duck-run.png": 10,
}
ALPHA_THRESHOLD = 4
MAX_CENTER_RANGE = 3.0
MAX_BOTTOM_RANGE = 2
POSITION_RANGE_OVERRIDES = {
    "assets/motion/duck-idle.png": (5.0, 0),
    # This clip keeps the source video's fixed 512px framing. Its run-to-tired
    # motion intentionally changes the visible silhouette instead of recentering
    # every frame, which would reintroduce the jitter the source framing avoids.
    "assets/motion/duck-run.png": (52.0, 6),
}
EDGE_HALO_RADIUS = 18


def count_dark_green_edge_halo(frame: Image.Image) -> int:
    alpha = frame.getchannel("A")
    visible_mask = alpha.point(lambda value: 255 if value > 0 else 0)
    inner_mask = visible_mask

    for _ in range(EDGE_HALO_RADIUS):
        inner_mask = inner_mask.filter(ImageFilter.MinFilter(3))

    edge_band = ImageChops.subtract(visible_mask, inner_mask)
    pixels = frame.load()
    band_pixels = edge_band.load()
    halo_pixels = 0

    for y in range(frame.height):
        for x in range(frame.width):
            if not band_pixels[x, y]:
                continue

            red, green, blue, alpha_value = pixels[x, y]
            if not alpha_value:
                continue

            greenish = (
                green >= red + 14
                and blue >= red + 4
                and green + blue - (2 * red) >= 52
            )
            darkish = red < 115 and green < 185 and blue < 175
            saturated_edge = green > 35 and blue > 28
            if greenish and darkish and saturated_edge:
                halo_pixels += 1

    return halo_pixels


def inspect_animation(relative_path: str, minimum_frames: int) -> dict:
    path = PROJECT_ROOT / relative_path
    if not path.exists():
        raise AssertionError(f"Missing animation: {relative_path}")

    with Image.open(path) as image:
        frame_count = getattr(image, "n_frames", 1)
        if frame_count < minimum_frames:
            raise AssertionError(
                f"{relative_path}: expected at least {minimum_frames} frames, "
                f"got {frame_count}"
            )

        frame_hashes = []
        touching_border = 0
        magenta_artifacts = 0
        edge_halo_artifacts = 0
        visible_boxes = []

        for index in range(frame_count):
            image.seek(index)
            frame = image.convert("RGBA")
            alpha = frame.getchannel("A")
            frame_hashes.append(hashlib.sha256(frame.tobytes()).hexdigest())
            visible_mask = alpha.point(
                lambda value: 255 if value > ALPHA_THRESHOLD else 0
            )
            visible_boxes.append(visible_mask.getbbox())

            width, height = frame.size
            border = (
                [alpha.getpixel((x, 0)) for x in range(width)]
                + [alpha.getpixel((x, height - 1)) for x in range(width)]
                + [alpha.getpixel((0, y)) for y in range(height)]
                + [alpha.getpixel((width - 1, y)) for y in range(height)]
            )
            touching_border += sum(value > 0 for value in border)

            if relative_path.startswith("assets/motion/"):
                for red, green, blue, pixel_alpha in frame.get_flattened_data():
                    if (
                        pixel_alpha
                        and red > 120
                        and blue > 120
                        and min(red, blue) - green >= 62
                    ):
                        magenta_artifacts += 1
                edge_halo_artifacts += count_dark_green_edge_halo(frame)

        if touching_border:
            raise AssertionError(
                f"{relative_path}: {touching_border} visible border pixels remain"
            )
        if magenta_artifacts:
            raise AssertionError(
                f"{relative_path}: {magenta_artifacts} magenta artifact pixels remain"
            )
        if len(set(frame_hashes)) < minimum_frames:
            raise AssertionError(
                f"{relative_path}: duplicate decoded frames were detected"
            )

        boxes = [box for box in visible_boxes if box]
        centers = [(left + right) / 2 for left, _, right, _ in boxes]
        bottoms = [bottom for _, _, _, bottom in boxes]
        center_range = max(centers) - min(centers)
        bottom_range = max(bottoms) - min(bottoms)
        max_center_range, max_bottom_range = POSITION_RANGE_OVERRIDES.get(
            relative_path,
            (MAX_CENTER_RANGE, MAX_BOTTOM_RANGE),
        )
        if center_range > max_center_range:
            raise AssertionError(
                f"{relative_path}: visible center jumps by "
                f"{center_range:.1f}px"
            )
        if bottom_range > max_bottom_range:
            raise AssertionError(
                f"{relative_path}: visible bottom jumps by "
                f"{bottom_range}px"
            )

        return {
            "file": relative_path,
            "size": list(image.size),
            "frames": frame_count,
            "uniqueFrames": len(set(frame_hashes)),
            "centerRangePx": round(center_range, 2),
            "bottomRangePx": bottom_range,
            "durationMs": image.info.get("duration"),
            "loop": image.info.get("loop"),
            "touchingBorderPixels": touching_border,
            "magentaArtifactPixels": magenta_artifacts,
            "edgeHaloArtifactPixels": edge_halo_artifacts,
            "bytes": path.stat().st_size,
        }


def main() -> None:
    report = [
        inspect_animation(relative_path, minimum_frames)
        for relative_path, minimum_frames in EXPECTED.items()
    ]
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
