/*
 * GFI — 标签遮挡节点测量探针（非断言，纯测量）
 * ===========================================================================
 * 要回答的问题：用户反馈「要显示的节点不能完全显示，是不是因为节点空间不够」。
 *
 * 先看清楚绘制顺序（renderer.render）：
 *     drawEdges → drawGlow → drawCores → 【drawLabels】 → drawOverlay
 * 标签画在【所有节点之上】。而占位网格（occGrid）只防「标签压标签」——
 * 它只记录标签自己的包围盒，**完全不记录节点的位置**。
 * 所以一个胜出的标签可以整块盖在别的节点上，把那个节点遮掉。
 *
 * 指标：
 *   视口内节点数     应该被看到的节点
 *   画出标签数       真正画出的标签
 *   被盖住的节点     节点圆心落进某个【已画出标签】包围盒的个数（= 被遮没）
 *   被盖住比例       上者 / 视口内节点数
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DPR = 2;
// 贴近真实：Logseq 图谱面板大致就这么大（原来用 500×500 会把密度放大 4 倍）
const VW = 1200, VH = 800;

const madeCanvases = [];
function makeStubCtx(canvas) {
  const calls = { drawImage: 0, fillText: 0, measureText: 0, dsts: [], srcs: [] };
  return {
    calls, canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '12px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    lineJoin: 'miter', lineCap: 'butt', miterLimit: 10,
    setTransform() {}, save() {}, restore() {},
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
    rect() {}, closePath() {}, fill() {}, stroke() {}, fillRect() {},
    createRadialGradient() { return { addColorStop() {} }; },
    // 字宽必须【随字号变】—— 写死 7px/字符 的话，改 labelFont 只有行高会变，
    // 而宽度（标签面积的主要维度）纹丝不动，字号扫描会得出"没用"的错误结论。
    // 0.583 = 7/12，与 renderer-labels.js 的桩在 12px 时对齐。
    measureText(t) {
      calls.measureText++;
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
      const px = m ? parseFloat(m[1]) : 12;
      return { width: String(t).length * px * 0.583 };
    },
    fillText() { calls.fillText++; }, strokeText() {},
    drawImage(src, dx, dy, dw, dh) {
      calls.drawImage++; calls.srcs.push(src);
      calls.dsts.push({ dx, dy, dw, dh });
    },
  };
}
function makeStubCanvas() {
  const c = {
    width: 0, height: 0, style: {}, isConnected: true,
    getContext() { return (c._ctx = c._ctx || makeStubCtx(c)); },
  };
  madeCanvases.push(c);
  return c;
}

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
for (const f of ['ns', 'config', 'spatial', 'data', 'physics', 'effects', 'timeline', 'datasource', 'camera', 'renderer']) {
  load(`src/${f}.js`);
}

const GFI = sandbox.GFI;
const DT = 1 / 60;

// 关掉辉光 —— 它也用 drawImage，否则没法用 drawImage 计数反推标签数
GFI.config.lod.levels[0].glow = 'hover';

// fitView 会用的缩放（与 camera.fitBounds 同一公式），用来把 k 表达成"fitK 的几倍"
function fitKOf(D) {
  const b = GFI.Data.bounds(D, true);
  const pad = GFI.config.camera.fitPadding;
  const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
  const kx = (VW - 2 * pad) / w, ky = (VH - 2 * pad) / h;
  return Math.min(kx, ky);
}

function run(tag, n, k, seed, yieldOn) {
  if (yieldOn !== undefined) GFI.config.render.labelYield = yieldOn;
  const demo = GFI.DataSource.demo(n, { seed: seed || 7, clusters: 8 });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  sim.lod = 0;
  for (let t = 0; t < 700; t++) sim.tick(DT);

  // 质心对中
  let cx = 0, cy = 0, c = 0;
  for (let i = 0; i < D.n; i++) if (D.visible[i]) { cx += D.x[i]; cy += D.y[i]; c++; }
  cx /= Math.max(1, c); cy /= Math.max(1, c);

  const cam = GFI.Camera.create(VW, VH);
  cam.k = k; cam.x = cx; cam.y = cy;

  const canvas = makeStubCanvas();
  const renderer = GFI.Renderer.create(canvas, D, cam);
  renderer.resize(VW, VH, DPR);
  renderer.setGrid(sim.grid);

  const ctx = canvas.getContext('2d');
  ctx.calls.dsts.length = 0; ctx.calls.drawImage = 0;
  renderer.render({ hoverIdx: -1, selectedIdx: -1, lod: 0, labelsOn: true, labelFade: 1 });

  const dsts = ctx.calls.dsts;

  // 视口内的可见节点（圆心落在视口里才算"应该被看到"）
  const nodes = [];
  for (let i = 0; i < D.n; i++) {
    if (!D.visible[i]) continue;
    const sx = cam.worldToScreenX(D.x[i]);
    const sy = cam.worldToScreenY(D.y[i]);
    if (sx < 0 || sx > VW || sy < 0 || sy > VH) continue;
    nodes.push({ i, sx, sy, r: Math.max(2, D.radius[i] * D.scaleMul[i] * k) });
  }

  // 圆心被某个标签包围盒盖住 = 这个节点被遮没
  let covered = 0, coveredCore = 0;
  for (const nd of nodes) {
    for (const d of dsts) {
      if (nd.sx >= d.dx && nd.sx <= d.dx + d.dw && nd.sy >= d.dy && nd.sy <= d.dy + d.dh) {
        covered++;
        // 连整颗节点（圆心 + 半径）都被盖住 → 完全看不见
        if (nd.sx - nd.r >= d.dx && nd.sx + nd.r <= d.dx + d.dw &&
            nd.sy - nd.r >= d.dy && nd.sy + nd.r <= d.dy + d.dh) coveredCore++;
        break;
      }
    }
  }

  // 标签被【画布边缘】裁掉 —— 另一种"显示不全"
  let clippedLabels = 0;
  for (const d of dsts) {
    if (d.dx < 0 || d.dy < 0 || d.dx + d.dw > VW || d.dy + d.dh > VH) clippedLabels++;
  }

  // 节点圆盘被画布边缘裁掉（圆心在视口内、但圆超出边界）
  let clippedNodes = 0;
  for (const nd of nodes) {
    if (nd.sx - nd.r < 0 || nd.sy - nd.r < 0 || nd.sx + nd.r > VW || nd.sy + nd.r > VH) clippedNodes++;
  }

  // 标签 → 所属节点的【精确反查】。
  // ⚠ 不能用"节点圆心落在标签框里"来反推归属：标签画在节点【下方】，落进框里的
  //   通常是【它下面那个节点】，会得出完全颠倒的结论（我踩过）。
  //   改成按 drawOne 的公式正算出每个节点"应该"落在哪，再与真正画出的对账。
  const PAD = Math.ceil(GFI.config.render.labelHaloWidth) + 2;
  const FONT_PX = parseFloat(/(\d+(?:\.\d+)?)px/.exec(GFI.config.render.labelFont)[1]);
  const BOX_H = Math.ceil(FONT_PX * 1.3) + PAD * 2;
  const labeled = new Set();
  for (const nd of nodes) {
    const txt = D.label[nd.i];
    if (!txt) continue;
    const w = Math.ceil(txt.length * FONT_PX * 0.583) + PAD * 2;   // 与桩的 measureText 一致
    const expDx = nd.sx - w * 0.5;
    const expDy = nd.sy + nd.r + 3 + (BOX_H * 0.5 - PAD) - BOX_H * 0.5;
    for (const d of dsts) {
      if (Math.abs(d.dx - expDx) <= 0.6 && Math.abs(d.dy - expDy) <= 0.6 &&
          Math.abs(d.dw - w) <= 0.6) { labeled.add(nd.i); break; }
    }
  }
  let degWith = 0, nWith = 0, degWithout = 0, nWithout = 0;
  for (const nd of nodes) {
    if (labeled.has(nd.i)) { degWith += D.deg[nd.i]; nWith++; }
    else { degWithout += D.deg[nd.i]; nWithout++; }
  }
  const avgWith = nWith ? degWith / nWith : 0;
  const avgWithout = nWithout ? degWithout / nWithout : 0;

  console.log(
    tag.padEnd(26) +
    ` 视口内=${String(nodes.length).padStart(4)}` +
    ` 画出标签=${String(dsts.length).padStart(4)}` +
    ` 圆心被盖=${String(covered).padStart(4)}` +
    ` 整颗被盖=${String(coveredCore).padStart(3)}` +
    `  标签节点均度=${avgWith.toFixed(1).padStart(5)} 未标节点均度=${avgWithout.toFixed(1).padStart(5)}`
  );
  void clippedLabels; void clippedNodes;
  return { nodes: nodes.length, labels: dsts.length, covered, coveredCore, avgWith, avgWithout };
}

// ===========================================================================
console.log('── 标签遮挡节点 ｜ 视口 ' + VW + '×' + VH + '，LOD0，标签全开 ──');
console.log('「圆心被盖」= 节点圆心落进某个已画出标签的包围盒 → 该节点被标签遮住');
console.log('「整颗被盖」= 连圆心 ± 半径都被盖住 → 这个节点实际上看不见了\n');
console.log('                              视口内节点  画出标签  圆心被盖      整颗被盖');
console.log('');

console.log('【300 节点 seed=7】');
for (const k of [0.35, 0.6, 1.0, 1.8]) {
  run(`  k=${k}（视距 ${k < 0.5 ? '远' : k < 1.2 ? '中' : '近'}）`, 300, k);
}
console.log('\n【不同规模 k=0.6】');
for (const n of [120, 500, 1000]) {
  run(`  n=${n}`, n, 0.6);
}

// ---------------------------------------------------------------------------
// 占位网格粒度 —— 判断"名字显示不出来"到底有多少是被它压掉的
// ---------------------------------------------------------------------------
// labelCell 越小 = 让位判定越精细 = 越少标签被压掉。把它调到 1（每个像素一格）
// 就等价于"只压制真正重叠的标签"，得到一帧能画出的【上限】。
console.log('\n【占位格粒度扫描：同一场景，只改 render.labelCell】');
console.log('（labelCell 越小，让位判定越精细；=1 时约等于"只压真正重叠的"）');
(function sweepCell() {
  const orig = GFI.config.render.labelCell;
  for (const cell of [orig, 8, 4, 2, 1]) {
    GFI.config.render.labelCell = cell;
    run(`  labelCell=${String(cell).padStart(2)}  n=300 k=0.6`, 300, 0.6);
  }
  GFI.config.render.labelCell = orig;
})();

// ---------------------------------------------------------------------------
// 策略对照 + 缩放门槛标定
// ---------------------------------------------------------------------------
// 关掉重叠让位（labelYield=false，Obsidian 行为）之后，密度完全由【缩放淡变】控制：
// main.js 在 k ∈ [hideK, showK] 之间做线性淡变，showK = fitK × labelShowScaleRatio。
// 所以这里按 fitK 的倍数扫一遍，看「放大到几倍时，视口内的标签数落到可读区间」。
console.log('\n【策略对照：同一场景，只改 render.labelYield】');
for (const k of [0.6, 1.0]) {
  run(`  让位  k=${k}`, 300, k, 7, true);
  run(`  不让位 k=${k}`, 300, k, 7, false);
}

console.log('\n【缩放门槛标定：300 节点，k = fitK × 倍率（不让位）】');
console.log('（fitK = 整张图刚好装满视口的缩放；倍率越大 = 放得越大）');
(function sweepZoom() {
  // 先拿一次 fitK（图不变，fitK 与 k 无关）
  const d0 = GFI.DataSource.demo(300, { seed: 7, clusters: 8 });
  const D0 = GFI.Data.build(d0.nodes, d0.links, null);
  const s0 = GFI.Physics.create(D0, GFI.config.physics);
  s0.lod = 0;
  for (let t = 0; t < 700; t++) s0.tick(DT);
  const fk = fitKOf(D0);

  for (const ratio of [1, 1.5, 2, 3, 4, 6]) {
    run(`  ${String(ratio).padStart(3)}× fitK`, 300, fk * ratio, 7, false);
  }
})();

// ---------------------------------------------------------------------------
// 字号扫描 —— 关掉让位后，字号不再是"能不能放下"，而是"糊不糊"的旋钮
// ---------------------------------------------------------------------------
// 标签面积 ∝ 字号²（宽是字符数×字宽，高是行高）。缩小字号是直接降低单张标签
// 的占位面积，而不是在排版上抠边角料。代价是字变小、可读性下降。
console.log('\n【字号扫描：同一场景，只改 render.labelFont 的 px】');
(function sweepFont() {
  const orig = GFI.config.render.labelFont;
  for (const px of [12, 11, 10, 9]) {
    GFI.config.render.labelFont = px + 'px ui-sans-serif, sans-serif';
    run(`  ${px}px  n=300 k=0.6`, 300, 0.6);
  }
  GFI.config.render.labelFont = orig;
})();
