#!/usr/bin/env node
/* CSV-driven carousel generator.
 *
 *   content/posts.csv  ->  templates/*.html  ->  .tmp/rendered/*.html
 *                      ->  Playwright Chromium  ->  output/YYYY-MM/post-id/slide-NN.png
 *
 * Usage:
 *   node scripts/generate.js                 render PNGs
 *   node scripts/generate.js --preview       write rendered HTML only, skip Chromium
 *   node scripts/generate.js --post <id>     render a single post_id only
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { parse } = require('csv-parse/sync');

const ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'content', 'posts.csv');
const CTA_PATH = path.join(ROOT, 'content', 'cta-library.json');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const ILLUSTRATION_DIR = path.join(ROOT, 'assets', 'illustrations');
const RENDER_DIR = path.join(ROOT, '.tmp', 'rendered');
const OUTPUT_DIR = path.join(ROOT, 'output');

const WIDTH = 1080;
const HEIGHT = 1350;

const BACKGROUNDS = ['bg-paper', 'bg-cream', 'bg-ink', 'bg-charcoal', 'bg-gray', 'bg-red'];

const PREVIEW = process.argv.includes('--preview');
const POST_FILTER = (() => {
  const i = process.argv.indexOf('--post');
  return i !== -1 ? process.argv[i + 1] : null;
})();

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------------- helpers */

// Literal "\n" in a CSV field becomes a real newline; templates render
// text with white-space:pre, so real newlines are real line breaks.
function toMultiline(value) {
  return value.split('\\n').join('\n');
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Placeholder replacement that never re-scans inserted content.
function fillTemplate(template, values) {
  const filled = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) fail(`Template uses unknown placeholder ${match}`);
    return values[key];
  });
  // Rendered copies live in .tmp/rendered/, so relative URLs (the local
  // Montserrat stylesheet) must still resolve against templates/.
  const base = `<base href="${pathToFileURL(TEMPLATE_DIR).href}/">`;
  return filled.replace('<head>', `<head>\n${base}`);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// A bare filename lives in assets/illustrations/; a value with a slash
// (e.g. assets/photos/portrait.png) is resolved from the repo root.
function resolveImage(value) {
  return value.includes('/') ? path.join(ROOT, value) : path.join(ILLUSTRATION_DIR, value);
}

/* ------------------------------------------------------------- load input */

function loadRows() {
  if (!fs.existsSync(CSV_PATH)) fail(`Missing CSV file: ${CSV_PATH}`);
  const rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  if (!rows.length) fail(`No rows found in ${CSV_PATH}`);
  return rows;
}

function loadCtaLibrary() {
  if (!fs.existsSync(CTA_PATH)) fail(`Missing CTA library: ${CTA_PATH}`);
  try {
    return JSON.parse(fs.readFileSync(CTA_PATH, 'utf8'));
  } catch (err) {
    fail(`Could not parse ${CTA_PATH}: ${err.message}`);
  }
}

function loadTemplates() {
  const templates = {};
  for (const name of ['cover', 'middle', 'closing']) {
    const file = path.join(TEMPLATE_DIR, `${name}.html`);
    if (!fs.existsSync(file)) fail(`Missing template: ${file}`);
    templates[name] = fs.readFileSync(file, 'utf8');
  }
  return templates;
}

/* ------------------------------------------------------------- validation */

