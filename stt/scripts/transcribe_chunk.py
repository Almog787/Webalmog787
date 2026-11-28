import argparse
import gc
import json
import os
import re
from pathlib import Path

import psutil
import soundfile as sf
import torch
from faster_whisper import WhisperModel


def select_runtime_profile(requested_compute: str) -> tuple[str, int]:
    total_ram_gb = psutil.virtual_memory().total / (1024 ** 3)
    cpu_count = os.cpu_count() or 4

    if requested_compute == "auto":
        compute_type = "float32" if total_ram_gb >= 12.0 else "int8_float32"
    else:
        if requested_compute == "float32" and total_ram_gb < 11.0:
            print(f"::warning::Low RAM ({total_ram_gb:.1f} GB) for float32; risk of OOM.")
        compute_type = requested_compute

    print(f"[runtime] RAM={total_ram_gb:.1f}GB | CPUs={cpu_count} | compute_type={compute_type}")
    return compute_type, cpu_count


def load_vocabulary(vocab_path: Path) -> tuple[str, str]:
    base_prompt = "תמלול מדויק בעברית תקנית, כולל סימני פיסוק מלאים."
    terms: list[str] = []

    if vocab_path.exists():
        terms.extend(
            line.strip()
            for line in vocab_path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        )

    secret_terms = os.environ.get("EXTRA_VOCABULARY", "").strip()
    if secret_terms:
        terms.extend(t.strip() for t in re.split(r"[,\n]+", secret_terms) if t.strip())

    if not terms:
        return base_prompt, ""

    unique_terms = list(dict.fromkeys(terms))
    prompt_terms = ", ".join(unique_terms)[:500]
    prompt = f"{base_prompt} מונחים רלוונטיים: {prompt_terms}"
    hotwords = " ".join(unique_terms[:60])
    return prompt, hotwords


def sanitize_hebrew_only(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\u0590-\u05FF\s]", " ", text)).strip()


def run_whisperx_alignment(chunk_wav: Path, raw_segments: list[dict]) -> tuple[list[dict], str]:
    if hasattr(torch.serialization, "add_safe_globals"):
        try:
            from omegaconf import DictConfig, ListConfig
            torch.serialization.add_safe_globals([ListConfig, DictConfig])
        except Exception:
            pass

    import whisperx

    align_model, metadata = whisperx.load_align_model(language_code="he", device="cpu")
    audio_np, sr = sf.read(str(chunk_wav), dtype="float32")
    if sr != 16000:
        audio_np = whisperx.load_audio(str(chunk_wav))

    alignable_inputs = []
    aligned_by_idx: dict[int, dict] = {}

    for i, seg in enumerate(raw_segments):
        has_digits_or_latin = bool(re.search(r"[0-9A-Za-z]", seg["text"]))
        if has_digits_or_latin or not sanitize_hebrew_only(seg["text"]):
            aligned_by_idx[i] = seg
        else:
            alignable_inputs.append({"idx": i, "start": seg["start"], "end": seg["end"], "text": seg["text"]})

    if alignable_inputs:
        try:
            result = whisperx.align(
                alignable_inputs,
                align_model,
                metadata,
                audio_np,
                "cpu",
                return_char_alignments=False,
            )
            for item, orig in zip(result.get("segments", []), alignable_inputs):
                src_seg = raw_segments[orig["idx"]]
                words = item.get("words") or src_seg.get("words", [])
                aligned_by_idx[orig["idx"]] = {
                    **src_seg,
                    "start": round(float(item.get("start", src_seg["start"])), 3),
                    "end": round(float(item.get("end", src_seg["end"])), 3),
                    "alignment_engine": "whisperx-wav2vec2",
                    "words": [
                        {
                            "word": str(w.get("word", "")).strip(),
                            "start": round(float(w["start"]), 3) if w.get("start") is not None else None,
                            "end": round(float(w["end"]), 3) if w.get("end") is not None else None,
                            "probability": round(float(w.get("score", w.get("probability", 0.0))), 4)
                            if w.get("score", w.get("probability")) is not None
                            else None,
                        }
                        for w in words
                    ],
                }
        except Exception as exc:
            print(f"::warning::WhisperX alignment fallback triggered ({type(exc).__name__})")
            del align_model
            gc.collect()
            return raw_segments, f"fallback: {type(exc).__name__}"

    ordered = [aligned_by_idx[i] for i in range(len(raw_segments))]
    del align_model
    gc.collect()
    return ordered, "whisperx-wav2vec2"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chunk-file", required=True)
    parser.add_argument("--chunk-idx", type=int, required=True)
    parser.add_argument("--offset-sec", type=float, required=True)
    parser.add_argument("--model-repo", default="ivrit-ai/whisper-large-v3-ct2")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--beam-size", type=int, default=10)
    parser.add_argument("--enable-align", action="store_true")
    parser.add_argument("--vocab-file", default="stt/vocabulary.txt")
    parser.add_argument("--out-file", required=True)
    args = parser.parse_args()

    compute_type, cpu_threads = select_runtime_profile(args.compute_type)
    initial_prompt, hotwords = load_vocabulary(Path(args.vocab_file))

    model = WhisperModel(
        args.model_repo,
        device="cpu",
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )

    transcribe_kwargs = dict(
        language="he",
        task="transcribe",
        beam_size=args.beam_size,
        best_of=5,
        patience=1.5,
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8],
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=450, speech_pad_ms=300),
    )
    if hotwords:
        transcribe_kwargs["hotwords"] = hotwords

    segments_gen, info = model.transcribe(args.chunk_file, **transcribe_kwargs)
    raw_segments = []
    for seg in segments_gen:
        raw_segments.append({
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "text": seg.text.strip(),
            "avg_logprob": round(float(seg.avg_logprob), 4),
            "alignment_engine": "faster-whisper",
            "words": [
                {
                    "word": w.word.strip(),
                    "start": round(float(w.start), 3),
                    "end": round(float(w.end), 3),
                    "probability": round(float(w.probability), 4),
                }
                for w in (seg.words or [])
            ],
        })

    del model
    gc.collect()

    align_status = "faster-whisper-only"
    final_segments = raw_segments
    if args.enable_align and raw_segments:
        final_segments, align_status = run_whisperx_alignment(Path(args.chunk_file), raw_segments)

    payload = {
        "chunk_idx": args.chunk_idx,
        "offset_sec": args.offset_sec,
        "model": args.model_repo,
        "compute_type": compute_type,
        "alignment_status": align_status,
        "language": info.language,
        "segments": final_segments,
    }
    Path(args.out_file).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_file).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
