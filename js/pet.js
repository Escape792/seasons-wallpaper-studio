/* ===== 壁纸宠物：状态机 + 自主行为 + 交互响应 =====
   宠物在壁纸画面内活动，不是独立桌面窗口。

   状态：
     idle     待机坐着，偶尔眨眼、甩尾
     walk     四足行走，地面上有投影
     sit      坐下休息
     sleep    蜷成一团睡觉，冒 Z
     groom    舔毛自洁
     alert    察觉到光标，抬头注视
     happy    被抚摸，眯眼享受，冒爱心
     eat      进食，低头咀嚼
     beg      饿了在脚边叫，等你喂
     follow   跟随光标走

   所有运动均由内部时钟驱动；渲染时传入的 phase 只用于环境动效，
   宠物自身的动画使用独立的时间轴，因此不影响壁纸的无缝循环数学。
*/
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const U = global.WS.util;

  const STATES = ['idle', 'walk', 'sit', 'sleep', 'groom', 'alert', 'happy', 'eat', 'beg', 'follow'];

  /* 状态权重（自主决策用） */
  const IDLE_WEIGHTS = {
    idle: 30, walk: 26, sit: 16, sleep: 10, groom: 12, beg: 6
  };

  function createPet(opts) {
    const o = Object.assign({
      x: 0.62,          // 初始位置（画面相对坐标）
      y: 0.86,          // 脚底所在高度（画面相对坐标）
      scale: 0.16,      // 相对画面高度
      facing: -1,       // -1 面朝左，1 面朝右
      speed: 0.012,     // 行走速度（相对宽度/秒）
      hunger: 0.25,     // 饥饿度 0..1
      energy: 1.0,      // 精力 0..1
      affection: 0.3,   // 亲密度 0..1
      enabled: true
    }, opts || {});

    /* ---------- 内部状态 ---------- */
    const P = {
      state: 'idle',
      prev: 'idle',
      stateT: 0,          // 当前状态已持续时间（秒）
      x: o.x,
      y: o.y,
      vx: 0,
      facing: o.facing,
      hunger: o.hunger,
      energy: o.energy,
      affection: o.affection,
      blinkT: 1.5 + Math.random() * 3,
      blinking: 0,
      tailT: Math.random() * 10,
      breathT: Math.random() * 10,
      stepPhase: 0,
      targetX: o.x,
      sitBlend: 0,        // 0=站 1=坐
      groomBlend: 0,
      sleepBlend: 0,
      happyBlend: 0,
      eatBlend: 0,
      headTurn: 0,        // -1..1 头部转向光标
      lookY: 0,           // 眼睛上下
      heartT: 0,
      zzz: [],
      // 交互输入
      cursor: { x: 0.5, y: 0.5, active: false, down: false, moved: false },
      petting: 0,         // 被抚摸强度 0..1
      food: null,         // {x,y,landed,bites}
      lastInteract: -99,
      // 事件回调
      onEvent: null,
      bubble: null,       // {text, t}
      sound: null
    };

    /* ---------- 工具 ---------- */
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function pickWeighted(weights) {
      let total = 0;
      for (const k in weights) total += weights[k];
      let r = Math.random() * total;
      for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
      return 'idle';
    }
    function setState(s) {
      if (P.state === s) return;
      P.prev = P.state;
      P.state = s;
      P.stateT = 0;
      if (P.onEvent) P.onEvent('state', s);
    }
    function say(text, dur) {
      P.bubble = { text, t: dur || 2.4 };
      if (P.onEvent) P.onEvent('say', text);
    }

    /* ---------- 主更新 ---------- */
    function update(dt, groundY, bounds) {
      dt = Math.min(dt, 0.05);
      P.stateT += dt;
      P.blinkT -= dt;
      P.tailT += dt;
      P.breathT += dt;
      P.heartT -= dt;

      if (P.blinkT <= 0) { P.blinking = 0.16; P.blinkT = rnd(2.2, 6.0); }
      if (P.blinking > 0) P.blinking -= dt;

      const cur = P.cursor;

      // ---- 进食 ----
      if (P.state === 'eat' && P.food) {
        P.eatBlend = Math.min(1, P.eatBlend + dt * 5);
        const dx = P.food.x - P.x;
        if (Math.abs(dx) > 0.02) {
          // 走向食物
          P.x += Math.sign(dx) * o.speed * 1.4 * dt;
          P.facing = Math.sign(dx) || P.facing;
        } else {
          P.food.bites += dt;
          if (Math.random() < dt * 2.2) {
            P.hunger = Math.max(0, P.hunger - dt * 0.34);
            P.affection = Math.min(1, P.affection + dt * 0.12);
            if (P.onEvent) P.onEvent('eat');
          }
          if (P.food.bites > 3.6 || P.hunger <= 0.02) {
            P.food = null;
            P.eatBlend = 0;
            setState('happy');
            say('吃饱啦～', 2.2);
            if (P.onEvent) P.onEvent('fed');
          }
        }
        P.sitBlend = 0;
        P.sleepBlend = 0;
        P.groomBlend = 0;
        P.happyBlend = Math.max(0, P.happyBlend - dt * 2);
        return;
      }
      P.eatBlend = Math.max(0, P.eatBlend - dt * 3);

      // ---- 被抚摸 ----
      if (P.petting > 0.02) {
        P.petting = Math.max(0, P.petting - dt * 0.9);
        P.happyBlend = Math.min(1, P.happyBlend + dt * 4);
        P.affection = Math.min(1, P.affection + dt * 0.10);
        if (Math.random() < dt * 2.4) {
          P.zzz.push({ x: P.x + rnd(-0.02, 0.05), y: P.y - 0.10, t: 0, life: rnd(1.2, 1.8), kind: 'heart' });
        }
        if (P.onEvent) P.onEvent('pet');
      } else {
        P.happyBlend = Math.max(0, P.happyBlend - dt * 1.6);
      }

      // ---- 有食物但还没吃 ----
      if (P.food && P.state !== 'eat') {
        setState('eat');
      }

      // ---- 光标交互：注视 / 跟随 ----
      const nearX = Math.abs(cur.x - P.x);
      const nearY = Math.abs(cur.y - P.y);
      const dist2 = Math.hypot(cur.x - P.x, (cur.y - P.y) * 0.6);
      const isNear = cur.active && dist2 < 0.16;

      // 头部转向光标
      const wantTurn = isNear ? Math.max(-1, Math.min(1, (cur.x - P.x) * 8)) : 0;
      P.headTurn += (wantTurn - P.headTurn) * Math.min(1, dt * 6);
      P.lookY = isNear ? -0.3 : 0;

      // ---- 状态机 ----
      switch (P.state) {
        case 'idle': {
          P.sitBlend += (1 - P.sitBlend) * Math.min(1, dt * 4);
          if (P.stateT > rnd(2.2, 5.5)) setState(pickWeighted(IDLE_WEIGHTS));
          break;
        }
        case 'walk': {
          P.sitBlend += (0 - P.sitBlend) * Math.min(1, dt * 5);
          P.x += P.vx * dt;
          P.stepPhase += dt * 7;
          if (P.x < bounds.x0 + 0.04) { P.x = bounds.x0 + 0.04; P.vx = Math.abs(P.vx); }
          if (P.x > bounds.x1 - 0.04) { P.x = bounds.x1 - 0.04; P.vx = -Math.abs(P.vx); }
          if (P.stateT > rnd(2.5, 6.5)) setState(pickWeighted(IDLE_WEIGHTS));
          break;
        }
        case 'sit': {
          P.sitBlend += (1 - P.sitBlend) * Math.min(1, dt * 3.5);
          if (P.stateT > rnd(3, 8)) setState(pickWeighted(IDLE_WEIGHTS));
          break;
        }
        case 'sleep': {
          P.sleepBlend += (1 - P.sleepBlend) * Math.min(1, dt * 2.2);
          P.sitBlend += (1 - P.sitBlend) * Math.min(1, dt * 3);
          P.energy = Math.min(1, P.energy + dt * 0.06);
          if (Math.random() < dt * 0.9) {
            P.zzz.push({ x: P.x + rnd(0.0, 0.03), y: P.y - 0.11, t: 0, life: 2.2, kind: 'z' });
          }
          if (P.stateT > rnd(6, 14)) { setState('idle'); P.energy = Math.min(1, P.energy + 0.2); }
          break;
        }
        case 'groom': {
          P.groomBlend += (1 - P.groomBlend) * Math.min(1, dt * 4);
          if (P.stateT > rnd(2.5, 5)) { setState('idle'); }
          break;
        }
        case 'alert': {
          if (!isNear) { setState('idle'); break; }
          if (P.stateT > 0.35 && Math.random() < dt * 0.5) {
            P.zzz.push({ x: P.x + rnd(-0.02, 0.04), y: P.y - 0.10, t: 0, life: 1.4, kind: 'note' });
          }
          if (P.stateT > rnd(1.5, 3.5)) setState('idle');
          break;
        }
        case 'happy': {
          if (P.stateT > 1.6) setState('idle');
          break;
        }
        case 'beg': {
          P.sitBlend += (1 - P.sitBlend) * Math.min(1, dt * 4);
          if (Math.random() < dt * 1.1) {
            P.zzz.push({ x: P.x + rnd(-0.03, 0.03), y: P.y - 0.12, t: 0, life: 1.3, kind: 'note' });
          }
          if (P.hunger < 0.25) { setState('idle'); break; }
          if (P.stateT > rnd(3, 7)) setState('idle');
          break;
        }
        case 'follow': {
          P.sitBlend += (0 - P.sitBlend) * Math.min(1, dt * 5);
          const dx = cur.x - P.x;
          if (Math.abs(dx) > 0.03) {
            const dir = Math.sign(dx);
            P.x += dir * o.speed * 1.15 * dt;
            P.facing = dir;
            P.stepPhase += dt * 7;
          }
          if (!cur.active || !isNear) setState('idle');
          break;
        }
      }

      // ---- 自主移动 ----
      if (P.state === 'walk') {
        if (Math.abs(P.vx) < 1e-4) {
          P.vx = (Math.random() < 0.5 ? -1 : 1) * o.speed * rnd(0.6, 1.4);
          P.facing = Math.sign(P.vx);
        }
      }
      if (P.state === 'idle' || P.state === 'sit' || P.state === 'sleep' || P.state === 'groom') {
        if (Math.random() < dt * 0.55) {
          P.vx = (Math.random() < 0.5 ? -1 : 1) * o.speed * rnd(0.5, 1.3);
          P.facing = Math.sign(P.vx);
        }
      }

      // ---- 饥饿驱动 ----
      P.hunger = Math.min(1, P.hunger + dt * 0.006);
      if (P.hunger > 0.72 && P.state !== 'eat' && P.state !== 'sleep' &&
        P.state !== 'beg' && Math.random() < dt * 0.4) {
        setState('beg');
        say('有点饿了…', 2.6);
      }
      if (P.hunger > 0.55 && Math.random() < dt * 0.12 && P.state !== 'beg') {
        setState('beg');
      }

      // ---- 光标接近 → 警觉 / 跟随 ----
      if (cur.active && isNear && P.state !== 'eat' && P.petting < 0.05 &&
        (P.state === 'idle' || P.state === 'sit')) {
        setState(Math.random() < 0.55 ? 'alert' : 'follow');
      }

      // ---- 气泡 ----
      if (P.bubble) {
        P.bubble.t -= dt;
        if (P.bubble.t <= 0) P.bubble = null;
      }

      // ---- 粒子 ----
      for (let i = P.zzz.length - 1; i >= 0; i--) {
        const z = P.zzz[i];
        z.t += dt;
        if (z.t > z.life) P.zzz.splice(i, 1);
      }
    }

    /* ---------- 交互接口 ---------- */
    function setCursor(x, y, active) {
      P.cursor.x = x; P.cursor.y = y;
      P.cursor.active = active !== false;
    }
    function onDown(x, y) {
      P.cursor.down = true;
      P.cursor.x = x; P.cursor.y = y;
      const hit = hitTest(x, y);
      if (hit) {
        P.petting = 1;
        setState('happy');
        P.affection = Math.min(1, P.affection + 0.06);
        say(rnd(0, 1) < 0.5 ? '呼噜呼噜～' : '好舒服', 2.0);
        if (P.onEvent) P.onEvent('touch');
      } else if (P.food && Math.hypot(x - P.food.x, (y - P.food.y) * 0.8) < 0.05) {
        // 点中食物 → 吃掉
        P.food = null;
        P.hunger = Math.max(0, P.hunger - 0.4);
        setState('happy');
        say('唔姆！', 1.8);
        if (P.onEvent) P.onEvent('eat');
      }
    }
    function onMove(x, y) {
      P.cursor.x = x; P.cursor.y = y;
      P.cursor.active = true;
      // 在猫身上移动 = 抚摸
      if (P.cursor.down && hitTest(x, y)) {
        P.petting = 1;
        if (P.state !== 'eat') setState('happy');
      }
    }
    function onUp() { P.cursor.down = false; }
    function hitTest(x, y) {
      const dx = (x - P.x) / 0.055;
      const dy = (y - (P.y - 0.045)) / 0.075;
      return (dx * dx + dy * dy) < 1;
    }

    /* ---------- 喂食 ---------- */
    function dropFood(x, y) {
      P.food = { x, y, bites: 0, landed: false, dropT: 0 };
      setState('eat');
      say('开饭啦！', 2.0);
      if (P.onEvent) P.onEvent('feed');
    }
    function hasFood() { return !!P.food; }

    /* ---------- 绘制 ---------- */
    function draw(ctx, W, H, sprites, opts) {
      if (!o.enabled) return;
      const meta = opts || {};
      const s = o.scale * Math.min(W, H * 1.6);
      const px = P.x * W;
      const py = P.y * H;

      const img = sprites[P.state === 'walk' ? 'walk' : (P.state === 'happy' || P.state === 'groom' || P.state === 'alert' || P.state === 'beg' ? 'happy' : 'idle')] || sprites.idle;
      if (!img) return;

      // ---- 接地阴影：与场景光照一致 ----
      const light = meta.light || 'side';
      ctx.save();
      ctx.translate(px, py);

      // 湿地面上的柔和倒影 + 接地影
      if (meta.groundWet) {
        ctx.save();
        ctx.globalAlpha = 0.20;
        ctx.scale(1, -0.42);
        ctx.filter = 'blur(2px)';
        const dw2 = img.width * (s / img.height);
        ctx.drawImage(img, -dw2 * 0.5, -s, dw2, s);
        ctx.restore();
      }

      const shw = s * (light === 'back' ? 0.62 : 0.55);
      const shh = s * (light === 'back' ? 0.075 : 0.085);
      const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, shw);
      sg.addColorStop(0, 'rgba(14,18,22,0.80)');
      sg.addColorStop(0.35, 'rgba(14,18,22,0.42)');
      sg.addColorStop(0.7, 'rgba(14,18,22,0.14)');
      sg.addColorStop(1, 'rgba(14,18,22,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.ellipse(0, 0, shw, shh, 0, 0, TAU);
      ctx.fill();
      // 脚下最实的一小团（接触点）
      const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.16);
      cg.addColorStop(0, 'rgba(10,14,18,0.72)');
      cg.addColorStop(1, 'rgba(10,14,18,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.17, s * 0.05, 0, 0, TAU);
      ctx.fill();
      // 逆光时在身前投一道长影
      if (light === 'back') {
        const lg = ctx.createLinearGradient(0, 0, -s * 0.55, 0);
        lg.addColorStop(0, 'rgba(18,20,24,0.30)');
        lg.addColorStop(1, 'rgba(18,20,24,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.ellipse(-s * 0.26, 0, s * 0.30, shh * 0.9, 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      // 呼吸起伏
      const breath = Math.sin(P.breathT * 1.9) * 0.006 * (P.sleepBlend > 0.5 ? 1.8 : 1);
      const bob = P.state === 'walk' ? Math.sin(P.stepPhase * 2) * s * 0.012 : 0;

      // ---- 主体 ----
      const dw = img.width * (s / img.height);
      const dh = s;
      const dx = -dw * 0.5;
      const dy = -dh;

      // 落地接触：轻微地气融合（底部羽化）
      ctx.save();
      ctx.translate(px, py + bob - s * breath);
      ctx.scale(P.facing, 1);
      if (P.sleepBlend > 0.01) {
        ctx.rotate(P.sleepBlend * 0.06);
        ctx.scale(1 - P.sleepBlend * 0.10, 1 - P.sleepBlend * 0.16);
      }
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.restore();

      // ---- 光影融合：把宠物纳入场景的光照与色调 ----
      if (meta.tintColor) {
        const tc = meta.tintColor;                       // [r,g,b]
        const strength = meta.tintStrength === undefined ? 0.30 : meta.tintStrength;
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = strength;
        const g = ctx.createLinearGradient(px - dw * 0.5, 0, px + dw * 0.5, 0);
        g.addColorStop(0, 'rgba(' + (tc[0] * 1.18 | 0) + ',' + (tc[1] * 1.18 | 0) + ',' + (tc[2] * 1.18 | 0) + ',1)');
        g.addColorStop(0.55, 'rgba(' + (tc[0] | 0) + ',' + (tc[1] | 0) + ',' + (tc[2] | 0) + ',1)');
        g.addColorStop(1, 'rgba(' + (tc[0] * 0.78 | 0) + ',' + (tc[1] * 0.78 | 0) + ',' + (tc[2] * 0.78 | 0) + ',1)');
        ctx.fillStyle = g;
        ctx.fillRect(px - dw * 0.6, py - dh * 1.02, dw * 1.2, dh * 1.04);
        ctx.restore();
        // 逆光时给边缘加一道轮廓光
        if (light === 'back' && meta.rimColor) {
          const rc = meta.rimColor;
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = 0.26;
          const rg = ctx.createLinearGradient(px + dw * 0.10, py - dh, px + dw * 0.5, py);
          rg.addColorStop(0, 'rgba(' + (rc[0] | 0) + ',' + (rc[1] | 0) + ',' + (rc[2] | 0) + ',0)');
          rg.addColorStop(1, 'rgba(' + (rc[0] | 0) + ',' + (rc[1] | 0) + ',' + (rc[2] | 0) + ',1)');
          ctx.fillStyle = rg;
          ctx.fillRect(px, py - dh * 1.02, dw * 0.55, dh * 1.04);
          ctx.restore();
        }
      }
      // 雾中宠物：靠近地平线时降低对比
      if (meta.hazeAmount) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = meta.hazeAmount;
        ctx.fillStyle = meta.hazeColor || 'rgba(220,228,232,1)';
        ctx.fillRect(px - dw * 0.6, py - dh * 1.02, dw * 1.2, dh * 1.04);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(px, py);

      // 眨眼：盖一条深色横带（简单可靠）
      if (P.blinking > 0 && P.sleepBlend < 0.4) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(60,42,30,0.85)';
        const ex = px + P.facing * s * 0.10;
        const ey = py - s * 0.66;
        ctx.beginPath();
        ctx.ellipse(ex, ey, s * 0.055, s * 0.014, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      // 睡觉的 Z / 音符 / 爱心
      for (const z of P.zzz) {
        const t = z.t / z.life;
        const zx = P.x * W + z.x * W + Math.sin(t * 3) * W * 0.008;
        const zy = P.y * H + z.y * H - t * s * 0.42;
        ctx.save();
        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.fillStyle = z.kind === 'heart' ? '#ff8fa8' : (z.kind === 'z' ? 'rgba(255,255,255,0.9)' : 'rgba(255,244,190,0.95)');
        ctx.font = 'bold ' + Math.round(s * (z.kind === 'heart' ? 0.26 : 0.22)) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 6;
        ctx.fillText(z.kind === 'heart' ? '♥' : (z.kind === 'z' ? 'Z' : '♪'), zx, zy);
        ctx.restore();
      }

      // 气泡
      if (P.bubble) {
        const t = 1 - P.bubble.t / 2.4;
        const a = Math.min(1, Math.min(t * 4, (1 - t) * 6 + 0.2));
        ctx.save();
        ctx.globalAlpha = a;
        const bw = Math.max(58, P.bubble.text.length * 15);
        const bh = 30;
        const bx = px - bw / 2;
        const by = py - s * 1.02;
        ctx.fillStyle = 'rgba(255,255,255,0.94)';
        ctx.strokeStyle = 'rgba(120,140,155,0.5)';
        ctx.lineWidth = 1.2;
        const rr = 12;
        ctx.beginPath();
        ctx.moveTo(bx + rr, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + bh, rr);
        ctx.arcTo(bx + bw, by + bh, bx, by + bh, rr);
        ctx.arcTo(bx, by + bh, bx, by, rr);
        ctx.arcTo(bx, by, bx + bw, by, rr);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px - 7, by + bh - 1);
        ctx.lineTo(px, by + bh + 11);
        ctx.lineTo(px + 7, by + bh - 1);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,255,255,0.94)';
        ctx.fill();
        ctx.fillStyle = '#2b3540';
        ctx.font = '600 15px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(P.bubble.text, px, by + bh / 2 + 1);
        ctx.restore();
      }

      // 饥饿指示（脚边的小碗）
      if (P.hunger > 0.45 && !P.food) {
        ctx.save();
        ctx.globalAlpha = 0.5 + 0.35 * Math.sin(P.breathT * 3);
        ctx.fillStyle = '#e8c98a';
        ctx.beginPath();
        ctx.ellipse(px + P.facing * s * 0.34, py - s * 0.02, s * 0.10, s * 0.045, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      ctx.restore();
    }

    /* ---------- 食物绘制（由场景层调用）---------- */
    function drawFood(ctx, W, H) {
      if (!P.food) return;
      const f = P.food;
      const s = o.scale * Math.min(W, H * 1.6);
      const fx = f.x * W, fy = f.y * H;
      ctx.save();
      ctx.translate(fx, fy);
      // 小碟
      ctx.fillStyle = 'rgba(240,238,232,0.96)';
      ctx.strokeStyle = 'rgba(150,145,135,0.6)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.17, s * 0.075, 0, 0, TAU);
      ctx.fill(); ctx.stroke();
      // 鱼干
      ctx.fillStyle = '#d99a54';
      ctx.beginPath();
      ctx.ellipse(-s * 0.02, -s * 0.012, s * 0.085, s * 0.032, -0.25, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#b8783a';
      ctx.beginPath();
      ctx.moveTo(s * 0.05, -s * 0.012);
      ctx.lineTo(s * 0.115, -s * 0.048);
      ctx.lineTo(s * 0.115, s * 0.024);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    return {
      state: P,
      opts: o,
      update, draw, drawFood,
      setCursor, onDown, onMove, onUp, dropFood, hasFood,
      say, setState,
      setEnabled(v) { o.enabled = v; },
      getScale() { return o.scale; },
      setScale(v) { o.scale = v; },
      setPosition(x, y) { P.x = x; P.y = y; },
      onEvent(fn) { P.onEvent = fn; }
    };
  }

  global.WS.Pet = { createPet, STATES };
})(window);
