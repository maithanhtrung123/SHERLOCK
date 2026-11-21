#!/usr/bin/env python3
"""Word-level timing for an audiobook chapter (for the yellow word highlight).

Transcribes the LibriVox mp3 with faster-whisper (word timestamps), then lines the
heard words up with the book's words, so every book word gets a start time.

Usage:  pip install faster-whisper
        python3 tools/align_audio.py SECTION_ID [SECTION_ID ...]
Writes book/align/<SECTION_ID>.json  ->  {"w": [[track, seconds, paragraphId, charStart, charEnd], ...]}
"""
import difflib, html, json, os, re, subprocess, sys, tempfile, urllib.request
import numpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORD = re.compile(r"[A-Za-z0-9]+(?:['’][A-Za-z]+)*")


def para_text(h):
    # same text the browser sees: <br> -> \n, tags removed
    h = re.sub(r"<br\s*/?>", "\n", h)
    h = re.sub(r"<[^>]+>", "", h)
    return html.unescape(h)


def norm(w):
    return w.lower().replace("’", "'")


def main(ids):
    from faster_whisper import WhisperModel
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "base.en"), device="cpu", compute_type="int8")
    book = json.load(open(os.path.join(ROOT, "book/book.json"), encoding="utf-8"))
    audio = json.load(open(os.path.join(ROOT, "book/audio.json"), encoding="utf-8"))
    os.makedirs(os.path.join(ROOT, "book/align"), exist_ok=True)
    for sid in ids:
        sec = book["sections"][int(sid)]
        tracks = audio["sections"][str(sid)]
        # a recording can span several chapters of one story (e.g. A Scandal in Bohemia)
        secs = [sec]
        S = book["sections"]
        k = int(sid) + 1
        while (k < len(S) and str(k) not in audio["sections"] and len(S[k]["path"]) == 3
               and S[k]["path"][:2] == sec["path"][:2]):
            secs.append(S[k]); k += 1
        bw = []  # (pid, a, b, normword)
        for pid, h, *_ in [p for s in secs for p in s["paras"]]:
            t = para_text(h)
            for m in WORD.finditer(t):
                bw.append((pid, m.start(), m.end(), norm(m.group())))
        heard = []  # (track, start, normword)
        for ti, tr in enumerate(tracks):
            with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
                req = urllib.request.Request(tr["url"], headers={"User-Agent": "Mozilla/5.0 (SherlockReader build script)"})
                f.write(urllib.request.urlopen(req, timeout=600).read()); f.flush()
                pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", f.name, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                                     capture_output=True, check=True).stdout
                segs, _ = model.transcribe(numpy.frombuffer(pcm, dtype=numpy.float32), word_timestamps=True, beam_size=1, vad_filter=False,
                                           initial_prompt="Sherlock Holmes, Dr. Watson.")
                for s in segs:
                    for w in s.words or []:
                        for m in WORD.finditer(w.word):
                            heard.append((ti, round(w.start, 2), norm(m.group())))
                print(f"section {sid} track {ti}: {len(heard)} words heard", flush=True)
        sm = difflib.SequenceMatcher(None, [w[3] for w in bw], [h[2] for h in heard], autojunk=False)
        times = [None] * len(bw)
        for a, b, n in sm.get_matching_blocks():
            for k in range(n):
                times[a + k] = heard[b + k][:2]
        matched = sum(t is not None for t in times)
        # fill gaps by interpolating between known neighbours (same track only)
        last = None
        for i in range(len(times)):
            if times[i] is not None:
                last = i; continue
            nxt = next((j for j in range(i + 1, len(times)) if times[j] is not None), None)
            if last is not None and nxt is not None and times[last][0] == times[nxt][0]:
                (tr, t0), (_, t1) = times[last], times[nxt]
                times[i] = (tr, round(t0 + (t1 - t0) * (i - last) / (nxt - last), 2))
            elif last is not None:
                times[i] = times[last]
            elif nxt is not None:
                times[i] = times[nxt]
        out = [[t[0], t[1], w[0], w[1], w[2]] for w, t in zip(bw, times) if t]
        json.dump({"w": out}, open(os.path.join(ROOT, f"book/align/{sid}.json"), "w"), separators=(",", ":"))
        print(f"section {sid}: {matched}/{len(bw)} words matched exactly ({100 * matched // max(1, len(bw))}%)", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
