"""Rebuild clqn's three-key emblem, wordmark and README header with Pillow."""

from itertools import groupby
from pathlib import Path

from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[1] / "docs" / "assets"
PAPER = "#f9faf7"
INK = "#20231f"
ORANGE = "#ff783e"
DESCRIPTION = "Three isometric keycaps on one switch plate, with an orange return key."


def project(point, height):
    """Project one point from the switch plate onto the two-to-one pixel grid."""
    x, y = point
    return 46 + x - y, 27 + (x + y) // 2 - height


def octagon(radius, corner):
    r, c = radius, corner
    return [
        (-r + c, -r), (r - c, -r), (r, -r + c), (r, r - c),
        (r - c, r), (-r + c, r), (-r, r - c), (-r, -r + c),
    ]


# Legends use key coordinates, so their baselines follow the top faces.
PROMPT = [(-5, -4), (-3, -5), (3, -1), (3, 1), (-3, 5), (-5, 4), (0, 0)]
CURSOR = [(-4, 1), (4, 1), (4, 4), (-4, 4)]
RETURN = [
    (2, -5), (5, -5), (5, 2), (-1, 2), (-1, 5), (-6, 1),
    (-1, -4), (-1, -1), (2, -1),
]


def draw_key(draw, center, legend, orange=False, travel=0):
    x, y = center

    def at(points, height):
        return [project((x + u, y + v), height) for u, v in points]

    if orange:
        shadow, midtone, highlight, top = "#993e29", "#d65a30", "#ffaf80", ORANGE
    else:
        shadow, midtone, highlight, top = "#343a37", "#59605b", "#9ca39a", "#464c46"

    # The base of each switch stays put as its cap moves down.
    base = at(octagon(10, 2), 5)
    rim = at(octagon(8, 2), 16 - travel)
    for i in range(len(rim)):
        j = (i + 1) % len(rim)
        color = midtone if 3 <= i <= 6 else shadow
        draw.polygon([base[i], base[j], rim[j], rim[i]], fill=color)
    draw.polygon(rim, fill=INK)

    top_edge = at(octagon(8, 2), 17 - travel)
    draw.polygon(top_edge, fill=top)
    draw.line(top_edge[5:] + top_edge[:2], fill=highlight)
    draw.polygon(at(legend, 17 - travel), fill=INK if orange else PAPER)


def icon(travel=0):
    image = Image.new("RGBA", (93, 65))
    draw = ImageDraw.Draw(image)
    plate = [(-11, 11), (11, 11), (11, -11), (33, -11), (33, 33), (-11, 33)]
    for height in range(5):
        color = "#747b73" if height == 4 else INK
        draw.polygon([project(p, height) for p in plate], fill=color)

    draw_key(draw, (0, 22), PROMPT)
    draw_key(draw, (22, 0), CURSOR)
    draw_key(draw, (22, 22), RETURN, orange=True, travel=travel)
    return image


# Four hand-drawn lowercase glyphs share a baseline and two pixels of spacing.
LETTERS = [
    [".......", ".......", "..####.", ".######", "###..##", "##.....",
     "##.....", "###..##", ".######", "..####.", ".......", "......."],
    ["##...", "##...", "##...", "##...", "##...", "##...",
     "##...", "##...", "#####", ".####", ".....", "....."],
    ["........", "........", "..###.##", ".#######", "###..###", "##....##",
     "##....##", "###..###", ".#######", "..######", "......##", "......##"],
    [".......", ".......", "##.###.", "#######", "###..##", "##...##",
     "##...##", "##...##", "##...##", "##...##", ".......", "......."],
]


def wordmark():
    gap = 2
    width = sum(len(glyph[0]) for glyph in LETTERS) + gap * (len(LETTERS) - 1)
    image = Image.new("RGBA", (width, 12))
    draw = ImageDraw.Draw(image)
    left = 0
    for glyph in LETTERS:
        for y, row in enumerate(glyph):
            for x, pixel in enumerate(row):
                if pixel == "#":
                    draw.point((left + x, y), fill=INK)
        left += len(glyph[0]) + gap
    return image


def pixel_paths(image):
    """Combine horizontal runs by color to preserve the hand-pixeled contours."""
    paths = {}
    pixels = image.load()
    for y in range(image.height):
        x = 0
        for color, run in groupby(pixels[i, y] for i in range(image.width)):
            length = sum(1 for _ in run)
            if color[3]:
                fill = "#%02x%02x%02x" % color[:3]
                paths.setdefault(fill, []).append(f"M{x} {y}h{length}v1h-{length}z")
            x += length
    return "\n".join(f'  <path fill="{fill}" d="{"".join(runs)}"/>' for fill, runs in paths.items())


def write_svg(filename, size, scale, content, description):
    width, height = size
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width * scale}" height="{height * scale}" viewBox="0 0 {width} {height}" shape-rendering="crispEdges" role="img" aria-labelledby="title desc">
  <title id="title">clqn</title>
  <desc id="desc">{description}</desc>
{content}
</svg>
'''
    (ASSETS / filename).write_bytes(svg.encode())


def scale(image, factor):
    return image.resize((image.width * factor, image.height * factor), Image.Resampling.NEAREST)


def main():
    bounds = icon().getbbox()
    mark = icon().crop(bounds)
    name = wordmark()
    mark_paths = pixel_paths(mark)
    name_paths = pixel_paths(name)
    write_svg("logo.svg", mark.size, 4, mark_paths, DESCRIPTION)
    write_svg("wordmark.svg", name.size, 8, name_paths, "Lowercase pixel lettering.")

    size = (344, 104)
    letters = scale(name, 4)
    gap = 13
    left = (size[0] - mark.width - letters.width - gap) // 2
    key_at = (left, (size[1] - mark.height) // 2)
    name_at = (left + mark.width + gap, (size[1] - letters.height) // 2)
    header = f'''  <rect width="{size[0]}" height="{size[1]}" fill="{PAPER}"/>
  <g transform="translate({key_at[0]} {key_at[1]})">
{mark_paths}
  </g>
  <g transform="translate({name_at[0]} {name_at[1]}) scale(4)">
{name_paths}
  </g>'''
    write_svg("header.svg", size, 3, header, DESCRIPTION)

    # One return keypress. GIF players hold the resting pose after playback.
    frames = []
    for travel in (0, 2, 4, 2, 0):
        frame = Image.new("RGBA", size, PAPER)
        frame.alpha_composite(icon(travel).crop(bounds), key_at)
        frame.alpha_composite(letters, name_at)
        frames.append(scale(frame, 3).convert("RGB"))
    frames[0].save(
        ASSETS / "header.gif",
        save_all=True,
        append_images=frames[1:],
        duration=[700, 70, 170, 70, 1000],
        disposal=1,
        optimize=True,
    )


if __name__ == "__main__":
    main()
