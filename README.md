# social-content

CSV-driven carousel generator. CSV content flows into the existing HTML slide
templates, SVG illustrations drop into the middle slides, Playwright renders
each slide in Chromium, and the result is final 1080 × 1350 PNG files.

This is an **HTML + SVG assets → PNG** workflow. The HTML is rendered and
screenshotted; nothing is converted to SVG along the way.

## Structure

```
social-content/
├── assets/illustrations/   SVG illustrations used on middle slides
├── templates/
│   ├── cover.html          cover slide template
│   ├── middle.html         middle slide template
│   └── closing.html        closing (CTA) slide template
├── content/
│   ├── posts.csv           carousel content, one row per middle slide
│   └── cta-library.json    approved closing headings and subheadings
├── scripts/generate.js     the generator
└── public/social/          generated PNGs, grouped by month and post
```

Each template opens directly in a browser for visual review — it falls back
to sample content whenever its `{{PLACEHOLDERS}}` have not been replaced.

## Setup

```
npm install
npx playwright install chromium
```

## Adding illustrations

Drop SVG files into `assets/illustrations/` and reference them by filename in
the `middle_illustration` CSV column (e.g. `document.svg`). Leave the field
empty for a slide without an illustration. SVGs are placed as-is — never
renamed, redrawn, or rasterized ahead of time.

## Editing content/posts.csv

One row per **middle** slide. Rows sharing a `post_id` form one carousel;
repeat the carousel-level fields (cover, CTA, publish time) on every row.

Columns:

```
post_id,publish_at,cover_title,cover_subtitle,cover_background,slide_number,
middle_heading,middle_body,middle_illustration,middle_alt,middle_background,
cta_key,closing_background,middle_subheading
```

- `publish_at` uses `YYYY-MM-DD HH:MM`; its month decides the output folder.
- Write `\n` inside a field for an explicit line break.
- Backgrounds: `bg-paper`, `bg-cream`, `bg-ink`, `bg-charcoal`, `bg-gray`, `bg-red`.
  Covers never use `bg-cream` — the generator rejects it.
- `slide_number` orders the middle slides and must be unique per post. It is
  internal only — slide numbers are never displayed on a slide.
- `middle_subheading` is an optional bold line (e.g. a person's name) placed
  between the divider and the body.
- `cover_subtitle` is a legacy column; the generator ignores it entirely.

## CTA keys

The closing slide's heading and subheading come from
`content/cta-library.json`, selected by the `cta_key` column. Add new closing
language there; an unknown key stops generation with an error, so only
approved copy ships.

## Generating PNGs

```
npm run generate
```

The generator validates every carousel, renders each slide in Chromium, checks
for overflow and element collisions, and writes PNGs to:

```
public/social/YYYY-MM/<post_id>/slide-01.png   (cover)
public/social/YYYY-MM/<post_id>/slide-02.png   (middle slides…)
public/social/YYYY-MM/<post_id>/slide-NN.png   (closing, always last)
```

`node scripts/generate.js --post <post_id>` regenerates a single carousel.

Every PNG is exactly 1080 × 1350.

`npm run preview` writes the filled-in HTML to `.tmp/rendered/` without
launching Chromium, so slides can be inspected in a browser first.

## Watch mode

```
npm run watch                       # watch everything
npm run watch -- --post <post_id>   # focus on one post
```

While it runs, editing `output/<post>/html/slide-NN.html` re-renders just
that slide's PNG in place within about a second, and editing a template or
`content/` file re-runs the full generator. The single-slide path is a fast
preview without the generator's overflow/collision validation — run
`npm run generate` before shipping.
