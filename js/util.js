/* ===== 工具函数：随机、噪声、插值、颜色 ===== */
(function (global) {
  'use strict';

  // ---- 确定性伪随机（mulberry32），保证构图/几何跨季完全一致 ----
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash1(n) {
    const s = Math.sin(n * 127.1) * 43758.5453123;
    return s - Math.floor(s);
  }

  function smoothstep(t) { return t * t * (3 - 2 * t); }

  // 1D 值噪声，周期 period 用于无缝循环
  function makeNoise1D(seed, period) {
    const P = period || 256;
    const rnd = mulberry32(seed);
    const tbl = new Float32Array(P);
    for (let i = 0; i < P; i++) tbl[i] = rnd();
    return function (x) {
      const xi = Math.floor(x);
      const f = x - xi;
      const a = tbl[((xi % P) + P) % P];
      const b = tbl[(((xi + 1) % P) + P) % P];
      return a + (b - a) * smoothstep(f);
    };
  }

  // 山脊型多重分形（用于山脉轮廓）
  function makeRidged(seed, period) {
    const n = makeNoise1D(seed, period);
    return function (x) {
      let v = 0, amp = 0.5, freq = 1, norm = 0;
      for (let o = 0; o < 5; o++) {
        let s = n(x * freq);
        s = 1 - Math.abs(s * 2 - 1);
        v += s * s * amp;
        norm += amp;
        amp *= 0.5; freq *= 2;
      }
      return v / norm;
    };
  }

  // 2D 值噪声（雾气、水面波纹、颗粒）
  function makeNoise2D(seed) {
    const P = 64;
    const rnd = mulberry32(seed);
    const tbl = new Float32Array(P * P);
    for (let i = 0; i < P * P; i++) tbl[i] = rnd();
    return function (x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = smoothstep(x - xi), fy = smoothstep(y - yi);
      const i0 = ((xi % P) + P) % P, j0 = ((yi % P) + P) % P;
      const i1 = (i0 + 1) % P, j1 = (j0 + 1) % P;
      const a = tbl[j0 * P + i0], b = tbl[j0 * P + i1];
      const c = tbl[j1 * P + i0], d = tbl[j1 * P + i1];
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
  }

  // ---- 颜色 ----
  function hex2rgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2hex(c) {
    return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  function mixRgb(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }
  function rgb(c) { return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'; }
  function shade(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
  function tint(c, t2, k) { return mixRgb(c, t2, k); }

  // ---- 调色板 ----
  const PALETTES = {
    spring: {
      name: '春',
      skyTop: '#8fb6d4', skyMid: '#c6dbe6', skyLow: '#eef0e5',
      sun: '#fff6dd', sunGlow: '#ffeec2',
      haze: '#dfe7e4',
      ridgeFar: '#a8bcc4', ridgeMid: '#8fa9a2', ridgeNear: '#6d8c74',
      water: '#a9c6cc', waterDeep: '#7ea3ab',
      foliage: '#9dc487', foliage2: '#7ba469', blossom: '#f6ccd8',
      ground: '#8fae74', snow: '#f4f8fb',
      particle: '#f7cbd8', particle2: '#ffe6ec',
      structure: '#8a6b52', roof: '#5d5348', warm: 0.15
    },
    summer: {
      name: '夏',
      skyTop: '#7fb2d6', skyMid: '#b7d8e6', skyLow: '#e7ece0',
      sun: '#fffbe8', sunGlow: '#fff6cf',
      haze: '#d6e2df',
      ridgeFar: '#9ab3b8', ridgeMid: '#75998a', ridgeNear: '#4e7558',
      water: '#8fbec2', waterDeep: '#5d9299',
      foliage: '#4f8355', foliage2: '#3b6845', blossom: '#7fa86a',
      ground: '#6f9463', snow: '#f4f8fb',
      particle: '#eaf3d2', particle2: '#ffffff',
      structure: '#8a6b52', roof: '#4f4a42', warm: 0.3
    },
    autumn: {
      name: '秋',
      skyTop: '#9fb2c4', skyMid: '#e3cdad', skyLow: '#f6e6c8',
      sun: '#ffe0a8', sunGlow: '#ffcf8e',
      haze: '#ecdfc6',
      ridgeFar: '#c3b49c', ridgeMid: '#b78b5c', ridgeNear: '#9a6636',
      water: '#c2ad8e', waterDeep: '#94826a',
      foliage: '#c98d3d', foliage2: '#a9532e', blossom: '#d8863c',
      ground: '#a8834c', snow: '#f4f8fb',
      particle: '#d9822f', particle2: '#c14a25',
      structure: '#8a6b52', roof: '#5a4a3c', warm: 0.55
    },
    winter: {
      name: '冬',
      skyTop: '#8ea3ba', skyMid: '#c2cfdb', skyLow: '#e9edf2',
      sun: '#eef3fb', sunGlow: '#dfe8f4',
      haze: '#dee5ec',
      ridgeFar: '#c3cdd8', ridgeMid: '#a8b6c5', ridgeNear: '#8496a8',
      water: '#bcccd8', waterDeep: '#93a8b8',
      foliage: '#8d97a0', foliage2: '#6e7986', blossom: '#dbe6ef',
      ground: '#e2eaf1', snow: '#fbfdff',
      particle: '#ffffff', particle2: '#eaf2fa',
      structure: '#7d6a5c', roof: '#514c48', warm: 0.05
    }
  };

  // ---- 画风 ----
  const STYLES = {
    real: {
      name: '治愈写实',
      filter: 'saturate(0.92) contrast(1.02)',
      bloom: 0.16, grain: 0.05, paper: 0, vignette: 0.3,
      cloudDensity: 0.55, cloudSoft: 1, flare: 0.15, detail: 1
    },
    shinkai: {
      name: '新海诚',
      filter: 'saturate(1.28) contrast(1.08)',
      bloom: 0.55, grain: 0.02, paper: 0, vignette: 0.34,
      cloudDensity: 0.95, cloudSoft: 0.6, flare: 0.85, detail: 1
    },
    ghibli: {
      name: '宫崎骏',
      filter: 'saturate(1.05) contrast(0.96) brightness(1.04)',
      bloom: 0.28, grain: 0.035, paper: 0.06, vignette: 0.18,
      cloudDensity: 0.8, cloudSoft: 1.5, flare: 0.1, detail: 0.9
    },
    ink: {
      name: '水墨国风',
      filter: 'saturate(0.22) contrast(1.16)',
      bloom: 0.05, grain: 0.1, paper: 0.4, vignette: 0.26,
      cloudDensity: 0.5, cloudSoft: 2.1, flare: 0, detail: 0.8
    },
    minimal: {
      name: '极简写实',
      filter: 'saturate(0.66) contrast(1.12)',
      bloom: 0.1, grain: 0.02, paper: 0, vignette: 0.22,
      cloudDensity: 0.35, cloudSoft: 1.2, flare: 0, detail: 0.55
    }
  };

  const SCENES = {
    valley: { name: '山谷湖畔', seed: 20241107 },
    path: { name: '林间小路', seed: 77341 },
    court: { name: '中式庭院', seed: 51209 },
    sea: { name: '海边', seed: 90211 },
    forest: { name: '森林', seed: 33017 }
  };

  global.WS = global.WS || {};
  global.WS.util = {
    mulberry32, hash1, smoothstep, makeNoise1D, makeNoise2D, makeRidged,
    hex2rgb, rgb2hex, mixRgb, rgba, rgb, shade, tint,
    PALETTES, STYLES, SCENES
  };
})(window);
