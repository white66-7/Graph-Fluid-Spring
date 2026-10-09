/*
 * 假宿主冒烟测试 —— node test/smoke-boot.js
 * ===========================================================================
 * 为什么需要它：src/overlay.js 与 src/main.js 是仓库里【仅有的两块】只能在真实
 * Logseq 里跑的东西 —— 它们要 DOM、要 canvas、要 ResizeObserver。改这两个文件
 * 之后如果只跑 headless-sim.js，任何"运行期才炸"的错误（错别字、TDZ、
 * 调了不存在的 API）都要等用户开图谱才发现。
 *
 * 这里用一个最低限度的假宿主把这条路径跑一遍：
 *   · 假 document：createElement / querySelector / appendChild / 事件登记
 *   · 假 canvas 2D：Proxy，任何方法都返回安全值（measureText → 宽度）
 *   · 假 rAF：注册后由测试手动推进，帧时间自己给 —— 于是"第一帧"是可复现的
 *
 * ⚠ 它验的是【不炸 + 关键状态对】。像素正确性、观感、时序都验不了 ——
 *   那些只能在真实 Logseq 里用 __GFI__.timeline() / __GFI__.diag() 看。
 *   所以这个文件不能替代实机验证，只能挡住低级错误。
 *
 * ⚠ 本文件含中文。用 PowerShell 的 Set-Content / Out-File 改它会破坏编码
 *   （踩过：整个文件变成 272 个 U+FFFD，还并掉了换行变成语法错误）。
 *   要改就用 write / edit 工具。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let fail = 0, pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
}

// ---------------------------------------------------------------------------
// 假 canvas 2D 上下文
// ---------------------------------------------------------------------------
// 用 Proxy 而不是手写 40 个方法：渲染器里 ctx 的调用点会随功能增加，
// 手写列表一漏就是 "g.fillRect is not a function"。这里凡是不认识的成员
// 都当成"返回 0 的函数"，而 measureText 给个像样的宽度（标签占位要用）。
function fakeCtx(canvas) {
  const store = { canvas };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s || '').length * 6 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => 0;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

// ---------------------------------------------------------------------------
// 假 DOM
// ---------------------------------------------------------------------------
let nodeSeq = 0;
function makeEl(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(),
    __id: ++nodeSeq,
    children: [],
    parentNode: null,
    style: {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      getPropertyValue(k) { return this._p[k] || ''; },
      removeProperty(k) { delete this._p[k]; },
    },
    dataset: {},
    hidden: false,
    textContent: '',
    width: 1200, height: 800,
    clientWidth: 1200, clientHeight: 800,
    __listeners: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
    },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el[k] = v; },
    getAttribute(k) { return el[k]; },
    removeAttribute(k) { delete el[k]; },
    addEventListener(t, fn) { el.__listeners.push([t, fn]); },
    removeEventListener() {},
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: el.clientWidth, height: el.clientHeight }; },
    getContext() { return (el.__ctx = el.__ctx || fakeCtx(el)); },
    querySelector(sel) {
      for (const c of el.children) {
        if (matches(c, sel)) return c;
        const deep = c.querySelector && c.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        if (c.querySelectorAll) for (const d of c.querySelectorAll(sel)) out.push(d);
      }
      return out;
    },
    contains(n) {
      if (n === el) return true;
      for (const c of el.children) if (c.contains && c.contains(n)) return true;
      return false;
    },
    get isConnected() { return !!(el.parentNode || el === doc.body); },
  };
  return el;
}
function matches(el, sel) {
  if (!sel) return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

const head = makeEl('head');
const body = makeEl('body');
const doc = {
  head, body, documentElement: makeEl('html'),
  createElement: (t) => makeEl(t, doc),
  getElementById: () => null,
  querySelector: (s) => { if (s === '#global-graph') return doc.__graphRoot; return body.querySelector(s); },
  querySelectorAll: (s) => body.querySelectorAll(s),
  addEventListener() {}, removeEventListener() {},
};

// 图谱根节点（宿主在"用户点开图谱"时挂上去）
//
// ⚠ 两条踩过的坑：
//  ① 每次都要把上一节的 root 摘掉。doc.querySelector('#global-graph') 若退化成
//     body.querySelector，返回的是【第一个】—— 残留会让后面几节量到上一节的尺寸。
//  ② 尺寸必须在【元素本身】上设，别去设返回对象的属性。
//     踩过：`const root = attachGraphRoot(); root.clientWidth = 708;` —— 这里
//     `root` 是 {root, nativeCanvas, nativeToolbar}，那一行等于给包装对象加了个
//     字段，元素还是 1200×800，于是 Overlay.measure() 报 1200×800、内边距自适应
//     的断言假失败（生产代码其实是对的）。
//     所以尺寸做成参数，由这里统一设在元素上。
function attachGraphRoot(w, h) {
  if (doc.__graphRoot && doc.__graphRoot.parentNode) doc.__graphRoot.remove();
  const root = makeEl('div');
  root.id = 'global-graph';
  root.clientWidth = w || 1200;
  root.clientHeight = h || 800;
  const nativeCanvas = makeEl('canvas');
  nativeCanvas.classList.add('graph-canvas');
  const nativeToolbar = makeEl('div');
  nativeToolbar.classList.add('graph-bottom-toolbar');
  root.appendChild(nativeCanvas);
  root.appendChild(nativeToolbar);
  body.appendChild(root);
  doc.__graphRoot = root;
  return { root, nativeCanvas, nativeToolbar };
}

// ---------------------------------------------------------------------------
// 假 rAF
// ---------------------------------------------------------------------------
// 两种用法都要支持：
//   · pump(n)  —— 手动推进 n 帧（渲染循环的断言要的是"可复现的帧时间"）
//   · 异步任务（预热器）—— 它靠 rAF 分帧，没人推它就会永远挂着，所以
//     注册时挂一个自走的定时器；pump() 抢走队列时那个定时器自然是空转。
// ---------------------------------------------------------------------------
const rafQueue = [];
let rafSeq = 0;
let frameClock = 1000;

function scheduleDrain() {
  setTimeout(() => {
    if (!rafQueue.length) return;
    const batch = rafQueue.splice(0, rafQueue.length);
    frameClock += 16.7;
    for (const r of batch) { try { r.cb(frameClock); } catch (e) { errors.push(['throw', e.stack || e.message]); } }
    if (rafQueue.length) scheduleDrain();
  }, 0);
}

const errors = [];
const sandbox = {
  console: {
    log() {}, warn(...a) { errors.push(['warn', a.join(' ')]); },
    error(...a) { errors.push(['error', a.join(' ')]); },
    group() {}, groupEnd() {}, table() {}, info() {},
  },
  Math, Date, Number, Array, Object, JSON, Map, Set, WeakMap, Promise,
  Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array,
  isNaN, parseInt, parseFloat, Infinity, NaN, setTimeout, clearTimeout,
  performance: { now: () => frameClock },
};
sandbox.window = sandbox;
sandbox.parent = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = doc;
sandbox.devicePixelRatio = 2;
sandbox.getComputedStyle = () => ({ position: 'relative', getPropertyValue: () => '#0d0f14' });
sandbox.ResizeObserver = class { observe() {} disconnect() {} };
sandbox.MutationObserver = class { observe() {} disconnect() {} };
sandbox.requestAnimationFrame = (cb) => {
  rafQueue.push({ id: ++rafSeq, cb });
  scheduleDrain();
  return rafSeq;
};
sandbox.cancelAnimationFrame = (id) => {
  const i = rafQueue.findIndex((r) => r.id === id);
  if (i >= 0) rafQueue.splice(i, 1);
};
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

/** 推进 n 帧，每帧 +16.7ms */
function pump(n) {
  let ran = 0;
  for (let k = 0; k < n; k++) {
    const batch = rafQueue.splice(0, rafQueue.length);
    if (!batch.length) break;
    frameClock += 16.7;
    for (const r of batch) { try { r.cb(frameClock); ran++; } catch (e) { errors.push(['throw', e.stack || e.message]); } }
  }
  return ran;
}

