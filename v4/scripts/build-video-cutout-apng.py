from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def safe_project_path(path: Path) -> Path:
    resolved = path.resolve()
    project = PROJECT_ROOT.resolve()
    if resolved != project and project not in resolved.parents:
        raise RuntimeError(f"Refusing to write outside project: {resolved}")
    return resolved


def recreate_dir(path: Path) -> None:
    resolved = safe_project_path(path)
    if resolved.exists():
        shutil.rmtree(resolved)
    resolved.mkdir(parents=True, exist_ok=True)


def run_ffmpeg_extract(
    input_video: Path,
    raw_dir: Path,
    fps: int,
    ffmpeg_exe: str,
) -> list[Path]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    pattern = raw_dir / "frame-%05d.png"
    command = [
        ffmpeg_exe,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_video),
        "-vf",
        f"fps={fps}",
        str(pattern),
    ]
    subprocess.run(command, check=True)
    frames = sorted(raw_dir.glob("frame-*.png"))
    if len(frames) < 2:
        raise RuntimeError("Need at least two frames after ffmpeg extraction")
    return frames


def choose_evenly(paths: list[Path], max_frames: int) -> list[Path]:
    if len(paths) <= max_frames:
        return paths
    last_index = len(paths) - 1
    result: list[Path] = []
    used: set[int] = set()
    for index in range(max_frames):
        source_index = round(index * last_index / (max_frames - 1))
        while source_index in used and source_index < last_index:
            source_index += 1
        used.add(source_index)
        result.append(paths[source_index])
    return result


