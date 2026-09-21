/*
 * GFI.Overlay — 宿主 DOM 挂载 / 原生切换 / resize
 * ===========================================================================
 * 宿主结构（已从 Logseq 2.0.1 源码确认）：
 *
 *   div#global-graph.graph-root          overflow:hidden; z-index:4
 *     div.graph-a11y-panel
 *     div.graph-canvas                   flex:1; height:100%; z-index:1  ← PIXI canvas 在这
 *     div.graph-bottom-toolbar           absolute; bottom:18px; left:18px; z-index:5
 *
 * ⚠ 隐藏原生 canvas 必须用 visibility:hidden，【绝不能用 display:none】——
 *   Pixi 会测量 canvas，display:none 会让布局塌缩并破坏 Logseq 的 resize 逻辑。
 *   visibility:hidden 保留布局，同时按规范让元素不可命中，原生 canvas 自然收不到指针事件。
 *
 * 隐藏而非单纯遮盖还能省掉真实开销：Pixi 的 ticker 会停止光栅化那块看不见的图。
 */
(function (GFI) {
  'use strict';
  if (GFI.Overlay) return;

  const { clamp } = GFI.util;

  const STYLE_ID = 'gfi-overlay-styles';

  const CSS = `
.gfi-root { position:absolute; inset:0; z-index:1; }
.gfi-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; }

/* 紧凑控件栏：只留 播放/暂停 · 日期+滑块 · 类型开关 · 适配视野 */
.gfi-toolbar {
  position:absolute; bottom:16px; left:50%; transform:translateX(-50%);
  z-index:6;
  display:flex; align-items:center; gap:8px;
  padding:5px 9px; border-radius:11px;
  background: rgba(20,20,24,0.82);
  backdrop-filter: blur(14px) saturate(170%);
  -webkit-backdrop-filter: blur(14px) saturate(170%);
  border:1px solid rgba(255,255,255,0.10);
  box-shadow: 0 8px 28px rgba(0,0,0,0.42);
  font: 11.5px/1.15 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  color: rgba(255,255,255,0.78);
  user-select:none; -webkit-user-select:none;
  /* 中文没有 nowrap 时会逐字换行 —— flex 子项被压缩后就是竖排。
     必须同时禁掉收缩，否则容器一窄文字照样会被挤成两行。 */
  white-space: nowrap;
}
.gfi-btn {
  display:inline-flex; align-items:center; justify-content:center;
  flex:0 0 auto;
  min-width:24px; height:24px; padding:0 6px;
  border-radius:7px; cursor:pointer;
  background: transparent;
  border:1px solid transparent;
  color: rgba(255,255,255,0.62);
  white-space: nowrap;
  transition: background .14s ease, color .14s ease, transform .14s ease;
}
.gfi-btn:hover { background: rgba(255,255,255,0.10); color: rgba(255,255,255,0.95); }
.gfi-btn:active { transform: scale(0.93); }
.gfi-btn.gfi-active {
  background: color-mix(in srgb, var(--ls-link-text-color, #705dcf) 30%, transparent);
  border-color: color-mix(in srgb, var(--ls-link-text-color, #705dcf) 55%, transparent);
  color:#fff;
}
.gfi-sep { flex:0 0 auto; width:1px; height:16px; background: rgba(255,255,255,0.10); }
.gfi-btn.gfi-kind { font-size:11px; padding:0 8px; min-width:0; letter-spacing:.5px; }

.gfi-time { display:flex; align-items:center; gap:8px; flex:0 0 auto; width:280px; }
.gfi-label {
  flex:0 0 auto; min-width:76px; font-size:11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing:.3px; color: rgba(255,255,255,0.62);
  text-align:right; white-space:nowrap;
}
.gfi-slider {
  -webkit-appearance:none; appearance:none; flex:1; height:3px; border-radius:2px; outline:none;
  background: linear-gradient(to right,
    var(--ls-link-text-color, #705dcf) 0%,
    var(--ls-link-text-color, #705dcf) var(--gfi-progress, 100%),
    rgba(255,255,255,0.14) var(--gfi-progress, 100%),
    rgba(255,255,255,0.14) 100%);
}
.gfi-slider::-webkit-slider-thumb {
  -webkit-appearance:none; width:11px; height:11px; border-radius:50%;
  background:#fff; border:0;
  box-shadow: 0 1px 4px rgba(0,0,0,.6);
  cursor:pointer;
  transition: transform .12s ease;
}
.gfi-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
`;

  function injectStyles() {
    const doc = GFI.topDoc;
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }

  function readBackground() {
    try {
      const v = GFI.topWin.getComputedStyle(GFI.topDoc.documentElement)
        .getPropertyValue(GFI.config.render.bgCssVar).trim();
      if (v) return v;
    } catch (e) {}
    return GFI.config.render.bgFallback;
  }

  /** 找到当前打开的全屏图谱根节点 */
  function findRoot() {
    const doc = GFI.topDoc;
    if (!doc) return null;
    return doc.querySelector('#global-graph');
  }

  // ===========================================================================
  // 原生 Pixi 渲染器的【暂停 / 恢复】
  // ===========================================================================
  // 为什么需要：
  //   把原生 canvas 设成 visibility:hidden 之后，浏览器确实不再【合成】它 ——
  //   但 Logseq 的 Pixi ticker 依然每帧执行 renderer.render({container: stage})，
  //   把全部节点 / 边的 draw call 照常提交给 GPU。这部分开销我们一点都看不见
  //   （它画在一块不显示的画布上），节点越多越贵。停掉它才是真的省下来。
  //
  // 怎么拿到那个 Application：
  //   Pixi v8 有一个【官方扩展点】—— Application.init() 在创建完 renderer、
  //   装好 ResizePlugin / TickerPlugin 之后会调用
  //       globalThis.__PIXI_APP_INIT__(app, VERSION)
  //   （Pixi 源码里的 ApplicationInitHook）。我们在宿主窗口上挂这个函数，
  //   就能拿到之后创建的每一个 Application —— 不需要猜任何私有字段。
  //   实证：Logseq 2.0.1 → resources/app.asar → /js/main.js，搜
  //   `__PIXI_APP_INIT__` 与 `ApplicationInitHook` 都能直接看到这段。
  //
  // ⚠ 时机：必须在 Application 创建【之前】挂上，所以是在模块加载时安装，
  //   而不是等到 mount()。插件 iframe 在 Logseq 启动时就加载了，而图谱组件
  //   【每次进入图谱都会新建一个 Application】，所以能覆盖到。
  //   唯一漏掉的情况是「插件重载时人已经站在图谱页面上」—— 那个 App 早就建好了，
  //   这时退化成今天的行为：只隐藏、不暂停。不报错、不影响任何功能。
  //
  // ⚠ 只动 ticker（app.stop / app.start），绝不去碰 visibility / display ——
  //   后者会破坏 Pixi 的尺寸测量，见本文件开头。
  //
  // 顺带确认过：Logseq 2.0.1 的打包产物里只有图谱这一个模块引入了 Pixi，
  //   所以不会误伤别的组件；而且下面还按 canvas 归属过滤了一次。
  const capturedApps = [];        // 所有见过的 Application
  const pausedApps = [];          // 被我们停掉的 Application（恢复时只动这些）
  let captureHook = null;
  let captureInstalled = false;
  let takeoverRoot = null;        // 非空 = 我们正盖在这个 root 上

  function installPixiCapture() {
    if (captureInstalled) return;
    const w = GFI.topWin;
    if (!w) return;
    try {
      const prev = w.__PIXI_APP_INIT__;
      captureHook = function (app, version) {
        try { if (app && app.canvas) capturedApps.push(app); } catch (e) {}
        // 接管期间新建的 App：它的 canvas 要等 init() 的 then 回调才挂进 DOM，
        // 所以推迟一个【宏任务】再匹配 —— 微任务会早于那个 then。
        if (takeoverRoot) {
          try { GFI.topWin.setTimeout(pauseNativeRenderers, 0); } catch (e) {}
        }
        // 万一以后有别人也用了这个钩子，链上去，不做独占地盘的事
        if (typeof prev === 'function') { try { prev(app, version); } catch (e) {} }
      };
      w.__PIXI_APP_INIT__ = captureHook;
      captureInstalled = true;
    } catch (e) { /* 跨域等异常 —— 静默退回"只隐藏不暂停" */ }
  }

  /** 捡出还活着的 App（destroy() 会把 renderer 置 null） */
  function liveApps() {
    for (let i = capturedApps.length - 1; i >= 0; i--) {
      if (!capturedApps[i].renderer) capturedApps.splice(i, 1);
    }
    return capturedApps;
  }

  /**
   * 停掉盖在 root 上的原生渲染循环。
   * app.stop() 就是 TickerPlugin 装在 Application 上的方法，内部是 ticker.stop()
   * —— 它会 cancelAnimationFrame，让 Pixi 降到【零 rAF 回调】。
   * 用公开方法而不是直接摸 ticker，是为了不依赖 Pixi 的内部字段名。
   * @returns {number} 本次停了几个
   */
  function pauseNativeRenderers() {
    if (!takeoverRoot) return 0;
    let k = 0;
    for (const app of liveApps()) {
      let c = null;
      try { c = app.canvas; } catch (e) { continue; }
      if (!c || !takeoverRoot.contains(c)) continue;   // 只动我们盖住的那块画布
      try {
        app.stop();
        if (pausedApps.indexOf(app) < 0) pausedApps.push(app);
        k++;
      } catch (e) {}
    }
    return k;
  }

  /** 把交还给宿主的那些渲染循环重新拉起来 */
  function resumeNativeRenderers() {
    for (const app of pausedApps) {
      try { app.start(); } catch (e) {}
    }
    pausedApps.length = 0;
  }

  /**
   * 插件真的要卸载时才摘钩子（由 index.js 的 beforeunload 调用）。
   * ⚠ 不能放在 unmount() 里：unmount 之后紧接着就会 mount（离开图谱再进来），
   *   而新图谱的 Application 是在我们下一次 mount 之前就建好的 ——
   *   中间摘钩子会整整漏掉一个 App。
   */
  function releasePixiCapture() {
    const w = GFI.topWin;
    if (captureInstalled && w) {
      try { if (w.__PIXI_APP_INIT__ === captureHook) delete w.__PIXI_APP_INIT__; } catch (e) {}
    }
    captureInstalled = false;
    captureHook = null;
    capturedApps.length = 0;
    pausedApps.length = 0;
    takeoverRoot = null;
  }

  /**
   * @param {HTMLElement} root #global-graph
   * @returns {object|null}
   */
  function mount(root) {
    if (!root) return null;
    // ⚠ 不能只看 root.__gfiMounted。
    //   React 重渲染 #global-graph 时会把它下面的子节点全部重建 ——
    //   我们 append 进去的容器会被清掉，但 root 元素本身仍然连着。
    //   此时标志位仍为 true，会让我们误判"已挂载"而直接返回 null，
    //   结果就是【第二次进入图谱时什么都不挂载，露出原生图谱】。
    //   所以要连带确认容器是否还活在 DOM 里。
    if (root.__gfiMounted && root.__gfiContainer && root.__gfiContainer.isConnected) return null;
    root.__gfiMounted = true;
    injectStyles();

    const doc = GFI.topDoc;
    const nativeCanvas = root.querySelector('.graph-canvas');
    const nativeToolbar = root.querySelector('.graph-bottom-toolbar');

    // 记住原生元素的原状，切回时要精确还原
    const nativeState = {
      canvasVisibility: nativeCanvas ? nativeCanvas.style.visibility : '',
      canvasPointer: nativeCanvas ? nativeCanvas.style.pointerEvents : '',
      toolbarVisibility: nativeToolbar ? nativeToolbar.style.visibility : '',
      toolbarPointer: nativeToolbar ? nativeToolbar.style.pointerEvents : '',
      // #global-graph 的声明样式里【没有 position】。若它是 static，
      // 我们那个 position:absolute; inset:0 的容器就会以更上层（甚至视口）为
      // 基准定位，而且 overflow:hidden 也裁不到它 —— 表现是图谱铺满整个窗口
      // 或者干脆被裁没。这里补上 relative 建立包含块。
      rootPosition: root.style.position,
    };
    if (GFI.topWin.getComputedStyle(root).position === 'static') {
      root.style.position = 'relative';
    }

    // ---- 我们的容器 ----
    const container = doc.createElement('div');
    container.className = 'gfi-root';

    const canvas = doc.createElement('canvas');
    canvas.className = 'gfi-canvas';
    container.appendChild(canvas);

    const toolbar = doc.createElement('div');
    toolbar.className = 'gfi-toolbar';
    container.appendChild(toolbar);

    root.appendChild(container);
    root.__gfiContainer = container;

    // ---- resize ----
    let resizeCb = null;
    let pendingResize = false;
    const RO = GFI.topWin.ResizeObserver || window.ResizeObserver;
    let observer = null;

    function measure() {
      const r = root.getBoundingClientRect();
      return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
    }

    if (RO) {
      observer = new RO(() => {
        if (pendingResize) return;
        pendingResize = true;
        // 合并到 rAF，避免连续触发时重复 resize
        GFI.topWin.requestAnimationFrame(() => {
          pendingResize = false;
          if (resizeCb) { const m = measure(); resizeCb(m.w, m.h); }
        });
      });
      try { observer.observe(root); } catch (e) {}
    }

    const api = {
      root, container, canvas, toolbar, nativeCanvas, nativeToolbar,

      measure,

      onResize(cb) {
        resizeCb = cb;
        const m = measure();
        cb(m.w, m.h);
      },

      readBackground,

      /** 接管 / 交还 */
      setNativeVisible(nativeVisible) {
        if (nativeCanvas) {
          nativeCanvas.style.visibility = nativeVisible ? nativeState.canvasVisibility : 'hidden';
          nativeCanvas.style.pointerEvents = nativeVisible ? nativeState.canvasPointer : 'none';
        }
        if (nativeToolbar) {
          nativeToolbar.style.visibility = nativeVisible ? nativeState.toolbarVisibility : 'hidden';
          nativeToolbar.style.pointerEvents = nativeVisible ? nativeState.toolbarPointer : 'none';
        }
        container.style.display = nativeVisible ? 'none' : '';
        // 画板盖住了，它的渲染循环就不该继续跑 —— 见上面「原生 Pixi 渲染器」一节
        takeoverRoot = nativeVisible ? null : root;
        if (nativeVisible) resumeNativeRenderers();
        else pauseNativeRenderers();
      },

      /** 被我们暂停的原生渲染器数量（诊断用） */
      get pausedNativeRenderers() { return pausedApps.length; },
      /** 见过的原生 Application 总数（诊断用） */
      get capturedNativeRenderers() { return capturedApps.length; },

      unmount() {
        // 交还宿主：循环该跑还得跑起来，否则切回原生图谱是一片死画面
        resumeNativeRenderers();
        takeoverRoot = null;
        try { if (observer) observer.disconnect(); } catch (e) {}
        observer = null;
        try { root.style.position = nativeState.rootPosition; } catch (e) {}
        // 精确还原原生元素 —— 这是"不破坏宿主"的底线
        if (nativeCanvas) {
          nativeCanvas.style.visibility = nativeState.canvasVisibility;
          nativeCanvas.style.pointerEvents = nativeState.canvasPointer;
        }
        if (nativeToolbar) {
          nativeToolbar.style.visibility = nativeState.toolbarVisibility;
          nativeToolbar.style.pointerEvents = nativeState.toolbarPointer;
        }
        try { container.remove(); } catch (e) {}
        if (root.__gfiContainer === container) delete root.__gfiContainer;
        delete root.__gfiMounted;
      },

      /** 容器是否还活在 DOM 里。React 重渲染会把它清掉，而 root 仍然连着。 */
      get alive() {
        return !!(container && container.isConnected && canvas && canvas.isConnected);
      },
    };

    return api;
  }

  // ⚠ 钩子必须在任何 Application 创建之前装好 —— 所以放在模块加载时，
  //   而不是等 mount()。装不上（跨域等）就静默退回"只隐藏不暂停"。
  installPixiCapture();

  GFI.Overlay = {
    mount, findRoot, injectStyles, readBackground, STYLE_ID,
    releasePixiCapture, pauseNativeRenderers, resumeNativeRenderers,
  };
})(window.GFI);