console.log('\n\x1b[36m━━━ GFI 假宿主冒烟测试 ━━━\x1b[0m');

for (const f of ['ns', 'i18n', 'config', 'spatial', 'data', 'physics', 'effects', 'timeline', 'datasource', 'warm',
                 'livewatch', 'camera', 'renderer', 'toolbar', 'interaction', 'overlay']) {
  load(`src/${f}.js`);
}
check('除 main.js 外的模块全部加载完成', !!sandbox.GFI.Overlay && !!sandbox.GFI.Renderer && !!sandbox.GFI.Warm);
check('i18n 也加载完成（config.js 依赖它生成设置面板）', !!sandbox.GFI.i18n);
check('livewatch 也加载完成（index.js 依赖它做图谱自动刷新）',
  !!sandbox.GFI.LiveWatch && typeof sandbox.GFI.LiveWatch.createScheduler === 'function');
check('设置 schema 已由 i18n 生成（不是空数组）',
  Array.isArray(sandbox.GFI.settingsSchema) && sandbox.GFI.settingsSchema.length > 20,
  `schema ${sandbox.GFI.settingsSchema.length} 条，首条 = ${sandbox.GFI.settingsSchema[0] && sandbox.GFI.settingsSchema[0].key}`);
// relabelPanel 会遍历宿主 DOM —— 结构不对时【必须安静返回 0，绝不能抛】。
// 它跑在 onSettingsChanged 里，抛出去会把设置同步整条链打断。
// 假宿主里没有真实的 Logseq 设置面板，正好就是这个"找不到就安静"的用例。
check('relabelPanel 找不到面板时安静返回 0（不抛）', (() => {
  try { return sandbox.GFI.i18n.relabelPanel() === 0; } catch (e) { return 'throw: ' + e.message; }
})(), JSON.stringify(sandbox.GFI.__relabelStat || null));
check('加载期间没有报错', errors.length === 0, errors.length ? JSON.stringify(errors.slice(0, 2)) : '');

