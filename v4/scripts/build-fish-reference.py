#!/usr/bin/env python3
"""Build strict, timestamp-preserving and compact Fish voice references."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt


def dbfs(value: float) -> float:
    return 20.0 * math.log10(max(value, 1e-12))


def fade_edges(audio: np.ndarray, sample_rate: int, duration_ms: float = 18.0) -> np.ndarray:
    result = audio.copy()
    fade_samples = min(
        int(round(sample_rate * duration_ms / 1000.0)),
        len(result) // 2,
    )
    if fade_samples <= 0:
        return result
    fade_in = np.linspace(0.0, 1.0, fade_samples, endpoint=True, dtype=np.float32)
    result[:fade_samples] *= fade_in
    result[-fade_samples:] *= fade_in[::-1]
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_audio", type=Path)
    parser.add_argument("selection_json", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    audio, sample_rate = sf.read(args.input_audio, always_2d=True, dtype="float32")
    mono = np.mean(audio, axis=1)

    # Remove only frequencies that are not useful for voice cloning.  The learned
    # separator and denoiser have already done the heavy cleanup.
    sos = butter(
        4,
        [70.0, min(14_000.0, sample_rate * 0.45)],
        btype="bandpass",
        fs=sample_rate,
        output="sos",
    )
    filtered = sosfiltfilt(sos, mono).astype(np.float32)

    selection = json.loads(args.selection_json.read_text(encoding="utf-8"))
    chosen = []
    report_segments = []
    timeline = np.zeros_like(filtered)
    for index, segment in enumerate(selection["segments"], start=1):
        start_sample = max(0, int(round(float(segment["start"]) * sample_rate)))
        end_sample = min(len(filtered), int(round(float(segment["end"]) * sample_rate)))
        clip = fade_edges(filtered[start_sample:end_sample], sample_rate)
        timeline[start_sample:end_sample] = clip
        chosen.append(clip)
        rms = float(np.sqrt(np.mean(np.square(clip)))) if len(clip) else 0.0
        peak = float(np.max(np.abs(clip))) if len(clip) else 0.0
        report_segments.append(
            {
                "index": index,
                "start": float(segment["start"]),
                "end": float(segment["end"]),
                "duration": (end_sample - start_sample) / sample_rate,
                "text": segment["text"],
                "rms_dbfs_before_mastering": dbfs(rms),
                "peak_dbfs_before_mastering": dbfs(peak),
            }
        )

    gap = np.zeros(int(round(sample_rate * 0.18)), dtype=np.float32)
    compact_parts = []
    for index, clip in enumerate(chosen):
        if index:
            compact_parts.append(gap)
        compact_parts.append(clip)
    compact = np.concatenate(compact_parts)

    # One shared gain preserves the natural dynamics and prevents clipping.
    compact_rms = float(np.sqrt(np.mean(np.square(compact))))
    target_rms = 10.0 ** (-20.0 / 20.0)
    gain = target_rms / max(compact_rms, 1e-12)
    peak_after_gain = float(np.max(np.abs(compact))) * gain
    gain = min(gain, (10.0 ** (-1.0 / 20.0)) / max(peak_after_gain, 1e-12))
    compact *= gain
    timeline *= gain

    args.output_dir.mkdir(parents=True, exist_ok=True)
    compact_path = args.output_dir / "other-speaker-fish-reference.wav"
    timeline_path = args.output_dir / "other-speaker-timeline-silenced.wav"
    report_path = args.output_dir / "reference-report.json"
    sf.write(compact_path, compact, sample_rate, subtype="PCM_24")
    sf.write(timeline_path, timeline, sample_rate, subtype="PCM_24")

    report = {
        "input": str(args.input_audio.resolve()),
        "selection": str(args.selection_json.resolve()),
        "sample_rate": sample_rate,
        "channels": 1,
        "compact_duration": len(compact) / sample_rate,
        "timeline_duration": len(timeline) / sample_rate,
        "kept_speech_duration": sum(len(clip) for clip in chosen) / sample_rate,
        "muted_timeline_duration": (
            len(timeline) - sum(len(clip) for clip in chosen)
        )
        / sample_rate,
        "master_gain_db": 20.0 * math.log10(max(gain, 1e-12)),
        "compact_peak_dbfs": dbfs(float(np.max(np.abs(compact)))),
        "compact_rms_dbfs": dbfs(float(np.sqrt(np.mean(np.square(compact))))),
        "segments": report_segments,
        "outputs": {
            "fish_reference": str(compact_path.resolve()),
            "timeline_silenced": str(timeline_path.resolve()),
        },
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
