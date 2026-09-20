/*
 * GFI.Timeline — 时间旅行
 * ===========================================================================
 * 可见性判定只有一次比较：  !(createdAt[i] > cutoff)
 *   因为 createdAt 缺失存的是 NaN，而 NaN > cutoff 恒为 false
 *   → 没有时间戳的节点永远可见，无需存在性分支。
 *   3000 次比较约 5µs，滑块拖动时每帧跑都无所谓。
 *
 * ── 两条关键设计 ──
 *
 * 1. 所有节点始终存在于模拟中，不可见的只是被排除出力循环。
 *    反面做法（可见时才加进模拟）对时间旅行是错的：过去的样子会被未来的布局
 *    塑造，同一段历史每次拖回去都会长得不一样。
 *
 * 2. 淡出时【保持节点在模拟里，只把力的权重线性降到 0】，而不是立刻移除。
 *    立刻移除会让邻居"咯噔"跳一下。重热要在淡出【开始】时做，
 *    这样邻居在它还看得见的时候就开始收拢；在淡出结束时才重热会看到明显的塌陷。
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
    // 脉冲
    // =======================================================================
    /** 计算一波变化的质心，以此为波源 —— 波才像是被这一步时间旅行引起的 */
    function changedCentroid() {
      let cx = 0, cy = 0, k = 0;
      for (let i = 0; i < D.n; i++) {
        // 目标可见性与当前不一致 = 这一步需要过渡的节点
        if (D.wantVisible[i] === D.visible[i]) continue;
        cx += D.x[i]; cy += D.y[i]; k++;
      }
      if (!k) return null;
      return { x: cx / k, y: cy / k, k };
    }

    function maybePulse(forward, origin, viewportWorldHeight) {
      const now = GFI.util.now();
      // 节流是下限，真正的约束是下面那条"上一道波必须走完"
      if (now - lastPulseAt < cfg.timeline.pulseThrottleMs) return;
      // ⚠ 必须等上一道波走完再发下一道。
      //   否则几道波同时在飞，观感就是"前一个效果还没完，下一个就直接来了"。
      if (fx.pulsesActive && fx.pulsesActive()) return;

      lastPulseAt = now;
      const o = origin || GFI.Data.centroid(D, true, _centroid);

      // 波只跑到图谱边缘就够了。
      // 之前写死 2600：图谱只有 ~700 单位时，波 0.3 秒就扫完了却要继续空跑 1.08 秒，
      // 白白占着脉冲池、逼着后面的波叠上来。
      const b = GFI.Data.bounds(D, false);
      const radius = Math.max(
        cfg.physics.linkDistance * 4,     // 极小图谱的兜底，别让波一出生就死
        Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 0.5 * cfg.shock.maxRadiusFactor
      );

      fx.pulse({
        ox: o.x,
        oy: o.y,
        sign: forward ? 1 : -1,          // 倒退时 J 取负 → 波前把节点向内吸（内爆）
        viewportWorldHeight,
        maxRadius: radius,
      });
      sim.reheat(cfg.reheat.pulse);
    }

    // =======================================================================
    // 揭示锚点
    // 节点的首帧绝不能出现在随机坐标上 —— 那会让"生长"看起来像乱码。
    // =======================================================================
    function anchorFor(i, visCentroid) {
      const rc = cfg.timeline;
      // 1. 可见邻居的质心（最好）
      let cx = 0, cy = 0, k = 0;
      const s = D.adjStart[i], e = D.adjStart[i + 1];
      for (let p = s; p < e; p++) {
        const j = D.adjList[p];
        if (!D.visible[j]) continue;
        cx += D.x[j]; cy += D.y[j]; k++;
      }
      if (k > 0) {
        return [cx / k + jitter(i, 21, rc.revealAnchorJitter),
                cy / k + jitter(i, 22, rc.revealAnchorJitter)];
      }
      // 2. 图谱质心的外围 —— 这些节点从边缘飞进来，效果很好看
      if (visCentroid && visCentroid.k > 0) {
        return [visCentroid.x + jitter(i, 23, rc.revealFringeJitter),
                visCentroid.y + jitter(i, 24, rc.revealFringeJitter)];
      }
      // 3. 什么都没有（第一次揭示）
      return [jitter(i, 25, rc.revealFringeJitter), jitter(i, 26, rc.revealFringeJitter)];
    }

    // =======================================================================
    // 设置 cutoff
    // =======================================================================
    /**
     * @param {number} ms 绝对毫秒时间戳
     * @param {object} [opts] { pulse:boolean, viewportWorldHeight:number, silent:boolean }
     * @returns {number} 发生状态翻转的节点数
     */
    tl.setCutoff = function setCutoff(ms, opts) {
      opts = opts || {};
      // ⚠ 必须先把旧值抓出来再赋值 —— 原先在赋值之后才读 tl.cutoff 做方向判断，
      //   那时它已经是新值了，ms > ms 恒为 false，时间永远被判成"倒退"。
      const prevCutoff = opts.prevCutoff !== undefined ? opts.prevCutoff : tl.cutoff;

      const changed = GFI.Data.applyCutoff(D, ms);   // 只写 wantVisible
      tl.cutoff = ms;
      if (!changed) return 0;

      const forward = (opts.forward !== undefined) ? opts.forward : (ms > prevCutoff);
      const origin = changedCentroid();
      const visCentroid = GFI.Data.centroid(D, false, _centroid);

      // 先决定要不要发脉冲 —— 揭示的径向错峰要以波源为基准。
      // 只揭示一两个节点不值得发一波：否则滑块微动都会激起冲击波，观感就"急"了。
      const doPulse = opts.pulse !== false && !opts.silent
        && changed >= (cfg.timeline.pulseMinReveal || 1);
      if (doPulse) maybePulse(forward, origin, opts.viewportWorldHeight || 0);

      let revealed = 0, hidden = 0;
      const waveSpeed = Math.max(1, cfg.pop.radialWaveSpeed);
      const maxDelay = cfg.pop.maxRadialDelay;
      // 无脉冲时按 createdAt 排名错峰，总时长封顶
      const idxDelayStep = D.n > 0 ? Math.min(0.012, cfg.pop.maxIndexDelay / D.n) : 0;
      let revealIndex = 0;

      for (let i = 0; i < D.n; i++) {
        const want = D.wantVisible[i];
        const isFading = D.fadeT[i] === D.fadeT[i];

        if (want === 1 && D.visible[i] === 0) {
          // ---- 揭示 ----
          const [ax, ay] = anchorFor(i, visCentroid);
          D.x[i] = ax; D.y[i] = ay;
          D.vx[i] = 0; D.vy[i] = 0;
          D.simWeight[i] = 0;

          let delay = 0;
          if (doPulse && origin) {
            // 径向错峰：节点随波前到达而逐个弹出。
            // 这是整个设计里最好看的一瞬 —— 它让波看起来是因果的，而不是装饰的。
            const d = Math.hypot(ax - origin.x, ay - origin.y);
            delay = Math.min(maxDelay, d / waveSpeed);
          } else {
            delay = revealIndex * idxDelayStep;
          }
          revealIndex++;

          fx.beginReveal(i, delay);
          revealed++;
        } else if (want === 1 && D.visible[i] === 1 && isFading) {
          // ---- 撤销淡出 ----
          // 来回拖滑块时高频出现：节点刚要消失就又被要求显示。
          // 不救的话它会淡到消失并卡死（fadeT 走完把 visible 置 0，
          // 而这次 cutoff 变化已经处理完了，没有后续事件再揭示它）。
          if (fx.cancelHide(i)) revealed++;
        } else if (want === 0 && D.visible[i] === 1 && !isFading) {
          // ---- 隐藏 ----
          fx.beginHide(i);
          hidden++;
        }
      }

      if (revealed || hidden) {
        // 播放中用温和的重热幅度 —— 见 config.reheat.timelinePlay 的说明。
        // 手动拖滑块则用较大幅度，那样响应才跟手。
        const revealHeat = opts.playing ? cfg.reheat.timelinePlay : cfg.reheat.cutoff;
        // 重热要在淡出【开始】时做，让邻居趁节点还看得见就开始收拢
        if (hidden) sim.reheat(Math.min(cfg.reheat.fadeStart, revealHeat));
        if (revealed) sim.reheat(revealHeat);
        if (hooks.onChange) hooks.onChange({ revealed, hidden, cutoff: ms });
      }
      return changed;
    };

    /**
     * 类型显示开关（0=页面 1=标签 2=日记 3=对象 4=属性）。
     * 走的是 wantVisible 这条既有通路 —— 于是淡出/弹出/重热整套机制都能复用，
     * 不用在渲染层再引入"部分隐藏"的概念。
     */
    tl.setKindOn = function setKindOn(kindIdx, on) {
      const k = kindIdx | 0;
      if (k < 0 || k >= D.kindOn.length) return 0;
      const v = on ? 1 : 0;
      if (D.kindOn[k] === v) return 0;
      D.kindOn[k] = v;
      // 打开 = 揭示（波前向外），关闭 = 收起（波前向内）
      return tl.setCutoff(tl.cutoff, { forward: !!on, pulse: true });
    };

    tl.isKindOn = function isKindOn(kindIdx) { return !!D.kindOn[kindIdx | 0]; };

    /** 用 0..duration 的滑块值设置（与 Logseq 原生滑块的语义一致） */
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
        // 已经到末尾 —— 从头开始
        const prev = tl.cutoff;
        tl.setCutoff(range.min, { forward: false, pulse: true });
        tl.setCutoff(range.min, { forward: true, pulse: false, prevCutoff: prev });
      }
      tl.playing = !!p;
      lastPulseAt = -1e9;          // 允许立刻发第一个脉冲
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

    // =======================================================================
    // 初始化
    // =======================================================================
    // 起始状态：全部可见（与原生一致），用户按播放才从头演化
    D.wantVisible.fill(1, 0, D.n);

    return tl;
  }

  GFI.Timeline = { create };
})(window.GFI);
