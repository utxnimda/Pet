from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def thresholded_bbox(image: Image.Image, alpha_threshold: int) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A")
    if alpha_threshold <= 0:
        return alpha.getbbox()

    mask = alpha.point(lambda value: 255 if value > alpha_threshold else 0)
    return mask.getbbox()


def paste_shifted(source: Image.Image, dx: int, dy: int) -> Image.Image:
    width, height = source.size
    source_left = max(0, -dx)
    source_top = max(0, -dy)
    source_right = min(width, width - dx)
    source_bottom = min(height, height - dy)

    canvas = Image.new("RGBA", source.size, (0, 0, 0, 0))
    if source_right <= source_left or source_bottom <= source_top:
        return canvas

    crop = source.crop((source_left, source_top, source_right, source_bottom))
    canvas.alpha_composite(crop, (source_left + dx, source_top + dy))
    return canvas


def axis_ranges(
    boxes: list[tuple[int, int, int, int] | None],
) -> tuple[float, int]:
    visible_boxes = [box for box in boxes if box]
    if not visible_boxes:
        return 0.0, 0

    centers = [(left + right) / 2 for left, _, right, _ in visible_boxes]
    bottoms = [bottom for _, _, _, bottom in visible_boxes]
    return max(centers) - min(centers), max(bottoms) - min(bottoms)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Align transparent animation frames to a common center x and "
            "bottom anchor before encoding."
        )
    )
    parser.add_argument("--input-pattern", required=True)
    parser.add_argument("--output-pattern", required=True)
    parser.add_argument("--frame-count", type=int, required=True)
    parser.add_argument("--target-x", type=float)
    parser.add_argument("--target-bottom", type=int)
    parser.add_argument("--alpha-threshold", type=int, default=4)
    parser.add_argument("--report")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.frame_count < 1:
        raise SystemExit("--frame-count must be positive")
    if not 0 <= args.alpha_threshold <= 255:
        raise SystemExit("--alpha-threshold must be between 0 and 255")

    input_paths = [
        Path(args.input_pattern % index) for index in range(args.frame_count)
    ]
    frames: list[Image.Image] = []
    before_boxes: list[tuple[int, int, int, int] | None] = []

    for path in input_paths:
        if not path.exists():
            raise SystemExit(f"Missing frame: {path}")
        with Image.open(path) as image:
            frame = image.convert("RGBA")
        frames.append(frame)
        before_boxes.append(thresholded_bbox(frame, args.alpha_threshold))

    visible_boxes = [box for box in before_boxes if box]
    if not visible_boxes:
        raise SystemExit("No visible pixels found in input frames")

    width, _ = frames[0].size
    target_x = args.target_x if args.target_x is not None else width / 2
    target_bottom = (
        args.target_bottom
        if args.target_bottom is not None
        else max(bottom for _, _, _, bottom in visible_boxes)
    )

    output_frames: list[Image.Image] = []
    shifts: list[dict[str, int]] = []
    after_boxes: list[tuple[int, int, int, int] | None] = []

    for index, (frame, box) in enumerate(zip(frames, before_boxes)):
        if not box:
            aligned = frame
            dx = 0
            dy = 0
        else:
            left, _, right, bottom = box
            center_x = (left + right) / 2
            dx = round(target_x - center_x)
            dy = round(target_bottom - bottom)
            aligned = paste_shifted(frame, dx, dy)

        output_path = Path(args.output_pattern % index)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        aligned.save(output_path)
        output_frames.append(aligned)
        shifts.append({"frame": index, "dx": dx, "dy": dy})
        after_boxes.append(thresholded_bbox(aligned, args.alpha_threshold))

    before_center_range, before_bottom_range = axis_ranges(before_boxes)
    after_center_range, after_bottom_range = axis_ranges(after_boxes)
    report = {
        "targetX": target_x,
        "targetBottom": target_bottom,
        "beforeCenterRange": round(before_center_range, 2),
        "beforeBottomRange": before_bottom_range,
        "afterCenterRange": round(after_center_range, 2),
        "afterBottomRange": after_bottom_range,
        "shifts": shifts,
    }

    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
