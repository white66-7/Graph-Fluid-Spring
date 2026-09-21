/*
 * 原生 Pixi 渲染器接管测试 —— node test/pixi-hook.js
 * ===========================================================================
 * 为什么单独一个脚本：
 *   overlay.js 平时跑不进无头测试（它碰 DOM）。但「盖住原生画板后把它的渲染
 *   循环停掉」这条机制【必须】有回归保护 —— 它的失败方式是静默的：
 *   停不掉只是白烧 GPU，不会有任何报错，页面上也看不出来。
 *
 * 这里用一个忠实于 Pixi v8 契约的假 Application 来跑 overlay.js 的【真实代码】。
 * 假货严格照着 Logseq 2.0.1 打包产物（resources/app.asar → /js/main.js）里的
 * 实现写，不是想象出来的：
 *   · Application.init() 在创建完 renderer、装好 ResizePlugin / TickerPlugin
 *     【之后】调用 globalThis.__PIXI_APP_INIT__(app, VERSION)
 *     （Pixi 源码 app/ApplicationInitHook.ts）
 *   · TickerPlugin 在 app 上挂 stop / start，内部就是 ticker.stop / ticker.start
 *   · Ticker.stop() → cancelAnimationFrame；start() → requestAnimationFrame
 *   · Application.destroy() 把 renderer 置 null
 *   · 图谱模块 h5c() 在 init() 的 then 回调里才 appendChild(app.canvas)
 *     —— 所以钩子必须推迟一个宏任务再匹配，否则会漏掉整个渲染循环
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  \x1b[32m✔\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  \x1b[31m✘\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log(`\n\x1b[36m━━━ ${t} ━━━\x1b[0m`); }

// ---------------------------------------------------------------------------
// 假宿主窗口 + 假 DOM（只 shim 到 mount() 够用为止）
// ---------------------------------------------------------------------------
function makeHost() {
  const host = {};
  host.window = host;
  host.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
  host.setTimeout = setTimeout;
  host.clearTimeout = clearTimeout;
  host.requestAnimationFrame = () => 1;
  host.cancelAnimationFrame = () => {};
  host.devicePixelRatio = 1;
  host.getComputedStyle = () => ({ position: 'relative' });
  host.ResizeObserver = class { observe() {} disconnect() {} };
  host.document = {
    documentElement: null, head: null, body: null,
    createElement: (t) => fakeEl(t),
    querySelector: () => null,
    getElementById: () => null,
  };
  host.document.documentElement = fakeEl('html');
  host.document.head = fakeEl('head');
  host.document.body = fakeEl('body');
  return host;
}

function fakeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), style: {}, children: [], className: '',
    isConnected: true, parentNode: null,
    _q: {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
        this.parentNode = null;
      }
    },
    querySelector(sel) { return this._q[sel] || null; },
    getElementById() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  };
  el.contains = function (n) {
    let p = n;
    while (p) { if (p === el) return true; p = p.parentNode; }
    return false;
  };
  return el;
}

/** 建一个装了 ns / config / overlay 的沙箱；topWin 就是返回的 host */
function makeRealm(host) {
  const sandbox = {
    console, Math, Date, Number, Array, Object, JSON, Map, Set,
    Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
    isNaN, parseInt, parseFloat, Infinity, NaN, setTimeout, clearTimeout,
    requestAnimationFrame: host.requestAnimationFrame,
    cancelAnimationFrame: host.cancelAnimationFrame,
    performance: host.performance,
    document: host.document,
    ResizeObserver: host.ResizeObserver,
  };
  sandbox.window = sandbox;
  sandbox.parent = host;              // parent !== window → topWin = parent
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['src/ns.js', 'src/config.js', 'src/overlay.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }
  return sandbox.window.GFI;
}

/** 照 Pixi v8 的契约造假 Application */
function makeApp(host) {
  const app = {
    stage: {}, renderer: null, _ticker: null,
    get canvas() { return this.renderer ? this.renderer.canvas : null; },
    get ticker() { return this._ticker; },
    set ticker(t) { this._ticker = t; },
    stop() { this._ticker.stop(); },
    start() { this._ticker.start(); },
  };

  function makeTicker() {
    let rafId = null;
    return {
      started: false,
      stop() {
        this.started = false;
        if (rafId !== null) { host.cancelAnimationFrame(rafId); rafId = null; }
      },
      start() {
        if (!this.started) { this.started = true; rafId = host.requestAnimationFrame(() => {}); }
      },
    };
  }

  app.init = function () {
    app.renderer = { canvas: fakeEl('canvas') };
    app._ticker = makeTicker();       // TickerPlugin: new Ticker()
    app.start();                      // TickerPlugin: autoStart 默认 true
    // ApplicationInitHook 排在插件列表最后 —— 也就是说钩子被调用时
    // app.stop / app.start / app.canvas 都已经可用
    if (typeof host.__PIXI_APP_INIT__ === 'function') host.__PIXI_APP_INIT__(app, '8.18.1');
    return app;
  };
  app.destroy = function () { app.renderer = null; app._ticker = null; };
  return app;
}

// ===========================================================================
section('A. 钩子必须在模块加载时就装好（要早于任何 Application 创建）');
const host = makeHost();
const GFI = makeRealm(host);
check('宿主窗口上有 __PIXI_APP_INIT__', typeof host.__PIXI_APP_INIT__ === 'function');

// 别人先装的钩子不能被顶掉
const host2 = makeHost();
let chained = 0;
host2.__PIXI_APP_INIT__ = () => { chained++; };
makeRealm(host2);
host2.__PIXI_APP_INIT__({ renderer: {} }, '8.18.1');
check('已有钩子会被链式调用而不是顶掉', chained === 1, `chained=${chained}`);

// ===========================================================================
section('B. 接管前：原生 App 正常跑着');
const root = fakeEl('div');                       // #global-graph
const canvasHost = fakeEl('div');                 // .graph-canvas
root.appendChild(canvasHost);
root._q['.graph-canvas'] = canvasHost;
root._q['.graph-bottom-toolbar'] = fakeEl('div');

const app = makeApp(host);
app.init();
canvasHost.appendChild(app.canvas);               // h5c() 里的 appendChild(app.canvas)
check('App 初始在运行', app.ticker.started === true);
check('App 的 canvas 在 #global-graph 里', root.contains(app.canvas));

// ===========================================================================
section('C. 接管：setNativeVisible(false) 停掉原生渲染循环');
const overlay = GFI.Overlay.mount(root);
check('mount 成功', !!overlay);
overlay.setNativeVisible(false);
check('原生 App 已被停掉', app.ticker.started === false, `started=${app.ticker.started}`);
check('诊断计数正确',
  overlay.pausedNativeRenderers === 1 && overlay.capturedNativeRenderers === 1,
  `paused=${overlay.pausedNativeRenderers} captured=${overlay.capturedNativeRenderers}`);
check('原生 canvas 依然只是被隐藏，没有被改成 display:none',
  canvasHost.style.display !== 'none');

overlay.setNativeVisible(false);
check('重复接管幂等', overlay.pausedNativeRenderers === 1,
  `paused=${overlay.pausedNativeRenderers}`);

// ===========================================================================
section('D. 接管之后才创建的 App（重进图谱 / React 重渲染）');
const app2 = makeApp(host);
app2.init();
canvasHost.appendChild(app2.canvas);
check('新 App 创建时是跑着的', app2.ticker.started === true);

setTimeout(() => {
  // 钩子里排的是 setTimeout(0)，这里等它跑完
  check('接管期间新建的 App 也会被停掉', app2.ticker.started === false,
    `started=${app2.ticker.started}`);
  check('诊断计数累加', overlay.pausedNativeRenderers === 2,
    `paused=${overlay.pausedNativeRenderers}`);

  section('E. 交还：setNativeVisible(true) 把循环还回去');
  overlay.setNativeVisible(true);
  check('两个 App 都恢复运行',
    app.ticker.started === true && app2.ticker.started === true,
    `app=${app.ticker.started} app2=${app2.ticker.started}`);
  check('暂停计数清零', overlay.pausedNativeRenderers === 0);

  section('F. 不属于本 root 的 Pixi App 绝不能误伤');
  const other = makeApp(host);
  other.init();
  fakeEl('div').appendChild(other.canvas);        // 挂在别的容器上
  GFI.Overlay.pauseNativeRenderers();             // takeoverRoot 此刻为空，应当是 no-op
  overlay.setNativeVisible(false);                // 重新接管，但 other 不在 root 里
  check('非接管 root 下的 App 不受影响', other.ticker.started === true);
  check('只停掉 root 里的那一个', app.ticker.started === false && app2.ticker.started === false);

  section('G. 已 destroy 的 App 要被回收，且不能因为它报错');
  app2.destroy();
  overlay.setNativeVisible(false);
  check('销毁过的 App 被剔除', overlay.capturedNativeRenderers === 2,
    `captured=${overlay.capturedNativeRenderers}`);
  check('存活的那个被停掉、没抛异常', app.ticker.started === false);

  section('H. unmount 把循环全部还回去');
  overlay.unmount();
  check('unmount 后原生循环恢复', app.ticker.started === true, `started=${app.ticker.started}`);
  check('unmount 后接管状态清空', overlay.pausedNativeRenderers === 0);
  check('unmount 不摘钩子（摘了会漏掉下一个 App）',
    typeof host.__PIXI_APP_INIT__ === 'function');
  GFI.Overlay.releasePixiCapture();
  check('releasePixiCapture 摘掉钩子', typeof host.__PIXI_APP_INIT__ === 'undefined');

  console.log(`\n${'═'.repeat(60)}`);
  if (fail === 0) console.log(`\x1b[32m全部通过\x1b[0m  ${pass} 项`);
  else {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 通过 ${pass} 项`);
  }
  process.exit(fail === 0 ? 0 : 1);
}, 10);
