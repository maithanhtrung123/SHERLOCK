#!/usr/bin/env python3
"""Match LibriVox recordings to the book's chapters -> book/audio.json.
Needs internet (LibriVox API).   Usage: python3 tools/build_audio.py"""
import json, os, re, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# book title in book.json -> (LibriVox id, dramatic reading?)
RECORDINGS = {
    "A Study In Scarlet": (16599, True),
    "The Sign of the Four": (7120, True),
    "The Adventures of Sherlock Holmes": (14369, True),
    "The Memoirs of Sherlock Holmes": (21615, False),
    "The Hound of the Baskervilles": (6557, True),
    "The Return of Sherlock Holmes": (8436, True),
    "The Valley Of Fear": (17767, True),
    "His Last Bow": (8854, True),
    "The Case-Book of Sherlock Holmes": (18897, False),
}
STOP = {"the", "of", "a", "an", "adventure", "story", "chapter", "part", "and", "in", "mr", "dr", "on", "to", "with"}

def words(t):
    t = re.sub(r"^story \d+:\s*", "", t.lower())
    t = re.sub(r"^chapter [ivxlc]+\s*·\s*", "", t)
    t = re.sub(r"\b(part|pt)\.? ?(\d+|[ab]|one|two)\b", " ", t)
    return {w.rstrip("s") for w in re.findall(r"[a-z]+", t) if w not in STOP}

def part_no(t):
    m = re.search(r"\bpart\s*(\d|[ab]|one|two)\b", t.lower())
    return {"1": 1, "a": 1, "one": 1, "2": 2, "b": 2, "two": 2}.get(m.group(1)) if m else None

def fetch(i):
    url = f"https://librivox.org/api/feed/audiobooks/?id={i}&format=json&extended=1"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (SherlockReader build script)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["books"][0]

def main():
    book = json.load(open(os.path.join(ROOT, "book/book.json"), encoding="utf-8"))
    out = {"recordings": {}, "sections": {}}
    for name, (lid, dramatic) in RECORDINGS.items():
        rec = fetch(lid)
        secs = [s for s in book["sections"] if s["path"][0] == name]
        out["recordings"][name] = {"id": lid, "title": rec["title"], "dramatic": dramatic,
                                   "page": rec.get("url_librivox") or f"https://librivox.org/{lid}"}
        for tr in rec["sections"]:
            tw = words(tr["title"])
            if not tw:
                continue
            # best section: story title (path[1]) or chapter title
            def score(s):
                best = 0
                for t in s["path"][1:]:
                    sw = words(t)
                    if sw:
                        best = max(best, len(tw & sw) / len(tw | sw))
                return best
            ranked = sorted(secs, key=score, reverse=True)
            if not ranked or score(ranked[0]) < 0.34:
                print("  no match:", tr["title"]); continue
            top = score(ranked[0])
            cands = [s for s in ranked if score(s) == top]
            pn = part_no(tr["title"])
            if len(cands) > 1 and pn and pn <= len(cands):
                target = sorted(cands, key=lambda s: s["id"])[pn - 1]   # story split into chapters
            else:
                # chapter-level match beats story-level: prefer the exact chapter title
                target = cands[0]
            out["sections"].setdefault(str(target["id"]), []).append(
                {"url": tr["listen_url"], "t": int(tr["playtime"] or 0), "title": tr["title"]})
    for s in book["sections"]:
        a = out["sections"].get(str(s["id"]))
        print(f'{s["id"]:4} {" › ".join(s["path"])[:70]:72} {"; ".join(x["title"] for x in a) if a else "-- no audio"}')
    json.dump(out, open(os.path.join(ROOT, "book/audio.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

if __name__ == "__main__":
    main()