const GFI = sandbox.GFI;
const DT = GFI.DT;

// ---------------------------------------------------------------------------
// 造假数据 + 一份"已经沉降完"的布局（复刻 src/warm.js 的做法）
// ---------------------------------------------------------------------------
const demo = GFI.DataSource.demo(120, { seed: 5 });
const D0 = GFI.Data.build(demo.nodes, demo.links, null);
const sim0 = GFI.Physics.create(D0, GFI.config.physics);
let settleTicks = 0;
while (sim0.isAwake() && settleTicks < 2000) { sim0.tick(DT); settleTicks++; }
const layout = new Map();
for (let i = 0; i < D0.n; i++) layout.set(D0.id[i], { x: D0.x[i], y: D0.y[i] });
const warmBounds = GFI.Data.bounds(D0, false);

// ---------------------------------------------------------------------------
// 挂载（点开图谱）：正常尺寸 1200×800
// ---------------------------------------------------------------------------
const graph = attachGraphRoot();
GFI.Overlay.startRootWatch();
load('src/main.js');

const api = GFI.Main.boot({
  nodes: demo.nodes,
  links: demo.links,
  onNodeActivate() {},
});
check('boot 返回了 API', !!api);

if (api) {
  const overlay = api.overlay;

  // ---- ① 挂载即接管：原生画布立刻不可见 ----
  check('① 原生画布在挂载那一刻就被藏掉（native visibility=hidden）',
    graph.nativeCanvas.style.visibility === 'hidden', `visibility=${graph.nativeCanvas.style.visibility}`);
  check('① 原生工具栏也一起藏掉', graph.nativeToolbar.style.visibility === 'hidden');
  check('① 我们的容器在显示中（不是 display:none）',
    overlay.container.style.display !== 'none', `display="${overlay.container.style.display}"`);

  // boot 之后还没调 setData，所以 loader 必须亮着
  check('① 数据到达前 loader 亮着（顶替原生图谱，而不是让它露脸）',
    overlay.loaderVisible === true);

  // ---- ② setData 吃沉降布局 ----
  const res = api.setData(demo.nodes, demo.links, { layout });
  check('② 全部节点命中布局坐标', res.warm && res.adopted === res.n, `adopted=${res.adopted}/${res.n}`);

  // 相机必须已经对准【沉降布局】，且不在缓动中
  const gb = GFI.Data.bounds(api.data, true);
  const wantK = Math.min(
    (api.camera.W - 2 * api.fitPadding) / Math.max(1, gb.maxX - gb.minX),
    (api.camera.H - 2 * api.fitPadding) / Math.max(1, gb.maxY - gb.minY)
  );
  check('② 首帧相机就对准了最终布局（不需要第二次适配）',
    Math.abs(api.camera.k - wantK) < 1e-6 &&
    Math.abs(api.camera.x - (gb.minX + gb.maxX) / 2) < 1e-6,
    `k=${api.camera.k.toFixed(5)}（期望 ${wantK.toFixed(5)}）`);
  check('② 布局的包围盒与相机视野一致（量的是同一张图）',
    Math.abs((gb.maxX - gb.minX) - (warmBounds.maxX - warmBounds.minX)) < 1e-6);

  // ---- ③ 模拟必须睡着：第一帧不许再塌一次 ----
  const alpha0 = api.sim.alpha;
  check('③ 灌入布局后模拟是睡着的', !api.sim.isAwake(), `alpha=${alpha0}`);

  // 推 3 帧：第一帧画内容 + 交接（收 loader），后两帧只重绘
  const ran = pump(3);
  check('③ rAF 循环确实在跑', ran >= 1, `${ran} 帧`);

  check('③ 推了几帧之后 alpha 一点没涨（没有偷偷重热）',
    api.sim.alpha === alpha0, `alpha ${alpha0} → ${api.sim.alpha}`);
  check('③ 交接完成：loader 收起', overlay.loaderVisible === false);
  check('③ 原生画布仍然是隐藏的（没有回弹）',
    graph.nativeCanvas.style.visibility === 'hidden');

  // ---- ④ 真的画了东西（剔除 / 网格没被搞坏）----
  const st = api.stats;
  check('④ 上一帧真的画出了节点', !!st && st.nodes > 0,
    st ? `节点 ${st.nodes} / 边 ${st.edgesN}` : '（没有 stats）');

  // ---- ⑤ 命中测试能用（睡眠期网格必须被手动补过）----
  // 复刻 interaction.hitTest 的第一步：拿网格按半径查节点
  const idx = 3;
  const buf = new Int32Array(64);
  const hit = api.sim.grid.collectRadius(api.data, api.data.x[idx], api.data.y[idx], 4, buf, api.data.visible);
  let self = false;
  for (let p = 0; p < hit; p++) if (buf[p] === idx) self = true;
  check('⑤ 睡眠期网格能查到节点（否则点不中、也会被整片剔除）', self, `命中 ${hit} 个`);

  // ---- ⑥ 时序探针有记录，且顺序正确 ----
  const tl = GFI.Overlay.printEvents();
  const labels = tl.map((e) => e.label);
  const iMount = labels.findIndex((l) => l.indexOf('overlay 挂载完成') >= 0);
  const iHide = labels.findIndex((l) => l.indexOf('隐藏原生图谱') >= 0);
  const iData = labels.findIndex((l) => l.indexOf('数据装载') >= 0);
  const iTake = labels.findIndex((l) => l.indexOf('画布接管') >= 0);
  check('⑥ 探针记录了四条分界', [iMount, iHide, iData, iTake].every((i) => i >= 0),
    labels.join(' → '));
  check('⑥ 顺序正确：挂载 → 藏原生 → 装数据 → 接管',
    iMount >= 0 && iHide > iMount && iData > iHide && iTake > iData);

  // ---- ⑦ 切回原生图谱时必须还原 ----
  api.setNativeMode(true);
  check('⑦ 切回原生：原生画布恢复可见', graph.nativeCanvas.style.visibility !== 'hidden');
  check('⑦ 切回原生：loader 不会留在屏幕上（它盖在原生画布上）',
    overlay.loaderVisible === false);
  api.setNativeMode(false);
  check('⑦ 再切回来：容器重新显示 + 原生又藏起来',
    overlay.container.style.display !== 'none' && graph.nativeCanvas.style.visibility === 'hidden');

  // ---- ⑧ 拆掉之后不能残留 ----
  api.destroy('smoke test');
  check('⑧ 拆卸后容器从 DOM 里移除', !overlay.container.isConnected);
  check('⑧ 拆卸后原生画布还原成初始状态', graph.nativeCanvas.style.visibility !== 'hidden');

  // ---- ⑨ 实时改外观不会因为新增的 warm 字段炸掉 ----
  const api2 = GFI.Main.boot({ nodes: demo.nodes, links: demo.links });
  const before = api2.data.n;
  api2.setRender({ nodeSize: 1.2 });
  check('⑨ setRender 之后图谱还在（重建管线没炸）', api2.data.n === before, `n=${api2.data.n}`);
  api2.destroy('smoke test 2');
}

