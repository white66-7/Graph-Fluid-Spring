/*
 * 均匀度 / 拖拽保位探针 —— node test/uniformity-probe.js
 * ===========================================================================
 * 不是断言测试，是【测量】：把候选物理参数组在无头沙箱里各跑一遍，
 * 输出可比指标，供改 config.js 默认值前提供实测依据。
 *
 *   · 均匀度：每节点最近邻距离分布的 p10/p50/p90 与变异系数 CV（越小越均匀）
 *   · 重叠：沉降后穿透 >10% 的节点对（必须为 0）
 *   · 尺度：p50 边长 / linkDistance 比值、包围半径（只做横向对比，不套 1.2~1.6
 *     门槛 —— 那条判据只在基准线长 82 下成立，见 headless-sim.js §2 的注释）
 *   · 拖拽保位：复刻 interaction.js 的抓取→拖动→松手链路，量松手 500 tick 后
 *     节点离【放下点】的距离（Obsidian 行为 = 几乎不动）
 *
 * 只加载不碰 DOM 的模块，与 headless-sim.js 同一套 window shim。
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

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function measure(D) {
  const n = D.n;
  const vis = (i) => D.visible[i] && D.simWeight[i] > 0;

  // 最近邻距离（O(n²)，500 节点 ≈ 12.5 万对，Node 里瞬时）
  const nn = [];
  for (let i = 0; i < n; i++) {
    if (!vis(i)) continue;
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || !vis(j)) continue;
      const dx = D.x[i] - D.x[j], dy = D.y[i] - D.y[j];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    if (best < Infinity) nn.push(Math.sqrt(best));
  }
  nn.sort((a, b) => a - b);
  const mean = nn.reduce((s, v) => s + v, 0) / nn.length;
  const varr = nn.reduce((s, v) => s + (v - mean) * (v - mean), 0) / nn.length;

  // 穿透 >10% 的重叠对
  let overlap = 0;
  for (let i = 0; i < n; i++) {
    if (!vis(i)) continue;
    for (let j = i + 1; j < n; j++) {
      if (!vis(j)) continue;
      const dx = D.x[i] - D.x[j], dy = D.y[i] - D.y[j];
      const rr = D.radius[i] + D.radius[j];
      if (dx * dx + dy * dy < rr * rr * 0.81) overlap++;
    }
  }

  const st = GFI.Data.stats(D);
  return {
    nnP10: quantile(nn, 0.10), nnP50: quantile(nn, 0.50), nnP90: quantile(nn, 0.90),
    nnCV: Math.sqrt(varr) / mean,
    overlap,
    ratio: st.p50LinkLen / GFI.config.physics.linkDistance,
    radius: st.boundingRadius,
  };
}

// ---------------------------------------------------------------------------
// 布局实验：一组物理参数 → 沉降 → 指标
// ---------------------------------------------------------------------------
function runLayout(tag, phys) {
  Object.assign(GFI.config.physics, phys);
  const demo = GFI.DataSource.demo(500, { seed: 42, clusters: 8 });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  sim.lod = 0;                                   // L0：collideIter 2、逐 tick 斥力
  for (let k = 0; k < 900; k++) sim.tick(DT);
  const m = measure(D);
  console.log(
    tag.padEnd(46) +
    ` CV=${m.nnCV.toFixed(3)}  NN p10/p50/p90=${m.nnP10.toFixed(1)}/${m.nnP50.toFixed(1)}/${m.nnP90.toFixed(1)}` +
    `  重叠=${m.overlap}  边长比=${m.ratio.toFixed(2)}  半径=${m.radius.toFixed(0)}`
  );
  return m;
}

// §2 校准预测：headless-sim.js §2 把 linkDistance 覆盖成 82 后跑同一判据
// （比值 ∈ [1.2, 1.6]）。改默认值前必须先确认那一档仍能过。
function runLayoutCal(tag, phys) {
  const ld0 = GFI.config.physics.linkDistance;
  GFI.config.physics.linkDistance = 82;
  Object.assign(GFI.config.physics, phys);
  const demo = GFI.DataSource.demo(500, { seed: 42, clusters: 8 });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  sim.lod = 0;
  for (let k = 0; k < 900; k++) sim.tick(DT);
  const st = GFI.Data.stats(D);
  const ratio = st.p50LinkLen / 82;
  const ok = ratio >= 1.2 && ratio <= 1.6;
  console.log(tag.padEnd(46) + ` ld=82 比值=${ratio.toFixed(2)} ${ok ? '✔ 过§2' : '✘ 破§2'}`);
  GFI.config.physics.linkDistance = ld0;
  return ratio;
}

// ---------------------------------------------------------------------------
// 拖拽实验已【迁移到 test/drag-probe.js】
//
// 这里原来有一个 runDrag()，用来测「松手钉死」与「解析解沉降」两个方案的保位
// 效果 —— 那两个方案都已从产品里删除（实测都更差，见 config.js 的 drag 段），
// 继续留着只会误导。现在拖拽全链路（拖拽期间邻居跟随 / 松手停位）的测量
// 一律在 test/drag-probe.js，本文件只负责布局均匀度。
// ---------------------------------------------------------------------------

// ===========================================================================
console.log('── 布局均匀度（500 节点 seed=42 clusters=8，900 tick 沉降，LOD0，ld=50）──');
console.log('（CV = 最近邻距离变异系数，越小越均匀；NN=最近邻距离 p10/p50/p90）');
runLayout('A 现行: c.85 grav3 ch-.10 pad0', { collideStrength: 0.85, gravity: 3, charge: -0.10, collidePad: 0 });
runLayout('B     : c1.0 grav3 ch-.10 pad6', { collideStrength: 1.0, gravity: 3, charge: -0.10, collidePad: 6 });
runLayout('C     : c1.0 grav2 ch-.10 pad6', { collideStrength: 1.0, gravity: 2, charge: -0.10, collidePad: 6 });
runLayout('D     : c1.0 grav2 ch-.10 pad12', { collideStrength: 1.0, gravity: 2, charge: -0.10, collidePad: 12 });
runLayout('E     : c1.0 grav2 ch-.12 pad6', { collideStrength: 1.0, gravity: 2, charge: -0.12, collidePad: 6 });

console.log('\n── §2 校准预测（linkDistance 覆盖 82，判据 比值 ∈ [1.2,1.6]）──');
runLayoutCal('A 现行', { collideStrength: 0.85, gravity: 3, charge: -0.10, collidePad: 0 });
runLayoutCal('C 候选', { collideStrength: 1.0, gravity: 2, charge: -0.10, collidePad: 6 });
runLayoutCal('E 候选', { collideStrength: 1.0, gravity: 2, charge: -0.12, collidePad: 6 });

console.log('\n（拖拽链路另见 test/drag-probe.js —— 本文件只测布局均匀度）');
