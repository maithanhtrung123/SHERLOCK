#!/usr/bin/env python3
"""Bundle the app into ONE html file (book + pictures inside) that opens offline
by double-clicking, no server needed.   Usage: python3 tools/build_single.py out.html"""
import base64, json, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rd = lambda p: open(os.path.join(ROOT, p), encoding="utf-8").read()
html = rd("index.html")
book = rd("book/book.json")
def img(m):
    data = base64.b64encode(open(os.path.join(ROOT, "book/images", m.group(1)), "rb").read()).decode()
    return "data:image/png;base64," + data
book = re.sub(r"book/images/([\w.-]+\.png)", img, book).replace("</", "<\\/")
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "")
html = html.replace('<link rel="icon" href="icon.svg" type="image/svg+xml">\n', "")
html = html.replace('<link rel="stylesheet" href="app.css">', "<style>\n" + rd("app.css") + "</style>")
audio = rd("book/audio.json").replace("</", "<\\/")
align = {}
adir = os.path.join(ROOT, "book/align")
for f in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
    align[f[:-5]] = json.load(open(os.path.join(adir, f)))
html = html.replace('<script src="app.js"></script>',
    '<script id="book-data" type="application/json">' + book + "</script>\n"
    + '<script id="audio-data" type="application/json">' + audio + "</script>\n"
    + '<script id="align-data" type="application/json">' + json.dumps(align, separators=(",", ":")) + "</script>\n"
    + "<script>\n" + rd("app.js") + "</script>")
open(sys.argv[1], "w", encoding="utf-8").write(html)
print("wrote", sys.argv[1], os.path.getsize(sys.argv[1]) // 1024, "KB")
