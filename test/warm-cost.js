/*
 * 预热成本基准 —— node test/warm-cost.js
 * ===========================================================================
 * 只回答一个问题：**跑完整段沉降到底要多久？** 这个数字决定"首次进图谱要不要
 * 等预热"，进而决定第一段观感（加载指示亮多久）和第三段（要不要第二次适配视角）。
 *
 * 为什么必须实测而不是估：tick 的成本是 O(n)（斥力是网格近邻，但每 tick 还有
 * 三趟全表扫描：applyPins / integrate / forceCenter），而 LOD 档位会改变每 tick
 * 的实际工作量（L2/L3 隔 tick 跑斥力、跳过孤立节点斥力）。所以只能量。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const sandbox = {
  console, Math, Date, Number, Array, Object, JSON, Map, Set,
  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
  isNaN, parseInt, parseFloat, Infinity, NaN, setTimeout, clearTimeout,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  document: { documentElement: {}, createElement: () => ({ style: {}, getContext: () => null }) },
};
sandbox.window = sandbox;
sandbox.parent = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['ns', 'config', 'spatial', 'data', 'physics', 'effects', 'timeline', 'datasource']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, `src/${f}.js`), 'utf8'), sandbox, { filename: f });
}
const GFI = sandbox.GFI;
const DT = GFI.DT;

function settleCost(n, lod) {
  const demo = GFI.DataSource.demo(n, { seed: 7 });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  sim.lod = lod;

  // 先跑 30 tick 热身（JIT），不计时
  for (let i = 0; i < 30; i++) sim.tick(DT);

  const t0 = process.hrtime.bigint();
  let ticks = 0;
  const cap = 4000;
  while (sim.isAwake() && ticks < cap) { sim.tick(DT); ticks++; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  let deg = 0;
  for (let i = 0; i < D.n; i++) if (D.deg[i] === 0) deg++;
  return { n, m: D.m, isolated: deg, ticks, ms, perTick: ms / Math.max(1, ticks), asleep: !sim.isAwake() };
}

console.log('\n\x1b[36m━━━ 预热成本基准（settleTicks=400）━━━\x1b[0m');
console.log('  节点     边   孤立   tick数    总耗时     每tick    推到 sleepTicks(1000) 的估计');
console.log('  ' + '─'.repeat(78));

const sizes = [81, 200, 500, 1000, 2000, 5000];
const rows = [];
for (const n of sizes) {
  for (const lod of [1]) {                    // LOD 1 = main.js 的初值，也是默认档
    const r = settleCost(n, lod);
    // 预热器的上限是 settleTicks × 2.5 = 1000 tick（哪怕提前睡着，也只跑到这里）
    const budget1000 = r.perTick * 1000;
    console.log(
      `  ${String(r.n).padStart(4)}  ${String(r.m).padStart(5)}  ${String(r.isolated).padStart(4)}  ` +
      `${String(r.ticks).padStart(6)}  ${r.ms.toFixed(0).padStart(7)}ms  ${r.perTick.toFixed(3).padStart(7)}ms  ` +
      `${budget1000.toFixed(0).padStart(6)}ms`
    );
    rows.push({ n, ...r, budget1000 });
  }
}

console.log('\n\x1b[36m━━━ 结论用得到的两条线 ━━━\x1b[0m');
const worst = rows[rows.length - 1];
const mid = rows.find((r) => r.n === 500) || rows[0];
console.log(`  · 500 节点：整段沉降约 ${mid.ms.toFixed(0)}ms → 分帧预热约 ${Math.ceil(mid.ms / 14)} 帧（≈${(Math.ceil(mid.ms / 14) / 60).toFixed(1)} 秒）`);
console.log(`  · 2000 节点：整段沉降约 ${(rows.find((r) => r.n === 2000) || worst).ms.toFixed(0)}ms → 分帧约 ${Math.ceil((rows.find((r) => r.n === 2000) || worst).ms / 14)} 帧`);
console.log(`  · 5000 节点：分帧会跑满上限（${worst.budget1000.toFixed(0)}ms），首次进图谱等不起`);
