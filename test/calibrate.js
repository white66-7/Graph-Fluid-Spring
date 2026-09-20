/*
 * 参数标定 —— node test/calibrate.js
 * ===========================================================================
 * 找出「让 p50 边长 = 1.4 × linkDistance」的 charge，并对每个 velocityRetain
 * 都测一遍 —— 因为收敛性（进而标定值是否有意义）完全取决于阻尼。
 *
 * 判据不只是"比值对不对"，还有【跨 seed 的方差】：
 * 若同一个 charge 在不同随机种子下给出差异巨大的结果，说明布局还在振荡、
 * 只是被 alpha 耗尽冻住了，那个"标定值"是假的。
 *
 * 用法：
 *   node test/calibrate.js
 *   node test/calibrate.js --n 400 --ticks 600 --seedn 2
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

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}
const N = argOf('--n', 400);
const TICKS = argOf('--ticks', 600);
const TARGET = 1.4;
const LD = GFI.configDefaults.physics.linkDistance;

// 每个组合都必须从 defaults 完全重置，否则上一轮的修改会累积，结果全部失真
function resetPhysics(charge, falloff, retain) {
  const d = GFI.configDefaults.physics;
  const p = GFI.config.physics;
  for (const k in d) p[k] = Array.isArray(d[k]) ? d[k].slice() : d[k];
  p.charge = -Math.abs(charge);
  p.chargeFalloff = falloff;
  p.velocityRetain = retain;
  return p;
}

function measure(charge, falloff, retain, n, seed, ticks) {
  const p = resetPhysics(charge, falloff, retain);
  const demo = GFI.DataSource.demo(n, { seed, clusters: Math.max(3, Math.round(Math.sqrt(n) / 2)) });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, p);
  const t0 = Date.now();
  for (let k = 0; k < ticks; k++) sim.tick(DT);
  const ms = (Date.now() - t0) / ticks;
  let nan = 0;
  for (let i = 0; i < D.n; i++) if (!Number.isFinite(D.x[i])) nan++;
  const st = GFI.Data.stats(D);
  return {
    ratio: st.p50LinkLen / LD, p50: st.p50LinkLen, radius: st.boundingRadius,
    nan, ms, alpha: sim.alpha,
  };
}

/** 多 seed：返回均值与极差（极差是"布局是否还在振荡"的直接指标） */
function sampleAt(charge, falloff, retain, n, ticks, seeds) {
  const rs = [], radii = [];
  let nan = 0;
  for (const s of seeds) {
    const r = measure(charge, falloff, retain, n, s, ticks);
    rs.push(r.ratio); radii.push(r.radius); nan += r.nan;
  }
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const spread = Math.max(...rs) - Math.min(...rs);
  const radMean = radii.reduce((a, b) => a + b, 0) / radii.length;
  return { mean, spread, radius: radMean, nan };
}

function bisect(falloff, retain, n, ticks, seeds) {
  let lo = 0.5, hi = 20000;
  let last = null;
  for (let i = 0; i < 15; i++) {
    const mid = Math.sqrt(lo * hi);
    const s = sampleAt(mid, falloff, retain, n, ticks, seeds);
    last = { charge: mid, ...s };
    if (s.nan) { hi = mid; continue; }
    if (s.mean > TARGET) hi = mid; else lo = mid;
    if (Math.abs(s.mean - TARGET) < 0.05) break;
  }
  return last;
}

console.log(`\n\x1b[36m标定\x1b[0m  n=${N}  ticks=${TICKS}  linkDistance=${LD}  目标 p50/ld = ${TARGET}`);
console.log('\x1b[90m极差 = 不同随机种子下比值的最大差异；> 0.5 说明布局还在振荡，标定值不可信\x1b[0m\n');

const SEEDS = [1, 7, 42].slice(0, argOf('--seedn', 3));

console.log('  retain │ falloff │   charge   │ 比值 │ 极差 │ 包围半径 │ ms/tick │ 判定');
console.log('  ───────┼─────────┼────────────┼──────┼──────┼──────────┼─────────┼──────');

const results = [];
for (const retain of [0.60, 0.70, 0.80, 0.85, 0.94]) {
  for (const falloff of [0, 1]) {
    const r = bisect(falloff, retain, N, TICKS, SEEDS);
    const m = measure(r.charge, falloff, retain, N, 1, TICKS);
    const stable = r.spread < 0.5;
    const onTarget = Math.abs(r.mean - TARGET) < 0.15;
    const verdict = !stable ? '\x1b[31m✘ 振荡\x1b[0m' : (onTarget ? '\x1b[32m✔ 达标\x1b[0m' : '\x1b[33m~ 勉强\x1b[0m');
    console.log(
      `  ${retain.toFixed(2).padStart(6)} │ ${String(falloff).padStart(7)} │ ` +
      `${r.charge.toFixed(2).padStart(10)} │ ${r.mean.toFixed(2).padStart(4)} │ ` +
      `${r.spread.toFixed(2).padStart(4)} │ ${String(Math.round(r.radius)).padStart(8)} │ ` +
      `${m.ms.toFixed(2).padStart(7)} │ ${verdict}`
    );
    results.push({ retain, falloff, charge: r.charge, ratio: r.mean, spread: r.spread, ms: m.ms });
  }
  console.log('');
}

// ---- 结论 ----
const good = results.filter((r) => r.spread < 0.5 && Math.abs(r.ratio - TARGET) < 0.15);
console.log('═'.repeat(72));
if (good.length) {
  good.sort((a, b) => a.spread - b.spread);
  const best = good[0];
  console.log(`\x1b[32m推荐\x1b[0m  velocityRetain = \x1b[1m${best.retain}\x1b[0m  ` +
    `chargeFalloff = \x1b[1m${best.falloff}\x1b[0m  charge = \x1b[1m${-best.charge.toFixed(2)}\x1b[0m`);
  console.log(`      比值 ${best.ratio.toFixed(2)}  极差 ${best.spread.toFixed(2)}  ${best.ms.toFixed(2)} ms/tick`);
  console.log(`\n把这三项填进 src/config.js 的 physics。`);
} else {
  console.log('\x1b[31m没有稳定的组合 —— 需要继续调 damping / alpha 衰减 / 力常数\x1b[0m');
}
console.log('');
