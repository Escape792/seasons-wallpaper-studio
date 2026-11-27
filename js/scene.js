/* ===== 动态壁纸渲染器 =====
   架构：写实母版图（静态基底）+ 实时动态图层（雾气 / 光照 / 飘落物 / 水波 / 微呼吸运镜）+ 后期（调色 / 颗粒 / 暗角）

   无缝循环保证：所有随时间变化的量都是循环相位 phase∈[0,1) 的周期函数（整数倍谐波），
   因此渲染 phase=0 与 phase=1 的画面严格一致。
*/
(function (global) {
  'use strict';

  const U = global.WS.util;
  const A = global.WS.Assets;
  const TAU = Math.PI * 2;

  /* 季节专属的动效配置 */
  const SEASON_FX = {
    spring: { particle: 'petal', pcount: 1.0, pSize: 1.0, pSpin: 1.0, haze: 0.9, glint: 0.35 },
    summer: { particle: 'pollen', pcount: 0.45, pSize: 0.7, pSpin: 0.5, haze: 1.05, glint: 1.0 },
    autumn: { particle: 'leaf', pcount: 0.9, pSize: 1.15, pSpin: 1.4, haze: 0.95, glint: 0.45 },
    winter: { particle: 'snow', pcount: 1.25, pSize: 0.85, pSpin: 0.3, haze: 1.15, glint: 0.25 }
  };

  /* 宠物活动区域（画面相对坐标）
     y      脚底所在高度
     x0/x1  活动范围
     scale  相对画面高度（宠物类型的默认值会被覆盖）
     light  受光方向与强度：'front' 正面受光 | 'back' 逆光剪影 | 'side' 侧光
  */
  const PET_ZONE = {
    'forest-rain': { y: 0.885, x0: 0.12, x1: 0.88, scale: 0.30, light: 'side' },
    'forest-rain-l': { y: 0.870, x0: 0.14, x1: 0.86, scale: 0.185, light: 'side' }
  };

  function createRenderer(canvas, loader, petLoader) {
    const ctx = canvas.getContext('2d');
    const scene = document.createElement('canvas');   // 场景层（底图 + 前景 + 宠物）
    const sctx = scene.getContext('2d');
    const fx = document.createElement('canvas');      // 动态效果层（雾/光/粒子）
    const fctx = fx.getContext('2d');
    const comp = document.createElement('canvas');    // 合成层
    const cctx = comp.getContext('2d');
    const grainTiles = [];
    const GW = 256;

    /* ---------- 宠物：多类型可选 ---------- */
    const petSprites = {};          // kind -> { idle, walk, happy }
    let petKind = 'blue';
    let petReady = false;

    function loadPetKind(kind) {
      const def = A.PET_KINDS[kind];
      if (!def) return Promise.resolve();
      if (petSprites[kind]) { petReady = true; return Promise.resolve(); }
      const holder = {};
      return Promise.all(Object.keys(def.sprites).map(k =>
        petLoader.load(def.sprites[k]).then(img => { holder[k] = img; })
      )).then(() => { petSprites[kind] = holder; petReady = true; });
    }
    if (petLoader) {
      loadPetKind('blue').catch(e => console.error(e));
      loadPetKind('fluffy').catch(e => console.error(e));
    }

    const pet = global.WS.Pet.createPet({
      x: 0.62, y: (PET_ZONE['forest-rain-l']).y,
      scale: (PET_ZONE['forest-rain-l']).scale, facing: -1
    });
    let petEnabled = true;
    let lastPetTime = 0;

    const state = {
      scene: 'forest-rain-l', season: 'spring', style: 'real',
      sunAngle: 118, fog: 26, wind: 34, fall: 42,
      loopLen: 12, breathe: 30, phase: 0, portrait: false
    };

    let baseImg = null;
    let baseKey = '';
    let ready = false;
    const onReadyCbs = [];

    /* ---------- 尺寸 ---------- */
    function resize(w, h, dpr) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      scene.width = canvas.width; scene.height = canvas.height;
      fx.width = canvas.width; fx.height = canvas.height;
      comp.width = canvas.width; comp.height = canvas.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas._dpr = dpr;
      grainTiles.length = 0;
    }

    /* ---------- 素材切换（带竞态保护：只接受最后一次请求的结果）---------- */
    let loadSeq = 0;
    let loadedKey = '';
    function ensureBase() {
      const portrait = state.portrait ? true : false;
      const folder = portrait && A.PORTRAIT_SCENES[state.scene]
        ? state.scene + '-portrait/' : state.scene + '/';
      const key = folder + state.season;
      if (key === baseKey) return;
      baseKey = key;
      const seq = ++loadSeq;
      loader.load(state.scene, state.season, portrait).then(img => {
        if (seq !== loadSeq) return;      // 已被更新的请求取代，丢弃
        baseImg = img;
        loadedKey = key;
        ready = true;
        onReadyCbs.splice(0).forEach(cb => cb());
      }).catch(err => {
        if (seq !== loadSeq) return;
        console.error(err);
      });
    }

    function onReady(cb) {
      if (loadedKey === baseKey) cb();
      else onReadyCbs.push(cb);
    }

    /* ---------- 太阳位置（由阳光角度驱动）---------- */
    function sunPos(W, H) {
      const rad = (state.sunAngle * Math.PI) / 180;
      return {
        x: W * (0.5 - 0.44 * Math.cos(rad)),
        y: H * (0.40 - 0.36 * Math.sin(rad)),
        elevation: Math.sin(rad)          // -1..1，负值=地平线以下
      };
    }

    /* ================= 动态效果层 ================= */

    /* --- 雾气带 --- */
    function drawMist(f, W, H, meta, phase, strength) {
      if (strength < 0.02) return;
      const bands = meta.mist;
      for (let b = 0; b < bands.length; b++) {
        const baseY = H * bands[b];
        const hgt = H * 0.075;
        const drift = Math.sin(phase * TAU + b * 2.1) * W * 0.045;
        const n = 44;
        f.save();
        f.globalCompositeOperation = 'screen';
        for (let i = 0; i < n; i++) {
          const u = i / n;
          const wob = Math.sin(u * 7.3 + b * 1.7 + phase * TAU) * H * 0.012;
          const x = u * (W + 260) - 130 + drift;
          const ww = (W + 260) / n * 1.9;
          const a = strength * (0.10 + 0.05 * Math.sin(u * 11 + phase * TAU + b)) * (b === 0 ? 1 : 0.75);
          const g = f.createLinearGradient(0, baseY - hgt + wob, 0, baseY + hgt + wob);
          g.addColorStop(0, 'rgba(226,236,242,0)');
          g.addColorStop(0.5, 'rgba(232,240,246,' + a.toFixed(4) + ')');
          g.addColorStop(1, 'rgba(226,236,242,0)');
          f.fillStyle = g;
          f.fillRect(x, baseY - hgt + wob, ww, hgt * 2);
        }
        f.restore();
      }
    }

    /* --- 阳光光束 / 辉光 --- */
    function drawSunLight(f, W, H, style, phase) {
      const s = sunPos(W, H);
      const p = A.STYLE_META[state.style];
      const above = s.elevation > 0;
      const power = above ? (0.35 + 0.65 * s.elevation) : 0;

      // 环境辉光
      if (power > 0.01) {
        const g = f.createRadialGradient(s.x, s.y, 0, s.x, s.y, Math.max(W, H) * 0.75);
        const warm = state.season === 'autumn' ? '255,214,150' :
          state.season === 'winter' ? '226,238,255' :
            state.season === 'summer' ? '255,246,214' : '255,240,212';
        g.addColorStop(0, 'rgba(' + warm + ',' + (0.30 * power * p.flare + 0.06).toFixed(4) + ')');
        g.addColorStop(0.22, 'rgba(' + warm + ',' + (0.10 * power * p.flare + 0.03).toFixed(4) + ')');
        g.addColorStop(1, 'rgba(' + warm + ',0)');
        f.fillStyle = g;
        f.fillRect(0, 0, W, H);
      }

      // 体积光束（穿过树冠/雾气）
      if (power > 0.05 && p.flare > 0.3) {
        f.save();
        f.globalCompositeOperation = 'screen';
        const beams = 7;
        for (let i = 0; i < beams; i++) {
          const a = (i / beams) * Math.PI + 0.35 + Math.sin(phase * TAU) * 0.03;
          const spread = 0.05 + 0.035 * ((i * 7) % 3);
          const len = H * 1.5;
          const ang = Math.PI * 0.28;
          const ox = s.x + Math.cos(a) * W * 0.1;
          const oy = s.y + Math.sin(a) * H * 0.06;
          const alpha = power * p.flare * 0.055 * (0.6 + 0.4 * Math.sin(phase * TAU + i));
          const g = f.createLinearGradient(ox, oy, ox + Math.cos(ang) * len * spread * 3, oy + Math.sin(ang) * len);
          g.addColorStop(0, 'rgba(255,244,214,' + alpha.toFixed(4) + ')');
          g.addColorStop(1, 'rgba(255,244,214,0)');
          f.fillStyle = g;
          f.beginPath();
          f.moveTo(ox, oy);
          f.lineTo(ox + Math.cos(ang - spread) * len, oy + Math.sin(ang - spread) * len);
          f.lineTo(ox + Math.cos(ang + spread) * len, oy + Math.sin(ang + spread) * len);
          f.closePath();
          f.fill();
        }
        f.restore();
      }
    }

    /* --- 水面波光 --- */
    function drawWaterFx(f, W, H, meta, phase, glint) {
      if (!meta.water || glint < 0.02) return;
      const lvl = H * meta.horizon;
      const depth = H - lvl;
      if (depth <= 4) return;
      const s = sunPos(W, H);
      const fx0 = A.STYLE_META[state.style];
      f.save();
      f.beginPath(); f.rect(0, lvl, W, depth); f.clip();
      f.globalCompositeOperation = 'screen';

      // 阳光在水面上的光带
      const bandCx = s.x;
      for (let i = 0; i < 46; i++) {
        const u = i / 46;
        const y = lvl + Math.pow(u, 1.6) * depth;
        const spread = W * (0.02 + u * 0.16);
        const wob = Math.sin(phase * TAU * 2 + i * 0.7) * (2 + u * 14) * (0.4 + state.wind / 130);
        const x = bandCx + wob;
        const a = glint * fx0.bloom * 0.30 * (0.35 + 0.65 * Math.abs(Math.sin(phase * TAU * 3 + i * 0.5))) * (1 - u * 0.55);
        if (a <= 0.002) continue;
        const g = f.createRadialGradient(x, y, 0, x, y, spread);
        g.addColorStop(0, 'rgba(255,246,222,' + a.toFixed(4) + ')');
        g.addColorStop(1, 'rgba(255,246,222,0)');
        f.fillStyle = g;
        f.fillRect(x - spread, y - spread * 0.3, spread * 2, spread * 0.6);
      }

      // 细波纹
      f.globalCompositeOperation = 'source-over';
      f.strokeStyle = 'rgba(255,255,255,0.055)';
      f.lineWidth = Math.max(0.6, H * 0.0012);
      for (let i = 0; i < 26; i++) {
        const u = i / 26;
        const y = lvl + Math.pow(u, 1.4) * depth;
        const ph = phase * TAU * 2 + i * 0.85;
        f.beginPath();
        for (let k = 0; k <= 28; k++) {
          const uu = k / 28;
          const x = uu * W;
          const yy = y + Math.sin(ph + uu * 8.5) * (0.8 + u * 3.4);
          if (k === 0) f.moveTo(x, yy); else f.lineTo(x, yy);
        }
        f.stroke();
      }
      f.restore();
    }

    /* --- 前景草木摇曳（对照片底部做水平错位，形成风吹草动）--- */
    /* --- 前景草木：底部草叶随风摆动（直接绘制，不依赖底图）--- */
    function drawGrass(f, W, H, band, p, st, phase, windK) {
      if (!band) return;
      const y0 = H * band[0], y1 = H * band[1];
      const bh = y1 - y0;
      if (bh <= 4) return;
      const base = U.hex2rgb(p.ground);
      const dark = U.shade(base, 0.62);
      const snowy = state.season === 'winter';
      const n = 110;
      for (let i = 0; i < n; i++) {
        const r1 = U.hash1(i * 1.37), r2 = U.hash1(i * 2.71), r3 = U.hash1(i * 4.13);
        const x = r1 * W;
        const h = (0.10 + r2 * 0.30) * bh;
        const y = y1 - r3 * bh * 0.25;
        const sway = Math.sin(phase * TAU * 3 + r2 * TAU) * windK * 0.22 * h;
        const col = U.mixRgb(base, dark, 0.2 + r3 * 0.5);
        f.strokeStyle = U.rgba(snowy ? U.mixRgb(col, U.hex2rgb(p.snow), 0.4) : col, 0.85);
        f.lineWidth = Math.max(0.7, H * 0.0016 * (0.7 + r2));
        f.beginPath();
        f.moveTo(x, y);
        f.quadraticCurveTo(x + sway * 0.4, y - h * 0.6, x + sway, y - h);
        f.stroke();
      }
    }

    function drawFoliage(f, W, H, meta, phase, strength) {
      const band = meta.foliage;
      if (!band || strength < 0.03) return;
      const y0 = H * band[0], y1 = H * band[1];
      const bh = y1 - y0;
      if (bh <= 4) return;
      // 前景带做轻微水平位移与亮度调制，模拟风吹草动
      f.save();
      f.globalCompositeOperation = 'overlay';
      const strips = 14;
      for (let i = 0; i < strips; i++) {
        const u = i / strips;
        const sy = y0 + u * bh;
        const sh = bh / strips + 1;
        const dx = Math.sin(phase * TAU * 2 + u * 4.2) * strength * W * 0.0035;
        f.globalAlpha = 0.07 * strength;
        f.drawImage(scene,
          0, sy * (scene.height / H), scene.width, sh * (scene.height / H),
          dx, sy, W, sh + 1);
      }
      f.restore();
    }

    /* --- 飘落物 --- */
    function drawParticles(f, W, H, phase, meta) {
      const cfg = SEASON_FX[state.season];
      const style = A.STYLE_META[state.style];
      const fallK = state.fall / 100;
      const windK = state.wind / 100;
      const density = { sparse: 0.35, natural: 1, soft: 1.15, sparkle: 0.85, ink: 0.7 }[style.particleStyle] || 1;
      const n = Math.round(120 * cfg.pcount * density);
      const base = 4 * Math.max(1, Math.round(1 + fallK * 11));
      const CYC = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
      // 图标安全区：上方与中部保持干净，粒子不侵入
      const cleanTop = H * (meta ? meta.sky : 0.42);
      const cleanBottom = H * (meta ? (meta.sky + meta.iconMid) : 0.72);

      for (let i = 0; i < n; i++) {
        const r1 = U.hash1(i * 1.37 + 0.5), r2 = U.hash1(i * 2.71 + 1.5);
        const r3 = U.hash1(i * 4.13 + 2.5), r4 = U.hash1(i * 5.59 + 3.5);
        const r5 = U.hash1(i * 6.83 + 4.5), r6 = U.hash1(i * 8.11 + 5.5);
        const cycles = base * CYC[Math.floor(r2 * CYC.length) % CYC.length];
        const tt = (r1 + phase * cycles) % 1;
        const sway = Math.sin(phase * TAU * 2 + r3 * TAU) * (14 + 46 * windK);
        const drift = windK * 70 * Math.sin(phase * TAU + r6 * 6.28);
        const span = W + 240;
        const x = (((r4 * span - 120) + sway + drift) % span + span) % span - 120;
        // 粒子只在 cleanBottom → H 之间飘落，保持图标区干净
        const zone = Math.max(20, H - cleanBottom);
        const y = cleanBottom + tt * (zone + 90) - 45;
        if (y < cleanBottom - 46) continue;
        const sz = (3.0 + r5 * 6.0) * cfg.pSize * (W / 1920);

        f.save();
        f.translate(x, y);
        switch (cfg.particle) {
          case 'petal': {
            f.rotate(r3 * TAU + phase * TAU * 2 * cfg.pSpin);
            const col = U.mixRgb([250, 214, 226], [255, 240, 244], r2);
            f.fillStyle = 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',0.86)';
            f.beginPath(); f.ellipse(0, 0, sz * 1.0, sz * 0.58, 0, 0, TAU); f.fill();
            f.fillStyle = 'rgba(255,255,255,0.28)';
            f.beginPath(); f.ellipse(sz * 0.22, -sz * 0.12, sz * 0.42, sz * 0.26, 0, 0, TAU); f.fill();
            break;
          }
          case 'leaf': {
            f.rotate(phase * TAU * 2 * cfg.pSpin + r3 * TAU);
            const col = U.mixRgb([206, 122, 46], [178, 62, 34], r2);
            f.fillStyle = 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',0.90)';
            f.beginPath();
            f.moveTo(0, -sz * 1.15);
            f.quadraticCurveTo(sz * 1.0, -sz * 0.25, 0, sz * 1.15);
            f.quadraticCurveTo(-sz * 1.0, -sz * 0.25, 0, -sz * 1.15);
            f.fill();
            f.strokeStyle = 'rgba(90,52,26,0.45)';
            f.lineWidth = Math.max(0.5, sz * 0.06);
            f.beginPath(); f.moveTo(0, -sz); f.lineTo(0, sz); f.stroke();
            break;
          }
          case 'snow': {
            const g = f.createRadialGradient(0, 0, 0, 0, 0, sz * 1.8);
            g.addColorStop(0, 'rgba(255,255,255,0.95)');
            g.addColorStop(0.42, 'rgba(240,248,255,0.45)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            f.fillStyle = g;
            f.beginPath(); f.arc(0, 0, sz * 1.8, 0, TAU); f.fill();
            break;
          }
          case 'pollen': {
            const g = f.createRadialGradient(0, 0, 0, 0, 0, sz * 1.3);
            g.addColorStop(0, 'rgba(255,250,222,0.78)');
            g.addColorStop(0.4, 'rgba(255,244,196,0.30)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            f.fillStyle = g;
            f.beginPath(); f.arc(0, 0, sz * 1.3, 0, TAU); f.fill();
            break;
          }
        }
        f.restore();
      }
    }

    /* --- 风格化粒子（新海诚/水墨附加）--- */
    function drawStyleParticles(f, W, H, phase, meta) {
      const style = A.STYLE_META[state.style];
      const cleanTop = H * (meta ? meta.sky : 0.42);
      const cleanBottom = H * (meta ? (meta.sky + meta.iconMid) : 0.72);
      if (style.particleStyle === 'sparkle') {
        for (let i = 0; i < 46; i++) {
          const r1 = U.hash1(i * 3.7), r2 = U.hash1(i * 5.1), r3 = U.hash1(i * 7.9);
          const x = r1 * W;
          const zone = Math.max(20, H - cleanBottom);
          const y = cleanBottom + ((r2 + phase * 0.5) % 1) * zone;
          const a = 0.25 + 0.45 * Math.abs(Math.sin(phase * TAU * 2 + r3 * TAU));
          const s = 3 + r3 * 5;
          const g = f.createRadialGradient(x, y, 0, x, y, s * 3);
          g.addColorStop(0, 'rgba(255,255,240,' + (a * 0.8).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(255,255,220,0)');
          f.fillStyle = g;
          f.beginPath(); f.arc(x, y, s * 3, 0, TAU); f.fill();
        }
      } else if (style.particleStyle === 'ink') {
        f.save();
        f.globalCompositeOperation = 'multiply';
        for (let i = 0; i < 22; i++) {
          const r1 = U.hash1(i * 4.3), r2 = U.hash1(i * 6.1);
          const x = r1 * W;
          const zone = Math.max(20, H - cleanBottom);
          const y = cleanBottom + ((r2 + phase * 0.6) % 1) * zone;
          const a = 0.05 + 0.05 * Math.abs(Math.sin(phase * TAU + r1 * 9));
          f.fillStyle = 'rgba(60,66,72,' + a.toFixed(3) + ')';
          f.beginPath(); f.ellipse(x, y, 26 + r1 * 46, 8 + r1 * 16, r1 * 2, 0, TAU); f.fill();
        }
        f.restore();
      }
    }

    /* ================= 后期 ================= */
    function ensureGrain() {
      if (grainTiles.length) return;
      for (let t = 0; t < 4; t++) {
        const gc = document.createElement('canvas');
        gc.width = gc.height = GW;
        const g = gc.getContext('2d');
        const img = g.createImageData(GW, GW);
        const rnd = U.mulberry32(777 + t * 31);
        for (let i = 0; i < GW * GW; i++) {
          const v = 128 + (rnd() - 0.5) * 255;
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        grainTiles.push(gc);
      }
    }

    /* ---------------- 主渲染 ---------------- */
    function render(phase) {
      const dpr = canvas._dpr || 1;
      const W = canvas.width / dpr, H = canvas.height / dpr;
      const meta = A.SCENE_META[state.scene];
      const sty = A.STYLE_META[state.style];
      const cfg = SEASON_FX[state.season];
      const p = U.PALETTES[state.season];

      ensureBase();
      if (!baseImg) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#12171d';
        ctx.fillRect(0, 0, W, H);
        return;
      }

      /* --- 1. 底图（等比裁切填充）+ 镜头微呼吸 --- */
      const bk = state.breathe / 100;
      const zoom = 1 + (Math.sin(phase * TAU) * 0.5 + 0.5) * 0.016 * bk;
      const panX = Math.sin(phase * TAU + 0.7) * 0.0045 * bk * W;
      const panY = Math.cos(phase * TAU) * 0.0032 * bk * H;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, W, H);
      sctx.save();
      sctx.translate(W / 2 + panX, H / 2 + panY);
      sctx.scale(zoom, zoom);
      sctx.translate(-W / 2, -H / 2);
      // cover 裁切（竖版素材不额外裁切，横向素材按 42% 偏上取景）
      const ir = baseImg.width / baseImg.height;
      const cr = W / H;
      let sw, sh, sx, sy;
      if (ir > cr) { sh = baseImg.height; sw = sh * cr; sx = (baseImg.width - sw) / 2; sy = 0; }
      else { sw = baseImg.width; sh = sw / cr; sx = 0; sy = (baseImg.height - sh) * 0.42; }
      sctx.drawImage(baseImg, sx, sy, sw, sh, 0, 0, W, H);
      sctx.restore();

      /* --- 2. 地面 / 水面 / 前景草地 --- */
      /* 注：底图本身已包含水面与倒影（写实母版），此处只补动态前景 */
      drawGrass(sctx, W, H, meta.grassBand, p, sty, phase, state.wind / 100);

      /* --- 2.5 宠物（画面内互动角色）：在前景草木之后、雾气之前 --- */
      if (petReady && petEnabled && petSprites[petKind]) {
        const zone = PET_ZONE[state.scene] || PET_ZONE['forest-rain-l'];
        // 宠物动画使用独立时间轴（不影响壁纸循环数学）
        const now = performance.now();
        const dt = lastPetTime ? Math.min(0.05, (now - lastPetTime) / 1000) : 0;
        lastPetTime = now;
        pet.setPosition(pet.state.x, zone.y);
        pet.opts.scale = zone.scale * (A.PET_KINDS[petKind] ? A.PET_KINDS[petKind].scale / 0.22 : 1);        pet.update(dt, zone.y, { x0: zone.x0, x1: zone.x1 });

        // 让宠物接受场景光照：主光来自太阳位置，环境色来自季节色调
        const tintCol = U.hex2rgb(meta.tint[state.season] || '#d8e2e8');
        const sunCol = U.hex2rgb(p.sun);
        const env = [
          (tintCol[0] * 0.55 + sunCol[0] * 0.45),
          (tintCol[1] * 0.55 + sunCol[1] * 0.45),
          (tintCol[2] * 0.55 + sunCol[2] * 0.45)
        ];
        pet.draw(sctx, W, H, petSprites[petKind], {
          light: zone.light,
          tintColor: env,
          tintStrength: 0.20 + state.fog / 100 * 0.18,
          rimColor: sunCol,
          hazeAmount: state.fog / 100 * 0.10,
          hazeColor: U.rgba(U.hex2rgb(p.haze), 1),
          groundWet: state.scene === 'forest-rain'
        });
        pet.drawFood(sctx, W, H);
      }

      /* --- 1.5 动态效果层（雾 / 阳光 / 波光 / 草木 / 粒子）--- */
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fctx.clearRect(0, 0, W, H);
      const fogK = (state.fog / 100) * cfg.haze;
      drawMist(fctx, W, H, meta, phase, fogK);
      drawSunLight(fctx, W, H, sty, phase);
      drawWaterFx(fctx, W, H, meta, phase, cfg.glint);
      drawFoliage(fctx, W, H, meta, phase, state.wind / 100);
      drawParticles(fctx, W, H, phase, meta);
      drawStyleParticles(fctx, W, H, phase, meta);

      /* --- 3. 合成 + 调色 --- */
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cctx.clearRect(0, 0, W, H);
      cctx.drawImage(scene, 0, 0, scene.width, scene.height, 0, 0, W, H);
      cctx.drawImage(fx, 0, 0, fx.width, fx.height, 0, 0, W, H);

      // 画风色调
      const tintCol = meta.tint[state.season] || '#d8e2e8';
      cctx.save();
      cctx.globalCompositeOperation = sty.warm > 0 ? 'soft-light' : 'overlay';
      cctx.globalAlpha = Math.abs(sty.tintA);
      const tg = cctx.createLinearGradient(0, 0, W, H);
      tg.addColorStop(0, sty.warm > 0 ? '#ffd9a8' : '#cfe0ee');
      tg.addColorStop(1, tintCol);
      cctx.fillStyle = tg;
      cctx.fillRect(0, 0, W, H);
      cctx.restore();

      /* --- 4. 输出：滤镜 + 后期 --- */
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const filter = 'saturate(' + sty.sat.toFixed(2) + ') contrast(' + sty.contrast.toFixed(2) + ') brightness(' + (1 + sty.lift).toFixed(2) + ')';
      ctx.save();
      ctx.filter = filter;
      ctx.drawImage(comp, 0, 0, comp.width, comp.height, 0, 0, W, H);
      ctx.restore();

      // 提亮（胶片 lift）
      if (sty.lift > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighten';
        ctx.globalAlpha = sty.lift * 0.30;
        ctx.fillStyle = '#1a1f26';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      // 纸纹（水墨/吉卜力）
      if (sty.paper > 0) {
        ensureGrain();
        ctx.save();
        ctx.globalAlpha = sty.paper;
        ctx.globalCompositeOperation = 'overlay';
        ctx.fillStyle = ctx.createPattern(grainTiles[Math.floor(phase * 4) % 4], 'repeat');
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      // 暗角
      if (sty.vignette > 0) {
        const g = ctx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.30, W / 2, H * 0.5, Math.max(W, H) * 0.82);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(8,11,16,' + sty.vignette + ')');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      // 胶片颗粒
      if (sty.grain > 0) {
        ensureGrain();
        ctx.save();
        ctx.globalAlpha = sty.grain;
        ctx.globalCompositeOperation = 'overlay';
        ctx.fillStyle = ctx.createPattern(grainTiles[Math.floor(phase * 8) % 4], 'repeat');
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }

    return {
      state,
      resize,
      render,
      onReady,
      isReady: () => ready,
      setScene(k) { state.scene = k; baseKey = ''; ensureBase(); },
      setSeason(s) { state.season = s; baseKey = ''; ensureBase(); },
      setStyle(s) { state.style = s; },
      setParam(k, v) { state[k] = v; if (k === 'portrait') { baseKey = ''; ensureBase(); } },
      getMeta() { return A.SCENE_META[state.scene]; },
      /* ---- 宠物交互 API ---- */
      pet,
      setPetEnabled(v) { petEnabled = !!v; pet.setEnabled(!!v); },
      petEnabled: () => petEnabled,
      setPetKind(k) {
        if (!A.PET_KINDS[k]) return;
        petKind = k;
        petReady = false;
        loadPetKind(k).then(() => { petReady = true; }).catch(e => console.error(e));
      },
      petKind: () => petKind,
      petSetCursor(x, y, active) { pet.setCursor(x, y, active); },
      petDown(x, y) { pet.onDown(x, y); },
      petMove(x, y) { pet.onMove(x, y); },
      petUp() { pet.onUp(); },
      petFeed(x, y) { pet.dropFood(x, y); },
      petHasFood: () => pet.hasFood(),
      petState: () => pet.state.state
    };
  }

  global.WS.Scene = { createRenderer };
})(window);
