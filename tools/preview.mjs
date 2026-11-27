#!/usr/bin/env node
/* 快速验证：渲染若干静态帧并保存 PNG，用于人工检查视觉效果 */
import { launch } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/chrome.exe']
  .find(p => existsSync(p));

const outDir = join(ROOT, '.preview');
mkdirSync(outDir, { recursive: true });

const browser = await launch({
  executablePath: EDGE, headless: 'new',
  args: ['--allow-file-access-from-files', '--hide-scrollbars', '--disable-gpu']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('[console]', m.text()); });

await page.goto('file:///' + join(ROOT, 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
await page.waitForFunction('window.WSApp && window.WSApp.renderer');
await page.evaluate(() => window.WSApp.setFrozen(true));

const cases = [
  { scene: 'valley', season: 'spring', style: 'real', file: 'valley-spring' },
  { scene: 'valley', season: 'summer', style: 'real', file: 'valley-summer' },
  { scene: 'valley', season: 'autumn', style: 'real', file: 'valley-autumn' },
  { scene: 'valley', season: 'winter', style: 'real', file: 'valley-winter' },
  { scene: 'valley', season: 'spring', style: 'shinkai', file: 'valley-shinkai' },
  { scene: 'valley', season: 'autumn', style: 'ghibli', file: 'valley-ghibli' },
  { scene: 'valley', season: 'winter', style: 'ink', file: 'valley-ink' },
  { scene: 'sea', season: 'summer', style: 'real', file: 'sea-summer' },
  { scene: 'court', season: 'autumn', style: 'real', file: 'court-autumn' },
  { scene: 'path', season: 'spring', style: 'real', file: 'path-spring' },
  { scene: 'forest', season: 'winter', style: 'real', file: 'forest-winter' }
];

for (const cs of cases) {
  const dataUrl = await page.evaluate(async (c) => {
    const A = window.WSApp;
    A.setScene(c.scene); A.setSeason(c.season); A.setStyle(c.style);
    A.resize(1280, 720);
    await A.waitReady();
    A.renderPhase(0.12);
    await new Promise(r => requestAnimationFrame(() => r()));
    return A.canvas.toDataURL('image/png');
  }, cs);
  writeFileSync(join(outDir, cs.file + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('ok', cs.file);
}
await browser.close();
console.log('preview dir:', outDir);
