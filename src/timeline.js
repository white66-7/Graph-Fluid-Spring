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
    let lastPulseAt = -1e9;

    // 节点出生样式
    const obsidianMode = cfg.pop.mode === 'obsidian';

    // 本帧新生节点总数，通过pass A用于 Obsidian 落点公式的抖动半径
    let revealBatch = 1;


    //   revealSlot[p] pass A当本帧子节点计数，pass B当槽位游标
    const revealSlot = new Int32Array(D.n);
    const parentOf = new Int32Array(D.n);
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

    // 脉冲
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
      if (!(cfg.shock.magnitude > 0)) return;

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

      const fired = fx.pulse({
        ox: o.x,
        oy: o.y,
        sign: forward ? 1 : -1,
        viewportWorldHeight,
        maxRadius: radius,
      });
      if (fired) sim.reheat(cfg.reheat.pulse);
    }

    // Obsidian 母体细胞分裂计算
    function findParent(i) {
      const s = D.adjStart[i], e = D.adjStart[i + 1];
      let parentIdx = -1;
      let maxDeg = -1;
      for (let p = s; p < e; p++) {
        const j = D.adjList[p];
        if (!D.visible[j]) continue;
        if (D.deg[j] > maxDeg) {
          maxDeg = D.deg[j];
          parentIdx = j;
        }
      }
      return parentIdx;
    }

    // parentIdx / slot 由 setCutoff 的两趟扫描传入 - pass A计数、pass B发射
    function anchorFor(i, visCentroid, parentIdx, slot) {
      // 算可见邻居的质心和最大半径
      const s = D.adjStart[i], e = D.adjStart[i + 1];
      let cx = 0, cy = 0, k = 0;
      for (let p = s; p < e; p++) {
        const j = D.adjList[p];
        if (!D.visible[j]) continue;
        cx += D.x[j]; cy += D.y[j]; k++;
      }

      // 有可见邻居
      if (k > 0) {
        cx /= k; cy /= k;

        let maxR = 0;
        for (let p = s; p < e; p++) {
          const j = D.adjList[p];
          if (!D.visible[j]) continue;
          const d = Math.hypot(D.x[j] - cx, D.y[j] - cy);
          if (d > maxR) maxR = d;
        }

        // 远离全图质心 + 黄金角错开兄弟
        let baseAngle;
        if (visCentroid && visCentroid.k > 0) {
          const dxc = cx - visCentroid.x, dyc = cy - visCentroid.y;
          const dc = Math.hypot(dxc, dyc);
          baseAngle = dc > 1e-3 ? Math.atan2(dyc, dxc) : jitter(i, 60, Math.PI);
        } else {
          baseAngle = jitter(i, 60, Math.PI);
        }
        const angle = baseAngle + (slot >= 0 ? slot * GOLDEN * 0.5 : 0) + jitter(i, 31, 0.2);
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);

        if (obsidianMode) {
          // 落在 hub 族外围
          const margin = cfg.physics.linkDistance * 0.8;   // 约 40
          const dist = maxR + margin + jitter(i, 61, 20);
          return {
            parentIdx: -1,
            x: cx + dirX * dist,
            y: cy + dirY * dist,
            dirX: -dirX,
            dirY: -dirY,
          };
        } else {
          // spring：紧贴母体 3px
          const px = D.x[parentIdx];
          const py = D.y[parentIdx];
          return {
            parentIdx,
            x: px + dirX * 3.0,
            y: py + dirY * 3.0,
            dirX,
            dirY,
          };
        }
      }

      // 无母节点的孤立节点
      if (visCentroid && visCentroid.k > 0) {
        // 算全图包围盒
        const bounds = GFI.Data.bounds(D, true);
        let outerR;
        if (!bounds.empty) {
          const cx = (bounds.minX + bounds.maxX) * 0.5;
          const cy = (bounds.minY + bounds.maxY) * 0.5;
          outerR = Math.max(
            bounds.maxX - cx,
            cx - bounds.minX,
            bounds.maxY - cy,
            cy - bounds.minY
          );
        } else {
          outerR = cfg.physics.linkDistance * 2.2;
        }

        const angle = jitter(i, 32, Math.PI);
        const margin = cfg.physics.linkDistance * 0.8;   
        const dist = outerR + margin + jitter(i, 33, 20);

        return {
          parentIdx: -1,
          x: visCentroid.x + Math.cos(angle) * dist,
          y: visCentroid.y + Math.sin(angle) * dist,
          dirX: -Math.cos(angle),
          dirY: -Math.sin(angle),
        };
      }

      // 创世节点 
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

    // 设置 cutoff
    tl.setCutoff = function setCutoff(ms, opts) {
      opts = opts || {};
      const prevCutoff = opts.prevCutoff !== undefined ? opts.prevCutoff : tl.cutoff;
      const budget = (opts.revealBudget === undefined) ? Infinity : opts.revealBudget;
      const instantHide = !!opts.instantHide;

      const changed = GFI.Data.applyCutoff(D, ms);
      tl.cutoff = ms;
      tl.rank = (opts.rank !== undefined) ? opts.rank : rankUpTo(ms);
      if (!changed && (budget === Infinity || !hasPendingReveal())) return 0;

      const forward = (opts.forward !== undefined) ? opts.forward : (ms > prevCutoff);
      const origin = changedCentroid();
      const visCentroid = GFI.Data.centroid(D, false, _centroid);

      const doPulse = opts.pulse !== false && !opts.silent
        && changed >= (cfg.timeline.pulseMinReveal || 1);
      if (doPulse) maybePulse(forward, origin, opts.viewportWorldHeight || 0);

      let revealed = 0, hidden = 0;

      revealSlot.fill(0, 0, D.n);
      let nPending = 0;
      for (let i = 0; i < D.n; i++) {
        if (D.wantVisible[i] !== 1 || D.visible[i] !== 0) continue;
        const p = findParent(i);
        parentOf[i] = p;
        if (p !== -1) revealSlot[p]++;
        nPending++;
      }
      revealBatch = Math.min(nPending, budget);

      for (let i = 0; i < D.n; i++) {
        const want = D.wantVisible[i];
        const isFading = D.fadeT[i] === D.fadeT[i];

        if (want === 1 && D.visible[i] === 0) {

          if (revealed >= budget) continue;

          const p = parentOf[i];
          const spawn = anchorFor(i, visCentroid, p, p !== -1 ? --revealSlot[p] : -1);
          D.x[i] = spawn.x;
          D.y[i] = spawn.y;

          if (obsidianMode) {
            D.vx[i] = 0;
            D.vy[i] = 0;
          } else {
            const kickSpeed = 22.0 + jitter(i, 41, 4.0);
            D.vx[i] = spawn.dirX * kickSpeed;
            D.vy[i] = spawn.dirY * kickSpeed;

            if (spawn.parentIdx !== -1) {
              const pIdx = spawn.parentIdx;
              const recoilMass = 1 / (1 + 0.18 * Math.sqrt(D.deg[pIdx]));
              const recoil = kickSpeed * 0.42 * recoilMass;
              D.vx[pIdx] -= spawn.dirX * recoil;
              D.vy[pIdx] -= spawn.dirY * recoil;
            }
          }

          D.simWeight[i] = 1.0;

          fx.beginReveal(i, 0);
          revealed++;
        } else if (want === 1 && D.visible[i] === 1 && isFading) {
          // ---- 撤销淡出 ----
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

    // 播放
    tl.setPlaying = function setPlaying(p) {
      if (!range) return;
      if (p && tl.sliderValue() >= range.duration - 1) {
        // 上一帧
        const prev = tl.cutoff;
        const start = cutoffAtRank(0);
        tl.setCutoff(start, { forward: false, pulse: true, instantHide: true });
        tl.setCutoff(start, { forward: true, pulse: false, prevCutoff: prev, instantHide: true });
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
      if (!tl.playing || !range || !pacedCount) return;

      const step = tl.rate * tl.speed * dt;
      if (step <= 0) return;

      const prev = tl.cutoff;
      const rank = Math.min(pacedCount, tl.rank + step);
      // rank转化为时间戳
      const next = cutoffAtRank(rank);

      const o = {
        forward: true, prevCutoff: prev, viewportWorldHeight, playing: true,
        rank,
      };
      if (cfg.timeline.burstSmoothing !== false) {
        o.revealBudget = Math.max(1, Math.ceil(step));
      }
      tl.setCutoff(next, o);

      // 判断是否结束
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