/*
 * Probe v4 — 两个决定性问题，一次回答
 * ===========================================================================
 * 贴到【主窗口】(top frame) 的 DevTools Console，图谱视图打开的状态下运行。
 *
 * A. WebGL 上传路径到底是 uniformMatrix3fv 还是 UBO？
 *    → 决定你文档里的「管道 A」是否存在。
 *
 * B. 能不能拿到 Pixi 的 Application 实例？
 *    → 决定你能否用 app.ticker.add() 跑真正的逐帧物理。
 *    → 关键：v2/v3 找的是 d3-force simulation，那东西【运行时根本不存在】。
 *      见 logic.cljs `(.stop simulation)` + `(dotimes [_ ticks] (.tick simulation))`：
 *      simulation 是 layout-nodes 的局部绑定，tick 完就被 GC 了，没人持有引用。
 *      真正持久的是 *graph-instances 里的 :app（Pixi Application）。
 *
 * C. 如果能拿到 app：stage 树长什么样，节点对象能不能被认出来。
 *    → pixi.cljs 用 (gobj/set sprite "logseqGraphNodeDisplay" kind) 打了字符串标记，
 *      这个标记能扛过 :advanced 编译，是我们的锚点。
 */
(() => {
  'use strict';

  const log = (t, ...a) => console.log(`%c[v4]%c ${t}`, 'color:#0af;font-weight:bold', 'color:inherit', ...a);
  const ok = (t, ...a) => console.log(`%c[v4]%c ${t}`, 'color:#0a0;font-weight:bold', 'color:inherit', ...a);
  const bad = (t, ...a) => console.warn(`[v4] ${t}`, ...a);

  // =========================================================================
  // A. WebGL 上传路径
  // =========================================================================
  function probeWebGL() {
    const canvas = document.querySelector('#global-graph canvas')
      || Array.from(document.querySelectorAll('canvas')).find(c => c.clientWidth > 250 && c.clientHeight > 250);
    if (!canvas) return bad('A: 找不到图谱 canvas，先打开图谱视图');

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return bad('A: 拿不到 WebGL context');

    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    log(`A: context = ${gl.constructor.name} (WebGL${isGL2 ? 2 : 1})`);

    const targets = [
      'uniformMatrix3fv', 'uniformMatrix4fv', 'uniform3f', 'uniform4fv',
      'bufferSubData', 'bindBufferBase', 'uniformBlockBinding', 'bufferData',
    ];
    const counts = {};
    const proto = Object.getPrototypeOf(gl);
    const saved = [];

    for (const name of targets) {
      counts[name] = 0;
      const orig = gl[name];
      if (typeof orig !== 'function') { counts[name] = 'N/A'; continue; }
      const wrapped = function (...args) { counts[name]++; return orig.apply(this, args); };
      // 同时patch实例和原型，避免Pixi走的是原型链
      try { gl[name] = wrapped; } catch (e) {}
      try { if (proto && proto[name] === orig) proto[name] = wrapped; } catch (e) {}
      saved.push([name, orig, proto && proto[name] === wrapped ? 'proto+inst' : 'inst']);
    }

    log('A: 采样 2.5 秒（期间请轻微拖动图谱，让它持续重绘）…');
    setTimeout(() => {
      for (const [name, orig] of saved) {
        try { gl[name] = orig; } catch (e) {}
        try { if (proto && proto[name] !== orig) proto[name] = orig; } catch (e) {}
      }
      console.table(counts);
      if (counts.uniformMatrix3fv === 0 && (counts.bufferSubData > 0 || counts.uniformBlockBinding > 0)) {
        bad('A: 结论 —— Pixi 在 WebGL2 下走 UBO，uniformMatrix3fv 从未被调用。管道 A 不存在。');
      } else if (counts.uniformMatrix3fv > 0) {
        ok('A: uniformMatrix3fv 确实被调用了。请在下面报告调用频率（但注意：改它=相机缩放，仍非逐节点斥力）。');
      }
    }, 2500);
  }

  // =========================================================================
  // B. Pixi Application 猎捕
  // =========================================================================
  const MAX_VISITED = 300000;
  const MAX_DEPTH = 8;
  const MAX_ARRAY = 60;
  const visited = new WeakSet();
  let visitCount = 0;

  function isDomNode(o) {
    return typeof Node !== 'undefined' && o instanceof Node;
  }

  // Pixi v8 Application 的形状特征
  function isPixiApplication(o) {
    try {
      return !!o && typeof o === 'object'
        && o.stage && Array.isArray(o.stage.children)
        && o.ticker && typeof o.ticker.add === 'function'
        && o.renderer && isDomNode(o.canvas);
    } catch (e) { return false; }
  }

  // *graph-instances 的形状特征：cljs Atom，值是「container DOM 元素 → {:app ...}」
  function isGraphInstancesAtom(o) {
    try {
      if (!o || typeof o !== 'object') return false;
      if (typeof o.deref !== 'function' || !('state' in o)) return false;
      const v = o.state;
      if (!v || typeof v !== 'object') return false;
      // 用迭代器枚举 cljs map（Object.keys 拿不到关键字条目！）
      const entries = cljsEntries(v);
      if (!entries) return false;
      return entries.some(([k, val]) => isDomNode(k) && val && (val.app || val.canvas));
    } catch (e) { return false; }
  }

  // cljs 集合不能靠 Object.keys 枚举内容 —— 这是 v2/v3 失败的另一个原因
  function cljsEntries(o) {
    try {
      if (typeof o[Symbol.iterator] === 'function') {
        const out = [];
        for (const e of o) {
          if (Array.isArray(e) && e.length >= 2) out.push([e[0], e[1]]);
          if (out.length > 500) break;
        }
        if (out.length) return out;
      }
    } catch (e) {}
    // PersistentArrayMap 的 arr 是扁平的 [k1,v1,k2,v2,...]
    try {
      if (Array.isArray(o.arr)) {
        const out = [];
        for (let i = 0; i + 1 < o.arr.length; i += 2) out.push([o.arr[i], o.arr[i + 1]]);
        return out;
      }
    } catch (e) {}
    return null;
  }

  const found = { app: null, appPath: null, instances: null, instancesPath: null };

  function descend(obj, path, depth) {
    if (found.app && found.instances) return;
    if (visitCount > MAX_VISITED) return;
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
    if (isDomNode(obj)) return;
    if (visited.has(obj)) return;
    visited.add(obj);
    visitCount++;

    if (!found.app && isPixiApplication(obj)) {
      found.app = obj; found.appPath = path;
      ok(`B: ★ 找到 Pixi Application @ ${path}`);
      return;
    }
    if (!found.instances && isGraphInstancesAtom(obj)) {
      found.instances = obj; found.instancesPath = path;
      ok(`B: ★★ 找到 *graph-instances @ ${path}`);
      // 顺着它直接拿 app
      try {
        for (const [k, v] of cljsEntries(obj.state) || []) {
          if (v && v.app) { found.app = v.app; found.appPath = `${path} → :app`; break; }
        }
      } catch (e) {}
    }
    if (depth >= MAX_DEPTH) return;

    // 先走 cljs 集合的迭代器
    const entries = cljsEntries(obj);
    if (entries) {
      for (const [k, v] of entries) {
        if (!found.app) descend(v, `${path}.<${typeof k === 'object' ? 'kw' : k}>`, depth + 1);
      }
    }

    let keys;
    try { keys = Object.keys(obj); } catch (e) { return; }
    for (const key of keys) {
      if (/^(__react|_react|webkit|__proto)/.test(key)) continue;
      let val;
      try { val = obj[key]; } catch (e) { continue; }   // getter 可能抛
      if (!val || (typeof val !== 'object' && typeof val !== 'function')) continue;
      if (isDomNode(val)) continue;
      if (Array.isArray(val)) {
        const n = Math.min(val.length, MAX_ARRAY);
        for (let i = 0; i < n; i++) {
          descend(val[i], `${path}.${key}[${i}]`, depth + 1);
          if (found.app && found.instances) return;
        }
      } else {
        descend(val, `${path}.${key}`, depth + 1);
      }
      if (found.app && found.instances) return;
    }
  }

  // React fiber 路径（v2 走过，但只沿着 current/memoizedState/next，漏了普通属性）
  function fromFibers() {
    const anchors = [
      document.querySelector('#global-graph'),
      document.querySelector('#global-graph canvas'),
      document.querySelector('.graph-canvas'),
    ].filter(Boolean);

    for (const el of anchors) {
      const fkey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!fkey) { log(`B: ${el.className || el.tagName} 上没有 React fiber`); continue; }
      let fiber = el[fkey];
      let hops = 0;
      while (fiber && hops++ < 40) {
        descend(fiber.memoizedProps, '<fiber.memoizedProps>', 0);
        descend(fiber.memoizedState, '<fiber.memoizedState>', 0);
        descend(fiber.stateNode, '<fiber.stateNode>', 0);
        if (found.app) return;
        fiber = fiber.return;
      }
      log(`B: 从 ${el.tagName} 向上走了 ${hops} 层 fiber`);
    }
  }

  function huntApp() {
    const roots = [
      ['window.frontend', () => window.frontend],
      ['window.logseq', () => window.logseq],
      ['window.LSPluginCore', () => window.LSPluginCore],
      ['window.__LSP__HOST__', () => window.__LSP__HOST__],
      ['window.PIXI', () => window.PIXI],
    ];

    for (const [name, get] of roots) {
      let val;
      try { val = get(); } catch (e) { continue; }
      if (!val) { log(`B: ${name} = ${val}`); continue; }
      log(`B: ${name} 存在，keys:`, Object.keys(val).slice(0, 40));
      descend(val, name, 0);
      if (found.app) return;
    }

    log('B: 前几个根没找到，walk React fiber…');
    fromFibers();
    if (found.app) return;

    log('B: fiber 也没有，扫全部 window 全局…');
    let scanned = 0;
    for (const key of Object.getOwnPropertyNames(window)) {
      if (/^(webkit|chrome|on|__react|__REACT)/i.test(key)) continue;
      let val;
      try { val = window[key]; } catch (e) { continue; }
      if (!val || (typeof val !== 'object' && typeof val !== 'function')) continue;
      scanned++;
      descend(val, `window.${key}`, 0);
      if (found.app) return;
    }
    log(`B: 扫过 ${scanned} 个全局`);
  }

  // =========================================================================
  // C. 拿到 app 之后：stage 树结构 + 节点标记
  // =========================================================================
  function probeStage(app) {
    const stage = app.stage;
    log('C: stage.children =', stage.children.length);
    console.table(stage.children.map((c, i) => ({
      i,
      type: c.constructor && c.constructor.name,
      label: c.label || '',
      children: Array.isArray(c.children) ? c.children.length : 0,
      visible: c.visible,
      alpha: Number((c.alpha ?? 1).toFixed(2)),
    })));

    // 递归数带 logseqGraphNodeDisplay 标记的对象
    let nodeDisplays = 0;
    const kinds = {};
    const samples = [];
    const walk = (o, d) => {
      if (!o || d > 8) return;
      let marked = false;
      try { marked = o.logseqGraphNodeDisplay !== undefined; } catch (e) {}
      if (marked) {
        nodeDisplays++;
        const k = String(o.logseqGraphNodeDisplay);
        kinds[k] = (kinds[k] || 0) + 1;
        if (samples.length < 5) {
          samples.push({
            type: o.constructor && o.constructor.name,
            kind: k,
            x: Math.round(o.x), y: Math.round(o.y),
            alpha: Number((o.alpha ?? 1).toFixed(2)),
            scaleX: Number(((o.scale && o.scale.x) ?? 1).toFixed(2)),
            ownKeys: Object.keys(o).slice(0, 20),
          });
        }
      }
      const kids = o.children;
      if (Array.isArray(kids)) for (const c of kids) walk(c, d + 1);
    };
    walk(stage, 0);

    ok(`C: 带 logseqGraphNodeDisplay 标记的显示对象 = ${nodeDisplays}`);
    console.log('C: 标记种类分布 =', kinds);
    console.log('C: 样本 =', samples);

    // 关键判定：显示对象上有没有节点 id
    if (samples.length) {
      const k = samples[0].ownKeys;
      const hasId = k.some(x => /id|node|key|name/i.test(x));
      if (hasId) ok('C: ★ 显示对象上似乎带了可识别字段，可以直接建立 sprite ↔ node-id 映射');
      else bad('C: 显示对象上看不到节点 id（预计如此：只在闭包内的 :displays* 里）。' +
               '物理仍可跑（位置可读写），但连边弹簧需要自己从 DB 重建拓扑。');
    }

    console.log('C: ticker 信息 =', {
      hasAdd: typeof app.ticker.add === 'function',
      listeners: app.ticker._head ? 'has _head' : 'no _head',
      started: app.ticker.started,
      maxFPS: app.ticker.maxFPS,
    });
    ok('C: 如果上面有值 → app.ticker.add(fn) 就是你的逐帧物理入口');
  }

  // =========================================================================
  // 跑
  // =========================================================================
  console.clear();
  log('=== Probe v4 开始 ===');
  probeWebGL();
  huntApp();

  console.log(`[v4] 访问对象数: ${visitCount}`);
  if (found.app) {
    ok(`B: 结论 —— 拿到了 app (${found.appPath})，Path 2 可行`);
    if (found.instances) ok(`B: *graph-instances @ ${found.instancesPath}`);
    probeStage(found.app);
  } else {
    bad('B: 结论 —— 够不着 Pixi app。Path 2 不可行，只能走「接管渲染」(Path 1)。');
    bad('B: 请把完整输出发回来。');
  }
})();
