/*
 * 聚焦诊断：零斥力时图应该塌缩到 linkDistance。
 * 如果不塌缩，问题在连边力 / 重力 / 积分器，而不是斥力。
 *   node test/debug-link.js
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
const DT = 1 / 60;
const LD = 55;

function setup(charge, extra) {
  const p = GFI.config.physics;
  p.charge = -Math.abs(charge);
  p.chargeFalloff = 1;
  p.linkDistance = LD;
  if (extra) Object.assign(p, extra);
  return p;
}

function dist(D, a, b) {
  const i = D.indexById.get(a), j = D.indexById.get(b);
  return Math.hypot(D.x[i] - D.x[j], D.y[i] - D.y[j]);
}

function run(label, nodes, links, ticks, charge, extra) {
  const p = setup(charge, extra);
  const D = GFI.Data.build(nodes, links, null);
  // 从随机散开的位置出发，这样才能看出"是否塌缩"
  for (let i = 0; i < D.n; i++) {
    D.x[i] = (GFI.util.hash11(i * 2) - 0.5) * 2000;
    D.y[i] = (GFI.util.hash11(i * 2 + 1) - 0.5) * 2000;
  }
  const sim = GFI.Physics.create(D, p);
  for (let k = 0; k < ticks; k++) sim.tick(DT);
  const st = GFI.Data.stats(D);
  console.log(
    `${label.padEnd(34)} alpha=${sim.alpha.toExponential(1)}  ` +
    `p50=${st.p50LinkLen.toFixed(1).padStart(7)} (${(st.p50LinkLen / LD).toFixed(2)}×)  ` +
    `半径=${String(st.boundingRadius).padStart(5)}`
  );
  return { D, st, sim };
}

console.log(`\nlinkDistance = ${LD}，从半径 1000 的随机散布出发\n`);
console.log('── 2 节点 / 1 边 ──');
{
  const N = [{ id: 'a', label: 'a', kind: 'page' }, { id: 'b', label: 'b', kind: 'page' }];
  const L = [{ source: 'a', target: 'b' }];
  for (const charge of [0, 0.5, 2]) {
    const p = setup(charge);
    const D = GFI.Data.build(N, L, null);
    D.x[0] = -500; D.y[0] = 0;
    D.x[1] = 500; D.y[1] = 0;
    const sim = GFI.Physics.create(D, p);
    for (let k = 0; k < 900; k++) sim.tick(DT);
    const d = Math.hypot(D.x[0] - D.x[1], D.y[0] - D.y[1]);
    console.log(`  charge=${String(charge).padEnd(4)} → 距离 ${d.toFixed(1)}  (${(d / LD).toFixed(2)}× linkDistance)`);
  }
}

console.log('\n── 10 节点链 ──');
{
  const N = [], L = [];
  for (let i = 0; i < 10; i++) N.push({ id: 'n' + i, label: 'n' + i, kind: 'page' });
  for (let i = 0; i < 9; i++) L.push({ source: 'n' + i, target: 'n' + (i + 1) });
  for (const charge of [0, 0.5, 2]) run(`  10 节点链 charge=${charge}`, N, L, 900, charge);
}

console.log('\n── 500 节点 demo ──');
{
  const demo = GFI.DataSource.demo(500, { seed: 42, clusters: 8 });
  for (const charge of [0, 0.5, 2, 8]) run(`  demo500 charge=${charge}`, demo.nodes, demo.links, 900, charge);
}

console.log('\n── 重力 / 阻尼 单独排查（500 节点 demo, charge=0）──');
{
  const demo = GFI.DataSource.demo(500, { seed: 42, clusters: 8 });
  run('  基准 charge=0', demo.nodes, demo.links, 900, 0);
  run('  重力=0', demo.nodes, demo.links, 900, 0, { gravity: 0 });
  run('  阻尼 0.80（更重）', demo.nodes, demo.links, 900, 0, { velocityRetain: 0.80 });
  run('  沉降 3000 tick', demo.nodes, demo.links, 3000, 0);
  run('  碰撞关掉', demo.nodes, demo.links, 900, 0, { collideStrength: 0 });
}

console.log('\n── 逐步收敛过程（charge=0.5, 500 节点）──');
{
  const demo = GFI.DataSource.demo(500, { seed: 42, clusters: 8 });
  const p = setup(0.5);
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  for (let i = 0; i < D.n; i++) {
    D.x[i] = (GFI.util.hash11(i * 2) - 0.5) * 2000;
    D.y[i] = (GFI.util.hash11(i * 2 + 1) - 0.5) * 2000;
  }
  const sim = GFI.Physics.create(D, p);
  for (const mark of [30, 60, 120, 240, 480, 900]) {
    while (sim.tickCount < mark) sim.tick(DT);
    const st = GFI.Data.stats(D);
    console.log(`  tick ${String(mark).padStart(4)}  alpha=${sim.alpha.toFixed(4)}  p50=${st.p50LinkLen.toFixed(1).padStart(7)} (${(st.p50LinkLen / LD).toFixed(2)}×)  半径=${st.boundingRadius}`);
  }
}
console.log('');