// ---------------------------------------------------------------------------
// 冷路径：没有缓存时也必须一步到位（同步抢跑）+ 小视口内边距自适应
// ---------------------------------------------------------------------------
// 这是修「首次进图谱：布局中 → 呈现 → 再适配视角」的那条路。
// 关键断言：抢跑拿到布局后 autoFitPending 必须是 false —— 只要它还是 true，
// frame() 就会在模拟睡着之后补一次 320ms 的相机缓动，那就是"接着才视角适配"。
async function syncSettlePath() {
  // ⚠ 把画布做成实机那个尺寸：708 × 243（用户的图谱挂在侧栏里，高度很小）。
  //   这正是"内边距必须自适应"那条断言的输入 —— 固定 72px 的话，
  //   243 高的窗口上下各吃掉 72，可视绘图区只剩 99px。
  //   尺寸必须在 attachGraphRoot 里设定（见那个函数的注释）。
  attachGraphRoot(708, 243);

  const a = GFI.Main.boot({ nodes: demo.nodes, links: demo.links });
  check('冷路径：boot 返回 API', !!a);
  if (!a) return;

  check('小视口下适配内边距自适应（不是固定吃 72px）',
    a.fitPadding > 10 && a.fitPadding < 30,
    `708×243 → padding=${a.fitPadding.toFixed(1)}px（配置上限 ${GFI.config.camera.fitPadding}）`);
  check('小视口下可视绘图区不再被内边距吃掉大半',
    a.camera.H - 2 * a.fitPadding > a.camera.H * 0.8,
    `可用高度 ${(a.camera.H - 2 * a.fitPadding).toFixed(0)}/${a.camera.H}px`);

  // 复刻 index.js acquireLayout 的第②级：有数据 → 同步抢跑。
  // ⚠ 先作废缓存，否则量到的是上一节留下的那份。
  GFI.Warm.invalidate('sync path test');
  const entry = GFI.Warm.settleNow(demo.nodes, demo.links, { source: 'demo', demoCount: 120 });
  check('② 同步抢跑在预算内跑完并给出布局', !!entry,
    entry ? `${entry.syncTicks} tick / ${entry.costMs}ms / 包围盒 ${entry.bbox.w}×${entry.bbox.h}` : '（null）');
  if (!entry) { a.destroy('sync path (skipped)'); return; }

  // 复刻 index.js 的 reveal 判据：抢跑 → playReveal = true
  // ⚠ 数据必须用【原始的】demo.nodes —— 预热条目里【没有 data 字段】了。
  //   这是刻意的结构约束：缓存只提供 layout，数据一律现查。
  //   （实机踩过：拿缓存里的 data 当数据 → 删页面/改正文之后图谱再也不更新）
  check('⚠ 预热条目里没有 data 字段（结构上禁止误用缓存数据）',
    entry.data === undefined, `entry.data = ${JSON.stringify(entry.data)}`);
  const r = a.setData(demo.nodes, demo.links, { layout: entry.layout, reveal: true });
  check('② 全部节点命中抢跑布局', r.warm && r.adopted === r.n, `adopted=${r.adopted}/${r.n}`);

  const gb = GFI.Data.bounds(a.data, true);
  const wantK = Math.min(
    (a.camera.W - 2 * a.fitPadding) / Math.max(1, gb.maxX - gb.minX),
    (a.camera.H - 2 * a.fitPadding) / Math.max(1, gb.maxY - gb.minY)
  );
  const wantX = (gb.minX + gb.maxX) / 2;
  check('② 首帧相机就对准最终布局',
    Math.abs(a.camera.k - wantK) < 1e-6 && Math.abs(a.camera.x - wantX) < 1e-6,
    `k=${a.camera.k.toFixed(5)}（期望 ${wantK.toFixed(5)}）`);

  const alpha0 = a.sim.alpha;
  check('② 模拟被按到睡着（第一帧之后不会自己再摊开）', !a.sim.isAwake(), `alpha=${alpha0}`);

  // 淡入是这次唯一的动画：它应该马上开始（第一帧 opacity < 1）
  const beforeFrames = a.overlay.canvas.style.opacity;
  pump(1);
  const afterOne = a.overlay.canvas.style.opacity;
  check('② 首帧交接完成：loader 收起', a.overlay.loaderVisible === false);
  check('② 画出节点', !!a.stats && a.stats.nodes > 0, a.stats ? `节点 ${a.stats.nodes}` : '（无 stats）');
  check('② 显现淡入确实在跑（第一帧 canvas opacity < 1）',
    afterOne !== '' && Number(afterOne) < 1, `首帧前 "${beforeFrames}" → 首帧后 "${afterOne}"`);

  pump(4);
  check('② 推几帧后 alpha 没涨（没有偷偷重热）', a.sim.alpha === alpha0, `alpha=${a.sim.alpha}`);

  // ★ 推足够多帧让淡入走完：opacity 必须回到 1（否则画面永远半透明）
  pump(60);
  check('② 显现淡入会收尾（canvas opacity 回到 1）',
    a.overlay.canvas.style.opacity === '', `opacity="${a.overlay.canvas.style.opacity}"`);

  // ★ 相机全程一步没动 —— 这才是"没有第二次视角适配"的直接证据
  check('② 相机在整个显现过程中一步没动',
    Math.abs(a.camera.k - wantK) < 1e-6 && Math.abs(a.camera.x - wantX) < 1e-6,
    `k=${a.camera.k.toFixed(5)} x=${a.camera.x.toFixed(1)}`);

  a.destroy('sync path');

  // ---- 部分命中：必须回退即时沉降 ----
  attachGraphRoot();
  const b = GFI.Main.boot({ nodes: demo.nodes, links: demo.links });
  const partial = new Map(entry.layout);
  partial.delete(String(demo.nodes[0].id));
  const r2 = b.setData(demo.nodes, demo.links, { layout: partial });
  check('部分命中：判定为「不是一步到位」', r2.warm === false && r2.adopted === r2.n - 1,
    `warm=${r2.warm} adopted=${r2.adopted}/${r2.n}`);
  check('部分命中：模拟醒着（这是老路径，会实时沉降）', b.sim.isAwake(), `alpha=${b.sim.alpha.toFixed(3)}`);
  pump(3);
  check('部分命中：loader 照样会收掉', b.overlay.loaderVisible === false);
  b.destroy('partial path');
}

