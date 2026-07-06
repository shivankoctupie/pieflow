"""PieFlow STT sidecar.

Long-running process. Speaks JSON-lines over stdin/stdout:
  in : {"cmd": "load", "model": "base", "device": "auto", "compute": "auto"}
  out: {"event": "loading", "model": "base"} then {"event": "loaded", ...} or {"event": "error", ...}
  in : {"cmd": "transcribe", "id": 1, "path": "...wav", "language": null, "prompt": "words to bias"}
  out: {"id": 1, "ok": true, "text": "...", "language": "en", "duration": 3.2}
  in : {"cmd": "ping"}   -> {"event": "pong"}
  in : {"cmd": "quit"}

Model files are cached under %LOCALAPPDATA%/PieFlow/models via HF_HOME so
first load downloads once and later loads are instant.
"""
import sys
import os
import json
import traceback

# Keep model cache inside PieFlow's own folder, not the global HF cache.
_cache = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "PieFlow", "models")
os.makedirs(_cache, exist_ok=True)
os.environ.setdefault("HF_HOME", _cache)
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

_model = None
_model_name = None


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model(name, device="auto", compute="auto"):
    global _model, _model_name
    from faster_whisper import WhisperModel
    emit({"event": "loading", "model": name})
    if compute == "auto":
        compute = "int8"
    try:
        _model = WhisperModel(name, device=device, compute_type=compute)
    except Exception:
        # CUDA present but broken, or unsupported compute type: retry on CPU int8.
        _model = WhisperModel(name, device="cpu", compute_type="int8")
    _model_name = name
    emit({"event": "loaded", "model": name})


def transcribe(req):
    if _model is None:
        emit({"id": req.get("id"), "ok": False, "error": "model not loaded"})
        return
    path = req["path"]
    language = req.get("language") or None
    prompt = req.get("prompt") or None
    segments, info = _model.transcribe(
        path,
        language=language,
        initial_prompt=prompt,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=5,
        condition_on_previous_text=False,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    emit({
        "id": req.get("id"),
        "ok": True,
        "text": text,
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
        "duration": round(float(info.duration), 2),
    })


def main():
    emit({"event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "load":
                load_model(req.get("model", "base"), req.get("device", "auto"), req.get("compute", "auto"))
            elif cmd == "transcribe":
                transcribe(req)
            elif cmd == "ping":
                emit({"event": "pong", "model": _model_name})
            elif cmd == "quit":
                break
            else:
                emit({"event": "error", "error": f"unknown cmd {cmd}"})
        except Exception as e:
            emit({"event": "error", "error": str(e), "trace": traceback.format_exc(), "id": (req.get("id") if isinstance(req, dict) else None)})


if __name__ == "__main__":
    main()
