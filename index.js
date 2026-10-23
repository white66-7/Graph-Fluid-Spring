//  注册设置面板、同步设置;监听 #global-graph 出现/消失并挂载/拆卸渲染器;把节点点击跳转 Logseq页面
(function () {
  'use strict';

  const GFI = window.GFI;
  if (!GFI) { console.error('[GFI] src/ 未加载，检查 index.html 的脚本顺序'); return; }

  // DOM 变动后，最多每32毫秒真正执行次 scan()
  const SCAN_THROTTLE_MS = 32;

  let graphApi = null;
  let observer = null;
  let scanTimer = null;
  let booting = false;

  
  // 预热失败后的四次延迟重试间隔
  const PREWARM_RETRY_DELAYS = [1200, 2500, 5000, 10000];
  let prewarmAttempts = 0;

  // 上一次未经 Data.build的原始数据
  let lastRaw = null;

  // 检测图谱视图
  function graphRootPresent() {
    try {
      return !!GFI.Overlay.findRoot();
    } catch (e) {
      return false;
    }
  }

  // GFI.config.runtime 的数据取用
  function prewarmRequest() {
    const rt = (GFI.config && GFI.config.runtime) || {};
    return { source: rt.dataSource, demoCount: rt.demoCount };
  }

  // 预热前等 db-worker 就绪
  const DB_PROBE_INTERVAL_MS = 250;
  const DB_PROBE_PATIENCE_MS = 4000;

  let dbReady = false;
  let dbProbeDeadline = 0;   // 0 = 还没开始计时
  let dbProbeWaiting = false;

  // DB.q 静默探测
  async function probeDbReady() {
    if (dbReady) return true;
    const L = window.logseq;
    if (!L || !L.DB || typeof L.DB.q !== 'function') return false;
    let r;
    try {
      r = await L.DB.q('[:find ?e :where [?e :block/uuid]]');
    } catch (e) {
      return false;          // 未就绪，安静
    }
    if (r === null || r === undefined) return false;
    dbReady = true;
    return true;
  }

  
   // 等 DB 就绪后开始预热，上限是 DB_PROBE_PATIENCE_MS 的值
  async function waitForDb(reason) {
    if (await probeDbReady()) {
      startPrewarm(`${reason || '?'}｜就绪后`, { skipReadyGate: true });
      return;
    }
    if (dbProbeDeadline === 0) {
      dbProbeDeadline = GFI.util.now() + DB_PROBE_PATIENCE_MS;
      console.log(`[GFI] 等 DB 就绪（${reason || '启动'}）`
        + `—— 就绪前不发任何查询，不产生 invoke-db-worker-error`);
    }
    if (dbProbeWaiting) return;      // 已经在轮询则复用
    dbProbeWaiting = true;
    const t0 = GFI.util.now();
    while (GFI.util.now() < dbProbeDeadline) {
      await new Promise((r) => setTimeout(r, DB_PROBE_INTERVAL_MS));
      if (await probeDbReady()) {
        dbProbeWaiting = false;
        dbProbeDeadline = 0;
        console.log(`[GFI] DB 已就绪（等待 ${Math.round(GFI.util.now() - t0)}ms）—— 开始预热`);
        startPrewarm(`${reason || '?'}｜就绪后`, { skipReadyGate: true });
        return;
      }
    }
    dbProbeWaiting = false;
    console.warn(`[GFI] 探测 ${DB_PROBE_PATIENCE_MS}ms 仍不确定 DB 是否就绪`
      + `—— 不再拦，交回退避路径（会有几次查询失败）`);
    startPrewarm(`${reason || '?'}｜探测超时兜底`, { skipReadyGate: true });
  }

  // 配置自检函数
  let prewarmDiagDone = false;
  function prewarmDiag() {
    // 防止重复检测
    if (prewarmDiagDone) return;
    prewarmDiagDone = true;
    const cfg = GFI.config || {};
    const rt = cfg.runtime || {};
    const req = prewarmRequest();
    const suspicious = [];
    if (!GFI.Warm) suspicious.push('GFI.Warm 未加载');
    if (cfg.useNativeGraph === undefined) suspicious.push('config.useNativeGraph 缺失');
    if (rt.dataSource === undefined) suspicious.push('config.runtime.dataSource 缺失（兜底成 logseq)');
    if (rt.demoCount === undefined) suspicious.push('config.runtime.demoCount 缺失（兜底成 400)');
    if (cfg.warm === undefined) suspicious.push('config.warm 缺失');
    if (cfg.physics === undefined) suspicious.push('config.physics 缺失');
    const line = `[GFI] v${GFI.VERSION} 配置自检　useNativeGraph=${!!cfg.useNativeGraph}`
      + ` runtime.dataSource=${JSON.stringify(rt.dataSource)} runtime.demoCount=${JSON.stringify(rt.demoCount)}`
      + ` → 实际用 ${GFI.Warm ? GFI.Warm.keyOf(req) : '?'}`
      + `warm=${JSON.stringify(cfg.warm)}`
      + `logseqAPI=${typeof window.logseq !== 'undefined'}`
      + `顶层键=[${Object.keys(cfg).join(',')}]`;
    if (suspicious.length) console.warn(line + '　⚠ ' + suspicious.join(' / '));
    else console.log(line);
  }

  // 判断数据源 / 演示图规模有没有变
  function prewarmKey() {
    return GFI.Warm ? GFI.Warm.keyOf(prewarmRequest()) : '';
  }
  
  // 预热函数
  function startPrewarm(reason, opts) {
    opts = opts || {};
    prewarmDiag();
    const why = (m) => { console.log(`[GFI] 预热不启动（${reason || '?'}）:${m}`); return null; };
    if (!GFI.Warm) return why('GFI.Warm 未加载 —— 检查 index.html 的脚本顺序');
    if (GFI.config.useNativeGraph) return why('设置里选了原生图谱');

    const key = prewarmKey();

    // 已有缓存
    if (GFI.Warm.peek(key)) return why('已经有现成的布局缓存');

    // 已有预热
    if (GFI.Warm.pending(key)) return why('已经有一个预热在跑（复用它的 Promise）');

    // DB 没就绪
    if (!opts.skipReadyGate && !dbReady) {
      waitForDb(reason || '启动');
      return null;
    }

    // 退回 demo 合成
    if (prewarmRequest().source === 'logseq' && typeof window.logseq === 'undefined') {
      return why('logseq API 还不可用，此时查库会退回 demo 合成图');
    }
    const wcfg = GFI.config.warm;
    if (wcfg && wcfg.enabled === false) return why('config.warm.enabled = false');
    const req = prewarmRequest();
    console.log(`[GFI] 预热启动（${reason || '?'}）source=${req.source} demoCount=${req.demoCount}`);
    const p = GFI.Warm.prewarm(Object.assign({
      log: (m) => console.log('[GFI] 预热 ' + (reason || '') + '｜' + m),
    }, req));
    // 门控超时或真查库失败时的兜底
    p.then((entry) => {
      if (entry) { prewarmAttempts = 0; return; }
      const delay = PREWARM_RETRY_DELAYS[prewarmAttempts];
      if (delay === undefined) {
        console.warn(`[GFI] 预热重试 ${PREWARM_RETRY_DELAYS.length} 次仍未拿到布局 —— 放弃`
          + '（进图谱时仍会同步抢跑，冷启动那几毫秒的代价）');
        return;
      }
      prewarmAttempts++;
      console.warn(`[GFI] 预热没拿到布局（已过 DB 就绪门控，属于异常）—— ${delay}ms 后第 ${prewarmAttempts} 次重试`);
      setTimeout(() => startPrewarm(`空结果重试#${prewarmAttempts}`, { skipReadyGate: true }), delay);
    });
    return p;
  }

  // 数据变后预热坐标作废
  function afterDataChanged(reason) {
    if (GFI.Warm) GFI.Warm.invalidate(reason);
  }

  // 把查库挂起来以免阻塞挂载
  function beginFetch() {
    const t0 = performance.now();
    return GFI.DataSource.fetchData({
      source: ((GFI.config.runtime || {}).dataSource),
      demoCount: ((GFI.config.runtime || {}).demoCount),
      includeParentLinks: false,
    }).then((data) => {
      console.log(`[GFI] 数据就绪 ${Math.round(performance.now() - t0)}ms（${data.nodes.length} 节点）`);
      if (data.nodes.length) lastRaw = data;
      return data;
    });
  }

  // 只给布局而非数据
  async function acquireLayout(fetching) {
    const key = prewarmKey();
    const req = prewarmRequest();

    // 缓存命中
    const cached = GFI.Warm.peek(key);
    if (cached) {
      GFI.Overlay.record('布局来源', '预热缓存命中（数据仍现查）');
      return { layout: cached.layout, playReveal: false };
    }

    if (!GFI.Warm.pending(key)) {
      // 没有正在跑的预热
      const t0 = performance.now();
      const data = await (fetching || beginFetch());
      if (!data || !data.nodes.length) return { layout: null, playReveal: false };
      const waited = performance.now() - t0;   // 已经等掉的时间

      const sync = GFI.Warm.settleNow(data.nodes, data.links, req);
      if (sync) {
        GFI.Overlay.record('布局来源',
          `同步抢跑 ${sync.costMs}ms（查库等待 ${Math.round(waited)}ms）`);
        return { layout: sync.layout, playReveal: true };
      }
      GFI.Overlay.record('布局来源', '抢跑超预算，回退即时沉降');
      return { layout: null, playReveal: true };
    }

    // 预热正在跑
    console.log('[GFI] 预热正在跑，等它跑完再装载（loader 亮着）');
    GFI.Overlay.record('布局来源', '等待后台预热完成');
    const entry = await GFI.Warm.pending(key);
    return { layout: entry ? entry.layout : null, playReveal: true };
  }

  async function mountGraph() {
    if (graphApi || booting) return;
    booting = true;
    try {
      // 挂起查库
      let fetching = beginFetch();

      // 立刻挂载并藏掉原生图谱
      graphApi = GFI.Main.boot({
        nodes: [],
        links: [],
        onNodeActivate: activateNode,
      });

      if (!graphApi) { booting = false; return; }

      let layout = null;
      let playReveal = false;
      try {
        const got = await acquireLayout(fetching);
        layout = got.layout;
        playReveal = got.playReveal;
      } catch (e) {
        console.error('取布局失败，按即时沉降走', e);
      }

      // 等待期间图谱视图可能被关掉
      if (!graphApi || !graphApi.alive) {
        console.log('取布局期间 overlay 已失效');
        return;
      }

      // 数据现查
      let data = lastRaw || (await fetching);
      if (!lastRaw) {
        if (!data || !data.nodes.length) {
          try { data = await beginFetch(); } catch (e) { data = null; }
        }
      }
      fetching = null;
      if (!graphApi || !graphApi.alive) { booting = false; return; }   // 期间被拆掉了

      // 没有数据
      if (!data || !data.nodes.length) {
        console.warn('[GFI] 数据为空 —— 图谱会停在加载态');
        return;
      }
      lastRaw = data;

      // 灌布局或即时沉降
      if (layout) {
        const res = graphApi.setData(data.nodes, data.links, { layout, reveal: playReveal });
        if (res && !res.warm) {
          console.log(`[GFI] 布局只命中 ${res.adopted}/${res.n} —— 库已变化，本次按即时沉降走`);
        }
        return;
      }

      startPrewarm('本次未命中，后台补一份');

      graphApi.setData(data.nodes, data.links);
    } catch (e) {
      console.error('[GFI] 挂载失败', e);
    } finally {
      booting = false;
    }
  }

  // 重新拉一次数据并重建图谱
  GFI.reloadData = async function reloadData() {
    if (!graphApi) return null;
    afterDataChanged('reloadData');
    const data = await GFI.DataSource.fetchData({
      source: ((GFI.config.runtime || {}).dataSource),
      demoCount: ((GFI.config.runtime || {}).demoCount),
      includeParentLinks: false,
    });
    lastRaw = data;
    if (graphApi) graphApi.setData(data.nodes, data.links);
    startPrewarm('reload 之后');
    return data;
  };

  /**
   * 运行时开关侧边栏页面图谱的接管。
   */
  GFI.setSidebarEnabled = function setSidebarEnabled(on) {
    GFI.config.sidebar = GFI.config.sidebar || {};
    GFI.config.sidebar.enabled = !! on;
    if (!on) {
      unmountSidebar('disabled by user');
      console.log('[GFI] 侧边栏页面图谱：已关闭接管');
    } else {
      sbRetryAt = 0;             // 清掉冷却，下一轮扫描立刻尝试
      scheduleScan();
      console.log('[GFI] 侧边栏页面图谱：已开启接管');
    }
    return GFI.config.sidebar.enabled;
  };


  // 侧边栏
  const _reloadData = GFI.reloadData;
  GFI.reloadData = async function reloadDataAndSidebar() {
    // 库变了 → "这一页不可接管"这个结论可能已经不成立（比如它刚被连上一条线）。
    // 清掉无限冷却，让侧边栏重新试一次。
    sbRetryAt = 0;
    const fresh = await _reloadData();
    try { await reloadSidebarGraph(!fresh); } catch (e) { }
    return fresh;
  };

  // 用上一次原始数据重建管线
  GFI.rebuild = function rebuild() {
    if (!graphApi || !lastRaw) return null;
    afterDataChanged('rebuild');
    graphApi.setData(lastRaw.nodes, lastRaw.links);
    startPrewarm('rebuild 之后');
    return lastRaw;
  };

  // 库变后自动刷新机制
  const graphRefresh = GFI.LiveWatch.createScheduler({
    debounceMs: 1500,
    isMounted: () => !!((graphApi && graphApi.alive) || (sbApi && sbApi.alive)),
    refresh: (reason) => {
      console.log(`[GFI] 检测到内容变动 - ${reason || ''},刷新图谱数据`);
      return GFI.reloadData();
    },
  });

  function unmountGraph() {
    graphRefresh.cancel();       // 图谱都关后排队中的刷新没意义
    if (graphApi) {
      graphApi.destroy('graph view closed');
      graphApi = null;
    }
    lastRaw = null;
  }

  // 节点点击 → 在 Logseq 里打开页面
  function activateNode(node) {
    if (!node) return;
    const L = window.logseq;
    if (!L || !L.App) return;
    const name = node.pageName || node.label;
    try {
      if (name) L.App.pushState('page', { name }, {});
    } catch (e) {
      console.warn('[GFI] 跳转失败', e);
    }
  }

  // 右侧边栏的页面图谱
  let sbApi = null;              // 侧边栏那个图谱实例
  let sbPageKey = '';            // 建它时用的那一页
  let sbAbsentScans = 0;
  let sbBooting = false;
  let sbCheckInFlight = false;
  let sbCheckedAt = 0;

  // 缓存
  const SIDEBAR_RETRY_MS = 3000;
  let sbRetryAt = 0;

  const sbListeners = GFI.util.createListenerRegistry();

  // 取当前页实体
  async function currentPageEntity() {
    const L = window.logseq;
    try {
      if (L && L.Editor && L.Editor.getCurrentPage) {
        const p = await L.Editor.getCurrentPage();
        return p || null;
      }
    } catch (e) {  }
    return null;
  }

  // 判断当前页变了没有
  function pageKeyOf(page) {
    if (!page) return '';
    const id = page.id !== undefined ? page.id
      : (page['db/id'] !== undefined ? page['db/id'] : page.dbId);
    const name = page.name || page.title || page.originalName || '';
    return String(id === undefined ? '' : id) + '|' + String(name).trim().toLowerCase();
  }


  async function loadSidebarSlice(forceFetch) {
    let data = forceFetch ? null : lastRaw;
    if (!data || !data.nodes.length) {
      data = await GFI.DataSource.fetchData({
        source: ((GFI.config.runtime || {}).dataSource),
        demoCount: ((GFI.config.runtime || {}).demoCount),
        includeParentLinks: false,
      });
    }
    if (!data || !data.nodes || !data.nodes.length) return null;
    const page = await currentPageEntity();
    return { nb: GFI.DataSource.pageNeighborhood(data, page), page };
  }

  function settleSidebar(nb) {
    try {
      if (!GFI.Warm || !GFI.Warm.settleNow) return null;
      const entry = GFI.Warm.settleNow(nb.nodes, nb.links,
        { source: 'sidebar', demoCount: 0 }, { noCache: true });
      return entry && entry.layout ? entry.layout : null;
    } catch (e) {
      console.warn('[GFI] 侧边栏同步沉降失败，按即时沉降走', e);
      return null;
    }
  }

  function sidebarEnabled() {
    const c = GFI.config.sidebar;
    return !(c && c.enabled === false);
  }

  function sidebarMinNodes() {
    const c = GFI.config.sidebar || {};
    return c.minNodes === undefined ? 2 : c.minNodes;
  }


  function skipSidebar(reason, permanent) {
    console.log('[GFI] 侧边栏页面图谱不接管：' + reason);
    unmountSidebar('not applicable: ' + reason);
    if (permanent) sbRetryAt = Infinity;
  }

  async function mountSidebar() {
    if (sbApi || sbBooting) return;
    if (!sidebarEnabled()) return;
    const root = GFI.Overlay.findPageGraphRoot();
    if (!root) return;
    sbBooting = true;

    sbRetryAt = GFI.util.now() + SIDEBAR_RETRY_MS;

    sbApi = GFI.Main.boot({
      root,
      nodes: [],
      links: [],
      primary: false,
      // 560px 宽塞不下工具栏和时间轴
      chrome: { toolbar: false, timeline: false },
      // 留白走侧边栏自己那条线
      fitPad: 'sidebar',
      onNodeActivate: activateNode,
    });
    if (!sbApi) { sbBooting = false; return; }

    try {
      // ---- ② 取数（这段时间加载屏亮着）----
      const got = await loadSidebarSlice();

      // 面板可能在等数据期间被关掉、被 React 换掉，或者我们已经被别的路径拆了
      if (!sbApi) { sbBooting = false; return; }
      if (!sbApi.alive) { unmountSidebar('overlay detached'); sbBooting = false; return; }
      if (sbApi.root !== root) { unmountSidebar('panel replaced'); sbBooting = false; return; }

      if (!got) { skipSidebar('取不到数据（本次按暂时失败处理，稍后重试）', false); return; }
      const { nb, page } = got;

      // 只有中心节点一个（孤立页）时不接管 —— 原生那块至少还能让用户拖一拖看个位置
      if (!nb.centerId) { skipSidebar(nb.reason, true); return; }
      if (nb.nodes.length < sidebarMinNodes()) {
        skipSidebar(`邻域只有 ${nb.nodes.length} 个节点（< ${sidebarMinNodes()}）`, true);
        return;
      }

      sbPageKey = pageKeyOf(page);
      sbRetryAt = 0;            

      const layout = settleSidebar(nb);

      sbApi.setData(nb.nodes, nb.links, layout ? { layout, reveal: false } : undefined);
      GFI.Overlay.record('侧边栏页面图谱接管',
        `${nb.nodes.length} 节点/${nb.links.length} 边，中心命中方式=${nb.hitBy}`
        + `${layout ? '，同步沉降一步到位' : '，即时沉降'}`);
      console.log(`[GFI] 侧边栏页面图谱接管：${nb.nodes.length} 节点 / ${nb.links.length} 边`
        + `（中心命中方式 ${nb.hitBy}${layout ? '，一步到位' : '，即时沉降'}）`);
    } catch (e) {
      console.error('[GFI] 侧边栏页面图谱挂载失败', e);
      skipSidebar('挂载异常：' + ((e && e.message) || e), false);
    } finally {
      sbBooting = false;
    }
  }

  /** 同一个面板、换了一页 → 就地换数据（位置按 id 继承，不会跳回随机） */
  async function reloadSidebarGraph(forceFetch) {
    if (!sbApi || !sbApi.alive) return;
    const got = await loadSidebarSlice(forceFetch);
    if (!got || !sbApi || !sbApi.alive) return;
    const { nb, page } = got;
    if (!nb.centerId) {
      // 新页在过滤后的图谱里压根没有 → 保留上一张图，别让它闪成空白
      console.log(`[GFI] 侧边栏页面图谱：新页取不到中心节点（${nb.reason}），保留上一张`);
      sbPageKey = pageKeyOf(page);
      return;
    }
    sbPageKey = pageKeyOf(page);

    const layout = settleSidebar(nb);
    sbApi.setData(nb.nodes, nb.links, layout ? { layout, reveal: false } : undefined);
    console.log(`[GFI] 侧边栏页面图谱已跟随换页：${nb.nodes.length} 节点 / ${nb.links.length} 边`
      + `${layout ? '（一步到位）' : '（即时沉降）'}`);
  }

  function checkSidebarPage(force) {
    if (!sbApi || !sbApi.alive || sbCheckInFlight) return;
    const every = (GFI.config.sidebar && GFI.config.sidebar.pageCheckMs) || 1000;
    if (!force && GFI.util.now() - sbCheckedAt < every) return;
    sbCheckedAt = GFI.util.now();
    sbCheckInFlight = true;
    currentPageEntity().then((page) => {
      sbCheckInFlight = false;
      if (!sbApi || !sbApi.alive) return;
      if (pageKeyOf(page) === sbPageKey) return;
      reloadSidebarGraph();
    }).catch(() => { sbCheckInFlight = false; });
  }

  function unmountSidebar(reason) {
    if (sbApi) {
      sbApi.destroy(reason || 'sidebar page graph closed');
      sbApi = null;
    }
    sbPageKey = '';
    sbCheckedAt = 0;
    sbAbsentScans = 0;
  }

  function scanSidebar() {
    const root = GFI.Overlay.findPageGraphRoot();
    if (root) {
      sbAbsentScans = 0;
      // 陈旧实例守卫 —— 判据和主图谱那条一样：看【容器】还连不连着
      if (sbApi && !sbApi.alive) {
        sbApi.destroy('overlay detached');
        sbApi = null;
        sbPageKey = '';
      }
      if (!sbApi) {
        // ⚠ 冷却必须在 mountSidebar 之外也判一次 —— 它是"别每 32ms 查一遍库"
        //   这道闸门的真正位置（mountSidebar 内部也会设它，但那只在真跑起来之后）。
        if (sidebarEnabled() && GFI.util.now() >= sbRetryAt) mountSidebar();
      } else {
        checkSidebarPage(false);
      }
    } else if (sbApi) {
      if (++sbAbsentScans >= ABSENT_SCANS_TO_UNMOUNT) {
        sbAbsentScans = 0;
        unmountSidebar('sidebar page graph closed');
      } else {
        scheduleScan();          // 自己续下一次扫描，理由同主图谱那条
      }
    } else {
      // 面板不在、我们也没接管
      sbRetryAt = 0;
    }
  }

  // 翻页了
  function sidebarOnMaybePageChanged() {
    if (sbApi && sbApi.alive) { checkSidebarPage(true); return; }
    sbRetryAt = 0;
    scheduleScan();
  }

  // Logseq 用 hash 路由
  function startSidebarRouteWatch() {
    const w = GFI.topWin;
    if (!w) return;
    try {
      sbListeners.add(w, 'hashchange', sidebarOnMaybePageChanged);
    } catch (e) { /* 挂不上就只靠轮询 */ }
  }

  // 扫描容错次数
  const ABSENT_SCANS_TO_UNMOUNT = 3;
  // 当前扫描累计
  let absentScans = 0;

  function scan() {
    scanTimer = null;
    try {
      // 侧边栏扫描
      scanSidebar();

      // #global-graph 存在检测
      if (graphRootPresent()) {
        if (graphApi && !graphApi.alive) {
          graphApi.destroy('overlay detached');
          graphApi = null;
        }
        absentScans = 0;

        // 挂载
        mountGraph();
      } else if (graphApi) {
        // 连续扫三次
        if (++absentScans >= ABSENT_SCANS_TO_UNMOUNT) {

          absentScans = 0;
          // 卸载
          unmountGraph();
        } else {
          // 32ms 后执行 scan()
          scheduleScan();
        }
      }
    } catch (e) {
      console.error('[GFI] scan 出错', e);
    }
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(scan, SCAN_THROTTLE_MS);
  }

  function startObserver() {
    scan();
    observer = new GFI.topWin.MutationObserver((muts) => {
      scheduleScan();
      try {
        graphRefresh.notify(muts, 'DOM 内容变动');
      } catch (e) { 

      }
    });
    observer.observe(GFI.topDoc.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (scanTimer !== null) { clearTimeout(scanTimer); scanTimer = null; }
    graphRefresh.cancel();
  }

  // 把 Logseq 设置同步进 GFI.config
  function applySettings(s) {
    // logseq.settings
    s = s || {};
    // 读取语言
    s.__langRaw = s.language;
    // 拿到设置的初始语言
    const before = GFI.i18n ? GFI.i18n.get() : '';

    // config.js的参数配置函数
    GFI.syncSettings(s);
    // 拿到之后的函数
    const after = GFI.i18n ? GFI.i18n.get() : '';

    const d = GFI.__langDiag || {};

    console.log(`[GFI] 语言存档=${JSON.stringify(d.存档原始值)}(${typeof d.存档原始值})`
      + ` → 归一化=${after} → 生效面板=${after === 'en' ? 'English' : '中文'}`
      + (before !== after ? `（由 ${before || '?'} 切换而来，将重新注册面板 schema)` : '')
      + (d.写回 && d.写回 !== d.存档原始值 ? `已把存档纠正为 ${JSON.stringify(d.写回)}` : ''));

    // 切换语言
    if (before !== after) registerSettingsSchema(`语言切到 ${after}`);
  }

  // 已注册的语言
  let registeredLang = '';

  // 重入闸门
  let registeringSchema = false;

  // 语言切换
  function registerSettingsSchema(reason) {
    // 未挂载
    if (!GFI.i18n || !GFI.settingsSchema) return false;
    // 防止堵塞
    if (registeringSchema) return false;
    registeringSchema = true;
    try {
      // 按当前语言重新编译
      const schema = GFI.i18n.schema();     

      // 配置项注册
      logseq.useSettingsSchema(schema);
      registeredLang = GFI.i18n.get();
      console.log(`[GFI] 已注册设置面板 schema(${reason || ''})`
        + `语言=${registeredLang}首条=${schema[0] && schema[0].key}`
        + `标题示例=${schema[1] && schema[1].title}`);
      return true;
    } catch (e) {
      console.warn('[GFI] 注册设置面板 schema 失败', e);
      return false;
    } finally {
      registeringSchema = false;
    }
  }


   // 就地改写设置面板文案
  function scheduleRelabel(reason) {
    if (!GFI.i18n || !GFI.i18n.relabelPanel) return;
    let tries = 0;
    let lastHits = -1;
    const tick = () => {
      const hits = GFI.i18n.relabelPanel();
      tries++;
      if (hits === 0 && lastHits === 0) {
        console.log(`[GFI] 语言面板文案已就位（${reason || ''}，补写 ${tries} 次）`);
        return;
      }
      lastHits = hits;
      if (tries < 20) setTimeout(tick, 250);
      else console.warn(`[GFI] 语言面板文案补写 ${tries} 次仍未全部命中 —— 面板结构可能变了`);
    };
    setTimeout(tick, 120);   // 先等 Logseq 自己那一次渲染落定
  }

  // 判断斥力、连接线长、节点大小是否变化
  function layoutSignature() {
    const c = GFI.config;
    return c.physics.charge + '|' + c.physics.linkDistance + '|' + c.render.nodeSize;
  }

  // 过滤变化判断
  function filterSignature() {
    const d = GFI.config.data;
    return [d.hideSystemJournal, d.hideSystemPages, d.hideNames.join(',')].join('|');
  }

  GFI.onFreshSettings = function onFreshSettings(values) {
    try {
      if (window.logseq && window.logseq.updateSettings && values) {
        window.logseq.updateSettings(values);
      }
    } catch (e) {
      console.warn('[GFI] 写回配置失败', e);
    }
  };

  // 语言面板文案的手动补写
  try {
    if (GFI.topWin) {
      GFI.topWin.__GFI_RELABEL__ = function () {
        if (!GFI.i18n) return 'i18n 未加载';
        const n = GFI.i18n.relabelPanel();
        console.log(`[GFI] 面板文案改写 ${n} 条（扫描了 ${GFI.__relabelStat && GFI.__relabelStat.scanned} 个叶子节点）`);
        return n;
      };
      GFI.topWin.__GFI_LANG__ = function (v) {
        if (!GFI.i18n) return 'i18n 未加载';
        const now = GFI.i18n.set(v);
        console.log(`[GFI] 语言 → ${now}；面板文案改写 ${GFI.i18n.relabelPanel()} 条`);
        return now;
      };

      // 侧边栏页面图谱的控制台入口
      GFI.topWin.__GFI_SIDEBAR__ = {
        /** 侧边栏留白（每边 CSS px）：fit() 查询当前值，fit(64) 设置并立刻重适配 */
        fit: (px) => (GFI.setSidebarFitPadding ? GFI.setSidebarFitPadding(px) : null),
        /** 接管开关：on() / off() 退回原生图谱 */
        on: () => (GFI.setSidebarEnabled ? GFI.setSidebarEnabled(true) : null),
        off: () => (GFI.setSidebarEnabled ? GFI.setSidebarEnabled(false) : null),
        /** 现在是什么状态 */
        state: () => {
          const api = GFI.getSidebarGraph ? GFI.getSidebarGraph() : null;
          const panel = GFI.Overlay.findPageGraphRoot && GFI.Overlay.findPageGraphRoot();
          return {
            面板在不在: !!panel,
            接管中: !!(api && api.alive),
            留白设置: (GFI.config.sidebar || {}).fitPadding,
            留白实际生效: api && api.alive ? api.fitPadding : null,
            节点数: api && api.alive ? api.data.n : null,
            当前页: sbPageKey || null,
          };
        },
      };
      console.log('[GFI] 侧边栏控制台入口：__GFI_SIDEBAR__.state() 看状态，'
        + '__GFI_SIDEBAR__.fit(px) 调视野留白，__GFI_SIDEBAR__.off() 退回原生');
    }
  } catch (e) { }

  function start() {
    try {
      applySettings(window.logseq && window.logseq.settings);
      startObserver();
      startSidebarRouteWatch();
      startPrewarm('插件启动');
    } catch (e) {
      console.error('[GFI] 启动失败', e);
    }
  }

  if (typeof logseq !== 'undefined' && logseq.ready) {
    if (logseq.beforeunload) {
      logseq.beforeunload(async () => {
        stopObserver();
        unmountGraph();
        unmountSidebar('plugin unloading');
        try { sbListeners.removeAll(); } catch (e) { }
        // 摘 Pixi 钩子
        try { GFI.Overlay.releasePixiCapture(); } catch (e) { }
      });
    }

    logseq.ready().then(() => {
      try {
        // 读设置确定语言后注册 schema
        applySettings(logseq.settings);

        // 配置项注册
        registerSettingsSchema('启动');

        // 设置在同步完后启动预热
        try { startPrewarm('logseq ready'); } catch (e) { console.warn('[GFI] 预热启动失败', e); }

        // 监听回调
        logseq.onSettingsChanged((s) => {
          // 改之前的状态
          const wasNative = GFI.getGraph() && GFI.getGraph().nativeMode;
          const beforeLayout = layoutSignature();
          const beforeFilter = filterSignature();
          const beforeSource = prewarmKey();
          //  语言要在 applySettings 前取
          const beforeLang = GFI.i18n ? GFI.i18n.get() : '';

          applySettings(s);

          // 当前图谱实例
          const g = GFI.getGraph(); 

          if (g && !!GFI.config.useNativeGraph !== !!wasNative) {
            g.setNativeMode(!!GFI.config.useNativeGraph);
            // 切换原生图谱
            if (GFI.config.useNativeGraph) afterDataChanged('切到原生图谱');
            else startPrewarm('切回我们的图谱');
          }
          if (g && layoutSignature() !== beforeLayout) GFI.rebuild();
          if (filterSignature() !== beforeFilter) {
            afterDataChanged('过滤规则已变');
          }
          if (prewarmKey() !== beforeSource) {
            afterDataChanged('数据源已变');
            startPrewarm('数据源已变');
          }
          // 更改语言
          if (beforeLang !== GFI.i18n.get()) {
            scheduleRelabel('语言切换');
          }
        });
      } catch (e) {
        console.error('设置注册失败', e);
      }
      setTimeout(start, 300);
    }).catch(console.error);
  } else {
    setTimeout(start, 300);
  }
})();
