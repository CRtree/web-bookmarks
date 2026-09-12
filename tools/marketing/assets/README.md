# Marketing assets

## youtube-logo-white.svg

The official **YouTube** logo lockup (icon + white wordmark), sourced from
Wikimedia Commons' copy of the official mark:

- File: `YouTube 2024 (white text).svg`
- Source: <https://commons.wikimedia.org/wiki/File:YouTube_2024_(white_text).svg>
- Viewbox: 388.676 × 83.901 (4.633:1)

The file is committed rather than fetched at build time so `npm run assets` works
offline and produces byte-identical output.

### Why this variant

The wordmark is **white**, which is the published variant for dark backgrounds —
this tile has a dark background. It is used **unmodified**: no recolouring, no
cropping, no added effects, and it keeps its clear space. The only published
black-wordmark variant would be invisible here, and recolouring that one would
count as modifying the trademark.

### Branding guidelines

Chrome Web Store branding guidelines require that a Google product be referenced
with the words "for", "for use with", or "compatible with", plus the ™ symbol. The
tile therefore renders:

```
[Scroll Saver mark]  for  [YouTube logo] ™
```

Notes for anyone editing `small-tile.html`:

- Keep the `for` and the `™`. They are what makes the reference descriptive rather
  than an implied endorsement.
- Do not make the YouTube mark the most prominent element on the tile — the
  extension's own mark leads.
- Do not animate, recolour, stretch, or add effects to the YouTube logo.
- Do not use trade dress like "Official" or "Editor's Choice"; Google's guidelines
  explicitly prohibit claims that misrepresent status.

See: <https://developer.chrome.com/docs/webstore/branding>
