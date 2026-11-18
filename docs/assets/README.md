# clqn artwork

The [mark](logo.svg) is a three-key macropad. Two dark keys carry a prompt and a cursor. They share a switch plate with the orange return key. The [wordmark](wordmark.svg) uses four lowercase glyphs drawn on the same pixel grid. Both SVGs have transparent backgrounds.

The README has a [static header](header.svg) and a [GIF](header.gif) that presses Return once. Edit the key geometry, colors and letter patterns in `scripts/generate-brand.py`. Rebuild the artwork from the repository root with Python and Pillow.

```sh
python -m pip install Pillow
python scripts/generate-brand.py
```
