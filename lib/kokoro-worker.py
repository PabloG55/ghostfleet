"""kokoro-worker — one long-lived Kokoro, fed one sentence at a time by fleet-serve.

    <venv>/bin/python lib/kokoro-worker.py <model.onnx> <voices.bin>

Reads one JSON object per line on stdin — {"id", "text", "voice", "lang", "speed", "out"} —
writes a 16-bit mono WAV to `out` and answers one JSON line on stdout: {"id", "ok", "ms"}
or {"id", "ok": false, "error"}. The first line it prints is {"ready": true}, once the
model is loaded.

LONG-LIVED BECAUSE LOADING IS THE EXPENSIVE HALF. Building the onnxruntime session for an
82M-parameter model takes longer than synthesising a short sentence with it, so a process
per sentence would pay the load once per sentence — on a laptop that is already busy, for
the one feature whose whole point is that the first sentence starts quickly.

The WAV is written with the standard library rather than soundfile: kokoro-onnx brings
numpy, and numpy plus `wave` is all a 16-bit PCM file needs, so the documented setup has
one package to install rather than two.
"""
import json
import os
import sys
import time
import wave

import numpy as np


def main():
    model, voices = sys.argv[1], sys.argv[2]
    from kokoro_onnx import Kokoro
    k = Kokoro(model, voices)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = {}
        try:
            job = json.loads(line)
            t0 = time.time()
            samples, rate = k.create(job["text"], voice=job["voice"], speed=float(job.get("speed", 1.0)),
                                     lang=job["lang"])
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
            tmp = job["out"] + ".part"
            with wave.open(tmp, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(int(rate))
                w.writeframes(pcm)
            # Renamed into place, so a reader never sees half a file under the final name.
            os.replace(tmp, job["out"])
            print(json.dumps({"id": job.get("id"), "ok": True, "ms": int((time.time() - t0) * 1000)}), flush=True)
        except Exception as e:  # one bad sentence must not take the worker down with it
            print(json.dumps({"id": job.get("id"), "ok": False, "error": str(e)[:240]}), flush=True)


if __name__ == "__main__":
    main()
