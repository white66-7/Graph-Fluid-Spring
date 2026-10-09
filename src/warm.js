/*
 * GFI.Warm — 布局预热器
 * ===========================================================================
 * 它存在的唯一理由：把「图谱视图打开后才会发生的那段布局沉降」提前到后台做完。
 *
 * ── 为什么需要（白盒时序）──
 * 老路径进图谱的观感是三段：
 *   ① 原生图谱        ② 我们的画布（种子螺旋）      ③ 沉降后缓动适配视野
 * ①②的分界是 src/main.js 的「交接」；②③的分界是 frame() 里的 autoFitPending。
 * ②之所以看得见，是因为 setData 后的第一次 fitView 是在 build() 刚算出来的
 * 黄金角螺旋上做的（spacing 26，81 个节点半径才 ~240），而模拟要跑几百个 tick
 * 才把它撑到最终尺度 —— 中间那几百毫秒就是用户看到的"还没适配"。
 *
 * 预热的做法是把这段物理提前跑掉：分帧跑同一个 GFI.Physics 到 alpha 睡着，
 * 把坐标按节点 id 存下来。图谱视图打开时把这批坐标直接灌进 D（GFI.Data.applyLayout），
 * 于是第一帧画的就是最终布局，一次 fitView 就到位，②③两段一起消失。
 *
 * ── 三条必须守住的约束 ──
 *  1.【分帧】一帧最多 BUDGET_MS 毫秒。整段沉降在无头机上约 0.3~1.5 秒（取决于
 *    节点数），一口气跑完就是一个肉眼可见的主线程卡顿。
 *  2.【可重入】prewarm() 返回的是【同一个 Promise】。图谱视图可能在任何时刻
 *    打开，包括预热跑到一半的时候 —— 那时它必须能等，而不是各跑一份。
 *  3.【零副作用】预热用独立的 D / sim，不碰任何渲染状态；跑完只留一个布局缓存。
 *    所以它可以在插件加载后就悄悄开始，用户根本不知道它跑过。
 *
 * ── 缓存失效 ──
 * 预热的坐标是「当前配置 + 当前库」的函数。数据源加载完了就 keep：
 * 用户关掉图谱再打开，看到的是同一张图（这正是预期）。但数据本身变了
 * （__GFI__.reload / 改了过滤规则 / 改了斥力线长节点大小之后的 GFI.rebuild）
 * 就必须丢掉，见 index.js 的 afterDataChanged()。
 */
