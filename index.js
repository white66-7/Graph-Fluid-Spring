/*
 * 这个文件只做三件事：
 *   1. 注册设置面板 + 同步设置
 *   2. 监听 #global-graph 的【出现与消失】，挂载 / 拆卸渲染器
 *   3. 把节点点击接到 Logseq 的页面跳转
 */
(function () {
  'use strict';

  const GFI = window.GFI;
  if (!GFI) { console.error('[GFI] src/ 未加载，检查 index.html 的脚本顺序'); return; }

  // 扫描节流（ms）。决定「宿主把 #global-graph 挂上 DOM」到「我们接管」之间
  // 隔多久 —— 也就是**原生图谱能露脸多久**。
  //
  // ⚠ 这个数字是实机量出来的，不是猜的。用户实测时序（2026-10）：
  //     1424ms 宿主挂上图谱 DOM
  //     1574ms 原生 Pixi 起画（原生图谱此刻已经能看）   ← 中间 150ms 是宿主自己的
  //     1671ms overlay 挂载完成
  //     1674ms 隐藏原生图谱（我们接管）                 ← 我们这边迟了 97ms
  //   那 97ms 里原生图谱是可见的。其中最大的一块就是这里：原值 120ms 的节流，
  //   DOM 变动到 scan() 之间要等一整个节流窗口。
  //
  // 为什么可以调小：scan() 只在【没挂载】时才真的干活（querySelector + mountGraph），
  //   已挂载时是一次 querySelector 加一个早退 —— 不是重活。真正贵的是
  //   mountGraph 里的建管线，那有 graphApi / booting 两道闸。
  // 为什么留 32ms 而不是 0：节流本身不能去掉。Logseq 的 React 重渲染会连续产生
  //   几百条 mutation，不合并的话每条都要查一次 DOM。
  const SCAN_THROTTLE_MS = 32;

  let graphApi = null;
  let observer = null;
  let scanTimer = null;
  let booting = false;
  // 预热重试退避表（见 startPrewarm 末尾）。
  //
  // ⚠ 第一档 1200ms 是贴着实测量的：Logseq 的 `app-init-spent-time` 是
  //   1121~1162ms，之前所有预热尝试都撞在它之前（11 条
  //   `db-worker has not been initialized`）。取 800ms 时第 1 次重试仍然太早，
  //   白白烧掉一档退避预算。
  // 跑完这张表还没成功就不再打扰（避免永久空库的图谱被反复查库刷日志）。
  const PREWARM_RETRY_DELAYS = [1200, 2500, 5000, 10000];
  let prewarmAttempts = 0;
  // 上一次拉到的原始数据（节点/边，未经 Data.build）。
  // 改「斥力 / 连接线长度 / 节点大小」这类【在 Data.build 里烘死】的参数时，
  // 用它就地重建管线即可，不必再查一次库。见 GFI.rebuild()。
  let lastRaw = null;

  // 检测图谱视图
  function graphRootPresent() {
    try {
      return !!GFI.Overlay.findRoot();
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 布局预热（见 src/warm.js）
  // ---------------------------------------------------------------------------
  // 为什么在这里：图谱视图打开前把沉降跑完，进图谱的第一帧就是最终布局，
  // 于是「原生图谱 → 种子螺旋 → 缓动适配视野」三段里后两段一起消失。
  //
  // ⚠ 预热只在【本插件启动之后】开始，而且分帧跑（一帧 ≤ config.warm.budgetMs）。
  //   它不是必须成功的功能：没跑完 / 跑失败，图谱照旧即时沉降，
  //   只是会看到那两段观感。
  //
  // ⚠⚠ 缓存 key 的默认值只有【一处】来源：`GFI.Warm.DEFAULTS`，
  //   由 `GFI.Warm.normReq()` 统一归一化。这里不再自己写一份兜底值 ——
  //   实机事故就是"两处各自有默认值、却互不相等"造成的：
  //   warm.js 里是 `demoCount || 0`，这里是 `|| 400`，于是
  //   `keyOf({})` 给 `logseq:0`、`keyOf(prewarmRequest())` 给 `logseq:400`，
  //   预热写进去的缓存永远 peek 不到（用户连点两次图谱都走"同步抢跑"）。
  //   所以这里只负责取原始配置，归一化交给 warm.js。
  //
  // ⚠⚠⚠ 路径是 `runtime.dataSource`，不是 `dataSource`。
  //   实机日志 `预热启动 source=undefined demoCount=undefined` 的**真正原因**
  //   就是把它们写成了 `cfg.dataSource` / `cfg.demoCount` —— 这两项一直挂在
  //   `cfg.runtime` 下面。读错一层不会崩，只会**静默走默认值**，
  //   而默认值恰好是 'logseq' / 400，于是"看起来全对"、连缓存 key 都对得上，
  //   只是用户改了数据源也永远不生效。三处读者（这里 / beginFetch /
  //   main.js 的 __GFI__.prewarm）一起修了。
  function prewarmRequest() {
    const rt = (GFI.config && GFI.config.runtime) || {};
    return { source: rt.dataSource, demoCount: rt.demoCount };
  }

  // ===========================================================================
  // 等 DB 就绪再预热 —— 门控来自对 Logseq 宿主源码的白盒对照
  // ===========================================================================
  // 为什么需要门控（而不是"失败就重试"）：
  //   `js/main.js` 里宿主自己的实现是
  //       Rs = function(a,b){ var c = mb(fw);
  //            if (c == null) throw Fg("db-worker has not been initialized", ...) }
  //   而插件桥 `logseq.api.datascript_query` **直接落到 Rs** —— 所以 DB 没就绪时
  //   每一次查询都会抛出那个错，并在控制台留下一条 `<invoke-db-worker-error …>`。
  //   盲目重试一轮就是 15 条，把控制台刷满。
  //
  // 就绪标志从哪来：同一个文件里，`q` 的桥接是
  //       ja("logseq.api.q", function(a){ var b = Vs(); return m(b) ? … : null })
  //   而 `Vs = ft.J(dh())` —— 取的就是 db-worker 连接（同一批里 `ft` 也被
  //   `tbb` 用 `Ss(ft,a)` 直接写）。也就是说：
  //       `DB.q(...)` 返回非 null  ⇒  连接已建立  ⇒  可以查库了
  //   而未就绪时它**返回 null、不抛**，所以这个探针不会产生任何报错日志。
  //   （对照：`DB.datascriptQuery` 走的是会抛的那条，绝不能拿来当探针。）
  //
  // ⚠ 插件桥并没有暴露官方的就绪事件 —— 我给 `lsplugin.core.js` 里 `logseq.DB`
  //   的全部成员做了枚举，只有 `onBlockChanged` 和 `datascriptQuery` 两个；
  //   宿主的 `wait-db-worker-ready-*` 是内部 watch，桥外面够不着。
  //   所以这里用"静默探测 + 超时兜底"替代它，并让超时兜底退回原来的退避路径。
  // ⚠ `q` 这条判据是"白盒读出来的"，但仍属于【推理】：万一它在健康库上也返回
  //   null（比如宿主某次改版改了包裹方式），门控就会永远不开、预热永远不启动。
  //   所以下面给它一个很短的耐心窗口（DB_PROBE_PATIENCE_MS）——到点就不再拦，
  //   把控制权交回退避路径。退避本来就有上限，所以最坏情况只是"多几次重试 +
  //   几条报错"，而不是"预热彻底不工作"。
  // ⚠⚠ 这里的判据必须 **await**，不能只看返回值是不是 null。
  //
  //   踩过的坑：`DB.q` 在 SDK 里是
  //       _execCallableAPIAsync(e,...t){ return this._caller.callAsync("api:call", …) }
  //   —— **它永远返回 Promise**。所以 `r !== null && r !== undefined` 拿到的是
  //   一个 Promise 对象（truthy），探测"立刻成功"，门控形同虚设，还在控制台留下
  //   一条 `Uncaught (in promise)`。实机日志：
  //       预热启动（logseq ready）…        ← 没有"等 DB 就绪"这一行
  //       index.html?__v__=1.0.5:1 Uncaught (in promise) Object
  //       <invoke-db-worker-error :thread-api/query-dsl-query>
  //   正确判据是"这次查询真的 resolve 了" —— 异常/拒绝就是还没就绪。
  // ⚠ 耐心窗口现在是【总时长】，不随调用次数重置 —— 否则退避重试会让它无限延长。
  const DB_PROBE_INTERVAL_MS = 250;
  const DB_PROBE_PATIENCE_MS = 4000;

  let dbReady = false;
  let dbProbeDeadline = 0;   // 0 = 还没开始计时
  let dbProbeWaiting = false;

  /**
   * 一次静默探测。**绝不抛、绝不刷日志、绝不留下未处理的拒绝。**
   * @returns {Promise<boolean>} true = DB 已就绪
   */
  async function probeDbReady() {
    if (dbReady) return true;
    const L = window.logseq;
    if (!L || !L.DB || typeof L.DB.q !== 'function') return false;
    let r;
    try {
      // 这个查询在空库上 resolve 成 []，所以"能 resolve"就是干净的判据。
      // 未就绪时它是 reject（宿主抛 db-worker has not been initialized）。
      r = await L.DB.q('[:find ?e :where [?e :block/uuid]]');
    } catch (e) {
      return false;          // 未就绪，安静
    }
    // 极老/未来版本的桥可能同步返回（不是 Promise）—— 那种情况非 null 就算就绪
    if (r === null || r === undefined) return false;
    dbReady = true;
    return true;
  }

  /**
   * 等 DB 就绪（最多 DB_PROBE_PATIENCE_MS 总时长），然后开始预热。
   *
   * ⚠ 这是**正常路径上唯一的**预热启动入口。任何"直接开跑"的路径都会在 DB
   *   没就绪时产生十几条宿主报错 —— 那正是要修的东西。
   */
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
    if (dbProbeWaiting) return;      // 已经有人在轮询了，复用
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
  // ===========================================================================

  /**
   * 预热相关配置的自检 —— 只在启动时喊一次。
   *
   * 为什么值得单独一段：`source` / `demoCount` 落进默认值不会报错、不会崩，
   * 只会让预热**静默**失效（缓存 key 与运行时用的一致，所以不报错，
   * 但"用户改过数据源却没生效"是看不出来的）。把实际读到的东西打出来，
   * 才能定位到"到底是哪个配置项没读到"。
   */
  let prewarmDiagDone = false;
  function prewarmDiag() {
    if (prewarmDiagDone) return;
    prewarmDiagDone = true;
    const cfg = GFI.config || {};
    const rt = cfg.runtime || {};
    const req = prewarmRequest();
    const suspicious = [];
    if (!GFI.Warm) suspicious.push('GFI.Warm 未加载');
    if (cfg.useNativeGraph === undefined) suspicious.push('config.useNativeGraph 缺失');
    if (rt.dataSource === undefined) suspicious.push('config.runtime.dataSource 缺失（会兜底成 logseq）');
    if (rt.demoCount === undefined) suspicious.push('config.runtime.demoCount 缺失（会兜底成 400）');
    if (cfg.warm === undefined) suspicious.push('config.warm 缺失');
    if (cfg.physics === undefined) suspicious.push('config.physics 缺失');
    const line = `[GFI] v${GFI.VERSION} 配置自检　useNativeGraph=${!!cfg.useNativeGraph}`
      + ` runtime.dataSource=${JSON.stringify(rt.dataSource)} runtime.demoCount=${JSON.stringify(rt.demoCount)}`
      + ` → 实际用 ${GFI.Warm ? GFI.Warm.keyOf(req) : '?'}`
      + `　warm=${JSON.stringify(cfg.warm)}`
      + `  logseqAPI=${typeof window.logseq !== 'undefined'}`
      + `　顶层键=[${Object.keys(cfg).join(',')}]`;
    if (suspicious.length) console.warn(line + '　⚠ ' + suspicious.join(' / '));
    else console.log(line);
  }

  /** 预热指纹，用来判断「数据源 / 演示图规模」有没有变（缓存能不能接着用） */
  function prewarmKey() {
    return GFI.Warm ? GFI.Warm.keyOf(prewarmRequest()) : '';
  }

  /** startPrewarm 的调用方。只有 '空结果重试*' 允许在"已有缓存"之后仍然跑
   *  （其实不需要，见下），其余一律受幂等闸门约束。 */
  function startPrewarm(reason, opts) {
    opts = opts || {};
    prewarmDiag();
    const why = (m) => { console.log(`[GFI] 预热不启动（${reason || '?'}）：${m}`); return null; };
    if (!GFI.Warm) return why('GFI.Warm 未加载 —— 检查 index.html 的脚本顺序');
    if (GFI.config.useNativeGraph) return why('设置里选了原生图谱');

    // ---- 幂等闸门 ----
    // ⚠⚠ 这道闸门是必须的，实机日志证明不加就会出结构性事故：
    //     预热启动（logseq ready）→ 0 节点 → 800ms 后第 1 次重试
    //     预热启动（插件启动）    → 0 节点 → 1500ms 后第 2 次重试   ← 第二条链
    //     预热启动（空结果重试#2）→ 成功
    //     预热启动（空结果重试#0）→ 又成功一遍（白跑一遍完整的查库 + 沉降）
    //   两个调用方（logseq.ready 与 start() 的 300ms 超时）各起一条退避链，
    //   共享同一个计数器 → 序号互相串台、退避预算被平白消耗、DB 就绪后还会
    //   重复预热。有了闸门之后，任何一次重入都只会复用进行中的那一个 Promise。
    const key = prewarmKey();
    if (GFI.Warm.peek(key)) return why('已经有现成的布局缓存');
    if (GFI.Warm.pending(key)) return why('已经有一个预热在跑（复用它的 Promise）');

    // ---- DB 就绪门控（见 waitForDb 的说明）----
    // ⚠ 这是修"报错刷屏"的那一步。DB 没就绪时 `fromLogseq` 会发 15 条查询、
    //   全被宿主拒绝，每条都留一行 `<invoke-db-worker-error …>`。
    //   所以**先等就绪，就绪了才查库** —— 一次报错都不产生。
    //   `skipReadyGate` 只给退避重试、以及 waitForDb 就绪后的回调用：
    //   那时判据已经确立，再探一次没意义（而且 probeDbReady 是异步的，
    //   放在这里会把 startPrewarm 变成异步 —— 没必要）。
    if (!opts.skipReadyGate && !dbReady) {
      waitForDb(reason || '启动');
      return null;
    }

    // ⚠ 数据源是 logseq、但 logseq API 还够不着时**不要预热**。
    //   `DataSource.fetchData` 在拿不到 logseq 时会静默退回 demo 合成图 ——
    //   于是预热会认认真真把一张 400 节点的假图跑到沉降、存进缓存，
    //   然后用户进图谱就吃到这份完全不相干的坐标。
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
    // 预热拿到空数据 / 失败时会静默返回 null，然后**什么都不留下**（没有缓存、
    // 也没有在跑的 Promise）—— 于是用户下次进图谱会落到"同步抢跑"而不是
    // "缓存命中"。
    //
    // ⚠ 这段退避现在是**纯兜底**：正常的冷启动已经被上面的 DB 就绪门控挡住了，
    //   所以路径应该是"等就绪 → 一次成功"，不该再看到任何 0 节点重试。
    //   会走到这里的只剩两种情况：
    //     · 门控 20 秒超时（宿主结构变了 / DB 真的起不来）
    //     · 门控认为就绪了、但真查库又失败（比如过滤查询用了宿主不支持的语法）
    //   这两种都值得喊出来，所以这里保留日志与退避。
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
      // ⚠ skipReadyGate：已经过了门控，重试不必再等一轮探测
      setTimeout(() => startPrewarm(`空结果重试#${prewarmAttempts}`, { skipReadyGate: true }), delay);
    });
    return p;
  }

  /**
   * 数据本身变了（reload / rebuild / 改了过滤规则）→ 预热坐标作废。
   *
   * ⚠ 必须在写 lastRaw 的地方调用。坐标是「数据 + 配置」的函数：数据换了而缓存
   *   没换，进图谱就会被 GFI.Data.applyLayout 灌进【另一张图】的坐标 ——
   *   而且因为节点数往往一致，它不会报错，只会画出一张错位的图。
   */
  function afterDataChanged(reason) {
    if (GFI.Warm) GFI.Warm.invalidate(reason);
  }

  /**
   * 单独抓一次数据（不阻塞任何人）。
   *
   * 存在的理由是一个**实机量到的时序事故**：原先把 `fetchData` 放在 `boot()` 之前
   * 的 `acquireLayout` 里串行执行，于是查库那 478ms 期间我们**还没接管** ——
   * 原生图谱整整多露了 478ms：
   *
   *     1833ms 宿主挂上图谱 DOM
   *     1870ms overlay 挂载完成     ← 节流修好了，只用了 37ms
   *     1990ms 隐藏原生图谱
   *     2376ms 数据装载             ← 478ms 全在这里，而这期间是原生图谱在显示
   *
   * 现在改成"先把 fetchData 挂起来（一个字都不 await），再去 boot"。
   * boot 是同步的（挂载 + 量尺寸 + 起循环），所以两件事实质并行 ——
   * 隐藏原生图谱从"查库之后"提前到"查库之前"。
   */
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

  /**
   * 把一份【布局】弄到手。三级，从便宜到贵：
   *
   *   ① 后台预热缓存      —— 命中就零成本（第二次进图谱走这里）
   *   ② 同步抢跑 settleNow —— 有数据、但预热没跑完：在 loader 后面阻塞一小段
   *                          把它跑完（中小库 0.5 秒内），还是零成本呈现
   *   ③ 异步等预热         —— 抢跑超预算（大库）时，只能分帧等它跑完
   *
   * ⚠⚠ **这里只给布局，绝不给数据。** 这是踩过大坑之后立的规矩：
   *   缓存的 `entry.data` 是"预热那一刻"的查库快照。曾经在缓存命中时直接把它
   *   当数据用 —— 结果用户删了页面、改了正文，**图谱永远停在旧数据上再也不更新**，
   *   因为每次打开图谱喂进去的都是同一份快照。
   *   现在：数据一律现查（`beginFetch()`，调用方已经在 boot 之前按下去了），
   *   缓存只提供"每个 id 落在哪里"。
   *   布局缓存本身是按 id 映射的，所以对数据变化是【天然安全】的：
   *     · 删掉的节点：新数据里没有它，自然消失
   *     · 新增的节点：命中不了 → 走"部分命中 = 即时沉降"那条老路径
   *     · 改名的节点：id 不变，位置不变（正是想要的）
   *
   * ⚠ 顺序不能调：必须先试缓存（免费），再试抢跑（便宜），最后才异步等（贵）。
   *   之前只写了 ①③，于是"预热没跑完"的首开必然落到 ③ 甚至 null ——
   *   那正是用户看到的「布局中 → 呈现 → 再适配视角」。
   *
   * @param {Promise} [fetching] beginFetch() 的结果（调用方已经先按下去了）
   * @returns {Promise<{layout:Map|null, playReveal:boolean}>}
   *          playReveal = 布局是【这次现场跑出来的】（首次打开）→ 值得一次淡入；
   *          缓存命中（重新打开）时为 false —— 画面该一模一样地立刻出现。
   */
  async function acquireLayout(fetching) {
    const key = prewarmKey();
    const req = prewarmRequest();

    // ① 缓存命中：只要它的 layout；数据照样现查
    const cached = GFI.Warm.peek(key);
    if (cached) {
      GFI.Overlay.record('布局来源', '预热缓存命中（数据仍现查）');
      return { layout: cached.layout, playReveal: false };
    }

    if (!GFI.Warm.pending(key)) {
      // ② 没有正在跑的预热 —— 用调用方提前按下的那次查库，然后在 loader 后面同步抢跑。
      const t0 = performance.now();
      const data = await (fetching || beginFetch());
      if (!data || !data.nodes.length) return { layout: null, playReveal: false };
      const waited = performance.now() - t0;   // 已经等掉的时间（并行段不算）

      const sync = GFI.Warm.settleNow(data.nodes, data.links, req);
      if (sync) {
        GFI.Overlay.record('布局来源',
          `同步抢跑 ${sync.costMs}ms（查库等待 ${Math.round(waited)}ms）`);
        return { layout: sync.layout, playReveal: true };
      }
      GFI.Overlay.record('布局来源', '抢跑超预算，回退即时沉降');
      return { layout: null, playReveal: true };
    }

    // ③ 预热正在跑：等它的布局。数据同样现查（与它并行）。
    console.log('[GFI] 预热正在跑，等它跑完再装载（loader 亮着）');
    GFI.Overlay.record('布局来源', '等待后台预热完成');
    const entry = await GFI.Warm.pending(key);
    return { layout: entry ? entry.layout : null, playReveal: true };
  }

  async function mountGraph() {
    if (graphApi || booting) return;
    booting = true;
    try {
      // ---- ① 先把查库挂起来（不 await），再去挂载 ----
      // ⚠ 这一行的位置就是这个函数的全部要点：放在 boot() 之后的话，
      //   查库那 400~500ms 里原生图谱是露着的（实机时序见 beginFetch 的注释）。
      //   另外这也是"数据永远新鲜"的保证 —— 见 acquireLayout 的注释。
      let fetching = beginFetch();

      // ---- ② 立刻挂载：原生图谱在 mount 那一刻就被藏掉 ----
      // ⚠ 绝不能"先 await 预热/查库、再 boot" —— 那样在数据到齐之前我们根本
      //   没接管。先 boot（原生已藏 + loader 亮着），再在 loader 后面取布局。
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
        console.error('[GFI] 取布局失败，按即时沉降走', e);
      }

      // 等待期间图谱视图可能被关掉 / 被 React 重渲染清掉
      if (!graphApi || !graphApi.alive) {
        console.log('[GFI] 取布局期间 overlay 已失效，放弃本次装载');
        return;
      }

      // ---- ③ 数据：一律现查 ----
      // ⚠ 绝不能退回"用缓存里的数据"。那正是"删了页面图谱也不更新"的原因。
      //   缓存条目里现在【没有 data 字段】了 —— 这是刻意的结构约束：
      //   想误用也没有东西可误用（见 acquireLayout 的注释）。
      let data = lastRaw || (await fetching);
      if (!lastRaw) {
        // 走到这里说明 acquireLayout 是走"缓存命中"或"等预热"回来的（都没查库），
        // 而本次 beginFetch 又抛了/返回空。补一次同样的查询尝试把数据弄到手。
        if (!data || !data.nodes.length) {
          try { data = await beginFetch(); } catch (e) { data = null; }
        }
      }
      fetching = null;
      if (!graphApi || !graphApi.alive) { booting = false; return; }   // 期间被拆掉了
      if (!data || !data.nodes.length) {
        console.warn('[GFI] 数据为空 —— 图谱会停在加载态（loader 亮着）');
        return;
      }
      lastRaw = data;

      // ---- ④ 有布局就灌布局，没有就即时沉降 ----
      if (layout) {
        // reveal 只在【布局是这次现场跑出来的】时给：
        //   · 同步抢跑 / 等后台预热 = 用户第一次打开 → 从空白淡入 0.3 秒
        //   · 预热缓存命中          = 用户重新打开 → 一模一样地立刻出现
        const res = graphApi.setData(data.nodes, data.links, { layout, reveal: playReveal });
        // 部分命中（库变了）时 main.js 会自己回退即时沉降，这里只记一笔
        if (res && !res.warm) {
          console.log(`[GFI] 布局只命中 ${res.adopted}/${res.n} —— 库已变化，本次按即时沉降走`);
        }
        return;
      }

      // 补一份预热：这次没吃到，下次进图谱就有了。
      // 注意这里【不 await】——本轮装载不等它，避免两条路互相等成死锁。
      startPrewarm('本次未命中，后台补一份');
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

  // 用上一次的原始数据就地重建管线 —— 不用查库，而且【位置按 id 继承】，
  // 所以改外观参数不会让图谱跳回随机位置。
  // 这是「调参数」的正确入口：改完设置调它，立刻看到效果。
  //
  // ⚠ 这条路径【不吃预热布局】：用户正在图谱里调参数，他要看的是"改了之后
  //   物理怎么变"，直接灌一份按旧参数算出来的坐标会把改动盖掉。同时预热缓存
  //   必须作废 —— 它也是按旧参数算的。
  GFI.rebuild = function rebuild() {
    if (!graphApi || !lastRaw) return null;
    afterDataChanged('rebuild');
    graphApi.setData(lastRaw.nodes, lastRaw.links);
    startPrewarm('rebuild 之后');
    return lastRaw;
  };

  // ---------------------------------------------------------------------------
  // 库变动 → 图谱自己刷新
  // ---------------------------------------------------------------------------
  // 为什么需要（实机反馈）：「删掉某些页面、改了部分正文，图谱自加载后就不再更新」。
  //   一半原因是我引入的 bug（缓存里的数据被当数据用，已修：现在数据一律现查），
  //   另一半是**原来根本没有刷新机制** —— 图谱只在"打开"那一刻查一次库，
  //   之后无论库怎么变都不会再看第二眼。
  //
  // 过滤与防抖的逻辑都在 `src/livewatch.js`（单独成模块是为了能测 ——
  // `looksLikeContentEdit` 的两条纪律：不能自激、不能太贵）。
  // 这里只负责接线：
  //   · isMounted：图谱没挂着就不用刷（下次打开一定会现查）
  //   · refresh  ：走 `GFI.reloadData()`，与 `__GFI__.reload()` 同一条路
  //
  // ⚠ 为什么【不用】 `logseq.DB.onBlockChanged`：读了 SDK 源码，它是
  //     `onBlockChanged(e, t){ ... s = ({block:r,...}) => { r.uuid === e && t(...) } }`
  //   —— 参数是【某个块的 uuid】，只回调那一个块的变化。拿它做"任何变动"的全局
  //   监听是错的：随便传个不存在的 uuid 就永远不触发。所以不假装能用。
  //
  // ⚠ 成本要说清楚：每次刷新就是一次完整查库（实测 300~500ms，68 节点的库）。
  //   所以防抖 1500ms —— 停手之后才查。
  const graphRefresh = GFI.LiveWatch.createScheduler({
    debounceMs: 1500,
    isMounted: () => !!(graphApi && graphApi.alive),
    refresh: (reason) => {
      console.log(`[GFI] 检测到内容变动（${reason || ''}）—— 自动刷新图谱数据`);
      return GFI.reloadData();
    },
  });

  function unmountGraph() {
    graphRefresh.cancel();       // 图谱都关了，排队中的刷新没有意义
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

  // 视图开关监听
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
    // ⚠ 回调里同时做两件事：
    //   ① 合并到 scheduleScan（图谱视图的出现/消失 → 挂载/拆卸）
    //   ② 把变动交给 graphRefresh（过滤 + 防抖都在 src/livewatch.js 里）
    // 观察参数必须带 characterData —— 否则"改正文"这类纯文本修改根本不产生回调。
    observer = new GFI.topWin.MutationObserver((muts) => {
      scheduleScan();
      try {
        graphRefresh.notify(muts, 'DOM 内容变动');
      } catch (e) { /* 过滤失败不能影响扫描 */ }
    });
    observer.observe(GFI.topDoc.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (scanTimer !== null) { clearTimeout(scanTimer); scanTimer = null; }
    graphRefresh.cancel();
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  /**
   * 把设置同步进 config，并在**语言发生变化时重新注册设置面板 schema**。
   *
   * ⚠⚠ 这里修的是一个顺序错误，它正是「存档是英文、界面还是中文」的根因：
   *   原来的启动顺序是
   *       logseq.useSettingsSchema(GFI.settingsSchema);   // 用的是加载时编译的快照
   *       applySettings(logseq.settings);                 // 这才读到 language
   *   而 `GFI.settingsSchema` 是在 `config.js` **加载时**编译的 —— 那一刻语言还是
   *   默认的中文。于是无论存档里存的是什么，交给 Logseq 的永远是中文面板。
   *   （存档本身没问题：`logseq.settings.language` 确实是 'English'，写回那一步
   *   工作正常，坏的是"读出来之后没有重新编译"。）
   *
   *   现在：先 applySettings（拿到语言）→ 再按语言注册 schema。
   *   运行期用户改语言时也走同一条路（`langChanged` 时重注册）。
   */
  function applySettings(s) {
    s = s || {};
    // 语言诊断：把"存档里读到的原始值"（连同它的类型）和"归一化后的结果"都喊出来。
    // 实机反馈过「切了不生效 / 上次选英文这次还是中文」，没有这一行就只能靠猜
    // 是哪一段断了 —— 尤其是 Logseq 的 enum 到底存字符串还是索引，一看就知道。
    s.__langRaw = s.language;
    const before = GFI.i18n ? GFI.i18n.get() : '';
    GFI.syncSettings(s);
    const after = GFI.i18n ? GFI.i18n.get() : '';
    const d = GFI.__langDiag || {};
    console.log(`[GFI] 语言　存档=${JSON.stringify(d.存档原始值)}（${typeof d.存档原始值}）`
      + ` → 归一化=${after} → 生效面板=${after === 'en' ? 'English' : '中文'}`
      + (before !== after ? `　（由 ${before || '?'} 切换而来，将重新注册面板 schema）` : '')
      + (d.写回 && d.写回 !== d.存档原始值 ? `　已把存档纠正为 ${JSON.stringify(d.写回)}` : ''));

    // schema 是按语言编译的，语言一变就必须重新交给 Logseq 一次
    if (before !== after) registerSettingsSchema(`语言切到 ${after}`);
  }

  /** 已注册 schema 的语言。避免每次 onSettingsChanged 都无谓地重注册。 */
  let registeredLang = '';
  // ⚠ 重入闸门。`useSettingsSchema` 有可能反过来触发一次 onSettingsChanged；
  //   没有这道闸门的话，"语言变了 → 重注册 → 又触发 → 又发现语言变了"会变成
  //   无限递归。这里最多允许一层嵌套。
  let registeringSchema = false;

  /**
   * 把当前语言的 schema 交给 Logseq。**必须在语言确定之后调用。**
   * ⚠ `GFI.settingsSchema` 只是"某一刻的快照"，重新 `i18n.schema()` 才拿到新语言。
   */
  function registerSettingsSchema(reason) {
    if (!GFI.i18n || !GFI.settingsSchema) return false;
    if (registeringSchema) return false;
    registeringSchema = true;
    try {
      const schema = GFI.i18n.schema();     // ← 关键：按【当前】语言重新编译
      logseq.useSettingsSchema(schema);
      registeredLang = GFI.i18n.get();
      console.log(`[GFI] 已注册设置面板 schema（${reason || ''}）`
        + `　语言=${registeredLang}　首条=${schema[0] && schema[0].key}`
        + `　标题示例=${schema[1] && schema[1].title}`);
      return true;
    } catch (e) {
      console.warn('[GFI] 注册设置面板 schema 失败', e);
      return false;
    } finally {
      registeringSchema = false;
    }
  }

  /**
   * 就地改写设置面板文案 —— 让语言切换**不用重载插件**。
   *
   * ⚠ 为什么不能只改一次：我们改完文字之后，Logseq 可能紧接着自己再渲染一遍
   *   面板（它才是 schema 的主人），把文字又写回提交时的那个语言。所以这里
   *   做一段有界的重试：只要"还有没换过来的条目"就补一次，最多 20 次 ×250ms。
   *   没有这个重试，用户看到的就是"点了一下、闪回去了"。
   */
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

  // 「斥力 / 连接线长度 / 节点大小」这三个值是在 Data.build 里【烘进】定型数组的
  // （D.charge / D.ldist / D.radius），改完 GFI.config 对已经建好的图毫无影响，
  // 必须重建管线才生效。这里用一个签名来检测它们有没有变。
  function layoutSignature() {
    const c = GFI.config;
    return c.physics.charge + '|' + c.physics.linkDistance + '|' + c.render.nodeSize;
  }

  // 过滤规则不同：它们是在【数据源】那一步生效的，重建不够，得重新查一次库。
  // 不自动做 —— hideNames 是个文本框，边打字边查库不合适。
  function filterSignature() {
    const d = GFI.config.data;
    return [d.hideSystemJournal, d.hideSystemPages, d.hideNames.join(',')].join('|');
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

  // 暴露给主窗口控制台：语言面板文案的手动补写（自动那条见 scheduleRelabel）
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
    }
  } catch (e) { }

  function start() {
    try {
      applySettings(window.logseq && window.logseq.settings);
      startObserver();
      // 兜底再喊一次：ready 回调里已经喊过了，这里对"还没起步"的情况（比如
      // ready 回调里那次抛错、或走了下面的非 logseq 分支）补一脚。
      // prewarm() 对同一个 key 返回同一个 Promise，重复调用是幂等的。
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
        // 插件真的要走了才摘 Pixi 钩子。
        // ⚠ 不能挪进 unmountGraph()：图谱视图来来去去都会走那条路径，
        //   而摘掉钩子会整整漏掉下一个 Application
        try { GFI.Overlay.releasePixiCapture(); } catch (e) { }
      });
    }

    logseq.ready().then(() => {
      // ---- 预热在那个 300ms 之前就开始 ----
      // `setTimeout(start, 300)` 延迟的是【观察者】，预热不依赖它。
      // 早这 300ms 有意义：预热越早跑完，用户点开图谱时越可能吃到缓存，
      // 而不是落在"同步抢跑"或"等后台预热"那条更慢的路上。
      // ⚠ 但它【必须在 applySettings 之后】—— 见下面那条注释。
      try {
        // ⚠⚠ 顺序不能反：**先读设置（确定语言），再注册 schema**。
        //   反过来就是「存档是英文、界面还是中文」的根因 ——
        //   `GFI.settingsSchema` 是 config.js 加载时按【默认语言】编译的快照。
        applySettings(logseq.settings);
        registerSettingsSchema('启动');
        // ---- 预热：设置在同步完之后才启动 ----
        // ⚠ 顺序同样不能反。原先是先 startPrewarm 再 applySettings —— 那样预热读到
        //   的是 config 的**初始副本**，用户改过的 dataSource / demoCount 还没写进来，
        //   实机日志里那条 `预热启动 source=undefined` 就是这么来的。
        //   代价是晚了这几毫秒开始；比起"整个预热白跑"完全不值一提。
        try { startPrewarm('logseq ready'); } catch (e) { console.warn('[GFI] 预热启动失败', e); }

        logseq.onSettingsChanged((s) => {
          const wasNative = GFI.getGraph() && GFI.getGraph().nativeMode;
          const beforeLayout = layoutSignature();
          const beforeFilter = filterSignature();
          const beforeSource = prewarmKey();
          // ⚠ 语言要在 applySettings 【之前】取 —— applySettings 里会把它改掉
          const beforeLang = GFI.i18n ? GFI.i18n.get() : '';
          applySettings(s);
          const g = GFI.getGraph();
          if (g && !!GFI.config.useNativeGraph !== !!wasNative) {
            g.setNativeMode(!!GFI.config.useNativeGraph);
            // 切回我们的图谱时该有一份现成的布局；切到原生图谱则不必烧 CPU
            if (GFI.config.useNativeGraph) afterDataChanged('切到原生图谱');
            else startPrewarm('切回我们的图谱');
          }
          // ⚠ 没有这一步的话，在设置面板里拖「斥力 / 连接线长度 / 节点大小」
          //   是【毫无反应】的 —— 它们被烘死在定型数组里。很容易因此得出
          //   "这个旋钮根本没用"的结论，而实际上是改了没重建。
          if (g && layoutSignature() !== beforeLayout) GFI.rebuild();
          if (filterSignature() !== beforeFilter) {
            console.log('[GFI] 过滤规则已变 —— 运行 __GFI__.reload() 重新拉取数据后生效');
            afterDataChanged('过滤规则已变');
          }
          // 数据源 / 演示图规模变了：缓存的那张图根本不是同一张了
          if (prewarmKey() !== beforeSource) {
            afterDataChanged('数据源已变');
            startPrewarm('数据源已变');
          }
          // 语言变了：
          //   ① applySettings 里已经【重新注册】过按新语言编译的 schema
          //   ② 但 Logseq 可能已经把面板渲染出来了，所以还要就地改写现有 DOM
          if (beforeLang !== GFI.i18n.get()) {
            console.log(`[GFI] 语言已切到 ${GFI.i18n.get()} —— schema 已重注册，同时就地改写面板文案`);
            scheduleRelabel('语言切换');
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
