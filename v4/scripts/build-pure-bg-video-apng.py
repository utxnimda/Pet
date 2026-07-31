from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


PROJECT_ROOT = Path(__file__).resolve().parent.parent


BackgroundModel = tuple[int, int, int] | np.ndarray


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


def parse_color(value: str) -> tuple[int, int, int]:
    normalized = value.strip()
    if normalized.startswith("#"):
        normalized = normalized[1:]
    if len(normalized) != 6:
        raise argparse.ArgumentTypeError("color must be #rrggbb")
    try:
        return (
            int(normalized[0:2], 16),
            int(normalized[2:4], 16),
            int(normalized[4:6], 16),
        )
    except ValueError as error:
        raise argparse.ArgumentTypeError("color must be hexadecimal") from error


def estimate_background_color(paths: list[Path], sample_size: int = 80) -> tuple[int, int, int]:
    samples: list[np.ndarray] = []
    for path in paths[: min(len(paths), 8)]:
        with Image.open(path) as image:
            arr = np.asarray(image.convert("RGB"))
        height, width, _ = arr.shape
        size = min(sample_size, width // 4, height // 4)
        # The top corners are safest for this source: the table touches the
        # bottom edge and the monitor touches the left edge.
        samples.extend(
            [
                arr[:size, :size].reshape(-1, 3),
                arr[:size, width - size :].reshape(-1, 3),
                arr[: max(8, size // 4), :].reshape(-1, 3),
            ]
        )
    stacked = np.concatenate(samples, axis=0)
    color = np.median(stacked, axis=0).round().astype(int)
    return int(color[0]), int(color[1]), int(color[2])


def estimate_background_field(image: Image.Image, border_width: int = 28) -> np.ndarray:
    """Fit a smooth 2D color surface from the unobstructed frame border."""
    rgb = np.asarray(image.convert("RGB")).astype(np.float32)
    height, width, _ = rgb.shape
    border_width = max(8, min(border_width, width // 6, height // 6))
    y_indices, x_indices = np.indices((height, width))
    border = (
        (x_indices < border_width)
        | (x_indices >= width - border_width)
        | (y_indices < border_width)
        | (y_indices >= height - border_width)
    )

    sample = border & ((x_indices % 3) == 0) & ((y_indices % 3) == 0)
    sample_y = (y_indices[sample].astype(np.float32) / max(1, height - 1)) * 2 - 1
    sample_x = (x_indices[sample].astype(np.float32) / max(1, width - 1)) * 2 - 1
    sample_rgb = rgb[sample]
    features = np.column_stack(
        [
            np.ones_like(sample_x),
            sample_x,
            sample_y,
            sample_x * sample_x,
            sample_y * sample_y,
            sample_x * sample_y,
        ]
    )

    keep = np.ones(sample_x.shape, dtype=bool)
    coefficients = np.zeros((features.shape[1], 3), dtype=np.float32)
    for _ in range(3):
        coefficients, *_ = np.linalg.lstsq(features[keep], sample_rgb[keep], rcond=None)
        fitted = features @ coefficients
        residual = np.sqrt(((sample_rgb - fitted) ** 2).sum(axis=1))
        cutoff = max(8.0, float(np.percentile(residual[keep], 92)))
        updated = residual <= cutoff
        if np.array_equal(updated, keep):
            break
        keep = updated

    full_y = (y_indices.astype(np.float32) / max(1, height - 1)) * 2 - 1
    full_x = (x_indices.astype(np.float32) / max(1, width - 1)) * 2 - 1
    full_features = np.stack(
        [
            np.ones_like(full_x),
            full_x,
            full_y,
            full_x * full_x,
            full_y * full_y,
            full_x * full_y,
        ],
        axis=2,
    )
    field = full_features @ coefficients
    return np.clip(field, 0, 255).astype(np.float32)


def connected_background(distance: np.ndarray, tolerance: float) -> np.ndarray:
    candidate = distance <= tolerance
    height, width = candidate.shape
    visited = np.zeros(candidate.shape, dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        for y in (0, height - 1):
            if candidate[y, x] and not visited[y, x]:
                visited[y, x] = True
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if candidate[y, x] and not visited[y, x]:
                visited[y, x] = True
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
            if visited[ny, nx] or not candidate[ny, nx]:
                continue
            visited[ny, nx] = True
            queue.append((nx, ny))

    return visited


def make_alpha_mask(
    image: Image.Image,
    background: BackgroundModel,
    tolerance: float,
    fringe_tolerance: float,
    expand: int,
    feather: float,
) -> Image.Image:
    arr = np.asarray(image.convert("RGB")).astype(np.float32)
    bg = np.asarray(background, dtype=np.float32)
    distance = np.sqrt(((arr - bg) ** 2).sum(axis=2))

    solid_bg = connected_background(distance, tolerance)
    fringe_bg = connected_background(distance, fringe_tolerance)

    solid_image = Image.fromarray(np.where(solid_bg, 255, 0).astype(np.uint8), "L")
    if expand > 0:
        for _ in range(expand):
            solid_image = solid_image.filter(ImageFilter.MaxFilter(3))
    solid_bg = np.asarray(solid_image) > 0

    alpha = np.full(distance.shape, 255, dtype=np.float32)
    alpha[solid_bg] = 0

    fringe = fringe_bg & ~solid_bg & (distance < fringe_tolerance)
    if fringe.any() and fringe_tolerance > tolerance:
        alpha[fringe] = np.minimum(
            alpha[fringe],
            ((distance[fringe] - tolerance) / (fringe_tolerance - tolerance)) * 255,
        )

    alpha = np.clip(alpha, 0, 255).astype(np.uint8)
    mask = Image.fromarray(alpha, "L")
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    return mask


def decontaminate_edges(
    image: Image.Image,
    alpha: Image.Image,
    background: BackgroundModel,
    strength: float,
) -> Image.Image:
    if strength <= 0:
        rgba = image.convert("RGBA")
        rgba.putalpha(alpha)
        return rgba

    rgb = np.asarray(image.convert("RGB")).astype(np.float32)
    a = np.asarray(alpha).astype(np.float32)
    bg = np.asarray(background, dtype=np.float32)

    edge = (a > 0) & (a < 255)
    if edge.any():
        correction = (1 - (a[edge] / 255.0))[:, None] * strength
        edge_background = bg[edge] if bg.ndim == 3 else bg
        rgb[edge] = np.clip(
            rgb[edge] + ((rgb[edge] - edge_background) * correction),
            0,
            255,
        )

    rgba = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")
    rgba.putalpha(alpha)
    return rgba


def defringe_edge_colors(
    image: Image.Image,
    background: BackgroundModel,
    width: int,
    strength: float,
    color_distance: float,
) -> Image.Image:
    """Replace baked-in background-colored rim pixels with nearby foreground color.

    Video generators commonly render a light outline around the subject even
    before chroma removal. Alpha matting alone cannot remove that outline
    because those pixels are fully opaque. Build an inward foreground color
    field and use it only for light/background-like pixels in a narrow band at
    the transparent edge.
    """
    if width <= 0 or strength <= 0:
        return image

    rgba = np.asarray(image.convert("RGBA")).copy()
    rgb = rgba[:, :, :3].astype(np.float32)
    alpha = rgba[:, :, 3]
    visible = alpha > 8
    if not visible.any():
        return image

    # Erode the visible subject to find reliable colors just inside the edge.
    core_image = Image.fromarray((visible * 255).astype(np.uint8), "L")
    for _ in range(width):
        core_image = core_image.filter(ImageFilter.MinFilter(3))
    core = np.asarray(core_image) > 0

    propagated = rgb.copy()
    known = core.copy()
    for _ in range(width + 2):
        if np.all(known | ~visible):
            break

        padded_known = np.pad(known, 1, mode="constant", constant_values=False)
        padded_rgb = np.pad(propagated, ((1, 1), (1, 1), (0, 0)), mode="edge")
        color_sum = np.zeros_like(rgb)
        neighbor_count = np.zeros(visible.shape, dtype=np.float32)

        for dy in range(3):
            for dx in range(3):
                if dx == 1 and dy == 1:
                    continue
                neighbor_known = padded_known[dy : dy + visible.shape[0], dx : dx + visible.shape[1]]
                neighbor_rgb = padded_rgb[dy : dy + visible.shape[0], dx : dx + visible.shape[1]]
                color_sum += neighbor_rgb * neighbor_known[:, :, None]
                neighbor_count += neighbor_known

        fill = visible & ~known & (neighbor_count > 0)
        if not fill.any():
            break
        propagated[fill] = color_sum[fill] / neighbor_count[fill, None]
        known[fill] = True

    edge_band = visible & ~core & known
    bg = np.asarray(background, dtype=np.float32)
    distance_to_bg = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    original_luma = rgb.mean(axis=2)
    propagated_luma = propagated.mean(axis=2)

    # Background-like pixels and unnaturally bright rim pixels are the visible
    # halo. Preserve dark line art even when it sits at the silhouette edge.
    halo = edge_band & (
        (distance_to_bg <= color_distance)
        | (original_luma >= propagated_luma + 18)
    )
    blend = float(np.clip(strength, 0, 1))
    rgb[halo] = (rgb[halo] * (1 - blend)) + (propagated[halo] * blend)
    rgba[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def neutralize_left_prop_halo(
    image: Image.Image,
    width: int,
) -> Image.Image:
    """Replace blue matte glow around the rigid gray monitor with monitor color."""
    if width <= 0:
        return image

    rgba = np.asarray(image.convert("RGBA")).copy()
    rgb = rgba[:, :, :3].astype(np.float32)
    alpha = rgba[:, :, 3]
    height, canvas_width = alpha.shape
    y_indices, x_indices = np.indices(alpha.shape)
    left_prop_region = (
        (x_indices <= canvas_width * 0.23)
        & (y_indices >= height * 0.24)
        & (y_indices <= height * 0.90)
    )
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    neutral_core = (
        left_prop_region
        & (alpha >= 96)
        & ((maximum - minimum) <= 48)
        & (rgb.mean(axis=2) >= 65)
    )
    visible_image = Image.fromarray(
        ((alpha > 8) * 255).astype(np.uint8),
        "L",
    )
    inner_visible = np.asarray(
        visible_image.filter(ImageFilter.MinFilter(15))
    ) > 0
    edge_target = left_prop_region & (alpha > 2) & ~inner_visible
    if not neutral_core.any() or not edge_target.any():
        return image

    neutral_core_image = Image.fromarray(
        (neutral_core * 255).astype(np.uint8),
        "L",
    ).filter(ImageFilter.MinFilter(5))
    neutral_core = np.asarray(neutral_core_image) > 0
    propagated = rgb.copy()
    known = neutral_core.copy()
    height, width_pixels = alpha.shape

    for _ in range(width):
        padded_known = np.pad(known, 1, mode="constant", constant_values=False)
        padded_rgb = np.pad(
            propagated,
            ((1, 1), (1, 1), (0, 0)),
            mode="edge",
        )
        color_sum = np.zeros_like(rgb)
        neighbor_count = np.zeros(alpha.shape, dtype=np.float32)

        for dy in range(3):
            for dx in range(3):
                if dx == 1 and dy == 1:
                    continue
                neighbor_known = padded_known[
                    dy : dy + height,
                    dx : dx + width_pixels,
                ]
                neighbor_rgb = padded_rgb[
                    dy : dy + height,
                    dx : dx + width_pixels,
                ]
                color_sum += neighbor_rgb * neighbor_known[:, :, None]
                neighbor_count += neighbor_known

        fill = edge_target & ~known & (neighbor_count > 0)
        if not fill.any():
            break
        propagated[fill] = color_sum[fill] / neighbor_count[fill, None]
        known[fill] = True

    replace = edge_target & known
    rgb[replace] = propagated[replace]
    rgba[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def remove_right_gray_background_prop(frame: Image.Image, alpha: Image.Image) -> Image.Image:
    rgb = np.asarray(frame.convert("RGB")).astype(np.int16)
    a = np.asarray(alpha).copy()
    height, width, _ = rgb.shape
    y_indices, x_indices = np.indices((height, width))

    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    mean = rgb.mean(axis=2)

    chair_zone = (
        (x_indices >= width * 0.70)
        & (y_indices >= height * 0.27)
        & (y_indices < height)
    )
    gray_prop = (
        chair_zone
        & ((maximum - minimum) <= 80)
        & (mean >= 75)
    )
    green_hair = (
        (green >= red + 12)
        & (green >= 95)
        & ((green + blue) >= (red * 2) + 14)
    )
    a[gray_prop & ~green_hair] = 0
    return Image.fromarray(a.astype(np.uint8), "L")


def remove_bottom_right_watermark(alpha: Image.Image) -> Image.Image:
    cleaned = np.asarray(alpha).copy()
    height, width = cleaned.shape
    cleaned[round(height * 0.90) :, round(width * 0.90) :] = 0
    return Image.fromarray(cleaned.astype(np.uint8), "L")


def remove_edge_background_pockets(
    frame: Image.Image,
    alpha: Image.Image,
    background: BackgroundModel,
    tolerance: float,
) -> Image.Image:
    """Clear enclosed background-colored gaps and chromatic matte shadows."""
    rgb = np.asarray(frame.convert("RGB")).astype(np.float32)
    bg = np.asarray(background, dtype=np.float32)
    distance = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    cleaned = np.asarray(alpha).copy()
    height, width = cleaned.shape
    _, x_indices = np.indices((height, width))
    side_zone = (x_indices <= width * 0.08) | (x_indices >= width * 0.72)
    cleaned[side_zone & (distance <= tolerance)] = 0

    # A generated solid-color background can contain cast shadows whose RGB
    # distance is much larger than the flat matte even though their hue is
    # unchanged. Match chromaticity as well when the matte has one clearly
    # dominant channel. This removes blue/green shadow pockets without erasing
    # neutral gray props such as a monitor.
    if bg.ndim == 3:
        representative_bg = np.median(bg.reshape(-1, 3), axis=0)
        bg_sum = np.maximum(bg.sum(axis=2, keepdims=True), 1)
        bg_chromaticity = bg / bg_sum
    else:
        representative_bg = bg
        bg_chromaticity = bg / max(float(bg.sum()), 1)

    representative_chromaticity = representative_bg / max(
        float(representative_bg.sum()),
        1,
    )
    channel_order = np.argsort(representative_chromaticity)
    dominant_channel = int(channel_order[-1])
    dominant_margin = float(
        representative_chromaticity[channel_order[-1]]
        - representative_chromaticity[channel_order[-2]]
    )

    if dominant_margin >= 0.08:
        rgb_sum = np.maximum(rgb.sum(axis=2, keepdims=True), 1)
        rgb_chromaticity = rgb / rgb_sum
        chromatic_distance = np.sqrt(
            ((rgb_chromaticity - bg_chromaticity) ** 2).sum(axis=2)
        )
        rgb_max = rgb.max(axis=2)
        saturation = (rgb_max - rgb.min(axis=2)) / np.maximum(rgb_max, 1)
        same_dominant_channel = rgb.argmax(axis=2) == dominant_channel
        chromatic_matte = (
            same_dominant_channel
            & (saturation >= 0.12)
            & (chromatic_distance <= 0.13)
        )
        cleaned[chromatic_matte] = 0

    return Image.fromarray(cleaned.astype(np.uint8), "L")


def smooth_final_alpha(alpha: Image.Image, radius: float) -> Image.Image:
    """Antialias hard matte-cleanup edges without blurring the RGB subject."""
    if radius <= 0:
        return alpha

    smoothed = np.asarray(
        alpha.filter(ImageFilter.GaussianBlur(radius=radius))
    ).copy()
    smoothed[smoothed <= 2] = 0
    smoothed[smoothed >= 253] = 255
    return Image.fromarray(smoothed.astype(np.uint8), "L")


def smooth_priority_alpha_regions(
    alpha: Image.Image,
    radius: float,
) -> Image.Image:
    """Apply stronger antialiasing to the monitor and lower-right hair edge."""
    if radius <= 0:
        return alpha

    source = np.asarray(alpha).astype(np.float32)
    height, width = source.shape
    y_indices, x_indices = np.indices((height, width))
    priority = (
        (
            (x_indices <= width * 0.28)
            & (y_indices >= height * 0.22)
        )
        | (
            (x_indices >= width * 0.54)
            & (y_indices >= height * 0.42)
        )
    )
    priority_blend = np.asarray(
        Image.fromarray((priority * 255).astype(np.uint8), "L").filter(
            ImageFilter.GaussianBlur(radius=max(4, radius * 4))
        )
    ).astype(np.float32) / 255
    strongly_smoothed = np.asarray(
        alpha.filter(ImageFilter.GaussianBlur(radius=radius))
    ).astype(np.float32)
    result = (
        source * (1 - priority_blend)
        + strongly_smoothed * priority_blend
    )
    result[result <= 2] = 0
    result[result >= 253] = 255
    return Image.fromarray(np.clip(result, 0, 255).astype(np.uint8), "L")


def refine_left_prop_alpha(
    frame: Image.Image,
    alpha: Image.Image,
) -> Image.Image:
    """Rebuild a clean antialiased edge where a blue glow meets the monitor."""
    rgb = np.asarray(frame.convert("RGB")).astype(np.int16)
    source_alpha = np.asarray(alpha).copy()
    height, width = source_alpha.shape
    y_indices, x_indices = np.indices(source_alpha.shape)
    region = (
        (x_indices <= width * 0.30)
        & (y_indices >= height * 0.24)
        & (y_indices <= height * 0.92)
    )
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    neutral_core = (
        region
        & (source_alpha >= 96)
        & ((maximum - minimum) <= 52)
        & (rgb.mean(axis=2) >= 45)
    )
    blue_halo = (
        region
        & (rgb[:, :, 2] >= rgb[:, :, 1] + 7)
        & (rgb[:, :, 2] >= rgb[:, :, 0] + 16)
    )
    if not neutral_core.any() or not blue_halo.any():
        return alpha

    core_image = Image.fromarray((neutral_core * 255).astype(np.uint8), "L")
    core_image = core_image.filter(ImageFilter.MaxFilter(3))
    core_image = core_image.filter(ImageFilter.MinFilter(3))
    expanded = np.asarray(core_image) > 0
    controlled = np.where(expanded, 255, 0).astype(np.uint8)

    for ring_alpha in (208, 144, 80, 32):
        expanded_image = Image.fromarray((expanded * 255).astype(np.uint8), "L")
        next_expanded = np.asarray(
            expanded_image.filter(ImageFilter.MaxFilter(3))
        ) > 0
        ring = next_expanded & ~expanded
        controlled[ring] = ring_alpha
        expanded = next_expanded

    source_alpha[blue_halo] = np.minimum(
        source_alpha[blue_halo],
        controlled[blue_halo],
    )
    return Image.fromarray(source_alpha.astype(np.uint8), "L")


def straighten_left_monitor_edge(
    frame: Image.Image,
    alpha: Image.Image,
) -> Image.Image:
    """Fit a stable straight line to the monitor's long right silhouette edge."""
    rgb = np.asarray(frame.convert("RGB")).astype(np.int16)
    source_alpha = np.asarray(alpha).copy()
    height, width = source_alpha.shape
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    neutral = (
        ((maximum - minimum) <= 55)
        & (rgb.mean(axis=2) >= 50)
    )
    row_samples: list[tuple[int, int]] = []
    left_limit = round(width * 0.25)

    for y in range(round(height * 0.44), round(height * 0.79)):
        xs = np.where(neutral[y, :left_limit] & (source_alpha[y, :left_limit] > 48))[0]
        if not xs.size:
            continue
        right = int(xs.max())
        if width * 0.08 <= right <= width * 0.21:
            row_samples.append((y, right))

    if len(row_samples) < max(20, round(height * 0.08)):
        return alpha

    sample_y = np.asarray([item[0] for item in row_samples], dtype=np.float32)
    sample_x = np.asarray([item[1] for item in row_samples], dtype=np.float32)
    slope, intercept = np.polyfit(sample_y, sample_x, 1)
    residual = sample_x - ((slope * sample_y) + intercept)
    inliers = np.abs(residual - np.median(residual)) <= 3
    if int(inliers.sum()) >= 20:
        slope, intercept = np.polyfit(sample_y[inliers], sample_x[inliers], 1)
        sample_y = sample_y[inliers]

    top = max(0, int(sample_y.min()) - 2)
    bottom = min(height, int(sample_y.max()) + 3)
    for y in range(top, bottom):
        edge = (slope * y) + intercept + 0.75
        start = max(0, int(np.floor(edge)) - 2)
        end = min(left_limit, int(np.ceil(edge)) + 14)
        if end <= start:
            continue
        x_values = np.arange(start, end, dtype=np.float32)
        coverage = np.clip(edge + 0.5 - x_values, 0, 1) * 255
        source_alpha[y, start:end] = np.minimum(
            source_alpha[y, start:end],
            coverage.astype(np.uint8),
        )

    return Image.fromarray(source_alpha.astype(np.uint8), "L")


def protect_top_white_character(
    frame: Image.Image,
    alpha: Image.Image,
    background: tuple[int, int, int],
) -> Image.Image:
    """Restore a small white mascot above the green-haired subject.

    A nearly white mascot can be closer to the matte color than the compressed
    background itself. Locate it relative to the green hair, then recover only
    locally connected pixels that differ from the background by a small but
    consistent amount.
    """
    rgb = np.asarray(frame.convert("RGB")).astype(np.float32)
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    height, width, _ = rgb.shape

    green_hair = (
        (green >= red + 8)
        & (green >= blue + 3)
        & (green >= 100)
        & (red >= 65)
    )
    hair_y, hair_x = np.where(green_hair)
    if hair_x.size < 500:
        return alpha

    hair_top = int(np.percentile(hair_y, 0.25))
    upper_hair = hair_x[hair_y <= hair_top + max(50, height // 9)]
    hair_center = int(np.median(upper_hair if upper_hair.size else hair_x))

    top = max(0, hair_top - round(height * 0.15))
    bottom = min(height, hair_top + round(height * 0.04))
    left = max(0, hair_center - round(width * 0.105))
    right = min(width, hair_center + round(width * 0.105))
    if bottom <= top or right <= left:
        return alpha

    roi_rgb = rgb[top:bottom, left:right]
    sample_height = max(3, min(10, roi_rgb.shape[0] // 8))
    local_background_samples = roi_rgb[:sample_height, :, :].reshape(-1, 3)
    local_background = np.median(local_background_samples, axis=0)
    roi_distance = np.sqrt(((roi_rgb - local_background) ** 2).sum(axis=2))
    background_distance = np.sqrt(
        ((local_background_samples - local_background) ** 2).sum(axis=1)
    )
    recovery_threshold = max(7.5, float(np.percentile(background_distance, 95)) + 0.5)
    roi_green_hair = green_hair[top:bottom, left:right]
    roi_y, roi_x = np.indices(roi_distance.shape)
    global_y = roi_y + top

    # The generated background typically varies by 1-4 RGB distance units,
    # while the white mascot body starts around 6. Strong line-art pixels seed
    # the connected component; the lower threshold recovers its pale fill.
    seed = roi_distance >= 20
    upper_non_hair_seed = seed & ~roi_green_hair & (global_y <= hair_top + 5)
    seed_y, seed_x = np.where(upper_non_hair_seed)
    if seed_x.size < 20:
        return alpha

    duck_center_x = float(np.median(seed_x))
    duck_center_y = float(hair_top - top - round(height * 0.05))
    plausible = (
        ((roi_x - duck_center_x) / max(1, width * 0.105)) ** 2
        + ((roi_y - duck_center_y) / max(1, height * 0.10)) ** 2
        <= 1
    )
    candidate = (roi_distance >= recovery_threshold) & plausible
    seed &= plausible
    candidate_image = Image.fromarray((candidate * 255).astype(np.uint8), "L")
    candidate_image = candidate_image.filter(ImageFilter.MaxFilter(3))
    candidate_image = candidate_image.filter(ImageFilter.MinFilter(3))
    candidate = np.asarray(candidate_image) > 0

    roi_height, roi_width = candidate.shape
    visited = np.zeros(candidate.shape, dtype=bool)
    keep = np.zeros(candidate.shape, dtype=bool)

    for y in range(roi_height):
        for x in range(roi_width):
            if visited[y, x] or not candidate[y, x]:
                continue
            visited[y, x] = True
            queue: deque[tuple[int, int]] = deque([(x, y)])
            component: list[tuple[int, int]] = []
            has_seed = False

            while queue:
                cx, cy = queue.popleft()
                component.append((cx, cy))
                has_seed = has_seed or bool(seed[cy, cx])
                for nx, ny in (
                    (cx - 1, cy),
                    (cx + 1, cy),
                    (cx, cy - 1),
                    (cx, cy + 1),
                ):
                    if nx < 0 or nx >= roi_width or ny < 0 or ny >= roi_height:
                        continue
                    if visited[ny, nx] or not candidate[ny, nx]:
                        continue
                    visited[ny, nx] = True
                    queue.append((nx, ny))

            if (
                not has_seed
                or len(component) < 35
                or len(component) > int(plausible.sum() * 0.78)
            ):
                continue
            for cx, cy in component:
                keep[cy, cx] = True

    if not keep.any():
        return alpha

    # Fill enclosed gaps in the recovered silhouette without extending into
    # the open background around it.
    outside = ~keep
    outside_visited = np.zeros(outside.shape, dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(roi_width):
        for y in (0, roi_height - 1):
            if outside[y, x] and not outside_visited[y, x]:
                outside_visited[y, x] = True
                queue.append((x, y))
    for y in range(roi_height):
        for x in (0, roi_width - 1):
            if outside[y, x] and not outside_visited[y, x]:
                outside_visited[y, x] = True
                queue.append((x, y))
    while queue:
        cx, cy = queue.popleft()
        for nx, ny in (
            (cx - 1, cy),
            (cx + 1, cy),
            (cx, cy - 1),
            (cx, cy + 1),
        ):
            if nx < 0 or nx >= roi_width or ny < 0 or ny >= roi_height:
                continue
            if outside_visited[ny, nx] or not outside[ny, nx]:
                continue
            outside_visited[ny, nx] = True
            queue.append((nx, ny))
    keep |= outside & ~outside_visited

    restored = np.zeros((height, width), dtype=np.uint8)
    restored[top:bottom, left:right] = np.where(keep, 255, 0).astype(np.uint8)
    restored_image = Image.fromarray(restored, "L")
    restored_image = restored_image.filter(ImageFilter.MedianFilter(9))
    restored_image = restored_image.filter(ImageFilter.MinFilter(5))
    restored_image = restored_image.filter(ImageFilter.GaussianBlur(1.8))
    combined = np.maximum(np.asarray(alpha), np.asarray(restored_image))
    return Image.fromarray(combined.astype(np.uint8), "L")


def protect_right_dark_hair(frame: Image.Image, alpha: Image.Image) -> Image.Image:
    """Restore dark-brown hair that is too close to a dark-blue matte."""
    rgb = np.asarray(frame.convert("RGB")).astype(np.int16)
    protected = np.asarray(alpha).copy()
    height, width = protected.shape
    y_indices, x_indices = np.indices((height, width))
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]

    right_character_zone = (
        (x_indices >= width * 0.47)
        & (y_indices >= height * 0.10)
        & (y_indices <= height * 0.92)
    )
    dark_warm_core = (
        right_character_zone
        & (red >= green + 3)
        & (red >= blue + 2)
        & (red <= 155)
        & (green <= 125)
        & (blue <= 125)
    )
    warm_edge = (
        right_character_zone
        & (red >= green - 2)
        & (red >= blue - 4)
        & (red <= 175)
        & (green <= 145)
        & (blue <= 145)
    )

    core_mask = Image.fromarray(
        (dark_warm_core.astype(np.uint8) * 255),
        "L",
    )
    soft_mask = core_mask.filter(ImageFilter.MaxFilter(3)).filter(
        ImageFilter.GaussianBlur(0.65)
    )
    soft = np.asarray(soft_mask).copy()
    soft[~warm_edge] = 0
    protected = np.maximum(protected, soft)
    protected[dark_warm_core] = 255
    return Image.fromarray(protected.astype(np.uint8), "L")


def remove_small_alpha_components(alpha: Image.Image, min_area: int) -> Image.Image:
    if min_area <= 0:
        return alpha

    visible = np.asarray(alpha) > 8
    height, width = visible.shape
    visited = np.zeros(visible.shape, dtype=bool)
    cleaned = np.asarray(alpha).copy()

    for y in range(height):
        for x in range(width):
            if visited[y, x] or not visible[y, x]:
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
                    if visited[ny, nx] or not visible[ny, nx]:
                        continue
                    visited[ny, nx] = True
                    queue.append((nx, ny))

            if len(component) >= min_area:
                continue

            for cx, cy in component:
                cleaned[cy, cx] = 0

    return Image.fromarray(cleaned.astype(np.uint8), "L")


def stabilize_alpha_sequence(
    alphas: list[Image.Image],
    strength: float,
    max_delta: float = 96,
) -> list[Image.Image]:
    if strength <= 0 or len(alphas) < 3:
        return alphas

    source = [np.asarray(alpha).astype(np.float32) for alpha in alphas]
    result = [array.copy() for array in source]
    blend = float(np.clip(strength, 0, 1))

    for index in range(1, len(source) - 1):
        previous = source[index - 1]
        current = source[index]
        following = source[index + 1]
        median = np.median(np.stack([previous, current, following], axis=0), axis=0)

        supported_on_both_sides = (previous > 24) & (following > 24)
        shared_edge = (current > 8) & (median > 8)
        one_frame_spike = (current > 8) & (median <= 8)
        adjust = supported_on_both_sides | shared_edge | one_frame_spike

        delta = np.clip(median - current, -max_delta, max_delta)
        corrected = current + (delta * blend)
        result[index][adjust] = corrected[adjust]

    return [
        Image.fromarray(np.clip(array, 0, 255).astype(np.uint8), "L")
        for array in result
    ]


def stabilize_left_prop_alpha(
    alphas: list[Image.Image],
    strength: float,
) -> list[Image.Image]:
    """Use a sequence median for the rigid monitor while leaving character motion."""
    if strength <= 0 or len(alphas) < 3:
        return alphas

    source = np.stack(
        [np.asarray(alpha).astype(np.float32) for alpha in alphas],
        axis=0,
    )
    median = np.median(source, axis=0)
    height, width = median.shape
    y_indices, x_indices = np.indices((height, width))
    region = (
        (x_indices <= width * 0.25)
        & (y_indices >= height * 0.24)
        & (y_indices <= height * 0.90)
    )
    region_blend = np.asarray(
        Image.fromarray((region * 255).astype(np.uint8), "L").filter(
            ImageFilter.GaussianBlur(radius=6)
        )
    ).astype(np.float32) / 255
    blend = region_blend * float(np.clip(strength, 0, 1))
    result = source * (1 - blend[None, :, :]) + median[None, :, :] * blend[None, :, :]
    result[result <= 2] = 0
    result[result >= 253] = 255
    return [
        Image.fromarray(np.clip(array, 0, 255).astype(np.uint8), "L")
        for array in result
    ]


def stabilize_color_sequence(
    frames: list[Image.Image],
    alphas: list[Image.Image],
    strength: float,
    threshold: float,
) -> list[Image.Image]:
    if strength <= 0 or len(frames) < 3:
        return frames

    source = [np.asarray(frame.convert("RGB")).astype(np.uint8) for frame in frames]
    alpha_source = [np.asarray(alpha).astype(np.uint8) for alpha in alphas]
    result = [array.copy() for array in source]
    blend = float(np.clip(strength, 0, 1))

    for index in range(1, len(source) - 1):
        window = np.stack(
            [source[index - 1], source[index], source[index + 1]],
            axis=0,
        )
        median = np.median(window, axis=0)
        color_range = window.max(axis=0).astype(np.int16) - window.min(axis=0).astype(np.int16)
        stable_color = color_range.max(axis=2) <= threshold
        stable_subject = (
            (alpha_source[index - 1] > 32)
            & (alpha_source[index] > 32)
            & (alpha_source[index + 1] > 32)
        )
        adjust = stable_color & stable_subject
        current = source[index].astype(np.float32)
        corrected = current + ((median - current) * blend)
        result[index][adjust] = np.clip(corrected[adjust], 0, 255).astype(np.uint8)

    return [Image.fromarray(array, "RGB") for array in result]


def clear_canvas_border(image: Image.Image, border_width: int = 1) -> Image.Image:
    """Keep APNG frames from leaking antialiased pixels onto the canvas edge."""
    output = np.array(image.convert("RGBA"), dtype=np.uint8, copy=True)
    width = max(1, min(border_width, output.shape[0] // 2, output.shape[1] // 2))
    output[:width, :, :] = 0
    output[-width:, :, :] = 0
    output[:, :width, :] = 0
    output[:, -width:, :] = 0
    return Image.fromarray(output, "RGBA")


def resize_frame(image: Image.Image, canvas_size: int) -> Image.Image:
    if image.size == (canvas_size, canvas_size):
        return clear_canvas_border(image)

    rgba = np.asarray(image.convert("RGBA")).astype(np.float32)
    alpha = rgba[:, :, 3] / 255.0
    premultiplied = rgba[:, :, :3] * alpha[:, :, None]
    target_size = (canvas_size, canvas_size)

    resized_alpha = np.asarray(
        Image.fromarray(alpha, "F").resize(target_size, Image.Resampling.LANCZOS)
    ).astype(np.float32)
    resized_premultiplied = np.stack(
        [
            np.asarray(
                Image.fromarray(premultiplied[:, :, channel], "F").resize(
                    target_size,
                    Image.Resampling.LANCZOS,
                )
            )
            for channel in range(3)
        ],
        axis=2,
    ).astype(np.float32)

    resized_alpha = np.clip(resized_alpha, 0, 1)
    safe_alpha = np.maximum(resized_alpha, 1 / 255)
    resized_rgb = resized_premultiplied / safe_alpha[:, :, None]
    resized_rgb[resized_alpha < (1 / 255)] = 0

    output = np.zeros((canvas_size, canvas_size, 4), dtype=np.uint8)
    output[:, :, :3] = np.clip(resized_rgb, 0, 255).astype(np.uint8)
    output[:, :, 3] = np.clip(resized_alpha * 255, 0, 255).astype(np.uint8)
    return clear_canvas_border(Image.fromarray(output, "RGBA"))


def save_apng(frames: list[Image.Image], output_path: Path, fps: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(1, round(1000 / fps))
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
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


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    return image.getchannel("A").point(lambda value: 255 if value > 8 else 0).getbbox()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert a fixed-camera video with a flat background into a "
            "transparent APNG desktop-pet candidate."
        )
    )
    parser.add_argument("--input-video", required=True)
    parser.add_argument("--out", default="assets/generated/midori-run/duck-run.png")
    parser.add_argument("--work-dir", default="test-output/midori-run")
    parser.add_argument("--report", default="assets/generated/midori-run/duck-run-report.json")
    parser.add_argument("--fps", type=int, default=12)
    parser.add_argument("--max-frames", type=int, default=48)
    parser.add_argument("--canvas-size", type=int, default=512)
    parser.add_argument("--ffmpeg-exe", default="ffmpeg")
    parser.add_argument("--background-color", type=parse_color)
    parser.add_argument("--adaptive-background", action="store_true")
    parser.add_argument("--tolerance", type=float, default=32)
    parser.add_argument("--fringe-tolerance", type=float, default=76)
    parser.add_argument("--expand", type=int, default=3)
    parser.add_argument("--feather", type=float, default=0.2)
    parser.add_argument("--edge-decontaminate", type=float, default=0.72)
    parser.add_argument("--defringe-width", type=int, default=7)
    parser.add_argument("--defringe-strength", type=float, default=1)
    parser.add_argument("--defringe-color-distance", type=float, default=165)
    parser.add_argument("--neutralize-left-prop", type=int, default=0)
    parser.add_argument("--keep-right-gray-prop", action="store_true")
    parser.add_argument("--remove-bottom-right-watermark", action="store_true")
    parser.add_argument("--remove-edge-background-pockets", action="store_true")
    parser.add_argument("--protect-top-white-character", action="store_true")
    parser.add_argument("--protect-right-dark-hair", action="store_true")
    parser.add_argument("--min-alpha-component", type=int, default=96)
    parser.add_argument("--temporal-alpha-strength", type=float, default=0)
    parser.add_argument("--temporal-color-strength", type=float, default=0)
    parser.add_argument("--temporal-color-threshold", type=float, default=18)
    parser.add_argument("--temporal-passes", type=int, default=1)
    parser.add_argument("--final-alpha-smooth", type=float, default=0)
    parser.add_argument("--priority-edge-smooth", type=float, default=0)
    parser.add_argument("--stabilize-left-prop", type=float, default=0)
    parser.add_argument("--refine-left-prop-alpha", action="store_true")
    parser.add_argument("--straighten-left-monitor-edge", action="store_true")
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
    if args.temporal_passes < 1:
        raise SystemExit("--temporal-passes must be at least 1")

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
    background = args.background_color or estimate_background_color(selected)

    source_frames: list[Image.Image] = []
    alpha_masks: list[Image.Image] = []

    for path in selected:
        with Image.open(path) as source:
            frame = source.convert("RGB")
        background_model: BackgroundModel = (
            estimate_background_field(frame)
            if args.adaptive_background
            else background
        )
        alpha = make_alpha_mask(
            frame,
            background=background_model,
            tolerance=args.tolerance,
            fringe_tolerance=args.fringe_tolerance,
            expand=args.expand,
            feather=args.feather,
        )
        if not args.keep_right_gray_prop:
            alpha = remove_right_gray_background_prop(frame, alpha)
        if args.remove_bottom_right_watermark:
            alpha = remove_bottom_right_watermark(alpha)
        if args.remove_edge_background_pockets:
            alpha = remove_edge_background_pockets(
                frame,
                alpha,
                background_model,
                min(args.fringe_tolerance, args.tolerance + 4),
            )
        if args.protect_top_white_character:
            alpha = protect_top_white_character(frame, alpha, background)
        if args.protect_right_dark_hair:
            alpha = protect_right_dark_hair(frame, alpha)
        alpha = remove_small_alpha_components(alpha, args.min_alpha_component)
        alpha = smooth_final_alpha(alpha, args.final_alpha_smooth)
        alpha = smooth_priority_alpha_regions(
            alpha,
            args.priority_edge_smooth,
        )
        if args.refine_left_prop_alpha:
            alpha = refine_left_prop_alpha(frame, alpha)
        if args.straighten_left_monitor_edge:
            alpha = straighten_left_monitor_edge(frame, alpha)
        source_frames.append(frame)
        alpha_masks.append(alpha)

    for _ in range(args.temporal_passes):
        alpha_masks = stabilize_alpha_sequence(
            alpha_masks,
            strength=args.temporal_alpha_strength,
        )
        source_frames = stabilize_color_sequence(
            source_frames,
            alpha_masks,
            strength=args.temporal_color_strength,
            threshold=args.temporal_color_threshold,
        )

    alpha_masks = stabilize_left_prop_alpha(
        alpha_masks,
        strength=args.stabilize_left_prop,
    )

    frames: list[Image.Image] = []
    cutout_paths: list[Path] = []
    bboxes: list[tuple[int, int, int, int]] = []

    for index, (frame, alpha) in enumerate(zip(source_frames, alpha_masks)):
        background_model = (
            estimate_background_field(frame)
            if args.adaptive_background
            else background
        )
        rgba = decontaminate_edges(
            frame,
            alpha,
            background=background_model,
            strength=args.edge_decontaminate,
        )
        rgba = defringe_edge_colors(
            rgba,
            background=background_model,
            width=args.defringe_width,
            strength=args.defringe_strength,
            color_distance=args.defringe_color_distance,
        )
        rgba = neutralize_left_prop_halo(
            rgba,
            width=args.neutralize_left_prop,
        )
        resized = resize_frame(rgba, args.canvas_size)
        resized_alpha = resized.getchannel("A").point(
            lambda value: 0 if value <= 8 else value
        )
        resized_alpha = remove_small_alpha_components(
            resized_alpha,
            args.min_alpha_component,
        )
        resized.putalpha(resized_alpha)
        cutout_path = cutout_dir / f"frame-{index:03d}.png"
        resized.save(cutout_path)
        cutout_paths.append(cutout_path)
        frames.append(resized)
        bbox = alpha_bbox(resized)
        if bbox:
            bboxes.append(bbox)

    output_path = safe_project_path(PROJECT_ROOT / args.out)
    save_apng(frames, output_path, args.fps)
    contact_sheet = work_dir / "cutout-contact-sheet.png"
    make_contact_sheet(cutout_paths, contact_sheet)

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
        "backgroundColor": "#%02x%02x%02x" % background,
        "adaptiveBackground": args.adaptive_background,
        "tolerance": args.tolerance,
        "fringeTolerance": args.fringe_tolerance,
        "expand": args.expand,
        "feather": args.feather,
        "edgeDecontaminate": args.edge_decontaminate,
        "defringeWidth": args.defringe_width,
        "defringeStrength": args.defringe_strength,
        "defringeColorDistance": args.defringe_color_distance,
        "neutralizeLeftProp": args.neutralize_left_prop,
        "rightGrayPropCleanup": not args.keep_right_gray_prop,
        "bottomRightWatermarkCleanup": args.remove_bottom_right_watermark,
        "edgeBackgroundPocketCleanup": args.remove_edge_background_pockets,
        "topWhiteCharacterProtection": args.protect_top_white_character,
        "rightDarkHairProtection": args.protect_right_dark_hair,
        "minAlphaComponent": args.min_alpha_component,
        "temporalAlphaStrength": args.temporal_alpha_strength,
        "temporalColorStrength": args.temporal_color_strength,
        "temporalColorThreshold": args.temporal_color_threshold,
        "temporalPasses": args.temporal_passes,
        "finalAlphaSmooth": args.final_alpha_smooth,
        "priorityEdgeSmooth": args.priority_edge_smooth,
        "stabilizeLeftProp": args.stabilize_left_prop,
        "refineLeftPropAlpha": args.refine_left_prop_alpha,
        "straightenLeftMonitorEdge": args.straighten_left_monitor_edge,
        "contactSheet": str(contact_sheet),
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
