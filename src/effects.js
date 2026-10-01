/*
 * GFI.Effects — Obsidian 动力学特效
 * ===========================================================================
 * 三件事：
 *   (a) pop-out 弹簧   —— 纯渲染层，【绝不进入模拟】
 *   (b) 径向斥力激波   —— 向模拟注入世界空间速度，【绝不触碰相机】
 *   (c) 拖拽惯性着陆   —— 解析解 + 加权混合交接，避免硬 pin 的"啪"一下
 *
 * ── (a) 为什么 pop 不进模拟 ──
 * 它只改 scaleMul[i]，零扰动、零失稳风险，可以逐节点独立增删。
 *
 * ── (b) 为什么必须是"行进波前"而不是单次径向场 ──
 * 单次均匀径向脉冲的视觉签名 = 缩放。改成推进一个波前半径后：
 *   · 每个节点在环带扫过时【恰好被击中一次】
 *   · 远近节点的被击中【时刻不同】—— 相机变换在原理上做不到这一点
 *   · 幅度 ÷ (1 + f·√deg)：重 hub 少动、叶子飞出去 —— 最强的反缩放线索
 *   · 30% 随机抖动：完美径向场看起来像 shader 特效
 *   · 连边力和重力仍在作用 → 节点向外过冲后【弹回并沉降】。缩放永不回弹。
 */
