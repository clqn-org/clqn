"""Rebuild clqn's logos, README GIF and animated terminal illustration."""

from itertools import groupby
from pathlib import Path

from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[1] / "docs" / "assets"
WEBSITE = ASSETS.parents[1] / "website"
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

KEYS = (
    ("prompt", (0, 22), PROMPT),
    ("cursor", (22, 0), CURSOR),
    ("return", (22, 22), RETURN),
)

# Timing in milliseconds and key travel in pixels, shared by the GIF and SVG.
SEQUENCE = (
    (250, (0, 0, 0)),
    (60, (3, 0, 0)), (170, (7, 0, 0)), (70, (3, 0, 0)), (130, (0, 0, 0)),
    (60, (0, 3, 0)), (170, (0, 7, 0)), (70, (0, 3, 0)), (130, (0, 0, 0)),
    (60, (0, 0, 3)), (60, (0, 0, 6)), (270, (0, 0, 9)),
    (70, (0, 0, 6)), (70, (0, 0, 3)), (750, (0, 0, 0)),
)


def draw_key(draw, center, legend, orange=False, travel=0, return_ink=INK):
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
    draw.polygon(at(legend, 17 - travel), fill=return_ink if orange else PAPER)


def draw_plate(draw):
    plate = [(-11, 11), (11, 11), (11, -11), (33, -11), (33, 33), (-11, 33)]
    for height in range(5):
        color = "#747b73" if height == 4 else INK
        draw.polygon([project(p, height) for p in plate], fill=color)


def icon(travel=(0, 0, 0), return_ink=INK):
    image = Image.new("RGBA", (93, 65))
    draw = ImageDraw.Draw(image)
    draw_plate(draw)
    for (name, center, legend), depth in zip(KEYS, travel):
        draw_key(draw, center, legend, orange=name == "return", travel=depth, return_ink=return_ink)
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


def write_terminal(bounds):
    # Rasterize the same poses on a monospace grid. Share identical scanlines
    # between poses so the browser downloads each line of text only once.
    palette = {
        "#20231f": ("=", "#85909d"), "#747b73": ("/", "#9ba8b5"),
        "#464c46": ("+", "#aeb9c5"), "#9ca39a": ("/", "#d7dde4"),
        PAPER: ("█", "#f5f5ef"), "#59605b": ("#", "#8a97a6"),
        "#343a37": (":", "#7f8d9c"), ORANGE: ("#", "#ffab78"),
        "#ffaf80": ("/", "#ffe1b8"), "#d65a30": ("+", "#f99462"),
        "#993e29": (":", "#de814f"), "#86503c": ("@", "#86503c"),
    }
    columns, rows = 77, 28
    cell_width, cell_height = 10, 14
    width, height = columns * cell_width, rows * cell_height
    poses = list(dict.fromkeys(pose for _, pose in SEQUENCE))
    lines = {}
    frames = []
    resting_rows = []
    for index, pose in enumerate(poses):
        grid = icon(pose, return_ink="#86503c").crop(bounds).resize((columns, rows), Image.Resampling.NEAREST)
        references = []
        for y in range(rows):
            runs = []
            x = 0
            for rgba, run in groupby(grid.getpixel((col, y)) for col in range(columns)):
                length = sum(1 for _ in run)
                if rgba[3]:
                    char, fill = palette["#%02x%02x%02x" % rgba[:3]]
                    runs.append(f'<tspan x="{x * cell_width}" fill="{fill}">{char * length}</tspan>')
                x += length
            line_id = lines.setdefault("".join(runs), len(lines))
            references.append(f'<use href="#r{line_id}" y="{13 + y * cell_height}"/>')
            if index == 0:
                resting_rows.append(f'<text y="{13 + y * cell_height}">{"".join(runs)}</text>')
        frames.append(f'<g transform="translate(0 {height * index})">{"".join(references)}</g>')

    total = sum(duration for duration, _ in SEQUENCE)
    elapsed = 0
    steps = []
    for duration, pose in SEQUENCE:
        offset = -height * poses.index(pose)
        steps.append(f'{100 * elapsed / total:.3f}% {{ transform: translateY({offset}px); }}')
        elapsed += duration
    definitions = "\n".join(f'<text id="r{i}">{row}</text>' for row, i in lines.items())
    opening = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" overflow="hidden" role="img" aria-labelledby="title">
  <title id="title">The clqn keycaps drawn in terminal characters</title>'''
    font = 'font-family="monospace" font-size="16.6" font-weight="bold"'
    still = f'{opening}\n  <g {font}>\n{chr(10).join(resting_rows)}\n  </g>\n</svg>\n'
    (WEBSITE / "keycaps-still.svg").write_bytes(still.encode())
    svg = f'''{opening}
  <style>
    @media (prefers-reduced-motion: no-preference) {{
      .strip {{ animation: press {total}ms step-end infinite; }}
    }}
    @keyframes press {{ {" ".join(steps)} 100% {{ transform: translateY(0); }} }}
  </style>
  <defs>
{definitions}
  </defs>
  <g class="strip" {font}>
{chr(10).join(frames)}
  </g>
</svg>
'''
    (WEBSITE / "keycaps.svg").write_bytes(svg.encode())


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

    write_terminal(bounds)
    frames = []
    for _, travel in SEQUENCE:
        frame = Image.new("RGBA", size, PAPER)
        frame.alpha_composite(icon(travel).crop(bounds), key_at)
        frame.alpha_composite(letters, name_at)
        frames.append(scale(frame, 3).convert("RGB"))
    frames[0].save(
        ASSETS / "header.gif",
        save_all=True,
        append_images=frames[1:],
        duration=[duration for duration, _ in SEQUENCE],
        loop=0,
        disposal=1,
        optimize=True,
    )


if __name__ == "__main__":
    main()
