#!/usr/bin/env node
/* CSV-driven carousel generator.
 *
 *   content/posts.csv  ->  templates/*.html  ->  .tmp/rendered/*.html
 *                      ->  Playwright Chromium  ->  public/social/YYYY-MM/post-id/slide-NN.png
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
const OUTPUT_DIR = path.join(ROOT, 'public', 'social');

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
    // Older rows may predate optional trailing columns (middle_subheading).
    relax_column_count_less: true,
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
  // Brand rule: covers never use cream.
  if (first.cover_background === 'bg-cream') {
    fail(`${where}: bg-cream is not allowed as a cover background. ` +
         'Use bg-paper, bg-ink, bg-charcoal, bg-gray, or bg-red.');
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
    template: 'cover',
    html: fillTemplate(templates.cover, {
      BACKGROUND: first.cover_background,
      TITLE: escapeHtml(toMultiline(first.cover_title)),
    }),
    checks: ['.wordmark', '.display'],
  });

  const middles = [...rows].sort((a, b) => Number(a.slide_number) - Number(b.slide_number));
  for (const row of middles) {
    const src = row.middle_illustration
      ? pathToFileURL(resolveImage(row.middle_illustration)).href
      : '';
    // slide_number is an internal ordering field only; it is never rendered.
    slides.push({
      name: `middle (order ${row.slide_number})`,
      template: 'middle',
      html: fillTemplate(templates.middle, {
        BACKGROUND: row.middle_background,
        HEADING: escapeHtml(toMultiline(row.middle_heading)),
        SUBHEADING: escapeHtml(toMultiline(row.middle_subheading || '')),
        BODY: escapeHtml(toMultiline(row.middle_body)),
        ILLUSTRATION_SRC: escapeHtml(src),
        ILLUSTRATION_ALT: escapeHtml(row.middle_alt || ''),
      }),
      checks: ['.title', '.rule.r-top', '.subheading', '.body', '.illustration'],
      // The image must start at least 36px below the last line of text.
      minGapBelowText: '.illustration',
    });
  }

  const cta = ctaLibrary[first.cta_key];
  const closingHtml = fillTemplate(templates.closing, {
    BACKGROUND: first.closing_background,
    CTA_KEY: escapeHtml(first.cta_key),
    CTA_HEADING: escapeHtml(cta.heading),
    CTA_SUBHEADING: escapeHtml(cta.subheading),
  });
  assertCatUnchanged(templates.closing, closingHtml, postId);
  slides.push({
    name: 'closing',
    template: 'closing',
    html: closingHtml,
    checks: ['.headline', '.subheading', '.phone', '.email', '.web', '.cat'],
  });

  return slides;
}

// The cat is a locked brand asset: whatever background the CSV picks, the
// generated markup must carry the cat SVG exactly as stored in the template.
function assertCatUnchanged(templateHtml, generatedHtml, postId) {
  const catOf = (html) => {
    const match = html.match(/<svg class="cat"[\s\S]*?<\/svg>/);
    return match ? match[0] : null;
  };
  const original = catOf(templateHtml);
  const generated = catOf(generatedHtml);
  if (!original || generated !== original) {
    fail(`post "${postId}": the closing-slide cat asset would be modified during generation. ` +
         'The cat is locked and must be inserted exactly as stored in templates/closing.html.');
  }
}

async function renderSlide(page, htmlFile, job) {
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

  const problems = await page.evaluate(({ selectors, minGapBelowText }) => {
    const slide = document.querySelector('.slide');
    const bounds = slide.getBoundingClientRect();
    const tol = 2;
    const found = [];

    // Measure every major element. For text, measure the actual rendered
    // line boxes via a Range: element boxes span the full margin width, so
    // they would false-positive against elements on the other side of the
    // slide, and scrollWidth never reports less than the container width.
    const boxes = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === 'none') continue;
      const tag = el.tagName.toLowerCase();
      const isText = tag !== 'img' && tag !== 'svg' && !el.classList.contains('rule');
      let r = el.getBoundingClientRect();
      if (isText) {
        const range = document.createRange();
        range.selectNodeContents(el);
        r = range.getBoundingClientRect();
      }
      if (r.width === 0 && r.height === 0) continue;
      boxes.push({ sel, isText, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }

    // 1. Nothing may extend beyond the slide boundary (overflow:hidden
    //    clips exactly there).
    for (const b of boxes) {
      if (b.left < bounds.left - tol || b.right > bounds.right + tol ||
          b.top < bounds.top - tol || b.bottom > bounds.bottom + tol) {
        found.push(`overflow: ${b.sel} extends outside the 1080x1350 slide boundary`);
      }
    }

    // 2. No two major elements may overlap.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > tol && h > tol) {
          found.push(`collision: ${a.sel} overlaps ${b.sel}`);
        }
      }
    }

    // 3. An image must start at least 36px below the last line of text.
    if (minGapBelowText) {
      const img = document.querySelector(minGapBelowText);
      if (img && getComputedStyle(img).display !== 'none') {
        const imgTop = img.getBoundingClientRect().top;
        let lastTextBottom = -Infinity;
        for (const b of boxes) {
          if (b.isText && b.bottom <= imgTop + tol) lastTextBottom = Math.max(lastTextBottom, b.bottom);
        }
        if (Number.isFinite(lastTextBottom) && imgTop - lastTextBottom < 36 - tol) {
          found.push(`spacing: ${minGapBelowText} begins ${Math.round(imgTop - lastTextBottom)}px ` +
                     'below the text; the minimum is 36px');
        }
      }
    }

    return found;
  }, { selectors: job.checks, minGapBelowText: job.minGapBelowText || null });

  if (problems.length) {
    fail(`${job.label}: validation failed after fonts and images loaded:\n  - ${problems.join('\n  - ')}\n` +
         'Shorten the copy, add explicit line breaks in the CSV, or use a smaller image.');
  }

  // Report the final computed type sizes, warning when auto-fit drove an
  // element to its minimum (a sign the copy needs editing, not more shrink).
  const sizes = await page.evaluate(() => {
    const out = [];
    for (const sel of ['.display', '.title', '.subheading', '.body', '.headline']) {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === 'none') continue;
      out.push({ sel, px: Math.round(parseFloat(getComputedStyle(el).fontSize) * 2) / 2 });
    }
    return out;
  });
  const floors = {
    cover: { '.display': 72 },
    middle: { '.title': 48, '.subheading': 36, '.body': 36 },
    closing: { '.headline': 60, '.subheading': 24 },
  }[job.template] || {};
  for (const s of sizes) {
    if (floors[s.sel] !== undefined && s.px <= floors[s.sel]) {
      console.warn(`  warning: ${job.label}: ${s.sel} rendered at its ${floors[s.sel]}px minimum — ` +
                   'the copy may need editing');
    }
  }
  return sizes;
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

  // Empty the render directory rather than removing it: deleting the
  // directory itself can hit transient ENOTEMPTY races on overlayfs.
  fs.mkdirSync(RENDER_DIR, { recursive: true });
  for (const entry of fs.readdirSync(RENDER_DIR)) {
    fs.rmSync(path.join(RENDER_DIR, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

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
        template: slide.template,
        checks: slide.checks,
        minGapBelowText: slide.minGapBelowText,
        label: `post "${postId}", ${slide.name} [${slide.template} template] (slide-${pad2(index + 1)}.png)`,
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
      const sizes = await renderSlide(page, job.htmlFile, job);
      fs.mkdirSync(path.dirname(job.pngFile), { recursive: true });
      await page.screenshot({
        path: job.pngFile,
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      });
      const typeReport = sizes.map((s) => `${s.sel} ${s.px}px`).join(', ');
      console.log(`wrote ${path.relative(ROOT, job.pngFile)}  [${typeReport}]`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. ${jobs.length} slide(s) rendered.`);
}

main().catch((err) => fail(err.stack || err.message));
