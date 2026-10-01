/*
 * GFI — 拖拽链路测量探针（非断言，纯测量）
 * ===========================================================================
 * 调用的都是【真实落地】的 API：sim.setDragLinkBoost() / cfg.drag.releaseAlpha，
 * 与 interaction.js 的调用序列逐行对应。所以这里的数字就是产品行为。
 *
 * 对照两组：
 *   legacy —— 改动前：不增益 + 松手保持拖拽期的 alpha(0.3) 自然衰减（= d3 惯例）
 *   shipped —— 改动后：拖动期间局部弹簧增益 + 松手把 alpha 压到 releaseAlpha
 *
 * 指标：
 *   撕裂     松手瞬间，被拖节点到最近邻居的距离（基线 26.4wu、平衡边长 50wu）
 *   峰值     松手后偏离放下点的【最大值】—— 直接对应观感上的"被甩出去"
 *   末位     松手 500 tick 后离放下点
 *   末尾邻距 500 tick 后到最近邻居距离（回到 ≈26 说明图重新连成一体）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const sandbox = {
  console, Math, Date, Number, Array, Object, JSON, Map, Set,
  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
  isNaN, parseInt, parseFloat, Infinity, NaN,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  document: { documentElement: {}, createElement: () => ({ style: {}, getContext: () => null }) },
  setTimeout, clearTimeout,
};
sandbox.window = sandbox;
sandbox.parent = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
for (const f of ['ns', 'config', 'spatial', 'data', 'physics', 'effects', 'timeline', 'datasource']) {
  load(`src/${f}.js`);
}

const GFI = sandbox.GFI;
const DT = 1 / 60;
const MARKS = [10, 20, 40, 80, 160, 320, 500];

function nearestGap(D, i) {
  let best = Infinity;
  for (let j = 0; j < D.n; j++) {
    if (j === i || !D.visible[j]) continue;
    const d = Math.hypot(D.x[j] - D.x[i], D.y[j] - D.y[i]);
    if (d < best) best = d;
  }
  return best;
}

function pickNode(D) {
  for (let k = 0; k < D.n; k++) if (D.deg[k] >= 2 && D.deg[k] <= 6) return k;
  return 0;
}

/**
 * @param shipped true = 走新链路；false = 走改动前的链路
 */
function runDrag(tag, shipped, dx, dy, ticks, hold) {
  const demo = GFI.DataSource.demo(300, { seed: 7, clusters: 5 });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  sim.lod = 0;
  for (let k = 0; k < 600; k++) sim.tick(DT);

  const i = pickNode(D);
  const homeX = D.x[i], homeY = D.y[i];
  const dropX = homeX + dx, dropY = homeY + dy;

  // ---- pointerdown：硬 pin + 抬 alphaTarget（+ 新链路：挂上局部弹簧增益）----
  sim.pin(i, homeX, homeY);
  if (D.deg[i] > 0) sim.setAlphaTarget(GFI.config.reheat.dragStart);
  if (shipped && D.deg[i] > 0) sim.setDragLinkBoost(i, GFI.config.drag.linkBoost);

  // ---- pointermove：首次越过 minDragDist 时 reheat，之后每步 pin + tick ----
  let reheated = false;
  for (let k = 1; k <= ticks; k++) {
    sim.pin(i, homeX + dx * k / ticks, homeY + dy * k / ticks);
    if (!reheated && D.deg[i] > 0) { sim.reheat(GFI.config.reheat.dragStart); reheated = true; }
    sim.tick(DT);
  }
  for (let k = 0; k < hold; k++) { sim.pin(i, dropX, dropY); sim.tick(DT); }

  const gapRelease = nearestGap(D, i);

  // ---- pointerup ----
  sim.setAlphaTarget(0);
  sim.setDragLinkBoost(-1, 1);
  sim.unpin(i);
  D.vx[i] = 0; D.vy[i] = 0;
  if (D.deg[i] > 0) {
    if (shipped) {
      if (sim.alpha > GFI.config.drag.releaseAlpha) sim.alpha = GFI.config.drag.releaseAlpha;
    } else {
      sim.reheat(GFI.config.reheat.dragRelease);   // 旧行为：让 alpha 从拖拽期水平衰减
    }
  }

  const back = {};
  let peak = 0;
  for (let k = 1; k <= MARKS[MARKS.length - 1]; k++) {
    sim.tick(DT);
    const b = Math.hypot(D.x[i] - dropX, D.y[i] - dropY);
    if (b > peak) peak = b;
    for (let q = 0; q < MARKS.length; q++) if (MARKS[q] === k) back[k] = b;
  }
  const gapEnd = nearestGap(D, i);

  console.log(
    tag.padEnd(30) +
    ` 撕裂=${gapRelease.toFixed(0).padStart(4)}` +
    ` 峰值=${peak.toFixed(0).padStart(4)}` +
    ` 末位=${back[500].toFixed(0).padStart(4)}` +
    ` 末尾邻距=${gapEnd.toFixed(0).padStart(3)}` +
    `   轨迹@${MARKS.join('/')}=` + MARKS.map((m) => String(Math.round(back[m])).padStart(4)).join(' ')
  );
}

// ===========================================================================
console.log('── 拖拽：改动前(legacy) vs 改动后(shipped) ｜ 300 节点 seed=7，LOD0 ──');
console.log(`基线：最近邻 26.4wu ｜ 平衡边长 ${GFI.config.physics.linkDistance}wu`);
console.log(`新参数：linkBoost=${GFI.config.drag.linkBoost}  releaseAlpha=${GFI.config.drag.releaseAlpha}`);
console.log('「撕裂」= 松手瞬间到最近邻居的距离（越小说明拖拽期间邻居跟得越紧）');
console.log('「峰值」= 松手后偏离放下点的最大值 = 观感上的"被甩出去"\n');
console.log('                                  撕裂   峰值   末位  末尾邻距   轨迹@' + MARKS.join('/'));
console.log('');

for (const [label, dx, dy, ticks, hold] of [
  ['大拖 234wu（45 tick）', 200, 120, 45, 0],
  ['小拖 50wu（45 tick）', 40, 30, 45, 0],
  ['大拖 + 悬停 90 tick', 200, 120, 45, 90],
  ['极慢拖（300 tick）', 200, 120, 300, 0],
  ['中拖 117wu（45 tick）', 100, 60, 45, 0],
]) {
  console.log(`【${label}】`);
  runDrag('  legacy', false, dx, dy, ticks, hold);
  runDrag('  shipped', true, dx, dy, ticks, hold);
  console.log('');
}