function validateCarousel(postId, rows, ctaLibrary) {
  const where = `post "${postId}"`;
  const first = rows[0];

  if (!postId) fail('A CSV row has an empty post_id.');
  if (!rows.length) fail(`${where} has no middle-slide rows.`);

  const publishAt = first.publish_at || '';
  const match = publishAt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match || Number.isNaN(Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00`))) {
    fail(`${where}: publish_at "${publishAt}" is missing or invalid. Expected "YYYY-MM-DD HH:MM".`);
  }

  if (!first.cover_title) fail(`${where}: cover_title is empty.`);

  for (const [field, value] of [
    ['cover_background', first.cover_background],
    ['closing_background', first.closing_background],
  ]) {
    if (!BACKGROUNDS.includes(value)) {
      fail(`${where}: ${field} "${value}" is not supported. Use one of: ${BACKGROUNDS.join(', ')}.`);
    }
  }

  const ctaKey = first.cta_key;
  if (!ctaLibrary[ctaKey]) {
    fail(`${where}: cta_key "${ctaKey}" does not exist in content/cta-library.json. ` +
         `Known keys: ${Object.keys(ctaLibrary).join(', ')}.`);
  }

  const seenNumbers = new Set();
  for (const row of rows) {
    const rawNumber = row.slide_number;
    if (!rawNumber) fail(`${where}: a middle row is missing slide_number.`);
    const number = Number(rawNumber);
    if (!Number.isInteger(number) || number < 1) {
      fail(`${where}: slide_number "${rawNumber}" is not a positive integer.`);
    }
    if (seenNumbers.has(number)) fail(`${where}: slide_number ${number} is duplicated.`);
    seenNumbers.add(number);

    const slideWhere = `${where}, middle slide ${number}`;
    if (!row.middle_heading) fail(`${slideWhere}: middle_heading is empty.`);
    if (!row.middle_body) fail(`${slideWhere}: middle_body is empty.`);
    if (!BACKGROUNDS.includes(row.middle_background)) {
      fail(`${slideWhere}: middle_background "${row.middle_background}" is not supported. ` +
           `Use one of: ${BACKGROUNDS.join(', ')}.`);
    }
    if (row.middle_illustration) {
      const file = resolveImage(row.middle_illustration);
      if (!fs.existsSync(file)) {
        fail(`${slideWhere}: illustration "${row.middle_illustration}" not found. Expected file: ${file}`);
      }
    }
  }
}

/* -------------------------------------------------------------- rendering */

function buildSlides(postId, rows, templates, ctaLibrary) {
  const first = rows[0];
  const slides = [];

  // cover_subtitle may still exist in the CSV as a legacy column; it is
  // deliberately never rendered.
  slides.push({
    name: 'cover',
    html: fillTemplate(templates.cover, {
      BACKGROUND: first.cover_background,
      TITLE: escapeHtml(toMultiline(first.cover_title)),
    }),
    checks: ['.display'],
  });

  const middles = [...rows].sort((a, b) => Number(a.slide_number) - Number(b.slide_number));
  for (const row of middles) {
    const src = row.middle_illustration
      ? pathToFileURL(resolveImage(row.middle_illustration)).href
      : '';
    // slide_number is an internal ordering field only; it is never rendered.
    slides.push({
      name: `middle ${row.slide_number}`,
      html: fillTemplate(templates.middle, {
        BACKGROUND: row.middle_background,
        HEADING: escapeHtml(toMultiline(row.middle_heading)),
        BODY: escapeHtml(toMultiline(row.middle_body)),
        ILLUSTRATION_SRC: escapeHtml(src),
        ILLUSTRATION_ALT: escapeHtml(row.middle_alt || ''),
      }),
      checks: ['.title', '.body', '.illustration'],
    });
  }

  const cta = ctaLibrary[first.cta_key];
  slides.push({
    name: 'closing',
    html: fillTemplate(templates.closing, {
      BACKGROUND: first.closing_background,
      CTA_KEY: escapeHtml(first.cta_key),
      CTA_HEADING: escapeHtml(cta.heading),
      CTA_SUBHEADING: escapeHtml(cta.subheading),
    }),
    checks: ['.headline', '.subheading', '.phone', '.email'],
  });

  return slides;
}

async function renderSlide(page, htmlFile, checks, label) {
  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });

  // Freeze animations and transitions before measuring or capturing.
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });

  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.images)
      .filter((img) => img.getAttribute('src') && img.style.display !== 'none');
    await Promise.all(images.map(async (img) => {
      try {
        await img.decode();
      } catch {
        throw new Error(`Image failed to load: ${img.src}`);
      }
    }));
  });

  // The auto-fit script runs on fonts.ready; give it one settled frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const problems = await page.evaluate((selectors) => {
    const slide = document.querySelector('.slide');
    const bounds = slide.getBoundingClientRect();
    const found = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const tolerance = 1;
      if (r.left < bounds.left - tolerance || r.right > bounds.right + tolerance ||
          r.top < bounds.top - tolerance || r.bottom > bounds.bottom + tolerance) {
        found.push(`${sel} extends outside the 1080x1350 slide bounds`);
      }
      // Text may exceed its margin box by a hair when auto-fit clamps at
      // its minimum size; the slide only clips at its own edge
      // (overflow:hidden), so measure the rendered extent against that.
      if (r.left + el.scrollWidth > bounds.right + tolerance) {
        found.push(`${sel} text is clipped at the right slide edge`);
      }
    }
    return found;
  }, checks);

  if (problems.length) {
    fail(`${label}: content is clipped or outside the slide after auto-fit:\n  - ${problems.join('\n  - ')}\n` +
         'Shorten the copy or add explicit line breaks in the CSV.');
  }
}

/* -------------------------------------------------------------------- run */

async function main() {
  const rows = loadRows();
  const ctaLibrary = loadCtaLibrary();
  const templates = loadTemplates();

  // Group rows by post_id, preserving CSV order of posts.
  const carousels = new Map();
  for (const row of rows) {
    const id = row.post_id || '';
    if (!carousels.has(id)) carousels.set(id, []);
    carousels.get(id).push(row);
  }

  for (const [postId, postRows] of carousels) {
    validateCarousel(postId, postRows, ctaLibrary);
  }

  if (POST_FILTER) {
    if (!carousels.has(POST_FILTER)) {
      fail(`--post "${POST_FILTER}" does not match any post_id in the CSV. ` +
           `Known posts: ${[...carousels.keys()].join(', ')}.`);
    }
    for (const id of [...carousels.keys()]) {
      if (id !== POST_FILTER) carousels.delete(id);
    }
  }

  fs.rmSync(RENDER_DIR, { recursive: true, force: true });
  fs.mkdirSync(RENDER_DIR, { recursive: true });

  const jobs = [];
  for (const [postId, postRows] of carousels) {
    const slides = buildSlides(postId, postRows, templates, ctaLibrary);
    const month = postRows[0].publish_at.slice(0, 7);
    slides.forEach((slide, index) => {
      const fileBase = `${postId}-slide-${pad2(index + 1)}`;
      const htmlFile = path.join(RENDER_DIR, `${fileBase}.html`);
      fs.writeFileSync(htmlFile, slide.html);
      jobs.push({
        postId,
        month,
        htmlFile,
        checks: slide.checks,
        label: `post "${postId}", ${slide.name} (slide-${pad2(index + 1)}.png)`,
        pngFile: path.join(OUTPUT_DIR, month, postId, `slide-${pad2(index + 1)}.png`),
      });
    });
  }

  if (PREVIEW) {
    console.log(`Preview mode: rendered HTML written to ${path.relative(ROOT, RENDER_DIR)}/`);
    for (const job of jobs) console.log(`  ${path.relative(ROOT, job.htmlFile)}`);
    return;
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  try {
    for (const job of jobs) {
      await renderSlide(page, job.htmlFile, job.checks, job.label);
      fs.mkdirSync(path.dirname(job.pngFile), { recursive: true });
      await page.screenshot({
        path: job.pngFile,
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      });
      console.log(`wrote ${path.relative(ROOT, job.pngFile)}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${jobs.length} slide(s) rendered.`);
}

main().catch((err) => fail(err.stack || err.message));
