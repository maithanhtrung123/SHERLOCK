#!/usr/bin/env python3
"""Convert The Complete Sherlock Holmes .docx into the app's data files.

Usage:  python3 tools/build_book.py path/to/The_Complete_Sherlock_Holmes.docx

Writes:
  book/book.json        chapters + paragraphs (HTML with <em>/<br>)
  book/images/*.png     illustrations
"""
import html
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "book")
IMG_DIR = os.path.join(OUT_DIR, "images")

HEADINGS = {"Heading1": 1, "Heading2": 2, "Heading3": 3}
SKIP_STYLES = {"ContentsTitle", "ContentsLevel1", "ContentsLevel2", "ContentsLevel3"}
# paragraph style -> short class name used by the app's CSS
STYLE_CLASS = {
    "BodyText": "", "FirstParagraph": "", "Compact": "compact",
    "BlockText": "quote", "LetterSignature": "sign",
    "NewspaperHeading": "news", "BookIllustration": "img",
    "EditionNote": "note", "Title": "title", "Subtitle": "subtitle",
}

PARA_RE = re.compile(r"<w:p[ >].*?</w:p>|<w:p/>", re.S)
RUN_RE = re.compile(r"<w:r[ >].*?</w:r>", re.S)
ITEM_RE = re.compile(r'<w:t(?: [^>]*)?>([^<]*)</w:t>|<w:br[^>]*/>|<w:tab/>|r:embed="([^"]+)"')
STYLE_RE = re.compile(r'<w:pStyle w:val="([^"]+)"')
ITALIC_RE = re.compile(r'<w:i/>|<w:i w:val="(?:1|true|on)"/>')
DESCR_RE = re.compile(r'<wp:docPr[^>]*descr="([^"]*)"')


def para_html(p, rels, z, images):
    out = []
    plain = []
    for run in RUN_RE.findall(p):
        rpr = run.split("</w:rPr>")[0] if "<w:rPr>" in run else ""
        italic = bool(ITALIC_RE.search(rpr))
        buf = []
        for m in ITEM_RE.finditer(run):
            tok = m.group(0)
            if m.group(1) is not None:
                t = html.unescape(m.group(1))
                buf.append(html.escape(t, quote=False))
                plain.append(t)
            elif tok.startswith("<w:br"):
                buf.append("<br>")
                plain.append("\n")
            elif tok == "<w:tab/>":
                buf.append(" ")
                plain.append(" ")
            elif m.group(2):
                target = rels.get(m.group(2))
                if target:
                    name = os.path.basename(target)
                    if name not in images:
                        with open(os.path.join(IMG_DIR, name), "wb") as f:
                            f.write(z.read("word/" + target))
                        images.add(name)
                    d = DESCR_RE.search(run)
                    alt = html.escape(html.unescape(d.group(1))) if d else ""
                    buf.append(f'<img src="book/images/{name}" alt="{alt}">')
        s = "".join(buf)
        if italic and s.strip():
            s = f"<em>{s}</em>"
        out.append(s)
    h = "".join(out).replace("</em><em>", "")
    return h, "".join(plain)


def main(docx):
    os.makedirs(IMG_DIR, exist_ok=True)
    z = zipfile.ZipFile(docx)
    xml = z.read("word/document.xml").decode("utf-8")
    rels_xml = z.read("word/_rels/document.xml.rels").decode("utf-8")
    rels = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels_xml))
    images = set()

    sections = []
    path = ["About this book", "", ""]
    cur = {"path": ["About this book"], "title": "About this book", "paras": []}
    pid = 0
    for p in PARA_RE.findall(xml):
        m = STYLE_RE.search(p)
        style = m.group(1) if m else "BodyText"
        if style in SKIP_STYLES:
            continue
        h, plain = para_html(p, rels, z, images)
        if style in HEADINGS:
            lvl = HEADINGS[style]
            title = plain.replace("\n", " ").strip()
            path[lvl - 1] = title
            for k in range(lvl, 3):
                path[k] = ""
            if cur["paras"]:
                sections.append(cur)
            cur = {"path": [x for x in path if x], "title": title, "paras": []}
            continue
        if not h.strip():
            continue
        pid += 1
        cls = STYLE_CLASS.get(style, "")
        para = [pid, h]
        if cls:
            para.append(cls)
        cur["paras"].append(para)
    if cur["paras"]:
        sections.append(cur)

    for i, s in enumerate(sections):
        s["id"] = i
        s["words"] = sum(len(re.sub(r"<[^>]+>", " ", p[1]).split()) for p in s["paras"])

    with open(os.path.join(OUT_DIR, "book.json"), "w", encoding="utf-8") as f:
        json.dump({"title": "The Complete Sherlock Holmes", "author": "Arthur Conan Doyle",
                   "sections": sections}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(sections)} sections, {pid} paragraphs, {len(images)} images")


if __name__ == "__main__":
    main(sys.argv[1])
