"""Render the illustrative README workflow. Requires Pillow; no live services.

Output is abridged to omit IDs, URLs, and Git metadata. TASK and WORKER
represent IDs saved after setup. Visible output lines retain the CLI's
wording; omitted lines are described by the opening shell comment.
This is an illustration, not a recording of a live API/GitHub session.
Run: python3 scripts/generate-demo.py
"""

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parents[1] / 'docs' / 'assets'
FONT_PATHS = [os.environ.get('CLQN_DEMO_FONT', ''),
              '/System/Library/Fonts/Menlo.ttc',
              '/System/Library/Fonts/SFNSMono.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']
FONT_PATH = next((p for p in FONT_PATHS if p and Path(p).exists()), None)
if not FONT_PATH:
    raise SystemExit('Set CLQN_DEMO_FONT to a monospace TrueType font.')
FONT = ImageFont.truetype(FONT_PATH, 17)
BG, INK, MUTED, GREEN = '#000000', '#f0f0e9', '#a7aa9e', '#afd75f'
SIZE = (1032, 320)
COLUMNS, ROWS, LINE_HEIGHT, MARGIN = 100, 13, 22, 12
# Each command uses the named actor's credentials, as in the README.
SCENES = [
    ('Orchestrator: assign the login task', [
        ('clqn task assign "$TASK" --agent "$WORKER"', []),
    ]),
    ('Worker: work in isolation, then submit a PR', [
        ('clqn task start "$TASK" --path ../login', []),
        ('cd ../login', []),
        ('# Edit, test, and commit changes.', []),
        ('clqn task submit "$TASK"', ['Integration: open']),
    ]),
    ('Orchestrator: check and merge the PR', [
        ('clqn task check "$TASK"', ['OPEN  checks=passed']),
        ('clqn task merge "$TASK"', ['Integration: merged']),
    ]),
    ('Worker: finish the task and view progress', [
        ('clqn task done "$TASK"', []),
        ('clqn status', ['CLAN / clqn', '2 members  /  3 agents', '',
            'TASKS / 1 total',
            'Completed [################################] 1 100%', '',
            '100% complete / 0 remaining']),
    ]),
]


def wrap(line):
    return [line[i:i + COLUMNS] for i in range(0, len(line), COLUMNS)] or ['']


def render(lines, cursor=False):
    im = Image.new('RGB', SIZE, BG)
    d = ImageDraw.Draw(im)
    visible = [part for line in lines for part in wrap(line)][-ROWS:]
    for row, line in enumerate(visible):
        y = MARGIN + row * LINE_HEIGHT
        if line.startswith('$ '):
            d.text((MARGIN, y), '$', font=FONT, fill=GREEN)
            d.text((MARGIN + FONT.getlength('$'), y), line[1:], font=FONT, fill=INK)
        else:
            d.text((MARGIN, y), line, font=FONT,
                   fill=MUTED if line.startswith('#') else INK)
    if cursor:
        x = MARGIN + FONT.getlength(visible[-1] if visible else '')
        y = MARGIN + (len(visible) - 1) * LINE_HEIGHT
        d.rectangle((x + 1, y + 2, x + 10, y + 20), fill=INK)
    return im


def main():
    frames, durations = [], []

    def append(im, ms):
        frames.append(im)
        durations.append(ms)

    for i, (role, commands) in enumerate(SCENES):
        # Like clearing a terminal between steps: keep each stage easy to scan.
        lines = ['# ' + role]
        if i == 0:
            lines.extend(['# $TASK and $WORKER are IDs; output is abridged.', ''])
        else:
            lines.append('')
        for command, output in commands:
            for count in range(0, len(command), 2):
                append(render(lines + ['$ ' + command[:count]], True), 50)
            lines.append('$ ' + command)
            append(render(lines, True), 200)
            lines.extend(output)
            append(render(lines), 600)
        append(render(lines), 3500 if i == len(SCENES) - 1 else 2400)
    lines.extend(['', '$ '])
    append(render(lines, True), 1800)
    # Use one palette across frames to avoid color flicker.
    palette = frames[-1].quantize(colors=64)
    indexed = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in frames]
    ASSETS.mkdir(parents=True, exist_ok=True)
    indexed[0].save(ASSETS / 'demo.gif', save_all=True, append_images=indexed[1:],
                    duration=durations, loop=0, optimize=True, disposal=1)
    frames[-1].save(ASSETS / 'demo.png', optimize=True)
    print(f'{len(frames)} frames / {sum(durations) / 1000:.1f}s / '
          f'{(ASSETS / "demo.gif").stat().st_size / 1024:.0f} KiB')


if __name__ == '__main__':
    main()
