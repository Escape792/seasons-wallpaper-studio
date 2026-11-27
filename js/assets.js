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
    valley: {
      name: '山谷湖畔', horizon: 0.78, water: true,
      mist: [0.62, 0.72], foliage: [0.86, 1.0], sky: 0.42, iconMid: 0.30,
      tint: { spring: '#cfe0e8', summer: '#c9dcd2', autumn: '#e0cba8', winter: '#d2dde8' }
    },
    path: {
      name: '林间小路', horizon: 0.0, water: false,
      mist: [0.45, 0.68], foliage: [0.70, 1.0], sky: 0.16, iconMid: 0.12,
      tint: { spring: '#d8e6d4', summer: '#cfe0c8', autumn: '#e4d3ae', winter: '#d6dfe8' }
    },
    court: {
      name: '中式庭院', horizon: 0.72, water: true,
      mist: [0.55, 0.70], foliage: [0.72, 1.0], sky: 0.34, iconMid: 0.26,
      tint: { spring: '#dde4dc', summer: '#d6e2d4', autumn: '#e6d6bc', winter: '#dbe2ea' }
    },
    sea: {
      name: '海边', horizon: 0.62, water: true,
      mist: [0.52, 0.66], foliage: [0.72, 0.86], sky: 0.44, iconMid: 0.32,
      tint: { spring: '#d6e2e6', summer: '#d8e2d8', autumn: '#ecd8b4', winter: '#d8e2ea' }
    },
    forest: {
      name: '森林', horizon: 0.0, water: false,
      mist: [0.30, 0.58], foliage: [0.72, 1.0], sky: 0.14, iconMid: 0.10,
      tint: { spring: '#d6e4d4', summer: '#cddfca', autumn: '#e2d2ae', winter: '#d4dee8' }
    }
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
  /* 竖版（9:16）使用独立母版图（<scene>-portrait 目录），构图与横版一致但取景更适合手机 */
  const PORTRAIT_SCENES = { valley: true };

  function createAssetLoader(basePath) {
    const cache = new Map();
    const base = basePath || 'assets/scenes/';

    function folderFor(scene, portrait) {
      if (portrait && PORTRAIT_SCENES[scene]) return scene + '-portrait/';
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
    SCENE_META, STYLE_META, SEASON_FILES, PORTRAIT_SCENES,
    createAssetLoader
  };
})(window);
