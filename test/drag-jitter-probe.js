/*
 * GFI — 拖拽【hub 抽搐】测量探针
 * ===========================================================================
 * 实机反馈（决定性）：关闭局部弹簧增益后抽搐消失；且【只有大节点（高连接度）周围抽】。
 *
 * 为什么前面四轮全都复现不出来 —— 探针选错对象了：
 *     pickNode() 一直是 `if (D.deg[k] >= 2 && D.deg[k] <= 6) return k;`
 *     【特意挑低度数叶子】。而抽搐发生在 hub 上。
 *
 * hub 的机制与叶子完全不同：
 *   · 边力按度数分配：hub(56)—leaf(1) 的边，biasT = 56/57 ≈ 0.98，
 *     力几乎【全部】施加在叶子上，hub 自己几乎不动。
 *   · 增益 ×16 之后，hub 的【全部 56 个邻居】同时被 16 倍刚度拽向同一点。
 *   · 它们互相挤成一团 → forceCollide（位置修正，不碰速度）每帧硬推开
 *     → 弹簧下一帧再拽回来 → 位置来回跳。
 *   ⚠ 这正是速度类指标看不见的那一类抖动（collide 直接写 x/y）。
 *
 * 指标：
 *   邻居间重叠对   在 hub 的邻居集合里，任意两节点间距 < r_i+r_j+2·pad 的对数
 *   重叠变化率     重叠对数相邻两帧的变化量（>0 表示有对在反复"挤上/弹开"）
 *   位移折返率     邻居连续两帧位移方向夹角 > 120° 的比例
 *   径向翻转率     邻居相对被拖 hub 的径向速度变号比例
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

function pickHub(D) {
  let best = 0, bd = -1;
  for (let k = 0; k < D.n; k++) if (D.deg[k] > bd) { bd = D.deg[k]; best = k; }
  return best;
}

/**
 * @param o { boost, ticks, speed, hub, damp }
 */
function runHub(tag, o) {
  GFI.config.drag.linkBoostDamp = o.damp !== undefined ? o.damp : GFI.config.drag.linkBoostDamp;
  const demo = GFI.DataSource.demo(300, { seed: 7, clusters: 5 });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  sim.lod = 0;
  for (let k = 0; k < 600; k++) sim.tick(DT);

  const i = o.hub ? pickHub(D) : 0;
  const homeX = D.x[i], homeY = D.y[i];
  const nbrs = [];
  for (let p = D.adjStart[i]; p < D.adjStart[i + 1]; p++) nbrs.push(D.adjList[p]);

  const pad = GFI.config.physics.collidePad;
  const overlapPairs = () => {
    let c = 0;
    for (let a = 0; a < nbrs.length; a++) {
      for (let b = a + 1; b < nbrs.length; b++) {
        const ja = nbrs[a], jb = nbrs[b];
        const d = Math.hypot(D.x[ja] - D.x[jb], D.y[ja] - D.y[jb]);
        if (d < D.radius[ja] + D.radius[jb] + 2 * pad) c++;
      }
    }
    return c;
  };

  sim.pin(i, homeX, homeY);
  if (D.deg[i] > 0) sim.setAlphaTarget(GFI.config.reheat.dragStart);
  if (o.boost > 1) sim.setDragLinkBoost(i, o.boost);

  // 抓起不动 30 帧
  let grabPeak = 0;
  for (let k = 0; k < 30; k++) {
    sim.tick(DT);
    for (const j of nbrs) {
      const s = Math.hypot(D.vx[j], D.vy[j]);
      if (s > grabPeak) grabPeak = s;
    }
  }

  const px = new Float64Array(D.n), py = new Float64Array(D.n);
  const pdx = new Float64Array(D.n), pdy = new Float64Array(D.n);
  const prevSign = new Int32Array(D.n);
  const has = new Uint8Array(D.n);
  let ring = 0, samples = 0;
  let dragPeak = 0, rev = 0, revN = 0;
  let ovSum = 0, ovMax = 0, ovChanges = 0, ovFrames = 0, prevOv = -1;
  let reheated = false;

  for (let k = 1; k <= o.ticks; k++) {
    sim.pin(i, homeX + o.speed * k, homeY + o.speed * k * 0.5);
    if (!reheated) { sim.reheat(GFI.config.reheat.dragStart); reheated = true; }
    sim.tick(DT);

    const ov = overlapPairs();
    ovSum += ov; ovFrames++;
    if (ov > ovMax) ovMax = ov;
    if (prevOv >= 0 && Math.abs(ov - prevOv) > 0) ovChanges += Math.abs(ov - prevOv);
    prevOv = ov;

    for (const j of nbrs) {
      const dx = D.x[j] - px[j], dy = D.y[j] - py[j];
      const disp = Math.hypot(dx, dy);
      const sp = Math.hypot(D.vx[j], D.vy[j]);
      if (sp > dragPeak) dragPeak = sp;

      const ax = D.x[j] - D.x[i], ay = D.y[j] - D.y[i];
      const ad = Math.hypot(ax, ay) || 1e-9;
      const vr = (ax / ad) * D.vx[j] + (ay / ad) * D.vy[j];
      const sg = vr > 1e-6 ? 1 : (vr < -1e-6 ? -1 : 0);
      if (sg !== 0) {
        if (prevSign[j] !== 0 && sg !== prevSign[j]) ring++;
        prevSign[j] = sg;
      }
      samples++;

      if (has[j] && disp > 1e-6) {
        const pd = Math.hypot(pdx[j], pdy[j]);
        if (pd > 1e-6) {
          revN++;
          const cos = (pdx[j] * dx + pdy[j] * dy) / (pd * disp);
          if (cos < -0.5) rev++;
        }
      }
      px[j] = D.x[j]; py[j] = D.y[j];
      pdx[j] = dx; pdy[j] = dy;
      has[j] = 1;
    }
  }
  // 松手瞬间到最近邻居的距离 = 跟随质量（越小越好；不干预时是 ~290）
  let gap = Infinity;
  for (const j of nbrs) {
    const d = Math.hypot(D.x[j] - D.x[i], D.y[j] - D.y[i]);
    if (d < gap) gap = d;
  }
  sim.setDragLinkBoost(-1, 1);

  console.log(
    tag.padEnd(24) +
    ` 度数=${String(D.deg[i]).padStart(3)}` +
    ` 抓取期峰邻速=${grabPeak.toFixed(1).padStart(5)}` +
    ` 拖拽期峰邻速=${dragPeak.toFixed(1).padStart(5)}` +
    ` 径向翻转=${(ring / Math.max(1, samples)).toFixed(3)}` +
    ` 位移折返=${(rev / Math.max(1, revN) * 100).toFixed(1).padStart(4)}%` +
    ` 松手邻距=${gap.toFixed(0).padStart(4)}`
  );
  void ovSum; void ovMax; void ovChanges; void ovFrames;
}

