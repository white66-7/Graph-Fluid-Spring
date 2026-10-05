// 宿主 DOM 挂载 / 原生切换 / resize
(function (GFI) {
  'use strict';
  if (GFI.Overlay) return;

  const { clamp } = GFI.util;

  const STYLE_ID = 'gfi-overlay-styles';

  const CSS = `
.gfi-root { position:absolute; inset:0; z-index:1; }
.gfi-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; }

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


  // 原生 Pixi 渲染器的暂停与恢复
  // Logseq 的 Pixi ticker 每帧执行 renderer.render({container: stage})
  // 不停止会浪费算力
  const capturedApps = [];        // 所有见过的 Application
  const pausedApps = [];          // 被我们停掉的 Application
  let captureHook = null;
  let captureInstalled = false;
  let takeoverRoot = null;        // 是否接管原生 #global-graph

  function installPixiCapture() {
    if (captureInstalled) return;
    const w = GFI.topWin;
    if (!w) return;
    try {
      // 靠 prev 拿到别人的__PIXI_APP_INIT__函数
      const prev = w.__PIXI_APP_INIT__;
      captureHook = function (app, version) {
        try { if (app && app.canvas) capturedApps.push(app); } catch (e) {}
        if (takeoverRoot) {
        // 如果发现我们正在接管，就预约一个暂停操作，但稍后再做
          try { GFI.topWin.setTimeout(pauseNativeRenderers, 0); } catch (e) {}
        }
        if (typeof prev === 'function') { try { prev(app, version); } catch (e) {} }
      };
      // 此时跑完别人的 __PIXI_APP_INIT__ 
      // 注册自己的
      w.__PIXI_APP_INIT__ = captureHook;
      captureInstalled = true;
    } catch (e) { /* 异常静默退回 */ }
  }

  /* 拿取活的Appliacation */
  function liveApps() {
    for (let i = capturedApps.length - 1; i >= 0; i--) {
      if (!capturedApps[i].renderer) capturedApps.splice(i, 1);
    }
    return capturedApps;
  }

  /**
   * 停掉盖在 root 上的原生渲染循环。
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

  /* 渲染重新循环 */
  function resumeNativeRenderers() {
    for (const app of pausedApps) {
      try { app.start(); } catch (e) {}
    }
    pausedApps.length = 0;
  }

   //  卸载__PIXI_APP_INIT__函数, 由index.js 的 beforeunload 调用。
   // 不放在 unmount 里因为离开图谱再进来会漏掉一个 App
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

  // 参数与返回注释
  /**
   * @param {HTMLElement} root #global-graph
   * @returns {object|null}
   */
  function mount(root) {
    if (!root) return null;

    // 挂载过、还活着、还在DOM里就返回
    if (root.__gfiMounted && root.__gfiContainer && root.__gfiContainer.isConnected) return null;
    root.__gfiMounted = true;

    injectStyles();

    const doc = GFI.topDoc;
    const nativeCanvas = root.querySelector('.graph-canvas');
    const nativeToolbar = root.querySelector('.graph-bottom-toolbar');

    // 保存元素原生样式
    const nativeState = {
      canvasVisibility: nativeCanvas ? nativeCanvas.style.visibility : '',
      canvasPointer: nativeCanvas ? nativeCanvas.style.pointerEvents : '',
      toolbarVisibility: nativeToolbar ? nativeToolbar.style.visibility : '',
      toolbarPointer: nativeToolbar ? nativeToolbar.style.pointerEvents : '',
      rootPosition: root.style.position,
    };
    
    if (GFI.topWin.getComputedStyle(root).position === 'static') {
      root.style.position = 'relative';
    }

    // ---- 容器 ----
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

    let resizeCb = null;  // 用来存储外部函数的变量
    let pendingResize = false;  
    let observer = null;

    function measure() {
      const r = root.getBoundingClientRect();
      return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
    }

    const RO = GFI.topWin.ResizeObserver || window.ResizeObserver;
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

      // 参数 cb 是函数
      onResize(cb) {
        resizeCb = cb;
        const m = measure();
        // 回调执行
        cb(m.w, m.h); 
      },

      readBackground,

      // 接管或回归原生图谱，这取决于 nativeVisible
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
        takeoverRoot = nativeVisible ? null : root;
        if (nativeVisible) resumeNativeRenderers();
        else pauseNativeRenderers();
      },

      // 被暂停的原生渲染器数量
      get pausedNativeRenderers() { return pausedApps.length; },
      // 见过的原生 Application 总数
      get capturedNativeRenderers() { return capturedApps.length; },

      unmount() {
        // 交还宿主
        resumeNativeRenderers();
        takeoverRoot = null;
        try { if (observer) observer.disconnect(); } catch (e) {}
        observer = null;
        try { root.style.position = nativeState.rootPosition; } catch (e) {}
        // 还原原生元素
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

   // 注册 __PIXI_APP_INIT__ 函数
  installPixiCapture();

  GFI.Overlay = {
    mount, findRoot, injectStyles, readBackground, STYLE_ID,
    releasePixiCapture, pauseNativeRenderers, resumeNativeRenderers,
  };
})(window.GFI);
