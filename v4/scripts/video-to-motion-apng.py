from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_ROOT = Path(__file__).resolve().parent


def load_encoder_helpers():
    helper_path = SCRIPT_ROOT / "encode-animated-image.py"
    spec = importlib.util.spec_from_file_location("motion_encoder", helper_path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Unable to load helper script: {helper_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def safe_temp_root(path: Path) -> Path:
    resolved = path.resolve()
    project = PROJECT_ROOT.resolve()
    if resolved == project or project not in resolved.parents:
        raise RuntimeError(f"Unsafe temporary directory: {resolved}")
    return resolved


def recreate_dir(path: Path) -> None:
    resolved = safe_temp_root(path)
    if resolved.exists():
        shutil.rmtree(resolved)
    resolved.mkdir(parents=True, exist_ok=True)


def run_ffmpeg_extract(
    input_path: Path,
    output_dir: Path,
    fps: int,
    canvas_size: int,
    background: tuple[int, int, int],
    start: float | None,
    duration: float | None,
    ffmpeg_exe: str,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    pattern = output_dir / "frame-%05d.png"
    bg_hex = "".join(f"{channel:02x}" for channel in background)
    filter_chain = (
        f"fps={fps},"
        f"scale={canvas_size}:{canvas_size}:force_original_aspect_ratio=decrease,"
        f"pad={canvas_size}:{canvas_size}:(ow-iw)/2:(oh-ih)/2:color=0x{bg_hex},"
        "format=rgba"
    )

    command = [
        ffmpeg_exe,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    if start is not None:
        command.extend(["-ss", str(start)])
    command.extend(["-i", str(input_path)])
    if duration is not None:
        command.extend(["-t", str(duration)])
    command.extend(["-vf", filter_chain, str(pattern)])

    subprocess.run(command, check=True)
    return sorted(output_dir.glob("frame-*.png"))


def load_frame_sequence(
    frames_dir: Path,
    pattern: str,
    output_dir: Path,
    canvas_size: int,
    background: tuple[int, int, int],
) -> list[Path]:
    source_paths = sorted(frames_dir.glob(pattern))
    if not source_paths:
        raise RuntimeError(f"No frames matched {frames_dir / pattern}")

    output_dir.mkdir(parents=True, exist_ok=True)
    output_paths: list[Path] = []
    background_rgba = (*background, 255)

    for index, source_path in enumerate(source_paths):
        with Image.open(source_path) as image:
            frame = image.convert("RGBA")
        frame.thumbnail((canvas_size, canvas_size), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (canvas_size, canvas_size), background_rgba)
        x = round((canvas_size - frame.width) / 2)
        y = round((canvas_size - frame.height) / 2)
        canvas.alpha_composite(frame, (x, y))
        output_path = output_dir / f"frame-{index:05d}.png"
        canvas.save(output_path)
        output_paths.append(output_path)

    return output_paths


def choose_evenly(paths: list[Path], max_frames: int) -> list[Path]:
    if len(paths) <= max_frames:
        return paths
    if max_frames < 2:
        raise RuntimeError("--max-frames must be at least 2")
    last_index = len(paths) - 1
    chosen: list[Path] = []
    used: set[int] = set()
    for index in range(max_frames):
        source_index = round(index * last_index / (max_frames - 1))
        while source_index in used and source_index + 1 <= last_index:
            source_index += 1
        used.add(source_index)
        chosen.append(paths[source_index])
    return chosen


def find_anchor(
    image: Image.Image,
    anchor_color: tuple[int, int, int],
    tolerance: int,
    search_box: tuple[int, int, int, int],
    min_pixels: int,
) -> dict:
    frame = image.convert("RGB")
    pixels = frame.load()
    left, top, right, bottom = search_box
    right = min(right, frame.width)
    bottom = min(bottom, frame.height)
    tolerance_squared = tolerance * tolerance
    xs: list[int] = []
    ys: list[int] = []
    red_target, green_target, blue_target = anchor_color

    for y in range(top, bottom):
        for x in range(left, right):
            red, green, blue = pixels[x, y]
            distance = (
                (red - red_target) ** 2
                + (green - green_target) ** 2
                + (blue - blue_target) ** 2
            )
            if distance <= tolerance_squared:
                xs.append(x)
                ys.append(y)

    if len(xs) < min_pixels:
        raise RuntimeError(
            "Anchor marker not found. Make sure the video contains a static "
            f"#{red_target:02x}{green_target:02x}{blue_target:02x} marker "
            f"inside {search_box}; matched {len(xs)} pixels."
        )

    return {
        "count": len(xs),
        "bbox": [min(xs), min(ys), max(xs) + 1, max(ys) + 1],
        "center": [sum(xs) / len(xs), sum(ys) / len(ys)],
    }


def shift_frame(
    image: Image.Image,
    dx: int,
    dy: int,
    background: tuple[int, int, int],
) -> Image.Image:
    source = image.convert("RGBA")
    width, height = source.size
    canvas = Image.new("RGBA", source.size, (*background, 255))
    source_left = max(0, -dx)
    source_top = max(0, -dy)
    source_right = min(width, width - dx)
    source_bottom = min(height, height - dy)

    if source_right <= source_left or source_bottom <= source_top:
        return canvas

    cropped = source.crop((source_left, source_top, source_right, source_bottom))
    canvas.alpha_composite(cropped, (source_left + dx, source_top + dy))
    return canvas


def fill_box(
    image: Image.Image,
    box: tuple[int, int, int, int],
    color: tuple[int, int, int],
) -> None:
    pixels = image.load()
    left, top, right, bottom = box
    left = max(0, left)
    top = max(0, top)
    right = min(image.width, right)
    bottom = min(image.height, bottom)
    for y in range(top, bottom):
        for x in range(left, right):
            pixels[x, y] = (*color, 255)


def chroma_to_alpha(
    image: Image.Image,
    key_color: tuple[int, int, int],
    tolerance: int,
) -> Image.Image:
    cleaned = image.convert("RGBA")
    pixels = cleaned.load()
    tolerance_squared = tolerance * tolerance
    key_red, key_green, key_blue = key_color

    for y in range(cleaned.height):
        for x in range(cleaned.width):
            red, green, blue, alpha = pixels[x, y]
            if not alpha:
                continue
            distance = (
                (red - key_red) ** 2
                + (green - key_green) ** 2
                + (blue - key_blue) ** 2
            )
            if distance <= tolerance_squared:
                pixels[x, y] = (0, 0, 0, 0)

    return cleaned


def alpha_bbox(image: Image.Image, threshold: int = 4) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    return mask.getbbox()


def subject_padding(
    bbox: tuple[int, int, int, int],
    width: int,
    height: int,
) -> dict[str, int]:
    left, top, right, bottom = bbox
    return {
        "left": left,
        "top": top,
        "right": width - right,
        "bottom": height - bottom,
        "minimum": min(left, top, width - right, height - bottom),
    }


def validate_anchor_stability(
    anchors: list[dict],
    max_size_drift: int,
    max_count_ratio: float,
) -> dict:
    widths = [anchor["bbox"][2] - anchor["bbox"][0] for anchor in anchors]
    heights = [anchor["bbox"][3] - anchor["bbox"][1] for anchor in anchors]
    counts = [anchor["count"] for anchor in anchors]
    count_low = min(counts)
    count_high = max(counts)
    count_ratio = 0.0 if count_high == 0 else 1 - (count_low / count_high)
    width_drift = max(widths) - min(widths)
    height_drift = max(heights) - min(heights)

    if width_drift > max_size_drift or height_drift > max_size_drift:
        raise RuntimeError(
            "Anchor marker changed size too much across frames: "
            f"width drift {width_drift}px, height drift {height_drift}px. "
            "Use a larger, solid, unchanging marker."
        )
    if count_ratio > max_count_ratio:
        raise RuntimeError(
            "Anchor marker pixel count changed too much across frames: "
            f"{count_ratio:.2%}. Use a solid, high-contrast marker."
        )

    return {
        "widthDrift": width_drift,
        "heightDrift": height_drift,
        "countRatio": round(count_ratio, 4),
    }


def save_apng(frames: list[Image.Image], output: Path, fps: int) -> None:
    if len(frames) < 2:
        raise RuntimeError("At least two frames are required for animation")
    output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        output,
        format="PNG",
        save_all=True,
        append_images=frames[1:],
        duration=round(1000 / fps),
        loop=0,
        disposal=2,
        blend=0,
        optimize=False,
    )


def build_anchor_clear_box(
    anchor_bbox: list[int],
    padding: int,
    canvas_size: int,
) -> tuple[int, int, int, int]:
    left, top, right, bottom = anchor_bbox
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(canvas_size, right + padding),
        min(canvas_size, bottom + padding),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert an anchored video or extracted frame sequence into a "
            "transparent, aligned APNG motion asset."
        )
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input-video")
    source.add_argument("--frames-dir")
    parser.add_argument("--frames-pattern", default="*.png")
    parser.add_argument("--out", required=True)
    parser.add_argument("--report")
    parser.add_argument("--tmp-dir", default=".motion-video-build")
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--max-frames", type=int, default=48)
    parser.add_argument("--canvas-size", type=int, default=512)
    parser.add_argument("--start", type=float)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--ffmpeg-exe", default="ffmpeg")
    parser.add_argument(
        "--anchor-color",
        type=parse_color,
        default=parse_color("#00ffff"),
    )
    parser.add_argument("--anchor-tolerance", type=int, default=72)
    parser.add_argument(
        "--anchor-search",
        type=parse_box,
        default=parse_box("0,0,160,160"),
    )
    parser.add_argument("--anchor-min-pixels", type=int, default=24)
    parser.add_argument("--anchor-padding", type=int, default=14)
    parser.add_argument("--max-anchor-size-drift", type=int, default=8)
    parser.add_argument("--max-anchor-count-ratio", type=float, default=0.35)
    parser.add_argument(
        "--background-color",
        type=parse_color,
        default=parse_color("#ff00ff"),
    )
    parser.add_argument("--chroma-tolerance", type=int, default=96)
    parser.add_argument("--min-subject-padding", type=int, default=24)
    parser.add_argument("--no-cleanup", action="store_true")
    parser.add_argument("--quiet", action="store_true", help="Do not print the full JSON report to stdout")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.fps < 1:
        raise SystemExit("--fps must be positive")
    if args.max_frames < 2:
        raise SystemExit("--max-frames must be at least 2")
    if args.canvas_size < 128:
        raise SystemExit("--canvas-size must be at least 128")

    tmp_root = safe_temp_root(PROJECT_ROOT / args.tmp_dir)
    extract_dir = tmp_root / "extracted"
    recreate_dir(tmp_root)

    if args.input_video:
        input_path = Path(args.input_video)
        if not input_path.exists():
            raise SystemExit(f"Missing video: {input_path}")
        source_paths = run_ffmpeg_extract(
            input_path=input_path,
            output_dir=extract_dir,
            fps=args.fps,
            canvas_size=args.canvas_size,
            background=args.background_color,
            start=args.start,
            duration=args.duration,
            ffmpeg_exe=args.ffmpeg_exe,
        )
    else:
        frames_dir = Path(args.frames_dir)
        if not frames_dir.exists():
            raise SystemExit(f"Missing frame directory: {frames_dir}")
        source_paths = load_frame_sequence(
            frames_dir=frames_dir,
            pattern=args.frames_pattern,
            output_dir=extract_dir,
            canvas_size=args.canvas_size,
            background=args.background_color,
        )

    if len(source_paths) < 2:
        raise SystemExit("Need at least two extracted frames")

    selected_paths = choose_evenly(source_paths, args.max_frames)
    encoder = load_encoder_helpers()
    anchors: list[dict] = []
    shifted_frames: list[Image.Image] = []
    cleaned_frames: list[Image.Image] = []

    for path in selected_paths:
        with Image.open(path) as image:
            frame = image.convert("RGBA")
        anchors.append(
            find_anchor(
                image=frame,
                anchor_color=args.anchor_color,
                tolerance=args.anchor_tolerance,
                search_box=args.anchor_search,
                min_pixels=args.anchor_min_pixels,
            )
        )

    anchor_stability = validate_anchor_stability(
        anchors,
        max_size_drift=args.max_anchor_size_drift,
        max_count_ratio=args.max_anchor_count_ratio,
    )
    reference_center = anchors[0]["center"]
    reference_bbox = anchors[0]["bbox"]
    clear_box = build_anchor_clear_box(
        reference_bbox,
        args.anchor_padding,
        args.canvas_size,
    )
    shifts: list[dict[str, int]] = []
    paddings: list[dict[str, int]] = []

    for path, anchor in zip(selected_paths, anchors):
        with Image.open(path) as image:
            frame = image.convert("RGBA")
        center_x, center_y = anchor["center"]
        dx = round(reference_center[0] - center_x)
        dy = round(reference_center[1] - center_y)
        shifted = shift_frame(frame, dx, dy, args.background_color)
        fill_box(shifted, clear_box, args.background_color)
        transparent = chroma_to_alpha(
            shifted,
            key_color=args.background_color,
            tolerance=args.chroma_tolerance,
        )

        if args.no_cleanup:
            cleaned = transparent
        else:
            cleaned, _ = encoder.remove_side_fragments(transparent)
            cleaned = encoder.remove_magenta_fringe(cleaned)
            cleaned, _ = encoder.remove_dark_green_edge_halo(cleaned, 18)
            cleaned, _ = encoder.remove_dark_green_shadow(cleaned)

        bbox = alpha_bbox(cleaned)
        if not bbox:
            raise RuntimeError(f"No visible subject remains after cleanup: {path}")
        padding = subject_padding(bbox, cleaned.width, cleaned.height)
        if padding["minimum"] < args.min_subject_padding:
            raise RuntimeError(
                f"Subject is too close to the canvas edge in {path}: "
                f"minimum padding {padding['minimum']}px, expected at least "
                f"{args.min_subject_padding}px. Generate the video with more "
                "empty space around the character."
            )

        shifted_frames.append(shifted)
        cleaned_frames.append(cleaned)
        shifts.append({"dx": dx, "dy": dy})
        paddings.append(padding)

    output_path = Path(args.out)
    save_apng(cleaned_frames, output_path, args.fps)

    max_abs_dx = max(abs(shift["dx"]) for shift in shifts)
    max_abs_dy = max(abs(shift["dy"]) for shift in shifts)
    report = {
        "sourceFrameCount": len(source_paths),
        "outputFrameCount": len(cleaned_frames),
        "fps": args.fps,
        "canvasSize": args.canvas_size,
        "anchorColor": "#%02x%02x%02x" % args.anchor_color,
        "anchorSearch": list(args.anchor_search),
        "anchorClearBox": list(clear_box),
        "anchorStability": anchor_stability,
        "minSubjectPadding": min(padding["minimum"] for padding in paddings),
        "subjectPadding": paddings,
        "maxAbsShift": [max_abs_dx, max_abs_dy],
        "anchors": anchors,
        "shifts": shifts,
        "output": str(output_path),
        "bytes": output_path.stat().st_size,
    }

    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    if not args.quiet:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    shutil.rmtree(tmp_root)


if __name__ == "__main__":
    main()
