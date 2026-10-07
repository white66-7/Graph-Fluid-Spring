/*
 * 出生影响范围探针 —— node test/birth-reach-probe.js
 * ===========================================================================
 * 问题：一次节点出生，是「把旁边的邻居挤开」（局部），还是「把整张图抖一下」（全局）？
 *
 * 三个指标：
 *   hop1..hop4+  按【图距离 BFS】分组，量出生后 0.75 秒内各组的平均位移。
 *   radial       位移沿「节点 → 质心」方向的分量（正 = 整张图在向外长大）。
 *   tangential   垂直于径向的分量（重排 / 抖动）。
 *
 * 结论（全部来自本探针的输出，不是推断）：
 *
 *   1. hop2 以外是一个【平坦地板】（现配置 ≈7.5wu），不随距离衰减。用户说的
 *      「整体位移和其他节点移动」就是它。hop1 是 25wu，局部性只有 3.33×。
 *
 *   2. ⚠ 地板【不是】新节点的斥力造成的：把出生窗口内新节点的斥力射程限到
 *      2.5 倍线长（reach 0/1.5/2.5/4 全试过），hop4+ 纹丝不动 = 7.5。
 *      原因：simWeight 到 1 后射程恢复满值，推力只是被【推迟】到窗口末尾。
 *      → 该功能已撤除（不做无效的死配置）。
 *
 *   3. ⚠ 也【不是】重热过量：重热压到 0.05（几乎不加热），hop4+ 仍有 5.7wu。
 *      而且降重热会让局部性【变差】（3.33× → 2.24×，邻居位移跌得比地板快）。
 *
 *   4. ⚠ 换成【局部冲量】（spring 模式的喷射初速 + 母节点后坐力），
 *      hop4+ = 5.5wu —— 与 obsidian 模式的 5.7wu 一样。此路也不通。
 *
 *   5. 方向分解（hop4+，play 0.30）：径向 3.4wu、切向 4.1wu。
 *      径向 ≈ 图在长大：恒定幅值斥力下平衡半径 R ∝ √N，
 *      80→81 个节点 ⇒ R 变 √(81/80)−1 = 0.62%，R≈500 时就是 3.1wu —— 对得上。
 *      切向 ≈ 全图在重热下重新找平衡。两者都不可约。
 *
 *   ⇒ 结论：「只让邻居动、别拖全图」在当前布局模型下【做不到】。
 *     想让远处完全不动，只能让图不重新找平衡 —— 那图就不会长大了。
 *     现配置（play 0.30）已经是可用选项里局部性最好的（3.33×）。
 *
 * 用法：node test/birth-reach-probe.js
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
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 7);
const SPAN = 36 * DAY;
const LD = GFI.config.physics.linkDistance;

function rng(s) {
  let a = s | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = [11, 23, 37, 53, 71];
const F = (x, n = 2) => x.toFixed(n);

// 用户规模：81 节点 / 36 天
function trial(opt, seed) {
  const d = GFI.DataSource.demo(81, { seed, clusters: 5 });
  const r = rng(seed + 7), t0 = NOW - SPAN;
  d.nodes.forEach((nd) => { nd.createdAt = t0 + SPAN * r(); });
  const D = GFI.Data.build(d.nodes, d.links, null);

  if (opt.play !== undefined) GFI.config.reheat.timelinePlay = opt.play;
  GFI.config.pop.mode = opt.mode === undefined ? 'obsidian' : opt.mode;
  GFI.config.timeline.revealRate = opt.rate === undefined ? 0.5 : opt.rate;

  const sim = GFI.Physics.create(D, GFI.config.physics);
  const fx = GFI.Effects.create(D, sim);
  let h = 0; while (sim.isAwake() && h++ < 60 * 120) sim.tick(DT);
  const tl = GFI.Timeline.create(D, sim, fx, {});
  tl.setPlaying(true);

  const hop = new Int32Array(D.n);
  const shift = { 1: [], 2: [], 3: [], 4: [] };
  const rad = { 1: [], 2: [], 3: [], 4: [] };
  const tan = { 1: [], 2: [], 3: [], 4: [] };
  let g = 0;

  while (tl.playing && g++ < 60 * 900) {
    tl.update(DT, 800);
    let born = -1;
    for (let i = 0; i < D.n; i++) if (D.popT[i] === 0) { born = i; break; }

    if (born >= 0) {
      // BFS 图距离，最多 4 跳
      hop.fill(-1); hop[born] = 0;
      let q = [born];
      for (let depth = 1; depth <= 4 && q.length; depth++) {
        const nq = [];
        for (const u of q) {
          for (let p = D.adjStart[u]; p < D.adjStart[u + 1]; p++) {
            const v = D.adjList[p];
            if (hop[v] < 0) { hop[v] = depth; nq.push(v); }
          }
        }
        q = nq;
      }

      const x0 = Float64Array.from(D.x), y0 = Float64Array.from(D.y);
      let cxs = 0, cys = 0, ck = 0;
      for (let i = 0; i < D.n; i++) if (D.visible[i]) { cxs += D.x[i]; cys += D.y[i]; ck++; }
      cxs /= Math.max(1, ck); cys /= Math.max(1, ck);

      for (let k = 0; k < 45; k++) { if (sim.isAwake()) sim.tick(DT); fx.update(DT); }

      // 按 BFS 距离分组累加（≥4 跳合并进 4）
      const sumR = { 1: 0, 2: 0, 3: 0, 4: 0 };
      const sumD = { 1: 0, 2: 0, 3: 0, 4: 0 };
      const sumT = { 1: 0, 2: 0, 3: 0, 4: 0 };
      const cnt = { 1: 0, 2: 0, 3: 0, 4: 0 };
      for (let i = 0; i < D.n; i++) {
        if (!D.visible[i] || i === born) continue;
        const hh = hop[i] < 0 ? 4 : Math.min(4, hop[i]);
        if (hh < 1) continue;
        const dx = D.x[i] - x0[i], dy = D.y[i] - y0[i];
        // 用【出生前】的位置定径向，避免位移本身污染方向
        let rx = x0[i] - cxs, ry = y0[i] - cys;
        const rl = Math.hypot(rx, ry) || 1;
        rx /= rl; ry /= rl;
        sumD[hh] += Math.hypot(dx, dy);
        sumR[hh] += dx * rx + dy * ry;               // 正 = 远离质心 = 图在长大
        sumT[hh] += Math.abs(dx * (-ry) + dy * rx);  // 垂直分量
        cnt[hh]++;
      }
      for (let k = 1; k <= 4; k++) {
        if (!cnt[k]) continue;
        shift[k].push(sumD[k] / cnt[k]);
        rad[k].push(sumR[k] / cnt[k]);
        tan[k].push(sumT[k] / cnt[k]);
      }
    }
    if (sim.isAwake()) sim.tick(DT);
    fx.update(DT);
  }

  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return {
    shift: [0, avg(shift[1]), avg(shift[2]), avg(shift[3]), avg(shift[4])],
    rad: [0, avg(rad[1]), avg(rad[2]), avg(rad[3]), avg(rad[4])],
    tan: [0, avg(tan[1]), avg(tan[2]), avg(tan[3]), avg(tan[4])],
  };
}

function run(name, opt) {
  const keep = {
    play: GFI.config.reheat.timelinePlay,
  };
  const rs = SEEDS.map((s) => trial(opt, s));
  GFI.config.reheat.timelinePlay = keep.play;
  const a = (k, i) => rs.reduce((x, y) => x + y[k][i], 0) / rs.length;

  console.log(name.padEnd(30) +
    F(a('shift', 1), 1).padStart(7) + F(a('shift', 2), 1).padStart(7) +
    F(a('shift', 3), 1).padStart(7) + F(a('shift', 4), 1).padStart(7) +
    ('  ' + (a('shift', 1) / Math.max(0.01, a('shift', 4))).toFixed(2) + '×').padStart(9) +
    F(a('rad', 4), 1).padStart(9) + F(a('tan', 4), 1).padStart(9));
}

console.log(`出生后 0.75 秒内各组的平均位移（wu）。基准线长 ${LD}，${SEEDS.length} 个种子`);
console.log('hop1 = 直接邻居；hop4+ = 图上很远（≥4 跳或不可达）');
console.log('径向正 = 远离质心（图在长大）；切向 = 重排/抖动');
console.log('');

console.log('方案                             hop1   hop2   hop3   hop4+   局部性   hop4径向  hop4切向');
run('obsidian + play 0.30（现值）', { play: 0.30, mode: 'obsidian' });
run('obsidian + play 0.05（几乎不重热）', { play: 0.05, mode: 'obsidian' });
run('spring  + play 0.05（局部冲量）', { play: 0.05, mode: 'spring' });
run('spring  + play 0.30', { play: 0.30, mode: 'spring' });

GFI.config.reheat.timelinePlay = 0.30;
