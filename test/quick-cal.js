/*
 * 快速标定 —— node test/quick-cal.js [n] [ticks]
 * 小规模 + 单 seed 二分，几十秒出结果。用于确定参数区间，
 * 精确值再用 test/calibrate.js 复核。
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

const N = Number(process.argv[2] || 200);
const TICKS = Number(process.argv[3] || 300);
const LD = GFI.configDefaults.physics.linkDistance;
const TARGET = 1.4;

function resetPhysics(charge, falloff, retain, linkStrength) {
  const d = GFI.configDefaults.physics;
  const p = GFI.config.physics;
  for (const k in d) p[k] = Array.isArray(d[k]) ? d[k].slice() : d[k];
  p.charge = -Math.abs(charge);
  p.chargeFalloff = falloff;
  p.velocityRetain = retain;
  if (linkStrength !== undefined) p.linkStrength = linkStrength;
  return p;
}

function measure(charge, falloff, retain, linkStrength, seed) {
  const p = resetPhysics(charge, falloff, retain, linkStrength);
  const demo = GFI.DataSource.demo(N, { seed, clusters: Math.max(3, Math.round(Math.sqrt(N) / 2)) });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, p);
  const t0 = Date.now();
  for (let k = 0; k < TICKS; k++) sim.tick(DT);
  const ms = (Date.now() - t0) / TICKS;
  let nan = 0;
  for (let i = 0; i < D.n; i++) if (!Number.isFinite(D.x[i])) nan++;
  const st = GFI.Data.stats(D);
  return { ratio: st.p50LinkLen / LD, radius: st.boundingRadius, ms, nan, p50: st.p50LinkLen };
}

function bisect(falloff, retain, linkStrength) {
  let lo = 0.05, hi = 6000, last = null;
  for (let i = 0; i < 13; i++) {
    const mid = Math.sqrt(lo * hi);
    const r = measure(mid, falloff, retain, linkStrength, 1);
    const r2 = measure(mid, falloff, retain, linkStrength, 7);
    const mean = (r.ratio + r2.ratio) / 2;
    last = { charge: mid, ratio: mean, spread: Math.abs(r.ratio - r2.ratio), radius: r.radius, ms: r.ms, nan: r.nan + r2.nan };
    if (last.nan) { hi = mid; continue; }
    if (mean > TARGET) hi = mid; else lo = mid;
    if (Math.abs(mean - TARGET) < 0.06) break;
  }
  return last;
}

console.log(`\n\x1b[36m快速标定\x1b[0m n=${N} ticks=${TICKS} linkDistance=${LD} 目标=${TARGET}`);
console.log('\n  retain │ falloff │ linkStr │  charge  │ 比值 │ 极差 │ 半径 │ ms/tick');
console.log('  ───────┼─────────┼─────────┼──────────┼──────┼──────┼──────┼────────');

const out = [];
for (const retain of [0.60, 0.70, 0.80]) {
  for (const falloff of [0, 1]) {
    for (const ls of [0.3]) {
      const r = bisect(falloff, retain, ls);
      const ok = r.spread < 0.35 && Math.abs(r.ratio - TARGET) < 0.2;
      console.log(
        `  ${retain.toFixed(2).padStart(6)} │ ${String(falloff).padStart(7)} │ ${String(ls).padStart(7)} │ ` +
        `${r.charge.toFixed(2).padStart(8)} │ ${r.ratio.toFixed(2).padStart(4)} │ ${r.spread.toFixed(2).padStart(4)} │ ` +
        `${String(Math.round(r.radius)).padStart(4)} │ ${r.ms.toFixed(2).padStart(6)} ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[33m~\x1b[0m'}`
      );
      out.push({ retain, falloff, ls, ...r, ok });
    }
  }
}

const good = out.filter((r) => r.ok).sort((a, b) => a.spread - b.spread);
console.log('\n' + '═'.repeat(70));
if (good.length) {
  const b = good[0];
  console.log(`\x1b[32m推荐\x1b[0m retain=${b.retain} falloff=${b.falloff} linkStrength=${b.ls} charge=\x1b[1m${(-b.charge).toFixed(1)}\x1b[0m`);
} else {
  console.log('\x1b[31m无稳定解\x1b[0m');
}
console.log('');
