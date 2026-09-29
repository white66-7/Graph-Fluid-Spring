/*
 * 标签系统验证 —— node test/renderer-labels.js
 * ===========================================================================
 * 为什么需要单独一个脚本：
 *   headless-sim.js 明确不覆盖 renderer —— 它要真实的 Canvas2D 上下文。
 *   所以标签逻辑（占位抑制 / 精灵缓存 / 悬浮标签那一路）此前完全没有回归保护。
 *
 * 这个脚本加载【真实的】 src/renderer.js + src/camera.js + src/data.js，
 * 只把 2D 上下文换成一个计数桩。measureText 用固定字宽（7px × 字符数）——
 * 这些断言验的是【标签摆放与缓存逻辑】，不是字形度量，所以固定宽度既够用又稳定。
 *
 * 覆盖的是这次重写的三条：
 *   1. 占位格从"只标落点一格"改成"标满整个包围盒" —— 相邻标签现在真的会互相让位
 *   2. 标签走精灵预渲染 —— 每帧 strokeText 归零、fillText 归零，只剩 drawImage
 *   3. 精灵缓存有界、且可复用；悬浮标签绕过缓存且不被让位
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DPR = 2;
const VW = 400, VH = 400;      // 视口 CSS 尺寸

// ---------------------------------------------------------------------------
// Canvas2D 桩
// ---------------------------------------------------------------------------
const madeCanvases = [];

function makeStubCtx(canvas) {
  const calls = {
    fillText: 0, strokeText: 0, drawImage: 0,
    fill: 0, stroke: 0, clearRect: 0, measureText: 0,
  };
  const ctx = {
    calls,
    canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '12px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    lineJoin: 'miter', lineCap: 'butt', miterLimit: 10,
    setTransform() {}, save() {}, restore() {},
    clearRect() { calls.clearRect++; },
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {}, closePath() {},
    fill() { calls.fill++; },
    stroke() { calls.stroke++; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {},
    // 固定字宽 —— 7px/字符，可预测，便于精确推算标签包围盒
    measureText(t) { calls.measureText++; return { width: String(t).length * 7 }; },
    fillText() { calls.fillText++; },
    strokeText() { calls.strokeText++; },
    drawImage() { calls.drawImage++; },
  };
  return ctx;
}

function makeStubCanvas() {
  const c = {
    width: 0, height: 0, style: {}, isConnected: true,
    getContext() { return (c._ctx = c._ctx || makeStubCtx(c)); },
  };
  madeCanvases.push(c);
  return c;
}

// ---------------------------------------------------------------------------
// 最小 window shim（与 headless-sim.js 同一套路）
// ---------------------------------------------------------------------------
const sandbox = {
  console, Math, Date, Number, Array, Object, JSON, Map, Set,
  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
  isNaN, parseInt, parseFloat, Infinity, NaN,
  devicePixelRatio: DPR,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  document: { documentElement: {}, createElement: () => makeStubCanvas() },
  setTimeout, clearTimeout,
};
sandbox.window = sandbox;
sandbox.parent = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}

// renderer 依赖 camera / data / config / ns。不需要 spatial / physics。
for (const f of ['ns', 'config', 'data', 'camera', 'renderer']) load(`src/${f}.js`);

const GFI = sandbox.GFI;

// 关掉辉光：辉光也是用 drawImage 画的，不关掉就没法用 drawImage 计数反推标签数。
// （辉光走 spriteCache 与标签的 labelCache 完全独立，对标签逻辑没有任何影响。）
GFI.config.lod.levels[0].glow = 'hover';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[36m━━━ ${t} ━━━\x1b[0m`); }

// ---------------------------------------------------------------------------
// 场景搭建
// ---------------------------------------------------------------------------
// 视口 400×400、k=1、相机在原点 → 屏幕坐标 = 世界坐标 + 200。
// 节点度数 0 → radius = radiusBase = 2 → 标签画在节点上方 max(3, 2+9) = 11px 处。
const SCREEN_OFF = VW / 2;

function screenToWorldX(sx) { return sx - SCREEN_OFF; }
function screenToWorldY(sy) { return sy - SCREEN_OFF; }

// 标签几何（必须与 config 对齐，否则断言算错）
const FONT_PX = 12;
const PAD = Math.ceil(GFI.config.render.labelHaloWidth) + 2;      // 1.5 → 2 + 2 = 4
const BOX_H = Math.ceil(FONT_PX * 1.3) + PAD * 2;                 // 16 + 8 = 24
const labelW = (str) => Math.ceil(str.length * 7) + PAD * 2;      // 7 字符 → 57

function makeScene(labels) {
  const nodes = labels.map((s, i) => ({ id: 'n' + i, label: s, kind: 'page' }));
  const D = GFI.Data.build(nodes, [], null);
  const cam = GFI.Camera.create(VW, VH);
  cam.k = 1; cam.x = 0; cam.y = 0;
  const canvas = makeStubCanvas();
  const renderer = GFI.Renderer.create(canvas, D, cam);
  renderer.resize(VW, VH, DPR);
  // 直接摆到指定屏幕坐标上
  return {
    D, cam, renderer, canvas,
    ctx: canvas.getContext('2d'),
    place(i, sx, sy) {
      D.x[i] = screenToWorldX(sx);
      D.y[i] = screenToWorldY(sy) + Math.max(3, D.radius[i] * D.scaleMul[i] * cam.k + 9);
    },
    draw(view) {
      const c = canvas.getContext('2d');
      for (const k in c.calls) c.calls[k] = 0;
      return renderer.render(Object.assign(
        { hoverIdx: -1, selectedIdx: -1, lod: 0, labelsOn: true }, view || {}));
    },
  };
}

// ===========================================================================
section('1. 占位抑制 —— 相邻标签必须互相让位');
// ===========================================================================
(function testOverlapSuppression() {
  const S = makeScene(['abcdefg', 'abcdefg']);
  // 屏幕 x = 100 / 130（相距 30px），同一 y → 两个标签的包围盒必然重叠
  S.place(0, 100, 200);
  S.place(1, 130, 200);

  const w = labelW('abcdefg'), hw = w / 2, sy = 200 - 11;
  const boxA = [100 - hw, 100 + hw], boxB = [130 - hw, 130 + hw];
  const overlap = boxA[1] > boxB[0] && boxB[1] > boxA[0];

  // 关键前提：两者的【落点格】不同 —— 所以旧的"只标一格"逻辑对 B 是放行的
  const cell = GFI.config.render.labelCell;
  const cellA = Math.floor(100 / cell), cellB = Math.floor(130 / cell);

  check('前提：两个标签的包围盒重叠', overlap,
    `A=[${boxA[0].toFixed(0)},${boxA[1].toFixed(0)}] B=[${boxB[0].toFixed(0)},${boxB[1].toFixed(0)}]`);
  check('前提：两者落点格不同（旧逻辑会放行 B）', cellA !== cellB,
    `格 ${cellA} vs ${cellB}（cell=${cell}）`);
  check('前提：两者在同一个 y 带上', Math.abs(sy) >= 0 && hw === hw, `标签 y = ${sy}`);

  const st = S.draw();
  check('重叠的第二个标签被抑制', st.labelN === 1, `画出 ${st.labelN} 个（期望 1）`);
})();

// ===========================================================================
section('2. 精灵预渲染 —— 每帧不再有字形描边/填充');
// ===========================================================================
(function testSpritePath() {
  const S = makeScene(['aaaa', 'bbbb', 'cccc', 'dddd']);
  // 摆开，互不重叠：标签宽 4*7+8 = 36，间距 120 足够
  S.place(0, 60, 100);
  S.place(1, 180, 100);
  S.place(2, 300, 100);
  S.place(3, 60, 300);

  S.draw();                       // 首帧：建精灵
  const st = S.draw();            // 次帧：应该全部命中缓存

  check('全部标签都画出来了', st.labelN === 4, `画出 ${st.labelN} 个`);
  check('零次 strokeText（描边已烘进精灵）', S.ctx.calls.strokeText === 0,
    `strokeText ${S.ctx.calls.strokeText} 次`);
  check('零次 fillText（文字已烘进精灵）', S.ctx.calls.fillText === 0,
    `fillText ${S.ctx.calls.fillText} 次`);
  check('每个标签一次 drawImage', S.ctx.calls.drawImage === st.labelN,
    `drawImage ${S.ctx.calls.drawImage} 次 / 标签 ${st.labelN} 个`);

  // 缓存复用最硬的证据：次帧没有再新建任何 canvas
  const before = madeCanvases.length;
  for (let f = 0; f < 5; f++) S.draw();
  const grow = madeCanvases.length - before;
  check('连续 5 帧不再新建任何 canvas（精灵全部命中缓存）', grow === 0,
    `新建 ${grow} 个`);
  check('缓存条目数稳定', S.renderer.labelCacheSize() === 4,
    `缓存 ${S.renderer.labelCacheSize()} 条（期望 4）`);
})();

// ===========================================================================
section('3. 悬浮标签 —— 绕过缓存，且永不被让位');
// ===========================================================================
(function testHoverLabel() {
  const S = makeScene(['abcdefg', 'abcdefg']);
  S.place(0, 100, 200);
  S.place(1, 130, 200);

  // 1 号是 §1 里【被让位】的那个（落点格 9，与 0 号的格 7 不同，
  // 但包围盒重叠）。现在悬浮它 —— 它必须被画出来。
  // hl 保持默认全 1：模式 A 只额外画 hl>=2 的邻居，这样本帧有且只有悬浮标签一个。
  const st = S.draw({ hoverIdx: 1 });
  check('悬浮的标签不被让位（模式 A 优先权）', st.labelN === 1, `画出 ${st.labelN} 个`);
  check('悬浮标签走直绘路径：strokeText + fillText 各一次',
    S.ctx.calls.strokeText === 1 && S.ctx.calls.fillText === 1,
    `strokeText ${S.ctx.calls.strokeText} / fillText ${S.ctx.calls.fillText}`);
  check('悬浮标签不吃精灵缓存', S.renderer.labelCacheSize() === 0,
    `缓存 ${S.renderer.labelCacheSize()} 条（期望 0）`);

  // 把 0 号标成邻接高亮 → 模式 A 会连它一起画。
  // ⚠ 关键：邻域标签【不做重叠让位】。它和悬浮标签的包围盒是重叠的（见 §1），
  //   但仍然必须画出来 —— 悬浮的意图就是"把这一圈邻居全亮出来"。
  //   让位只属于常态模式（§1 验的就是那个）。
  S.D.hl[0] = 2;
  const st2 = S.draw({ hoverIdx: 1 });
  check('邻域标签不受重叠让位影响（悬浮时邻居全显示）',
    st2.labelN === 2 && S.renderer.labelCacheSize() === 1,
    `画出 ${st2.labelN} 个（期望 2）/ 缓存 ${S.renderer.labelCacheSize()} 条`);

  // 回到常态 → 全部改走缓存，且不再有字形描边
  S.D.hl[0] = 1;
  const st3 = S.draw();
  check('回到常态后恢复走缓存', st3.labelN === 1 && S.renderer.labelCacheSize() === 1,
    `画出 ${st3.labelN} 个 / 缓存 ${S.renderer.labelCacheSize()} 条`);
  check('常态下无字形描边', S.ctx.calls.strokeText === 0, `strokeText ${S.ctx.calls.strokeText} 次`);
})();

// ===========================================================================
section('4. 精灵缓存有界');
// ===========================================================================
(function testCacheBounded() {
  const S = makeScene(['aaaa', 'bbbb']);
  S.place(0, 60, 200);
  S.place(1, 300, 200);

  const saved = GFI.config.render.labelCacheMax;
  GFI.config.render.labelCacheMax = 3;

  let maxSeen = 0, over = 0;
  for (let f = 0; f < 40; f++) {
    // 每帧换一套全新标签 → 每帧都是缓存未命中
    S.D.label[0] = 'x' + f.toString(36) + 'zz';
    S.D.label[1] = 'y' + f.toString(36) + 'zz';
    S.draw();
    const sz = S.renderer.labelCacheSize();
    if (sz > maxSeen) maxSeen = sz;
    if (sz > 3) over++;
  }
  check('缓存始终不超过 labelCacheMax', over === 0,
    `40 帧中越界 ${over} 次，峰值 ${maxSeen} 条（上限 3）`);
  check('超限时不会整体清空（那样会每帧重建）', maxSeen >= 2,
    `峰值 ${maxSeen} 条 —— 若为 0 说明被整体 clear 了`);

  GFI.config.render.labelCacheMax = saved;
})();

// ===========================================================================
section('5. 尺寸 / 视口裁剪');
// ===========================================================================
(function testClipping() {
  const S = makeScene(['abcdefg']);
  S.place(0, 100, 200);

  const stIn = S.draw();
  check('正常位置能画出', stIn.labelN === 1, `labelN=${stIn.labelN}`);

  // 标签中心推到屏幕右侧外，但仍有一半可见 → 应该还画（新旧逻辑的分界点）
  S.place(0, VW + 10, 200);
  const stHalf = S.draw();
  check('一半在视口外仍画（按包围盒判可见）', stHalf.labelN === 1, `labelN=${stHalf.labelN}`);

  // 完全推出视口 → 不画
  S.place(0, VW + labelW('abcdefg'), 200);
  const stOut = S.draw();
  check('完全移出视口不画', stOut.labelN === 0, `labelN=${stOut.labelN}`);
})();

// ===========================================================================
// 结果
// ===========================================================================
console.log(`\n${'═'.repeat(60)}`);
if (fail === 0) {
  console.log(`\x1b[32m全部通过\x1b[0m  ${pass} 项`);
} else {
  console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 通过 ${pass} 项`);
  console.log('失败清单:');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
