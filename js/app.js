/* ===== 应用控制层：UI 绑定、循环播放、录制、导出 ===== */
(function (global) {
  'use strict';

  const U = global.WS.util;
  const A = global.WS.Assets;
  const canvas = document.getElementById('cv');
  const frame = document.getElementById('frame');
  const stageBadge = document.getElementById('stageBadge');
  const statEl = document.getElementById('stat');
  const guides = document.getElementById('guides');

  const loader = A.createAssetLoader('assets/scenes/');
  const petLoader = A.createPetLoader('assets/pet/');
  const renderer = global.WS.Scene.createRenderer(canvas, loader, petLoader);
  const R = renderer.state;

  const DEFAULTS = {
    scene: 'forest-rain-l', season: 'spring', style: 'real',
    sunAngle: 118, fog: 26, wind: 34, fall: 42,
    loopLen: 12, breathe: 30, aspect: '16:9', autoSeason: false
  };
  let autoSeason = false;

  /* ---------- 画面比例 ---------- */
  const ASPECT = { '16:9': 16 / 9, '9:16': 9 / 16, '21:9': 21 / 9, '1:1': 1, '4:3': 4 / 3 };
  let aspect = '16:9';

  /* ---------- 尺寸自适应 ---------- */
  function fit() {
    const stage = document.getElementById('stage');
    const pad = 28;
    const availW = stage.clientWidth - pad * 2;
    const availH = stage.clientHeight - pad * 2;
    const ar = ASPECT[aspect];
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    frame.style.width = Math.floor(w) + 'px';
    frame.style.height = Math.floor(h) + 'px';
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    renderer.resize(w, h, dpr);
  }
  global.addEventListener('resize', fit);

  /* ---------- 主循环 ---------- */
  let t0 = performance.now();
  let phase = 0;
  let fps = 0, lastFpsT = performance.now(), frames = 0;
  let autoTimer = 0;
  let frozen = false;
  const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

  function tick(now) {
    const loopMs = R.loopLen * 1000;
    phase = ((now - t0) % loopMs) / loopMs;

    if (autoSeason) {
      autoTimer += (now - (tick._last || now)) / 1000;
      tick._last = now;
      if (autoTimer > 14) {
        autoTimer = 0;
        const i = SEASONS.indexOf(R.season);
        setSeason(SEASONS[(i + 1) % 4], true);
      }
    } else tick._last = now;

    if (!frozen) {
      renderer.render(phase);
      frames++;
      if (now - lastFpsT > 500) {
        fps = Math.round(frames * 1000 / (now - lastFpsT));
        frames = 0; lastFpsT = now;
        updateStat();
      }
    }
    requestAnimationFrame(tick);
  }

  function updateStat() {
    statEl.textContent = `${canvas.width}×${canvas.height} · ${fps} FPS · 循环 ${R.loopLen}s · 阶段 ${(phase * 100).toFixed(0)}%`;
  }

  /* ---------- 控件构建 ---------- */
  function buildChips(container, map, onPick) {
    container.innerHTML = '';
    Object.keys(map).forEach(k => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = map[k];
      b.dataset.k = k;
      b.addEventListener('click', () => onPick(k));
      container.appendChild(b);
    });
  }
  function markChips(container, active) {
    Array.from(container.children).forEach(b => b.classList.toggle('on', b.dataset.k === active));
  }

  const sceneChips = document.getElementById('sceneChips');
  const styleChips = document.getElementById('styleChips');
  const seasonChips = document.getElementById('seasonChips');
  const petChips = document.getElementById('petChips');

  const sceneMap = {}, styleMap = {}, seasonMap = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
  const petMap = {};
  Object.keys(A.SCENE_META).forEach(k => sceneMap[k] = A.SCENE_META[k].name);
  Object.keys(A.STYLE_META).forEach(k => styleMap[k] = A.STYLE_META[k].name);
  Object.keys(A.PET_KINDS).forEach(k => petMap[k] = A.PET_KINDS[k].name);

  buildChips(sceneChips, sceneMap, k => { setScene(k); updateBadge(); });
  buildChips(styleChips, styleMap, k => { renderer.setStyle(k); R.style = k; markChips(styleChips, k); updateBadge(); });
  buildChips(seasonChips, seasonMap, k => setSeason(k, true));
  buildChips(petChips, petMap, k => {
    renderer.setPetKind(k);
    markChips(petChips, k);
    document.getElementById('petHint').textContent = '已换成「' + petMap[k] + '」· 左键抚摸 · 右键投喂';
  });

  function setScene(k) {
    renderer.setScene(k); R.scene = k;
    markChips(sceneChips, k);
    updateBadge();
  }
  function setSeason(k, syncUI) {
    renderer.setSeason(k); R.season = k;
    if (syncUI) markChips(seasonChips, k);
    updateBadge();
  }
  const DIMS = {
    '16:9': '1920×1080', '9:16': '1080×1920', '21:9': '2560×1080',
    '1:1': '1440×1440', '4:3': '1440×1080'
  };
  function updateBadge() {
    stageBadge.textContent = `${A.SCENE_META[R.scene].name} · ${U.PALETTES[R.season].name} · ${A.STYLE_META[R.style].name} · ${DIMS[aspect]}`;
  }

  /* ---------- 滑块 ---------- */
  function bindSlider(id, key, fmt, onChange) {
    const el = document.getElementById(id);
    const out = document.getElementById(id + 'Val');
    const apply = () => {
      const v = parseFloat(el.value);
      renderer.setParam(key, v);
      if (out) out.textContent = fmt ? fmt(v) : v;
      if (onChange) onChange(v);
    };
    el.addEventListener('input', apply);
    apply();
  }
  bindSlider('sunAngle', 'sunAngle', v => v + '°');
  bindSlider('fog', 'fog', v => v);
  bindSlider('wind', 'wind', v => v);
  bindSlider('fall', 'fall', v => v);
  bindSlider('breathe', 'breathe', v => v);
  bindSlider('loopLen', 'loopLen', v => v + 's', () => { t0 = performance.now(); });

  document.getElementById('aspect').addEventListener('change', e => {
    aspect = e.target.value;
    renderer.setParam('portrait', aspect === '9:16');
    // 比例变化时自动切换到对应的母版（竖版 / 横版）
    applyAspectScene();
    fit(); updateBadge();
  });

  /* 比例 → 母版场景映射 */
  function applyAspectScene() {
    const cur = R.scene;
    if (cur === 'forest-rain' || cur === 'forest-rain-l') {
      const want = aspect === '9:16' ? 'forest-rain' : 'forest-rain-l';
      if (want !== cur) { setScene(want); return; }
    }
    markChips(sceneChips, R.scene);
  }
  document.getElementById('autoSeason').addEventListener('change', e => {
    autoSeason = e.target.checked; autoTimer = 0;
  });
  document.getElementById('showGuides').addEventListener('change', e => {
    guides.classList.toggle('hidden', !e.target.checked);
  });

  /* ---------- 宠物交互 ---------- */
  /* 鼠标坐标 → 画面相对坐标 */
  function canvasPos(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / r.width,
      y: (ev.clientY - r.top) / r.height
    };
  }

  canvas.addEventListener('mousemove', ev => {
    const p = canvasPos(ev);
    renderer.petMove(p.x, p.y);
  });
  canvas.addEventListener('mouseleave', () => {
    renderer.petMove(-1, -1);
    renderer.petSetCursor(-1, -1, false);
  });
  canvas.addEventListener('mousedown', ev => {
    const p = canvasPos(ev);
    renderer.petDown(p.x, p.y);
  });
  window.addEventListener('mouseup', () => renderer.petUp());
  canvas.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    const p = canvasPos(ev);
    renderer.petFeed(p.x, p.y);      // 右键 = 丢猫粮
  });

  /* 喂食按钮 */
  document.getElementById('btnFeed').addEventListener('click', () => {
    const zone = renderer.pet.state;
    const x = zone.x + (Math.random() - 0.5) * 0.16;
    renderer.petFeed(Math.max(0.08, Math.min(0.92, x)), 0.93);
  });

  /* 宠物开关 */
  document.getElementById('petOn').addEventListener('change', e => {
    renderer.setPetEnabled(e.target.checked);
    document.getElementById('petHint').textContent = e.target.checked
      ? '左键抚摸 · 右键投喂 · 靠近它会看向光标'
      : '宠物已隐藏';
  });

  /* 呼唤它：看向光标并靠近 */
  document.getElementById('btnPetCall').addEventListener('click', () => {
    const st = renderer.pet.state;
    st.affection = Math.min(1, st.affection + 0.1);
    renderer.pet.say('喵？', 2.0);
    renderer.pet.setState('alert');
  });

  /* ---------- 折叠面板 ---------- */
  const panel = document.getElementById('panel');
  document.getElementById('btnCollapse').addEventListener('click', togglePanel);
  function togglePanel() {
    panel.classList.toggle('collapsed');
    document.getElementById('btnCollapse').textContent = panel.classList.contains('collapsed') ? '⟩' : '⟨';
    setTimeout(fit, 260);
  }

  /* ---------- 全屏 / 壁纸模式 ---------- */
  document.getElementById('btnFull').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  document.getElementById('btnWall').addEventListener('click', () => {
    document.body.classList.toggle('wallmode');
    panel.classList.toggle('hidden-wall', document.body.classList.contains('wallmode'));
    guides.classList.add('hidden');
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    setTimeout(fit, 260);
  });

  /* ---------- PNG 导出 ---------- */
  document.getElementById('btnPng').addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = `wallpaper-${R.scene}-${R.season}-${R.style}-${Math.round(phase * 100)}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  });

  /* ---------- 参数复制 ---------- */
  document.getElementById('btnCopy').addEventListener('click', async () => {
    const cfg = JSON.stringify({
      scene: R.scene, season: R.season, style: R.style,
      sunAngle: R.sunAngle, fog: R.fog, wind: R.wind, fall: R.fall,
      loopLen: R.loopLen, breathe: R.breathe, aspect
    });
    try {
      await navigator.clipboard.writeText(cfg);
      document.getElementById('recHint').textContent = '参数已复制到剪贴板。';
    } catch (e) {
      document.getElementById('recHint').textContent = cfg;
    }
  });

  /* ---------- 重置 ---------- */
  document.getElementById('btnReset').addEventListener('click', () => {
    renderer.setScene(DEFAULTS.scene);
    renderer.setSeason(DEFAULTS.season);
    renderer.setStyle(DEFAULTS.style);
    R.scene = DEFAULTS.scene; R.season = DEFAULTS.season; R.style = DEFAULTS.style;
    markChips(sceneChips, 'forest-rain-l'); markChips(seasonChips, 'spring'); markChips(styleChips, 'real');
    aspect = DEFAULTS.aspect;
    document.getElementById('aspect').value = aspect;
    autoSeason = false;
    document.getElementById('autoSeason').checked = false;
    ['sunAngle', 'fog', 'wind', 'fall', 'breathe', 'loopLen'].forEach(id => {
      const el = document.getElementById(id);
      el.value = DEFAULTS[id];
      el.dispatchEvent(new Event('input'));
    });
    fit(); updateBadge();
  });

  /* ---------- 录制循环视频 ---------- */
  const recOverlay = document.getElementById('recOverlay');
  const recTime = document.getElementById('recTime');
  let recorder = null, recChunks = [], recStart = 0, recTimer = null;

  function startRec() {
    if (!canvas.captureStream) { alert('当前浏览器不支持录制，请使用 Chrome / Edge。'); return; }
    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 20_000_000 });
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: 'video/webm' });
      const a = document.createElement('a');
      a.download = `wallpaper-${R.scene}-${R.season}-${R.style}-${aspect.replace(':', 'x')}.webm`;
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      recOverlay.classList.add('hidden');
      document.getElementById('btnRecord').textContent = '录制循环视频';
    };
    recorder.start();
    recStart = performance.now();
    recOverlay.classList.remove('hidden');
    document.getElementById('btnRecord').textContent = '停止并保存';
    recTimer = setInterval(() => {
      const el = (performance.now() - recStart) / 1000;
      recTime.textContent = el.toFixed(1) + 's';
      if (el >= R.loopLen * 3) stopRec();
    }, 100);
  }
  function stopRec() {
    clearInterval(recTimer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }
  document.getElementById('btnRecord').addEventListener('click', () => {
    if (recorder && recorder.state !== 'inactive') stopRec(); else startRec();
  });
  document.getElementById('btnRecStop').addEventListener('click', stopRec);

  /* ---------- 键盘快捷键 ---------- */
  global.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === 'h') togglePanel();
    else if (k === 'f') document.getElementById('btnFull').click();
    else if (k === 'w') document.getElementById('btnWall').click();
    else if (k === 'g') {
      const cb = document.getElementById('showGuides');
      cb.checked = !cb.checked; cb.dispatchEvent(new Event('change'));
    } else if (k >= '1' && k <= '4') setSeason(SEASONS[parseInt(k, 10) - 1], true);
    else if (k === ' ') e.preventDefault();
  });

  /* ---------- 初始化 ---------- */
  markChips(sceneChips, R.scene);
  markChips(styleChips, R.style);
  markChips(seasonChips, R.season);
  markChips(petChips, renderer.petKind());
  fit();
  updateBadge();
  requestAnimationFrame(tick);

  /* ---------- 自动化 API ---------- */
  global.WSApp = {
    renderer, canvas, loader,
    setScene(k) { setScene(k); },
    setSeason(k) { setSeason(k, true); },
    setStyle(k) { renderer.setStyle(k); R.style = k; markChips(styleChips, k); },
    setPetKind(k) { renderer.setPetKind(k); markChips(petChips, k); },
    setParam(k, v) { renderer.setParam(k, v); },
    renderPhase(p) { renderer.render(p); },
    setFrozen(v) { frozen = !!v; },
    waitReady() { return new Promise(res => renderer.onReady(res)); },
    getState() { return Object.assign({}, R, { aspect, petKind: renderer.petKind() }); },
    setAspect(a) {
      aspect = a;
      document.getElementById('aspect').value = a;
      renderer.setParam('portrait', a === '9:16');
      fit();
    },
    resize(w, h) { renderer.resize(w, h, 1); }
  };
})(window);
