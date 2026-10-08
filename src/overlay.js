// 宿主 DOM 挂载 / 原生切换 / resize
(function (GFI) {
  'use strict';
  if (GFI.Overlay) return;

  const { clamp } = GFI.util;

  const STYLE_ID = 'gfi-overlay-styles';

  const CSS = `
/* ⚠ overflow:hidden 不是装饰：这个容器是 position:absolute + inset:0，
   尺寸完全跟随 #global-graph。如果 root 的定位上下文不是我们以为的那个
   （比如它是 static，我们的 absolute 就会挂到更高的祖先上），容器会撑成
   整屏大小、盖住设置面板之类的 UI，把滚轮/点击一起吃掉。
   加上 overflow:hidden 之后，它至少不会把自己的内容画到 root 之外。 */
.gfi-root { position:absolute; inset:0; overflow:hidden; z-index:1; }
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

/* 加载指示 —— 只在我们已经接管、但画布上还没有内容的那个窗口里出现。
   它替代的是"原生图谱继续显示"那段：既然要的是"点进去就是我的样式"，
   那等待期间就不该再让原生图谱露脸，但也不能是一片空白。 */
.gfi-loader {
  position:absolute; inset:0; z-index:5;
  display:flex; align-items:center; justify-content:center; gap:10px;
  font:12px/1 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  color: var(--ls-secondary-text-color, rgba(255,255,255,0.45));
  letter-spacing:.4px;
  pointer-events:none;
}
.gfi-loader[hidden] { display:none; }
.gfi-spinner {
  width:15px; height:15px; border-radius:50%;
  border:1.5px solid currentColor;
  border-top-color: transparent;
  animation: gfi-spin .7s linear infinite;
}
@keyframes gfi-spin { to { transform: rotate(360deg); } }
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
        record('原生 Pixi 起画（原生图谱此刻已经能看）');
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
   * @param {object} [opts] { nativeVisible:boolean }
   *        nativeVisible 默认 false —— 挂载即接管（把原生画布藏掉、露出我们的
   *        加载指示）。这是"点进去就是我的样式"的前提：只要还让原生图谱显示，
   *        用户必然先看到它，再看到我们。
   * @returns {object|null}
   */
  function mount(root, opts) {
    if (!root) return null;
    opts = opts || {};
    const showNative = !!opts.nativeVisible;

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
    
    // ⚠ 只在 root 是 static 时才改成 relative —— 这是为了给我们的 absolute
    //   容器建立定位上下文。如果 root 本来就有定位（Logseq 通常给了 absolute
    //   或 relative），就【不要碰它】。
    //   实机排查"设置面板滚不动/点不动"时，第一件要确认的事就是
    //   `.gfi-root` 的 rect 是否等于 #global-graph 的 rect；不相等就说明
    //   定位上下文不是这里，容器撑成了整屏。
    if (GFI.topWin.getComputedStyle(root).position === 'static') {
      root.style.position = 'relative';
    }

    // ---- 容器 ----
    const container = doc.createElement('div');
    container.className = 'gfi-root';
    // 给 i18n 的面板文案改写打标记：它靠"文字内容反查"定位设置面板的节点，
    // 万一图谱里恰好有 {label} 的文字、又落在疑似 settings 的子树里，
    // 就会被误改。这个标记让它整棵跳过我们的容器。
    container.__gfiSkip = true;

    const canvas = doc.createElement('canvas');
    canvas.className = 'gfi-canvas';
    container.appendChild(canvas);

    // 加载指示。默认隐藏 —— 只有 main.js 明确说"还没内容"时才亮。
    const loader = doc.createElement('div');
    loader.className = 'gfi-loader';
    loader.hidden = true;
    const spinner = doc.createElement('div');
    spinner.className = 'gfi-spinner';
    const loaderText = doc.createElement('div');
    loaderText.textContent = '图谱布局中…';
    loader.appendChild(spinner);
    loader.appendChild(loaderText);
    container.appendChild(loader);

    const toolbar = doc.createElement('div');
    toolbar.className = 'gfi-toolbar';
    container.appendChild(toolbar);

    root.appendChild(container);
    root.__gfiContainer = container;

    let resizeCb = null;  // 用来存储外部函数的变量
    let resizeRaf = null; // 已排队的 resize 合并（0 = 没有）
    let observer = null;

    function measure() {
      const r = root.getBoundingClientRect();
      return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
    }

    const RO = GFI.topWin.ResizeObserver || window.ResizeObserver;
    if (RO) {
      observer = new RO(() => {
        // 合并到 rAF，避免连续触发时重复 resize
        if (resizeRaf != null) return;
        resizeRaf = GFI.topWin.requestAnimationFrame(() => {
          resizeRaf = null;
          if (!resizeCb) return;
          const m = measure();
          // ⚠ 量到 0 就直接丢掉。容器在原生模式（或还没显示）时是 display:none，
          //   量出来是 0×0 —— 拿它去 resize 会把相机与画布一起打成 0，
          //   回到我们的视图时就是一片空白，而且 ResizeObserver 不会再触发一次
          //   （尺寸"没变"）。原来是靠一个 pendingResize 标志位卡住，
          //   但那个标志位在 rAF 回调抛错时会永久停在 true，ResizeObserver
          //   从此彻底失效 —— 用一个"排队 id"就不会有这种粘滞状态。
          if (m.w <= 1 || m.h <= 1) return;
          resizeCb(m.w, m.h);
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

      /** 画布上还没有内容时亮着它 —— 见 CSS 里 .gfi-loader 的说明 */
      showLoader() { loader.hidden = false; },
      hideLoader() { loader.hidden = true; },
      get loaderVisible() { return !loader.hidden; },

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
        // ---- 时序探针 ----
        // 观感问题（"先看到原生图谱"）无法靠读代码定论 —— 它取决于宿主什么时候
        // 把 #global-graph 交出来。所以每一次切换都留一条带时间戳的记录，
        // 事后在控制台调 __GFI__.timeline() 就能看到客观顺序。
        record(nativeVisible ? '切回原生图谱' : '隐藏原生图谱（我们接管）');
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
        if (resizeRaf != null) { try { GFI.topWin.cancelAnimationFrame(resizeRaf); } catch (e) {} resizeRaf = null; }
        resizeCb = null;
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

   // ---------------------------------------------------------------------------
  // 时序探针 —— 进图谱那几百毫秒里到底发生了什么，靠它定论
  // ---------------------------------------------------------------------------
  // 为什么必须有：观感（"先看到原生图谱"）是【宿主 + 我们】的时序产物。
  // 读代码只能证明我们会怎么切，证明不了宿主什么时候把 #global-graph 交出来、
  // 原生 Pixi 是什么时候起画的。所以把每个分界点记成一条带时间戳的记录，
  // 事后 `__GFI__.timeline()` 就能给出客观顺序，而不是靠感觉描述。
  const MAX_EVENTS = 80;
  const origin = (() => { try { return GFI.topWin.performance.now(); } catch (e) { return 0; } })();
  let events = [];

  function record(label, detail) {
    let t = 0;
    try { t = GFI.topWin.performance.now() - origin; } catch (e) {}
    events.push({ t: Math.round(t), label, detail: detail === undefined ? '' : detail });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  /** 打印时序。返回数组，方便脚本化断言。 */
  function printEvents() {
    const lines = events.map((e) => `${String(e.t).padStart(6)}ms  ${e.label}${e.detail !== '' ? '  ' + e.detail : ''}`);
    console.log('%c[GFI] 进图谱时序\n' + lines.join('\n'), 'color:#0aa;font-family:monospace');
    return events.slice();
  }

  function clearEvents() { events = []; }

  // ---- 原生图谱是什么时候出现在 DOM 里的 ----
  // 探针脚本可能比这个模块晚加载，所以先同步查一次。
  // ⚠ 这两行必须排在 events 声明【之后】：record 会往 events 里写，
  //   提前调用就是一次 TDZ 抛错（`Cannot access 'events' before initialization`），
  //   而且它会连带把 __PIXI_APP_INIT__ 的注册一起带走。
  const initialRoot = findRoot();
  record('overlay.js 加载', initialRoot ? '#global-graph 已在 DOM' : '#global-graph 还不在');

  // 暴露给后加载的探针脚本：它拿到的 events 是同一个数组引用（实时）。
  const w = GFI.topWin;
  if (w) { w.__GFI_TIMELINE__ = { events, print: printEvents, clear: clearEvents }; }

  function startRootWatch() {
    const doc = GFI.topDoc;
    if (!doc || !doc.body || !GFI.topWin.MutationObserver) return;
    let seen = !!initialRoot;
    try {
      const mo = new GFI.topWin.MutationObserver(() => {
        const r = findRoot();
        const now = !!r;
        if (now === seen) return;
        seen = now;
        record(now ? '宿主挂上图谱 DOM' : '宿主移除图谱 DOM');
      });
      mo.observe(doc.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  // 原生 Pixi Application 是什么时候被创建出来的 —— 这一条决定"原生图谱
  // 到底有没有机会被看到"（它一旦 start()，画布上就有内容了）。
  // ---- 注册 __PIXI_APP_INIT__ 函数
  installPixiCapture();
  startRootWatch();

  GFI.Overlay = {
    mount, findRoot, injectStyles, readBackground, STYLE_ID,
    releasePixiCapture, pauseNativeRenderers, resumeNativeRenderers,
    record, printEvents, clearEvents, startRootWatch,
  };
})(window.GFI);
