#!/usr/bin/env python3
"""Transcribe a separated voice track and retain timing/confidence metadata."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_audio", type=Path)
    parser.add_argument("output_json", type=Path)
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()

    args.model_dir.mkdir(parents=True, exist_ok=True)
    args.output_json.parent.mkdir(parents=True, exist_ok=True)

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=str(args.model_dir),
        cpu_threads=8,
    )
    segments_iter, info = model.transcribe(
        str(args.input_audio),
        language="zh",
        beam_size=5,
        best_of=5,
        word_timestamps=True,
        condition_on_previous_text=False,
        vad_filter=True,
        vad_parameters={
            "threshold": 0.62,
            "min_speech_duration_ms": 300,
            "min_silence_duration_ms": 350,
            "speech_pad_ms": 120,
        },
    )

    segments = []
    for segment in segments_iter:
        words = [
            {
                "start": word.start,
                "end": word.end,
                "word": word.word,
                "probability": word.probability,
            }
            for word in (segment.words or [])
        ]
        item = {
            "id": segment.id,
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "avg_logprob": segment.avg_logprob,
            "compression_ratio": segment.compression_ratio,
            "no_speech_prob": segment.no_speech_prob,
            "words": words,
        }
        segments.append(item)
        print(f"[{segment.start:7.2f} - {segment.end:7.2f}] {item['text']}")

    payload = {
        "input": str(args.input_audio.resolve()),
        "model": args.model,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "duration_after_vad": info.duration_after_vad,
        "segments": segments,
    }
    args.output_json.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
