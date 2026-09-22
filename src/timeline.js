/*
 * GFI.Timeline — 时间旅行（Obsidian 细胞分裂动态模型）
 * ===========================================================================
 * 可见性判定只有一次比较：  !(createdAt[i] > cutoff)
 *   因为 createdAt 缺失存的是 NaN，而 NaN > cutoff 恒为 false
 *   → 没有时间戳的节点永远可见，无需存在性分支。
 *
 * ── Obsidian 风格核心机制：母体细胞分裂（Cell Budding） ──
 *
 * 1. 细胞分裂式诞生：
 *    新节点出生时不再摆放在抽象的“邻居几何中心”，而是直接紧贴其引用的母节点
 *    （母体）诞生。
 *
 * 2. 动量守恒与后坐力（Action-Reaction）：
 *    子节点诞生瞬间被赋予背离母体的喷射初速度；同时母节点承受反向后坐力推力。
 *    原本长度接近 0 的连线被瞬间拉伸紧绷，产生强烈的弹簧回弹与团簇震颤。
 *
 * 3. 首帧全受力：
 *    simWeight 直接从 1.0 开始，连线拉力第 1 帧全力介入，杜绝“隐形中弹完”的现象。
 */
(function (GFI) {
  'use strict';
  if (GFI.Timeline) return;

  const { clamp, jitter } = GFI.util;

  function create(D, sim, fx, hooks) {
    const cfg = GFI.config;
    hooks = hooks || {};

    const range = GFI.Data.timeRange(D);

    const tl = {
      range,
      cutoff: range ? range.max : Infinity,   // = "现在"，全部可见
      playing: false,
      speed: 1,
      speedIdx: 1,
    };

    const _centroid = { x: 0, y: 0, k: 0 };
    let lastPulseAt = -1e9;

    // =======================================================================
    // 脉冲（可选的背景扰动波）
    // =======================================================================
    function changedCentroid() {
      let cx = 0, cy = 0, k = 0;
      for (let i = 0; i < D.n; i++) {
        if (D.wantVisible[i] === D.visible[i]) continue;
        cx += D.x[i]; cy += D.y[i]; k++;
      }
      if (!k) return null;
      return { x: cx / k, y: cy / k, k };
    }

    function maybePulse(forward, origin, viewportWorldHeight) {
      const now = GFI.util.now();
      if (now - lastPulseAt < cfg.timeline.pulseThrottleMs) return;
      if (fx.pulsesActive && fx.pulsesActive()) return;

      lastPulseAt = now;
      const o = origin || GFI.Data.centroid(D, true, _centroid);

      const b = GFI.Data.bounds(D, false);
      const radius = Math.max(
        cfg.physics.linkDistance * 4,
        Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 0.5 * cfg.shock.maxRadiusFactor
      );

      fx.pulse({
        ox: o.x,
        oy: o.y,
        sign: forward ? 1 : -1,
        viewportWorldHeight,
        maxRadius: radius,
      });
      sim.reheat(cfg.reheat.pulse);
    }

    // =======================================================================
    // 揭示锚点：Obsidian 母体细胞分裂计算
    // =======================================================================
    function anchorFor(i, visCentroid) {
      const s = D.adjStart[i], e = D.adjStart[i + 1];

      let parentIdx = -1;
      let maxDeg = -1;

      // 寻找度数最高且已处于可见状态的邻居，作为主要分裂母体
      for (let p = s; p < e; p++) {
        const j = D.adjList[p];
        if (!D.visible[j]) continue;
        if (D.deg[j] > maxDeg) {
          maxDeg = D.deg[j];
          parentIdx = j;
        }
      }

      // 情况 1：存在母节点 —— 紧贴母节点向外侧爆破喷射
      if (parentIdx !== -1) {
        const px = D.x[parentIdx];
        const py = D.y[parentIdx];

        // 基础方向：沿母体背离全图质心的外展方向
        const cx = visCentroid && visCentroid.k > 0 ? visCentroid.x : px;
        const cy = visCentroid && visCentroid.k > 0 ? visCentroid.y : py;
        let angle = Math.atan2(py - cy, px - cx);

        if (Math.abs(px - cx) < 1e-3 && Math.abs(py - cy) < 1e-3) {
          angle = jitter(i, 30, Math.PI);
        } else {
          // 叠加大自然般的有机散射角（±45度散开）
          angle += jitter(i, 31, 0.78);
        }

        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);

        // 仅偏移 3 像素出生，视觉呈现出纯正的从母节点裂变而出的质感
        return {
          parentIdx,
          x: px + dirX * 3.0,
          y: py + dirY * 3.0,
          dirX,
          dirY,
        };
      }

      // 情况 2：无母节点的孤立节点 —— 从外圈向内滑入
      if (visCentroid && visCentroid.k > 0) {
        const angle = jitter(i, 32, Math.PI);
        const dist = cfg.physics.linkDistance * 2.2 + jitter(i, 33, 40);
        return {
          parentIdx: -1,
          x: visCentroid.x + Math.cos(angle) * dist,
          y: visCentroid.y + Math.sin(angle) * dist,
          dirX: -Math.cos(angle),
          dirY: -Math.sin(angle),
        };
      }

      // 情况 3：初始创世节点（图谱完全为空）
      const angle = jitter(i, 34, Math.PI);
      const r = 20 + jitter(i, 35, 30);
      return {
        parentIdx: -1,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        dirX: Math.cos(angle),
        dirY: Math.sin(angle),
      };
    }

    // =======================================================================
    // 设置 cutoff
    // =======================================================================
    tl.setCutoff = function setCutoff(ms, opts) {
      opts = opts || {};
      const prevCutoff = opts.prevCutoff !== undefined ? opts.prevCutoff : tl.cutoff;

      const changed = GFI.Data.applyCutoff(D, ms);
      tl.cutoff = ms;
      if (!changed) return 0;

      const forward = (opts.forward !== undefined) ? opts.forward : (ms > prevCutoff);
      const origin = changedCentroid();
      const visCentroid = GFI.Data.centroid(D, false, _centroid);

      const doPulse = opts.pulse !== false && !opts.silent
        && changed >= (cfg.timeline.pulseMinReveal || 1);
      if (doPulse) maybePulse(forward, origin, opts.viewportWorldHeight || 0);

      let revealed = 0, hidden = 0;

      for (let i = 0; i < D.n; i++) {
        const want = D.wantVisible[i];
        const isFading = D.fadeT[i] === D.fadeT[i];

        if (want === 1 && D.visible[i] === 0) {
          // ---- 揭示：Obsidian 母体分裂与反冲爆发 ----
          const spawn = anchorFor(i, visCentroid);
          D.x[i] = spawn.x;
          D.y[i] = spawn.y;

          // 🌟 1. 子节点爆发速度（向外猛冲）
          const kickSpeed = 22.0 + jitter(i, 41, 4.0);
          D.vx[i] = spawn.dirX * kickSpeed;
          D.vy[i] = spawn.dirY * kickSpeed;

          // 🌟 2. 母节点后坐力反冲（牛顿第三定律）
          // 子节点向外射出的同时，母节点被向后推退，连线弹簧瞬间被拉得极紧并产生回弹振荡
          if (spawn.parentIdx !== -1) {
            const pIdx = spawn.parentIdx;
            const recoilMass = 1 / (1 + 0.18 * Math.sqrt(D.deg[pIdx]));
            const recoil = kickSpeed * 0.42 * recoilMass;
            D.vx[pIdx] -= spawn.dirX * recoil;
            D.vy[pIdx] -= spawn.dirY * recoil;
          }

          // 🌟 3. 力的权重首帧全开，连线弹簧立即介入工作
          D.simWeight[i] = 1.0;

          // 🌟 4. 取消延迟错峰，诞生即刻爆发
          fx.beginReveal(i, 0);
          revealed++;
        } else if (want === 1 && D.visible[i] === 1 && isFading) {
          // ---- 撤销淡出 ----
          if (fx.cancelHide(i)) revealed++;
        } else if (want === 0 && D.visible[i] === 1 && !isFading) {
          // ---- 隐藏 ----
          fx.beginHide(i);
          hidden++;
        }
      }

      if (revealed || hidden) {
        const revealHeat = opts.playing ? cfg.reheat.timelinePlay : cfg.reheat.cutoff;
        if (hidden) sim.reheat(Math.min(cfg.reheat.fadeStart, revealHeat));
        if (revealed) sim.reheat(revealHeat);
        if (hooks.onChange) hooks.onChange({ revealed, hidden, cutoff: ms });
      }
      return changed;
    };

    tl.setKindOn = function setKindOn(kindIdx, on) {
      const k = kindIdx | 0;
      if (k < 0 || k >= D.kindOn.length) return 0;
      const v = on ? 1 : 0;
      if (D.kindOn[k] === v) return 0;
      D.kindOn[k] = v;
      return tl.setCutoff(tl.cutoff, { forward: !!on, pulse: true });
    };

    tl.isKindOn = function isKindOn(kindIdx) { return !!D.kindOn[kindIdx | 0]; };

    tl.setSliderValue = function setSliderValue(v, opts) {
      if (!range) return 0;
      const prev = tl.cutoff;
      const ms = range.min + clamp(v, 0, range.duration);
      const o = Object.assign({}, opts || {});
      o.forward = ms >= prev;
      o.prevCutoff = prev;
      return tl.setCutoff(ms, o);
    };

    tl.sliderValue = function sliderValue() {
      if (!range) return 0;
      if (tl.cutoff === Infinity) return range.duration;
      return clamp(tl.cutoff - range.min, 0, range.duration);
    };

    tl.progress = function progress() {
      if (!range || !range.duration) return 1;
      return clamp(tl.sliderValue() / range.duration, 0, 1);
    };

    tl.reset = function reset() {
      if (!range) return;
      tl.setCutoff(range.max, { pulse: true, forward: true });
    };

    // =======================================================================
    // 播放
    // =======================================================================
    tl.setPlaying = function setPlaying(p) {
      if (!range) return;
      if (p && tl.sliderValue() >= range.duration - 1) {
        const prev = tl.cutoff;
        tl.setCutoff(range.min, { forward: false, pulse: true });
        tl.setCutoff(range.min, { forward: true, pulse: false, prevCutoff: prev });
      }
      tl.playing = !!p;
      lastPulseAt = -1e9;
      if (hooks.onPlayingChange) hooks.onPlayingChange(tl.playing);
    };

    tl.toggle = function toggle() { tl.setPlaying(!tl.playing); };

    tl.setSpeed = function setSpeed(s) { tl.speed = s; };

    tl.cycleSpeed = function cycleSpeed() {
      const speeds = cfg.timeline.speeds;
      tl.speedIdx = (tl.speedIdx + 1) % speeds.length;
      tl.speed = speeds[tl.speedIdx];
      return tl.speed;
    };

    tl.update = function update(dt, viewportWorldHeight) {
      if (!tl.playing || !range) return;
      const advance = (dt / Math.max(1, cfg.timeline.baseDurationSec) * tl.speed) * range.duration;
      if (advance <= 0) return;

      const prev = tl.cutoff;
      let next = prev + advance;
      if (next >= range.max) next = range.max;

      tl.setCutoff(next, { forward: true, prevCutoff: prev, viewportWorldHeight, playing: true });

      if (next >= range.max) {
        tl.playing = false;
        if (hooks.onPlayingChange) hooks.onPlayingChange(false);
      }
    };

    // 起始状态：全部可见
    D.wantVisible.fill(1, 0, D.n);

    return tl;
  }

  GFI.Timeline = { create };
})(window.GFI);