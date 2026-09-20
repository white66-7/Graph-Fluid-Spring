/*
 * Probe M0 — Logseq 2.0.1 DB schema 验证
 * ===========================================================================
 * 为什么不能用 probe-simulation.js 的方式（贴进主窗口控制台）：
 *   window.logseq 只在【插件 iframe】里才是完整的插件 SDK。主窗口里没有它。
 *
 * 用法：
 *   1. 确保插件已加载（Logseq 已通过 preferences.json 的 externals 指向本项目）
 *   2. 在主窗口 DevTools Console（Ctrl+Shift+I）里执行：
 *          __GFI_PROBE__()
 *   3. 把完整输出发回来
 *
 * 探针本体跑在插件 iframe 作用域，但通过 top.console 输出到你的控制台。
 *
 * 要回答的问题：
 *   A. logseq.Editor.getAllPages() 返回什么？含不含 createdAt？
 *   B. datascriptQuery 能否跑通 DB schema 的各种属性？返回形状如何？
 *   C. 三类链接（refs / tags / parent）各有多少条？
 *   D. 隐藏/删除页面的过滤条件怎么写？
 *   E. 图谱规模 —— 决定 LOD 档位是否必需
 */
(function () {
  'use strict';

  // 输出到主窗口控制台（插件 iframe 的 console 也会转发，但直接写 top 更稳）
  let out = console;
  try { if (window.parent && window.parent.console) out = window.parent.console; } catch (e) {}

  const S = 'color:#0aa;font-weight:bold';
  const OK = 'color:#0a0;font-weight:bold';
  const BAD = 'color:#c00;font-weight:bold';
  const DIM = 'color:#888';

  function section(t) { out.log(`\n%c━━━ ${t} ━━━`, S); }
  function ok(t, ...a) { out.log(`%c✔ ${t}`, OK, ...a); }
  function bad(t, ...a) { out.log(`%c✘ ${t}`, BAD, ...a); }
  function note(t, ...a) { out.log(`%c  ${t}`, DIM, ...a); }

  function describe(v, depth) {
    depth = depth || 0;
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t !== 'object') return t + ' ' + JSON.stringify(v);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return `Array(${v.length}) of ${describe(v[0], depth + 1)}`;
    }
    if (depth > 2) return '{…}';
    const keys = Object.keys(v);
    return '{' + keys.slice(0, 24).join(', ') + (keys.length > 24 ? `, …+${keys.length - 24}` : '') + '}';
  }

  // 剥掉可能存在的 cljs 包装，拿到可 JSON 化的值
  function plain(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    if (depth > 3) return '[deep]';
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.slice(0, 3).map(x => plain(x, depth + 1));
    const o = {};
    let keys = [];
    try { keys = Object.keys(v); } catch (e) { return '[no-keys]'; }
    for (const k of keys.slice(0, 30)) {
      try { o[k] = plain(v[k], depth + 1); } catch (e) { o[k] = '[getter threw]'; }
    }
    return o;
  }

  // 单个 datascript 查询：永不抛，总是返回诊断对象
  async function q(label, query) {
    const LOGSEQ = window.logseq;
    const t0 = (window.performance || Date).now();
    try {
      // 注意：SDK 里 datascriptQuery 会 t.pop() 掉最后一个参数。
      // 不带 input 的查询直接单参调用是安全的。
      const r = await LOGSEQ.DB.datascriptQuery(query);
      const ms = Math.round((window.performance || Date).now() - t0);
      if (!Array.isArray(r)) {
        bad(`${label}: 返回值不是数组 → ${describe(r)}`, plain(r));
        return { label, ok: false, shape: describe(r), sample: plain(r), ms };
      }
      ok(`${label}: ${r.length} 条  (${ms}ms)`);
      if (r.length) {
        out.log(`   形状: ${describe(r[0])}`);
        out.log('   样本:', plain(r.slice(0, 3)));
      } else {
        note('（空结果 —— 可能属性名不对，或该图谱确实没有这类数据）');
      }
      return { label, ok: true, count: r.length, shape: describe(r[0]), sample: plain(r.slice(0, 3)), ms };
    } catch (e) {
      bad(`${label}: 抛出异常 → ${e && e.message ? e.message : e}`);
      return { label, ok: false, error: String(e && e.message || e) };
    }
  }

  async function run() {
    const LOGSEQ = window.logseq;
    if (!LOGSEQ) {
      out.error('[M0] window.logseq 不存在 —— 这个脚本必须在插件 iframe 作用域里跑。' +
                '请确认插件已加载，然后在主窗口控制台执行 __GFI_PROBE__()');
      return null;
    }

    const report = { app: null, allPages: null, queries: [], scale: null };

    out.clear && out.clear();
    out.log('%c[M0] Logseq 图谱数据层探针', 'color:#06f;font-size:15px;font-weight:bold');

    // ---------------------------------------------------------------------
    section('0. 环境');
    // ---------------------------------------------------------------------
    try {
      const info = await LOGSEQ.App.getInfo();
      report.app = plain(info);
      ok('App.getInfo()');
      out.log('   ', plain(info));
    } catch (e) {
      bad('App.getInfo() 失败: ' + (e && e.message));
    }
    note('SDK version:', LOGSEQ.version);
    try { note('baseInfo:', plain(LOGSEQ.baseInfo)); } catch (e) {}

    // ---------------------------------------------------------------------
    section('1. logseq.Editor.getAllPages()');
    // ---------------------------------------------------------------------
    try {
      const pages = await LOGSEQ.Editor.getAllPages();
      if (!Array.isArray(pages)) {
        bad(`不是数组 → ${describe(pages)}`);
        report.allPages = { ok: false, shape: describe(pages) };
      } else {
        ok(`返回 ${pages.length} 个页面`);
        report.allPages = {
          ok: true,
          count: pages.length,
          firstKeys: pages.length ? Object.keys(pages[0]) : [],
          sample: plain(pages.slice(0, 3)),
        };
        if (pages.length) {
          out.log('   第一个页面的字段:', Object.keys(pages[0]));
          out.log('   前 3 个样本:', plain(pages.slice(0, 3)));

          // 关键：有没有创建时间？
          const k = pages[0] || {};
          const timeKeys = Object.keys(k).filter(x => /created|time|date/i.test(x));
          if (timeKeys.length) {
            ok(`★ 发现时间字段: ${timeKeys.join(', ')}`);
            for (const tk of timeKeys) {
              const vals = pages.slice(0, 5).map(p => p[tk]);
              out.log(`     ${tk} 样本值:`, vals);
            }
            report.allPages.timeKeys = timeKeys;
          } else {
            bad('★ getAllPages() 里没有 created/date 类字段 —— 时间戳只能走 datascriptQuery');
          }
        }
      }
    } catch (e) {
      bad('getAllPages() 失败: ' + (e && e.message));
      report.allPages = { ok: false, error: String(e && e.message) };
    }

    // ---------------------------------------------------------------------
    section('2. datascriptQuery —— 节点属性');
    // ---------------------------------------------------------------------
    report.queries.push(await q(
      'Q1 页面标题+创建时间  [?e :block/title][?e :block/created-at]',
      '[:find ?e ?title ?created :where [?e :block/title ?title] [?e :block/created-at ?created]]'
    ));

    report.queries.push(await q(
      'Q2 全部 :block/name 实体',
      '[:find ?e ?name :where [?e :block/name ?name]]'
    ));

    report.queries.push(await q(
      'Q3 只有 :block/title（不看创建时间）',
      '[:find ?e ?title :where [?e :block/title ?title]]'
    ));

    report.queries.push(await q(
      'Q4 :block/created-at 全局存在性',
      '[:find ?e ?t :where [?e :block/created-at ?t]]'
    ));

    // ---------------------------------------------------------------------
    section('3. datascriptQuery —— 链接（拓扑）');
    // ---------------------------------------------------------------------
    report.queries.push(await q(
      'L1 引用   [?b :block/page ?p][?b :block/refs ?r]',
      '[:find ?p ?r :where [?b :block/page ?p] [?b :block/refs ?r]]'
    ));

    report.queries.push(await q(
      'L2 引用(去重) [?b :block/page ?p][?b :block/refs ?r] distinct',
      '[:find ?p ?r :where [?b :block/page ?p] [?b :block/refs ?r]]'
    ));

    report.queries.push(await q(
      'L3 标签   [?p :block/tags ?t]',
      '[:find ?p ?t :where [?p :block/tags ?t]]'
    ));

    report.queries.push(await q(
      'L4 父子   [?p :block/parent ?par]',
      '[:find ?p ?par :where [?p :block/parent ?par]]'
    ));

    report.queries.push(await q(
      'L5 反向引用 [?b :block/refs ?r]',
      '[:find ?b ?r :where [?b :block/refs ?r]]'
    ));

    // ---------------------------------------------------------------------
    section('4. 过滤条件 —— 隐藏 / 删除');
    // ---------------------------------------------------------------------
    report.queries.push(await q(
      'F1 :logseq.property/hide? = true',
      '[:find ?e :where [?e :logseq.property/hide? true]]'
    ));

    report.queries.push(await q(
      'F2 :logseq.property/deleted-at 存在',
      '[:find ?e ?d :where [?e :logseq.property/deleted-at ?d]]'
    ));

    report.queries.push(await q(
      'F3 :logseq.property/exclude-from-graph-view 存在',
      '[:find ?e ?v :where [?e :logseq.property/exclude-from-graph-view ?v]]'
    ));

    report.queries.push(await q(
      'F4 :block/journal? = true（日记页）',
      '[:find ?e :where [?e :block/journal? true]]'
    ));

    // ---------------------------------------------------------------------
    section('5. 规模统计 —— 决定 LOD');
    // ---------------------------------------------------------------------
    try {
      const cnt = async (label, query) => {
        const r = await LOGSEQ.DB.datascriptQuery(query);
        const n = Array.isArray(r) ? r.length : -1;
        note(`${label}: ${n}`);
        return n;
      };
      const pagesN = await cnt('实体总数 (:block/name)', '[:find ?e :where [?e :block/name ?n]]');
      const titleN = await cnt('标题总数 (:block/title)', '[:find ?e :where [?e :block/title ?t]]');
      const refsN = await cnt('引用边数', '[:find ?b ?r :where [?b :block/refs ?r]]');
      const tagsN = await cnt('标签边数', '[:find ?p ?t :where [?p :block/tags ?t]]');
      const parN = await cnt('父子边数', '[:find ?p ?par :where [?p :block/parent ?par]]');
      report.scale = { pagesN, titleN, refsN, tagsN, parN };

      const est = Math.max(titleN, pagesN);
      out.log('');
      if (est > 5000) bad(`规模 ${est} —— LOD 是必需项（L2/L3 档）`);
      else if (est > 2200) ok(`规模 ${est} —— 需要 L1/L2 档`);
      else if (est > 800) ok(`规模 ${est} —— L0/L1 足够`);
      else ok(`规模 ${est} —— L0 档，Canvas2D 余量充足`);
    } catch (e) {
      bad('规模统计失败: ' + (e && e.message));
    }

    // ---------------------------------------------------------------------
    section('完成');
    out.log('%c把以上完整输出复制发回。', 'color:#06f;font-weight:bold');
    try { window.__GFI_REPORT__ = report; } catch (e) {}
    try { window.parent.__GFI_REPORT__ = report; } catch (e) {}
    note('（结构化结果已挂在 window.__GFI_REPORT__，可 JSON.stringify 后复制）');
    return report;
  }

  // 暴露给主窗口控制台
  try { window.parent.__GFI_PROBE__ = run; } catch (e) { window.__GFI_PROBE__ = run; }
  window.__GFI_PROBE__ = run;

  out.log('%c[M0] 就绪 —— 在主窗口控制台执行: __GFI_PROBE__()', 'color:#06f;font-weight:bold');
})();
