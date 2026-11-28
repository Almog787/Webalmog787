import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import soundfile as sf


def download_audio_safely(audio_url: str, dest_path: Path, retries: int = 3) -> Path:
    clean_path_part = audio_url.split("?")[0]
    ext = Path(clean_path_part).suffix or ".audio"
    target = dest_path.with_suffix(ext)

    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "*/*",
    }

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(audio_url, headers=headers)
            with urllib.request.urlopen(req, timeout=300) as resp:
                status = getattr(resp, "status", 200)
                if status >= 400:
                    raise RuntimeError(f"HTTP status {status}")

                content_type = (resp.info().get_content_type() or "").lower()
                if content_type.startswith("text/html"):
                    raise RuntimeError(
                        "Remote URL returned an HTML webpage instead of direct audio/video media. "
                        "Provide a direct download link."
                    )

                with open(target, "wb") as out_f:
                    while True:
                        buf = resp.read(1024 * 1024)
                        if not buf:
                            break
                        out_f.write(buf)

            if target.stat().st_size < 1024:
                raise RuntimeError("Downloaded file is too small (<1 KB) to be valid media.")
            return target
        except (urllib.error.URLError, RuntimeError, TimeoutError) as exc:
            last_err = exc
            if target.exists():
                target.unlink()
            if attempt < retries:
                wait_s = attempt * 3
                print(f"[prepare] Download attempt {attempt} failed ({type(exc).__name__}); retrying in {wait_s}s...")
                time.sleep(wait_s)

    print(f"ERROR: Failed to download audio_url after {retries} attempts: {type(last_err).__name__}: {last_err}", file=sys.stderr)
    sys.exit(1)


def run_ffmpeg(input_path: Path, output_wav: Path) -> None:
    af_filter = "highpass=f=80,lowpass=f=7600,loudnorm=I=-16:TP=-1.5:LRA=11"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(input_path),
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-af", af_filter,
            str(output_wav),
        ],
        check=True,
    )


def compute_silence_cut_points(
    wav_path: Path, target_chunk_sec: int = 720, min_chunk_sec: int = 240
) -> list[tuple[float, float]]:
    info = sf.info(str(wav_path))
    total_dur = float(info.duration)
    if total_dur <= target_chunk_sec * 1.25:
        return [(0.0, round(total_dur, 3))]

    from silero_vad import get_speech_timestamps, load_silero_vad, read_audio

    model = load_silero_vad()
    wav = read_audio(str(wav_path), sampling_rate=16000)
    speech_ts = get_speech_timestamps(
        wav,
        model,
        sampling_rate=16000,
        min_silence_duration_ms=450,
        speech_pad_ms=250,
        return_seconds=True,
    )

    if not speech_ts:
        return [(0.0, round(total_dur, 3))]

    silence_midpoints: list[float] = []
    for i in range(len(speech_ts) - 1):
        gap_start = float(speech_ts[i]["end"])
        gap_end = float(speech_ts[i + 1]["start"])
        if gap_end - gap_start >= 0.35:
            silence_midpoints.append((gap_start + gap_end) / 2.0)

    chunks: list[tuple[float, float]] = []
    cur_start = 0.0
    while cur_start < total_dur:
        ideal_end = cur_start + target_chunk_sec
        if ideal_end >= total_dur - min_chunk_sec:
            chunks.append((round(cur_start, 3), round(total_dur, 3)))
            break

        candidates = [
            t
            for t in silence_midpoints
            if (cur_start + min_chunk_sec) <= t <= (ideal_end + 180)
        ]
        cut_t = min(candidates, key=lambda t: abs(t - ideal_end)) if candidates else ideal_end
        chunks.append((round(cur_start, 3), round(cut_t, 3)))
        cur_start = cut_t

    return chunks


def prewarm_models(model_repo: str, enable_align: bool) -> None:
    from huggingface_hub import snapshot_download

    print(f"[prepare] Pre-warming Whisper model: {model_repo}")
    snapshot_download(repo_id=model_repo)
    if enable_align:
        align_repo = "imvladikon/wav2vec2-xls-r-300m-hebrew"
        print(f"[prepare] Pre-warming Hebrew wav2vec2 alignment model: {align_repo}")
        snapshot_download(repo_id=align_repo)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-file", default="")
    parser.add_argument("--model-repo", default="ivrit-ai/whisper-large-v3-ct2")
    parser.add_argument("--chunk-seconds", type=int, default=720)
    parser.add_argument("--enable-align", action="store_true")
    parser.add_argument("--redact-logs", action="store_true")
    parser.add_argument("--work-dir", default="stt/workspace")
    parser.add_argument("--full-audio-dir", default="stt/full_audio")
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    chunks_dir = work_dir / "chunks"
    full_audio_dir = Path(args.full_audio_dir)
    chunks_dir.mkdir(parents=True, exist_ok=True)
    full_audio_dir.mkdir(parents=True, exist_ok=True)

    audio_url = os.environ.get("AUDIO_URL", "").strip()
    if audio_url:
        print("[prepare] Downloading remote audio (URL redacted in public logs)")
        raw_input = download_audio_safely(audio_url, work_dir / "downloaded_input")
        clean_path_part = audio_url.split("?")[0]
        slug = "encrypted_audio" if args.redact_logs else (Path(clean_path_part).stem or "remote_audio")
        source_label = "remote-url-redacted"
    elif args.input_file.strip():
        raw_input = Path(args.input_file.strip())
        if not raw_input.exists():
            print("ERROR: Input audio file not found.", file=sys.stderr)
            sys.exit(1)
        slug = "encrypted_audio" if args.redact_logs else raw_input.stem
        source_label = "redacted" if args.redact_logs else str(raw_input)
    else:
        print("ERROR: Provide either audio_url or a valid audio_file path.", file=sys.stderr)
        sys.exit(1)

    clean_wav = full_audio_dir / "clean_audio.wav"
    print("[prepare] Normalizing audio -> clean_audio.wav")
    run_ffmpeg(raw_input, clean_wav)

    if audio_url and raw_input.exists():
        raw_input.unlink()

    intervals = compute_silence_cut_points(clean_wav, target_chunk_sec=args.chunk_seconds)
    manifest_chunks = []
    for idx, (start_s, end_s) in enumerate(intervals):
        padded_idx = f"{idx:03d}"
        chunk_name = f"chunk_{padded_idx}.wav"
        chunk_path = chunks_dir / chunk_name
        subprocess.run(
            [
                "ffmpeg", "-y", "-ss", str(start_s), "-to", str(end_s),
                "-i", str(clean_wav), "-c", "copy", str(chunk_path),
            ],
            check=True,
        )
        manifest_chunks.append({
            "idx": idx,
            "padded_idx": padded_idx,
            "file": chunk_name,
            "offset_sec": start_s,
            "duration_sec": round(end_s - start_s, 3),
        })

    manifest = {
        "slug": slug,
        "source": source_label,
        "total_duration_sec": round(float(sf.info(str(clean_wav)).duration), 3),
        "chunks": manifest_chunks,
    }
    (work_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    prewarm_models(args.model_repo, args.enable_align)

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"matrix={json.dumps({'include': manifest_chunks})}\n")
            f.write(f"slug={slug}\n")
            f.write(f"chunk_count={len(manifest_chunks)}\n")


if __name__ == "__main__":
    main()
