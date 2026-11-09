"""piper-worker — one long-lived Piper, fed one sentence at a time by server/piper.mjs.

    <venv>/bin/python server/piper-worker.py

Same deal as ghostfleet's lib/kokoro-worker.py. Reads one JSON object per line on stdin —
{"id", "text", "model", "out"} — writes a WAV to `out` and answers one JSON line on stdout:
{"id", "ok", "ms"} or {"id", "ok": false, "error"}. The first line it prints is {"ready": true}.

Only the last voice stays loaded: every reply uses one voice, and memory here is short.
"""
import json
import os
import sys
import time
import wave


def main():
    from piper import PiperVoice
    print(json.dumps({"ready": True}), flush=True)
    loaded, voice = "", None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = {}
        try:
            job = json.loads(line)
            t0 = time.time()
            if job["model"] != loaded:
                voice, loaded = PiperVoice.load(job["model"]), job["model"]
            tmp = job["out"] + ".part"
            with wave.open(tmp, "wb") as w:
                voice.synthesize_wav(job["text"], w)
            # Renamed into place, so a reader never sees half a file under the final name.
            os.replace(tmp, job["out"])
            print(json.dumps({"id": job.get("id"), "ok": True, "ms": int((time.time() - t0) * 1000)}), flush=True)
        except Exception as e:  # one bad sentence must not take the worker down with it
            print(json.dumps({"id": job.get("id"), "ok": False, "error": str(e)[:240]}), flush=True)


if __name__ == "__main__":
    main()
