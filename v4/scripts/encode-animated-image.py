from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter


def remove_side_fragments(image: Image.Image) -> tuple[Image.Image, int]:
    cleaned = image.convert("RGBA")
    alpha = cleaned.getchannel("A")
    width, height = cleaned.size
    visible = [value > 0 for value in alpha.get_flattened_data()]
    visited = bytearray(width * height)
    components: list[tuple[list[int], int, int]] = []

    for start in range(width * height):
        if visited[start] or not visible[start]:
            continue

        visited[start] = 1
        queue = deque([start])
        component: list[int] = []
        minimum_x = width
        maximum_x = 0

        while queue:
            position = queue.popleft()
            component.append(position)
            y, x = divmod(position, width)
            minimum_x = min(minimum_x, x)
            maximum_x = max(maximum_x, x)

            if x > 0:
                neighbor = position - 1
                if not visited[neighbor] and visible[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
            if x + 1 < width:
                neighbor = position + 1
                if not visited[neighbor] and visible[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
            if y > 0:
                neighbor = position - width
                if not visited[neighbor] and visible[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
            if y + 1 < height:
                neighbor = position + width
                if not visited[neighbor] and visible[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)

        components.append((component, minimum_x, maximum_x))

    if not components:
        return cleaned, 0

    largest_area = max(len(component) for component, _, _ in components)
    edge_margin = max(round(width * 0.12), 16)
    pixels = cleaned.load()
    removed_pixels = 0

    for component, minimum_x, maximum_x in components:
        near_side = (
            minimum_x < edge_margin or maximum_x >= width - edge_margin
        )
        smaller_than_subject = len(component) < largest_area * 0.35
        if not (near_side and smaller_than_subject):
            continue

        for position in component:
            y, x = divmod(position, width)
            pixels[x, y] = (0, 0, 0, 0)
        removed_pixels += len(component)

    return cleaned, removed_pixels


def remove_magenta_fringe(image: Image.Image) -> Image.Image:
    cleaned = image.convert("RGBA")
    pixels = cleaned.load()
    for y in range(cleaned.height):
        for x in range(cleaned.width):
            red, green, blue, alpha = pixels[x, y]
            if (
                alpha
                and red > 120
                and blue > 120
                and min(red, blue) - green >= 62
            ):
                pixels[x, y] = (0, 0, 0, 0)
    return cleaned


def remove_dark_green_edge_halo(
    image: Image.Image,
    radius: int,
) -> tuple[Image.Image, int]:
    cleaned = image.convert("RGBA")
    alpha = cleaned.getchannel("A")
    visible_mask = alpha.point(lambda value: 255 if value > 0 else 0)
    inner_mask = visible_mask

    for _ in range(radius):
        inner_mask = inner_mask.filter(ImageFilter.MinFilter(3))

    edge_band = ImageChops.subtract(visible_mask, inner_mask)
    pixels = cleaned.load()
    band_pixels = edge_band.load()
    removed_pixels = 0

    for y in range(cleaned.height):
        for x in range(cleaned.width):
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
            if not (greenish and darkish and saturated_edge):
                continue

            pixels[x, y] = (0, 0, 0, 0)
            removed_pixels += 1

    return cleaned, removed_pixels


def remove_dark_green_shadow(image: Image.Image) -> tuple[Image.Image, int]:
    cleaned = image.convert("RGBA")
    pixels = cleaned.load()
    removed_pixels = 0

    for y in range(cleaned.height):
        for x in range(cleaned.width):
            red, green, blue, alpha_value = pixels[x, y]
            if not alpha_value:
                continue

            greenish = (
                green >= red + 10
                and blue >= red + 2
                and green + blue - (2 * red) >= 36
            )
            shadow = red < 125 and green < 175 and blue < 165
            saturated = green > 30 and blue > 20
            luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
            protected_face_area = 130 <= x <= 310 and 120 <= y <= 330

            if not (
                greenish
                and shadow
                and saturated
                and luminance < 145
                and not protected_face_area
            ):
                continue

            pixels[x, y] = (0, 0, 0, 0)
            removed_pixels += 1

    return cleaned, removed_pixels


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Clean a split frame or encode full-canvas RGBA PNG frames as a "
            "looping animation."
        )
    )
    parser.add_argument("--input-pattern")
    parser.add_argument("--frame-count", type=int)
    parser.add_argument("--fps", type=int)
    parser.add_argument("--out")
    parser.add_argument(
        "--frame-order-offset",
        type=int,
        default=0,
        help="Rotate the animation so this zero-based source frame plays first.",
    )
    parser.add_argument("--clean-input")
    parser.add_argument("--clean-output")
    parser.add_argument("--edge-halo-clean", action="store_true")
    parser.add_argument("--edge-halo-radius", type=int, default=18)
    parser.add_argument("--shadow-clean", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.clean_input or args.clean_output:
        if not args.clean_input or not args.clean_output:
            raise SystemExit(
                "--clean-input and --clean-output must be used together"
            )
        with Image.open(args.clean_input) as image:
            cleaned, removed_pixels = remove_side_fragments(image)
            cleaned = remove_magenta_fringe(cleaned)
            removed_halo_pixels = 0
            removed_shadow_pixels = 0
            if args.edge_halo_clean:
                cleaned, removed_halo_pixels = remove_dark_green_edge_halo(
                    cleaned,
                    args.edge_halo_radius,
                )
            if args.shadow_clean:
                cleaned, removed_shadow_pixels = remove_dark_green_shadow(
                    cleaned
                )
            output = Path(args.clean_output)
            output.parent.mkdir(parents=True, exist_ok=True)
            cleaned.save(output)
        print(
            f"Wrote cleaned frame {output} "
            f"(removed {removed_pixels} side-fragment pixels, "
            f"{removed_halo_pixels} edge-halo pixels, "
            f"{removed_shadow_pixels} shadow pixels)"
        )
        return

    if not all(
        (
            args.input_pattern,
            args.frame_count is not None,
            args.fps is not None,
            args.out,
        )
    ):
        raise SystemExit(
            "--input-pattern, --frame-count, --fps, and --out are required "
            "for animation encoding"
        )
    if args.frame_count < 2:
        raise SystemExit("--frame-count must be at least 2")
    if args.fps < 1:
        raise SystemExit("--fps must be at least 1")

    frame_paths = [
        Path(args.input_pattern % index) for index in range(args.frame_count)
    ]
    frame_order_offset = args.frame_order_offset % len(frame_paths)
    if frame_order_offset:
        frame_paths = (
            frame_paths[frame_order_offset:]
            + frame_paths[:frame_order_offset]
        )
    frames = []
    removed_side_pixels = 0
    removed_halo_pixels = 0
    removed_shadow_pixels = 0

    for frame_path in frame_paths:
        with Image.open(frame_path) as image:
            without_fragments, removed_pixels = remove_side_fragments(image)
            removed_side_pixels += removed_pixels
            cleaned = remove_magenta_fringe(without_fragments)
            if args.edge_halo_clean:
                cleaned, removed_pixels = remove_dark_green_edge_halo(
                    cleaned,
                    args.edge_halo_radius,
                )
                removed_halo_pixels += removed_pixels
            if args.shadow_clean:
                cleaned, removed_pixels = remove_dark_green_shadow(cleaned)
                removed_shadow_pixels += removed_pixels
            frames.append(cleaned)

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    duration = round(1000 / args.fps)
    if output.suffix.lower() == ".png":
        frames[0].save(
            output,
            format="PNG",
            save_all=True,
            append_images=frames[1:],
            duration=duration,
            loop=0,
            disposal=2,
            blend=0,
            optimize=False,
        )
    else:
        frames[0].save(
            output,
            format="WEBP",
            save_all=True,
            append_images=frames[1:],
            duration=duration,
            loop=0,
            lossless=True,
            method=6,
            exact=True,
            minimize_size=False,
        )
    print(
        f"Wrote {output} ({len(frames)} frames at {args.fps} fps, "
        f"source frame {frame_order_offset} first, "
        f"removed {removed_side_pixels} side-fragment pixels, "
        f"{removed_halo_pixels} edge-halo pixels, "
        f"{removed_shadow_pixels} shadow pixels)"
    )


if __name__ == "__main__":
    main()
