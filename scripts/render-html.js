#!/usr/bin/env node
/* Render exported slide HTML files straight to their PNGs.
 *
 *   node scripts/render-html.js output/<post>/html/slide-02.html [more...]
 *
 * output/<post>/html/slide-NN.html renders to output/<post>/slide-NN.png.
 * Exported HTML carries absolute file:// URLs (the <base> tag and image
 * sources) from the machine that generated it; they are rewritten to this
 * checkout before rendering so the files render correctly anywhere,
 * including CI.
 *
 * Used by the render-slides GitHub Action and by scripts/watch.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.tmp', 'render-cli');
const WIDTH = 1080;
const HEIGHT = 1350;

// Rewrite any absolute file:// reference into repo assets/ or templates/
// so exported HTML renders identically on any machine.
function normalize(html) {
  const rootUrl = pathToFileURL(ROOT).href;
  return html.replace(/file:\/\/[^"']*?\/(assets|templates)\//g, `${rootUrl}/$1/`);
}

function pngFor(htmlFile) {
  const abs = path.resolve(htmlFile);
  const match = abs.match(/(.*)[/\\]html[/\\](slide-\d+)\.html$/);
  if (match) return path.join(match[1], `${match[2]}.png`);
  return abs.replace(/\.html$/, '.png');
}

async function renderFile(page, htmlFile, pngFile) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpFile = path.join(TMP_DIR, `${Date.now()}-${path.basename(htmlFile)}`);
  fs.writeFileSync(tmpFile, normalize(fs.readFileSync(htmlFile, 'utf8')));
  try {
    await page.goto(pathToFileURL(tmpFile).href, { waitUntil: 'load' });
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      const images = Array.from(document.images)
        .filter((img) => img.getAttribute('src') && img.style.display !== 'none');
      await Promise.all(images.map((img) => img.decode().catch(() => {})));
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: pngFile, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

async function main() {
  const files = process.argv.slice(2).filter((f) => f.endsWith('.html'));
  if (!files.length) {
    console.log('usage: node scripts/render-html.js <slide.html> [more...]');
    return;
  }
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  try {
    for (const file of files) {
      if (!fs.existsSync(file)) {
        console.log(`skipped (missing) ${file}`);
        continue;
      }
      const pngFile = pngFor(file);
      await renderFile(page, file, pngFile);
      console.log(`rendered ${path.relative(ROOT, pngFile)}`);
    }
  } finally {
    await browser.close();
  }
}

module.exports = { renderFile, pngFor };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