(function (GFI) {
  'use strict';
  if (GFI.Effects) return;

  const { clamp, hash11s, jitter } = GFI.util;

  // 速度单位换算：模拟内部用「世界单位 / tick」，而激波冲量和甩掷速度
  // 是以「世界单位 / 秒」表达的（那是人更容易理解的单位）。
  const DT = GFI.DT;

  const NEARLY_ONE = 0.985;

  function create(D, sim) {
    const n = D.n;
    const cfg = GFI.config;

    // -----------------------------------------------------------------------
    // (a) pop-out 弹簧
    //   S(t) = 1 + A·e^(−ζω₀t)·sin(ω_d t),   ω_d = ω₀√(1−ζ²)
    // -----------------------------------------------------------------------
    function popDuration() {
      const { amp, omega, zeta } = cfg.pop;
      const decay = Math.max(0.0001, zeta * omega);
      const t = Math.log(Math.max(1.01, amp / 0.01)) / decay;
      return Math.min(cfg.pop.maxDuration, t);
    }

    // -----------------------------------------------------------------------
    // (b) 激波池（预分配，永不分配）
    // -----------------------------------------------------------------------
    const poolSize = cfg.timeline.poolSize;
    const pulses = [];
    for (let i = 0; i < poolSize; i++) {
      pulses.push({
        active: false, ox: 0, oy: 0,
        r0: 0, rPrev: 0, rCur: 0,
        speed: 0, decayLen: 1, J: 0, maxR: 0,
      });
    }
    let pulsesEnabled = true;
    let pulseWrite = 0;

    // -----------------------------------------------------------------------
    // 计数（用于空闲判定）
    // -----------------------------------------------------------------------
    // 🌟 T3 活跃索引列表：pop/fade 的逐帧推进从「全表 O(n) 扫描」改成「只扫活跃项」。
    //   播放期间 popCount 几乎恒 >0，旧实现对 5000 节点图是每帧几千次无效分支。
    //   popN/fadeN 是唯一事实来源，popCount/fadeCount 变成它们的只读别名 ——
    //   对外 getter、anyActive、§10 的计数器断言语义全部不变。
    //   ⚠ 不变量：列表里的每个 i 必有 popT[i]（fadeT[i]）为数字 —— 所有把
    //   T 置回 NaN 的路径（自然结束 / cancelHide / 被隐藏打断）都必须同步摘除。
    const popList = new Int32Array(n);
    const fadeList = new Int32Array(n);
    let popN = 0, fadeN = 0;

    const fx = {
      get popCount() { return popN; },
      get fadeCount() { return fadeN; },
    };

    // =======================================================================
    // 揭示 / 隐藏
    // =======================================================================
    fx.beginReveal = function beginReveal(i, delay) {
      if (i < 0 || i >= n) return;
      D.visible[i] = 1;
      D.wantVisible[i] = 1;

      if (D.popT[i] !== D.popT[i]) popList[popN++] = i;
      D.popT[i] = -Math.max(0, delay || 0);
      D.popDur[i] = popDuration();
      D.scaleMul[i] = 1;
      D.renderAlpha[i] = 0;

      // 🌟 Obsidian 分裂机制：受力权重首帧即全开（1.0），连线弹簧立即紧绷产生回弹
      D.simWeight[i] = 1.0;

      if (D.fadeT[i] === D.fadeT[i]) {
        // 复活一个正在淡出的节点 → 从活跃列表摘除，fadeT 同步清掉
        for (let k = 0; k < fadeN; k++) {
          if (fadeList[k] === i) { fadeList[k] = fadeList[--fadeN]; break; }
        }
      }
      D.fadeT[i] = NaN;
    };

    fx.beginHide = function beginHide(i) {
      if (i < 0 || i >= n) return;
      if (D.fadeT[i] === D.fadeT[i] && D.fadeT[i] >= 0) return;
      D.fadeT[i] = 0;
      D.fadeFrom[i] = D.simWeight[i];
      fadeList[fadeN++] = i;
    };

    fx.cancelHide = function cancelHide(i) {
      if (i < 0 || i >= n) return false;
      if (D.fadeT[i] !== D.fadeT[i]) return false;
      D.fadeT[i] = NaN;
      D.renderAlpha[i] = 1;
      D.scaleMul[i] = 1;
      D.simWeight[i] = D.fadeFrom[i] > 0 ? D.fadeFrom[i] : 1;
      for (let k = 0; k < fadeN; k++) {
        if (fadeList[k] === i) { fadeList[k] = fadeList[--fadeN]; break; }
      }
      return true;
    };

    // =======================================================================
    // 激波
    // =======================================================================
    // 🌟 T2：返回值 = 是否【真的】发射了一道波。magnitude=0（当前默认）或
    //   被视口钳制到 0 时返回 false —— 调用方（timeline.maybePulse）据此前止
    //   「波没发出去、图却被 reheat(0.5) 白白重热」的幽灵脉冲。
    fx.pulse = function pulse(o) {
      if (!pulsesEnabled) return false;
      o = o || {};
      const sc = cfg.shock;

      let mag = Math.abs(o.magnitude !== undefined ? o.magnitude : sc.magnitude);
      const vh = o.viewportWorldHeight;
      if (vh > 0) {
        const decayRate = Math.max(0.5, -Math.log(clamp(cfg.physics.velocityRetain, 0.5, 0.999)) * 60);
        const maxMag = (sc.maxDisplacementRatio * vh * decayRate);
        if (mag > maxMag) mag = maxMag;
      }
      if (mag <= 0) return false;

      const p = pulses[pulseWrite];
      pulseWrite = (pulseWrite + 1) % poolSize;

      p.active = true;
      p.ox = o.ox || 0;
      p.oy = o.oy || 0;
      p.r0 = o.r0 || 0;
      p.rPrev = p.r0;
      p.rCur = p.r0;
      p.speed = sc.speed;
      p.decayLen = sc.decayLen;
      p.maxR = Math.min(sc.maxRadius, o.maxRadius || sc.maxRadius);
      p.J = mag * (o.sign < 0 ? sc.backwardSign : 1);
      return true;
    };

    // 🌟 关闭时顺手清空波池：updatePulses 会因 !pulsesEnabled 早退，池里若还挂着
    //   active 的波就永远没人收尾 —— pulsesActive() 卡死为 true，timeline 的
    //   maybePulse 从此被它的前置检查吞掉。
    fx.setPulsesEnabled = function setPulsesEnabled(b) {
      pulsesEnabled = !!b;
      if (!pulsesEnabled) fx.clearPulses();
    };
    fx.clearPulses = function clearPulses() {
      for (let i = 0; i < poolSize; i++) pulses[i].active = false;
    };

    // =======================================================================
    // 每帧推进
    // =======================================================================
    fx.update = function update(dt) {
      updatePops(dt);
      updateFades(dt);
      updatePulses(dt);
    };

    function updatePops(dt) {
      if (popN <= 0) return;

      const { amp, omega, zeta, fadeInTime } = cfg.pop;
      const decayRate = Math.max(0.0001, zeta * omega);
      const wd = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta));

      const popT = D.popT, popDur = D.popDur, scaleMul = D.scaleMul,
        renderAlpha = D.renderAlpha, simWeight = D.simWeight, fadeT = D.fadeT;

      // 🌟 T3：只扫活跃列表。所有摘除走 swap-remove 且【不 j++】——
      //   换到当前槽位的是原本排在后面的、本帧还没处理的元素。
      let j = 0;
      while (j < popN) {
        const i = popList[j];
        const t = popT[i];

        // 不变量自愈：popT 已被别的路径清成 NaN → 直接摘除（理论上不发生）
        if (t !== t || fadeT[i] === fadeT[i]) {
          if (t === t) popT[i] = NaN;
          popList[j] = popList[--popN];
          continue;
        }

        if (t < 0) {
          const t2 = t + dt;
          if (t2 < 0) { popT[i] = t2; j++; continue; }   // 还在延迟期
          popT[i] = 0;
        }

        const elapsed = popT[i] + dt;
        popT[i] = elapsed;

        const e = Math.exp(-decayRate * elapsed);
        scaleMul[i] = 1 + amp * e * Math.sin(wd * elapsed);
        renderAlpha[i] = clamp(elapsed / Math.max(0.001, fadeInTime), 0, 1);

        // 🌟 保持受力权重全开
        simWeight[i] = 1.0;

        if (elapsed >= popDur[i]) {
          popT[i] = NaN;
          scaleMul[i] = 1;
          renderAlpha[i] = 1;
          simWeight[i] = 1;
          popList[j] = popList[--popN];
          continue;
        }
        j++;
      }
    }

    function updateFades(dt) {
      if (fadeN <= 0) return;

      const fadeTime = Math.max(0.001, cfg.timeline.hideFadeTime);
      const shrink = cfg.timeline.hideShrink;
      const fadeT = D.fadeT, renderAlpha = D.renderAlpha, simWeight = D.simWeight,
        scaleMul = D.scaleMul, visible = D.visible;

      let j = 0;
      while (j < fadeN) {
        const i = fadeList[j];
        let t = fadeT[i];

        if (t !== t) {                   // 不变量自愈（正常路径 cancelHide 已摘除）
          fadeList[j] = fadeList[--fadeN];
          continue;
        }

        t += dt / fadeTime;
        if (t >= 1) {
          fadeT[i] = NaN;
          visible[i] = 0;
          simWeight[i] = 0;
          renderAlpha[i] = 0;
          fadeList[j] = fadeList[--fadeN];
          continue;
        }
        fadeT[i] = t;
        renderAlpha[i] = 1 - t;
        simWeight[i] = D.fadeFrom[i] * (1 - t);
        scaleMul[i] = 1 - (1 - shrink) * t;
        j++;
      }
    }

    function updatePulses(dt) {
      if (!pulsesEnabled) return;
      const sc = cfg.shock;

      for (let pi = 0; pi < poolSize; pi++) {
        const p = pulses[pi];
        if (!p.active) continue;

        p.rPrev = p.rCur;
        p.rCur += p.speed * dt;
        if (p.rCur > (p.maxR || sc.maxRadius)) { p.active = false; continue; }

        const ox = p.ox, oy = p.oy, rPrev = p.rPrev, rCur = p.rCur;
        const J = p.J, decayLen = p.decayLen, r0 = p.r0;
        const jit = sc.jitter, mf = sc.massFactor;

        for (let i = 0; i < n; i++) {
          if (D.simWeight[i] === 0 || !D.visible[i]) continue;
          if (D.pinMode[i] === GFI.Physics.PIN_HARD) continue;

          const dx = D.x[i] - ox, dy = D.y[i] - oy;
          const d2 = dx * dx + dy * dy;
          if (d2 > rCur * rCur) continue;
          const d = Math.sqrt(d2) || 1e-3;
          if (d < rPrev || d >= rCur) continue;

          const jitF = 1 + jit * (hash11s(i, 3) - 0.5);
          const massScale = 1 / (1 + mf * Math.sqrt(D.deg[i]));
          const mag = J * Math.exp(-(d - r0) / decayLen) * jitF * massScale;

          const inv = mag * DT / d;
          D.vx[i] += dx * inv;
          D.vy[i] += dy * inv;
        }
      }
    }

    fx.anyActive = function anyActive() {
      return popN > 0 || fadeN > 0 || pulsesActive();
    };

    function pulsesActive() {
      for (let i = 0; i < poolSize; i++) if (pulses[i].active) return true;
      return false;
    }
    fx.pulsesActive = pulsesActive;

    fx.reset = function reset() {
      D.popT.fill(NaN, 0, n);
      D.fadeT.fill(NaN, 0, n);
      D.scaleMul.fill(1, 0, n);
      D.renderAlpha.fill(1, 0, n);
      D.simWeight.fill(1, 0, n);
      popN = 0; fadeN = 0;
      fx.clearPulses();
    };

    fx.destroy = function destroy() {
      fx.clearPulses();
    };

    return fx;
  }

  GFI.Effects = { create };
})(window.GFI);