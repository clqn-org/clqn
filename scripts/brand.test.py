"""Regression checks for the website's ASCII artwork."""

from pathlib import Path
import runpy
import unittest

from PIL import Image

brand = runpy.run_path(str(Path(__file__).with_name("generate-brand.py")))


class AsciiEyesTest(unittest.TestCase):
    def test_eyes_stay_identical_for_all_characters_at_every_visible_height(self):
        peak = brand["FULL_HEIGHT"] + brand["ANTICIPATION_PIXELS"]
        for character in range(3):
            for height in range(16, peak + 1):
                with self.subTest(character=character, height=height):
                    heights = [0, 0, 0]
                    heights[character] = height
                    grid = brand["icon"](tuple(heights), ascii_art=True).resize(
                        (96, 31), Image.Resampling.NEAREST
                    )
                    colors = list(grid.getdata())
                    self.assertEqual(colors.count((249, 250, 247, 255)), 2)
                    self.assertEqual(colors.count((36, 31, 36, 255)), 10)


if __name__ == "__main__":
    unittest.main()