// ===========================================================================
console.log('── hub 抽搐测量 ｜ 300 节点 seed=7，LOD0，匀速拖 2wu/帧 200 帧 ──');
console.log('⚠ 前四轮探针一直挑 deg 2~6 的【叶子】，而抽搐发生在 hub —— 这是复现不出的原因');
console.log('「邻居间重叠对」= hub 的邻居里间距小于 r_i+r_j+2·collidePad 的对数');
console.log('「每帧变化」= 该对数逐帧的变化量；持续非零 = 邻居在反复挤上/弹开 = 抽搐\n');
console.log('                      度数  重叠对均值  峰值  每帧变化  径向翻转  位移折返');
console.log('');

console.log('【A 组：拖 hub —— 固定阻尼 0.8（= 没有额外阻尼，改动前的行为）】');
for (const b of [1, 4, 16]) {
  runHub(`  boost=${String(b).padEnd(2)} damp=0.80`, { boost: b, ticks: 200, speed: 2, hub: true, damp: 0.8 });
}

console.log('\n【B 组：拖 hub —— 逐步加大额外阻尼（boost 固定 16）】');
for (const d of [0.6, 0.45, 0.35, 0.28, 0.22, 0.16]) {
  runHub(`  boost=16 damp=${d}`, { boost: 16, ticks: 200, speed: 2, hub: true, damp: d });
}

console.log('\n【C 组：拖 hub —— 较低增益 + 配套阻尼（可能比高增益更稳）】');
for (const cfg of [[8, 0.35], [8, 0.22], [12, 0.28]]) {
  runHub(`  boost=${cfg[0]} damp=${cfg[1]}`, { boost: cfg[0], ticks: 200, speed: 2, hub: true, damp: cfg[1] });
}

console.log('\n【D 组：拖低度数叶子（确认没有把叶子的手感搞坏）】');
for (const b of [1, 16]) {
  runHub(`  boost=${String(b).padEnd(2)} damp=0.80`, { boost: b, ticks: 200, speed: 2, hub: false, damp: 0.8 });
}
runHub('  boost=16 damp=0.22', { boost: 16, ticks: 200, speed: 2, hub: false, damp: 0.22 });
