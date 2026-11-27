#!/usr/bin/env node
/* ============================================================
   四季壁纸出图：森林雨径 × 春夏秋冬，一次生成 4 张成品
   产出：out/wallpaper/{spring,summer,autumn,winter}.png
   ============================================================ */
import { launch } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find(p => existsSync(p));

const W = parseInt(process.argv[2] || '1080', 10);
const H = parseInt(process.argv[3] || '1920', 10);
const PET = process.argv[5] || 'blue';
const OUTDIR = join(ROOT, 'out', process.argv[6] || (W < H ? 'wallpaper' : 'wallpaper-16x9'));
// 竖屏用 forest-rain 母版，横屏用 forest-rain-l 母版
const SCENE = W < H ? 'forest-rain' : 'forest-rain-l';
mkdirSync(OUTDIR, { recursive: true });

const browser = await launch({ executablePath: EDGE, headless: 'new',
  args: ['--allow-file-access-from-files', '--hide-scrollbars', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('[console]', m.text()); });

await page.goto('file:///' + join(ROOT, 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
await page.waitForFunction('window.WSApp && window.WSApp.renderer');
await page.evaluate(() => window.WSApp.setFrozen(true));

const seasons = ['spring', 'summer', 'autumn', 'winter'];
for (const s of seasons) {
  const d = await page.evaluate(async (o) => {
    const A = window.WSApp;
    A.setScene(o.scene);
    A.setSeason(o.season);
    A.setPetKind(o.pet);
    A.setParam('portrait', o.portrait);
    A.setParam('sunAngle', o.sunAngle);
    A.setParam('fog', o.fog);
    A.setParam('wind', o.wind);
    A.setParam('fall', o.fall);
    A.resize(o.w, o.h);
    await A.waitReady();
    await new Promise(r => setTimeout(r, 900));
    A.renderPhase(o.phase);
    await new Promise(r => requestAnimationFrame(() => r()));
    return A.canvas.toDataURL('image/png');
  }, {
    scene: SCENE, season: s, pet: PET, w: W, h: H,
    portrait: W < H, phase: 0.22,
    sunAngle: s === 'autumn' ? 128 : (s === 'winter' ? 96 : 112),
    fog: s === 'winter' ? 42 : (s === 'autumn' ? 34 : 28),
    wind: s === 'winter' ? 42 : 32,
    fall: s === 'winter' ? 30 : 46
  });
  const file = join(OUTDIR, `${s}.png`);
  writeFileSync(file, Buffer.from(d.split(',')[1], 'base64'));
  console.log('saved', file);
}
await browser.close();
console.log('DONE');