// ---------------------------------------------------------------------------
// 抢跑超预算：必须【立刻】回退，并把半成品留给异步预热接着跑
// ---------------------------------------------------------------------------
async function syncSettleBudget() {
  const keep = GFI.config.warm.syncSettleMs;
  try {
    GFI.Warm.invalidate('budget test');

    // 预算设成 0 → 抢跑直接不干活
    GFI.config.warm.syncSettleMs = 0;
    check('预算 0 ⇒ 抢跑直接放弃（不死等）',
      GFI.Warm.settleNow(demo.nodes, demo.links, { source: 'demo', demoCount: 120 }) === null);

    // 前提：这张图确实需要几百个 tick
    check('前提：这张图确实要几百个 tick 才睡着', settleTicks > 100, `${settleTicks} tick`);

    // 预算极小（1ms）+ 时钟推进 → 必须跑一点就停、返回 null。
    // ⚠ 这里必须显式推进假时钟：settleNow 的预算检查是"墙上时间"，
    //   而本 harness 的时钟默认不动 —— 不动就等于"永远没超时"，
    //   这条断言会假通过（第一次写就踩了：它返回了完整布局）。
    GFI.Warm.invalidate('budget test 2');
    GFI.config.warm.syncSettleMs = 1;
    const realNow = sandbox.performance.now;
    let nowHits = 0;
    sandbox.performance.now = () => { nowHits++; return frameClock + nowHits * 0.5; };
    const partialResult = GFI.Warm.settleNow(demo.nodes, demo.links, { source: 'demo', demoCount: 120 });
    sandbox.performance.now = realNow;
    check('极小预算 ⇒ 返回 null（调用方据此回退即时沉降）', partialResult === null,
      partialResult ? `竟然跑完了：${partialResult.ticks} tick` : '');
    const st = GFI.Warm.state();
    check('超预算时把半成品留在 stats 里（没白跑）',
      !!st.最近一次 && st.最近一次.抢跑tick > 0,
      st.最近一次 ? `跑了 ${st.最近一次.抢跑tick} tick / ${st.最近一次.成本ms}ms` : '（无 stats）');

    // 异步预热必须能接着半成品跑完，并给出完整布局
    GFI.config.warm.syncSettleMs = keep;
    const done = await GFI.Warm.prewarm({ source: 'demo', demoCount: 120 });
    check('异步预热接上并跑完', !!done, done ? `${done.ticks} tick / ${done.n} 节点` : '（null）');
    check('接上之后缓存可用（下次进图谱直接命中）',
      !!GFI.Warm.peek(GFI.Warm.keyOf({ source: 'demo', demoCount: 120 })));
    check('异步预热跑出的布局覆盖全部节点', !!done && done.layout.size === done.n,
      done ? `${done.layout.size}/${done.n}` : '（null）');
  } finally {
    GFI.config.warm.syncSettleMs = keep;
  }
}

