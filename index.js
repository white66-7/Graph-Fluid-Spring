/*
 * Graph Fluid Inertia — Logseq 生命周期胶水
 * ===========================================================================
 * 这个文件只做三件事：
 *   1. 注册设置面板 + 同步设置
 *   2. 监听 #global-graph 的【出现与消失】，挂载 / 拆卸渲染器
 *   3. 把节点点击接到 Logseq 的页面跳转
 *
 * 真正的图谱渲染全在 src/ 下。
 *
 * ── v1 遗留说明 ──
 * 旧的 WebGL uniformMatrix3fv 劫持、capture 阶段的 topWin 指针监听、
 * 合成 PointerEvent 傀儡都已删除。原因见 README / 架构文档：
 *   · Pixi v8 在 WebGL2 下走 UBO，uniformMatrix3fv 根本不会被调用；
 *   · 即使调用了，改 projection matrix 也只是相机缩放（相似变换），
 *     数学上无法表达"逐节点独立受力"；
 *   · 合成 PointerEvent 只能驱动一个 drag session，无法注入外力。
 */
(function () {
  'use strict';

  const GFI = window.GFI;
  if (!GFI) { console.error('[GFI] src/ 未加载，检查 index.html 的脚本顺序'); return; }

  const SCAN_THROTTLE_MS = 120;

  let graphApi = null;
  let observer = null;
  let scanTimer = null;
  let booting = false;

  // -------------------------------------------------------------------------
  // 检测图谱视图
  // -------------------------------------------------------------------------
  function graphRootPresent() {
    try {
      return !!GFI.Overlay.findRoot();
    } catch (e) {
      return false;
    }
  }

  async function mountGraph() {
    if (graphApi || booting) return;
    booting = true;
    try {
      const cfg = GFI.config;
      // 先用空数据挂载 —— 立刻给出视觉反馈，数据到了再 setData
      graphApi = GFI.Main.boot({
        nodes: [],
        links: [],
        onNodeActivate: activateNode,
      });
      if (!graphApi) { booting = false; return; }

      const t0 = performance.now();
      const data = await GFI.DataSource.fetchData({
        source: cfg.dataSource,
        demoCount: cfg.demoCount,
        includeParentLinks: false,
      });
      if (!graphApi) { booting = false; return; }   // 期间被拆掉了
      console.log(`[GFI] 数据就绪 ${Math.round(performance.now() - t0)}ms`);
      graphApi.setData(data.nodes, data.links);
    } catch (e) {
      console.error('[GFI] 挂载失败', e);
    } finally {
      booting = false;
    }
  }

  // 重新拉一次数据并重建图谱。
  // 改过滤规则后不用重载插件 —— 由 __GFI__.reload() 调用
  GFI.reloadData = async function reloadData() {
    if (!graphApi) return null;
    const data = await GFI.DataSource.fetchData({
      source: GFI.config.dataSource,
      demoCount: GFI.config.demoCount,
      includeParentLinks: false,
    });
    if (graphApi) graphApi.setData(data.nodes, data.links);
    return data;
  };

  function unmountGraph() {
    if (graphApi) {
      graphApi.destroy('graph view closed');
      graphApi = null;
    }
  }

  // -------------------------------------------------------------------------
  // 节点点击 → 在 Logseq 里打开页面
  // -------------------------------------------------------------------------
  function activateNode(node) {
    if (!node) return;
    const L = window.logseq;
    if (!L) return;
    const name = node.label;
    const uuid = node.uuid;
    try {
      // 优先按 uuid 跳（更精确，页名可能被改名过）
      if (uuid && L.App && typeof L.App.pushState === 'function') {
        L.App.pushState('page', { name }, {});
        return;
      }
      if (L.App && typeof L.App.pushState === 'function' && name) {
        L.App.pushState('page', { name }, {});
      }
    } catch (e) {
      console.warn('[GFI] 跳转失败', e);
    }
  }

  // -------------------------------------------------------------------------
  // 视图开关监听
  // -------------------------------------------------------------------------
  // Logseq 自己的重渲染会让 #global-graph 短暂消失（几帧到几十毫秒）。
  // 一发现不在就拆掉的话，会白跑一次数据拉取、还会把已经沉降好的布局重置，
  // 视觉上就是一次闪烁。所以要求连续若干次扫描都缺席才真的拆。
  const ABSENT_SCANS_TO_UNMOUNT = 3;
  let absentScans = 0;

  function scan() {
    scanTimer = null;
    try {
      if (graphRootPresent()) {
        // 陈旧实例守卫。
        // ⚠ 判据是【容器】是否还连着，不是 root —— React 重渲染 #global-graph 时
        //   会重建其子节点，把我们的容器清掉，而 root 元素本身仍然连着。
        //   不清理的话 boot() 的 `if (instance) return instance` 会返回这个死实例，
        //   结果是【第二次进入图谱什么都不挂载，露出原生图谱】。
        if (graphApi && !graphApi.alive) {
          graphApi.destroy('overlay detached');
          graphApi = null;
        }
        absentScans = 0;
        mountGraph();
      } else if (graphApi) {
        if (++absentScans >= ABSENT_SCANS_TO_UNMOUNT) {
          absentScans = 0;
          unmountGraph();
        } else {
          // ⚠ 必须自己续上下一次扫描。
          //   scheduleScan 只由 DOM 变动触发，而"根节点消失"这件事只产生一次变动 ——
          //   不主动重排的话 absentScans 会永远停在 1，unmountGraph 永不执行，
          //   于是残留一个陈旧实例，下次进入图谱就挂不上了。
          scheduleScan();
        }
      }
    } catch (e) {
      console.error('[GFI] scan 出错', e);
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    // 合并到 setTimeout —— 用插件 iframe 的 rAF 是不安全的（iframe 可能隐藏）
    scanTimer = setTimeout(scan, SCAN_THROTTLE_MS);
  }

  function startObserver() {
    scan();
    observer = new GFI.topWin.MutationObserver(scheduleScan);
    observer.observe(GFI.topDoc.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (scanTimer !== null) { clearTimeout(scanTimer); scanTimer = null; }
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function applySettings(s) {
    GFI.syncSettings(s || {});
  }

  // config.js 通过这个回调把「配置已升级」写回 Logseq 设置，
  // 这样下次启动就不会重复重置（也避免 config.js 直接依赖 logseq API）
  GFI.onFreshSettings = function onFreshSettings(values) {
    try {
      if (window.logseq && window.logseq.updateSettings && values) {
        window.logseq.updateSettings(values);
      }
    } catch (e) {
      console.warn('[GFI] 写回配置失败', e);
    }
  };

  function start() {
    try {
      applySettings(window.logseq && window.logseq.settings);
      startObserver();
    } catch (e) {
      console.error('[GFI] 启动失败', e);
    }
  }

  if (typeof logseq !== 'undefined' && logseq.ready) {
    if (logseq.beforeunload) {
      logseq.beforeunload(async () => {
        stopObserver();
        unmountGraph();
        // 插件真的要走了才摘 Pixi 钩子。
        // ⚠ 不能挪进 unmountGraph()：图谱视图来来去去都会走那条路径，
        //   而摘掉钩子会整整漏掉下一个 Application（详见 overlay.js 的说明）。
        try { GFI.Overlay.releasePixiCapture(); } catch (e) {}
      });
    }

    logseq.ready().then(() => {
      try {
        logseq.useSettingsSchema(GFI.settingsSchema);
        applySettings(logseq.settings);
        logseq.onSettingsChanged((s) => {
          const wasNative = GFI.getGraph() && GFI.getGraph().nativeMode;
          applySettings(s);
          const g = GFI.getGraph();
          if (g && !!GFI.config.useNativeGraph !== !!wasNative) {
            g.setNativeMode(!!GFI.config.useNativeGraph);
          }
        });
      } catch (e) {
        console.error('[GFI] 设置注册失败', e);
      }
      setTimeout(start, 300);
    }).catch(console.error);
  } else {
    setTimeout(start, 300);
  }
})();
