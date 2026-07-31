from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def is_magenta(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel
    return red > 190 and blue > 190 and green < 125


def find_column_boundaries(
    image: Image.Image,
    row_top: int,
    row_bottom: int,
    columns: int,
) -> list[int]:
    width = image.width
    pixels = image.load()
    cell_width = width / columns
    search_radius = max(round(cell_width * 0.2), 12)
    boundaries = [0]

    for column in range(1, columns):
        nominal = round(column * cell_width)
        search_left = max(boundaries[-1] + 16, nominal - search_radius)
        search_right = min(width - 16, nominal + search_radius)
        best_x = nominal
        best_score = -1
        best_distance = width

        for x in range(search_left, search_right + 1):
            score = sum(
                is_magenta(pixels[sample_x, y])
                for sample_x in range(max(x - 3, 0), min(x + 4, width))
                for y in range(row_top + 4, row_bottom - 4, 2)
            )
            distance = abs(x - nominal)
            if score > best_score or (
                score == best_score and distance < best_distance
            ):
                best_x = x
                best_score = score
                best_distance = distance

        boundaries.append(best_x)

    boundaries.append(width)
    return boundaries


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Split a chroma-key sprite sheet by locating magenta gaps near its "
            "nominal grid boundaries."
        )
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--columns", type=int, default=5)
    parser.add_argument("--rows", type=int, default=2)
    parser.add_argument("--horizontal-inset", type=int, default=24)
    parser.add_argument("--vertical-inset", type=int, default=4)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.columns < 1 or args.rows < 1:
        raise SystemExit("--columns and --rows must be positive")

    input_path = Path(args.input)
    output_dir = Path(args.out_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with Image.open(input_path) as source:
        image = source.convert("RGB")
        row_boundaries = [
            round(row * image.height / args.rows)
            for row in range(args.rows + 1)
        ]

        frame_index = 0
        for row in range(args.rows):
            row_top = row_boundaries[row]
            row_bottom = row_boundaries[row + 1]
            column_boundaries = find_column_boundaries(
                image,
                row_top,
                row_bottom,
                args.columns,
            )
            print(
                f"row {row + 1} column boundaries: "
                + ", ".join(str(value) for value in column_boundaries)
            )

            for column in range(args.columns):
                left = column_boundaries[column]
                right = column_boundaries[column + 1]
                crop_left = left + (
                    args.horizontal_inset if column > 0 else 0
                )
                crop_right = right - (
                    args.horizontal_inset
                    if column + 1 < args.columns
                    else 0
                )
                crop_top = row_top + (
                    args.vertical_inset if row > 0 else 0
                )
                crop_bottom = row_bottom - (
                    args.vertical_inset if row + 1 < args.rows else 0
                )
                if crop_right <= crop_left or crop_bottom <= crop_top:
                    raise RuntimeError(
                        f"Invalid crop for frame {frame_index}: "
                        f"{crop_left},{crop_top},{crop_right},{crop_bottom}"
                    )

                frame = image.crop(
                    (crop_left, crop_top, crop_right, crop_bottom)
                )
                output_path = output_dir / f"raw-{frame_index:02d}.png"
                frame.save(output_path)
                frame_index += 1

    print(f"Wrote {frame_index} adaptively split frames to {output_dir}")


if __name__ == "__main__":
    main()
