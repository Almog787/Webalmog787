import argparse
import json
import os
from pathlib import Path


def fmt_srt(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:
        s += 1
        ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def fmt_vtt(t: float) -> str:
    return fmt_srt(t).replace(",", ".")


def run_diarization(
    clean_wav: Path, hf_token: str, preferred_model: str
) -> list[tuple[float, float, str]]:
    import soundfile as sf
    import torch

    if hasattr(torch.serialization, "add_safe_globals"):
        try:
            from omegaconf import DictConfig, ListConfig
            torch.serialization.add_safe_globals([ListConfig, DictConfig])
        except Exception:
            pass

    from pyannote.audio import Pipeline

    candidates = [
        preferred_model,
        "pyannote/speaker-diarization-3.1"
        if preferred_model != "pyannote/speaker-diarization-3.1"
        else "pyannote/speaker-diarization-community-1",
    ]

    pipeline = None
    for repo in candidates:
        try:
            pipeline = Pipeline.from_pretrained(repo, token=hf_token)
            print(f"[diarize] Loaded pipeline: {repo}")
            break
        except TypeError:
            pipeline = Pipeline.from_pretrained(repo, use_auth_token=hf_token)
            print(f"[diarize] Loaded pipeline (legacy auth): {repo}")
            break
        except Exception as exc:
            print(f"::warning::Could not load {repo}: {type(exc).__name__}")

    if pipeline is None:
        return []

    audio_np, sr = sf.read(str(clean_wav), dtype="float32")
    waveform = torch.from_numpy(audio_np).unsqueeze(0)
    output = pipeline({"waveform": waveform, "sample_rate": sr})

    turns: list[tuple[float, float, str]] = []
    annotation = getattr(output, "speaker_diarization", output)
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        turns.append((float(turn.start), float(turn.end), str(speaker)))
    return turns


def assign_speaker(start: float, end: float, turns: list[tuple[float, float, str]]) -> str | None:
    if not turns:
        return None
    best_speaker = None
    best_overlap = 0.0
    for t_start, t_end, spk in turns:
        overlap = max(0.0, min(end, t_end) - max(start, t_start))
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = spk
    return best_speaker


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chunks-dir", required=True)
    parser.add_argument("--clean-wav", default="")
    parser.add_argument("--slug", required=True)
    parser.add_argument("--diarize", action="store_true")
    parser.add_argument("--diarization-model", default="pyannote/speaker-diarization-3.1")
    parser.add_argument("--out-dir", default="stt/transcripts")
    args = parser.parse_args()

    chunk_files = sorted(Path(args.chunks_dir).rglob("chunk_*.json"), key=lambda p: p.name)
    if not chunk_files:
        raise FileNotFoundError(f"No chunk_*.json files found under {args.chunks_dir}")

    merged_segments = []
    seg_id = 1
    meta_models = set()
    meta_align = set()

    for cf in chunk_files:
        data = json.loads(cf.read_text(encoding="utf-8"))
        offset = float(data["offset_sec"])
        meta_models.add(f"{data.get('model')} ({data.get('compute_type')})")
        meta_align.add(data.get("alignment_status", "unknown"))

        for seg in data.get("segments", []):
            abs_start = round(float(seg["start"]) + offset, 3)
            abs_end = round(float(seg["end"]) + offset, 3)
            words = []
            for w in seg.get("words", []):
                w_start = round(float(w["start"]) + offset, 3) if w.get("start") is not None else None
                w_end = round(float(w["end"]) + offset, 3) if w.get("end") is not None else None
                words.append({**w, "start": w_start, "end": w_end})
            merged_segments.append({
                "id": seg_id,
                "start": abs_start,
                "end": abs_end,
                "text": seg["text"],
                "avg_logprob": seg.get("avg_logprob"),
                "speaker": None,
                "words": words,
            })
            seg_id += 1

    hf_token = os.environ.get("HF_TOKEN", "").strip()
    diarized = False
    if args.diarize:
        clean_wav_path = Path(args.clean_wav) if args.clean_wav else None
        if not hf_token:
            print("::warning::diarize=true requested, but HF_TOKEN secret is not set. Skipping diarization.")
        elif not clean_wav_path or not clean_wav_path.exists():
            print("::warning::clean_audio.wav missing for diarization. Skipping diarization.")
        else:
            print(f"[diarize] Running speaker diarization across {len(merged_segments)} segments...")
            turns = run_diarization(clean_wav_path, hf_token, args.diarization_model)
            if turns:
                diarized = True
                for seg in merged_segments:
                    seg["speaker"] = assign_speaker(seg["start"], seg["end"], turns)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.slug

    txt_lines, srt_lines, vtt_lines = [], [], ["WEBVTT\n"]
    for seg in merged_segments:
        spk_prefix = f"[{seg['speaker']}] " if seg["speaker"] else ""
        txt_lines.append(f"[{seg['start']:.2f} -> {seg['end']:.2f}] {spk_prefix}{seg['text']}")
        srt_lines.append(f"{seg['id']}\n{fmt_srt(seg['start'])} --> {fmt_srt(seg['end'])}\n{spk_prefix}{seg['text']}\n")
        vtt_lines.append(f"{fmt_vtt(seg['start'])} --> {fmt_vtt(seg['end'])}\n{spk_prefix}{seg['text']}\n")

    (out_dir / f"{stem}.txt").write_text("\n".join(txt_lines), encoding="utf-8")
    (out_dir / f"{stem}.srt").write_text("\n".join(srt_lines), encoding="utf-8")
    (out_dir / f"{stem}.vtt").write_text("\n".join(vtt_lines), encoding="utf-8")
    (out_dir / f"{stem}.json").write_text(
        json.dumps(
            {
                "slug": stem,
                "models": sorted(meta_models),
                "alignment": sorted(meta_align),
                "diarized": diarized,
                "segment_count": len(merged_segments),
                "segments": merged_segments,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[merge] Wrote {len(merged_segments)} segments into {out_dir}")


if __name__ == "__main__":
    main()
