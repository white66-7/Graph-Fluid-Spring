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

  function createPipeline(overlay, cam, nodes, links, prevD, layout) {
    const D = GFI.Data.build(nodes, links, prevD, layout);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);
    const renderer = GFI.Renderer.create(overlay.canvas, D, cam);
    renderer.setGrid(sim.grid);

    let inter = null;
    let timeline = null;

    return { D, sim, fx, renderer,
             get inter() { return inter; }, set inter(v) { inter = v; },
             get timeline() { return timeline; }, set timeline(v) { timeline = v; } };
  }

  function boot(opts) {
    opts = opts || {};
    if (instance) return instance;

    const cfg = GFI.config;
    const root = GFI.Overlay.findRoot();
    if (!root) return null;

    let nativeMode = !!cfg.useNativeGraph;

    // ---- 挂载即接管 ----
    // 一挂上就把原生画布藏掉。这是"点进去就是我的样式"的前提：只要原生图谱
    // 还显示着，用户必然先看到它。
    // 代价是"数据到达前画布是空的"，用 .gfi-loader 顶上（而不是让原生图谱顶）。
    const deferTakeover = false;
    const overlay = GFI.Overlay.mount(root, { nativeVisible: deferTakeover });
    if (!overlay) return null;

    GFI.Overlay.record('overlay 挂载完成',
      deferTakeover ? '（原生图谱继续显示）' : '（原生图谱已隐藏，等待数据）');
    if (!deferTakeover) overlay.showLoader();

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
    let labelFade = 0;              // 🌟 L3：标签层全局 alpha 补间（0..1）
    let lodLevel = 1;
    let lodForced = -1;
    let lastStats = null;
    // 本次数据装载是不是「一步到位」的（吃到了沉降布局）。
    // 为 true 时关掉所有相机缓动、并让标签层直接以终值出现 —— 见 setData。
    let instantReveal = false;
    // 当前这一轮显现淡入的总时长（ms，>0 表示淡入真的在跑）。
    // ⚠ 不能用 instantReveal 代替它：instantReveal 说的是"布局是沉降好的"，
    //   而"有没有淡入"取决于调用方传的 reveal（缓存命中时不淡入）。
    //   实机日志里就因为混用而把「首帧（预热布局，无缓动）」记成了一次带淡入的
    //   交接 —— 探针的措辞自相矛盾，排查时会被误导。
    let revealDurMs = 0;

    // ---- 交接状态（见 setData / frame / setNativeMode 三处）----
    // boot() 是在【数据还没到】的时候挂载的，而容器已经在显示、原生图谱已经被
    // 藏掉（见上面的 "挂载即接管"）。所以真正要等的是：【我们画出第一帧有内容
    // 的画面】，那一刻才把 loader 收掉 —— 一次 rAF 都不能插在中间。
    //
    // ⚠ 这里是两个【不同】的概念，混成一个就会出 bug：
    //   tookOver    —— 视图归属：原生图谱是不是已经归我们了。挂载那一刻（原生
    //                  被藏掉）就成立，因为画面已经归我们了。
    //   loaderArmed —— 首帧待交接：画布上还没有内容、loader 正亮着，等第一帧
    //                  有内容的画面画完再收。setData 时置位，frame 里完成。
    //   曾经写成 tookOver 兼任两者，于是 setData 那句 `if (!tookOver)` 永远为假
    //   → 交接永不执行 → loader 一直转（被 test/smoke-boot.js 抓到）。
    // 老路径（deferTakeover = true）的观感是三段：原生图谱 → 我们的画布（种子
    // 螺旋）→ 缓动适配视野。开关现在是常量 false，见文件上方挂载处的说明。
    let tookOver = !deferTakeover || nativeMode;
    let loaderArmed = false;

    // 视野缓动状态（实现见 fitView 下方的 animateFitTo / stepCamAnim）。
    // ⚠ 声明必须放在这里、而不是和那几个函数挨着：attachInteraction() 在我们
    //   定义它们【之前】就跑了，而那些 hook 闭包会引用这个变量 —— 放后面虽然
    //   靠"调用时机晚于声明"侥幸能work，但一次重排就会变成 TDZ 报错。
    let camAnim = null;

    // 图谱显现时的一次淡入（见 setData 的 reveal 参数）。
    // ⚠ 刻意【不放进 camera.js】：那个模块有一条结构性约束 —— 不暴露任何动画
    //   方法，好让"激波"和"缩放"不可能被混淆。而且这个动画只改 canvas 的 CSS
    //   opacity，它【不动相机】—— 相机的 fit 已经在 setData 里一次算完了。
    let revealAnim = null;
    let lastVisualAlpha = 1;      // 只在变化时写 style，避免每帧碰 DOM

    // 数据加载后自动重新适配一次视野。
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

      // ⚠ 这两行必须留在【所有早退路径之外】。
      //   原先它们排在两个 early return 后面，于是「手动锁档」(__GFI__.setLod)
      //   以及「采样窗口还没填满的头 30 帧」，sim.lod 都停在初始值 ——
      //   降档那套「隔 tick 跑斥力 / 跳过碰撞 / 跳过孤立节点斥力」全部不生效，
      //   锁档等于按了没反应的按钮。
      if (P.fx && P.fx.setPulsesEnabled) P.fx.setPulsesEnabled(lodCfg.levels[lodLevel].pulses);
      P.sim.lod = lodLevel;
    }

    // ---- 尺寸 ----
    let cssW = 1, cssH = 1;

    // ⚠ 这里【必须】同步量一次，不能只靠 ResizeObserver。
    //
    //   实测（test/smoke-boot.js）：boot 期间 cam 的 W/H 一直是 Camera.create(1,1)
    //   那个默认值，直到 setData 才被修正。原因是 overlay.onResize 的注册发生在
    //   boot 后半段（见下面），而 boot 开头那次 fitView() 是按默认值算的 ——
    //   于是"首帧视野"是错的，要靠 setData 里那次 fitView 再纠正一遍。
    //   同步量掉之后 fitView 第一次就是对的，`api.fitPadding` 这类依赖视口尺寸的
    //   计算也不会在首帧拿到错值。
    const m0 = overlay.measure();
    cssW = Math.max(1, m0.w | 0);
    cssH = Math.max(1, m0.h | 0);
    cam.resize(cssW, cssH);

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
      onFit() { fitViewAnimated(); },
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

    /**
     * 适配视野时的内边距（CSS px），按视口尺寸自适应。
     *
     * 实机数据（2026-10）：用户的图画布只有 **708 × 243**（图谱挂在侧栏里），
     * 而 config.camera.fitPadding 是 72 —— 两边各 72，可视绘图区只剩 564 × 99！
     * 结果图谱被压成"又小又挤"的一条，还会让 fitK 偏小、顺带把标签阈值带偏。
     *
     * 所以把它当成【上限】：小视口按 6% 缩，并且至少留 10px。
     * 243 高的窗口 → 14px；800 高的窗口 → 48px；≥1200 才用满 72。
     */
    const FIT_PAD_LIMIT = 10;      // 两侧加起来最少要留的空间
    function fitPad() {
      const want = cfg.camera.fitPadding;
      const bySize = Math.min(cam.W, cam.H) * 0.06;
      return clamp(bySize, FIT_PAD_LIMIT, want);
    }

    function fitView() {
      const b = GFI.Data.bounds(P.D, true);
      cam.fitBounds(b, fitPad());
      fitK = cam.k;
      markDirty();
    }

    // ---- 视野缓动 ----
    // 为什么需要：setData 时的 fitView 是在【种子布局】上算的，模拟沉降完图谱
    // 会大一圈（实测包围盒差 40%+），所以这里要再适配一次。瞬变会让整个画面
    // "啪"地跳一下 —— 缓动就没这个问题。
    //
    // ⚠ 刻意【不放进 camera.js】：那个模块有一条结构性约束 —— 不暴露任何动画
    //   方法，好让"激波"和"缩放"在 API 层面不可能被混淆（激波必须往模拟里注入
    //   速度，绝不能靠改相机伪装）。相机动画一旦进了那个模块，这条约束就破了。
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
      markDirty();                                       // 保持循环活着（busy 含 dirty）
    }

    /** 用户一动相机就放弃缓动 —— 不跟人抢镜头 */
    function cancelCamAnim() { camAnim = null; }

    /**
     * 交接：把 loader 收掉，画面正式交给我们的画布。
     *
     * ⚠ 只允许在【本帧已经画完】之后调用（frame 里的 loaderArmed 分支，或
     *   setNativeMode 这种明确知道原生要回来的场合）。提前调 = 露一帧空白。
     */
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

    // 置脏必须同时确保循环在跑。
    // 否则会出现这种状态：循环因空闲停掉了 → 某个操作置了脏标志并（可能）重热了模拟
    // → 但没有任何人在跑 rAF 去看那个标志 → 画面冻住，而且 alpha 永远停在重热值上
    // （因为没有 tick 去衰减它）。之前 resize 就是这么把图谱冻住的。
    function markDirty() {
      dirty = true;
      wake();
    }

    // 主循环
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
          if (P.timeline) P.timeline.update(DT, vhWorld);
          acc -= DT;
          substeps++;
        }

        // 🌟 特效推进必须是【每渲染帧一次】，不能放在上面的物理子步循环里。
        //
        //   为什么：Obsidian 的节点淡入是 `fadeAlpha = uZ(fadeAlpha, 1)` —— 每【渲染帧】
        //   一次（在 rAF 的 renderCallback 里）。我们原先按【物理子步】推：
        //     · 高刷屏（120Hz）：elapsed 8.3ms < DT，一半的帧一个子步都没有，
        //       淡入直接停顿 → 一卡一卡地出现；
        //     · 掉帧（33ms）：一帧跑 2 个子步，alpha 连跳两级 → 一次跳 +0.29。
        //   实测这个"跳"就是「节点出现得突然」的来源之一（见 test/…probe）。
        //   传真实 elapsed 而不是 DT，弹簧/淡出/激波那几条【本来就是 dt 累计】的
        //   路径行为不变；只有 Obsidian 淡入这条（按调用次数递推）被修正为每帧一步。
        P.fx.update(Math.min(cfg.runtime.maxFrameMs, Math.max(0, elapsed)) / 1000);
  
        if (substeps >= maxSub) acc = 0;

        // 模拟睡着时 chargeGrid 不会自己重建，而拖拽是【唯一】在睡眠状态下直接写
        // 节点坐标的路径：sim.pin() 是同步写 x/y 的，且零度节点刻意不 reheat、
        // 不抬 alphaTarget（见 interaction.js onPointerDown）→ 模拟全程睡着。
        // 剔除（renderer.setGrid(sim.grid)）与命中测试都复用这张网格，不补这一下
        // 的话，被拖的节点会以【入睡时的旧位置】参与剔除 —— 拖出余量后就地消失、
        // 也点不中。只在拖拽进行中补，每帧一次 O(n)，睡眠期间零成本。
        if (!P.sim.isAwake() && P.inter && P.inter.dragNode >= 0) P.sim.rebuildGrid();

        // ---- 视野缓动（每帧一次，不是每 substep —— 它是时间驱动的）----
        stepCamAnim(elapsed / 1000);

        // ---- 沉降后自动适配视野（见 autoFitPending 的说明）----
        // ⚠ instantReveal 时整段跳过：吃到预热布局的那一次装载，setData 里的
        //   fitView 已经是在【最终布局】上算的，再"补一次缓动"就是用户抱怨的
        //   第③段（"接着才视角适配"）。
        if (!instantReveal && autoFitPending && !P.sim.isAwake() && !(P.inter && P.inter.interacted)) {
          autoFitPending = false;
          const b = GFI.Data.bounds(P.D, true);
          // 只有在差异明显时才动相机，避免连续的微调抖动
          const curW = cam.W / cam.k, curH = cam.H / cam.k;
          const wantW = Math.max(1, b.maxX - b.minX), wantH = Math.max(1, b.maxY - b.minY);
          if (Math.abs(curW - wantW) / wantW > 0.25 || Math.abs(curH - wantH) / wantH > 0.25) {
            // 缓动而不是瞬变 —— 种子布局到沉降完的图谱包围盒差 40%+，
            // 瞬变就是整个画面"啪"地跳一下
            animateFitTo(b, cfg.camera.fitAnimMs);
          }
        }

        // ---- 视觉层 alpha（含"从加载态显现"的一次淡入）----
        // ⚠ 走 canvas 的 CSS opacity，不碰 renderer。
        //   为什么：渲染器里 ctx.globalAlpha 有 13 处赋值（边按 alpha 分桶、
        //   辉光按增益、节点按 renderAlpha...），要"整体乘一个系数"就得改那 13 处，
        //   而且任何一个漏掉都会在淡入时露出来。CSS opacity 是一次性、整层的，
        //   且只在首帧后那 0.3 秒里非 1 —— 代价（多一层合成）可以忽略。
        //   这也是【唯一】让 warm 路径动起来的东西：相机不在其中，它的 fit 在
        //   setData 里一次算完，所以不存在"接着才适配视角"。
        let visualAlpha = 1;
        if (revealAnim) {
          revealAnim.t += elapsed / 1000;
          let rp = revealAnim.t / revealAnim.dur;
          if (!(rp < 1)) rp = 1;
          visualAlpha = 1 - Math.pow(1 - rp, 3);        // ease-out cubic
          if (rp >= 1) revealAnim = null;
          markDirty();                                  // 保持循环活着（busy 含 dirty）
        }
        if (visualAlpha !== lastVisualAlpha) {
          lastVisualAlpha = visualAlpha;
          overlay.canvas.style.opacity = visualAlpha >= 1 ? '' : String(visualAlpha.toFixed(3));
        }

        // ---- 标签显隐 —— 🌟 随缩放【连续】淡变（Obsidian 的 text fade threshold）----
        //
        // 原来是二元滞回（k ≥ showK 整层开 / k < hideK 整层关）再叠一层时间补间。
        // 但 `render.labelYield = false`（默认，Obsidian 行为）关掉了标签之间的重叠
        // 让位之后，缩放淡变就成了【唯一】的密度控制手段 —— 视口内节点一多，标签
        // 必然互相压住，只能靠「缩小就别读字」来取舍。
        // 所以改成随 k 连续过渡：缩小过程中标签是渐渐淡掉的，而不是到某一帧整层啪地消失。
        // 阈值仍相对于 fitView 缩放（fitK），换一张图不用重调。
        const k = cam.k;
        const rc = cfg.render;
        const showK = fitK > 0 ? fitK * rc.labelShowScaleRatio : rc.labelFallbackShow;
        const hideK = fitK > 0 ? fitK * rc.labelHideScaleRatio : rc.labelFallbackHide;
        // k 在 [hideK, showK] 之间线性映射 0→1，两端外截断
        const t = (k - hideK) / Math.max(1e-9, showK - hideK);
        const want = t <= 0 ? 0 : (t >= 1 ? 1 : t);

        // 🌟 L3：在连续目标之上再叠一层时间补间（~90ms/10%）——
        //   k 连续变化时它让淡变更顺；相机瞬变（fitView 跳转）时给出平滑过渡。
        //   ⚠ instantReveal 时直接取终值：那 90ms 的淡入正是"样式还在长出来"
        //     的那一点观感，而这一步的目标就是"点进去已经是最终样式"。
        labelFade = instantReveal ? want : labelFade + (want - labelFade) * Math.min(1, elapsed * 0.011);
        if (labelFade < 0.001) labelFade = 0;
        else if (labelFade > 0.999) labelFade = 1;
        // ⚠ labelsOn 必须与【实际 alpha】一致（而不是 want）：want 是个极小的正数时
        //   标签几乎不可见，却仍会让渲染层整层跑一遍 drawLabels（含精灵创建）。
        //   这也是 renderer 里「labelFade = 0 时整层跳过」那条断言的入口条件。
        labelsOn = labelFade > 0;

        // ---- 绘制 ----
        const stats = renderer.render({
          hoverIdx: P.inter ? P.inter.hoverIdx : -1,
          selectedIdx: P.inter ? P.inter.selectedIdx : -1,
          lod: lodLevel,
          labelsOn,
          labelFade,
        });
        lastStats = stats;

        // ---- 交接：这一帧已经画在画布上了，现在可以把 loader 收掉 ----
        // 必须是【同一帧内】完成，中间不能插一次 rAF，否则会出现
        // 「loader 已收 / 画面还没出」的那一帧空白。
        if (loaderArmed) {
          completeTakeover(revealDurMs > 0 ? `首帧（沉降布局 + ${revealDurMs}ms 淡入）` : '首帧（沉降布局，无淡入）');
          markDirty();
        }

        // LOD 采样必须用【真实帧间隔 elapsed】，不能用 GFI.util.now() - now。
        //   后者只量到主线程 JS 跑完为止，而 glow 的 drawImage 是纯 fill-rate 开销，
        //   光栅化在 raster / compositor 线程上 —— 主线程早在 GPU 出图之前就返回了。
        //   也就是说：最贵的那一环，主线程计时【看不见】。
        //   elapsed 还顺带覆盖了同帧内其他 rAF 回调（含宿主自己的）占用的时间。
        pushFrameTime(elapsed);
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
        // ⚠ canvas 元素是【复用】的（每次 setData 只换管线不换 DOM），所以
        //   上一次显现留下的 opacity 必须显式清掉 —— 否则重载数据后画面会一直
        //   停在半透明上（帧循环里那个"只在变化时写 style"的守卫会发现
        //   lastVisualAlpha 已经是 1 而跳过写入，DOM 就永远回不来）。
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
        // 数据已就位，安排交接：下一帧画完（那时画布上已经有内容了）再收起 loader。
        // ⚠ 判据【不是】tookOver —— 视图归属在挂载那一刻就定了，这里要问的是
        //   「loader 还亮着吗」。原生模式下 loader 是藏着的，这一句也不会把它翻出来
        //   （completeTakeover 只会 hideLoader）。
        loaderArmed = true;
        return { warm, adopted, n: P.D.n };
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
      /** 带缓动的适配视野（工具栏那个按钮用的就是它） */
      fitViewAnimated,

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
      // 用户显式选了原生图谱：原生本来就是主角，loader 绝不能亮
      overlay.setNativeVisible(true);
      overlay.hideLoader();
      syncToolbar();
    } else if (deferTakeover) {
      // 老路径：数据没到之前让原生图谱继续显示
      overlay.setNativeVisible(true);
      overlay.hideLoader();
      fitView();
      startLoop();
    } else {
      // 新路径：原生图谱在 mount 那一刻就藏掉了，loader 已经在显示。
      // boot 是在【数据还没到】的时候跑的，所以 setData 之前循环里画的是空画布
      // —— 那没关系，loader 盖在上面。
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
      // loader 只该在「数据还没到」的那一小段里亮。它一直亮着 = 数据装载失败，
      // 而原生图谱已经被我们藏掉了 —— 那就是一块空白，必须报出来。
      if (out.交接.加载指示 && out.数据.n > 0 && !out.交接.待交接) {
        problems.push('loader 还亮着但数据已经装载 —— 交接没走到，画面会停在加载态');
      }
      if (out.交接.加载指示 && out.数据.n === 0) {
        notes.push('loader 亮着且数据为空 —— 数据还在路上（正常情况下只有几百毫秒）');
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
        // 🌟 节奏（2026-10-07 按秩推进）——「全程多少秒」现在是算出来的，不是设定值
        有时间戳节点: tl.pacedCount,
        设定节奏_每秒: GFI.config.timeline.revealRate,
        诞生速率_每秒: tl.rate ? +tl.rate.toFixed(2) : 0,
        实际全程秒: tl.playDurationSec ? +tl.playDurationSec.toFixed(1) : 0,
        // 全程太久时给个可执行的提示（护栏已经全部删掉，节奏完全由用户定，
        // 所以这里只【说】不动手 —— 「演变节奏」就是那个旋钮）
        全程提示: tl.playDurationSec > 180
          ? `全程 ${(tl.playDurationSec / 60).toFixed(1)} 分钟 —— 嫌久就把「演变节奏」调大（当前 ${GFI.config.timeline.revealRate}/秒）`
          : undefined,
        // 「密度」的正确度量：同一时刻有几个节点正在做出生动画。
        //   速率 × 单次动画时长。调「演变节奏」或 pop.mode/maxDuration 都会动它。
        出生缓动模式: GFI.config.pop.mode,
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
        pulse: (o) => api.pulse(o),
        fit: () => api.fitView(),
        setLod: (n) => api.setLod(n),
        native: (b) => api.setNativeMode(b),
        demo: (n) => { const d = GFI.DataSource.demo(n || 400, {}); api.setData(d.nodes, d.links); },

        // ---- 进图谱时序 ----
        /** 打印「原生图谱 → 我们的画布 → 视角适配」三段的客观时间戳 */
        timeline: () => GFI.Overlay.printEvents(),
        timelineClear: () => GFI.Overlay.clearEvents(),

        // ---- 布局预热 ----
        /** 预热器状态：有没有现成的布局缓存、最近一次跑了多久多少 tick */
        warm: () => (GFI.Warm ? GFI.Warm.state() : null),
        /** 手动重跑一次预热（改完布局参数后想立刻验证"打开即最终形态"就用它） */
        prewarm: () => (GFI.Warm ? GFI.Warm.prewarm({
          source: (cfg.runtime||{}).dataSource, demoCount: (cfg.runtime||{}).demoCount,
          log: (m) => console.log('[GFI]', m),
        }) : null),
        /** 丢掉预热缓存（下次进图谱会即时沉降，用来做 A/B 对照） */
        unwarm: () => { if (GFI.Warm) GFI.Warm.invalidate('__GFI__.unwarm()'); return true; },
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
