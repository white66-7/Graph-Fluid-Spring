/* 时间旅行 - Obsidian 细胞分裂动态模型 */
(function (GFI) {
  'use strict';
  if (GFI.Timeline) return;

  const { clamp, jitter } = GFI.util;

  function create(D, sim, fx, hooks) {
    const cfg = GFI.config;
    hooks = hooks || {};

    const range = GFI.Data.timeRange(D);  // 时间范围对象

    const tl = {
      range,  // 时间戳
      cutoff: range ? range.max : Infinity,   // 当前时刻
      playing: false,
      speed: 1,           // 倍速
      speedIdx: 1,
      rank: 0,            // 秩
      rate: 0,            // 节点/秒
      pacedCount: 0,      // 有时间戳的节点数
      playDurationSec: 0, // 全程秒数
      rateAuto: false,    // 速率自动计算
    };

    const _centroid = { x: 0, y: 0, k: 0 };

    //   GOLDEN = 黄金角 137.5°
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));

    // 时间戳排序
    const sortedTs = (function () {
      const a = [];
      for (let i = 0; i < D.n; i++) {
        const t = D.createdAt[i];
        if (Number.isFinite(t)) a.push(t);
      }
      a.sort((x, y) => x - y);
      return Float64Array.from(a);
    })();

    const pacedCount = sortedTs.length;   // 有时间戳的节点总数

    // 二分查找 sortedTs中小于等于 ms的元素个数
    function rankUpTo(ms) {
      let lo = 0, hi = pacedCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTs[mid] <= ms) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    function cutoffAtRank(rank) {
      const k = Math.floor(rank);
      if (k <= 0) return range ? range.min - 1 : -Infinity;   // 还差一点才轮到第一个
      return sortedTs[Math.min(pacedCount, k) - 1];
    }

    // 判定要出现但未出现的节点
    function hasPendingReveal() {
      const want = D.wantVisible, vis = D.visible;
      for (let i = 0; i < D.n; i++) if (want[i] && !vis[i]) return true;
      return false;
    }

    // 用户自定义速率(节点/秒),设成0时使用 Obsidian公式
    tl.pacedCount = pacedCount;

    const rawRate = Number(cfg.timeline.revealRate);
    tl.rateAuto = rawRate === 0;
    tl.rate = tl.rateAuto
      ? clamp(0.5 * Math.sqrt(D.m), 5, 100)     //  Obsidian 公式
      : clamp(rawRate || 0, 0.05, 200);
    tl.playDurationSec = pacedCount / tl.rate;


    tl.rank = rankUpTo(tl.cutoff);


    // 算新节点的落点
    function anchorFor(i, visCentroid) {
      // 无可见节点 → 创世
      if (!visCentroid || visCentroid.k === 0) {
        const angle = jitter(i, 34, Math.PI);
        const r = 20 + jitter(i, 35, 30);
        return {
          x: Math.cos(angle) * r,
          y: Math.sin(angle) * r,
          dirX: Math.cos(angle),
          dirY: Math.sin(angle),
        };
      }

      // 全图外围
      const bounds = GFI.Data.bounds(D, true);
      let outerR;
      if (!bounds.empty) {
        const bxc = (bounds.minX + bounds.maxX) * 0.5;
        const byc = (bounds.minY + bounds.maxY) * 0.5;
        outerR = Math.max(
          bounds.maxX - bxc, bxc - bounds.minX,
          bounds.maxY - byc, byc - bounds.minY
        );
      } else {
        outerR = cfg.physics.linkDistance * 2.2;
      }

      const angle = jitter(i, 32, Math.PI);
      const margin = cfg.physics.linkDistance * 0.8;
      const dist = outerR + margin + jitter(i, 33, 20);

      return {
        x: visCentroid.x + Math.cos(angle) * dist,
        y: visCentroid.y + Math.sin(angle) * dist,
        dirX: -Math.cos(angle),
        dirY: -Math.sin(angle),
      };
    }
    // 设置 cutoff
    tl.setCutoff = function setCutoff(ms, opts) {
      opts = opts || {};
      const budget = (opts.revealBudget === undefined) ? Infinity : opts.revealBudget;
      const instantHide = !!opts.instantHide;

      const changed = GFI.Data.applyCutoff(D, ms);
      tl.cutoff = ms;
      tl.rank = (opts.rank !== undefined) ? opts.rank : rankUpTo(ms);
      if (!changed && (budget === Infinity || !hasPendingReveal())) return 0;

      const visCentroid = GFI.Data.centroid(D, false, _centroid);

      let revealed = 0, hidden = 0;

      // 揭示 / 撤销淡出 / 隐藏
      for (let i = 0; i < D.n; i++) {
        const want = D.wantVisible[i];
        const isFading = D.fadeT[i] === D.fadeT[i];

        if (want === 1 && D.visible[i] === 0) {
          if (revealed >= budget) continue;

          const spawn = anchorFor(i, visCentroid);
          D.x[i] = spawn.x;
          D.y[i] = spawn.y;
          D.vx[i] = 0;
          D.vy[i] = 0;
          D.simWeight[i] = 1.0;

          fx.beginReveal(i, 0);
          revealed++;
        } else if (want === 1 && D.visible[i] === 1 && isFading) {
          if (fx.cancelHide(i)) revealed++;
        } else if (want === 0 && D.visible[i] === 1 && !isFading) {
          if (instantHide) fx.hideNow(i); else fx.beginHide(i);
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
      return tl.setCutoff(tl.cutoff);
    };

    tl.isKindOn = function isKindOn(kindIdx) { return !!D.kindOn[kindIdx | 0]; };

    tl.setSliderValue = function setSliderValue(v, opts) {
      if (!range) return 0;
      const ms = range.min + clamp(v, 0, range.duration);
      return tl.setCutoff(ms, opts || {});
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
      tl.setCutoff(range.max);
    };

    // 播放
    tl.setPlaying = function setPlaying(p) {
      if (!range) return;
      if (p && tl.sliderValue() >= range.duration - 1) {
        tl.setCutoff(cutoffAtRank(0), { instantHide: true });
      }
      tl.playing = !!p;
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

    tl.update = function update(dt) {
      if (!tl.playing || !range || !pacedCount) return;

      const step = tl.rate * tl.speed * dt;
      if (step <= 0) return;

      const rank = Math.min(pacedCount, tl.rank + step);
      const next = cutoffAtRank(rank);

      const o = { playing: true, rank };
      if (cfg.timeline.burstSmoothing !== false) {
        o.revealBudget = Math.max(1, Math.ceil(step));
      }
      tl.setCutoff(next, o);

      if (rank >= pacedCount && !hasPendingReveal()) {
        tl.playing = false;
        if (hooks.onPlayingChange) hooks.onPlayingChange(false);
      }
    };

    // 刷新可见性
    D.wantVisible.fill(1, 0, D.n);
    return tl;
  }

  GFI.Timeline = { create };
})(window.GFI);