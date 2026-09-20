/*
 * 复现「图谱爆炸式扩散」—— node test/repro-blowup.js
 * ===========================================================================
 * 症状：n=88 的用户图谱最终扩散到 ~6300 世界单位，相机里只看得到 1 个节点。
 *
 * 假设：开局种子螺旋半径只有 243，全部 88 个节点都落在彼此的 distanceMax(420) 内
 *       → 每个节点承受 ~87 × charge 的总斥力 → 初速度极大
 *       → 在 alpha 衰减到足以削弱力之前就飞出去几千单位 → 冻结在那个膨胀态
 *
 * 之前的标定只测【终点】，没测【路径】—— 所以没发现这个问题。
 * 这个脚本打印半径的时间演化。
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
sandbox.window = sandbox; sandbox.parent = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['ns', 'config', 'spatial', 'data', 'physics', 'effects', 'datasource']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, `src/${f}.js`), 'utf8'), sandbox, { filename: f });
}
const GFI = sandbox.GFI;
const DT = GFI.DT;
const LD = 82;

function resetPhysics(over) {
  const d = GFI.configDefaults.physics;
  const p = GFI.config.physics;
  for (const k in d) p[k] = Array.isArray(d[k]) ? d[k].slice() : d[k];
  if (over) Object.assign(p, over);
  return p;
}

/**
 * 模拟用户图谱的形状：88 节点 / 147 边，含少量高度数的 tag 枢纽。
 * @param {number} isoCount 末尾多少个节点做成【孤立节点】（零度）。
 *   真实 Logseq 图谱里大量页面只被标签连了一下、或者压根没被引用，
 *   这些节点不受连边力约束 —— 是关键变量。
 */
function userLikeGraph(n, m, hubCount, isoCount) {
  isoCount = isoCount || 0;
  const nodes = [], links = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: 'n' + i, label: 'n' + i,
      kind: i < hubCount ? 'tag' : 'page',
      createdAt: now - (n - i) * 86400000,
    });
  }
  const lastLinked = n - isoCount;           // [hubCount, lastLinked) 是参与连边的节点

  // 枢纽是 tag
  for (let h = 0; h < hubCount; h++) {
    for (let i = hubCount; i < lastLinked; i++) {
      if (links.length >= m) break;
      if ((i * 7 + h * 13) % 5 === 0) links.push({ source: 'n' + i, target: 'n' + h });
    }
  }
  // 剩下的随机长边（确定性伪随机）
  let k = 0;
  const span = Math.max(2, lastLinked - hubCount);
  while (links.length < m) {
    const a = hubCount + ((k * 17) % span);
    const b = hubCount + ((k * 31 + 7) % span);
    k++;
    if (a !== b) links.push({ source: 'n' + a, target: 'n' + b });
    if (k > 5000) break;
  }
  return { nodes, links };
}

function run(label, nodes, links, over, probes) {
  const p = resetPhysics(over);
  const D = GFI.Data.build(nodes, links, null);
  const sim = GFI.Physics.create(D, p);
  const marks = probes || [1, 15, 30, 60, 90, 120, 200, 400, 800];
  const row = [];
  const maxTick = Math.max(...marks);
  for (let t = 1; t <= maxTick; t++) {
    sim.tick(DT);
    if (marks.includes(t)) {
      // 用 p90 距离而不是包围盒 —— 包围盒被单个离群点主导，看不出整体
      let cx = 0, cy = 0;
      for (let i = 0; i < D.n; i++) { cx += D.x[i]; cy += D.y[i]; }
      cx /= D.n; cy /= D.n;
      const ds = [];
      for (let i = 0; i < D.n; i++) ds.push(Math.hypot(D.x[i] - cx, D.y[i] - cy));
      ds.sort((a, b) => a - b);
      const bb = GFI.Data.bounds(D, false);
      row.push({
        t,
        alpha: +sim.alpha.toFixed(4),
        p50r: Math.round(ds[Math.floor(ds.length * 0.5)]),
        p90r: Math.round(ds[Math.floor(ds.length * 0.9)]),
        w: Math.round(bb.maxX - bb.minX),
      });
    }
  }
  console.log(`\n\x1b[1m${label}\x1b[0m  charge=${p.charge} retain=${p.velocityRetain} linkDist=${p.linkDistance} grav=${p.gravity}`);
  console.log('     tick │  alpha │ p50半径 │ p90半径 │  总宽');
  for (const r of row) {
    console.log(`  ${String(r.t).padStart(7)} │ ${r.alpha.toFixed(4)} │ ${String(r.p50r).padStart(7)} │ ${String(r.p90r).padStart(7)} │ ${String(r.w).padStart(5)}`);
  }
  // 最终状态
  const st = GFI.Data.stats(D);
  console.log(`  → 终态 p50边长=${st.p50LinkLen.toFixed(0)} (${(st.p50LinkLen / LD).toFixed(2)}×)  包围半径=${st.boundingRadius}  孤立=${st.isolated}`);
  return { D, st, sim };
}

const PROBE = [1, 15, 30, 60, 90, 120, 200, 400, 800];

console.log('\n' + '═'.repeat(78));
console.log('\x1b[33m【A. 孤立节点是不是元凶】\x1b[0m 只改孤立节点数量，其余参数不变');
for (const iso of [0, 10, 25, 40]) {
  const G = userLikeGraph(88, 147, 9, iso);
  run(`孤立节点 ${iso} 个`, G.nodes, G.links, {}, PROBE);
}

console.log('\n' + '═'.repeat(78));
console.log('\x1b[33m【B. 加强重力】\x1b[0m 重力是唯一能把离群点拉回来的力（当前 0.3 太弱）');
{
  const G = userLikeGraph(88, 147, 9, 40);
  for (const g of [0.3, 3, 10, 30]) {
    run(`gravity=${g}`, G.nodes, G.links, { gravity: g }, PROBE);
  }
}

console.log('\n' + '═'.repeat(78));
console.log('\x1b[33m【C. 孤立节点不参与斥力】\x1b[0m 它们不在结构里，没必要互相排斥');
{
  const G = userLikeGraph(88, 147, 9, 40);
  for (const g of [0.3, 3]) {
    run(`gravity=${g} + skipIsolatedCharge`, G.nodes, G.links,
      { gravity: g, skipIsolatedCharge: true }, PROBE);
  }
}

console.log('\n' + '═'.repeat(78));
console.log('\x1b[33m【D. 降低斥力 + 适度重力】\x1b[0m 组合方案');
{
  const G = userLikeGraph(88, 147, 9, 40);
  for (const [c, g] of [[0.03, 3], [0.03, 10], [0.01, 3]]) {
    run(`charge=-${c} gravity=${g}`, G.nodes, G.links, { charge: -c, gravity: g }, PROBE);
  }
}
