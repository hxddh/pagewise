#!/usr/bin/env python3
"""Second typesetter for the evaluation corpus: `python3 eval/corpus/build_reportlab.py`.

`build.mjs` explains why the corpus is generated. This half exists so that the
same words reach the extractor through a PDF producer other than Chromium:
ReportLab writes its own text operators, its own word spacing and — with
`pyphen` installed — breaks English words at line ends with a real hyphen
glyph in the text layer, which is exactly the case a quote has to survive.

Requires `pip install reportlab pyphen`. Only needed to rebuild; the PDFs are
committed.
"""
import html
import re
from pathlib import Path

from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, PageBreak

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"

pdfmetrics.registerFont(TTFont("WQY", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", subfontIndex=0))
pdfmetrics.registerFont(TTFont("LibSerif", "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"))


def folio(label):
    def draw(canvas, doc):
        canvas.saveState()
        canvas.setFont("LibSerif", 8)
        w, h = doc.pagesize
        canvas.drawCentredString(w / 2, 12 * mm, f"{label} — {doc.page}")
        canvas.restoreState()
    return draw


def gpl():
    text = (SRC / "gpl-3.0.txt").read_text(encoding="utf8")
    body = ParagraphStyle(
        "b", fontName="LibSerif", fontSize=10.5, leading=13.2, alignment=TA_JUSTIFY,
        spaceAfter=5, hyphenationLang="en_US", embeddedHyphenation=1, uriWasteReduce=0.3,
    )
    story = []
    for para in re.split(r"\n\s*\n", text):
        para = re.sub(r"\s*\n\s*", " ", para).strip()
        if para:
            story.append(Paragraph(html.escape(para), body))
    doc = SimpleDocTemplate(str(HERE / "gpl-3.0.pdf"), pagesize=LETTER,
                            leftMargin=30 * mm, rightMargin=30 * mm, topMargin=22 * mm, bottomMargin=24 * mm,
                            title="GNU General Public License v3")
    doc.build(story, onFirstPage=folio("GNU GPL v3"), onLaterPages=folio("GNU GPL v3"))


def strip_tags(s):
    return html.unescape(re.sub(r"<br\s*/?>", "\n", re.sub(r"<(?!br)[^>]+>", "", s))).strip()


def contract():
    src = (SRC / "contract-zh.html").read_text(encoding="utf8")
    body = re.search(r"<body>(.*)</body>", src, re.S).group(1)
    base = dict(fontName="WQY", wordWrap="CJK")
    h1 = ParagraphStyle("h1", fontSize=17, leading=24, alignment=TA_CENTER, spaceAfter=10, **base)
    h2 = ParagraphStyle("h2", fontSize=12.5, leading=18, spaceBefore=9, spaceAfter=3, **base)
    p = ParagraphStyle("p", fontSize=10.5, leading=18, firstLineIndent=21, alignment=TA_JUSTIFY, spaceAfter=3, **base)
    note = ParagraphStyle("n", fontSize=8.5, leading=13, spaceAfter=6, **base)
    cell = ParagraphStyle("c", fontSize=9, leading=13, **base)
    story = []
    for m in re.finditer(r"<(h1|h2[^>]*|p[^>]*|table[^>]*)>(.*?)</(h1|h2|p|table)>", body, re.S):
        tag, inner = m.group(1), m.group(2)
        if tag.startswith("h2") and "break" in tag:
            story.append(PageBreak())
        if tag == "h1":
            story.append(Paragraph(strip_tags(inner), h1))
        elif tag.startswith("h2"):
            story.append(Paragraph(strip_tags(inner), h2))
        elif tag.startswith("p"):
            story.append(Paragraph(html.escape(strip_tags(inner)), note if "note" in tag else p))
        else:
            rows = []
            for row in re.findall(r"<tr>(.*?)</tr>", inner, re.S):
                cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
                rows.append([Paragraph(html.escape(strip_tags(c)).replace("\n", "<br/>"), cell) for c in cells])
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            t = Table(rows, hAlign="LEFT")
            if "sign" not in tag:
                t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, "#444444"), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
            story.append(Spacer(0, 3))
            story.append(t)
            story.append(Spacer(0, 5))
    doc = SimpleDocTemplate(str(HERE / "contract-zh-rl.pdf"), pagesize=A4,
                            leftMargin=22 * mm, rightMargin=22 * mm, topMargin=20 * mm, bottomMargin=22 * mm,
                            title="设备采购与维护服务合同")
    doc.build(story, onFirstPage=folio("PW-EVAL-2025-0417"), onLaterPages=folio("PW-EVAL-2025-0417"))


if __name__ == "__main__":
    gpl()
    contract()
    print("reportlab corpus built")
