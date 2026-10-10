/* 图谱数据来源 */
(function (GFI) {
  'use strict';
  if (GFI.DataSource) return;

  // window.logseq的存在性检查
  const LS = () => (typeof window.logseq !== 'undefined' ? window.logseq : null);

  // 工具
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

  // 日记页标题格式
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

  // 真实数据源
  // 在数据库未加载好时不重复报错
  let queryFailCount = 0;
  let queryFirstError = null;

  async function query(q) {
    const L = LS();
    // 数据库接口与查询api函数存在检验
    if (!L || !L.DB || !L.DB.datascriptQuery) return null;
    try {
      // 单参安全
      const r = await L.DB.datascriptQuery(q);
      return Array.isArray(r) ? r : null;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      queryFailCount++;
      if (queryFailCount === 1) {
        queryFirstError = msg;
        console.warn('[GFI] datascriptQuery 失败:', q.slice(0, 60), msg);
      }
      return null;
    }
  }

  // 从 Logseq 拉取节点与边。
  async function fromLogseq(opts) {
    opts = opts || {};
    const L = LS();
    if (!L) throw new Error('[GFI] logseq API 不可用');

    queryFailCount = 0;
    queryFirstError = null;

    // 内部实体隐藏
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
    applyFilter('property-def', await query('[:find ?e :where [?e :logseq.property/type ?t]]'));

    for (const ident of (GFI.config.data && GFI.config.data.hideClassIdents) || []) {
      applyFilter(`class:${ident}`,
        await query(`[:find ?e :where [?e :db/ident :${ident}]]`));
    }

    // 名字黑名单
    const nameBlocklist = new Set(
      (GFI.config.data && GFI.config.data.hideNames) || []
    );

    // 节点
    let rawPages = null;
    try {
      rawPages = await L.Editor.getAllPages();
    } catch (e) {
      console.warn('[GFI] getAllPages 失败，退回 datascript', e && e.message);
    }

    const nodes = [];
    // 已加入 nodes的节点ID
    const seen = new Set();

    if (Array.isArray(rawPages) && rawPages.length) {
      for (const p of rawPages) {
        const id = entityId(p);
        if (!id || seen.has(id) || excluded.has(id)) continue;
        const label = firstString(p, ['title']) || id;
        seen.add(id);
        nodes.push({
          id,
          dbId: Number(id),
          uuid: firstString(p, ['uuid']),
          label,
          kind: pageKind(p),
          pageName: firstString(p, ['name']) || label,
          createdAt: firstNumber(p, ['createdAt', 'created-at']),
        });
      }
    } else {
      // getAllPages 失效时
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

    // 边 
    const links = [];
    // 去重
    const edgeSeen = new Set();

    function addLink(a, b, label) {
      const s = String(a), t = String(b);
      if (!seen.has(s) || !seen.has(t) || s === t) return;
      // 生成独特的key值
      const key = s < t ? s + '|' + t : t + '|' + s;
      if (edgeSeen.has(key)) return;
      edgeSeen.add(key);
      links.push({ source: s, target: t });
    }

    // 块查询 [[]]引用
    const refRows = await query('[:find ?p ?r :where [?b :block/page ?p] [?b :block/refs ?r]]');
    if (refRows) for (const r of refRows) addLink(r[0], r[1]);

    // 标签引用 #
    const tagRows = await query('[:find ?p ?t :where [?p :block/tags ?t]]');
    const tagIds = new Set();
    if (tagRows) {
      // 标签与标题同名时,tagIds发挥作用
      for (const r of tagRows) { addLink(r[0], r[1]); tagIds.add(String(r[1])); }
    }

    // 标记 tag 类型
    for (const nd of nodes) {
      if (tagIds.has(nd.id)) nd.kind = 'tag';
    }

    if (opts.includeParentLinks) {
      const parRows = await query('[:find ?p ?par :where [?p :block/parent ?par]]');
      if (parRows) for (const r of parRows) addLink(r[0], r[1]);
    }

    // 节点黑名单处理
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

    // 日志
    if (queryFailCount > 0 && nodes.length === 0) {
      console.warn(`[GFI] 取数全部失败（${queryFailCount} 条查询）—— DB 可能还没就绪`
        + `；首条错因：${queryFirstError}`);
    } else if (queryFailCount > 0) {
      console.warn(`[GFI] 有 ${queryFailCount} 条查询失败，但取到了 ${nodes.length} 个节点（部分过滤条件未生效）`
        + `；首条错因：${queryFirstError}`);
    }
    const withTs = nodes.reduce((c, n) => c + (n.createdAt ? 1 : 0), 0);
    console.log(
      `[GFI] 数据源：${nodes.length} 节点 / ${links.length} 边  ` +
      `（${tagIds.size} 个标签，${withTs} 个带时间戳，共排除 ${excluded.size} 个内部实体）`
    );
    console.log('[GFI] 过滤明细：' + filterStats.join('  '));

    return { nodes, links };
  }

  // Demo 生成器
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
   * 合成图谱。
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
        // 10% 的节点时间戳为NaN
        const createdAt = (withTs && rnd() > 0.1)
          ? now - spanDays * 86400000 * Math.pow(rnd(), 0.6)     
          : undefined;
        nodes.push({
          id, dbId: nodes.length + 1,
          label: `Node ${c + 1}.${k + 1}`,
          kind: KINDS[(rnd() * KINDS.length) | 0],
          createdAt,
        });
        members.push(id);
        if (rnd() < 0.85) links.push({ source: id, target: hub });
        // 簇内互连
        if (members.length > 1 && rnd() < 0.4) {
          links.push({ source: id, target: members[(rnd() * (members.length - 1)) | 0] });
        }
      }
    }

    // 少量跨簇长边
    const crossCount = Math.max(2, Math.round(clusters * 0.7));
    for (let i = 0; i < crossCount; i++) {
      const a = hubs[(rnd() * clusters) | 0];
      const b = hubs[(rnd() * clusters) | 0];
      if (a !== b) links.push({ source: a, target: b});
    }

    return { nodes, links };
  }

  // 统一入口
  // 并发去重：相同请求在飞行中时复用同一个 Promise
  // 节省一次预热数据
  let inflight = null;
  let inflightKey = '';
  /**
   * @param {object} o { source: 'logseq'|'demo', demoCount, includeParentLinks }
   */
  function fetchData(o) {
    o = o || {};
    if (o.source === 'demo' || !LS()) return Promise.resolve(demo(o.demoCount || 400, o));

    // 每次请求生成特殊密钥
    const key = String(o.source || 'logseq') + '|' + (o.demoCount || 400) + '|' + (o.includeParentLinks ? 1 : 0);
    if (inflight && inflightKey === key) {
      console.log('[GFI] 数据请求合并');
      return inflight;
    }

    const p = (async function run() {
      try {
        return await fromLogseq(o);
      } catch (e) {
        console.error('[GFI] 拉取真实数据失败', e);
        return demo(o.demoCount || 400, o);
      }
    })();

    inflight = p;
    inflightKey = key;
    p.then(
      () => { if (inflight === p) { inflight = null; inflightKey = ''; } },
      () => { if (inflight === p) { inflight = null; inflightKey = ''; } }
    );
    return p;
  }

  GFI.DataSource = { fetchData, fromLogseq, demo, query };
})(window.GFI);
