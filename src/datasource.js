/*
 * GFI.DataSource — 图谱数据来源
 * ===========================================================================
 * ✅ 本模块的 schema 已于 M0 阶段在 Logseq 2.0.1 / DB 图谱上实测验证。
 *   实测结论见 fromLogseq() 的文档注释。
 *
 * 目标形状（与 Logseq 原生节点对齐）：
 *   Node { id:string, dbId:number, uuid:string, label:string,
 *          kind:'page'|'tag'|'journal'|'object'|'property',
 *          createdAt?:number(ms), icon?, color? }
 *   Link { source:string, target:string, label?:string }
 *
 * Logseq 2.0.1 是 DB 版，schema 与老文件版完全不同（:block/title 而非 :page/name）。
 * 从 app.asar 里读到的属性名：:block/title / :block/created-at / :block/refs /
 * :block/tags / :block/parent，过滤用 :logseq.property/hide? / :logseq.property/deleted-at
 * / :logseq.property/exclude-from-graph-view。
 *
 * datascriptQuery 有个坑：SDK 里它会 t.pop() 掉最后一个参数。
 *   不带 input 的查询单参调用是安全的；要传 input 必须补一个尾随占位参数。
 */
(function (GFI) {
  'use strict';
  if (GFI.DataSource) return;

  const LS = () => (typeof window.logseq !== 'undefined' ? window.logseq : null);

  // =========================================================================
  // 工具
  // =========================================================================
  function firstNumber(o, keys) {
    for (const k of keys) {
      const v = o[k];
      if (v === undefined || v === null) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  function firstString(o, keys) {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.length) return v;
    }
    return undefined;
  }

  function entityId(o) {
    const v = firstNumber(o, ['id', 'db/id', 'dbId']);
    return v === undefined ? null : String(v);
  }

  // 日记页标题的形态。Logseq 会按语言/设置给出不同格式，
  // 之前只认两种，导致 "2026-09-15 Tue"（带星期）被误判成普通页面。
  const JOURNAL_PATTERNS = [
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(\s+\S{1,8})?$/,            // 2026-09-15 / 2026-09-15 Tue
    /^\d{4}年\d{1,2}月\d{1,2}日(\s+\S{1,8})?$/,                  // 2026年9月15日
    /^[A-Z][a-z]{2,9}\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4}$/,    // Sep 10th, 2026 / September 10, 2026
  ];

  function pageKind(p) {
    const t = String(p.title || p.name || p.originalName || '');
    for (const re of JOURNAL_PATTERNS) {
      if (re.test(t)) return 'journal';
    }
    const cls = firstString(p, ['class', 'type', 'kind']);
    if (cls === 'tag') return 'tag';
    if (cls === 'property') return 'property';
    if (p.tags && Array.isArray(p.tags)) {
      for (const tag of p.tags) {
        const tn = typeof tag === 'string' ? tag : (tag && (tag.title || tag.name));
        if (tn === 'Journal') return 'journal';
      }
    }
    return 'page';
  }

  // =========================================================================
  // 真实数据源
  // =========================================================================
  async function query(q) {
    const L = LS();
    if (!L || !L.DB || !L.DB.datascriptQuery) return null;
    try {
      // 单参调用是安全的 —— SDK 只 pop 掉多余的 input 参数
      const r = await L.DB.datascriptQuery(q);
      return Array.isArray(r) ? r : null;
    } catch (e) {
      console.warn('[GFI] datascriptQuery 失败:', q.slice(0, 60), e && e.message);
      return null;
    }
  }

  /**
   * 从 Logseq 拉取节点与边。
   *
   * ── 以下是 M0 探针在 Logseq 2.0.1 / DB 图谱上的实测结论 ──
   *   · Editor.getAllPages() 可用，且【直接带 createdAt】(ms epoch) 与 uuid
   *       字段: createdAt, name, title, updatedAt, uuid, id, content, fullTitle
   *       → 节点根本不用走 datascript，这是最省事也最可靠的一条路
   *   · :logseq.property/hide? = true 有 93 条 → 必须过滤，否则图谱里全是内部实体
   *   · :logseq.property/deleted-at 有 1 条 → 过滤
   *   · :logseq.property/exclude-from-graph-view 查询成功但 0 条 → 保留在过滤里，无害
   *   · :block/journal? 查询成功但 0 条 → 日记判据改用标题的日期格式
   *   · 边：引用 61 条 / 标签 206 条 / 父子 248 条
   */
  async function fromLogseq(opts) {
    opts = opts || {};
    const L = LS();
    if (!L) throw new Error('[GFI] logseq API 不可用');

    // ---------------- 需要排除的实体 ----------------
    // 内部实体（模板、属性定义等）不隐藏掉的话会把真实结构淹掉
    const excluded = new Set();
    const filterStats = [];
    const applyFilter = (name, rows) => {
      if (!rows) { filterStats.push(`${name}: 查询失败`); return 0; }
      let c = 0;
      for (const r of rows) {
        const id = String(r[0]);
        if (!excluded.has(id)) { excluded.add(id); c++; }
      }
      filterStats.push(`${name}: +${c}`);
      return c;
    };

    applyFilter('hide?', await query('[:find ?e :where [?e :logseq.property/hide? true]]'));
    applyFilter('deleted-at', await query('[:find ?e :where [?e :logseq.property/deleted-at ?d]]'));
    applyFilter('exclude-from-graph-view', await query('[:find ?e :where [?e :logseq.property/exclude-from-graph-view ?v]]'));

    // Logseq 自身的【属性定义实体】。
    // 它们带 :logseq.property/type 属性（这就是"这是个属性定义"的判据）。
    // 不过滤的话图谱里会混进 Alias / Due / State / Extends / User Name /
    // Title Format / Published URL 这一大堆噪音节点 ——
    // 正是"我明明没有这么多节点"的来源。
    // ── 只滤「属性定义」，不动「类」 ──
    //
    // ⚠ 这里曾经把 logseq.class 的实体也一并滤掉，结果是图谱失去了骨架：
    //   在 DB 版 Logseq 里，每个页面都被 logseq.class/Page 标记、日记被
    //   logseq.class/Journal 标记 —— 原生图谱正是靠这些边形成
    //   「Page 连着所有页面、Journal 连着所有日记」的枢纽结构。
    //   真正该滤的是零度的属性定义（Alias / Due / State / Title Format …）。
    //
    // 判据：属性定义实体带 :logseq.property/type。这是个普通属性查询，
    // datascript 支持；之前失败的其实是用到 namespace / clojure.string 的那两条。
    applyFilter('property-def', await query('[:find ?e :where [?e :logseq.property/type ?t]]'));

    // 内置类枢纽黑名单（默认只有 logseq.class/Tag，见 config.data.hideClassIdents）。
    // logseq.class/Page 与 logseq.class/Journal 【不在这里】—— 它们是有用的骨架。
    for (const ident of (GFI.config.data && GFI.config.data.hideClassIdents) || []) {
      applyFilter(`class:${ident}`,
        await query(`[:find ?e :where [?e :db/ident :${ident}]]`));
    }

    // 名字黑名单：只剔除【零度节点】（见 config.data.hideNames 的说明）。
    // 无论 property-def 查询成功与否都启用 —— 它管的是另一类东西：
    // Logseq 由 {{include}} 之类的指令生成的幽灵页面，属性查询抓不到。
    const nameBlocklist = new Set(
      (GFI.config.data && GFI.config.data.hideNames) || []
    );

    // ---------------- 节点 ----------------
    let rawPages = null;
    try {
      rawPages = await L.Editor.getAllPages();
    } catch (e) {
      console.warn('[GFI] getAllPages 失败，退回 datascript', e && e.message);
    }

    const nodes = [];
    const seen = new Set();

    if (Array.isArray(rawPages) && rawPages.length) {
      for (const p of rawPages) {
        const id = entityId(p);
        if (!id || seen.has(id) || excluded.has(id)) continue;
        const label = firstString(p, ['title', 'name', 'fullTitle', 'originalName']) || id;
        seen.add(id);
        nodes.push({
          id,
          dbId: Number(id),
          uuid: firstString(p, ['uuid']),
          label,
          kind: pageKind(p),
          createdAt: firstNumber(p, ['createdAt', 'created-at']),
        });
      }
    } else {
      // 退回路径：页面 API 不可用（例如未来版本改签名）
      const rows = await query('[:find ?e ?title ?created :where [?e :block/title ?title] [?e :block/created-at ?created]]');
      if (rows) {
        for (const r of rows) {
          const id = String(r[0]);
          if (seen.has(id) || excluded.has(id)) continue;
          seen.add(id);
          nodes.push({
            id, dbId: Number(r[0]), label: String(r[1] || id),
            kind: pageKind({ title: String(r[1] || '') }), createdAt: Number(r[2]),
          });
        }
      }
    }

    // ---------------- 边 ----------------
    const links = [];
    const edgeSeen = new Set();
    function addLink(a, b, label) {
      const s = String(a), t = String(b);
      if (!seen.has(s) || !seen.has(t) || s === t) return;
      const key = s < t ? s + ' ' + t : t + ' ' + s;
      if (edgeSeen.has(key)) return;
      edgeSeen.add(key);
      links.push({ source: s, target: t, label });
    }

    // 引用边：块所在页面 → 被引用的实体
    const refRows = await query('[:find ?p ?r :where [?b :block/page ?p] [?b :block/refs ?r]]');
    if (refRows) for (const r of refRows) addLink(r[0], r[1]);

    // 标签边：被标签的页面 → 标签实体
    const tagRows = await query('[:find ?p ?t :where [?p :block/tags ?t]]');
    const tagIds = new Set();
    if (tagRows) {
      for (const r of tagRows) { addLink(r[0], r[1]); tagIds.add(String(r[1])); }
    }

    // 用标签边把 tag 类型的节点标出来 —— 这是唯一可靠的判据。
    // 光看标题分不出「标签」和「恰好叫这个名字的页面」。
    for (const nd of nodes) {
      if (tagIds.has(nd.id)) nd.kind = 'tag';
    }

    if (opts.includeParentLinks) {
      const parRows = await query('[:find ?p ?par :where [?p :block/parent ?par]]');
      if (parRows) for (const r of parRows) addLink(r[0], r[1]);
    }

    // 兜底黑名单的落地：只剔除【没有任何连边】的同名节点。
    // 加这个限制是因为黑名单是按名字匹配的 —— 万一用户真有一个叫
    // "State" 或 "include" 的页面且它有链接，那它就是内容，不能删。
    if (nameBlocklist.size) {
      const linked = new Set();
      for (const l of links) { linked.add(l.source); linked.add(l.target); }
      let removed = 0;
      const hit = [];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const nd = nodes[i];
        if (nameBlocklist.has(nd.label) && !linked.has(nd.id)) {
          seen.delete(nd.id);
          nodes.splice(i, 1);
          hit.push(nd.label);
          removed++;
        }
      }
      filterStats.push(`名字黑名单剔除 ${removed} 个零度节点` + (removed ? ` [${hit.join(', ')}]` : ''));
    }

    const withTs = nodes.reduce((c, n) => c + (n.createdAt ? 1 : 0), 0);
    console.log(
      `[GFI] 数据源：${nodes.length} 节点 / ${links.length} 边  ` +
      `（${tagIds.size} 个标签，${withTs} 个带时间戳，共排除 ${excluded.size} 个内部实体）`
    );
    console.log('[GFI] 过滤明细：' + filterStats.join('  '));

    return { nodes, links };
  }

  // =========================================================================
  // Demo 生成器 —— 让渲染器/物理/特效可以在真实数据就绪前就测起来
  // =========================================================================
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 合成一个带簇结构、度数长尾、时间戳跨度的图谱。
   * @param {number} count 节点数
   * @param {object} [o] { clusters, seed, spanDays, withTimestamps }
   */
  function demo(count, o) {
    o = o || {};
    const rnd = mulberry32(o.seed === undefined ? 20260920 : o.seed);
    const clusters = o.clusters || Math.max(3, Math.round(Math.sqrt(count) / 2));
    const spanDays = o.spanDays === undefined ? 900 : o.spanDays;
    const withTs = o.withTimestamps !== false;

    const nodes = [];
    const links = [];
    const now = Date.now();
    const KINDS = ['page', 'page', 'page', 'page', 'journal', 'tag'];

    const perCluster = Math.floor(count / clusters);

    // 每簇一个 hub
    const hubs = [];
    for (let c = 0; c < clusters; c++) {
      const id = `c${c}-hub`;
      // hub 更老，这样时间旅行时它们先出现
      const createdAt = withTs ? now - spanDays * 86400000 * (0.75 + rnd() * 0.25) : undefined;
      nodes.push({ id, dbId: nodes.length + 1, label: `Hub ${c + 1}`, kind: 'page', createdAt });
      hubs.push(id);
    }

    for (let c = 0; c < clusters; c++) {
      const hub = hubs[c];
      const members = [];
      for (let k = 0; k < perCluster && nodes.length < count; k++) {
        const id = `c${c}-n${k}`;
        // ~10% 的节点不给时间戳 —— 真实图谱里也有这种页面，
        // 而且是 NaN 可见性路径（无时间戳 = 永远可见）唯一的验证来源
        const createdAt = (withTs && rnd() > 0.1)
          ? now - spanDays * 86400000 * Math.pow(rnd(), 0.6)     // 越新越多
          : undefined;
        nodes.push({
          id, dbId: nodes.length + 1,
          label: `Node ${c + 1}.${k + 1}`,
          kind: KINDS[(rnd() * KINDS.length) | 0],
          createdAt,
        });
        members.push(id);
        // 每个成员连 hub
        if (rnd() < 0.85) links.push({ source: id, target: hub });
        // 簇内互连
        if (members.length > 1 && rnd() < 0.4) {
          links.push({ source: id, target: members[(rnd() * (members.length - 1)) | 0] });
        }
      }
    }

    // 少量跨簇长边 —— 这是图谱"结构感"的来源
    const crossCount = Math.max(2, Math.round(clusters * 0.7));
    for (let i = 0; i < crossCount; i++) {
      const a = hubs[(rnd() * clusters) | 0];
      const b = hubs[(rnd() * clusters) | 0];
      if (a !== b) links.push({ source: a, target: b, label: 'rel' });
    }

    return { nodes, links };
  }

  // =========================================================================
  // 统一入口
  // =========================================================================
  /**
   * @param {object} o { source: 'logseq'|'demo', demoCount, includeParentLinks }
   */
  async function fetchData(o) {
    o = o || {};
    if (o.source === 'demo' || !LS()) return demo(o.demoCount || 400, o);
    try {
      return await fromLogseq(o);
    } catch (e) {
      console.error('[GFI] 拉取真实数据失败，退回 demo：', e);
      return demo(o.demoCount || 400, o);
    }
  }

  GFI.DataSource = { fetchData, fromLogseq, demo, query };
})(window.GFI);
