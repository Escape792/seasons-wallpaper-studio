#!/usr/bin/env node
/* ============================================================
   离线批量渲染器
   用无头 Edge 打开壁纸工作室，按固定相位步进逐帧抓取 PNG，
   再由 ffmpeg 编码为可无缝循环的 MP4 / WebM / GIF。

   用法：
     node tools/render.mjs --scene valley --season spring --style real \
        --aspect 16:9 --width 1920 --height 1080 --fps 30 --seconds 12 \
        --out out/valley-spring.mp4
   ============================================================ */
import { launch } from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const OPT = {
  scene: arg('scene', 'valley'),
  season: arg('season', 'spring'),
  style: arg('style', 'real'),
  aspect: arg('aspect', '16:9'),
  width: parseInt(arg('width', '1920'), 10),
  height: parseInt(arg('height', '1080'), 10),
  fps: parseInt(arg('fps', '30'), 10),
  seconds: parseFloat(arg('seconds', '12')),
  sunAngle: arg('sunAngle', '118'),
  fog: arg('fog', '26'),
  wind: arg('wind', '34'),
  fall: arg('fall', '42'),
  breathe: arg('breathe', '30'),
  out: arg('out', 'out/render.mp4'),
  keepFrames: argv.includes('--keep-frames'),
  quality: arg('quality', 'high')
};

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const browserPath = EDGE_CANDIDATES.find(p => existsSync(p));
if (!browserPath) { console.error('找不到 Edge/Chrome 可执行文件'); process.exit(1); }

function findFfmpeg() {
  if (ffmpegPath && existsSync(ffmpegPath)) return ffmpegPath;
  for (const c of ['ffmpeg', 'C:/Program Files/Gyan.FFmpeg/bin/ffmpeg.exe']) {
    try {
      if (c === 'ffmpeg') {
        require('node:child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
        return c;
      }
    } catch (e) { /* next */ }
    if (c.includes('/') && existsSync(c)) return c;
  }
  return null;
}
const FFMPEG = findFfmpeg();
if (!FFMPEG) { console.error('找不到 ffmpeg，请先安装（Gyan.FFmpeg）或 npm i ffmpeg-static'); process.exit(1); }

/* ---------- 主流程 ---------- */
// 帧目录复用（每次渲染覆盖），避免产生大批量临时文件
const frameDir = join(ROOT, '.frames', 'frames');
mkdirSync(frameDir, { recursive: true });
mkdirSync(dirname(resolve(ROOT, OPT.out)), { recursive: true });

console.log(`[render] ${OPT.scene}/${OPT.season}/${OPT.style} ${OPT.width}x${OPT.height} ${OPT.fps}fps ${OPT.seconds}s`);

const browser = await launch({
  executablePath: browserPath,
  headless: 'new',
  args: ['--allow-file-access-from-files', '--hide-scrollbars', '--disable-gpu',
    `--window-size=${OPT.width},${OPT.height}`]
});
const page = await browser.newPage();
await page.setViewport({ width: OPT.width, height: OPT.height, deviceScaleFactor: 1 });
page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', e => console.error('[pageerror]', e.message));

const url = 'file:///' + join(ROOT, 'index.html').replace(/\\/g, '/');
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.WSApp && window.WSApp.renderer');

await page.evaluate((o) => {
  const A = window.WSApp;
  A.setFrozen(true);
  A.setScene(o.scene);
  A.setSeason(o.season);
  A.setStyle(o.style);
  A.setParam('sunAngle', +o.sunAngle);
  A.setParam('fog', +o.fog);
  A.setParam('wind', +o.wind);
  A.setParam('fall', +o.fall);
  A.setParam('breathe', +o.breathe);
  A.setParam('loopLen', o.seconds);
  A.setParam('portrait', o.portrait);
  A.resize(o.width, o.height);
}, {
  scene: OPT.scene, season: OPT.season, style: OPT.style,
  sunAngle: OPT.sunAngle, fog: OPT.fog, wind: OPT.wind, fall: OPT.fall,
  breathe: OPT.breathe, seconds: OPT.seconds, width: OPT.width, height: OPT.height,
  portrait: OPT.aspect === '9:16'
});

// 等待母版图加载完成
await page.evaluate(async () => { await window.WSApp.waitReady(); });

const total = Math.round(OPT.fps * OPT.seconds);
const step = 1 / OPT.fps;

for (let i = 0; i < total; i++) {
  const phase = i * step / OPT.seconds;   // 0 → (N-1)/N，不重复首帧
  const dataUrl = await page.evaluate(async (ph) => {
    window.WSApp.renderPhase(ph);
    await new Promise(r => requestAnimationFrame(() => r()));
    return window.WSApp.canvas.toDataURL('image/jpeg', 0.97);
  }, phase);
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  writeFileSync(join(frameDir, 'f' + String(i).padStart(5, '0') + '.jpg'), buf);
  if (i % 15 === 0) process.stdout.write(`  frame ${i}/${total}\r`);
}
console.log(`  frames ok: ${total}          `);

await browser.close();

/* ---------- 编码 ---------- */
const outPath = resolve(ROOT, OPT.out);
const isGif = /\.gif$/i.test(OPT.out);
const isWebm = /\.webm$/i.test(OPT.out);

let args;
if (isGif) {
  args = ['-y', '-framerate', String(OPT.fps), '-i', join(frameDir, 'f%05d.jpg'),
    '-vf', `fps=${OPT.fps},scale=${OPT.width}:${OPT.height}:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=sierra2_4a`,
    '-loop', '0', outPath];
} else if (isWebm) {
  args = ['-y', '-framerate', String(OPT.fps), '-i', join(frameDir, 'f%05d.jpg'),
    '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuv420p',
    '-an', outPath];
} else {
  args = ['-y', '-framerate', String(OPT.fps), '-i', join(frameDir, 'f%05d.jpg'),
    '-c:v', 'libx264', '-preset', OPT.quality === 'high' ? 'slow' : 'medium',
    '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outPath];
}

console.log('[ffmpeg]', args.join(' '));
await new Promise((res, rej) => {
  const p = spawn(FFMPEG, args, { stdio: 'inherit' });
  p.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg exit ' + code)));
});

console.log('[done]', outPath);
