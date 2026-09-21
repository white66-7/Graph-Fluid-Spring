/*
 * GFI.Main — 装配 + rAF 主循环 + 公开 API
 * ===========================================================================
 * 循环三条铁律：
 *   1. 【双重 clamp】累加器既限单帧时长（maxFrameMs），又限子步数（maxSubsteps）。
 *      只限一个的话，一次 200ms 卡顿会变成 12 个 tick 的死亡螺旋。
 *   2. 【空闲停机】连续 30 帧无活动就 cancelAnimationFrame。进程降到零 rAF 回调 ——
 *      这是"用户愿意一直启用"和"被卸载"的分界。
 *   3. 【平移缩放不唤醒模拟】只置脏标记重绘。每拖一下相机就重热整个图是不可接受的。
 */
(function (GFI) {
  'use strict';
  if (GFI.Main) return;

  const { clamp } = GFI.util;
  const DT = GFI.DT;

  let instance = null;

  function createPipeline(overlay, cam, nodes, links, prevD) {
    const D = GFI.Data.build(nodes, links, prevD);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);
    const renderer = GFI.Renderer.create(overlay.canvas, D, cam);
    renderer.setGrid(sim.grid);

    let inter = null;
    let timeline = null;

    return { D, sim, fx, renderer, get inter() { return inter; }, set inter(v) { inter = v; },
             get timeline() { return timeline; }, set timeline(v) { timeline = v; } };
  }

  function boot(opts) {
    opts = opts || {};
    if (instance) return instance;

    const cfg = GFI.config;
    const root = GFI.Overlay.findRoot();
    if (!root) return null;

    const overlay = GFI.Overlay.mount(root);
    if (!overlay) return null;

    const listeners = GFI.util.createListenerRegistry();
    const emitter = GFI.util.createEmitter();

    // ---- 相机 ----
    const cam = GFI.Camera.create(1, 1);

    // ---- 管线 ----
    let P = createPipeline(overlay, cam, opts.nodes || [], opts.links || [], null);
    let renderer = P.renderer;

    // ---- 主题背景 ----
    renderer.setBackground(overlay.readBackground());

    // ---- 脏标记 / 循环状态 ----
    let dirty = true;
    let rafId = null;
    let lastTime = 0;
    let acc = 0;
    let idleFrames = 0;
    let running = true;
    let errorCount = 0;
    let frameCount = 0;
    let labelsOn = false;
    let nativeMode = !!cfg.useNativeGraph;
    let lodLevel = 1;
    let lodForced = -1;
    let lastStats = null;

    // 数据加载后自动重新适配一次视野。
    //
    // 为什么必需：setData 里的 fitView 是在【种子布局】上算的 —— 那时节点还挤在
    // 半径 ~240 的螺旋里。模拟跑完后图谱可能扩散到几千单位，而相机不会自己跟上，
    // 结果就是视野里只剩一两个节点，看起来像白屏。
    // 等模拟沉降后再适配一次，保证第一眼看到的是完整图谱。
    // 用户一旦自己操作过（拖拽/平移），就取消这次自动适配，不跟人抢镜头。
    let autoFitPending = false;

    // ---- LOD 自适应 ----
    const lodCfg = cfg.lod;
    const frameTimes = new Float32Array(lodCfg.sampleFrames);
    // 排序暂存区。原先是 Array.prototype.slice + sort —— 每帧一次 60 元素
    // 数组分配外加一遍比较器调用，是主循环里唯一的稳定分配源（GC 抖动的来源）。
    // 换成预分配缓冲 + 插入排序：样本只有 30~60 个且近似有序，零分配。
    const ftScratch = new Float32Array(lodCfg.sampleFrames);
    let ftIdx = 0, ftFilled = 0, goodFrames = 0;

    function pushFrameTime(ms) {
      frameTimes[ftIdx] = ms;
      ftIdx = (ftIdx + 1) % frameTimes.length;
      if (ftFilled < frameTimes.length) ftFilled++;
    }

    function medianFrameTime() {
      if (!ftFilled) return 0;
      // 复制 + 插入排序一趟做完（用 subarray/slice 复制的话每帧又多一个视图对象）。
      // 帧耗时序列近似有序，插入排序正好是最优解。
      ftScratch[0] = frameTimes[0];
      for (let i = 1; i < ftFilled; i++) {
        const v = frameTimes[i];
        let j = i - 1;
        while (j >= 0 && ftScratch[j] > v) { ftScratch[j + 1] = ftScratch[j]; j--; }
        ftScratch[j + 1] = v;
      }
      return ftScratch[ftFilled >> 1];
    }

    function updateLod() {
      if (lodForced >= 0) { lodLevel = lodForced; return; }
      if (!lodCfg.auto || ftFilled < lodCfg.sampleFrames) return;
      const p50 = medianFrameTime();
      const maxLevel = lodCfg.levels.length - 1;
      if (p50 > lodCfg.downshiftMs && lodLevel < maxLevel) {
        lodLevel++; goodFrames = 0; ftFilled = 0;
      } else if (p50 < lodCfg.upshiftMs) {
        // 非对称阈值 + 持续帧数，防止在档位之间反复横跳
        if (++goodFrames >= lodCfg.upshiftHoldFrames && lodLevel > 0) {
          lodLevel--; goodFrames = 0; ftFilled = 0;
        }
      } else {
        goodFrames = 0;
      }
      if (P.fx && P.fx.setPulsesEnabled) P.fx.setPulsesEnabled(lodCfg.levels[lodLevel].pulses);
      // 必须把 LOD 传进物理 —— 否则 sim.lod 永远停在初始值，
      // 降档后「隔 tick 跑斥力」「跳过碰撞」这些优化根本不会生效
      P.sim.lod = lodLevel;
    }

    // ---- 尺寸 ----
    let cssW = 1, cssH = 1;
    overlay.onResize((w, h) => {
      cssW = w; cssH = h;
      const dpr = Math.min(GFI.topWin.devicePixelRatio || 1, cfg.render.maxDpr);
      cam.resize(w, h);
      renderer.resize(w, h, dpr);
      if (P.sim) P.sim.reheat(cfg.reheat.resize);
      markDirty();
    });

    // ---- 工具栏 ----
    const toolbar = GFI.Toolbar.create(overlay.toolbar, {
      onTogglePlay() { if (P.timeline) { P.timeline.toggle(); syncToolbar(); } },
      onScrub(p) {
        if (!P.timeline || !P.timeline.range) return;
        P.timeline.setSliderValue(p * P.timeline.range.duration, {
          viewportWorldHeight: cssH / Math.max(0.01, cam.k),
        });
        syncToolbar();
      },
      onScrubEnd() { markDirty(); },
      onToggleKind(idx) {
        if (!P.timeline) return;
        P.timeline.setKindOn(idx, !P.timeline.isKindOn(idx));
        syncToolbar();
      },
      onFit() { fitView(); },
    });

    function syncToolbar() {
      const tl = P.timeline;
      if (tl) {
        toolbar.setPlaying(tl.playing);
        // 用户正在拖滑块时，setProgress 内部会自行跳过回写（避免和手抢）
        toolbar.setProgress(tl.progress());
        const r = tl.range;
        if (r) {
          // 始终显示标准日期，不用「现在」这种相对说法 ——
          // 滑块在最右端时它本身就是最后一天的日期。
          const v = tl.cutoff === Infinity ? r.max : tl.cutoff;
          toolbar.setLabel(GFI.Toolbar.fmtDate(v));
        }
        toolbar.setKinds([tl.isKindOn(0), tl.isKindOn(1), tl.isKindOn(2)]);
      }
    }

    // ---- 交互 ----
    function attachInteraction() {
      if (P.inter) P.inter.destroy();
      P.inter = GFI.Interaction.create(overlay.canvas, P.D, cam, P.sim, P.fx, {
        onNodeActivate(node) {
          if (opts.onNodeActivate) opts.onNodeActivate(node);
          emitter.emit('nodeactivate', node);
        },
        onHoverChange() { markDirty(); },
        onSelectionChange(i) { emitter.emit('selectionchange', i); markDirty(); },
        // 相机变化（平移/缩放）→ 只需重绘，不需要模拟
        onCameraChange() { markDirty(); },
        onWake() { markDirty(); },
      });
      syncHighlightAfterVisibility();
      markDirty();
    }

    function syncHighlightAfterVisibility() {
      if (P.inter && P.inter.refreshHighlight) P.inter.refreshHighlight();
    }

    // ---- 时间轴 ----
    function attachTimeline() {
      P.timeline = GFI.Timeline.create(P.D, P.sim, P.fx, {
        onPlayingChange() { syncToolbar(); markDirty(); },
        onChange() { syncHighlightAfterVisibility(); syncToolbar(); markDirty(); },
      });
      toolbar.setTimeTravelAvailable(!!P.timeline.range);
      if (P.timeline.range) {
        // 初始落在 "现在"
        P.timeline.setCutoff(P.timeline.range.max, { pulse: false, silent: true });
      }
      syncToolbar();
    }

    attachInteraction();
    attachTimeline();

    // 记录 fitView 得到的缩放。标签阈值以它为基准做相对判断 ——
    // 世界单位是任意的（88 节点的图 fit 后 k≈0.08，3000 节点 k≈0.01），
    // 用绝对阈值会导致大图谱永远不显示标签。
    let fitK = 0;

    function fitView() {
      const b = GFI.Data.bounds(P.D, true);
      cam.fitBounds(b, cfg.camera.fitPadding);
      fitK = cam.k;
      markDirty();
    }

    function setNativeMode(native) {
      nativeMode = !!native;
      overlay.setNativeVisible(nativeMode);
      if (nativeMode) stopLoop();
      else { dirty = true; startLoop(); }
      syncToolbar();
      emitter.emit('nativemode', nativeMode);
    }

    // 置脏必须同时确保循环在跑。
    // 否则会出现这种状态：循环因空闲停掉了 → 某个操作置了脏标志并（可能）重热了模拟
    // → 但没有任何人在跑 rAF 去看那个标志 → 画面冻住，而且 alpha 永远停在重热值上
    // （因为没有 tick 去衰减它）。之前 resize 就是这么把图谱冻住的。
    function markDirty() {
      dirty = true;
      wake();
    }

    // =======================================================================
    // 主循环
    // =======================================================================
    function frame(now) {
      if (!running) return;
      rafId = GFI.topWin.requestAnimationFrame(frame);

      try {
        const elapsed = Math.min(cfg.runtime.maxFrameMs, Math.max(0, now - lastTime));
        lastTime = now;
        acc += elapsed;
        frameCount++;

        // ---- 退化场景：canvas 尺寸塌缩 ----
        if (frameCount % cfg.runtime.degenerateCheckEvery === 0) {
          const m = overlay.measure();
          if (m.w !== cssW || m.h !== cssH) {
            cssW = m.w; cssH = m.h;
            const dpr = Math.min(GFI.topWin.devicePixelRatio || 1, cfg.render.maxDpr);
            cam.resize(cssW, cssH);
            renderer.resize(cssW, cssH, dpr);
            markDirty();
          }
          if (!overlay.canvas.isConnected) { destroy('overlay detached'); return; }
          // 主题可能变了 —— 轮询比监听更可靠（Logseq 没有稳定的主题事件）
          if (frameCount % (cfg.runtime.degenerateCheckEvery * 4) === 0) {
            const bg = overlay.readBackground();
            if (bg !== renderer.bgColor) renderer.setBackground(bg);
          }
        }

        const vhWorld = cssH / Math.max(0.01, cam.k);

        // ---- 模拟子步 ----
        let substeps = 0;
        const maxSub = cfg.runtime.maxSubsteps;
        while (acc >= DT && substeps < maxSub) {
          const awake = P.sim.isAwake();
          if (awake) P.sim.tick(DT);
          P.fx.update(DT);
          if (awake) P.fx.applyHandoff(DT);
          if (P.timeline) P.timeline.update(DT, vhWorld);
          acc -= DT;
          substeps++;
        }
        // 丢弃积压，防止死亡螺旋
        if (substeps >= maxSub) acc = 0;

        // ---- 沉降后自动适配视野（见 autoFitPending 的说明）----
        if (autoFitPending && !P.sim.isAwake() && !(P.inter && P.inter.interacted)) {
          autoFitPending = false;
          const b = GFI.Data.bounds(P.D, true);
          // 只有在差异明显时才动相机，避免连续的微调抖动
          const curW = cam.W / cam.k, curH = cam.H / cam.k;
          const wantW = Math.max(1, b.maxX - b.minX), wantH = Math.max(1, b.maxY - b.minY);
          if (Math.abs(curW - wantW) / wantW > 0.25 || Math.abs(curH - wantH) / wantH > 0.25) {
            fitView();
          }
        }

        // ---- 标签滞回（阈值相对于 fitView 缩放）----
        const k = cam.k;
        const rc = cfg.render;
        const showK = fitK > 0 ? fitK * rc.labelShowScaleRatio : rc.labelFallbackShow;
        const hideK = fitK > 0 ? fitK * rc.labelHideScaleRatio : rc.labelFallbackHide;
        if (!labelsOn && k >= showK) labelsOn = true;
        else if (labelsOn && k < hideK) labelsOn = false;

        // ---- 绘制 ----
        const stats = renderer.render({
          hoverIdx: P.inter ? P.inter.hoverIdx : -1,
          selectedIdx: P.inter ? P.inter.selectedIdx : -1,
          lod: lodLevel,
          labelsOn,
        });
        lastStats = stats;
        // LOD 看的是【整帧处理耗时】，不只是绘制耗时 —— 物理占大头时也得降档
        pushFrameTime(GFI.util.now() - now);
        updateLod();

        // ---- 空闲判定 ----
        const busy = P.sim.isAwake() || P.fx.anyActive() ||
          (P.timeline && P.timeline.playing) ||
          (P.inter && (P.inter.dragNode >= 0 || P.inter.panning)) ||
          dirty;
        if (busy) { idleFrames = 0; dirty = false; }
        else if (++idleFrames > cfg.runtime.idleFrames) {
          stopLoop();
        }
      } catch (err) {
        if (++errorCount > 3) {
          console.error('[GFI] 连续出错，拆卸', err);
          destroy('too many frame errors');
        } else {
          console.warn('[GFI] 帧内错误', err);
        }
      }
    }

    function startLoop() {
      if (rafId != null || nativeMode || !running) return;
      lastTime = GFI.util.now();
      acc = 0;
      idleFrames = 0;
      rafId = GFI.topWin.requestAnimationFrame(frame);
    }

    function stopLoop() {
      if (rafId != null) {
        GFI.topWin.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function wake() {
      if (nativeMode) return;
      if (rafId == null) startLoop();
    }

    // ---- 宿主可见性 ----
    listeners.add(GFI.topDoc, 'visibilitychange', () => {
      if (GFI.topDoc.hidden) stopLoop();
      else { acc = 0; startLoop(); }     // 清空累加器，否则后台回来会堆 200 个 substep
    });

    // =======================================================================
    // 公开 API
    // =======================================================================
    const api = {
      get data() { return P.D; },
      get sim() { return P.sim; },
      get camera() { return cam; },
      get timeline() { return P.timeline; },
      get stats() { return lastStats; },
      get lod() { return lodLevel; },
      get root() { return root; },
      /** 渲染层是否还挂在 DOM 上。React 重渲染会清掉我们的容器，而 root 仍然连着。 */
      get alive() { return !!(overlay && overlay.alive); },
      overlay, toolbar,

      /** 全量替换数据。位置会按 id 继承，图谱不会整个跳回随机位置 */
      setData(nodes, links) {
        const prevD = P.D;
        // 拆掉旧管线：旧渲染器持有精灵缓存与测量缓存，不回收会累积泄漏
        if (P.inter) P.inter.destroy();
        if (P.fx) P.fx.destroy();
        if (P.renderer) P.renderer.destroy();
        P = createPipeline(overlay, cam, nodes, links, prevD);
        renderer = P.renderer;
        renderer.setGrid(P.sim.grid);
        renderer.setBackground(overlay.readBackground());
        const dpr = Math.min(GFI.topWin.devicePixelRatio || 1, cfg.render.maxDpr);
        renderer.resize(cssW, cssH, dpr);
        renderer.setGrid(P.sim.grid);
        attachInteraction();
        attachTimeline();
        fitView();                    // 先在种子布局上给一个大致视野
        autoFitPending = true;        // 等沉降完再精确适配一次
        P.sim.reheat(cfg.reheat.dataChange);
        startLoop();
      },

      setCutoff(ms) {
        if (!P.timeline) return;
        P.timeline.setCutoff(ms, { viewportWorldHeight: cssH / Math.max(0.01, cam.k) });
        syncToolbar();
      },

      pulse(o) {
        P.fx.pulse(Object.assign({
          ox: cam.x, oy: cam.y,
          viewportWorldHeight: cssH / Math.max(0.01, cam.k),
        }, o || {}));
        P.sim.reheat(cfg.reheat.pulse);
        wake();
      },

      fitView,

      /**
       * 实时调整外观（不用重载插件）。
       * 用法：__GFI__.setRender({ edgeColor: 'rgba(255,255,255,0.6)' })
       * 调好后把值告诉我，我写进 config.js 的默认值。
       */
      setRender(partial) {
        if (!partial) return cfg.render;
        for (const k in partial) {
          if (k === 'palette') Object.assign(cfg.render.palette, partial.palette);
          else cfg.render[k] = partial[k];
        }
        if (renderer && renderer.invalidateSprites) renderer.invalidateSprites();
        markDirty();
        return {
          edgeColor: cfg.render.edgeColor,
          edgeColorHi: cfg.render.edgeColorHi,
          edgeWidthBase: cfg.render.edgeWidthBase,
          edgeWidthMin: cfg.render.edgeWidthMin,
          labelColor: cfg.render.labelColor,
          labelFont: cfg.render.labelFont,
          labelShowScaleRatio: cfg.render.labelShowScaleRatio,
        };
      },

      setLod(n) { lodForced = (n === null || n === undefined || n === 'auto') ? -1 : (n | 0); },
      setNativeMode,
      get nativeMode() { return nativeMode; },
      on: emitter.on,
      off: emitter.off,
      wake,
      destroy(reason) { destroy(reason); },
    };

    // ---- 销毁 ----
    let destroyed = false;
    function destroy(reason) {
      if (destroyed) return;
      destroyed = true;
      running = false;
      stopLoop();
      try { listeners.removeAll(); } catch (e) {}
      try { if (P.inter) P.inter.destroy(); } catch (e) {}
      try { if (P.fx) P.fx.destroy(); } catch (e) {}
      try { if (P.renderer) P.renderer.destroy(); } catch (e) {}
      try { toolbar.destroy(); } catch (e) {}
      try { overlay.unmount(); } catch (e) {}
      emitter.clear();
      instance = null;
      try { delete GFI.topWin.__GFI__; } catch (e) {}
      console.log('[GFI] destroyed', reason || '');
    }

    instance = api;

    // ---- 启动 ----
    if (nativeMode) {
      overlay.setNativeVisible(true);
      syncToolbar();
    } else {
      overlay.setNativeVisible(false);
      fitView();
      startLoop();
    }
    syncToolbar();

    // -----------------------------------------------------------------------
    // 一键诊断 —— 白屏/看不见时先跑这个
    // -----------------------------------------------------------------------
    function diag() {
      const g = GFI.topWin.getComputedStyle;
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const css = (el, props) => {
        if (!el) return null;
        const s = g(el);
        const o = {};
        for (const p of props) o[p] = s[p];
        return o;
      };

      const natCanvas = overlay.nativeCanvas;
      const natToolbar = overlay.nativeToolbar;
      const out = {
        循环: { 运行中: rafId != null, 帧计数: frameCount, 原生模式: nativeMode, LOD: lodLevel },
        尺寸: { cssW, cssH, dpr: renderer.dpr, canvasAttr: overlay.canvas.width + '×' + overlay.canvas.height },
        相机: { x: Math.round(cam.x), y: Math.round(cam.y), k: +cam.k.toFixed(4) },
        数据: { n: P.D.n, m: P.D.m, 可见: (() => { let c = 0; for (let i = 0; i < P.D.n; i++) if (P.D.visible[i]) c++; return c; })() },
        交互: P.inter ? {
          hover: P.inter.hoverIdx, selected: P.inter.selectedIdx,
          dragging: P.inter.dragNode, panning: P.inter.panning,
          interacted: P.inter.interacted,
        } : null,
        自动适配: { pending: autoFitPending, fitK: +fitK.toFixed(4) },
        模拟: { alpha: +P.sim.alpha.toFixed(5), tick: P.sim.tickCount, 网格: P.sim.grid.cols + '×' + P.sim.grid.rows },
        // 原生 Pixi 渲染器：捕获 0 个说明钩子装晚了（进图谱之前插件就已经加载过
        // 一次的那种情况），这时原生画板只是被盖住、渲染循环还在空跑
        原生渲染: {
          已捕获: overlay.capturedNativeRenderers,
          已暂停: overlay.pausedNativeRenderers,
        },
        // ⚠ 这些是耗时，单位 ms。Chromium 把 performance.now() 钳到 100µs 精度，
        //   所以几十个节点的渲染所有阶段都会四舍五入成 0 —— 那【不代表没画】。
        //   要判断有没有画出来，看下面 DOM 里的 canvasAttr 和这里的 绘制节点/边 整数计数。
        上一帧耗时: lastStats,
        绘制: lastStats
          ? { 节点: lastStats.nodes, 边: lastStats.edgesN, 标签开关: labelsOn }
          : '（还没渲染过任何一帧）',
        DOM: {
          root: { rect: rect(root), css: css(root, ['position', 'overflow', 'zIndex', 'display', 'height']) },
          容器: { rect: rect(overlay.container), css: css(overlay.container, ['position', 'display', 'zIndex', 'visibility', 'opacity']) },
          我们的canvas: { rect: rect(overlay.canvas), 已连接: overlay.canvas.isConnected, css: css(overlay.canvas, ['position', 'display', 'visibility', 'opacity', 'background']) },
          原生canvas: { rect: rect(natCanvas), css: css(natCanvas, ['visibility', 'pointerEvents', 'display', 'zIndex']) },
          原生工具栏: { rect: rect(natToolbar), css: css(natToolbar, ['visibility', 'zIndex']) },
          工具栏: rect(overlay.toolbar),
          root内canvas数: root.querySelectorAll('canvas').length,
        },
      };

      console.group('%c[GFI] 诊断', 'color:#0aa;font-weight:bold');
      console.log('循环/尺寸/相机:', out.循环, out.尺寸, out.相机);
      console.log('数据/模拟:', out.数据, out.模拟);
      console.log('绘制:', out.绘制);
      console.log('上一帧耗时(ms，受 100µs 计时精度限制):', out.上一帧耗时);
      console.log('原生渲染器:', out.原生渲染);
      console.log('DOM:', out.DOM);
      console.groupEnd();

      const d = out.DOM;
      const problems = [];
      const notes = [];

      // ---- 致命问题 ----
      if (!d.我们的canvas.已连接) problems.push('我们的 canvas 未连接 —— overlay 被移除了');
      if (d.root.rect.h < 10) problems.push(`#global-graph 高度 ${d.root.rect.h}px —— 测量塌缩了`);
      if (out.尺寸.cssW < 10) problems.push(`测量宽度仅 ${out.尺寸.cssW}px`);
      if (out.数据.n === 0) problems.push('数据为空 —— 数据源没返回节点');
      if (out.数据.n > 0 && out.数据.可见 === 0) problems.push('所有节点都不可见 —— 检查时间轴 cutoff');
      if (out.数据.n > 0 && out.相机.k < 0.01) problems.push('相机缩放过小（fitView 可能算错了）');
      if (d.原生canvas.css.visibility !== 'hidden') problems.push('原生 canvas 未被隐藏 —— 可能盖住了我们');
      if (d.我们的canvas.css.display === 'none') problems.push('我们的 canvas 是 display:none');
      if (Number(d.我们的canvas.css.opacity) === 0) problems.push('我们的 canvas opacity 为 0');
      if (lastStats && lastStats.total > 200) problems.push(`帧耗时 ${lastStats.total}ms —— 太慢`);

      // 画了 0 个节点才是真问题；耗时全是 0 只是计时精度不足
      if (lastStats && lastStats.nodes === 0 && out.数据.n > 0 && out.数据.可见 > 0) {
        problems.push('视口剔除后节点数为 0 —— 相机可能没对准图谱');
      }

      // ---- 非致命说明 ----
      if (!out.循环.运行中) {
        if (out.模拟.alpha <= 0.01) {
          notes.push(`渲染循环已空闲停机（帧计数 ${out.循环.帧计数}，alpha=${out.模拟.alpha}）—— 这是【设计行为】，沉降完成后不再空转，有交互会自动唤醒`);
        } else {
          problems.push(`渲染循环停了但 alpha=${out.模拟.alpha}（还醒着）—— 唤醒逻辑有问题`);
        }
      }
      if (lastStats && lastStats.total === 0 && lastStats.nodes > 0) {
        notes.push('上一帧各阶段耗时显示为 0 —— 那是 performance.now() 的 100µs 精度下限，不是没画');
      }

      if (problems.length) {
        console.warn('%c[GFI] 发现问题:', 'color:#c00;font-weight:bold');
        for (const p of problems) console.warn('  ✘ ' + p);
      } else {
        console.log('%c[GFI] 未发现致命问题', 'color:#0a0;font-weight:bold');
      }
      for (const n of notes) console.log('%c  ℹ ' + n, 'color:#888');
      return out;
    }

    // -----------------------------------------------------------------------
    // 时间轴内省 —— 排查"按播放没反应"用这个
    // -----------------------------------------------------------------------
    function tlState() {
      const tl = P.timeline;
      if (!tl) { console.warn('[GFI] 时间轴不存在'); return { 存在: false }; }

      let vis = 0, want = 0, fading = 0, popping = 0;
      for (let i = 0; i < P.D.n; i++) {
        if (P.D.visible[i]) vis++;
        if (P.D.wantVisible[i]) want++;
        if (P.D.fadeT[i] === P.D.fadeT[i]) fading++;
        if (P.D.popT[i] === P.D.popT[i]) popping++;
      }
      const r = tl.range;
      const out = {
        存在: true,
        playing: tl.playing,
        速度: tl.speed,
        cutoff: tl.cutoff === Infinity ? 'Infinity' : tl.cutoff,
        进度: +tl.progress().toFixed(4),
        范围: r ? { min: r.min, max: r.max, durationMs: r.duration, 跨度天: Math.round(r.duration / 86400000) } : null,
        可见: vis, 目标可见: want, 淡出中: fading, 弹出中: popping, 总节点: P.D.n,
      };
      console.log('%c[GFI] 时间轴状态 ' + JSON.stringify(out, null, 2), 'color:#0aa;font-family:monospace');
      if (!r) {
        console.error('%c✘ tl.range 为 null —— setPlaying() 会直接 return，播放完全不会启动。' +
          '原因通常是所有节点的 createdAt 相同或全部缺失。', 'color:#c00;font-weight:bold');
      }
      return out;
    }

    // -----------------------------------------------------------------------
    // 布局分布 dump —— 判断"图谱为什么这么大/这么散"用这个
    // -----------------------------------------------------------------------
    function dump() {
      const Dd = P.D;
      if (!Dd.n) { console.warn('[GFI] 无数据'); return null; }

      let cx = 0, cy = 0;
      for (let i = 0; i < Dd.n; i++) { cx += Dd.x[i]; cy += Dd.y[i]; }
      cx /= Dd.n; cy /= Dd.n;

      const dist = new Float64Array(Dd.n);
      const idx = [];
      for (let i = 0; i < Dd.n; i++) {
        dist[i] = Math.hypot(Dd.x[i] - cx, Dd.y[i] - cy);
        idx.push(i);
      }
      const sorted = Float64Array.from(dist).sort();
      const pct = (p) => Math.round(sorted[Math.min(Dd.n - 1, Math.floor(Dd.n * p))]);
      const bb = GFI.Data.bounds(Dd, false);

      // 度数分布
      const degHist = {};
      let iso = 0;
      for (let i = 0; i < Dd.n; i++) {
        const d = Dd.deg[i];
        if (d === 0) iso++;
        const bucket = d === 0 ? '0' : d <= 2 ? '1-2' : d <= 5 ? '3-5' : d <= 10 ? '6-10' : '11+';
        degHist[bucket] = (degHist[bucket] || 0) + 1;
      }

      // 最远的 15 个
      idx.sort((a, b) => dist[b] - dist[a]);
      const far = idx.slice(0, 15).map((i) => ({
        标签: String(Dd.label[i]).slice(0, 24),
        度数: Dd.deg[i],
        类型: Dd.KIND_NAMES[Dd.kind[i]],
        离质心: Math.round(dist[i]),
      }));

      // 度数最高 but 离质心也远的 —— 正常情况 hub 应该靠近中心
      const byDeg = idx.slice().sort((a, b) => Dd.deg[b] - Dd.deg[a]).slice(0, 8).map((i) => ({
        标签: String(Dd.label[i]).slice(0, 24),
        度数: Dd.deg[i],
        离质心: Math.round(dist[i]),
      }));

      const summary = {
        节点数: Dd.n, 边数: Dd.m,
        包围盒: { 宽: Math.round(bb.maxX - bb.minX), 高: Math.round(bb.maxY - bb.minY) },
        离质心: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), 最大: Math.round(sorted[Dd.n - 1]) },
        度数直方图: degHist,
        孤立节点数: iso,
        相机可见世界宽度: Math.round(cam.W / cam.k),
        linkDistance: cfg.physics.linkDistance,
      };

      // 用纯文本输出 —— 对象在控制台里默认折叠，复制粘贴时什么都看不到
      const L = [];
      L.push('━━━ 概览 ━━━');
      L.push(`节点 ${summary.节点数}  边 ${summary.边数}  孤立节点 ${summary.孤立节点数}`);
      L.push(`包围盒 ${summary.包围盒.宽} × ${summary.包围盒.高}   相机可见宽度 ${summary.相机可见世界宽度}   linkDistance ${summary.linkDistance}`);
      L.push(`离质心距离  p50=${summary.离质心.p50}  p90=${summary.离质心.p90}  p99=${summary.离质心.p99}  max=${summary.离质心.最大}`);
      L.push(`最大/p50 = ${(summary.离质心.最大 / Math.max(1, summary.离质心.p50)).toFixed(1)}`);
      L.push('');
      L.push('━━━ 度数直方图 ━━━');
      for (const k of ['0', '1-2', '3-5', '6-10', '11+']) {
        L.push(`  度数 ${k.padEnd(6)} : ${degHist[k] || 0} 个`);
      }
      L.push('');
      L.push('━━━ 最远的 15 个节点 ━━━');
      L.push('  ' + '标签'.padEnd(26) + '度数'.padEnd(6) + '类型'.padEnd(10) + '离质心');
      for (const r of far) {
        L.push('  ' + String(r.标签).padEnd(26) + String(r.度数).padEnd(6) +
               String(r.类型).padEnd(10) + r.离质心);
      }
      L.push('');
      L.push('━━━ 度数最高的 8 个（正常应靠近中心）━━━');
      L.push('  ' + '标签'.padEnd(26) + '度数'.padEnd(6) + '离质心');
      for (const r of byDeg) {
        L.push('  ' + String(r.标签).padEnd(26) + String(r.度数).padEnd(6) + r.离质心);
      }

      // 全量清单 —— 用来判断"这些节点到底是不是我的内容"
      L.push('');
      L.push(`━━━ 全部 ${Dd.n} 个节点（按度数降序）━━━`);
      const all = [];
      for (let i = 0; i < Dd.n; i++) {
        all.push({ i, d: Dd.deg[i] });
      }
      all.sort((a, b) => b.d - a.d);
      for (const { i, d } of all) {
        L.push(`  ${String(d).padStart(3)}  ${String(Dd.KIND_NAMES[Dd.kind[i]]).padEnd(9)} ${Dd.label[i]}`);
      }
      console.log('%c[GFI] 布局分布\n' + L.join('\n'), 'color:#0aa;font-family:monospace');

      const ratio = summary.离质心.最大 / Math.max(1, summary.离质心.p50);
      if (ratio > 8) {
        console.warn(`%c⚠ 最大/中位距离比 = ${ratio.toFixed(1)} —— 有极端离群点把视野撑爆了，看上面「最远的 15 个」`,
          'color:#c00;font-weight:bold');
      }
      if (summary.包围盒.宽 > summary.相机可见世界宽度 * 3) {
        console.warn('%c⚠ 图谱宽度是相机可见宽度的 3 倍以上 —— 视野没对准（自动适配应该会修好）',
          'color:#c00;font-weight:bold');
      }
      return { summary, far, byDeg };
    }

    // 精简调试入口。
    // GFI 命名空间本体挂在插件 iframe 的 window 上（避免污染宿主页面和别的插件），
    // 所以主窗口控制台够不着。这里【故意】暴露一个小而明确的接口到 top，
    // 让你能在主窗口 DevTools 里直接调 —— 这是唯一的例外，且只有这几个成员。
    try {
      GFI.topWin.__GFI__ = {
        version: GFI.VERSION,
        graph: api,
        diag,
        dump,
        tlState,
        setRender: (p) => api.setRender(p),
        play: () => P.timeline && P.timeline.setPlaying(true),
        pause: () => P.timeline && P.timeline.setPlaying(false),
        /** 改过滤规则后重新拉数据，不用重载插件 */
        reload: () => (GFI.reloadData ? GFI.reloadData() : null),
        /** 直接改内置类黑名单并重新加载，如 __GFI__.hideClasses(['logseq.class/Tag','logseq.class/Page']) */
        hideClasses: (idents) => {
          GFI.config.data.hideClassIdents = idents || [];
          console.log('[GFI] 隐藏类枢纽：', GFI.config.data.hideClassIdents);
          return GFI.reloadData ? GFI.reloadData() : null;
        },
        /** 类型开关（0=页面 1=标签 2=日记 3=对象 4=属性），如 __GFI__.kind(2, false) */
        kind: (idx, on) => {
          if (!P.timeline) return null;
          P.timeline.setKindOn(idx, on);
          syncToolbar();
          return P.timeline.isKindOn(idx);
        },
        calibrate: () => GFI.calibrate(),
        config: GFI.config,
        stats: () => GFI.Data.stats(api.data),
        sim: () => api.sim,
        data: () => api.data,
        pulse: (o) => api.pulse(o),
        fit: () => api.fitView(),
        setLod: (n) => api.setLod(n),
        native: (b) => api.setNativeMode(b),
        demo: (n) => { const d = GFI.DataSource.demo(n || 400, {}); api.setData(d.nodes, d.links); },
      };
    } catch (e) {}

    return api;
  }

  // -------------------------------------------------------------------------
  // 标定助手
  // -------------------------------------------------------------------------
  GFI.calibrate = function calibrate() {
    const api = instance;
    if (!api) { console.warn('[GFI] 未运行'); return null; }
    const s = GFI.Data.stats(api.data);
    const st = api.stats;
    console.log('%c[GFI] 标定', 'color:#0aa;font-weight:bold');
    console.table({
      '节点数 n': s.n,
      '边数 m': s.m,
      '平均度数': s.avgDeg,
      '最大度数': s.maxDeg,
      '孤立节点': s.isolated,
      'p50 边长': s.p50LinkLen,
      'p90 边长': s.p90LinkLen,
      '包围半径': s.boundingRadius,
      'linkDistance': GFI.config.physics.linkDistance,
      'p50 / linkDistance': +(s.p50LinkLen / GFI.config.physics.linkDistance).toFixed(2),
    });
    if (st) console.log('上一帧耗时:', st);
    const ratio = s.p50LinkLen / GFI.config.physics.linkDistance;
    if (ratio < 1.2) console.log('%c→ p50 边长偏短，把 charge 调小一点（更负）或 linkDistance 调大', 'color:#c80');
    else if (ratio > 1.6) console.log('%c→ p50 边长偏长，把 charge 调大（更接近 0）', 'color:#c80');
    else console.log('%c✔ p50 边长落在 1.2~1.6 × linkDistance，达标', 'color:#0a0');
    return { ...s, frame: st };
  };

  GFI.getGraph = () => instance;

  GFI.Main = { boot, get instance() { return instance; } };
})(window.GFI);
