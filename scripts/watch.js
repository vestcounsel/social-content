#!/usr/bin/env node
/* Watch mode: keep PNGs in sync while you edit.
 *
 *   node scripts/watch.js [--post <id>]     (or: npm run watch)
 *
 * Two triggers:
 *   1. output/<post>/html/slide-NN.html changes
 *        -> that single slide is re-rendered straight to
 *           output/<post>/slide-NN.png (fast, no full pipeline).
 *   2. templates/*.html, content/posts.csv, or content/cta-library.json
 *        -> scripts/generate.js runs again (full validation), honoring
 *           the --post filter when one was given.
 *
 * The single-slide path is a fast preview: it waits for fonts and
 * images but skips the generator's overflow/collision validation.
 * Run npm run generate before shipping anything.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const { renderFile } = require('./render-html');

const ROOT = path.resolve(__dirname, '..');
const WIDTH = 1080;
const HEIGHT = 1350;

const POST = (() => {
  const i = process.argv.indexOf('--post');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const stamp = () => new Date().toTimeString().slice(0, 8);

/* ------------------------------------------------ single-slide rendering */

let browser = null;
let page = null;

async function getPage() {
  if (!page) {
    browser = await chromium.launch();
    page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
  }
  return page;
}

async function renderHtml(htmlFile, pngFile) {
  const p = await getPage();
  await renderFile(p, htmlFile, pngFile);
  console.log(`${stamp()}  updated ${path.relative(ROOT, pngFile)}`);
}

// Renders run one at a time; rapid saves queue up behind each other.
let renderChain = Promise.resolve();
function enqueueRender(htmlFile, pngFile, rel) {
  renderChain = renderChain.then(async () => {
    if (!fs.existsSync(htmlFile)) return;
    try {
      await renderHtml(htmlFile, pngFile);
    } catch (err) {
      console.log(`${stamp()}  render failed for ${rel}: ${err.message.split('\n')[0]}`);
    }
  });
}

/* ------------------------------------------------------- full generation */

let generating = false;
let queued = false;

function runGenerate(reason) {
  if (generating) { queued = true; return; }
  generating = true;
  const args = ['scripts/generate.js', ...(POST ? ['--post', POST] : [])];
  console.log(`${stamp()}  ${reason} -> node ${args.join(' ')}`);
  const child = spawn('node', args, { cwd: ROOT, stdio: 'inherit' });
  activeChild = child;
  child.on('exit', (code) => {
    activeChild = null;
    generating = false;
    if (code !== 0) console.log(`${stamp()}  generate exited with ${code} — still watching`);
    if (queued) { queued = false; runGenerate('queued change'); }
  });
}

// The generator child must die with the watcher, or it keeps writing
// PNGs after the watcher is gone.
let activeChild = null;

/* --------------------------------------------------------------- watchers */

const timers = new Map();
function debounce(key, fn) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(fn, 300));
}

function watchDir(dir, options, handler) {
  if (!fs.existsSync(dir)) return;
  fs.watch(dir, options, handler);
  console.log(`watching ${path.relative(ROOT, dir)}${options.recursive ? '/**' : ''}`);
}

watchDir(path.join(ROOT, 'templates'), {}, (event, name) => {
  if (!name || !name.endsWith('.html')) return;
  debounce(`gen:templates/${name}`, () => runGenerate(`templates/${name} changed`));
});

watchDir(path.join(ROOT, 'content'), {}, (event, name) => {
  if (name !== 'posts.csv' && name !== 'cta-library.json') return;
  debounce(`gen:content/${name}`, () => runGenerate(`content/${name} changed`));
});

watchDir(path.join(ROOT, 'output'), { recursive: true }, (event, rel) => {
  if (!rel || !rel.endsWith('.html')) return;
  const match = rel.match(/^(.+)[/\\]html[/\\](slide-\d+)\.html$/);
  if (!match) return;
  if (POST && match[1] !== POST) return;
  const htmlFile = path.join(ROOT, 'output', rel);
  const pngFile = path.join(ROOT, 'output', match[1], `${match[2]}.png`);
  debounce(`html:${rel}`, () => enqueueRender(htmlFile, pngFile, rel));
});

console.log(`watch mode ready${POST ? ` (post filter: ${POST})` : ''} — edit HTML and the PNG follows. Ctrl+C to stop.`);

async function shutdown() {
  console.log('\nstopping watch mode');
  if (activeChild) activeChild.kill('SIGTERM');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
