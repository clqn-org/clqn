"""Rebuild the README wordmark and its introductory animation from logo.svg."""

from pathlib import Path
from xml.etree import ElementTree

import pymupdf
from PIL import Image


ASSETS = Path(__file__).resolve().parents[1] / "docs" / "assets"
SVG = "{http://www.w3.org/2000/svg}"
WIDTH, HEIGHT = 1040, 384

# Each outline is drawn on the same baseline as the standalone q.
C = """M93 19 80 42q-9-7-21-7-23 0-23 23 0 22 23 22 13 0 26-9l8 23
       q-16 12-39 12C21 106 1 88 1 59 1 29 23 8 56 8q23 0 37 11z"""
L = """M8-21h33V65q0 13 13 13h9l-15 26h-9Q8 104 8 73z"""
N = """M4 11h29v12Q45 8 63 8q36 0 36 40v56H66V53q0-17-14-17-15 0-15 18v50H4z"""


def wordmark(paper, ink, q, lift=0):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 520 192" role="img" aria-labelledby="title desc">
  <title id="title">clqn</title>
  <desc id="desc">Lowercase clqn lettering with a terminal prompt inside the q.</desc>
  <rect width="520" height="192" fill="{paper}"/>
  <g transform="matrix(1 0 -.17 1 82 40)" fill="{ink}">
    <path d="{C}"/>
    <path transform="translate(95)" d="{L}"/>
    <path transform="translate(158 {lift})" fill-rule="evenodd" d="{q}"/>
    <path transform="translate(270)" d="{N}"/>
  </g>
</svg>
'''


def render(svg):
    with pymupdf.open(stream=svg.encode(), filetype="svg") as document:
        pixels = document[0].get_pixmap()
        return Image.frombytes("RGB", (pixels.width, pixels.height), pixels.samples)


def main():
    logo = ElementTree.parse(ASSETS / "logo.svg")
    paper = logo.find(f"{SVG}rect").attrib["fill"]
    ink = logo.find(f"{SVG}g").attrib["fill"]
    q = logo.find(".//*[@id='q']").attrib["d"]
    poster = wordmark(paper, ink, q)
    (ASSETS / "header.svg").write_bytes(poster.encode())

    # The q makes one keystroke and rests. Omit the GIF loop extension so
    # readers who stay on the README see the wordmark settle permanently.
    positions = [0, 1, 3, 6, 8, 5, 2, 0]
    frames = [render(wordmark(paper, ink, q, lift)) for lift in positions]
    frames[0].save(
        ASSETS / "header.gif",
        save_all=True,
        append_images=frames[1:],
        duration=[900, 40, 40, 40, 140, 50, 50, 1000],
        disposal=1,
        optimize=True,
    )


if __name__ == "__main__":
    main()
