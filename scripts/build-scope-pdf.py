#!/usr/bin/env python3
"""
Regenerate docs/RecruitMe-Project-Scope.pdf from docs/PROJECT-SCOPE.md.

Dependency-free: converts the (simple) markdown to styled HTML and prints it to
PDF with headless Chrome. Run after editing PROJECT-SCOPE.md so the PDF the
client sees stays in sync:

    python3 scripts/build-scope-pdf.py

Handles the constructs this doc uses: # / ## / ### headers, --- rules, GFM
tables, "- " bullet lists, blank-line paragraphs, and inline **bold** / *italic*
/ `code`. Not a general markdown engine — just enough for this doc.
"""
import html
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "PROJECT-SCOPE.md")
OUT_PDF = os.path.join(ROOT, "docs", "RecruitMe-Project-Scope.pdf")
TMP_HTML = os.path.join(ROOT, "docs", ".scope-build.html")

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "chromium", "chromium-browser",
]


def inline(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    return text


def render(md: str) -> str:
    lines = md.split("\n")
    out, i, n = [], 0, len(lines)
    while i < n:
        line = lines[i]
        # Table: a row of |...| followed by a |---| separator
        if line.lstrip().startswith("|") and i + 1 < n and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            header = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < n and lines[i].lstrip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            out.append("<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in header) + "</tr></thead><tbody>")
            for r in rows:
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>")
            out.append("</tbody></table>")
            continue
        if re.match(r"^#{1,6}\s", line):
            level = len(line) - len(line.lstrip("#"))
            out.append(f"<h{level}>{inline(line.lstrip('#').strip())}</h{level}>")
            i += 1
            continue
        if re.match(r"^\s*---\s*$", line):
            out.append("<hr>")
            i += 1
            continue
        if line.lstrip().startswith("- "):
            out.append("<ul>")
            while i < n and lines[i].lstrip().startswith("- "):
                out.append(f"<li>{inline(lines[i].lstrip()[2:])}</li>")
                i += 1
            out.append("</ul>")
            continue
        if line.strip() == "":
            i += 1
            continue
        # paragraph (gather consecutive non-blank, non-structural lines)
        para = [line]
        i += 1
        while i < n and lines[i].strip() and not re.match(r"^(#{1,6}\s|\s*---\s*$|\s*\|)", lines[i]) and not lines[i].lstrip().startswith("- "):
            para.append(lines[i])
            i += 1
        out.append("<p>" + inline(" ".join(para)) + "</p>")
    return "\n".join(out)


CSS = """
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1d1d1f; font-size: 10.5pt; line-height: 1.5; max-width: 800px; margin: 0 auto; }
h1 { font-size: 21pt; margin: 0 0 4px; color: #0a3d62; }
h2 { font-size: 14pt; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #0a84ff; color: #0a3d62; }
h3 { font-size: 11.5pt; margin: 14px 0 6px; color: #333; }
p { margin: 8px 0; }
ul { margin: 8px 0; padding-left: 20px; }
li { margin: 3px 0; }
hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
code { background: #f2f2f4; padding: 1px 5px; border-radius: 4px; font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 9pt; }
strong { color: #111; }
em { color: #555; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 9.3pt; }
th, td { border: 1px solid #d8d8dc; padding: 6px 9px; text-align: left; vertical-align: top; }
th { background: #0a3d62; color: #fff; font-weight: 600; }
tbody tr:nth-child(even) { background: #f7f8fa; }
h2, h3 { page-break-after: avoid; }
table, ul { page-break-inside: avoid; }
"""


def main() -> int:
    with open(SRC, encoding="utf-8") as f:
        md = f.read()
    body = render(md)
    doc = f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{body}</body></html>"
    with open(TMP_HTML, "w", encoding="utf-8") as f:
        f.write(doc)

    chrome = next((c for c in CHROME_CANDIDATES if os.path.exists(c) or _on_path(c)), None)
    if not chrome:
        print("ERROR: no Chrome/Chromium found for PDF printing.", file=sys.stderr)
        return 1
    subprocess.run([
        chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
        f"--print-to-pdf={OUT_PDF}", "file://" + TMP_HTML,
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.remove(TMP_HTML)
    print(f"Wrote {OUT_PDF} ({os.path.getsize(OUT_PDF)} bytes)")
    return 0


def _on_path(name: str) -> bool:
    return any(os.path.exists(os.path.join(p, name)) for p in os.environ.get("PATH", "").split(os.pathsep))


if __name__ == "__main__":
    sys.exit(main())
