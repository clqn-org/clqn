# clqn artwork

[logo.svg](logo.svg) is the standalone `q`. The cutout in its bowl is the terminal prompt. The [README header](header.svg) uses the same outline in the full wordmark. In the [GIF](header.gif), the `q` dips once like a keypress and settles.

Edit the mark in `logo.svg` and the other three letter outlines in `scripts/generate-brand.py`. To rebuild the headers, run these commands from the repository root in a Python environment with Pillow and PyMuPDF.

```sh
python -m pip install Pillow PyMuPDF
python scripts/generate-brand.py
```
