/*
 * GFI.LiveWatch — "库变了，图谱要不要自己刷新"
 * 为什么需要它：图谱只在【打开那一刻】查一次库，之后无论库怎么变都不会再看第二眼。
 * 实机反馈：「删掉某些页面、改了部分正文，图谱自加载后就不再更新」。
 * 其中"缓存数据被当数据用"那一半已经修掉了（现在数据一律现查），
 * 这一半是"根本没有刷新机制"。
 *
 * ── 为什么监听 DOM 而不是 Logseq 的数据库事件 ──
 * Logseq 的 `logseq.DB.onBlockChanged(blockUuid, cb)` 参数是【某个块的 uuid】，
 * 只回调那一个块的变化（SDK 源码：`r.uuid === e && t(...)`）—— 拿它做"任何变动"
 * 的全局监听是错的。所以退一步用"内容变动必然伴随 DOM 变动"这个事实：
 * 我们本来就观察着 body（见 index.js 的 startObserver），这里只加过滤器。
 *
 * ── 两条必须守住的纪律 ──
 *  ① 【不能自激】刷新会改画布、也会改我们自己的工具栏（innerHTML 换图标、
 *     textContent 写日期），那些正好都是"内容类变动"。
 *     不过滤的话：刷新 → setData → 同步工具栏 → 又触发 → 又刷新 …… 死循环。
 *     所以凡是落在我们容器里的变动一律忽略。
 *  ② 【不能太贵】每次刷新 = 一次完整查库（实测 300~500ms / 68 节点的库）。
 *     所以带防抖，而且是"停手之后才查"。
 */
(function (GFI) {
  'use strict';
  if (GFI.LiveWatch) return;

  // 命中这些标签的【新增节点】才认为"用户在改内容"，而不是框架在重排布局。
  const CONTENT_TAGS = {
    P: 1, SPAN: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, LI: 1, A: 1,
    STRONG: 1, EM: 1, CODE: 1, PRE: 1, TABLE: 1, UL: 1, OL: 1,
    BLOCKQUOTE: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1,
  };

  /**
   * 这个节点属于"我们自己的东西 / 用户正在操作的 UI"吗？（都不该触发刷新）
   * @param {Node} node
   */
  function isIgnored(node) {
    let d = node && node.nodeType === 1 ? node : (node && node.parentNode);
    let n = 0;
    while (d && n++ < 12) {
      try {
        if (d.__gfiSkip) return true;
        // SVG 的 className 是 SVGAnimatedString，得走 baseVal
        const raw = (d.className && d.className.baseVal !== undefined)
          ? d.className.baseVal : (d.className || '');
        const cls = String(raw);
        if (/(^|\s)gfi-/.test(cls)) return true;
        // 设置面板只在被用户操作时变动，其中的 input/label 会命中 CONTENT_TAGS。
        // 不排除的话：改一个设置就白查一次库（不会死循环，但纯属浪费）。
        if (/settings|plugin/i.test(cls)) return true;
      } catch (e) { /* 忽略 */ }
      d = d.parentNode;
    }
    return false;
  }

  /**
   * 这批 DOM 变动看起来像不像"用户在编辑内容"？
   * @param {MutationRecord[]} muts
   * @returns {boolean}
   */
  function looksLikeContentEdit(muts) {
    if (!muts || !muts.length) return false;
    for (const m of muts) {
      if (isIgnored(m.target)) continue;

      if (m.type === 'characterData') return true;

      const added = m.addedNodes || [];
      for (const n of added) {
        if (isIgnored(n)) continue;
        if (n.nodeType === 3) {
          // 纯空白文本节点是框架噪音，不算内容
          if (String(n.nodeValue || '').trim()) return true;
          continue;
        }
        if (n.nodeType !== 1) continue;
        if (CONTENT_TAGS[String(n.tagName || '').toUpperCase()]) return true;
        // 深层也要看：编辑器插入的往往是个外层容器
        try {
          if (n.querySelector && n.querySelector('p, li, a, code, pre, table, textarea')) return true;
        } catch (e) {}
      }
    }
    return false;
  }

  /**
   * 造一个"内容变动 → 防抖刷新"的调度器。
   *
   * @param {object} hooks
   *   isMounted()  → 图谱现在挂着吗？（没挂就不用刷，下次打开会现查）
   *   refresh()    → 真正去做刷新（返回 Promise 最好）
   *   debounceMs   → 防抖窗口，默认 1500
   * @returns {{ notify(muts, reason?), cancel(), get pending(), get running() }}
   */
  function createScheduler(hooks) {
    hooks = hooks || {};
    const debounceMs = hooks.debounceMs > 0 ? hooks.debounceMs : 1500;
    let timer = null;
    let running = false;

    function notify(muts, reason) {
      if (typeof hooks.isMounted === 'function' && !hooks.isMounted()) return false;
      if (running) return false;                  // 我们自己正在写 DOM，忽略
      if (timer !== null) return false;           // 已经排队了
      if (!looksLikeContentEdit(muts)) return false;

      timer = setTimeout(() => {
        timer = null;
        if (typeof hooks.isMounted === 'function' && !hooks.isMounted()) return;
        running = true;
        Promise.resolve()
          .then(() => (typeof hooks.refresh === 'function' ? hooks.refresh(reason) : null))
          .catch((e) => { if (GFI.topWin && GFI.topWin.console) GFI.topWin.console.warn('[GFI] 自动刷新失败', e); })
          .then(() => { running = false; });
      }, debounceMs);
      return true;                                // 表示"已排队"
    }

    function cancel() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }

    return {
      notify,
      cancel,
      get pending() { return timer !== null; },
      get running() { return running; },
    };
  }

  GFI.LiveWatch = { looksLikeContentEdit, isIgnored, createScheduler, CONTENT_TAGS };
})(window.GFI = window.GFI || {});