def bounded_grid(width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    y_indices, x_indices = np.indices((height, width))
    return x_indices, y_indices


def build_color_subject_mask(frame_paths: list[Path]) -> Image.Image:
    with Image.open(frame_paths[0]) as first:
        width, height = first.size

    xs, ys = bounded_grid(width, height)
    union = np.zeros((height, width), dtype=bool)

    for path in frame_paths:
        with Image.open(path) as image:
            arr = np.asarray(image.convert("RGB")).astype(np.int16)

        red = arr[:, :, 0]
        green = arr[:, :, 1]
        blue = arr[:, :, 2]
        roi_character = (xs >= width * 0.18) & (xs <= width * 0.96) & (ys >= 0) & (ys <= height * 0.96)
        roi_body = (xs >= width * 0.16) & (xs <= width * 0.86) & (ys >= height * 0.18) & (ys <= height * 0.95)
        roi_duck = (xs >= width * 0.43) & (xs <= width * 0.74) & (ys <= height * 0.19)

        green_hair = (
            roi_character
            & (green >= 95)
            & (green >= red + 14)
            & (blue >= red - 16)
            & ((green + blue) >= (red * 2) + 18)
        )
        pink_clothes = (
            roi_body
            & (red >= 145)
            & (green >= 75)
            & (blue >= 95)
            & (red >= green + 14)
            & (red >= blue + 4)
        )
        skin = (
            roi_body
            & (red >= 150)
            & (green >= 105)
            & (blue >= 95)
            & (red >= green + 10)
            & (green >= blue - 10)
        )
        duck_white = (
            roi_duck
            & (red >= 175)
            & (green >= 165)
            & (blue >= 150)
            & (np.abs(red - green) <= 45)
            & (np.abs(green - blue) <= 55)
        )
        duck_beak = (
            roi_duck
            & (red >= 170)
            & (green >= 95)
            & (blue <= 120)
            & (red >= green + 30)
        )
        union |= (
            green_hair
            | pink_clothes
            | skin
            | duck_white
            | duck_beak
        )

    mask = Image.fromarray(np.where(union, 255, 0).astype(np.uint8), "L")
    # Join nearby hair/face/clothes regions, then fill small holes.
    mask = mask.filter(ImageFilter.MaxFilter(17))
    mask = mask.filter(ImageFilter.MinFilter(13))
    mask = mask.filter(ImageFilter.MaxFilter(9))
    return keep_largest_components(mask, component_count=2, minimum_area_ratio=0.025)


def draw_static_foreground_shapes(mask: Image.Image) -> Image.Image:
    width, height = mask.size
    shaped = mask.copy()
    draw = ImageDraw.Draw(shaped)

    # Desktop/table top. This intentionally keeps the desk as a stable base.
    draw.polygon(
        [
            (0, round(height * 0.775)),
            (width, round(height * 0.765)),
            (width, height),
            (0, height),
        ],
        fill=255,
    )

    # Left monitor and its lower stand/edge.
    draw.polygon(
        [
            (0, round(height * 0.255)),
            (round(width * 0.17), round(height * 0.252)),
            (round(width * 0.245), round(height * 0.81)),
            (round(width * 0.055), round(height * 0.81)),
            (0, round(height * 0.71)),
        ],
        fill=255,
    )

    # Keyboard, mouse and mug areas above the table line.
    draw.rounded_rectangle(
        [
            round(width * 0.02),
            round(height * 0.80),
            round(width * 0.56),
            round(height * 0.945),
        ],
        radius=round(width * 0.025),
        fill=255,
    )
    draw.ellipse(
        [
            round(width * 0.55),
            round(height * 0.82),
            round(width * 0.82),
            round(height * 0.965),
        ],
        fill=255,
    )
    draw.rounded_rectangle(
        [
            round(width * 0.82),
            round(height * 0.685),
            width,
            round(height * 0.965),
        ],
        radius=round(width * 0.055),
        fill=255,
    )

    return shaped


def remove_known_background_leaks(mask: Image.Image) -> Image.Image:
    width, height = mask.size
    trimmed = mask.copy()
    draw = ImageDraw.Draw(trimmed)

    # The generated source video has a fixed blurred room/cabinet sliver on the
    # upper-right side. It is not part of the character, monitor, desk, mug or
    # mouse, and tends to be caught by broad skin/beige color rules.
    draw.rectangle(
        [
            round(width * 0.89),
            0,
            width,
            round(height * 0.69),
        ],
        fill=0,
    )
    draw.polygon(
        [
            (round(width * 0.84), 0),
            (width, 0),
            (width, round(height * 0.50)),
            (round(width * 0.93), round(height * 0.50)),
            (round(width * 0.90), round(height * 0.39)),
            (round(width * 0.84), round(height * 0.29)),
        ],
        fill=0,
    )

    return trimmed


def keep_largest_components(
    mask: Image.Image,
    component_count: int,
    minimum_area_ratio: float,
) -> Image.Image:
    binary = np.asarray(mask) > 0
    height, width = binary.shape
    visited = np.zeros(binary.shape, dtype=bool)
    components: list[list[tuple[int, int]]] = []

    for y in range(height):
        for x in range(width):
            if visited[y, x] or not binary[y, x]:
                continue

            visited[y, x] = True
            queue: deque[tuple[int, int]] = deque([(x, y)])
            component: list[tuple[int, int]] = []

            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                for nx, ny in (
                    (cx - 1, cy),
                    (cx + 1, cy),
                    (cx, cy - 1),
                    (cx, cy + 1),
                ):
                    if nx < 0 or nx >= width or ny < 0 or ny >= height:
                        continue
                    if visited[ny, nx] or not binary[ny, nx]:
                        continue
                    visited[ny, nx] = True
                    queue.append((nx, ny))

            components.append(component)

    if not components:
        return mask

    components.sort(key=len, reverse=True)
    minimum_area = width * height * minimum_area_ratio
    kept = np.zeros(binary.shape, dtype=np.uint8)

    for component in components[:component_count]:
        if len(component) < minimum_area:
            continue
        for x, y in component:
            kept[y, x] = 255

    return Image.fromarray(kept, "L")


def fill_mask_holes(mask: Image.Image) -> Image.Image:
    binary = np.asarray(mask) > 0
    height, width = binary.shape
    outside = np.zeros(binary.shape, dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        for y in (0, height - 1):
            if not binary[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if not binary[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((x, y))

    while queue:
        cx, cy = queue.popleft()
        for nx, ny in (
            (cx - 1, cy),
            (cx + 1, cy),
            (cx, cy - 1),
            (cx, cy + 1),
        ):
            if nx < 0 or nx >= width or ny < 0 or ny >= height:
                continue
            if binary[ny, nx] or outside[ny, nx]:
                continue
            outside[ny, nx] = True
            queue.append((nx, ny))

    filled = binary | ~outside
    return Image.fromarray(np.where(filled, 255, 0).astype(np.uint8), "L")


def build_foreground_mask(frame_paths: list[Path], feather: float) -> Image.Image:
    mask = build_color_subject_mask(frame_paths)
    mask = fill_mask_holes(mask)
    mask = draw_static_foreground_shapes(mask)
    # Make the mask stable and less jagged without causing frame-to-frame alpha shimmer.
    mask = mask.filter(ImageFilter.MaxFilter(5))
    mask = mask.filter(ImageFilter.MinFilter(3))
    mask = remove_known_background_leaks(mask)
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    return mask


def patch_watermark(image: Image.Image) -> Image.Image:
    cleaned = image.convert("RGB")
    arr = np.asarray(cleaned).copy()
    height, width, _ = arr.shape
    left = round(width * 0.90)
    top = round(height * 0.90)
    right = width
    bottom = height
    region = arr[top:bottom, left:right]

    if region.size == 0:
        return cleaned

    bright = (
        (region[:, :, 0] > 165)
        & (region[:, :, 1] > 155)
        & (region[:, :, 2] > 140)
    )
    if not bright.any():
        return cleaned

    blurred = np.asarray(cleaned.filter(ImageFilter.GaussianBlur(10)))
    region_blur = blurred[top:bottom, left:right]
    region[bright] = region_blur[bright]
    arr[top:bottom, left:right] = region
    return Image.fromarray(arr, "RGB")


def refine_alpha_with_frame_colors(frame: Image.Image, mask: Image.Image) -> Image.Image:
    rgb = np.asarray(frame.convert("RGB")).astype(np.int16)
    alpha = np.asarray(mask.convert("L")).copy()
    height, width, _ = rgb.shape
    xs, ys = bounded_grid(width, height)

    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]

    green_hair = (
        (green >= 95)
        & (green >= red + 12)
        & (blue >= red - 18)
        & ((green + blue) >= (red * 2) + 14)
    )
    mint_highlight = (
        (green >= 145)
        & (blue >= 115)
        & (green >= red - 4)
        & (xs >= width * 0.52)
        & (ys <= height * 0.72)
    )
    pink_or_flower = (
        (red >= 145)
        & (green >= 70)
        & (blue >= 125)
        & (red >= green + 10)
        & (red >= blue - 6)
        & (ys >= height * 0.18)
    )
    skin = (
        (red >= 150)
        & (green >= 105)
        & (blue >= 90)
        & (red >= green + 8)
        & (xs <= width * 0.82)
        & (ys >= height * 0.20)
        & (ys <= height * 0.82)
    )
    duck = (
        (xs >= width * 0.42)
            & (xs <= width * 0.74)
        & (ys <= height * 0.20)
        & (
            (
                (red >= 175)
                & (green >= 160)
                & (blue >= 140)
                & (np.abs(red - green) <= 55)
            )
            | ((red >= 170) & (green >= 90) & (blue <= 110))
        )
    )
    foreground_color = green_hair | mint_highlight | pink_or_flower | duck

    right_room_leak_zone = (
        (xs >= width * 0.78)
        & (ys <= height * 0.69)
    )
    upper_right_wall_zone = (
        (xs >= width * 0.70)
        & (ys <= height * 0.46)
    )
    leak_zone = right_room_leak_zone | upper_right_wall_zone
    alpha[leak_zone & ~foreground_color] = 0

    return Image.fromarray(alpha.astype(np.uint8), "L")


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    return image.getchannel("A").point(lambda value: 255 if value > 8 else 0).getbbox()


def resize_frame(image: Image.Image, canvas_size: int) -> Image.Image:
    if image.width == canvas_size and image.height == canvas_size:
        return image
    return image.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)


def save_apng(frames: list[Image.Image], output_path: Path, fps: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(1, round(1000 / fps))
    first, rest = frames[0], frames[1:]
    first.save(
        output_path,
        save_all=True,
        append_images=rest,
        duration=duration,
        loop=0,
        format="PNG",
        disposal=2,
        blend=0,
        optimize=False,
    )


def make_contact_sheet(paths: list[Path], output_path: Path, columns: int = 6) -> None:
    thumbs: list[Image.Image] = []
    for path in paths:
        with Image.open(path) as image:
            thumb = image.convert("RGBA")
        thumb.thumbnail((160, 160), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (160, 160), (32, 32, 32, 255))
        canvas.alpha_composite(thumb, ((160 - thumb.width) // 2, (160 - thumb.height) // 2))
        thumbs.append(canvas)

    rows = math.ceil(len(thumbs) / columns)
    sheet = Image.new("RGBA", (columns * 160, rows * 160), (24, 24, 24, 255))
    for index, thumb in enumerate(thumbs):
        x = (index % columns) * 160
        y = (index // columns) * 160
        sheet.alpha_composite(thumb, (x, y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Turn a fixed-camera generated video into a transparent APNG desktop-pet candidate."
    )
    parser.add_argument("--input-video", required=True)
    parser.add_argument("--out", default="assets/generated/midori-run/duck-run.png")
    parser.add_argument("--work-dir", default="test-output/midori-run")
    parser.add_argument("--report", default="assets/generated/midori-run/duck-run-report.json")
    parser.add_argument("--fps", type=int, default=12)
    parser.add_argument("--max-frames", type=int, default=48)
    parser.add_argument("--canvas-size", type=int, default=512)
    parser.add_argument("--ffmpeg-exe", default="ffmpeg")
    parser.add_argument("--feather", type=float, default=1.2)
    parser.add_argument("--no-watermark-patch", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_video = Path(args.input_video)
    if not input_video.exists():
        raise SystemExit(f"Missing input video: {input_video}")
    if args.fps < 1:
        raise SystemExit("--fps must be positive")
    if args.max_frames < 2:
        raise SystemExit("--max-frames must be at least 2")
    if args.canvas_size < 128:
        raise SystemExit("--canvas-size must be at least 128")

    work_dir = safe_project_path(PROJECT_ROOT / args.work_dir)
    raw_dir = work_dir / "raw-frames"
    cutout_dir = work_dir / "cutout-frames"
    recreate_dir(raw_dir)
    recreate_dir(cutout_dir)

    extracted = run_ffmpeg_extract(
        input_video=input_video,
        raw_dir=raw_dir,
        fps=args.fps,
        ffmpeg_exe=args.ffmpeg_exe,
    )
    selected = choose_evenly(extracted, args.max_frames)
    mask = build_foreground_mask(selected, feather=args.feather)
    mask_path = work_dir / "foreground-mask.png"
    mask.save(mask_path)

    frames: list[Image.Image] = []
    bboxes: list[tuple[int, int, int, int]] = []
    cutout_paths: list[Path] = []

    for index, path in enumerate(selected):
        with Image.open(path) as source:
            frame = source.convert("RGB")
        if not args.no_watermark_patch:
            frame = patch_watermark(frame)
        frame_mask = refine_alpha_with_frame_colors(frame, mask)
        rgba = frame.convert("RGBA")
        rgba.putalpha(frame_mask)
        resized = resize_frame(rgba, args.canvas_size)
        cutout_path = cutout_dir / f"frame-{index:03d}.png"
        resized.save(cutout_path)
        cutout_paths.append(cutout_path)
        frames.append(resized)
        bbox = alpha_bbox(resized)
        if bbox:
            bboxes.append(bbox)

    output_path = safe_project_path(PROJECT_ROOT / args.out)
    save_apng(frames, output_path, fps=args.fps)
    make_contact_sheet(
        cutout_paths[: min(12, len(cutout_paths))],
        work_dir / "cutout-contact-sheet.png",
    )

    centers = [((left + right) / 2, (top + bottom) / 2) for left, top, right, bottom in bboxes]
    bottoms = [bottom for _, _, _, bottom in bboxes]
    report = {
        "inputVideo": str(input_video),
        "output": str(output_path),
        "workDir": str(work_dir),
        "sourceExtractedFrames": len(extracted),
        "outputFrames": len(frames),
        "fps": args.fps,
        "canvasSize": args.canvas_size,
        "mask": str(mask_path),
        "contactSheet": str(work_dir / "cutout-contact-sheet.png"),
        "alphaBBoxFirst": list(bboxes[0]) if bboxes else None,
        "alphaBBoxLast": list(bboxes[-1]) if bboxes else None,
        "alphaCenterRangeX": round(max(x for x, _ in centers) - min(x for x, _ in centers), 2) if centers else None,
        "alphaCenterRangeY": round(max(y for _, y in centers) - min(y for _, y in centers), 2) if centers else None,
        "alphaBottomRange": max(bottoms) - min(bottoms) if bottoms else None,
        "bytes": output_path.stat().st_size,
    }
    report_path = safe_project_path(PROJECT_ROOT / args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
