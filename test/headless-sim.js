/*
 * 无头仿真测试 —— node test/headless-sim.js
 * ===========================================================================
 * 为什么能这么测：physics / spatial / data / effects 四个模块【完全不碰 DOM】，
 * 只在 Node 里 shim 一个 window 就能跑。渲染器/overlay/toolbar 才需要真实浏览器。
 *
 * 验证的是 M2 / M4 / M5 的验收标准：
 *   · 模拟能从随机团收敛，不发散、不 NaN
 *   · p50 边长落在 1.2 ~ 1.6 × linkDistance
 *   · pop 弹簧峰值 = 1.328，出现在 ~59ms
 *   · 激波是【行进波前】：近处节点先于远处被推、hubs 比叶子动得少
 *   · 时间轴 cutoff 过滤正确，且无时间戳的节点永远可见
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 最小 window shim
// ---------------------------------------------------------------------------
const sandbox = {
  console,
  Math,
  Date,
  Number,
  Array,
  Object,
  JSON,
  Map,
  Set,
  Float32Array,
  Float64Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int32Array,
  isNaN,
  parseInt,
  parseFloat,
  Infinity,
  NaN,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  document: { documentElement: {}, createElement: () => ({ style: {}, getContext: () => null }) },
  setTimeout,
  clearTimeout,
};
sandbox.window = sandbox;
sandbox.parent = sandbox;          // parent === window → 走 self 分支
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

for (const f of ['ns', 'config', 'spatial', 'data', 'physics', 'effects', 'timeline', 'datasource']) {
  load(`src/${f}.js`);
}

const GFI = sandbox.GFI;
const DT = 1 / 60;

// 激波冲量必须【显式给定】，不能靠 config 默认值：
// config.shock.magnitude 是用户可调项，796a70e 起默认 0（关掉全屏扩散激波），
// 于是 pulse() 在 `if (mag <= 0) return` 处直接早退，整个第 5 节断言全废、
// 并且因为 firstHit 为空引发 TypeError 把 6~9 节一起带走。
// 下面这些断言验的是【波前机制本身】—— 行进波前、距离衰减、度数加权、
// 环带不重叠 —— 与那个可调幅度无关，所以这里给死一个值。
// 210 = 这些断言被标定时的原默认值。
const SHOCK_MAG = 210;

// 物理测试全部跑在【基准线长 82】上，而不是 config 里的当前值。
//
// 为什么：`p50 边长 ∈ [1.2, 1.6] × linkDistance` 这个判据的【原意】是
// 「弹簧接近静止长度 ⇒ charge 标定得合适」。而它能成立的前提是
// linkDistance 处于基准量级 —— 一旦把线长调到 40 以下，图谱的整体尺度
// 被斥力/重力撑着缩不下去（实测 fit-k 几乎不动：0.428 → 0.490），
// 边长便有下限，比值必然上翘（ld=22 时 1.69，ld=10 时 2.28），
// 跟 charge 好不好已经没有关系了。
//
// 所以 linkDistance 在这里当【外观调参】处理：调它不该让标定测试变红。
// 要重新标定 charge，用 test/quick-cal.js（它读 configDefaults，也跟着改）。
const REF_LINK_DISTANCE = 82;
GFI.config.physics.linkDistance = REF_LINK_DISTANCE;

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  \x1b[32m✔\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✘\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n\x1b[36m━━━ ${t} ━━━\x1b[0m`); }
function countNaN(D) {
  let c = 0;
  for (let i = 0; i < D.n; i++) if (!Number.isFinite(D.x[i]) || !Number.isFinite(D.y[i])) c++;
  return c;
}

// ===========================================================================
section('1. 数据层 — SoA 构建');
// ===========================================================================
const demo = GFI.DataSource.demo(500, { seed: 42, clusters: 8 });
let D = GFI.Data.build(demo.nodes, demo.links, null);
check('节点/边数量正确', D.n === demo.nodes.length, `n=${D.n} m=${D.m}`);
check('度数总和 = 2m', (() => { let s = 0; for (let i = 0; i < D.n; i++) s += D.deg[i]; return s === D.m * 2; })(), `Σdeg=${(() => { let s = 0; for (let i = 0; i < D.n; i++) s += D.deg[i]; return s; })()}, 2m=${D.m * 2}`);
check('CSR 邻接自洽（adjStart[n] === 2m）', D.adjStart[D.n] === D.m * 2);
check('初始位置无 NaN', countNaN(D) === 0);
check('createdAt 是 Float64Array 且含 NaN', D.createdAt instanceof Float64Array && (() => {
  let nan = 0; for (let i = 0; i < D.n; i++) if (Number.isNaN(D.createdAt[i])) nan++;
  return nan > 0;
})(), `无时间戳节点 ${(() => { let c = 0; for (let i = 0; i < D.n; i++) if (Number.isNaN(D.createdAt[i])) c++; return c; })()}`);

const tr = GFI.Data.timeRange(D);
check('时间范围可解析', !!tr && tr.duration > 0, tr ? `${new Date(tr.min).toISOString().slice(0, 10)} → ${new Date(tr.max).toISOString().slice(0, 10)}` : 'null');

// ===========================================================================
section('2. 物理 — 收敛性');
// ===========================================================================
const sim = GFI.Physics.create(D, GFI.config.physics);
const N2 = 900;                       // 15 秒
const t0 = Date.now();
for (let i = 0; i < N2; i++) sim.tick(DT);
const elapsedMs = Date.now() - t0;

check('无 NaN / 无发散', countNaN(D) === 0, `NaN=${countNaN(D)}`);
check('alpha 已降到 alphaMin 附近', sim.alpha <= GFI.config.physics.alphaMin * 1.5,
  `alpha=${sim.alpha.toExponential(2)} (alphaMin=${GFI.config.physics.alphaMin})`);

const st = GFI.Data.stats(D);
const ratio = st.p50LinkLen / REF_LINK_DISTANCE;
check('p50 边长落在 1.2~1.6 × linkDistance', ratio >= 1.2 && ratio <= 1.6,
  `p50=${st.p50LinkLen} 基准线长=${REF_LINK_DISTANCE} 比值=${ratio.toFixed(2)}`);
check('图谱不是一团（包围半径合理）', st.boundingRadius > 100, `包围半径=${st.boundingRadius}`);
check('模拟速度可接受', elapsedMs / N2 < 8, `${(elapsedMs / N2).toFixed(2)} ms/tick（900 tick 共 ${elapsedMs}ms）`);

console.log(`    平均度数 ${st.avgDeg} · 最大度数 ${st.maxDeg} · 孤立 ${st.isolated} · p90 边长 ${st.p90LinkLen}`);

// ===========================================================================
section('3. 空间网格');
// ===========================================================================
const g = sim.grid;
check('网格已构建', g.cols > 0 && g.rows > 0, `${g.cols}×${g.rows} 格，cellSize=${g.cellSize}`);
check('网格纳入所有活动节点', g.count === D.n, `${g.count}/${D.n}`);

const buf = new Int32Array(D.n);
const bb = GFI.Data.bounds(D, false);
const got = g.collectRect(D, bb.minX - 1, bb.minY - 1, bb.maxX + 1, bb.maxY + 1, buf, null);
check('全图矩形查询找回所有节点', got === D.n, `${got}/${D.n}`);

const one = new Int32Array(8);
const idx = 0;
const near = g.collectRadius(D, D.x[idx], D.y[idx], 5, one, null);
check('半径查询至少命中自身', near >= 1 && Array.from(one.slice(0, near)).includes(idx), `命中 ${near} 个`);

// 对照：暴力法验证网格查询完整性
(function verifyGrid() {
  const cx = D.x[100], cy = D.y[100], R = 300;
  let brute = 0;
  for (let i = 0; i < D.n; i++) {
    const dx = D.x[i] - cx, dy = D.y[i] - cy;
    if (dx * dx + dy * dy <= R * R) brute++;
  }
  const out = new Int32Array(D.n);
  const got2 = g.collectRadius(D, cx, cy, R, out, null);
  check('半径查询与暴力法一致', got2 === brute, `网格 ${got2} / 暴力 ${brute}`);
})();

// ===========================================================================
section('4. pop-out 弹簧（欠阻尼振子）');
// ===========================================================================
(function testPop() {
  const fx = GFI.Effects.create(D, sim);
  const i = 5;
  fx.beginReveal(i, 0);
  let peak = 0, peakT = 0;
  const steps = Math.ceil(GFI.config.pop.maxDuration * 60);
  for (let k = 1; k <= steps; k++) {
    fx.update(DT);
    const t = k * DT;
    if (D.scaleMul[i] > peak) { peak = D.scaleMul[i]; peakT = t; }
  }
  // 期望值从配置推导，不写死 —— 否则每次调 ω₀/ζ 都要改测试
  const P = GFI.config.pop;
  const wd = P.omega * Math.sqrt(Math.max(0, 1 - P.zeta * P.zeta));
  const tPeakTheory = Math.atan(wd / (P.zeta * P.omega)) / wd;
  const peakTheory = 1 + P.amp * Math.exp(-P.zeta * P.omega * tPeakTheory) * Math.sin(wd * tPeakTheory);

  check(`峰值尺度 ≈ ${peakTheory.toFixed(3)}（${Math.round((peakTheory - 1) * 100)}% 过冲）`,
    Math.abs(peak - peakTheory) < 0.02, `实测 ${peak.toFixed(4)}`);
  check(`峰值时刻 ≈ ${(tPeakTheory * 1000).toFixed(0)}ms`,
    Math.abs(peakT - tPeakTheory) < 0.02, `实测 ${(peakT * 1000).toFixed(1)}ms`);
  check('动画结束后 scaleMul 归 1', Math.abs(D.scaleMul[i] - 1) < 1e-6, `scaleMul=${D.scaleMul[i]}`);
  check('pop 不影响模拟位置', D.popT[i] !== D.popT[i], 'popT 已清空（NaN）');
})();

// ===========================================================================
section('5. 斥力激波 — 必须是"行进波前"而不是"缩放"');
// ===========================================================================
(function testPulse() {
  // 造一个可控图：中心 hub + 同心环上的叶子
  const nodes = [{ id: 'hub', label: 'hub', kind: 'page' }];
  const links = [];
  const rings = [200, 500, 900, 1500];
  const RADIAL = 8;
  const ringIdx = [];
  rings.forEach((r, ri) => {
    const arr = [];
    for (let k = 0; k < RADIAL; k++) {
      const a = (k / RADIAL) * Math.PI * 2;
      const id = `r${ri}-${k}`;
      nodes.push({ id, label: id, kind: 'page' });
      links.push({ source: id, target: 'hub' });
      arr.push({ id, x: Math.cos(a) * r, y: Math.sin(a) * r, r });
    }
    ringIdx.push(arr);
  });

  const D2 = GFI.Data.build(nodes, links, null);
  // 摆到指定半径上，并冻结模拟（只观察激波注入的速度）
  for (const ring of ringIdx) {
    for (const n of ring) {
      const i = D2.indexById.get(n.id);
      D2.x[i] = n.x; D2.y[i] = n.y;
    }
  }
  const sim2 = GFI.Physics.create(D2, GFI.config.physics);
  const fx2 = GFI.Effects.create(D2, sim2);

  const hubIdx = D2.indexById.get('hub');
  // 记录每个节点第一次获得速度的时刻
  const firstHit = new Map();
  const mags = new Map();

  fx2.pulse({ ox: 0, oy: 0, sign: 1, magnitude: SHOCK_MAG, viewportWorldHeight: 2000 });

  for (let k = 1; k <= 90; k++) {
    const before = new Map();
    for (let i = 0; i < D2.n; i++) before.set(i, Math.hypot(D2.vx[i], D2.vy[i]));
    fx2.update(DT);
    for (let i = 0; i < D2.n; i++) {
      const v = Math.hypot(D2.vx[i], D2.vy[i]);
      if (v > before.get(i) + 1e-6 && !firstHit.has(i)) {
        firstHit.set(i, k * DT);
        mags.set(i, v - before.get(i));
      }
    }
  }

  check('所有叶子都被波前击中', firstHit.size >= RADIAL * rings.length,
    `${firstHit.size}/${RADIAL * rings.length + 1}`);

  // 关键判据 ①：近处先于远处被击中 —— 相机缩放做不到这一点
  const tNear = firstHit.get(D2.indexById.get('r0-0'));
  const tFar = firstHit.get(D2.indexById.get('r3-0'));
  check('近处节点先于远处被击中（波前在推进）', tNear < tFar,
    `r=200 → ${(tNear * 1000).toFixed(0)}ms，r=1500 → ${(tFar * 1000).toFixed(0)}ms`);

  // 关键判据 ②：能量沿路径衰减
  const mNear = mags.get(D2.indexById.get('r0-0'));
  const mFar = mags.get(D2.indexById.get('r3-0'));
  check('幅度沿路径指数衰减', mNear > mFar,
    `近 ${mNear.toFixed(1)} > 远 ${mFar.toFixed(1)}`);

  // 关键判据 ③：hubs 比叶子动得少 —— 最强的反缩放线索
  check('hub 因度数高而移动更少', (() => {
    // hub 度数 = RADIAL*rings.length = 32，叶子度数 = 1
    const hubMag = mags.get(hubIdx);
    const leafMag = mNear;
    if (hubMag === undefined) return true;   // hub 在圆心，波前从它身上出发，可能不被击中
    return hubMag < leafMag;
  })(), `hub 度数 ${D2.deg[hubIdx]}，叶子度数 ${D2.deg[D2.indexById.get('r0-0')]}`);

  // 关键判据 ④：每节点恰好被击中一次（环带扫过）
  let hitTwice = 0;
  const hits = new Map();
  const fx3 = GFI.Effects.create(D2, sim2);
  for (let i = 0; i < D2.n; i++) { D2.vx[i] = 0; D2.vy[i] = 0; }
  fx3.pulse({ ox: 0, oy: 0, sign: 1, magnitude: SHOCK_MAG, viewportWorldHeight: 2000 });
  for (let k = 0; k < 90; k++) {
    const before = new Float32Array(D2.n);
    for (let i = 0; i < D2.n; i++) before[i] = D2.vx[i];
    fx3.update(DT);
    for (let i = 0; i < D2.n; i++) {
      if (D2.vx[i] !== before[i]) hits.set(i, (hits.get(i) || 0) + 1);
    }
  }
  for (const [, c] of hits) if (c > 1) hitTwice++;
  check('无节点被重复击中（环带不重叠）', hitTwice === 0, `重复击中 ${hitTwice} 个`);

  // 关键判据 ⑤：倒退时符号翻转 → 内爆
  const fx4 = GFI.Effects.create(D2, sim2);
  for (let i = 0; i < D2.n; i++) { D2.vx[i] = 0; D2.vy[i] = 0; }
  fx4.pulse({ ox: 0, oy: 0, sign: -1, magnitude: SHOCK_MAG, viewportWorldHeight: 2000 });
  for (let k = 0; k < 30; k++) fx4.update(DT);
  const li = D2.indexById.get('r1-0');
  const radial = D2.x[li] * D2.vx[li] + D2.y[li] * D2.vy[li];   // 与径向同号 = 向外
  check('sign<0 时向内吸（内爆）', radial < 0, `径向速度分量 ${radial.toFixed(1)}`);
})();

// ===========================================================================
section('6. 时间轴过滤');
// ===========================================================================
(function testTimeline() {
  const D3 = GFI.Data.build(GFI.DataSource.demo(300, { seed: 7 }).nodes,
    GFI.DataSource.demo(300, { seed: 7 }).links, null);
  const r = GFI.Data.timeRange(D3);

  GFI.Data.applyCutoff(D3, r.min);
  let visAtMin = 0;
  for (let i = 0; i < D3.n; i++) if (D3.wantVisible[i]) visAtMin++;

  GFI.Data.applyCutoff(D3, r.max);
  let visAtMax = 0;
  for (let i = 0; i < D3.n; i++) if (D3.wantVisible[i]) visAtMax++;

  check('cutoff=min 时只有最早的一批可见', visAtMin > 0 && visAtMin < visAtMax, `${visAtMin} 个`);
  check('cutoff=max 时全部可见', visAtMax === D3.n, `${visAtMax}/${D3.n}`);

  // 无时间戳的节点必须永远可见（NaN > cutoff 恒 false）
  const D4 = GFI.Data.build(
    [{ id: 'a', label: 'a', kind: 'page', createdAt: 1000 },
     { id: 'b', label: 'b', kind: 'page' }], [], null);
  GFI.Data.applyCutoff(D4, 0);
  check('无时间戳的节点在 cutoff=0 时仍可见', D4.wantVisible[1] === 1);
  check('有时间戳的节点在 cutoff=0 时被隐藏', D4.wantVisible[0] === 0);
})();

// ===========================================================================
section('7. 拖拽沉降 — 加权混合交接');
// ===========================================================================
(function testSettle() {
  const D5 = GFI.Data.build(GFI.DataSource.demo(120, { seed: 3 }).nodes,
    GFI.DataSource.demo(120, { seed: 3 }).links, null);
  const sim5 = GFI.Physics.create(D5, GFI.config.physics);
  const fx5 = GFI.Effects.create(D5, sim5);
  const i = 3;
  for (let k = 0; k < 60; k++) sim5.tick(DT);

  const x0 = D5.x[i], y0 = D5.y[i];
  fx5.startSettle(i, x0 + 300, y0, 900, 0, x0 + 300 * (1 - 0.22) + 15, y0, 1);
  D5.x[i] = x0 + 300; D5.y[i] = y0;

  let maxJump = 0, lastX = D5.x[i], lastY = D5.y[i];
  for (let k = 0; k < 120; k++) {
    sim5.tick(DT);
    fx5.applyHandoff(DT);
    const jump = Math.hypot(D5.x[i] - lastX, D5.y[i] - lastY);
    if (jump > maxJump) maxJump = jump;
    lastX = D5.x[i]; lastY = D5.y[i];
    if (!fx5.settleActive) break;
  }
  check('沉降过程中无位置突变（交接无缝）', maxJump < 40, `最大单帧位移 ${maxJump.toFixed(2)} wu`);
  check('沉降会自行结束', !fx5.settleActive);
  check('结束后位置有限', Number.isFinite(D5.x[i]) && Number.isFinite(D5.y[i]));
})();

// ===========================================================================
section('8. 时间轴端到端 —— 揭示的节点必须真的能画出来');
// ===========================================================================
// 这一节是为了抓一个真实发生过的 bug：
//   beginReveal 把 simWeight 置 0（"权重渐入"），但没有实现渐入。
//   而 simWeight 是 activeMask 的依据，空间网格又只收录 active 节点
//   → 被揭示的节点永远进不了网格 → 视口剔除找不到 → 永远不绘制。
//   症状：按播放后只有最初那一两个节点可见。
(function testTimelineReveal() {
  const demo = GFI.DataSource.demo(120, { seed: 11 });
  const D6 = GFI.Data.build(demo.nodes, demo.links, null);
  const sim6 = GFI.Physics.create(D6, GFI.config.physics);
  const fx6 = GFI.Effects.create(D6, sim6);
  const tl6 = GFI.Timeline.create(D6, sim6, fx6, {});

  check('时间范围可解析', !!tl6.range);

  // 跳到起点：只剩最早的一两个节点可见。
  // 注意要先让淡出动画跑完 —— visible 是在 fadeT 走完才置 0 的。
  tl6.setCutoff(tl6.range.min, { pulse: false });
  for (let k = 0; k < 60; k++) fx6.update(GFI.DT);
  let vis0 = 0;
  for (let i = 0; i < D6.n; i++) if (D6.visible[i]) vis0++;
  // 不写成固定数量 —— 合成数据里会有若干节点共享接近最小的时间戳，
  // 关键是"起点只占很小一部分"，而不是恰好 1 个
  check('起点只有很小一部分节点可见', vis0 > 0 && vis0 < D6.n * 0.15,
    `${vis0}/${D6.n} 个可见`);

  // 把模拟跑到沉降，模拟真实播放过程
  const DT6 = GFI.DT;
  tl6.setPlaying(true);
  const vh = 800;
  // 预算按配置算，别写死 —— 改 baseDurationSec 会让写死的帧数不够用
  const maxTicks = Math.ceil(GFI.config.timeline.baseDurationSec * 60 * 1.6);
  for (let k = 0; k < maxTicks; k++) {
    const awake = sim6.isAwake();
    if (awake) sim6.tick(DT6);
    fx6.update(DT6);
    tl6.update(DT6, vh);
    if (!tl6.playing) break;
  }
  // 播放结束后模拟还会继续跑一会儿（fx.anyActive() 让循环保持忙碌），
  // 最后一批被揭示的节点靠这段把 simWeight 渐入完
  sim6.tick(DT6);
  for (let k = 0; k < 60; k++) fx6.update(DT6);

  let visN = 0, activeN = 0, stuckZero = 0;
  for (let i = 0; i < D6.n; i++) {
    if (D6.visible[i]) visN++;
    if (D6.simWeight[i] > 0) activeN++;
    // 可见但权重恒为 0 = 会被网格漏掉 = 画不出来
    if (D6.visible[i] && D6.simWeight[i] <= 0) stuckZero++;
  }

  check('播放走完全程后有节点可见', visN > 0, `${visN} 个可见`);
  check('没有「可见但 simWeight=0」的节点（会被网格漏掉）', stuckZero === 0,
    `${stuckZero} 个卡住`);
  check('所有可见节点都参与了力循环', activeN >= visN - 0,
    `可见 ${visN} / 活跃 ${activeN}`);

  // 关键：网格必须真的收录这些节点，否则绘制阶段找不到它们
  sim6.tick(DT6);
  const grid6 = sim6.grid;
  let inGrid = 0;
  for (let i = 0; i < grid6.count; i++) inGrid++;
  check('网格收录了活跃节点', inGrid === activeN, `网格 ${inGrid} / 活跃 ${activeN}`);

  // 播放应当自然结束（而不是卡住）
  check('播放会自行结束', !tl6.playing, `playing=${tl6.playing}`);

  // 来回擦滑块：反复隐藏/显示，不应有节点卡在中间态
  for (let round = 0; round < 6; round++) {
    tl6.setCutoff(tl6.range.min, { pulse: false });
    for (let k = 0; k < 40; k++) fx6.update(DT6);
    tl6.setCutoff(tl6.range.max, { pulse: false });
    for (let k = 0; k < 40; k++) fx6.update(DT6);
  }
  let bad = 0;
  for (let i = 0; i < D6.n; i++) {
    const fading = D6.fadeT[i] === D6.fadeT[i];
    if (D6.wantVisible[i] === 1 && (D6.visible[i] === 0 || fading)) bad++;
  }
  check('来回擦滑块后没有节点卡在"该显示却没显示"', bad === 0, `${bad} 个异常`);
})();

// ===========================================================================
section('7b. 孤立节点外环布局');
// ===========================================================================
// 零度节点没有连边力，位置随机 —— 否则会飘在主干中间挡住别的节点。
(function testIsolatedRing() {
  // 造一个"核心 + 一圈孤立点"的图
  const nodes = [], links = [];
  for (let i = 0; i < 30; i++) {
    nodes.push({ id: 'c' + i, label: 'c' + i, kind: 'page' });
  }
  for (let i = 1; i < 30; i++) links.push({ source: 'c0', target: 'c' + i });
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: 'i' + i, label: 'i' + i, kind: 'page' });
  }

  const D9 = GFI.Data.build(nodes, links, null);
  const sim9 = GFI.Physics.create(D9, GFI.config.physics);
  for (let k = 0; k < 900; k++) sim9.tick(GFI.DT);

  // 连通节点的质心与半径
  let cx = 0, cy = 0, k = 0;
  for (let i = 0; i < D9.n; i++) {
    if (D9.deg[i] === 0) continue;
    cx += D9.x[i]; cy += D9.y[i]; k++;
  }
  cx /= k; cy /= k;
  let maxR = 0;
  for (let i = 0; i < D9.n; i++) {
    if (D9.deg[i] === 0) continue;
    maxR = Math.max(maxR, Math.hypot(D9.x[i] - cx, D9.y[i] - cy));
  }

  // 孤立节点的半径分布
  const isoR = [];
  for (let i = 0; i < D9.n; i++) {
    if (D9.deg[i] !== 0) continue;
    isoR.push(Math.hypot(D9.x[i] - cx, D9.y[i] - cy));
  }
  const outside = isoR.filter((r) => r >= maxR * 0.95).length;
  const avg = isoR.reduce((a, b) => a + b, 0) / Math.max(1, isoR.length);

  check('孤立节点数量正确', isoR.length === 12, `${isoR.length} 个`);
  check('孤立节点全部落在连通主干之外', outside === isoR.length,
    `${outside}/${isoR.length} 在外圈（主干半径 ${maxR.toFixed(0)}，孤立点均值 ${avg.toFixed(0)}）`);
  check('孤立节点半径与目标环接近',
    Math.abs(avg / maxR - GFI.config.physics.isolatedRing.factor) < 0.35,
    `实际/目标 = ${(avg / maxR).toFixed(2)} vs ${GFI.config.physics.isolatedRing.factor}`);

  // 分散度用【二维最小间距】衡量，而不是角间隔 ——
  // 角度相同但半径差很大的两个节点，视觉上根本不挨着，用角度判会误报。
  const iso = [];
  for (let i = 0; i < D9.n; i++) if (D9.deg[i] === 0) iso.push(i);

  let minPair = Infinity;
  for (let a = 0; a < iso.length; a++) {
    for (let b = a + 1; b < iso.length; b++) {
      const i = iso[a], j = iso[b];
      const dd = Math.hypot(D9.x[i] - D9.x[j], D9.y[i] - D9.y[j]);
      if (dd < minPair) minPair = dd;
    }
  }
  const minSep = D9.radius[iso[0]] * 2 + 6;   // 两倍节点半径 + 一点余量
  check('孤立节点彼此不重叠', minPair > minSep,
    `最小间距 ${minPair.toFixed(1)}（需 > ${minSep.toFixed(1)}）`);

  // 诊断：逐个列出角度与半径，看清是"角度没散开"还是"半径没对齐"
  const rows = iso.map((i) => {
    const ang = Math.atan2(D9.y[i] - cy, D9.x[i] - cx);
    return {
      id: D9.label[i],
      angDeg: (ang * 180 / Math.PI + 360) % 360,
      r: Math.hypot(D9.x[i] - cx, D9.y[i] - cy),
    };
  }).sort((a, b) => a.angDeg - b.angDeg);

  let minGap = Infinity;
  for (let i = 1; i < rows.length; i++) minGap = Math.min(minGap, rows[i].angDeg - rows[i - 1].angDeg);
  const ideal = 360 / rows.length;
  console.log(`    角度分布（理想间隔 ${ideal.toFixed(1)}°，实测最小 ${minGap.toFixed(1)}°）：`);
  console.log('      ' + rows.map((r) => `${r.angDeg.toFixed(0)}°/${r.r.toFixed(0)}`).join('  '));
})();

// ===========================================================================
section('8b. 激波行程 —— 扫完就结束，不空跑');
// ===========================================================================
// 回归点：原来 maxRadius 写死 2600。图谱只有 700 单位时，波 0.3 秒就扫完了，
// 却要继续空跑 1.08 秒才算结束 —— 于是好几道波同时在飞，
// 观感就是"前一个效果还没完，下一个就直接来了"。
(function testPulseTravel() {
  const demo = GFI.DataSource.demo(80, { seed: 13 });
  const D8 = GFI.Data.build(demo.nodes, demo.links, null);
  const sim8 = GFI.Physics.create(D8, GFI.config.physics);
  const fx8 = GFI.Effects.create(D8, sim8);

  const measureLife = (maxRadius) => {
    fx8.clearPulses();
    fx8.pulse({ ox: 0, oy: 0, sign: 1, magnitude: SHOCK_MAG, maxRadius });
    let ticks = 0;
    while (fx8.pulsesActive() && ticks < 600) { fx8.update(GFI.DT); ticks++; }
    return ticks * GFI.DT;
  };

  const shortLife = measureLife(400);
  const longLife = measureLife(2600);
  const expectedShort = 400 / GFI.config.shock.speed;

  check('波在给定行程处结束', Math.abs(shortLife - expectedShort) < 0.05,
    `行程 400 → 存活 ${shortLife.toFixed(3)}s（理论 ${expectedShort.toFixed(3)}s）`);
  check('行程越短活得越短', shortLife < longLife,
    `400 → ${shortLife.toFixed(2)}s，2600 → ${longLife.toFixed(2)}s`);

  // 关键：两道波不该同时存在
  fx8.clearPulses();
  fx8.pulse({ ox: 0, oy: 0, sign: 1, magnitude: SHOCK_MAG, maxRadius: 2000 });
  check('发波后处于活跃', fx8.pulsesActive() === true);
  for (let i = 0; i < Math.ceil(2000 / GFI.config.shock.speed * 60) + 5; i++) fx8.update(GFI.DT);
  check('走完行程后自动结束（不占用脉冲池）', fx8.pulsesActive() === false);
})();

// ===========================================================================
section('9. 类型过滤（页面 / 标签 / 日记）');
// ===========================================================================
(function testKindFilter() {
  const demo = GFI.DataSource.demo(150, { seed: 5 });
  const D7 = GFI.Data.build(demo.nodes, demo.links, null);
  const sim7 = GFI.Physics.create(D7, GFI.config.physics);
  const fx7 = GFI.Effects.create(D7, sim7);
  const tl7 = GFI.Timeline.create(D7, sim7, fx7, {});

  const countKind = (k) => { let c = 0; for (let i = 0; i < D7.n; i++) if (D7.kind[i] === k) c++; return c; };
  const countVisKind = (k) => {
    let c = 0;
    for (let i = 0; i < D7.n; i++) if (D7.kind[i] === k && D7.wantVisible[i]) c++;
    return c;
  };

  const journals = countKind(2);
  const pages = countKind(0);
  check('数据里有日记节点', journals > 0, `${journals} 个`);
  check('数据里有页面节点', pages > 0, `${pages} 个`);

  tl7.setCutoff(tl7.range.max, { pulse: false, silent: true });
  check('默认全部可见', countVisKind(2) === journals && countVisKind(0) === pages);

  // 关掉日记
  tl7.setKindOn(2, false);
  for (let k = 0; k < 60; k++) fx7.update(GFI.DT);
  check('关闭日记后日记节点不可见', countVisKind(2) === 0, `${countVisKind(2)} 个残留`);
  check('关闭日记不影响页面节点', countVisKind(0) === pages, `${countVisKind(0)}/${pages}`);

  // 再打开
  tl7.setKindOn(2, true);
  for (let k = 0; k < 60; k++) fx7.update(GFI.DT);
  check('重新打开日记后恢复可见', countVisKind(2) === journals, `${countVisKind(2)}/${journals}`);

  // 三种全关
  tl7.setKindOn(0, false); tl7.setKindOn(1, false); tl7.setKindOn(2, false);
  for (let k = 0; k < 60; k++) fx7.update(GFI.DT);
  let anyWant = 0;
  for (let i = 0; i < D7.n; i++) if (D7.wantVisible[i]) anyWant++;
  // object/property 两类仍开着，所以不一定为 0；但被关掉的三类必须是 0
  check('三类全关后它们都不再可见',
    countVisKind(0) === 0 && countVisKind(1) === 0 && countVisKind(2) === 0,
    `剩余可见 ${anyWant} 个（应只有 object/property）`);
})();

// ===========================================================================
section('10. 特效空转剪枝 —— 计数器必须精确，隐藏的节点不许复活');
// ===========================================================================
// 这一节守两件事：
//   1. updatePops / updateFades 的 O(n) 全表扫描现在靠 popCount / fadeCount
//      早退。计数器一旦漂移（只增不减），早退就永远不生效 —— 性能优化静默失效，
//      而且没有任何报错。所以必须直接断言它归零。
//   2. pop 与 fade 会争抢 scaleMul / renderAlpha / simWeight。pop 的收尾分支
//      在节点已经淡出之后执行的话，会把 simWeight 推回 1 ——
//      于是出现一个【看不见却仍然留在模拟里】的节点：照样进 activeMask、
//      照样对邻居施力，永远不退场。
(function testEffectIdle() {
  const demo = GFI.DataSource.demo(80, { seed: 5 });
  const D8 = GFI.Data.build(demo.nodes, demo.links, null);
  const sim8 = GFI.Physics.create(D8, GFI.config.physics);
  const fx8 = GFI.Effects.create(D8, sim8);
  const DT8 = GFI.DT;

  // ---- 静止时 update() 必须是纯 no-op ----
  const s0 = D8.scaleMul[3], a0 = D8.renderAlpha[3], w0 = D8.simWeight[3];
  for (let k = 0; k < 30; k++) fx8.update(DT8);
  check('无激活特效时 update() 不改动任何状态',
    D8.scaleMul[3] === s0 && D8.renderAlpha[3] === a0 && D8.simWeight[3] === w0);
  check('空闲时计数器为 0', fx8.popCount === 0 && fx8.fadeCount === 0,
    `pop=${fx8.popCount} fade=${fx8.fadeCount}`);

  const steps = Math.ceil(GFI.config.pop.maxDuration * 60) + 8;

  // ---- 正常一轮：揭示 → 跑完 ----
  const i = 3;
  fx8.beginReveal(i, 0);
  check('reveal 后 popCount 为 1', fx8.popCount === 1, `popCount=${fx8.popCount}`);
  for (let k = 0; k < steps; k++) fx8.update(DT8);
  check('pop 结束后 popCount 精确归零', fx8.popCount === 0, `popCount=${fx8.popCount}`);
  check('pop 结束后节点完全可见',
    D8.visible[i] === 1 && D8.simWeight[i] === 1 && Math.abs(D8.scaleMul[i] - 1) < 1e-6,
    `visible=${D8.visible[i]} simWeight=${D8.simWeight[i]} scaleMul=${D8.scaleMul[i].toFixed(4)}`);

  // ---- 关键回归：pop 还没走完就隐藏 ----
  const j = 7;
  fx8.beginReveal(j, 0);
  fx8.update(DT8);                       // 让 pop 真正开始（popT 变成正数）
  fx8.beginHide(j);
  for (let k = 0; k < steps; k++) fx8.update(DT8);
  check('隐藏节点不会在 pop 收尾时被复活（权重必须留在 0）',
    D8.visible[j] === 0 && D8.simWeight[j] === 0 && D8.renderAlpha[j] === 0,
    `visible=${D8.visible[j]} simWeight=${D8.simWeight[j]} alpha=${D8.renderAlpha[j]}`);
  check('淡出 + pop 结束后两个计数器都归零',
    fx8.popCount === 0 && fx8.fadeCount === 0,
    `pop=${fx8.popCount} fade=${fx8.fadeCount}`);

  // ---- 同一个节点反复 reveal / hide（不是时间轴走的那条路，但状态机必须自洽）----
  const m = 11;
  fx8.beginReveal(m, 0);
  fx8.beginReveal(m, 0);                 // 重复 reveal 不能重复计数
  check('重复 reveal 不重复计数', fx8.popCount === 1, `popCount=${fx8.popCount}`);
  fx8.beginReveal(m, 0);
  fx8.beginHide(m);
  fx8.beginReveal(m, 0);                 // 清掉进行中的淡出，计数要还回去
  for (let k = 0; k < steps; k++) fx8.update(DT8);
  check('反复 reveal/hide 后计数器不漂移',
    fx8.popCount === 0 && fx8.fadeCount === 0,
    `pop=${fx8.popCount} fade=${fx8.fadeCount}`);

  // ---- 撤消淡出（cancelHide）时计数要还回去 ----
  const q = 13;
  fx8.beginHide(q);
  fx8.update(DT8);
  check('cancelHide 前 fadeCount 为 1', fx8.fadeCount === 1, `fadeCount=${fx8.fadeCount}`);
  fx8.cancelHide(q);
  check('cancelHide 后 fadeCount 归零', fx8.fadeCount === 0, `fadeCount=${fx8.fadeCount}`);
})();

// ===========================================================================
section('11. 主循环 handoff 门控 —— settle 不许把空闲停机钉死');
// ===========================================================================
// 复刻 main.js 子步循环里那两行（改动前 / 改动后）：
//     const awake = sim.isAwake();
//     if (awake) sim.tick(DT);
//     fx.update(DT);
//     if (awake) fx.applyHandoff(DT);     ← 改动前：模拟睡着时解析解永远不推进
//     fx.applyHandoff(DT);                ← 改动后
// main.js 需要 DOM、进不了本沙箱，但被门控的 sim / fx 是这里加载的真实代码，
// 而失败模式完全由这两行决定：settle 非空 ⇒ fx.anyActive() 恒真 ⇒ main.js 的
// busy 恒真 ⇒ 空闲停机（连续 30 帧无活动就 cancelAnimationFrame）永不触发。
(function testHandoffGating() {
  const buildIso = () => {
    const nodes = [
      { id: 'hub', label: 'hub', kind: 'page' },
      { id: 'a', label: 'a', kind: 'page' },
      { id: 'b', label: 'b', kind: 'page' },
      { id: 'iso', label: 'iso', kind: 'page' },   // 零度节点
    ];
    const links = [{ source: 'hub', target: 'a' }, { source: 'hub', target: 'b' }];
    const D = GFI.Data.build(nodes, links, null);
    const i = D.indexById.get('iso');
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);
    for (let k = 0; k < 900; k++) sim.tick(DT);   // 跑到沉降入睡（与 §2 同量级）
    // 网格最后一次重建时的节点位置 —— 之后 applyHandoff 会绕过模拟写坐标
    return { D, sim, fx, i, gridX: D.x[i], gridY: D.y[i] };
  };

  // 复刻 interaction.js 松手：deg===0 ⇒ 刻意不 reheat ⇒ 模拟全程睡着
  const release = (S, dx, dy) => {
    const { D, sim, fx, i } = S;
    const rx = D.x[i] + dx, ry = D.y[i] + dy;
    sim.pin(i, D.x[i], D.y[i]);
    sim.unpin(i);
    D.x[i] = rx; D.y[i] = ry;
    D.vx[i] = 600 * GFI.DT; D.vy[i] = 400 * GFI.DT;
    fx.startSettle(i, rx, ry, 600, 400, rx + 30, ry + 20, 0.5);
  };

  // 返回"第几帧进入空闲"（等价于 main.js 里 idleFrames 开始累加），-1 = 永远忙
  const runLoop = (S, guardWithAwake, maxFrames) => {
    const { sim, fx } = S;
    for (let f = 0; f < maxFrames; f++) {
      const awake = sim.isAwake();
      if (awake) sim.tick(DT);
      fx.update(DT);
      if (!guardWithAwake || awake) fx.applyHandoff(DT);
      if (!(sim.isAwake() || fx.anyActive())) return f + 1;
    }
    return -1;
  };

  const MAX = 600;   // 10s，远超 maxSettleTime=1.5s

  // ---- 改动前的门控：必须复现"永久空转" ----
  const before = buildIso();
  check('零度节点入睡后 alpha 低于 alphaMin', !before.sim.isAwake(),
    `alpha=${before.sim.alpha.toExponential(2)}`);
  release(before, 420, 300);
  check('零度节点松手不重热（这正是危险路径）', !before.sim.isAwake(),
    `alpha=${before.sim.alpha.toExponential(2)}`);
  check('松手后 settle 已激活', before.fx.settleActive === true);

  const stuck = runLoop(before, true, MAX);
  check('【回归】awake 守卫下 settle 永不结束 → 空闲停机被钉死',
    stuck === -1, stuck === -1 ? `${MAX} 帧后仍 busy` : `第 ${stuck} 帧就停了`);

  // ---- 改动后的门控：必须在 maxSettleTime 内收敛并放行停机 ----
  const after = buildIso();
  release(after, 420, 300);
  const idleAt = runLoop(after, false, MAX);
  check('handoff 无条件推进后 settle 自行结束', idleAt > 0,
    idleAt > 0 ? `第 ${idleAt} 帧（${(idleAt * DT).toFixed(2)}s）进入空闲` : '仍然卡死');
  check('结束后 settle 已清除', after.fx.settleActive === false);
  check('结束后 fx.anyActive() 为假 → 可以让循环停机', after.fx.anyActive() === false);
  check('结束后位置有限', Number.isFinite(after.D.x[after.i]) && Number.isFinite(after.D.y[after.i]));

  // ---- 网格刷新：睡着时 handoff 直接写坐标，网格必须跟上 ----
  // 不补 rebuildGrid 的话，被甩出的节点仍以【入睡时的网格位置】参与剔除，
  // 而剔除 / 命中测试都复用这张网格（renderer.cull / interaction.hitTest）——
  // 表现就是飞行中途凭空消失、并且点不中。
  const { D: D11, sim: sim11, i: i11 } = after;
  const buf = new Int32Array(64);
  const findSelf = () => {
    const c = sim11.grid.collectRadius(D11, D11.x[i11], D11.y[i11], 4, buf, D11.visible);
    for (let p = 0; p < c; p++) if (buf[p] === i11) return true;
    return false;
  };
  const cellOf = (v, min) => Math.floor((v - min) * sim11.grid.inv);
  const cellsMoved = Math.abs(cellOf(D11.x[i11], sim11.grid.minX) - cellOf(after.gridX, sim11.grid.minX))
    + Math.abs(cellOf(D11.y[i11], sim11.grid.minY) - cellOf(after.gridY, sim11.grid.minY));
  check('位移跨越了网格单元（陈旧网格必然漏掉它）', cellsMoved >= 1, `跨 ${cellsMoved} 格`);
  check('陈旧网格里查不到 → 会被剔除掉', !findSelf(),
    `最终位置 ${D11.x[i11].toFixed(0)},${D11.y[i11].toFixed(0)}`);
  sim11.rebuildGrid();
  check('rebuildGrid 之后能查到 → 剔除 / 命中测试恢复', findSelf() === true);
})();

// ===========================================================================
section('12. 拖拽手感的前提 —— reheat 必须瞬时，alphaTarget 必须渐进');
// ===========================================================================
// interaction.js 在 pointerdown 里【两个都要调】：
//   sim.reheat(dragStart)        → 立刻给足动能（手感的关键）
//   sim.setAlphaTarget(dragStart)→ 你【握着】的这段时间里维持活性
// 只调后者的话，alpha 要从 alphaMin 按 alphaDecay 指数爬升；而 alphaDecay 是
// 按 settleTicks=400 标定的 → 时间常数约 1 秒。抓起 hub 后邻域要一秒才活过来。
//
// 这条守的是【那个前提】本身（reheat 瞬时 / setAlphaTarget 渐进）。
// ⚠ 它守不住"interaction.js 里那一行有没有写" —— interaction 需要 DOM，
//   不在本沙箱的加载范围内。那条只能靠 Logseq 里实测。
(function testReheatSemantics() {
  const demo = GFI.DataSource.demo(120, { seed: 5 });
  const D = GFI.Data.build(demo.nodes, demo.links, null);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  const T = GFI.config.reheat.dragStart;

  for (let k = 0; k < 900; k++) sim.tick(DT);   // 沉降入睡
  check('基线：模拟已入睡', !sim.isAwake(), `alpha=${sim.alpha.toExponential(2)}`);

  // ---- reheat：瞬时生效，不经过任何 tick ----
  sim.reheat(T);
  check('reheat 立即把 alpha 抬到目标值', Math.abs(sim.alpha - T) < 1e-9,
    `alpha=${sim.alpha}（目标 ${T}）`);

  // ---- setAlphaTarget：渐进 ----
  sim.setAlphaTarget(0);
  for (let k = 0; k < 600; k++) sim.tick(DT);   // 重新衰减入睡
  check('复位后再次入睡', !sim.isAwake(), `alpha=${sim.alpha.toExponential(2)}`);

  sim.setAlphaTarget(T);
  sim.tick(DT);
  check('setAlphaTarget 一个 tick 内几乎没动（所以不能单独用来"抓起就活"）',
    sim.alpha < T * 0.05, `1 tick 后 alpha=${sim.alpha.toExponential(2)}（目标 ${T}）`);

  let halfAt = -1;
  for (let k = 2; k <= 900; k++) {
    sim.tick(DT);
    if (halfAt < 0 && sim.alpha >= T * 0.5) halfAt = k;
  }
  const decay = 1 - Math.pow(GFI.config.physics.alphaMin, 1 / GFI.config.physics.settleTicks);
  const theory = Math.log(2) / decay;
  check('爬到目标一半要几十个 tick —— 这就是"拽不动"的来源',
    halfAt > 30, `第 ${halfAt} 个 tick（${(halfAt * DT * 1000).toFixed(0)}ms），理论 ${theory.toFixed(0)} tick`);
})();

// ===========================================================================
// 结果
// ===========================================================================
console.log(`\n${'═'.repeat(60)}`);
if (fail === 0) {
  console.log(`\x1b[32m全部通过\x1b[0m  ${pass} 项`);
} else {
  console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 通过 ${pass} 项`);
  console.log('失败清单:');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