(function (GFI) {
  'use strict';
  if (GFI.Warm) return;

  const DT = GFI.DT;

  // 一帧的物理预算。默认 26ms ≈ 一个 60Hz 帧的 1.5 倍 —— 故意超帧。
  //
  // ⚠ 原先写的是 14ms，理由是"别把帧吃满"。实测（test/warm-cost.js）证明那个
  //   理由站不住：沉降成本是 O(n) 的几百次累积，让它每晚一帧跑完，用户就越可能
  //   在"预热还没好"的时候点开图谱。而 500 节点的库整段沉降要 ~2 秒 ——
  //   按 14ms/帧 分帧，等于要 142 帧（2.4 秒）才跑完，而按 26ms/帧 只要 1.3 秒。
  //   预热期间用户几乎总在别的页面，多占一点帧是值得的；真有影响也就是
  //   Logseq 启动那一下略微钝一点。
  // 可调：config.warm.budgetMs
  const DEFAULT_BUDGET_MS = 26;

  // 单次预热最多跑多少个 tick（× settleTicks）。settleTicks 默认 400
  // （alpha 1→alphaMin），但孤立节点的外环拉力【不乘 alpha】，尾段仍在缓慢
  // 移动 —— 多给余量让它彻底停稳，免得灌进去的坐标和真正跑完的最终布局有偏差。
  // ⚠ 实测：371 tick 就睡着了（settleTicks=400），所以这个上限平时根本用不到；
  //   它只在"库异常、alpha 掉不下去"时兜底。
  // 可调：config.warm.maxTicksFactor
  const DEFAULT_MAX_TICKS_FACTOR = 2.5;

  // 单帧最多跑多少个 tick。
  // ⚠ 这道上限和"毫秒预算"是【两个独立护栏】，缺一不可：
  //   预算那一道依赖 performance.now() 真的在走。宿主页面被切到后台、
  //   或者运行环境把计时器钳住时，now() 可能整帧不动 —— 那时"本帧还没用完
  //   预算"会永远成立，一帧里就把几千个 tick 全跑完，表现是一次 1~2 秒的
  //   主线程冻结。按 tick 数封顶就不受时钟影响（实测被
  //   test/smoke-boot.js 的假时钟抓到：401 tick 全挤在一帧里，
  //   因为那一帧的 now() 没变）。
  //   120 是"最便宜的图"（81 节点 ≈0.53ms/tick ⇒ 64ms）的上界，
  //   最贵的图由毫秒预算先拦住，所以这个数字只在时钟坏掉时才真正生效。
  const MAX_TICKS_PER_FRAME = 120;

  // ---- 进图谱时的【同步抢跑】预算 ----
  // 背景预热没跑完时，我们已经在 loader 后面了：此刻主线程本来就不出帧
  // （画布上什么都还没有），所以可以把剩下的沉降一次性跑掉，跑完直接呈现
  // 最终布局 —— 代价只有"加载指示多亮这一会儿"。
  //
  // ⚠ 上限必须拿实测数字说话（test/warm-cost.js）：
  //     200 节点 ≈ 0.5s   500 节点 ≈ 2.0s   1000 节点 ≈ 7.2s
  //   所以"能全部跑完"这条路只对中小库成立（300ms ≈ 500~700 节点以内）。
  //   大库跑不完就必须【立刻回退】到异步路径，绝不能在这儿死等 ——
  //   那会变成十几秒的假死。
  const DEFAULT_SYNC_SETTLE_MS = 300;

  function budgetMs() {
    const c = GFI.config.warm;
    return (c && Number.isFinite(c.budgetMs) && c.budgetMs > 0) ? c.budgetMs : DEFAULT_BUDGET_MS;
  }

  function syncSettleMs() {
    const c = GFI.config.warm;
    return (c && Number.isFinite(c.syncSettleMs) && c.syncSettleMs >= 0)
      ? c.syncSettleMs : DEFAULT_SYNC_SETTLE_MS;
  }

  function maxTicksFactor() {
    const c = GFI.config.warm;
    return (c && Number.isFinite(c.maxTicksFactor) && c.maxTicksFactor > 0)
      ? c.maxTicksFactor : DEFAULT_MAX_TICKS_FACTOR;
  }

  let cache = null;          // { key, layout:Map, data, ... }
  let inflight = null;       // { key, promise }
  let partial = null;        // 同步抢跑超预算时留下的半成品 { key, data, D, sim, ticks, maxTicks }
  let stepHandle = null;     // 当前排队的 rAF id（作废时取消）
  let generation = 0;        // 缓存代数 —— 跑在路上的预热发现自己过期就自弃
  let obs = null;            // 诊断用：最近一次的统计数据

  // ---------------------------------------------------------------------------
  // 请求参数归一化 —— 这是缓存 key 的【唯一】默认值来源
  // ---------------------------------------------------------------------------
  // 实机事故（2026-10）：日志里出现 `预热启动 source=undefined demoCount=undefined`。
  // keyOf() 会把 undefined 兜底成 'logseq' / 0，fetchData 也会照常走真实数据源 ——
  // 两边"看起来都对"，但写缓存的 key 与 peek() 问出来的 key 从此对不上，
  // 预热等于白跑（用户连点两次图谱都走"同步抢跑"）。
  //
  // 更隐蔽的一层：默认值原先散在两个地方（warm.js 的 `|| 0`、index.js 的 `|| 400`），
  // 于是 `keyOf({})` 给 `logseq:0` 而 `keyOf(prewarmRequest())` 给 `logseq:400` ——
  // 两边各自"有默认值"，却依旧对不上。所以现在只有这一处：
  //   · keyOf() 用它算 key
  //   · prewarm() / settleNow() 用它算真正拿去查库的参数
  // 两边共用同一个归一化函数，就不存在"对不上"的可能。
  const DEFAULTS = { source: 'logseq', demoCount: 400 };

  function normReq(req) {
    req = req || {};
    return {
      source: req.source || DEFAULTS.source,
      // ⚠ 用 > 0 判断，不能用 || —— demoCount 允许被显式设成 0 以外的值，
      //   而 `0 || 400` 会把它悄悄改成 400。
      demoCount: (typeof req.demoCount === 'number' && req.demoCount > 0)
        ? req.demoCount : DEFAULTS.demoCount,
    };
  }

  /** 预热请求的指纹：数据源不同 / 演示图节点数不同，缓存就不能共用 */
  function keyOf(req) {
    const r = normReq(req);
    return r.source + ':' + r.demoCount;
  }

  /**
   * 异步预算一张图的沉降布局。
   * @param {{source?:string, demoCount?:number, log?:function}} req
   * @returns {Promise<object|null>} 缓存对象；数据为空时 null
   */
  function prewarm(req) {
    req = normReq(req);
    const key = keyOf(req);
    const log = typeof req.log === 'function' ? req.log : function () {};

    if (cache && cache.key === key) return Promise.resolve(cache);
    if (inflight && inflight.key === key) return inflight.promise;

    const myGen = generation;
    const t0 = GFI.util.now();
    let priorMs = 0;          // 半成品已经烧掉的时间（接续时用）

    const promise = (async function run() {
      // ---- 半成品优先 ----
      // 同步抢跑（settleNow）在超预算时会把「已经跑出来的 D/sim/tick 数」留在
      // partial 里。数据本来就是同一份，接着跑比从第 0 个 tick 重来省掉那一整段。
      // ⚠ 这里的 key 判断不是可选的优化：用户可能在两次装载之间换了数据源，
      //   用错的半成品会跑出一张别的图的坐标。
      let D, sim, ticks, maxTicks, data;
      if (partial && partial.key === key) {
        ({ D, sim, ticks, maxTicks, data } = partial);
        priorMs = partial.spentMs || 0;
        partial = null;
        log(`接续同步抢跑留下的半成品（已跑 ${ticks}/${maxTicks} tick，已烧 ${priorMs}ms）`);
      } else {
        data = await GFI.DataSource.fetchData({
          source: req.source,
          demoCount: req.demoCount,
          includeParentLinks: false,
        });
        log(`数据就绪 ${Math.round(GFI.util.now() - t0)}ms　${data.nodes.length} 节点 / ${data.links.length} 边`);

        // 数据在等待期间被作废了（用户改了过滤规则又 reload）→ 这份已经过期
        if (myGen !== generation) return null;
        if (!data.nodes.length) return null;

        D = GFI.Data.build(data.nodes, data.links, null);
        sim = GFI.Physics.create(D, GFI.config.physics);
        ticks = 0;
        maxTicks = Math.ceil(GFI.config.physics.settleTicks * maxTicksFactor());
      }
      if (myGen !== generation) return null;

      const frameBudget = budgetMs();
      let blocked = false;          // true = 跑到上限还没睡着（异常库）

      await new Promise(function pump(resolve) {
        const frameStart = GFI.util.now();
        let done = 0;
        while (ticks < maxTicks && done < MAX_TICKS_PER_FRAME &&
               GFI.util.now() - frameStart < frameBudget) {
          if (!sim.isAwake()) break;
          sim.tick(DT);
          ticks++; done++;
        }
        if (ticks >= maxTicks && sim.isAwake()) blocked = true;
        if (!sim.isAwake() || blocked || myGen !== generation) { resolve(); return; }
        if (ticks % 240 === 0) log(`预热 ${ticks}/${maxTicks} tick　alpha=${sim.alpha.toExponential(1)}`);
        stepHandle = GFI.util.raf(() => pump(resolve));
      });

      if (myGen !== generation) return null;

      const entry = buildEntry(key, D, sim, ticks, blocked);
      // ⚠ 接着半成品跑时要把"同步抢跑已经烧掉的那段时间"加回来（priorMs），
      //   否则 costMs 只反映本轮，会把"整张图沉降到底花了多久"报小。
      entry.costMs = Math.round(priorMs + (GFI.util.now() - t0));
      cache = entry;
      obs = obsOf(entry);
      log(`预热完成 ${entry.costMs}ms　${ticks} tick　包围盒 ${entry.bbox.w}×${entry.bbox.h}`);
      return entry;
    })();

    const wrapped = promise
      .catch(function (e) {
        console.warn('[GFI] 预热失败（图谱仍会即时沉降）', e);
        return null;
      })
      .then(function (r) {
        if (inflight && inflight.promise === wrapped) inflight = null;
        return r;
      });

    inflight = { key, promise: wrapped };
    return wrapped;
  }

  // ---------------------------------------------------------------------------
  // 共用零件
  // ---------------------------------------------------------------------------
  /**
   * 把跑完的 D / sim 打包成缓存条目。
   *
   * ⚠⚠ 条目里【刻意不放原始数据】（没有 `data` 字段）。
   *   它原先带着 `data: { nodes, links }` —— 那是"预热那一刻"的查库快照；
   *   调用方很容易顺手把它当数据用。实机就这么踩了：用户删页面、改正文之后
   *   图谱永远停在旧数据上，因为每次打开喂进去的都是同一份快照。
   *   现在结构上就没有东西可误用：缓存只回答"每个 id 落在哪里"，
   *   数据一律由调用方现查。
   *
   * ⚠ 只取【可见】节点的坐标。不可见的节点（时间轴 cutoff 之外的）首次进入时
   *   本来就该走"出生"那条路径，给它们一个沉降后的坐标没有意义。
   *   当前 build 把所有节点初始化为可见、cutoff 初值 = range.max，所以实际上
   *   会全取；留着这个判断是为了将来 cutoff 初值改了不会静默出错。
   */
  function buildEntry(key, D, sim, ticks, blocked) {
    const layout = new Map();
    for (let i = 0; i < D.n; i++) {
      if (!D.visible[i]) continue;
      layout.set(D.id[i], { x: D.x[i], y: D.y[i] });
    }
    const bb = GFI.Data.bounds(D, false);
    return {
      key,
      layout,                                 // ← 唯一的产出，就它
      n: D.n,
      m: D.m,
      ticks,
      alpha: sim.alpha,
      blocked,
      bbox: { w: Math.round(bb.maxX - bb.minX), h: Math.round(bb.maxY - bb.minY) },
      costMs: 0,
    };
  }

  function obsOf(entry) {
    return {
      节点: entry.n, 边: entry.m, tick数: entry.ticks, 成本ms: entry.costMs,
      包围盒: entry.bbox, alpha: +entry.alpha.toExponential(2),
      跑到上限没睡着: entry.blocked,
      // 同步抢跑的 tick 数（0 = 这次没走抢跑）
      抢跑tick: entry.syncTicks || 0,
    };
  }

  // ---------------------------------------------------------------------------
  // 同步抢跑 —— 进图谱时在 loader 后面把剩下的沉降一次跑完
  // ---------------------------------------------------------------------------
  /**
   * 在【已经有数据】的前提下，同步（阻塞地）把沉降跑到预算上限。
   *
   * 为什么可以同步阻塞：调用它的时刻，画布上还什么都没有（loader 正亮着），
   * 主线程本来就不出帧 —— 这段时间的阻塞不影响任何已显示的东西。
   * 为什么必须有预算：500 节点要 2 秒、1000 节点要 7 秒（test/warm-cost.js）。
   * 超预算就必须【立刻】返回 null 让调用方回退，绝不能死等。
   *
   * ⚠ 超预算时**不扔掉**已经跑出来的部分：存进 partial，交给后台预热接着跑。
   *   不存的话，大库每次进图谱都会白烧掉预算那一段（200ms × 每次），
   *   而且后台预热还要从第 0 个 tick 重新开始。
   *
   * @param {Array} nodes 已经拿到的原始节点
   * @param {Array} links
   * @param {object} [req] { source, demoCount } 用来写缓存 key
   * @returns {object|null} 缓存条目；没跑完 / 数据为空时 null
   */
  function settleNow(nodes, links, req) {
    const key = keyOf(req);
    if (!nodes || !nodes.length) return null;

    const limit = syncSettleMs();
    if (!(limit > 0)) return null;

    // ⚠ t0 必须取在 Data.build / Physics.create 【之前】：它们同样是同步阻塞的
    //   （build 里有 CSR 邻接、按度数排序、色表；create 要扫一遍半径最大值），
    //   而预算管的是"这次同步阻塞总共多久"，不是"物理循环多久"。
    //   实测（test/smoke-boot.js 的 e2e）：只卡物理循环时，墙钟比预算多出 25%。
    const t0 = GFI.util.now();
    const D = GFI.Data.build(nodes, links, null);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const maxTicks = Math.ceil(GFI.config.physics.settleTicks * maxTicksFactor());

    let ticks = 0;
    let timedOut = false;
    if (GFI.util.now() - t0 > limit) timedOut = true;    // 建图本身就超了
    while (!timedOut && sim.isAwake()) {
      if (ticks >= maxTicks) break;
      // ⚠ 首轮也要查一次（ticks = 0）。否则「预算极小」时先跑满 8 个 tick
      //   才发现超时 —— 对 5000 节点那种 175ms/tick 的图，这一下就是 1.4 秒
      //   的越界。之后每 8 个 tick 查一次：performance.now() 本身也要钱，
      //   而这个循环的对手是"每 tick 几毫秒"的物理，不是微秒级开销。
      if ((ticks & 7) === 0 && GFI.util.now() - t0 > limit) { timedOut = true; break; }
      sim.tick(DT);
      ticks++;
    }

    const spent = Math.round(GFI.util.now() - t0);

    if (timedOut || sim.isAwake()) {
      // 没跑完 —— 这份布局不能用（半沉降的坐标和最终形态不是一张图，
      // 灌进去反而会让第一帧"跳"一下）。但已经跑出来的 tick 不浪费。
      partial = { key, data: { nodes, links }, D, sim, ticks, maxTicks, spentMs: spent };
      obs = {
        节点: D.n, 边: D.m, tick数: ticks, 成本ms: spent,
        包围盒: null, alpha: +sim.alpha.toExponential(2),
        跑到上限没睡着: false, 抢跑tick: ticks,
        同步抢跑: `超预算（${spent}ms > ${limit}ms），已存半成品并回退异步`,
      };
      return null;
    }

    const entry = buildEntry(key, D, sim, ticks, false);
    entry.syncTicks = ticks;
    entry.costMs = spent;
    cache = entry;
    partial = null;
    obs = Object.assign(obsOf(entry), { 同步抢跑: '命中，一步到位' });
    console.log(`[GFI] 同步抢跑完成 ${entry.costMs}ms　${ticks} tick　包围盒 ${entry.bbox.w}×${entry.bbox.h}`);
    return entry;
  }

  /** 已经有现成的缓存就直接给（图谱视图挂载时先用它判断能不能一步到位） */
  function peek(key) {
    if (!cache) return null;
    if (key !== undefined && cache.key !== key) return null;
    return cache;
  }

  /** 正在跑的预热 Promise（图谱视图挂载时可以等它） */
  function pending(key) {
    if (!inflight) return null;
    if (key !== undefined && inflight.key !== key) return null;
    return inflight.promise;
  }

  /** 丢掉缓存。数据变了就调它 —— 坐标是数据的函数，不丢会画出一张错位的图。 */
  function invalidate(reason) {
    generation++;
    const had = !!cache;
    cache = null;
    partial = null;          // 半成品同样是【旧数据的函数】，一并丢
    obs = null;
    if (stepHandle != null) { try { GFI.util.caf(stepHandle); } catch (e) {} stepHandle = null; }
    if (had) console.log('[GFI] 预热缓存已作废', reason || '');
  }

  /** 诊断用 —— 主窗口控制台里 __GFI__.warm() 就是它 */
  function state() {
    return {
      开关: !(GFI.config.warm && GFI.config.warm.enabled === false),
      单帧预算ms: budgetMs(),
      抢跑预算ms: syncSettleMs(),
      tick上限倍率: maxTicksFactor(),
      有缓存: !!cache,
      正在预热: !!inflight,
      最近一次: obs,
      缓存: cache ? {
        来源: cache.key, 节点: cache.n, 边: cache.m,
        tick数: cache.ticks, 成本ms: cache.costMs,
        包围盒: cache.bbox, 跑到上限没睡着: cache.blocked,
      } : null,
    };
  }

  GFI.Warm = {
    prewarm, settleNow, peek, pending, invalidate, state, keyOf, normReq, DEFAULTS,
    budgetMs, syncSettleMs, maxTicksFactor, MAX_TICKS_PER_FRAME,
  };
})(window.GFI);
