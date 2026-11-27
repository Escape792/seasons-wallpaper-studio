/* ===== 场景素材库 =====
   每个场景 × 季节对应一张写实母版图（AI 生成，构图/建筑/山体轮廓四季完全一致）。
   母版图只提供静态基底；所有动态效果（雾气、光照、飘落、微呼吸运镜）由 scene.js 的
   动态图层实时叠加实现，因此：
     · 切换季节 → 只换母版图，构图分毫不动；
     · 切换画风 → 只换调色 LUT 与后期强度，几何不动；
     · 所有动效都是 phase∈[0,1) 的周期函数 → 首尾帧严格一致，无缝循环。
*/
(function (global) {
  'use strict';

  const U = global.WS.util;

  /* 季节 → 各场景母版图 */
  const SEASON_FILES = {
    spring: 'spring.png', summer: 'summer.png',
    autumn: 'autumn.png', winter: 'winter.png'
  };

  /* 场景元数据：
     horizon  水面/地面分界在画面中的相对高度（0=顶 1=底）
     water    是否有水面（用于波光/倒影扰动）
     mist     雾气带的基础位置（相对高度数组）
     foliage  前景草木带位置（相对高度），用于草木摇曳
     sky      天空安全区上界（该比例以上保持干净，适合放桌面图标）
     iconMid  中部图标安全区下界
  */
  const SCENE_META = {
    'forest-rain-l': {
      name: '雨后林径 · 横版', horizon: 0.66, water: true,
      mist: [0.46, 0.62], foliage: [0.78, 1.0], grassBand: [0.88, 1.0],
      sky: 0.22, iconMid: 0.14,
      tint: { spring: '#cfe0d8', summer: '#c8ded0', autumn: '#e2cba6', winter: '#cfd9e2' }
    },
    'forest-rain': {
      name: '雨后林径 · 竖版', horizon: 0.72, water: true,
      mist: [0.52, 0.68], foliage: [0.82, 1.0], grassBand: [0.92, 1.0],
      sky: 0.26, iconMid: 0.18,
      tint: { spring: '#cfe0d8', summer: '#c8ded0', autumn: '#e2cba6', winter: '#cfd9e2' }
    }
  };

  /* 可选宠物：每种宠物有 idle / walk / happy 三姿态 */
  const PET_KINDS = {
    blue: { name: '蓝猫宝', sprites: { idle: 'blue-idle', walk: 'blue-walk', happy: 'blue-happy' }, scale: 0.20 },
    fluffy: { name: '毛茸茸', sprites: { idle: 'fluffy-idle', walk: 'fluffy-walk', happy: 'fluffy-happy' }, scale: 0.24 }
  };

  /* 画风：LUT 色调 + 后期强度 + 粒子/光效风格 */
  const STYLE_META = {
    real: {
      name: '治愈写实', tintA: 0.10, sat: 0.90, contrast: 1.02, warm: 0.10,
      bloom: 0.18, grain: 0.045, vignette: 0.30, paper: 0, sharpen: 0,
      particleStyle: 'natural', flare: 0.18, lift: 0.02
    },
    shinkai: {
      name: '新海诚', tintA: 0.20, sat: 1.32, contrast: 1.10, warm: 0.06,
      bloom: 0.52, grain: 0.015, vignette: 0.34, paper: 0, sharpen: 0.25,
      particleStyle: 'sparkle', flare: 0.90, lift: 0.05
    },
    ghibli: {
      name: '宫崎骏', tintA: 0.16, sat: 1.08, contrast: 0.95, warm: 0.16,
      bloom: 0.30, grain: 0.030, vignette: 0.16, paper: 0.05, sharpen: 0.10,
      particleStyle: 'soft', flare: 0.12, lift: 0.06
    },
    ink: {
      name: '水墨国风', tintA: 0.30, sat: 0.20, contrast: 1.18, warm: -0.04,
      bloom: 0.04, grain: 0.085, vignette: 0.24, paper: 0.42, sharpen: 0.35,
      particleStyle: 'ink', flare: 0, lift: 0.10
    },
    minimal: {
      name: '极简写实', tintA: 0.26, sat: 0.62, contrast: 1.14, warm: 0.02,
      bloom: 0.10, grain: 0.015, vignette: 0.20, paper: 0, sharpen: 0.20,
      particleStyle: 'sparse', flare: 0, lift: 0.04
    }
  };

  /* ---------------- 素材加载器 ---------------- */
  /* 竖版素材目录（横版场景在竖屏时用独立母版） */
  const PORTRAIT_SCENES = {};

  function createAssetLoader(basePath) {
    const cache = new Map();
    const base = basePath || 'assets/scenes/';

    function folderFor(scene, portrait) {
      if (portrait && PORTRAIT_SCENES[scene]) return PORTRAIT_SCENES[scene] + '/';
      return scene + '/';
    }

    function load(scene, season, portrait) {
      const folder = folderFor(scene, portrait);
      const key = folder + season;
      if (cache.has(key)) return cache.get(key);
      const file = (SEASON_FILES[season] || SEASON_FILES.spring);
      const img = new Image();
      img.decoding = 'async';
      const p = new Promise((res, rej) => {
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('素材加载失败: ' + base + folder + file));
      });
      img.src = base + folder + file;
      cache.set(key, p);
      return p;
    }

    function preload(scene, seasons, portrait) {
      return Promise.all((seasons || ['spring', 'summer', 'autumn', 'winter']).map(s => load(scene, s, portrait)));
    }

    return { load, preload, cached: cache, hasPortrait: s => !!PORTRAIT_SCENES[s] };
  }

  global.WS.Assets = {
    SCENE_META, STYLE_META, SEASON_FILES, PORTRAIT_SCENES, PET_KINDS,
    createAssetLoader,
    /* 宠物精灵图加载器（按 kind 缓存） */
    createPetLoader(basePath) {
      const cache = new Map();
      const base = basePath || 'assets/pet/';
      function load(name) {
        if (cache.has(name)) return cache.get(name);
        const img = new Image();
        const p = new Promise((res, rej) => {
          img.onload = () => res(img);
          img.onerror = () => rej(new Error('宠物素材加载失败: ' + base + name + '.png'));
        });
        img.src = base + name + '.png';
        cache.set(name, p);
        return p;
      }
      return { load };
    }
  };
})(window);
