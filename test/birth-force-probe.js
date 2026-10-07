/*
 * 出生力学探针 —— node test/birth-force-probe.js
 * ===========================================================================
 * 回答两个问题（都是白盒：加载真实 timeline/effects/physics，不是 mock）：
 *
 *   1. 「节点出现把其他节点推开」到底有多强？
 *      做法：每 30 帧（0.5 秒）一窗，记录坐标 → 推进 → 量最大位移，
 *      再按「这一窗里有没有节点出生」分成两组。两组的差 = 出生真正带来的位移。
 *      ⚠ 两个坑，都踩过：
 *      (1) 必须排除【本窗内才出生的节点】—— 它的落点是从种子位置瞬移过来的，几百 wu，
 *          会把邻居那几十 wu 完全盖住，指标就退化成了在量瞬移。
 *      (2) 判据要用【绝对位移】而不是比值：把重热删掉后两类窗口双双塌到 0.7/0.3 wu，
 *          而比值反而从 1.5× 涨到 2.7× —— 纯比值对「机制被删掉」是瞎的。
 *
 *   2. 新节点落在哪？Obsidian 是落【所有已存在邻居的质心】±抖动，
 *      本插件 spring 模式是落【单个母体旁 3px】。量的是
 *      「实际落点 − 可见邻居质心」的距离。
 *
 * Obsidian 的对应实现（实测 app.asar!/app.js）：
 *   · setData()：新节点 = 已存在邻居位置均值 ± (rand-.5)*F，F = 60·√I
 *   · 数据变化时唯一的力学动作：worker.postMessage({..., alpha:.3, run:true})
 *
 * 用法：node test/birth-force-probe.js
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
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 7);
const SPAN = 36 * DAY;

function rng(s) {
  let a = s | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 用户真实规模：81 节点 / 36 天
function makeG(seed) {
  const d = GFI.DataSource.demo(81, { seed, clusters: 5 });
  const r = rng(seed + 7), t0 = NOW - SPAN;
  d.nodes.forEach((nd) => { nd.createdAt = t0 + SPAN * r(); });
  return GFI.Data.build(d.nodes, d.links, null);
}

// ---------------------------------------------------------------------------
// 1. 出生把其他节点推开多强
// ---------------------------------------------------------------------------
function birthVsQuiet(opt, seed) {
  const D = makeG(seed);
  GFI.config.pop.mode = opt.mode;
  GFI.config.reheat.timelinePlay = opt.play;
  GFI.config.timeline.revealRate = opt.rate;
  const sim = GFI.Physics.create(D, GFI.config.physics);
  const fx = GFI.Effects.create(D, sim);
  let h = 0; while (sim.isAwake() && h++ < 60 * 120) sim.tick(DT);
  const tl = GFI.Timeline.create(D, sim, fx, {});
  tl.setPlaying(true);

  const born = [], quiet = [];
  const x0 = new Float64Array(D.n), y0 = new Float64Array(D.n);
  const watch = new Uint8Array(D.n);      // 本窗口要跟踪的节点（窗开始时就在场、且不在出生动画中）
  let g = 0, timer = 0, sawBirth = false;
  while (tl.playing && g++ < 60 * 900) {
    if (timer === 0) {
      for (let i = 0; i < D.n; i++) {
        x0[i] = D.x[i]; y0[i] = D.y[i];
        // ⚠ 必须排除「本窗内才出生的节点」：它的落点是从种子位置【瞬移】过来的，
        //   位移有几百 wu，会把邻居那几十 wu 完全盖住 —— 指标就变成在量瞬移，
        //   而不是在量「节点出现把其他节点推开」。同样排除还在出生动画里的。
        watch[i] = (D.visible[i] && D.popT[i] !== D.popT[i]) ? 1 : 0;
      }
      sawBirth = false;
    }
    tl.update(DT, 800);
    for (let i = 0; i < D.n; i++) if (D.popT[i] === 0) { sawBirth = true; break; }
    if (sim.isAwake()) sim.tick(DT);
    fx.update(DT);
    if (++timer === 30) {
      let mx = 0;
      for (let i = 0; i < D.n; i++) {
        if (!watch[i]) continue;
        const d = Math.hypot(D.x[i] - x0[i], D.y[i] - y0[i]);
        if (d > mx) mx = d;
      }
      (sawBirth ? born : quiet).push(mx);
      timer = 0;
    }
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return { born: avg(born), quiet: avg(quiet), net: avg(born) - avg(quiet) };
}

// ---------------------------------------------------------------------------
// 2. 新节点落点离「可见邻居质心」多远
// ---------------------------------------------------------------------------
function anchorOffset(opt, seed) {
  const D = makeG(seed);
  GFI.config.pop.mode = opt.mode;
  GFI.config.reheat.timelinePlay = opt.play;
  GFI.config.timeline.revealRate = opt.rate;
  const sim = GFI.Physics.create(D, GFI.config.physics);
  const fx = GFI.Effects.create(D, sim);
  let h = 0; while (sim.isAwake() && h++ < 60 * 120) sim.tick(DT);
  const tl = GFI.Timeline.create(D, sim, fx, {});
  tl.setPlaying(true);

  const offs = [];
  let g = 0;
  while (tl.playing && g++ < 60 * 900) {
    tl.update(DT, 800);
    for (let i = 0; i < D.n; i++) {
      if (D.popT[i] !== 0) continue;
      let cx = 0, cy = 0, k = 0;
      for (let p = D.adjStart[i]; p < D.adjStart[i + 1]; p++) {
        const j = D.adjList[p];
        if (j === i || !D.visible[j]) continue;
        cx += D.x[j]; cy += D.y[j]; k++;
      }
      // ⚠ 邻居自己也刚被摆过位，所以这条只在「邻接已稳定」时有意义 ——
      //   用 k>=2 过滤掉单邻居的退化情形。
      if (k >= 2) offs.push(Math.hypot(D.x[i] - cx / k, D.y[i] - cy / k));
    }
    if (sim.isAwake()) sim.tick(DT);
    fx.update(DT);
  }
  offs.sort((a, b) => a - b);
  const avg = offs.reduce((a, b) => a + b, 0) / Math.max(1, offs.length);
  return { n: offs.length, avg, p90: offs[Math.floor(offs.length * 0.9)] || 0 };
}

// ---------------------------------------------------------------------------
const LD = GFI.config.physics.linkDistance;
console.log(`基准：linkDistance = ${LD} wu · 81 节点 / 36 天 · 演变节奏 1.0/秒\n`);

const CASES = [
  ['spring   + 0.30', { mode: 'spring', play: 0.30, rate: 1 }],
  ['obsidian + 0.12', { mode: 'obsidian', play: 0.12, rate: 1 }],
  ['obsidian + 0.30', { mode: 'obsidian', play: 0.30, rate: 1 }],
];

console.log('【1】节点出现把其他节点推开的强度（每 0.5 秒一窗，全场最大位移 wu）');
console.log('方案                有出生窗口   无出生窗口    净效应(wu)   倍数');
for (const [name, o] of CASES) {
  const rs = [birthVsQuiet(o, 11), birthVsQuiet(o, 23), birthVsQuiet(o, 37)];
  const a = (k) => rs.reduce((s, x) => s + x[k], 0) / rs.length;
  console.log(name.padEnd(20) + a('born').toFixed(1).padStart(9) +
    a('quiet').toFixed(1).padStart(12) + a('net').toFixed(1).padStart(13) +
    (a('born') / Math.max(0.1, a('quiet'))).toFixed(1).padStart(8) + '×');
}

console.log('\n【2】新节点落点 − 可见邻居质心 的距离（wu，只统计 ≥2 个可见邻居的）');
console.log('方案                采样数      平均      p90');
for (const [name, o] of CASES) {
  const rs = [anchorOffset(o, 11), anchorOffset(o, 23), anchorOffset(o, 37)];
  const a = (k) => rs.reduce((s, x) => s + x[k], 0) / rs.length;
  console.log(name.padEnd(20) + a('n').toFixed(0).padStart(7) +
    a('avg').toFixed(2).padStart(10) + a('p90').toFixed(2).padStart(9));
}

// ---------------------------------------------------------------------------
// 3. 出生「那一记闷棍」有多集中 —— pop.simWeightRamp
// ---------------------------------------------------------------------------
// 新节点落在已存在邻居的质心上（距离趋 0），而斥力用 chargeFalloff=0（恒定幅值），
// 于是它一出生就对邻居施加满幅推力。指标：邻居逐帧 Δv 的【前 3 帧占比】与【首帧值】。
function joltProfile(ramp, seed) {
  const d = GFI.DataSource.demo(81, { seed, clusters: 5 });
  let a = (seed + 7) | 0;
  const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const t0 = NOW - SPAN;
  d.nodes.forEach((nd) => { nd.createdAt = t0 + SPAN * rnd(); });
  const D = GFI.Data.build(d.nodes, d.links, null);
  GFI.config.pop.simWeightRamp = ramp;
  GFI.config.pop.mode = 'obsidian';
  GFI.config.reheat.timelinePlay = 0.30;
  GFI.config.timeline.revealRate = 0.5;
  const sim = GFI.Physics.create(D, GFI.config.physics);
  const fx = GFI.Effects.create(D, sim);
  let h = 0; while (sim.isAwake() && h++ < 60 * 120) sim.tick(DT);
  const tl = GFI.Timeline.create(D, sim, fx, {});
  tl.setPlaying(true);
  const runs = [];
  let g = 0;
  while (tl.playing && g++ < 60 * 900) {
    tl.update(DT, 800);
    let born = -1;
    for (let i = 0; i < D.n; i++) if (D.popT[i] === 0) { born = i; break; }
    if (born >= 0) {
      const nbr = [];
      for (let p = D.adjStart[born]; p < D.adjStart[born + 1]; p++) nbr.push(D.adjList[p]);
      if (nbr.length) {
        const pv = new Float64Array(D.n * 2), series = [];
        for (let k = 0; k < 40; k++) {
          if (sim.isAwake()) sim.tick(DT);
          fx.update(DT);
          let mx = 0;
          for (const j of nbr) {
            const dv = Math.hypot(D.vx[j] - pv[j * 2], D.vy[j] - pv[j * 2 + 1]);
            if (dv > mx) mx = dv;
            pv[j * 2] = D.vx[j]; pv[j * 2 + 1] = D.vy[j];
          }
          series.push(mx);
        }
        runs.push(series);
      }
    }
    if (sim.isAwake()) sim.tick(DT);
    fx.update(DT);
  }
  const avg = new Array(40).fill(0);
  for (const sr of runs) for (let k = 0; k < 40; k++) avg[k] += sr[k];
  for (let k = 0; k < 40; k++) avg[k] /= Math.max(1, runs.length);
  const total = avg.reduce((x, y) => x + y, 0);
  return { first: avg[0], head3: (avg[0] + avg[1] + avg[2]) / Math.max(1e-9, total), total };
}

console.log('');
console.log('【3】出生那一下有多集中（81 节点库，邻居逐帧 Δv；基准线长 ' + LD + ' wu）');
console.log('ramp 越大越摊开 —— 这一步量的是「出生那一下有多集中」');
console.log('simWeightRamp   首帧 Δv   前3帧占总冲量   总冲量');
console.log('');
for (const r of [0, 0.3, 0.5, 0.9]) {
  const rs = [11, 23, 37].map((sd) => joltProfile(r, sd));
  const a = (kk) => rs.reduce((x, y) => x + y[kk], 0) / rs.length;
  const note = r === 0 ? '   ← 改动前（首帧全受力）' : (r === 0.3 ? '   ← 现值' : '');
  console.log(String(r).padEnd(15) + a('first').toFixed(3).padStart(8) +
    (a('head3') * 100).toFixed(0).padStart(13) + '%' + a('total').toFixed(2).padStart(10) + note);
}
GFI.config.pop.simWeightRamp = 0.3;