// ---------------------------------------------------------------------------
// 预热器本身：真跑一遍（分帧靠假 rAF；这里直接等它自己跑完）
// ---------------------------------------------------------------------------
async function prewarmModule() {
  const req = { source: 'demo', demoCount: 40 };
  check('预热指纹：数据源不同则 key 不同',
    GFI.Warm.keyOf({ source: 'demo', demoCount: 40 }) !== GFI.Warm.keyOf({ source: 'logseq' }),
    GFI.Warm.keyOf(req));

  // ★ 实机事故的回归守卫：日志里出现过 `预热启动 source=undefined demoCount=undefined`。
  //   keyOf() 会把 undefined 兜底成 'logseq'，fetchData 也会照常走真实数据源 ——
  //   两边"看起来都对"，但【缓存写入的 key 与 peek() 问出来的 key】从此永远对不上，
  //   预热等于白跑（用户连点两次图谱都走"同步抢跑"）。
  //   现在 index.js 的 prewarmRequest() 给死了兜底值；这条断言守住 keyOf 那一侧
  //   的等价性，任何一边改了默认值都会立刻炸出来。
  check('前提（回归）：缺失字段时 keyOf 自己会兜底成 logseq/400',
    GFI.Warm.keyOf({}) === 'logseq:400' && GFI.Warm.keyOf({ source: undefined }) === 'logseq:400',
    `${GFI.Warm.keyOf({})} / ${GFI.Warm.keyOf({ source: undefined, demoCount: undefined })}`);
  check('前提（回归）：undefined 与显式 logseq 必须落到同一个 key',
    GFI.Warm.keyOf({ source: undefined, demoCount: undefined }) === GFI.Warm.keyOf({ source: 'logseq', demoCount: 400 }));

  const entry = await GFI.Warm.prewarm(req);
  check('预热器跑出了缓存', !!entry && !!entry.layout,
    entry ? `${entry.n} 节点 / ${entry.m} 边 / ${entry.ticks} tick / ${entry.costMs}ms` : '（null）');
  if (!entry) return;

  check('缓存里的布局覆盖了全部节点', entry.layout.size === entry.n, `${entry.layout.size}/${entry.n}`);
  check('预热确实跑到了睡着（不是中途罢工）',
    entry.alpha <= GFI.config.physics.alphaMin * 1.001 && !entry.blocked,
    `alpha=${entry.alpha.toExponential(2)} blocked=${entry.blocked}`);
  // 分帧护栏：单帧 tick 数有硬上限，且这个上限【不依赖时钟】。
  // （本 harness 不推进时钟 —— 正是"计时器被钳住"那种情形，
  //  所以这条断言能真的挡住"一帧跑完"。）
  check('单帧 tick 数有硬上限（计时器被钳住时也不会一帧跑完）',
    entry.ticks > GFI.Warm.MAX_TICKS_PER_FRAME,
    `${entry.ticks} tick 分布在多帧，上限 ${GFI.Warm.MAX_TICKS_PER_FRAME}/帧`);

  // 同一份请求必须复用同一个 Promise / 同一份缓存（图谱可能随时打开）
  const again = await GFI.Warm.prewarm(req);
  check('重复预热直接命中缓存（不重跑）', again === entry);
  check('peek 能取到缓存', GFI.Warm.peek(entry.key) === entry);
  check('peek 用错的 key 取不到', GFI.Warm.peek('不存在的key') === null);

  // 作废之后必须真的丢掉
  GFI.Warm.invalidate('smoke test');
  check('invalidate 之后缓存没了', GFI.Warm.peek() === null && GFI.Warm.state().有缓存 === false);

  check('config.warm 各项齐备且默认开启',
    !!GFI.config.warm && GFI.config.warm.enabled === true &&
    GFI.config.warm.budgetMs > 0 && GFI.config.warm.maxTicksFactor > 0 &&
    Number.isFinite(GFI.config.warm.syncSettleMs) && Number.isFinite(GFI.config.warm.revealAnimMs),
    JSON.stringify(GFI.config.warm));

  // ★ 实机事故的回归守卫：数据源配置项挂在 runtime 下面，而所有读者都写成
  //   `GFI.config.dataSource` —— 读错一层，永远 undefined，然后静默走默认值。
  //   "静默"是这条 bug 最坏的地方：默认值恰好就是对的，所以行为看不出异常，
  //   只有用户真去改 dataSource 才会发现毫无反应（实机日志里那句
  //   `预热启动 source=undefined` 就是它）。
  //   这里同时钉住"值在 runtime 下"和"顶层没有同名键"两件事。
  check('数据源配置挂在 config.runtime 下（读者不该写成 config.dataSource）',
    GFI.config.runtime && GFI.config.runtime.dataSource !== undefined &&
    GFI.config.runtime.demoCount !== undefined,
    `runtime.dataSource=${JSON.stringify(GFI.config.runtime && GFI.config.runtime.dataSource)}`
    + ` runtime.demoCount=${JSON.stringify(GFI.config.runtime && GFI.config.runtime.demoCount)}`);
  check('顶层【没有】config.dataSource / config.demoCount（防止读者再读错一层）',
    GFI.config.dataSource === undefined && GFI.config.demoCount === undefined);
}

