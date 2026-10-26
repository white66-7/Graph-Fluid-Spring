// 负责画图
(function (GFI) {
  'use strict';
  if (GFI.Main) return;

  const { clamp } = GFI.util;
  const DT = GFI.DT;

  // 图谱实例表
  const instances = new Map();     // HTMLElement root → api
  // 主实例
  let primary = null;

  function createPipeline(overlay, cam, nodes, links, prevD, layout) {
    const D = GFI.Data.build(nodes, links, prevD, layout);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D);
    const renderer = GFI.Renderer.create(overlay.canvas, D, cam);
    renderer.setGrid(sim.grid);

    let inter = null;
    let timeline = null;

    return {
      D, sim, fx, renderer,
      get inter() { return inter; }, set inter(v) { inter = v; },
      get timeline() { return timeline; }, set timeline(v) { timeline = v; }
    };
  }

  function boot(opts) {
    opts = opts || {};
    // ⚠ root 必须由调用方给：`GFI.Overlay.findRoot()` 写死的是全屏图谱，
    //   侧边栏那块面板得传自己的 `.page-graph-panel` 进来。
    const root = opts.root || GFI.Overlay.findRoot();
    if (!root) return null;

    // 同一个 root 不重复挂（React 重渲染会连着喊好几次）
    const existing = instances.get(root);
    if (existing) {
      if (existing.alive) return existing;
      // 容器被 React 清掉了 —— 清掉登记，往下走重挂
      instances.delete(root);
    }

    const cfg = GFI.config;

    // 相机、循环、工具栏、时间轴是【全屏图谱】的配置；侧边栏那块面板只有
    // 560px 宽、还带个 min(72vh,860px) 的高度上限，塞不下那套控件，
    // 而且它的时间轴语义也和全局图谱不同（见 index.js 的 sidebar 控制器）。
    const chrome = opts.chrome || {};
    const wantToolbar = chrome.toolbar !== false;
    const wantTimeline = chrome.timeline !== false;

    let nativeMode = !!cfg.useNativeGraph;

    // 挂载即接管
    const deferTakeover = false;
    const overlay = GFI.Overlay.mount(root, { nativeVisible: deferTakeover });
    if (!overlay) return null;

    // 不要工具栏的那条路必须把【容器元素本身】也摘掉。
    //   `.gfi-toolbar` 是个有背景色、圆角、内边距的浮动胶囊 ——
    //   只把里面塞空的话，面板底部会挂着一个空的小黑条。
    if (!wantToolbar) { try { overlay.toolbar.remove(); } catch (e) { } }

    GFI.Overlay.record('overlay 挂载完成',
      deferTakeover ? '原生图谱继续显示' : '原生图谱已隐藏');
    if (!deferTakeover) overlay.showLoader();

    const listeners = GFI.util.createListenerRegistry();
    const emitter = GFI.util.createEmitter();

    // 相机
    const cam = GFI.Camera.create(1, 1);

    // 管线
    let P = createPipeline(overlay, cam, opts.nodes || [], opts.links || [], null);
    let renderer = P.renderer;

    // 主题背景
    renderer.setBackground(overlay.readBackground());

    // 循环状态
    let dirty = true;
    let rafId = null;
    let lastTime = 0;
    let acc = 0;

    // 静止帧累计
    let idleFrames = 0;
    let running = true;
    let errorCount = 0;
    let frameCount = 0;
    let labelsOn = false;
    let labelFade = 0;
    let lodLevel = 1;
    let lodForced = -1;
    let lastStats = null;

    let instantReveal = false;
    // 显现淡入的总时长
    let revealDurMs = 0;

    // 视图归属
    let tookOver = !deferTakeover || nativeMode;
    // 首帧待交接
    let loaderArmed = false;

    // 视野缓动
    let camAnim = null;

    // 图谱显现时的一次淡入
    let revealAnim = null;

    // 只在变化时写 style，避免每帧碰 DOM
    let lastVisualAlpha = 1;

    // 自动适配
    let autoFitPending = false;

    // 停顿帧判据
    const STALL_MIN_MS = 100;
    const STALL_FACTOR = 3;

    // ---- LOD 自适应 ----
    const lodCfg = cfg.lod;
    const frameTimes = new Float32Array(lodCfg.sampleFrames);
    // 排序暂存区。原先是 Array.prototype.slice + sort —— 每帧一次 60 元素
    // 数组分配外加一遍比较器调用，是主循环里唯一的稳定分配源（GC 抖动的来源）。
    // 换成预分配缓冲 + 插入排序：样本只有 30~60 个且近似有序，零分配。
    const ftScratch = new Float32Array(lodCfg.sampleFrames);
    let ftIdx = 0, ftFilled = 0, goodFrames = 0;

    // ⚠ 不变式：有效样本位于 frameTimes[0 .. ftFilled-1]。
    //   所以换档时重置 ftFilled 必须【同时】重置 ftIdx —— 否则新一轮样本从旧位置
    //   绕圈写入，而中位数仍然在读 [0..ftFilled-1]，正好在换档后最需要准数的
    //   那 30 帧里混进换档【之前】的陈旧样本。
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
      const maxLevel = lodCfg.levels.length - 1;

      if (lodForced >= 0) {
        lodLevel = clamp(lodForced, 0, maxLevel) | 0;
      } else if (lodCfg.auto && ftFilled >= lodCfg.sampleFrames) {
        const p50 = medianFrameTime();
        if (p50 > lodCfg.downshiftMs && lodLevel < maxLevel) {
          lodLevel++; goodFrames = 0; ftFilled = 0; ftIdx = 0;
        } else if (p50 < lodCfg.upshiftMs) {
          // 非对称阈值 + 持续帧数，防止在档位之间反复横跳
          if (++goodFrames >= lodCfg.upshiftHoldFrames && lodLevel > 0) {
            lodLevel--; goodFrames = 0; ftFilled = 0; ftIdx = 0;
          }
        } else {
          goodFrames = 0;
        }
      }

      P.sim.lod = lodLevel;
    }

    // ---- 尺寸 ----
    let cssW = 1, cssH = 1;

    // 每30帧检查尺寸
    const m0 = overlay.measure();
    cssW = Math.max(1, m0.w | 0);
    cssH = Math.max(1, m0.h | 0);

    // 重新分配画布
    cam.resize(cssW, cssH);
    overlay.onResize((w, h) => {
      cssW = w; cssH = h;
      const dpr = Math.min(GFI.topWin.devicePixelRatio || 1, cfg.render.maxDpr);
      cam.resize(w, h);
      renderer.resize(w, h, dpr);
      if (P.sim) P.sim.reheat(cfg.reheat.resize);
      markDirty();
    });

    // 工具栏
    const toolbar = wantToolbar ? GFI.Toolbar.create(overlay.toolbar, {
      onTogglePlay() { if (P.timeline) { P.timeline.toggle(); syncToolbar(); } },
      onScrub(p) {
        if (!P.timeline || !P.timeline.range) return;
        P.timeline.setSliderValue(p * P.timeline.range.duration);
        syncToolbar();
      },
      onScrubEnd() { markDirty(); },
      onToggleKind(idx) {
        if (!P.timeline) return;
        P.timeline.setKindOn(idx, !P.timeline.isKindOn(idx));
        syncToolbar();
      },
      onFit() { fitViewAnimated(); },
      onSnapshot() { snapshot(); },
    }) : GFI.Toolbar.createNull();

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

    // 交互 
    function attachInteraction() {
      if (P.inter) P.inter.destroy();
      P.inter = GFI.Interaction.create(overlay.canvas, P.D, cam, P.sim, {
        onNodeActivate(node) {
          if (opts.onNodeActivate) opts.onNodeActivate(node);
          emitter.emit('nodeactivate', node);
        },
        onHoverChange() { markDirty(); },
        onSelectionChange(i) { emitter.emit('selectionchange', i); markDirty(); },
        // 相机变化（平移/缩放）→ 只需重绘，不需要模拟。
        // 同时放弃进行中的视野缓动 —— 用户一动手就不跟他抢镜头。
        onCameraChange() { cancelCamAnim(); markDirty(); },
        // 任何指针动作也放弃缓动（拖节点不改相机，但用户显然已经接管了）
        onWake() { cancelCamAnim(); markDirty(); },
      });
      syncHighlightAfterVisibility();
      markDirty();
    }

    function syncHighlightAfterVisibility() {
      if (P.inter && P.inter.refreshHighlight) P.inter.refreshHighlight();
    }

    // 时间轴 
    function attachTimeline() {
      P.timeline = GFI.Timeline.create(P.D, P.sim, P.fx, {
        onPlayingChange() { syncToolbar(); markDirty(); },
        onChange() { syncHighlightAfterVisibility(); syncToolbar(); markDirty(); },
      });
      toolbar.setTimeTravelAvailable(!!P.timeline.range);
      if (P.timeline.range) {
        // 初始落在 "现在"
        P.timeline.setCutoff(P.timeline.range.max);
      }
      syncToolbar();
    }

    attachInteraction();
    if (wantTimeline) attachTimeline();
    // 没有时间轴就不会有范围/进度，但调用顺序上 syncToolbar 可能先跑一轮 ——
    // 空实现 + 这里的 setTimeTravelAvailable 保证工具栏任何状态下都不显示那组控件。
    else toolbar.setTimeTravelAvailable(false);

    // 记录 fitView 得到的缩放。标签阈值以它为基准做相对判断 ——
    // 世界单位是任意的（88 节点的图 fit 后 k≈0.08，3000 节点 k≈0.01），
    // 用绝对阈值会导致大图谱永远不显示标签。
    let fitK = 0;

    /**
     * 适配视野时的内边距（CSS px），按视口尺寸自适应。
     *
     * 实机数据（2026-10）：用户的图画布只有 **708 × 243**（图谱挂在侧栏里），
     * 而 config.camera.fitPadding 是 72 —— 两边各 72，可视绘图区只剩 564 × 99！
     * 结果图谱被压成"又小又挤"的一条，还会让 fitK 偏小、顺带把标签阈值带偏。
     *
     * 所以把它当成【上限】：小视口按 6% 缩，并且至少留 10px。
     * 243 高的窗口 → 14px；800 高的窗口 → 48px；≥1200 才用满 72。
     *
     * ⚠ 侧边栏面板走另一条线（`opts.fitPad === 'sidebar'`），见 config.sidebar.fitPadding：
     *   它是一个【绝对值】而不是比例。面板只有 560px，同一个 6% 算出来只有 ~33px，
     *   实测偏紧；而绝对值"每边留 48px"是按眼睛调出来的，不用脑补比例。
     *   这个值是每次调用【现读】的，所以调参不需要重挂实例。
     */
    const FIT_PAD_LIMIT = 10;      // 两侧加起来最少要留的空间
    // 侧边栏没有 config 时的兜底（面板小，别让留白吃满）
    const SB_FIT_PAD_FALLBACK = 48;
    const isSidebarFit = opts.fitPad === 'sidebar';
    function fitPad() {
      const short = Math.min(cam.W, cam.H);
      if (isSidebarFit) {
        // 每边留白的绝对值；上限按面板短边的 45% 兜底，防止填太大把图压成一个点
        const want = (cfg.sidebar && cfg.sidebar.fitPadding) || SB_FIT_PAD_FALLBACK;
        return clamp(want, FIT_PAD_LIMIT, short * 0.45);
      }
      const want = cfg.camera.fitPadding;
      const bySize = short * 0.06;
      return clamp(bySize, FIT_PAD_LIMIT, want);
    }

    function fitView() {
      const b = GFI.Data.bounds(P.D, true);
      cam.fitBounds(b, fitPad());
      fitK = cam.k;
      markDirty();
    }

    // 视野缓动 
    function animateFitTo(b, ms) {
      const pad = fitPad();
      const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
      const kx = (cam.W - 2 * pad) / w, ky = (cam.H - 2 * pad) / h;
      const k1 = clamp(Math.min(kx, ky), cfg.camera.minZoom, cfg.camera.maxZoom);
      const x1 = (b.minX + b.maxX) * 0.5, y1 = (b.minY + b.maxY) * 0.5;
      if (!(ms > 0) || (cam.k === k1 && cam.x === x1 && cam.y === y1)) {
        fitView();
        return;
      }
      camAnim = { t: 0, dur: ms / 1000, x0: cam.x, y0: cam.y, k0: cam.k, x1, y1, k1 };
      wake();
    }


    function snapshot(opts) {
      opts = opts || {};
      const paddingCss = opts.padding !== undefined ? opts.padding : 60;
      const maxSize = opts.maxSize || 1600;
      const format = opts.format === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      const quality = opts.quality !== undefined ? opts.quality : 0.92;

      // ---- ① 探测 ----
      if (!running || !renderer) {
        console.warn('[GFI] 截图失败：实例已销毁');
        return false;
      }
      const src = overlay && overlay.canvas;
      if (!src || !src.isConnected) {
        console.warn('[GFI] 截图失败：canvas 不在 DOM');
        return false;
      }
      if (!(src.width > 0 && src.height > 0)) {
        console.warn(`[GFI] 截图失败：canvas 尺寸 ${src.width}×${src.height}`);
        return false;
      }
      if (typeof src.toBlob !== 'function') {
        console.warn('[GFI] 截图失败：不支持 canvas.toBlob');
        return false;
      }
      if (!P.D || !P.D.n) {
        console.warn('[GFI] 截图失败：没有数据');
        return false;
      }

      // fitView
      fitView();

      // 包围盒→ 屏幕
      const b = GFI.Data.bounds(P.D, true);
      if (b.empty || !(b.maxX > b.minX) || !(b.maxY > b.minY)) {
        console.warn('[GFI] 截图失败：没有可见节点');
        return false;
      }
      const x0 = cam.worldToScreenX(b.minX);
      const y0 = cam.worldToScreenY(b.minY);
      const x1 = cam.worldToScreenX(b.maxX);
      const y1 = cam.worldToScreenY(b.maxY);

      const sxCss = Math.max(0, x0 - paddingCss);
      const syCss = Math.max(0, y0 - paddingCss);
      const swCss = Math.min(cam.W, x1 + paddingCss) - sxCss;
      const shCss = Math.min(cam.H, y1 + paddingCss) - syCss;
      if (swCss <= 0 || shCss <= 0) {
        console.warn('[GFI] 截图失败：裁剪区域无效');
        return false;
      }

      try {
        renderer.render({
          hoverIdx: -1,          
          selectedIdx: -1,
          lod: lodLevel,
          labelsOn,
          labelFade,
        });
      } catch (e) {
        console.warn('[GFI] 截图失败：补画异常', e);
        return false;
      }

      // 转设备像素
      const dpr = src.width / cam.W;
      const sx = Math.round(sxCss * dpr);
      const sy = Math.round(syCss * dpr);
      const sw = Math.round(swCss * dpr);
      const sh = Math.round(shCss * dpr);
      if (sw <= 0 || sh <= 0) {
        console.warn('[GFI] 截图失败：裁剪尺寸为 0');
        return false;
      }

      //  放大到最长边 maxSize
      const scale = maxSize / Math.max(sw, sh);
      const outW = Math.max(1, Math.round(sw * scale));
      const outH = Math.max(1, Math.round(sh * scale));

      let outCanvas = null;
      try {
        outCanvas = GFI.topDoc.createElement('canvas');
        outCanvas.width = outW;
        outCanvas.height = outH;
        const g = outCanvas.getContext('2d');
        if (!g) throw new Error('离屏 2d 上下文不可用');
        g.fillStyle = renderer.bgColor || cfg.render.bgFallback;
        g.fillRect(0, 0, outW, outH);
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, sx, sy, sw, sh, 0, 0, outW, outH);
      } catch (e) {
        console.warn('[GFI] 截图失败：绘制阶段异常', e);
        return false;
      }

      // ---- ⑦ 导出 ----
      try {
        outCanvas.toBlob((blob) => {
          if (!blob) {
            console.warn('[GFI] 截图失败：toBlob 返回 null');
            return;
          }
          try {
            const url = URL.createObjectURL(blob);
            const a = GFI.topDoc.createElement('a');
            const d = new Date();
            const p = (v) => String(v).padStart(2, '0');
            const ext = format === 'image/jpeg' ? 'jpg' : 'png';
            a.download = `graph-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
              + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
            a.href = url;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (e) {
            console.warn('[GFI] 截图下载失败', e);
          }
        }, format, quality);
      } catch (e) {
        console.warn('[GFI] 截图失败：导出异常（可能 canvas 被污染）', e);
        return false;
      }

      return true;
    }

    function fitViewAnimated() {
      animateFitTo(GFI.Data.bounds(P.D, true), cfg.camera.fitAnimMs);
    }

    function stepCamAnim(dt) {
      const a = camAnim;
      if (!a) return;
      a.t += dt;
      let p = a.t / a.dur;
      if (!(p < 1)) p = 1;
      const e = 1 - Math.pow(1 - p, 3);                 // ease-out cubic
      cam.x = a.x0 + (a.x1 - a.x0) * e;
      cam.y = a.y0 + (a.y1 - a.y0) * e;
      // 缩放走【几何插值】。线性插值 k 会让前段显得飞快、后段几乎不动 ——
      // 人对缩放的感知是对数的（同 zoomByWheel 用 zoomBase 指数一样）。
      cam.k = a.k0 * Math.pow(Math.max(1e-9, a.k1) / Math.max(1e-9, a.k0), e);
      if (p >= 1) { camAnim = null; fitK = cam.k; }
      markDirty();                                       // 保持循环活着
    }

    // 用户操作取消缓动
    function cancelCamAnim() { camAnim = null; }

    // 取消加载态
    function completeTakeover(reason) {
      tookOver = true;
      loaderArmed = false;
      overlay.hideLoader();
      GFI.Overlay.record('画布接管（loader 收起）', reason || '');
    }

    function setNativeMode(native) {
      nativeMode = !!native;
      overlay.setNativeVisible(nativeMode);
      if (nativeMode) {
        // 交还给原生图谱 —— loader 绝不能留在屏幕上（它盖在原生画布上）
        overlay.hideLoader();
        loaderArmed = false;
        stopLoop();
      } else { dirty = true; startLoop(); }
      // 手动切回来即视为视图归属已定，别再让 frame() 去重复交接一次
      if (!nativeMode) { tookOver = true; loaderArmed = false; }
      syncToolbar();
      emitter.emit('nativemode', nativeMode);
    }

    // 置脏必须同时确保循环在跑
    function markDirty() {
      dirty = true;
      // 确保循环在跑
      wake();
    }

    // 主循环
    function frame(now) {
      if (!running) return;
      rafId = GFI.topWin.requestAnimationFrame(frame);

      try {
        const raw = Math.max(0, now - lastTime);
        const stalled = raw > Math.max(STALL_MIN_MS, medianFrameTime() * STALL_FACTOR);
        const elapsed = stalled ? DT * 1000 : Math.min(cfg.runtime.maxFrameMs, raw);
        lastTime = now;
        acc += elapsed;
        frameCount++;

        //  canvas 尺寸维护 
        if (frameCount % cfg.runtime.degenerateCheckEvery === 0) {
          const m = overlay.measure();
          if (m.w !== cssW || m.h !== cssH) {
            cssW = m.w; cssH = m.h;
            // 设备像素比
            const dpr = Math.min(GFI.topWin.devicePixelRatio || 1, cfg.render.maxDpr);
            cam.resize(cssW, cssH);
            renderer.resize(cssW, cssH, dpr);
            markDirty();
          }
          if (!overlay.canvas.isConnected) { destroy('overlay detached'); return; }
          // 主题变化查询
          if (frameCount % (cfg.runtime.degenerateCheckEvery * 4) === 0) {
            const bg = overlay.readBackground();
            if (bg !== renderer.bgColor) renderer.setBackground(bg);
          }
        }

        // 模拟子步
        let substeps = 0;
        const maxSub = cfg.runtime.maxSubsteps;
        while (acc >= DT && substeps < maxSub) {
          const awake = P.sim.isAwake();
          if (awake) P.sim.tick(DT);
          if (P.timeline) P.timeline.update(DT);
          acc -= DT;
          substeps++;
        }

        // 每渲染帧淡入淡出特效
        P.fx.update(Math.min(cfg.runtime.maxFrameMs, Math.max(0, elapsed)) / 1000);

        if (substeps >= maxSub) acc = 0;

        // 拖拽重建网格
        if (!P.sim.isAwake() && P.inter && P.inter.dragNode >= 0) P.sim.rebuildGrid();

        // 视野缓动
        stepCamAnim(elapsed / 1000);

        // 沉降后自动适配视野
        if (!instantReveal && autoFitPending && !P.sim.isAwake() && !(P.inter && P.inter.interacted)) {
          autoFitPending = false;
          const b = GFI.Data.bounds(P.D, true);
          // 差异明显时改动相机
          const curW = cam.W / cam.k, curH = cam.H / cam.k;
          const wantW = Math.max(1, b.maxX - b.minX), wantH = Math.max(1, b.maxY - b.minY);
          if (Math.abs(curW - wantW) / wantW > 0.25 || Math.abs(curH - wantH) / wantH > 0.25) {
            // 缓动
            animateFitTo(b, cfg.camera.fitAnimMs);
          }
        }

        // 图谱显现时的一次淡入
        let visualAlpha = 1;
        if (revealAnim) {
          revealAnim.t += elapsed / 1000;
          let rp = revealAnim.t / revealAnim.dur;
          if (!(rp < 1)) rp = 1;
          visualAlpha = 1 - Math.pow(1 - rp, 3);        // ease-out cubic
          if (rp >= 1) revealAnim = null;
          markDirty();                                  // 保持循环
        }
        if (visualAlpha !== lastVisualAlpha) {
          lastVisualAlpha = visualAlpha;
          overlay.canvas.style.opacity = visualAlpha >= 1 ? '' : String(visualAlpha.toFixed(3));
        }

        // 标签随相机缩放连续淡变
        const k = cam.k;
        const rc = cfg.render;
        const showK = fitK > 0 ? fitK * rc.labelShowScaleRatio : rc.labelFallbackShow;
        const hideK = fitK > 0 ? fitK * rc.labelHideScaleRatio : rc.labelFallbackHide;
        // k 在 [hideK, showK] 之间线性映射 0→1
        const t = (k - hideK) / Math.max(1e-9, showK - hideK);
        const want = t <= 0 ? 0 : (t >= 1 ? 1 : t);

        labelFade = instantReveal ? want : labelFade + (want - labelFade) * Math.min(1, elapsed * 0.011);
        if (labelFade < 0.001) labelFade = 0;
        else if (labelFade > 0.999) labelFade = 1;
        // labelsOn 与实际 alpha一致
        labelsOn = labelFade > 0;

        // 绘制 
        const stats = renderer.render({
          hoverIdx: P.inter ? P.inter.hoverIdx : -1,
          selectedIdx: P.inter ? P.inter.selectedIdx : -1,
          lod: lodLevel,
          labelsOn,
          labelFade,
        });
        lastStats = stats;

        // 避免loader已收但画面还没出的一帧空白
        if (loaderArmed) {
          completeTakeover(revealDurMs > 0 ? `首帧（沉降布局 + ${revealDurMs}ms 淡入）` : '首帧（沉降布局，无淡入）');
          markDirty();
        }

        // 测帧耗时
        pushFrameTime(elapsed);

        // lod档更新
        updateLod();

        // 物理醒着、特效在跑、时间轴在播、用户平移、或 dirty为真，这帧要画
        const busy = P.sim.isAwake() || P.fx.anyActive() ||
          (P.timeline && P.timeline.playing) ||
          (P.inter && (P.inter.dragNode >= 0 || P.inter.panning)) ||
          dirty;
        // 静止帧累计
        if (busy) { idleFrames = 0; dirty = false; }
        else if (++idleFrames > cfg.runtime.idleFrames) {
          stopLoop();
        }
      } catch (err) {
        if (++errorCount > 3) {
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

    // 公开 API
    const api = {
      get data() { return P.D; },
      get sim() { return P.sim; },
      get camera() { return cam; },
      get timeline() { return P.timeline; },
      get stats() { return lastStats; },
      get lod() { return lodLevel; },
      get root() { return root; },
      /** 当前生效的适配内边距（CSS px）。按视口尺寸自适应，见 fitPad() */
      get fitPadding() { return fitPad(); },
      /** 渲染层是否还挂在 DOM 上。React 重渲染会清掉我们的容器，而 root 仍然连着。 */
      get alive() { return !!(overlay && overlay.alive); },
      overlay, toolbar,

      /**
       * 全量替换数据。位置会按 id 继承，图谱不会整个跳回随机位置。
       *
       * @param {Array} nodes
       * @param {Array} links
       * @param {object} [o]
       *        layout:Map<string,{x,y}>  沉降布局（GFI.Warm 产物）
       *        reveal:boolean            显现时要不要淡入
       *
       * 给了 layout 且全部命中，这一帧画出来的就是【最终布局】，于是：
       *   · 不需要"沉降后再适配一次视野"（那正是用户看到的第③段）
       *   · 模拟被按到睡着，画面静止 —— 也就不存在"再摊开一次"
       *
       * reveal 为什么要分：布局可能来自两条不同的路。
       *   · 后台预热缓存命中 → 用户是【重新打开】图谱，画面应该一模一样地
       *     立刻出现，再来一次淡入反而像是"又加载了一遍"。
       *   · 刚在 loader 后面同步跑完沉降 → 用户是【第一次】打开，从空白直接
       *     跳到满屏 500 个点太生硬，一次 0.3 秒的淡入刚好。
       */
      setData(nodes, links, o) {
        o = o || {};
        const prevD = P.D;
        const layout = o.layout || null;
        // 拆掉旧管线：旧渲染器持有精灵缓存与测量缓存，不回收会累积泄漏
        if (P.inter) P.inter.destroy();
        if (P.fx) P.fx.destroy();
        if (P.renderer) P.renderer.destroy();
        P = createPipeline(overlay, cam, nodes, links, prevD, layout);
        renderer = P.renderer;
        renderer.setGrid(P.sim.grid);
        renderer.setBackground(overlay.readBackground());
        const dpr = Math.min(GFI.topWin.devicePixelRatio || 1, cfg.render.maxDpr);
        renderer.resize(cssW, cssH, dpr);
        renderer.setGrid(P.sim.grid);
        attachInteraction();
        attachTimeline();

        // 吃到沉降布局的判据是【全部节点都命中】。部分命中（用户刚新建了页面、
        // 缓存还没刷新）说明库已经变了，那时按老路径即时沉降才对 —— 用一半
        // 沉降坐标 + 一半种子螺旋拼出来的图既不是最终形态也不平滑。
        const adopted = P.D.adopted || 0;
        const warm = !!layout && P.D.n > 0 && adopted === P.D.n;

        if (!warm && adopted > 0) {
          console.warn(`[GFI] 沉降布局只命中 ${adopted}/${P.D.n} 个节点 —— 库已变化，本次按即时沉降走`);
        }

        instantReveal = warm;
        revealAnim = null;
        revealDurMs = 0;
        lastVisualAlpha = 1;
        overlay.canvas.style.opacity = '';
        if (warm) {
          // 按到"刚睡着"：alpha = alphaMin，速度与受力清零。
          P.sim.reset();
          // ⚠ 网格必须手动补一次。睡眠期没有 tick，而 tick 内部才会 chargeGrid.build
          //   —— 不补的话渲染剔除（renderer 用 sim.grid）和命中测试全都查不到任何
          //   节点，画面是一片空白。
          P.sim.rebuildGrid();
          // ⚠ 这里【必须】是 false。warm 路径下相机是在最终布局上 fit 的，一次
          //   到位；再挂一个 autoFitPending 就等于用户说的"接着才适配视角"。
          autoFitPending = false;

          if (o.reveal) {
            const ms = (cfg.warm && cfg.warm.revealAnimMs) || 0;
            if (ms > 0) { revealAnim = { t: 0, dur: ms / 1000 }; revealDurMs = ms; }
          }
        } else {
          autoFitPending = true;      // 等沉降完再精确适配一次
          P.sim.reheat(cfg.reheat.dataChange);
        }

        fitView();                    // warm 时这一步已是在最终布局上算的 → 一步到位
        GFI.Overlay.record('数据装载', warm
          ? `沉降布局命中 ${adopted}/${P.D.n}（一步到位${o.reveal ? '，显现淡入' : '，无缓动'}）`
          : `${P.D.n} 节点（即时沉降，adopted=${adopted}）`);
        startLoop();
        loaderArmed = true;
        return { warm, adopted, n: P.D.n };
      },

      setCutoff(ms) {
        if (!P.timeline) return;
        P.timeline.setCutoff(ms);
        syncToolbar();
      },

      fitView,
      /** 带缓动的适配视野（工具栏那个按钮用的就是它） */
      fitViewAnimated,

      snapshot(opts) { return snapshot(opts); },
      /**
       * 实时调整外观（不用重载插件）。
       * 用法：__GFI__.setRender({ edgeColor: 'rgba(255,255,255,0.6)' })
       * 调好后把值告诉我，我写进 config.js 的默认值。
       */
      setRender(partial) {
        if (!partial) return cfg.render;
        // radius 相关参数是在 Data.build 里烘进 D.radius 的 —— 光改配置不生效，
        // 必须重建管线。顺手代劳，省得调参时还要记得手动 rebuild。
        const needRebuild = partial.nodeSize !== undefined ||
          partial.radiusBase !== undefined || partial.radiusScale !== undefined ||
          partial.radiusMin !== undefined || partial.radiusMax !== undefined;
        for (const k in partial) {
          if (k === 'palette') Object.assign(cfg.render.palette, partial.palette);
          else cfg.render[k] = partial[k];
        }
        if (renderer && renderer.invalidateSprites) renderer.invalidateSprites();
        markDirty();
        if (needRebuild && GFI.rebuild) GFI.rebuild();
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

    // 销毁 
    let destroyed = false;
    function destroy(reason) {
      if (destroyed) return;
      destroyed = true;
      running = false;
      stopLoop();
      try { listeners.removeAll(); } catch (e) { }
      try { if (P.inter) P.inter.destroy(); } catch (e) { }
      try { if (P.fx) P.fx.destroy(); } catch (e) { }
      try { if (P.renderer) P.renderer.destroy(); } catch (e) { }
      try { toolbar.destroy(); } catch (e) { }
      try { overlay.unmount(); } catch (e) { }
      emitter.clear();
      // 非主实例挂在自己 root 上的那句 `__gfiApi` 也要摘掉 —— 留着会指向一个
      // 已经 destroy 的 api，调试时看着像"还活着"，一调就报错。
      if (root.__gfiApi === api) { try { delete root.__gfiApi; } catch (e) { } }
      if (instances.get(root) === api) instances.delete(root);
      // ⚠ 只有主实例才允许摘掉 __GFI__。侧边栏那个实例拆掉时把它删了，
      //   全屏图谱的控制台入口就凭空消失了（而它还在正常工作）。
      if (primary === api) {
        primary = null;
        try { delete GFI.topWin.__GFI__; } catch (e) { }
      }
      console.log('[GFI] destroyed', reason || '');
    }

    instances.set(root, api);
    // 第一个挂上的实例默认成为主实例；侧边栏控制器会显式传 primary:false。
    if (opts.primary !== false && !primary) primary = api;

    // 启动 
    if (nativeMode) {
      overlay.setNativeVisible(true);
      overlay.hideLoader();
      syncToolbar();
    } else if (deferTakeover) {
      overlay.setNativeVisible(true);
      overlay.hideLoader();
      fitView();
      startLoop();
    } else {
      overlay.setNativeVisible(false);
      fitView();
      startLoop();
    }
    syncToolbar();

    // 一键诊断
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
        // 交接状态。期望看到：延迟交接=false、已交接=true、待交接=false。
        // 待交接=true 只在「数据正在路上」那一小段里成立 —— 那时画布上还没有
        // 内容，loader 亮着。
        交接: {
          延迟交接: deferTakeover, 已交接: tookOver, 待交接: loaderArmed,
          加载指示: overlay.loaderVisible, 一步到位: instantReveal,
        },
        尺寸: { cssW, cssH, dpr: renderer.dpr, canvasAttr: overlay.canvas.width + '×' + overlay.canvas.height },
        相机: { x: Math.round(cam.x), y: Math.round(cam.y), k: +cam.k.toFixed(4) },
        数据: { n: P.D.n, m: P.D.m, 采用预热坐标: P.D.adopted || 0, 可见: (() => { let c = 0; for (let i = 0; i < P.D.n; i++) if (P.D.visible[i]) c++; return c; })() },
        交互: P.inter ? {
          hover: P.inter.hoverIdx, selected: P.inter.selectedIdx,
          dragging: P.inter.dragNode, panning: P.inter.panning,
          interacted: P.inter.interacted,
        } : null,
        自动适配: { pending: autoFitPending, fitK: +fitK.toFixed(4) },
        显现: { 淡入中: !!revealAnim, 本帧淡入时长ms: revealDurMs, canvas_opacity: overlay.canvas.style.opacity || '1' },
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

      // 致命问题 
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
      if (lastStats && lastStats.nodes === 0 && out.数据.n > 0 && out.数据.可见 > 0) {
        problems.push('视口剔除后节点数为 0 —— 相机可能没对准图谱');
      }
      if (out.交接.加载指示 && out.数据.n > 0 && !out.交接.待交接) {
        problems.push('loader 还亮着但数据已经装载 —— 交接没走到，画面会停在加载态');
      }
      if (out.交接.加载指示 && out.数据.n === 0) {
        notes.push('loader 亮着且数据为空 —— 数据还在路上（正常情况下只有几百毫秒）');
      }

      // 非致命说明 
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

    // 时间轴内省 —— 排查"按播放没反应"用这个
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
        有时间戳节点: tl.pacedCount,
        设定节奏_每秒: GFI.config.timeline.revealRate,
        诞生速率_每秒: tl.rate ? +tl.rate.toFixed(2) : 0,
        实际全程秒: tl.playDurationSec ? +tl.playDurationSec.toFixed(1) : 0,
        全程提示: tl.playDurationSec > 180
          ? `全程 ${(tl.playDurationSec / 60).toFixed(1)} 分钟 —— 嫌久就把「演变节奏」调大（当前 ${GFI.config.timeline.revealRate}/秒）`
          : undefined,
        单次出生动画秒: P.fx && P.fx.popDuration ? +P.fx.popDuration().toFixed(3) : 0,
        同时出生动画数: (P.fx && P.fx.popDuration && tl.rate)
          ? +(tl.rate * P.fx.popDuration()).toFixed(2) : 0,
        游标rank: tl.rank ? +tl.rank.toFixed(1) : 0,
        待揭示队列: (() => { let c = 0; for (let i = 0; i < P.D.n; i++) if (P.D.wantVisible[i] && !P.D.visible[i]) c++; return c; })(),
        可见: vis, 目标可见: want, 淡出中: fading, 弹出中: popping, 总节点: P.D.n,
      };
      console.log('%c[GFI] 时间轴状态 ' + JSON.stringify(out, null, 2), 'color:#0aa;font-family:monospace');
      if (!r) {
        console.error('%c✘ tl.range 为 null —— setPlaying() 会直接 return，播放完全不会启动。' +
          '原因通常是所有节点的 createdAt 完全相同，或全部缺失。', 'color:#c00;font-weight:bold');
      }
      return out;
    }

    // 布局分布 dump 
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

      // 纯文本输出
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

      // 全量清单 
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
        console.warn(`%c 最大/中位距离比 = ${ratio.toFixed(1)} —— 有极端离群点把视野撑爆了，看上面「最远的 15 个」`,
          'color:#c00;font-weight:bold');
      }
      if (summary.包围盒.宽 > summary.相机可见世界宽度 * 3) {
        console.warn('%c 图谱宽度是相机可见宽度的 3 倍以上 —— 视野没对准（自动适配应该会修好）',
          'color:#c00;font-weight:bold');
      }
      return { summary, far, byDeg };
    }

    // 精简调试入口 —— 只由【主实例】发布。
    // ⚠ 侧边栏那个实例也走这段的话，两边的 api 闭包会互相覆盖同一个 __GFI__，
    //   后挂上的那块面板说了算 —— 于是"刚打开侧边栏图谱，全屏图谱的控制台
    //   入口就指向了侧边栏那份数据"。要摸侧边栏那份用 __GFI__.graphs()。
    try {
      if (api === primary) GFI.topWin.__GFI__ = {
        version: GFI.VERSION,
        graph: api,
        /** 当前所有活着的图谱实例（[0] 是全屏，其余是侧边栏面板） */
        graphs: () => [...instances.values()],
        diag,
        dump,
        tlState,
        setRender: (p) => api.setRender(p),
        play: () => P.timeline && P.timeline.setPlaying(true),
        pause: () => P.timeline && P.timeline.setPlaying(false),
        /** 改过滤规则后重新拉数据，不用重载插件 */
        reload: () => (GFI.reloadData ? GFI.reloadData() : null),
        /** 改完布局参数（斥力 / 线长 / 节点大小）后就地重建 —— 不查库，位置按 id 继承 */
        rebuild: () => (GFI.rebuild ? GFI.rebuild() : null),
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
        fit: () => api.fitView(),
        setLod: (n) => api.setLod(n),
        native: (b) => api.setNativeMode(b),
        demo: (n) => { const d = GFI.DataSource.demo(n || 400, {}); api.setData(d.nodes, d.links); },
        timeline: () => GFI.Overlay.printEvents(),
        timelineClear: () => GFI.Overlay.clearEvents(),
        // 布局预热 
        warm: () => (GFI.Warm ? GFI.Warm.state() : null),
        prewarm: () => (GFI.Warm ? GFI.Warm.prewarm({
          source: (cfg.runtime || {}).dataSource, demoCount: (cfg.runtime || {}).demoCount,
          log: (m) => console.log('[GFI]', m),
        }) : null),
        unwarm: () => { if (GFI.Warm) GFI.Warm.invalidate('__GFI__.unwarm()'); return true; },
        /** 侧边栏页面图谱的接管开关，如 __GFI__.sidebar(false) 退回原生 */
        sidebar: (on) => (GFI.setSidebarEnabled ? GFI.setSidebarEnabled(on) : null),
        /** 侧边栏视野留白（每边 CSS px），如 __GFI__.sidebarFit(64)。完整入口见 __GFI_SIDEBAR__ */
        sidebarFit: (px) => (GFI.setSidebarFitPadding ? GFI.setSidebarFitPadding(px) : null),
      };
      // 非主实例（侧边栏面板）把 api 挂在自己的 root 元素上 —— 否则它就是一坨
      // 只能通过 __GFI__.graphs() 摸到的东西，调试时找不到抓手。
      else root.__gfiApi = api;
    } catch (e) { }

    return api;
  }

  // 标定助手
  GFI.calibrate = function calibrate() {
    const api = primary;
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
    if (ratio < 1.2) console.log('%c→ p50 边长偏短，把 charge 调小一点或 linkDistance 调大', 'color:#c80');
    else if (ratio > 1.6) console.log('%c→ p50 边长偏长，把 charge 调大', 'color:#c80');
    else console.log('%c✔ p50 边长落在 1.2~1.6 X linkDistance,达标', 'color:#0a0');
    return { ...s, frame: st };
  };

  GFI.getGraph = () => primary;
  /** 侧边栏那块页面图谱的实例（没挂就是 null） */
  GFI.getSidebarGraph = () => {
    const root = GFI.Overlay.findPageGraphRoot && GFI.Overlay.findPageGraphRoot();
    return root ? (instances.get(root) || null) : null;
  };

  /**
   * 调侧边栏那块的视野留白：`__GFI_SIDEBAR__.fit(64)`
   *
   * 留白是纯观感参数，只能靠眼睛定 —— 所以给的是一条"改完立刻看到"的通路，
   * 而不是"改 config.js → 重载插件 → 再看"那种一轮几十秒的循环。
   * `fitPad()` 每次适配时【现读】这个值，所以不用重挂实例。
   *
   * ⚠ 放在 main.js 而不是 index.js：它只依赖 config 和 getSidebarGraph，
   *   留在这里才能被无头测试直接调到（index.js 在测试里跑不起来）。
   *
   * @param {number} px 每边留白（CSS px）。不传 = 只查询当前值
   * @returns {number} 当前设置的留白
   */
  GFI.setSidebarFitPadding = function setSidebarFitPadding(px) {
    const side = GFI.config.sidebar = GFI.config.sidebar || {};
    if (px === undefined || px === null || px === '') return side.fitPadding;
    const v = Number(px);
    if (!Number.isFinite(v) || v <= 0) {
      console.warn(`[GFI] 留白要是正数（收到 ${JSON.stringify(px)}），本次忽略`);
      return side.fitPadding;
    }
    side.fitPadding = v;
    const api = GFI.getSidebarGraph();
    if (!api || !api.alive) {
      console.log(`[GFI] 侧边栏留白 → 每边 ${v}px（侧边栏图谱当前没开，下次打开时生效）`);
      return v;
    }
    if (api.fitViewAnimated) api.fitViewAnimated();      // 立刻能看到效果
    // ⚠ 报的是【实际生效值】而不是刚设进去的值 —— 它会被
    //   `clamp(…, 10, 面板短边 × 0.45)` 兜底；调太大时两个数不一样，
    //   只报后者会让人以为"设了没反应"。
    const panel = api.overlay && api.overlay.measure ? api.overlay.measure() : null;
    console.log(`[GFI] 侧边栏留白 → 设置 ${v}px，实际生效 ${api.fitPadding}px`
      + (panel ? `（面板 ${panel.w}×${panel.h}，绘图区 ${panel.w - 2 * api.fitPadding}×${panel.h - 2 * api.fitPadding}）` : '')
      + '。满意后把 config.sidebar.fitPadding 写成这个值。');
    return v;
  };

  GFI.Main = {
    boot,
    get instance() { return primary; },
    get graphs() { return [...instances.values()]; },
  };
})(window.GFI);
