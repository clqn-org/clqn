# clqn artwork

The [mark](logo.svg) has three pixel groundhogs in three separate earth holes staggered in depth: one at the back, one forward-left, and one farther forward-right. The static pose shows them at different heights. The [wordmark](wordmark.svg) uses four lowercase glyphs on the same pixel grid. Both SVGs and the [PNG mark](logo.png) have transparent backgrounds.

The [README GIF](header.gif) and [homepage animation](../../website/groundhogs.svg) show the characters popping up and fully retreating independently, with staggered starts and different pauses. All three reach the same full body height and jerk up six pixels for 160 milliseconds before dropping. Each rise and retreat takes 200 milliseconds; each loop lasts six seconds. The homepage renders the same poses in high-contrast colored ASCII characters with bright outlines, white eyes, and pink noses, using the [static illustration](../../website/groundhogs-still.svg) when reduced motion is enabled, and the README uses its [static header](header.svg).

Edit the pixel geometry, palette, and timing in `scripts/generate-brand.py`. Rebuild from the repository root with Python 3 and Pillow:

```sh
python3 -m pip install Pillow
python3 scripts/generate-brand.py
```

The original three-key artwork is preserved alongside the groundhog assets: [keycap logo](logo-keycaps.svg), [wordmark](wordmark-keycaps.svg), [static header](header-keycaps.svg), and [animated header](header-keycaps.gif). These archived files are not overwritten by the artwork generator.