// ---------------------------------------------------------------------------
// 端到端复刻：复刻 index.js acquireLayout + mountGraph 的完整决策路径
// ---------------------------------------------------------------------------
// 这一节守的是【用户实际会走的那条路】。前面几节各自验了零件，这里把它们
// 串成 index.js 的真实顺序，并断言走的是哪一级：
//   ① 缓存命中 → 重开，立刻呈现、不淡入
//   ② 同步抢跑 → 首开，淡入呈现、不补第二次视角适配
async function endToEnd() {
  const req = { source: 'demo', demoCount: 120 };

  // ---- 第一次：预热已经跑完 → 缓存命中（等价于"用户等了很久才点图谱"）----
  GFI.Warm.invalidate('e2e start');
  GFI.Overlay.clearEvents();
  const warm = await GFI.Warm.prewarm(req);
  check('e2e：后台预热跑完并留下缓存', !!warm, warm ? `${warm.ticks} tick` : '（null）');

  attachGraphRoot();
  const a = GFI.Main.boot({ nodes: [], links: [] });
  const cached = GFI.Warm.peek(GFI.Warm.keyOf(req));
  check('e2e①：第二次进入直接命中缓存', !!cached);
  const r1 = a.setData(demo.nodes, demo.links, { layout: cached.layout, reveal: false });
  check('e2e①：一步到位', r1.warm && r1.adopted === r1.n, `${r1.adopted}/${r1.n}`);
  pump(2);
  check('e2e①：loader 收起 + 画布完全不透明（重开不该再淡入）',
    a.overlay.loaderVisible === false && a.overlay.canvas.style.opacity === '',
    `loader=${a.overlay.loaderVisible} opacity="${a.overlay.canvas.style.opacity}"`);
  a.destroy('e2e cached');

  // ---- 第二次：缓存被作废 + 没有在跑的预热 → 必须走"同步抢跑" ----
  //     这正是用户报的场景：插件刚起来就点开图谱。
  GFI.Warm.invalidate('e2e cold');
  GFI.Overlay.clearEvents();
  attachGraphRoot();
  const b = GFI.Main.boot({ nodes: [], links: [] });

  check('e2e②：前提 —— 没有缓存也没有在跑的预热',
    !GFI.Warm.peek(GFI.Warm.keyOf(req)) && !GFI.Warm.pending(GFI.Warm.keyOf(req)));
  const t0 = Date.now();
  const data = await GFI.DataSource.fetchData({ source: req.source, demoCount: req.demoCount });
  const sync = GFI.Warm.settleNow(data.nodes, data.links, req);
  const syncMs = Date.now() - t0;
  check('e2e②：同步抢跑拿到了布局（没退化成"等后台预热"）', !!sync,
    sync ? `${sync.ticks} tick / 实测墙钟 ${syncMs}ms` : '（null → 会退化成实时沉降）');
  if (!sync) { b.destroy('e2e cold'); return; }

  const r2 = b.setData(data.nodes, data.links, { layout: sync.layout, reveal: true });
  check('e2e②：一步到位（全部命中）', r2.warm && r2.adopted === r2.n, `${r2.adopted}/${r2.n}`);

  // 相机一次算对
  const gb = GFI.Data.bounds(b.data, true);
  const wantK = Math.min(
    (b.camera.W - 2 * b.fitPadding) / Math.max(1, gb.maxX - gb.minX),
    (b.camera.H - 2 * b.fitPadding) / Math.max(1, gb.maxY - gb.minY)
  );
  check('e2e②：相机对准最终布局', Math.abs(b.camera.k - wantK) < 1e-6, `k=${b.camera.k.toFixed(5)}`);

  pump(1);
  check('e2e②：第一帧交接完成，loader 收起', b.overlay.loaderVisible === false);
  check('e2e②：显现淡入在跑（首开该有这一次淡入）',
    b.overlay.canvas.style.opacity !== '' && Number(b.overlay.canvas.style.opacity) < 1,
    `opacity="${b.overlay.canvas.style.opacity}"`);

  // ★ 全程推进：相机的 k / x / y 必须【一个 bit 都不动】——
  //   这就是"没有第二次视角适配"的直接证据
  const k0 = b.camera.k, x0 = b.camera.x, y0 = b.camera.y;
  pump(80);
  check('e2e②：80 帧内相机一步没动（没有第二次视角适配）',
    b.camera.k === k0 && b.camera.x === x0 && b.camera.y === y0,
    `k ${k0.toFixed(5)}→${b.camera.k.toFixed(5)}  x ${x0.toFixed(1)}→${b.camera.x.toFixed(1)}`);
  check('e2e②：模拟全程睡着（画面不会自己再摊开）', !b.sim.isAwake(), `alpha=${b.sim.alpha}`);
  check('e2e②：淡入收尾（opacity 回到 1）', b.overlay.canvas.style.opacity === '',
    `opacity="${b.overlay.canvas.style.opacity}"`);

  // 时序探针里必须只有一条"隐藏原生图谱"，且全程没有切回去
  const labels = GFI.Overlay.printEvents().map((e) => e.label);
  const hides = labels.filter((l) => l.indexOf('隐藏原生图谱') >= 0).length;
  const backToNative = labels.filter((l) => l.indexOf('切回原生图谱') >= 0).length;
  check('e2e②：原生图谱只被隐藏一次、全程没有切回去', hides === 1 && backToNative === 0,
    labels.join(' → '));

  b.destroy('e2e cold');
  attachGraphRoot();   // 还给后面的用例一个干净的 DOM
}

// 依次跑（各自会往 DOM 上挂图谱根节点，不能并发）
(async function main() {
  await syncSettlePath();
  await syncSettleBudget();
  await prewarmModule();
  await endToEnd();
  finish();
})().catch((e) => {
  console.error('[smoke] 顶层异常', e && (e.stack || e.message));
  process.exit(1);
});

function finish() {
  console.log(`\n${'═'.repeat(60)}`);
  if (fail === 0) console.log(`\x1b[32m冒烟通过\x1b[0m  ${pass} 项`);
  else {
    console.log(`\x1b[31m冒烟失败 ${fail} 项\x1b[0m / 通过 ${pass} 项`);
    for (const f of failures) console.log('  · ' + f);
  }

  // 捕获到的运行期错误单独列出来 —— 它们是这个文件真正的产出
  const realErrors = errors.filter((e) => e[0] === 'throw' || e[0] === 'error');
  if (realErrors.length) {
    console.log('\n\x1b[31m运行期错误:\x1b[0m');
    for (const e of realErrors.slice(0, 10)) console.log('  ' + e[1].split('\n').slice(0, 4).join('\n  '));
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
}
