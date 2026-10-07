/*
 * 力引擎对照探针 —— node test/physics-vs-obsidian-probe.js
 * ===========================================================================
 * 把本插件的力引擎与 Obsidian 的逐项对账，并对每个差异【实测】它值不值得抄。
 *
 * ── Obsidian 的力引擎（实测 obsidian.asar!/sim.js，17693 字节）──
 * 它是 d3-force 原版 + 一个 WebAssembly 快路径，两边参数一致：
 *
 *   // WASM 快路径
 *   n.simulate(0, nNodes, nLinks, alpha, centerStrength, linkStrength,
 *              linkDistance, charge, .9, .5)   // .9 = theta, .5 = collideStrength
 *   n.complete(0, nNodes, .6)                  // .6 = 速度保留率（velocityDecay 0.4）
 *
 *   // JS 回退（d3-force 原文）
 *   _ = forceX().strength(.1)     N = forceY().strength(.1)
 *   q = forceLink().id(d=>d.id).distance(250)
 *   R = forceManyBody().strength(()=>-1e3).distanceMin(30)
 *   k = forceCollide().radius(60).strength(.5)
 *   每 tick: b.forEach(f => f(alpha));
 *            node.x += node.vx *= .6;
 *   alpha += (alphaTarget - alpha) * (1 - Math.pow(.001, 1/300));
 *
 * 用户可调的四个数（centerStrength / linkStrength / linkDistance / repelStrength）
 * 由主线程 postMessage 传进来；collide 的 radius(60) 与 strength(.5)【从不被覆盖】。
 *
 * 用法：node test/physics-vs-obsidian-probe.js
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

const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
for (const f of ['ns', 'config', 'spatial', 'data', 'physics', 'effects', 'timeline', 'datasource']) load(`src/${f}.js`);

const GFI = sandbox.GFI;
const DT = 1 / 60;
const PH = GFI.config.physics;
const LD = PH.linkDistance;

// 探针会改 config，跑完必须还原 —— 逐键快照
const SNAP = JSON.parse(JSON.stringify(GFI.config.physics));
const restore = () => { for (const k of Object.keys(SNAP)) PH[k] = SNAP[k]; };

function build(N, seed) {
  const d = GFI.DataSource.demo(N, { seed, clusters: Math.max(3, Math.round(Math.sqrt(N) / 2)) });
  return GFI.Data.build(d.nodes, d.links, null);
}

// ---------------------------------------------------------------------------
// A. 布局质量：改某个参数后，收敛要多久、图长什么样
// ---------------------------------------------------------------------------
function layout(patch, N, seed) {
  restore();
  Object.assign(PH, patch);
  const D = build(N, seed);
  const sim = GFI.Physics.create(D, PH);
  let ticks = 0;
  const prevX = Float64Array.from(D.x), prevY = Float64Array.from(D.y);
  const tail = [];
  while (sim.isAwake() && ticks < 6000) {
    sim.tick(DT); ticks++;
    let mx = 0;
    for (let i = 0; i < D.n; i++) {
      const d = Math.hypot(D.x[i] - prevX[i], D.y[i] - prevY[i]);
      if (d > mx) mx = d;
      prevX[i] = D.x[i]; prevY[i] = D.y[i];
    }
    tail.push(mx);
    if (tail.length > 60) tail.shift();
  }
  restore();

  const L = [];
  for (let e = 0; e < D.m; e++) {
    const a = D.lsrc[e], b = D.ltgt[e];
    if (!D.visible[a] || !D.visible[b]) continue;
    L.push(Math.hypot(D.x[a] - D.x[b], D.y[a] - D.y[b]));
  }
  L.sort((x, y) => x - y);

  // 最近邻间距的变异系数 —— 越小越均匀
  const nn = [];
  for (let i = 0; i < D.n; i++) {
    let m = Infinity;
    for (let j = 0; j < D.n; j++) {
      if (i === j) continue;
      const d = Math.hypot(D.x[i] - D.x[j], D.y[i] - D.y[j]);
      if (d < m) m = d;
    }
    nn.push(m);
  }
  const mu = nn.reduce((a, b) => a + b, 0) / nn.length;
  const sd = Math.sqrt(nn.reduce((a, b) => a + (b - mu) * (b - mu), 0) / nn.length);

  const rad = (i) => GFI.config.render.radiusMin + GFI.config.render.radiusScale * Math.sqrt(D.deg[i]);
  let ov = 0;
  for (let i = 0; i < D.n; i++) {
    for (let j = i + 1; j < D.n; j++) {
      const d = Math.hypot(D.x[i] - D.x[j], D.y[i] - D.y[j]);
      if (d < (rad(i) + rad(j)) * 0.9) ov++;
    }
  }

  return {
    ticks, p50: L[Math.floor(L.length * 0.5)] / LD, p90: L[Math.floor(L.length * 0.9)] / LD,
    cv: sd / Math.max(1e-9, mu), ov,
    tail: tail.reduce((a, b) => a + b, 0) / tail.length,
  };
}

// ---------------------------------------------------------------------------
// B. 「没事的时候它自己在动多少」—— 直接对应「整张图停不下来」
// ---------------------------------------------------------------------------
function idleDrift(retain, seed) {
  const DAY = 86400000, NOW = Date.UTC(2026, 9, 7), SPAN = 36 * DAY;
  let a = (seed + 7) | 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const d = GFI.DataSource.demo(81, { seed, clusters: 5 });
  const t0 = NOW - SPAN;
  d.nodes.forEach((nd) => { nd.createdAt = t0 + SPAN * rnd(); });
  const D = GFI.Data.build(d.nodes, d.links, null);

  restore();
  PH.velocityRetain = retain;
  GFI.config.pop.mode = 'obsidian';
  GFI.config.reheat.timelinePlay = 0.30;
  GFI.config.timeline.revealRate = 1;

  const sim = GFI.Physics.create(D, PH);
  const fx = GFI.Effects.create(D, sim);
  let h = 0; while (sim.isAwake() && h++ < 60 * 120) sim.tick(DT);
  const startX = Float64Array.from(D.x), startY = Float64Array.from(D.y);
  const lastX = Float64Array.from(D.x), lastY = Float64Array.from(D.y);

  const tl = GFI.Timeline.create(D, sim, fx, {});
  tl.setPlaying(true);

  let g = 0, path = 0;
  const quiet = [];
  while (tl.playing && g++ < 60 * 900) {
    let born = false;
    tl.update(DT, 800);
    for (let i = 0; i < D.n; i++) if (D.popT[i] === 0) { born = true; break; }
    if (sim.isAwake()) sim.tick(DT);
    fx.update(DT);
    for (let i = 0; i < D.n; i++) {
      path += Math.hypot(D.x[i] - lastX[i], D.y[i] - lastY[i]);
      lastX[i] = D.x[i]; lastY[i] = D.y[i];
    }
    // 只取【没有任何节点出生】的帧 —— 那才是"没事的时候"
    if (!born && g % 3 === 0) {
      let sp = 0, k = 0;
      for (let i = 0; i < D.n; i++) { if (!D.visible[i]) continue; sp += Math.hypot(D.vx[i], D.vy[i]); k++; }
      if (k) quiet.push(sp / k);
    }
  }
  let drift = 0;
  for (let i = 0; i < D.n; i++) drift += Math.hypot(D.x[i] - startX[i], D.y[i] - startY[i]);
  restore();
  const avg = (x) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
  return { path: path / D.n, drift: drift / D.n, quiet: avg(quiet) };
}

// ---------------------------------------------------------------------------
const N_LAYOUT = 300, SEEDS = [11, 23, 37];
const avgOf = (rs, key) => rs.reduce((s, x) => s + x[key], 0) / rs.length;
const F = (x, n = 2) => x.toFixed(n);

console.log(`linkDistance = ${LD} · 布局质量 ${N_LAYOUT} 节点 × ${SEEDS.length} 种子\n`);

// Obsidian 的参数按【相对线长】折算后逐个试
const CASES = [
  ['基线（现状：retain 已 = 0.60）', {}],
  ['velocityRetain .60 → .80   (改动前的旧值，作对照)', { velocityRetain: 0.80 }],
  ['velocityRetain → .50（过阻尼对照）', { velocityRetain: 0.50 }],
  ['settleTicks 400 → 300     (=Obsidian)', { settleTicks: 300 }],
  ['collideStrength 1.0 → .5  (=Obsidian)', { collideStrength: 0.5 }],
  ['distanceMin 16 → 6        (=Obsidian 比例)', { distanceMin: 6 }],
  ['distanceMax 420 → ∞       (=Obsidian 不截断)', { distanceMax: 1e9 }],
  ['linkStrength .3 → 1.0     (=Obsidian 比例)', { linkStrength: 1.0 }],
];

console.log('方案                                       收敛tick   p50/LD  p90/LD   间距CV  重叠对  尾段抖动');
for (const [name, patch] of CASES) {
  const rs = SEEDS.map((s) => layout(patch, N_LAYOUT, s));
  console.log(name.padEnd(42) +
    String(avgOf(rs, 'ticks').toFixed(0)).padStart(7) +
    F(avgOf(rs, 'p50')).padStart(9) + F(avgOf(rs, 'p90')).padStart(8) +
    F(avgOf(rs, 'cv'), 3).padStart(9) + F(avgOf(rs, 'ov'), 1).padStart(8) +
    F(avgOf(rs, 'tail'), 3).padStart(10));
}

console.log('\n\n━━ velocityRetain 对「没事的时候它自己在动多少」的影响 ━━');
console.log('（81 节点 / 演变节奏 1/s / obsidian 缓动 / 重热 0.30，3 种子平均）\n');
console.log('velocityRetain   人均累计路程(wu)  人均净位移(wu)  无事时节点速度(wu/帧)');
for (const r of [0.80, 0.70, 0.60, 0.50]) {
  const rs = SEEDS.map((s) => idleDrift(r, s));
  const note = Math.abs(r - 0.80) < 1e-9 ? '   ← 改动前'
    : (Math.abs(r - 0.60) < 1e-9 ? '   ← 现值 = Obsidian 实测' : '');
  console.log(String(r).padEnd(17) + avgOf(rs, 'path').toFixed(0).padStart(14) +
    avgOf(rs, 'drift').toFixed(0).padStart(16) + avgOf(rs, 'quiet').toFixed(4).padStart(21) + note);
}
