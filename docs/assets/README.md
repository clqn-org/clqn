# clqn artwork

The [mark](logo.svg) is a three-key macropad. Two dark keys carry a prompt and a cursor. They share a switch plate with the orange return key. The [wordmark](wordmark.svg) uses four lowercase glyphs drawn on the same pixel grid. Both SVGs have transparent backgrounds.

The [README GIF](header.gif) presses the prompt, cursor, and Return keys in sequence, then pauses before repeating. The [homepage illustration](../../website/keycaps.svg) plays the same sequence in terminal characters. With reduced motion enabled, the homepage holds the resting pose and the README uses its [static header](header.svg).

Edit the geometry, colors, and keystroke timing in `scripts/generate-brand.py`. Rebuild the artwork from the repository root with Python and Pillow.

```sh
python -m pip install Pillow
python scripts/generate-brand.py
```
