# clqn brand assets

- `logo.svg`: square avatar with four terminals connected to one shared center.
- `header.svg`: static README header and reduced-motion alternative.
- `header.gif`: an eight-second loop of context flowing into a clan and three example commands being typed. The opening frame shows the complete header.

The coral mark represents people and their own agents meeting in one workspace. The header uses the project's tagline and supported CLI commands; it illustrates a workflow rather than showing a recorded session. Authentication and setup are covered in the main README.

Regenerate all three assets from the repository root on macOS:

```sh
swift scripts/generate-brand.swift
```

The generator uses Apple's Core Graphics, Core Text, and Image I/O frameworks, with no extra dependencies. Set `CLQN_BRAND_PREVIEW_DIR` to a temporary directory to also render PNG previews. Other platforms can use the checked-in assets directly. The SVGs use system font stacks; the GIF embeds its rendered text. Keep all three assets together when updating the visual identity.
