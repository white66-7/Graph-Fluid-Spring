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

for (const f of ['ns', 'i18n', 'config', 'spatial', 'data', 'physics', 'effects', 'timeline', 'datasource', 'warm', 'livewatch']) {
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
  // ⚠ 本节验的是【弹簧】这条路径，必须显式钉死模式 —— 不能依赖 config 默认值
  //   （默认已改成 'obsidian' = 纯淡入，没有弹簧）。同 §14。
  const savedPopMode = GFI.config.pop.mode;
  GFI.config.pop.mode = 'spring';
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
  GFI.config.pop.mode = savedPopMode;
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
section('7. 拖拽 —— 局部弹簧增益让邻居跟随（setDragLinkBoost）');
// ===========================================================================
// 守的是 physics.js forceLink 里的 dragBoost：
//   lstr[e] = clamp(linkStrength / minDeg, 0.02, 0.5)，边刚度按两端较【低】度数
//   衰减，而被拖的恰恰是这个低度数节点 —— 不增益时邻居几乎不动，关联边被拉到
//   好几倍长（实测 test/drag-probe.js：拖 234wu 时撕裂 379%、松手瞬间被拖节点
//   离最近邻居 142wu，而基线只有 26.4、平衡边长 50）。
//
// ⚠ 断言全部用【相对量】：绝对数值随 linkDistance / nodeSize 等面板参数漂移，
//   钉死在具体数字上的话，用户调一下外观这些用例就会变红（踩过这个坑）。
(function testDragNeighbourFollow() {
  const build = () => {
    const demo = GFI.DataSource.demo(120, { seed: 3 });
    const D = GFI.Data.build(demo.nodes, demo.links, null);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    sim.lod = 0;
    for (let k = 0; k < 400; k++) sim.tick(DT);      // 先沉降
    return { D, sim };
  };

  // 复刻 interaction.js 的拖拽：每步 pin + tick（邻居是在帧间被弹簧拉动的，
  // 只连发 pin 不 tick 等于瞬移，测出来的数据全是假的）
  const drag = (S, boost) => {
    const { D, sim } = S;
    let i = -1;
    for (let k = 0; k < D.n; k++) if (D.deg[k] >= 2 && D.deg[k] <= 6) { i = k; break; }
    const hx = D.x[i], hy = D.y[i];
    const nbrs = [];
    for (let p = D.adjStart[i]; p < D.adjStart[i + 1]; p++) nbrs.push(D.adjList[p]);
    const n0 = nbrs.map((j) => [D.x[j], D.y[j]]);

    const globalTear = () => {
      let s = 0;
      for (let e = 0; e < D.m; e++) {
        const a = D.lsrc[e], b = D.ltgt[e];
        s += Math.abs(Math.hypot(D.x[b] - D.x[a], D.y[b] - D.y[a]) - D.ldist[e]) / D.ldist[e];
      }
      return D.m ? s / D.m : 0;
    };

    sim.pin(i, hx, hy);
    sim.setAlphaTarget(GFI.config.reheat.dragStart);
    if (boost) sim.setDragLinkBoost(i, GFI.config.drag.linkBoost);
    sim.reheat(GFI.config.reheat.dragStart);

    for (let k = 1; k <= 45; k++) {
      sim.pin(i, hx + 200 * k / 45, hy + 120 * k / 45);
      sim.tick(DT);
    }
    sim.setDragLinkBoost(-1, 1);

    let gap = Infinity;
    for (const j of nbrs) {
      const d = Math.hypot(D.x[j] - D.x[i], D.y[j] - D.y[i]);
      if (d < gap) gap = d;
    }
    let moved = 0;
    for (let q = 0; q < nbrs.length; q++) {
      moved += Math.hypot(D.x[nbrs[q]] - n0[q][0], D.y[nbrs[q]] - n0[q][1]);
    }
    return { gap, moved: moved / Math.max(1, nbrs.length), tear: globalTear() };
  };

  const dragDist = Math.hypot(200, 120);
  const A = drag(build(), false);
  const B = drag(build(), true);

  // 判据用【相对量】：绝对数值随 linkDistance / nodeSize 等面板参数漂移，
  // 钉死在具体数字上的话，用户调一下外观这些用例就会变红（踩过这个坑）。
  check('不增益时邻居跟不上 → 图被扯裂', A.gap > dragDist * 0.3,
    `最近邻居 ${A.gap.toFixed(0)}wu（拖距 ${dragDist.toFixed(0)}wu）`);
  check('增益后邻居明显跟得更紧', B.gap < A.gap * 0.85,
    `${A.gap.toFixed(0)} → ${B.gap.toFixed(0)} wu`);
  check('增益后邻居位移更大', B.moved > A.moved * 1.15,
    `${A.moved.toFixed(0)} → ${B.moved.toFixed(0)} wu`);
  check('增益没有把全局拉得更坏', B.tear <= A.tear * 1.2,
    `全局平均撕裂 ${(A.tear * 100).toFixed(0)}% → ${(B.tear * 100).toFixed(0)}%`);
  check('松手后坐标有限', Number.isFinite(B.gap) && Number.isFinite(B.moved));

  // ---- 局域性：增益【只能】改变被拖节点及其一环的受力 ----
  //
  // 这是 forceLink 里那个 be 倍率的准确契约，所以用【精确相等】而不是统计量来守：
  // 两次 build 是确定性的，跑同一 tick 时二环外节点的受力输入（位置）完全相同，
  // 而力是在 integrate 之前全部累加完的 → 它们的 vx/vy 必须一个 bit 都不差。
  // （位置不能这么比：forceCenter 会把【所有】节点按质心平移，而质心因为被拖
  //   那一点的位移略有不同 —— 那是全局平移，不是受力泄漏。）
  const S1 = build(), S2 = build();
  const D1 = S1.D, D2 = S2.D;
  let i1 = -1;
  for (let k = 0; k < D1.n; k++) if (D1.deg[k] >= 2 && D1.deg[k] <= 6) { i1 = k; break; }
  const hop1 = new Uint8Array(D1.n);
  for (let p = D1.adjStart[i1]; p < D1.adjStart[i1 + 1]; p++) hop1[D1.adjList[p]] = 1;

  S2.sim.setDragLinkBoost(i1, GFI.config.drag.linkBoost);
  S1.sim.tick(DT);
  S2.sim.tick(DT);

  let maxVelDelta = 0, checked = 0;
  for (let j = 0; j < D1.n; j++) {
    if (j === i1 || hop1[j] || D1.deg[j] === 0) continue;
    const d = Math.abs(D1.vx[j] - D2.vx[j]) + Math.abs(D1.vy[j] - D2.vy[j]);
    if (d > maxVelDelta) maxVelDelta = d;
    checked++;
  }
  check('增益严格局部：一环之外受力完全相同', maxVelDelta === 0,
    `最大速度偏差 ${maxVelDelta}（受检 ${checked} 个节点）`);

  // 反面：被拖节点自己必须【真的】被增益影响，否则上面那条会假通过
  const boostedDelta = Math.abs(D1.vx[i1] - D2.vx[i1]) + Math.abs(D1.vy[i1] - D2.vy[i1]);
  check('被拖节点自身受力确实变了（防止上一条假通过）', boostedDelta > 0,
    `速度偏差 ${boostedDelta.toExponential(3)}`);

  // ---- 撤销必须彻底：设了又立刻撤，结果应与从没设过完全一致 ----
  const S3 = build(), S4 = build();
  let i4 = -1;
  for (let k = 0; k < S4.D.n; k++) if (S4.D.deg[k] >= 2 && S4.D.deg[k] <= 6) { i4 = k; break; }
  S4.sim.setDragLinkBoost(i4, GFI.config.drag.linkBoost);
  S4.sim.setDragLinkBoost(-1, 1);
  S3.sim.tick(DT);
  S4.sim.tick(DT);
  let undoDelta = 0;
  for (let j = 0; j < S3.D.n; j++) {
    const d = Math.abs(S3.D.vx[j] - S4.D.vx[j]) + Math.abs(S3.D.vy[j] - S4.D.vy[j]);
    if (d > undoDelta) undoDelta = d;
  }
  check('setDragLinkBoost(-1, …) 撤销彻底（全表受力一致）', undoDelta === 0,
    `最大速度偏差 ${undoDelta}`);
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
  // 预算按【实际全程】算，别写死 —— 改「演变节奏」会让写死的帧数不够用
  const maxTicks = Math.ceil(tl6.playDurationSec * 60 * 1.6);
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
section('11. 拖拽沉睡期写坐标 —— 网格必须跟上，否则节点会被剔除掉');
// ===========================================================================
// 守的是 main.js 里那一行：
//     if (!P.sim.isAwake() && P.inter && P.inter.dragNode >= 0) P.sim.rebuildGrid();
//
// 拖拽是【唯一】在模拟睡眠状态下直接写节点坐标的路径：sim.pin() 是同步写 x/y 的，
// 而零度节点刻意不 reheat、也不抬 alphaTarget（见 interaction.js onPointerDown）
// → 模拟全程睡着 → chargeGrid 不会自己重建。而剔除（renderer.setGrid(sim.grid)）
// 与命中测试都复用这张网格 —— 不补 rebuildGrid 的话，被拖的节点会以【入睡时的
// 旧位置】参与剔除，拖出余量后就地消失、也点不中。
// main.js 需要 DOM、进不了本沙箱，但被它调用的 sim 是这里加载的真实代码。
(function testSleepDragGrid() {
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
    // 网格最后一次重建时的节点位置 —— 之后拖拽会绕过模拟直接写坐标
    return { D, sim, fx, i, gridX: D.x[i], gridY: D.y[i] };
  };

  const after = buildIso();
  check('零度节点入睡后 alpha 低于 alphaMin', !after.sim.isAwake(),
    `alpha=${after.sim.alpha.toExponential(2)}`);

  // 复刻 interaction.js 拖一个零度节点：pin 直接写坐标，且【不】唤醒模拟
  after.sim.pin(after.i, after.D.x[after.i] + 420, after.D.y[after.i] + 300);
  check('拖零度节点全程不唤醒模拟（这正是危险路径）', !after.sim.isAwake(),
    `alpha=${after.sim.alpha.toExponential(2)}`);
  check('拖拽不会让 fx 变成常驻活跃（空闲停机不被钉死）', after.fx.anyActive() === false);

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
section('13. 沉降后不得残留节点重叠');
// ===========================================================================
// 用户实测截图里出现过成对叠死的节点。根因是碰撞的 alpha 门控
// （a > 0.05 才跑），而 isolatedRing 不乘 alpha —— 尾段节点仍在动、碰撞停了，
// 重叠被冻结。解开门控后这条必须成立。
// 判据：交叠深度 > 10%（d < 0.9 × (ri+rj)）算失败；轻微软碰（碰撞正在
// 推开的瞬间）不算。
(function testNoOverlapAfterSettle() {
  // 复用 §2 已沉降 900 tick 的顶层 D
  let overlap = 0, worst = 0, worstPair = '';
  for (let i = 0; i < D.n; i++) {
    if (!D.visible[i] || D.simWeight[i] === 0) continue;
    for (let j = i + 1; j < D.n; j++) {
      if (!D.visible[j] || D.simWeight[j] === 0) continue;
      const dx = D.x[i] - D.x[j], dy = D.y[i] - D.y[j];
      const d2 = dx * dx + dy * dy;
      const rr = D.radius[i] + D.radius[j];
      if (d2 < rr * rr * 0.81) {
        overlap++;
        const pen = 1 - Math.sqrt(d2) / rr;
        if (pen > worst) { worst = pen; worstPair = D.label[i] + ' ↔ ' + D.label[j]; }
      }
    }
  }
  check('沉降后无 >10% 交叠的节点对', overlap === 0,
    `${overlap} 对，最深 ${(worst * 100).toFixed(0)}% ${worstPair}`);

  // 完全重合的对（d2 ≈ 0）也必须不存在 —— 那种对在旧代码里会被永久跳过
  let stacked = 0;
  for (let i = 0; i < D.n; i++) {
    if (!D.visible[i] || D.simWeight[i] === 0) continue;
    for (let j = i + 1; j < D.n; j++) {
      if (!D.visible[j] || D.simWeight[j] === 0) continue;
      const dx = D.x[i] - D.x[j], dy = D.y[i] - D.y[j];
      if (dx * dx + dy * dy < 1e-6) stacked++;
    }
  }
  check('无完全重合的节点对', stacked === 0, `${stacked} 对`);
})();

// ===========================================================================
section('14. 出生分槽 —— 同母体同帧兄弟必须角向错开（T1）');
// ===========================================================================
// 快进 / 拖滑块大步时，同一母体的多个子节点会在【同一帧】从母节点旁的 3px
// 出生点喷出。旧实现每个子节点各自「背离质心 + ±0.78rad 抖动」——方向可能
// 几乎重合，出生瞬间叠成一坨、靠碰撞逐帧顶开。现在按黄金角 137.5° 轮转分槽。
(function testBuddingSlots() {
  // ⚠ 出生喷射初速只在 spring 模式下存在（obsidian 模式不注入）→ 显式钉死
  const savedPopMode = GFI.config.pop.mode;
  GFI.config.pop.mode = 'spring';
  const T0 = Date.UTC(2024, 0, 1);
  const DAY = 86400000;
  const nodes = [
    { id: 'hub', label: 'hub', kind: 'page', createdAt: T0 },
    { id: 'l1', label: 'l1', kind: 'page', createdAt: T0 + DAY },
    { id: 'l2', label: 'l2', kind: 'page', createdAt: T0 + DAY },
    { id: 'l3', label: 'l3', kind: 'page', createdAt: T0 + DAY },
    { id: 'l4', label: 'l4', kind: 'page', createdAt: T0 + DAY },
  ];
  const links = [
    { source: 'hub', target: 'l1' }, { source: 'hub', target: 'l2' },
    { source: 'hub', target: 'l3' }, { source: 'hub', target: 'l4' },
  ];
  const D8 = GFI.Data.build(nodes, links, null);
  const sim8 = GFI.Physics.create(D8, GFI.config.physics);
  const fx8 = GFI.Effects.create(D8, sim8);
  const tl8 = GFI.Timeline.create(D8, sim8, fx8, {});

  tl8.setCutoff(T0, { pulse: false });
  // ⚠ 必须让淡出跑完（fx.update）—— visible 是 fade 走完才置 0。少了这一步，
  //   第二次 setCutoff 会走「撤销淡出」分支而不是「揭示」，出生分槽根本不参与，
  //   测到的"速度"只是余波（第一版探针实测 1.5~2.4，而喷射初速是 ~22）。
  for (let k = 0; k < 60; k++) { sim8.tick(GFI.DT); fx8.update(GFI.DT); }

  const leaves = [];
  for (let i = 0; i < D8.n; i++) if (D8.deg[i] === 1) leaves.push(i);
  check('前提：图谱 = 1 hub + 4 叶子', leaves.length === 4, `${leaves.length} 片叶子`);
  let hiddenLeaves = 0;
  for (const i of leaves) if (D8.visible[i] === 0) hiddenLeaves++;
  check('前提：4 片叶子已完全隐藏（淡出走完）', hiddenLeaves === 4, `${hiddenLeaves}/4`);

  // 叶子同帧揭示 —— 此刻速度就是出生喷射方向（kickSpeed 沿 dirX/dirY）
  tl8.setCutoff(T0 + DAY, { pulse: false });
  let kicked = 0;
  for (const i of leaves) if (Math.hypot(D8.vx[i], D8.vy[i]) > 10) kicked++;
  check('4 片叶子同帧全部获得喷射初速（|v| ≈ 22）', kicked === 4, `${kicked}/4`);

  let minSep = Infinity;
  for (let a = 0; a < leaves.length; a++) {
    for (let b = a + 1; b < leaves.length; b++) {
      const ia = leaves[a], ib = leaves[b];
      const la = Math.hypot(D8.vx[ia], D8.vy[ia]) || 1;
      const lb = Math.hypot(D8.vx[ib], D8.vy[ib]) || 1;
      let dot = (D8.vx[ia] * D8.vx[ib] + D8.vy[ia] * D8.vy[ib]) / (la * lb);
      if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
      const sep = Math.acos(dot);
      if (sep < minSep) minSep = sep;
    }
  }
  // 黄金角轮转下 4 兄弟的理论最小夹角 ≈ 0.92 rad；任意子数下界都 ≥ 0.5
  check('同父兄弟出生方向最小夹角 ≥ 0.5 rad', minSep >= 0.5,
    `最小夹角 ${minSep.toFixed(3)} rad`);

  // 方向错开 → 第一 tick 就散开（碰撞根本不用介入）
  sim8.tick(GFI.DT);
  let minDist = Infinity;
  for (let a = 0; a < leaves.length; a++) {
    for (let b = a + 1; b < leaves.length; b++) {
      const ia = leaves[a], ib = leaves[b];
      const d = Math.hypot(D8.x[ia] - D8.x[ib], D8.y[ia] - D8.y[ib]);
      if (d < minDist) minDist = d;
    }
  }
  check('出生 1 tick 后兄弟最近间距 > 10 wu', minDist > 10,
    `最近间距 ${minDist.toFixed(1)} wu（出生点相距仅 3px）`);

  GFI.config.pop.mode = savedPopMode;
})();

// ===========================================================================
section('15. 幽灵脉冲门控 —— magnitude=0 时时间轴不许白白重热（T2）');
// ===========================================================================
// 旧代码：maybePulse 无条件 sim.reheat(cfg.reheat.pulse=0.5)，而 fx.pulse 在
// shock.magnitude=0（默认）时早就 return 了 —— 波没发出去，图却被重热得比
// reheat.timelinePlay(0.32) 还狠，播放期间每 pulseThrottleMs 白翻腾一次。
(function testGhostPulse() {
  const T0 = Date.UTC(2024, 0, 1);
  const DAY = 86400000;
  const nodes = [
    { id: 'hub', label: 'hub', kind: 'page', createdAt: T0 },
    { id: 'a1', label: 'a1', kind: 'page', createdAt: T0 + DAY },
    { id: 'a2', label: 'a2', kind: 'page', createdAt: T0 + DAY },
    { id: 'a3', label: 'a3', kind: 'page', createdAt: T0 + DAY },
    { id: 'b1', label: 'b1', kind: 'page', createdAt: T0 + 2 * DAY },
    { id: 'b2', label: 'b2', kind: 'page', createdAt: T0 + 2 * DAY },
    { id: 'b3', label: 'b3', kind: 'page', createdAt: T0 + 2 * DAY },
  ];
  const links = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map((t) => ({ source: 'hub', target: t }));
  const D9 = GFI.Data.build(nodes, links, null);
  const sim9 = GFI.Physics.create(D9, GFI.config.physics);
  const fx9 = GFI.Effects.create(D9, sim9);
  const tl9 = GFI.Timeline.create(D9, sim9, fx9, {});

  const savedMag = GFI.config.shock.magnitude;
  const VH = 10000;                       // 视口世界高度给足，避免 maxDisplacementRatio 钳幅

  try {
    // ---- 阶段 1：magnitude = 0（默认）----
    GFI.config.shock.magnitude = 0;
    tl9.setCutoff(T0, { pulse: false });
    // ⚠ 两个前提缺一不可：① 淡出必须跑完（fx.update），否则下一批叶子还在
    //   visible=1，第二次 setCutoff 走 cancelHide 而不是揭示；② 新建模拟的
    //   alpha 从 1 起步，自然衰减的尾巴（~0.6）会把「有没有幽灵重热」糊掉。
    for (let k = 0; k < 60; k++) { sim9.tick(GFI.DT); fx9.update(GFI.DT); }
    sim9.alpha = GFI.config.physics.alphaMin;

    tl9.setCutoff(T0 + DAY, { pulse: true, playing: true, viewportWorldHeight: VH });
    check('mag=0：揭示只按 timelinePlay 重热（无 0.5 幽灵）',
      sim9.alpha <= GFI.config.reheat.timelinePlay + 1e-6,
      `alpha=${sim9.alpha.toFixed(3)}（timelinePlay=${GFI.config.reheat.timelinePlay}，pulse=${GFI.config.reheat.pulse}）`);
    check('mag=0：波池仍为空', !fx9.pulsesActive());

    // ---- 阶段 2：mag > 0 → 脉冲必须真的发射并重热 ----
    GFI.config.shock.magnitude = 200;
    sim9.alpha = 0.001;
    tl9.setCutoff(T0 + 2 * DAY, { pulse: true, playing: true, viewportWorldHeight: VH });
    check('mag>0：脉冲真的发射（波池非空）', fx9.pulsesActive());
    check('mag>0：重热到 reheat.pulse',
      sim9.alpha >= GFI.config.reheat.pulse - 1e-6,
      `alpha=${sim9.alpha.toFixed(3)}`);
  } finally {
    GFI.config.shock.magnitude = savedMag;
  }
})();

// ===========================================================================
section('16. 活跃列表不变量（T3）—— 计数 = 列表长度，跑完必归零');
// ===========================================================================
// updatePops/updateFades 改成活跃索引列表后，「列表里每个 i 的 T 必须是数字」
// 是硬不变量：任何把 T 置回 NaN 的路径（自然结束 / cancelHide / 被隐藏打断）
// 都必须同步摘除，否则列表会残留幽灵项，popCount 与实际状态脱钩。
(function testActiveLists() {
  const demo = GFI.DataSource.demo(80, { seed: 21 });
  const D10 = GFI.Data.build(demo.nodes, demo.links, null);
  const sim10 = GFI.Physics.create(D10, GFI.config.physics);
  const fx10 = GFI.Effects.create(D10, sim10);
  const tl10 = GFI.Timeline.create(D10, sim10, fx10, {});

  // ---- 揭示：pop 列表非空 → 跑完归零 ----
  tl10.setCutoff(tl10.range.min, { pulse: false });
  for (let k = 0; k < 60; k++) fx10.update(GFI.DT);
  tl10.setCutoff(tl10.range.max, { pulse: false });
  check('揭示后 popCount > 0', fx10.popCount > 0, `${fx10.popCount} 个 pop 在跑`);

  // ---- 列表自检（跑动中做才有意义）：popT 为数字的节点数 === 列表长度 ----
  let livePops = 0;
  for (let i = 0; i < D10.n; i++) {
    const t = D10.popT[i];
    if (t === t) livePops++;
  }
  check('列表长度与 popT 实况一致', livePops === fx10.popCount,
    `popT 为数字 ${livePops} / popCount ${fx10.popCount}`);

  for (let k = 0; k < 90; k++) fx10.update(GFI.DT);
  check('pop 跑完后归零', fx10.popCount === 0, `popCount=${fx10.popCount}`);
  check('pop 期间没有 fade 混入', fx10.fadeCount === 0, `fadeCount=${fx10.fadeCount}`);

  // ---- 隐藏：fade 列表非空 → 跑完归零 ----
  tl10.setCutoff(tl10.range.min, { pulse: false });
  check('隐藏后 fadeCount > 0', fx10.fadeCount > 0, `${fx10.fadeCount} 个 fade 在跑`);
  for (let k = 0; k < 60; k++) fx10.update(GFI.DT);
  check('fade 跑完后归零', fx10.fadeCount === 0, `fadeCount=${fx10.fadeCount}`);

  // ---- 撤销淡出（cancelHide）：必须从 fade 列表摘除 ----
  tl10.setCutoff(tl10.range.max, { pulse: false });   // 全部可见
  for (let k = 0; k < 90; k++) fx10.update(GFI.DT);
  tl10.setCutoff(tl10.range.min, { pulse: false });   // 开始淡出
  const midFade = fx10.fadeCount;
  tl10.setCutoff(tl10.range.max, { pulse: false });   // 淡出中途撤销
  check('撤销淡出后 fadeCount 归零（列表已摘除）', fx10.fadeCount === 0,
    `中途 ${midFade} → ${fx10.fadeCount}`);
  for (let k = 0; k < 60; k++) fx10.update(GFI.DT);
  let stillFading = 0;
  for (let i = 0; i < D10.n; i++) if (D10.fadeT[i] === D10.fadeT[i]) stillFading++;
  check('撤销后无残留淡出状态', stillFading === 0 && fx10.fadeCount === 0,
    `fadeT 残留 ${stillFading} / fadeCount ${fx10.fadeCount}`);
  check('特效全静后 anyActive 为假', !fx10.anyActive());
})();

// ===========================================================================
section('17. 被固定节点的斥力对称性 —— 守卫不能写在配对的外层循环上');
// ===========================================================================
// 回归一个真实 bug：forceManyBody 的外层循环曾写成
//     if (!activeMask[i] || pinMode[i] === PIN_HARD) continue;
// 而内层是 `if (j <= i) continue;` —— 每对只算一次、对称施加，即外层 i 负责的是
// 它和【更高序号】邻居之间那一对。于是 i 被固定时整对 (i, j>i) 被一起跳掉，
// 两个方向的力同时消失：被固定的节点对【高序号】邻居完全「斥力隐身」，
// 对低序号邻居却正常（那一对由低序号方作外层索引时被处理）—— 序号相关的非对称。
// 表现是右键固定一个节点后，序号比它大的邻居会慢慢往它身上挤。
//
// 这与 §3 里零度节点那条是【同一类错误】：守卫写在外层循环上，就会连带抹掉
// 成对的相互作用。被固定的节点不需要【接收】力，但必须照常【施加】力。
//
// 判据用【精确相等】：两次 build 是确定性的；跑 one tick 时所有力都在 integrate
// 之前、按【同一批位置】算完 —— 所以把 P 钉住绝不能改变 P 施加给别人的力，
// 除 P 自己以外每个节点的 vx/vy 必须一个 bit 都不差。
(function testPinChargeSymmetry() {
  const build = () => {
    const demo = GFI.DataSource.demo(200, { seed: 11 });
    const D = GFI.Data.build(demo.nodes, demo.links, null);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    sim.lod = 0;
    for (let k = 0; k < 300; k++) sim.tick(DT);
    return { D, sim };
  };

  // 挑一个【同时有低序号和高序号邻居】的节点，否则下面两条断言会因样本为空假通过
  const pick = (D) => {
    for (let i = D.n - 1; i >= 0; i--) {
      if (D.deg[i] < 2) continue;
      let lo = 0, hi = 0;
      for (let p = D.adjStart[i]; p < D.adjStart[i + 1]; p++) {
        if (D.adjList[p] < i) lo++; else hi++;
      }
      if (lo > 0 && hi > 0) return i;
    }
    return -1;
  };

  const A = build(), B = build();
  const P = pick(A.D);
  check('被测节点同时有低序号与高序号邻居', P >= 0, `index=${P}`);

  A.sim.pin(P, A.D.x[P], A.D.y[P]);
  A.sim.tick(DT);
  B.sim.tick(DT);          // B 里 P 没被固定，位置完全一致

  let maxLo = 0, maxHi = 0, loN = 0, hiN = 0;
  for (let p = A.D.adjStart[P]; p < A.D.adjStart[P + 1]; p++) {
    const j = A.D.adjList[p];
    const d = Math.abs(A.D.vx[j] - B.D.vx[j]) + Math.abs(A.D.vy[j] - B.D.vy[j]);
    if (j < P) { loN++; if (d > maxLo) maxLo = d; } else { hiN++; if (d > maxHi) maxHi = d; }
  }
  check('高序号邻居照常被推开（原来的 bug 就在这里）', maxHi === 0,
    `${hiN} 个高序号邻居，最大速度偏差 ${maxHi}`);
  check('低序号邻居照常被推开（原来就正常，防回退）', maxLo === 0,
    `${loN} 个低序号邻居，最大速度偏差 ${maxLo}`);

  // 全表逐位比对 —— 顺带覆盖不在 P 邻域内的节点
  let maxAll = 0;
  for (let j = 0; j < A.D.n; j++) {
    if (j === P) continue;                       // P 自己本来就不该动
    const d = Math.abs(A.D.vx[j] - B.D.vx[j]) + Math.abs(A.D.vy[j] - B.D.vy[j]);
    if (d > maxAll) maxAll = d;
  }
  check('固定某节点不改变其余任何节点的受力（全表）', maxAll === 0, `最大速度偏差 ${maxAll}`);

  // 反面：被固定的 P 自己必须【不受力】（applyPins 已把它的速度清零）
  check('被固定的节点自身不被积分', A.D.vx[P] === 0 && A.D.vy[P] === 0,
    `v=(${A.D.vx[P]}, ${A.D.vy[P]})`);
})();

// ===========================================================================
section('18. 时间线节奏 —— 按秩推进 + 每帧揭示额度');
// ===========================================================================
(function testPacing() {
  // ⚠ 本节的判据全部是【节奏】本身，与用户可调的 config 默认值无关 ——
  //   所以下面显式钉死所需的那几项，跑完再还原（别让本节污染后续 / 依赖默认值）。
  const T = GFI.config.timeline;
  const saved = { rate: T.revealRate, burst: T.burstSmoothing };
  T.revealRate = 40;          // 用户可调 → 本节显式钉死（1200 个节点 ⇒ 30 秒）
  T.burstSmoothing = true;

  function rng(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DAY = 86400000, NOW = Date.UTC(2026, 9, 7), SPAN = 900 * DAY;

  // 造图。shape:
  //   'uniform' —— 900 天均匀铺开（稳态）
  //   'import'  —— 60% 挤在导入当天（时间戳各不相同，扎堆）
  //   'instant' —— 60% 共享【同一毫秒】（按秩也救不了，只能靠揭示额度）
  function makeGraph(N, shape, seed) {
    const demo = GFI.DataSource.demo(N, { seed, clusters: Math.max(3, Math.round(Math.sqrt(N) / 2)) });
    const rnd = rng(seed + 991);
    const t0 = NOW - SPAN;
    demo.nodes.forEach((nd, i) => {
      if (shape === 'uniform') nd.createdAt = t0 + (SPAN * i) / Math.max(1, N - 1);
      else if (shape === 'instant') nd.createdAt = rnd() < 0.6 ? t0 : t0 + DAY + rnd() * (SPAN - DAY);
      else nd.createdAt = rnd() < 0.6 ? t0 + rnd() * DAY : t0 + DAY + rnd() * (SPAN - DAY);
    });
    return GFI.Data.build(demo.nodes, demo.links, null);
  }

  // 播放到底，返回逐帧揭示数
  function play(D) {
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);
    let hit = 0;
    const tl = GFI.Timeline.create(D, sim, fx, { onChange(e) { hit += e.revealed; } });
    const out = { tl, frames: [], seconds: 0, peak: 0, total: 0 };
    if (!tl.range) return out;

    tl.setPlaying(true);           // 真实入口：会先「倒带」回空白（见 G 节）
    hit = 0;

    let clock = 0, guard = 0;
    while (tl.playing && guard++ < 60 * 1200) {
      hit = 0;
      tl.update(DT, 800);
      out.frames.push(hit);
      out.total += hit;
      if (hit > out.peak) out.peak = hit;
      clock += DT;
    }
    out.seconds = clock;
    let pending = 0;
    for (let i = 0; i < D.n; i++) if (D.wantVisible[i] && !D.visible[i]) pending++;
    out.pending = pending;
    return out;
  }

  // ---- A. 扎堆（时间戳各不相同）—— 靠「按秩推进」本身就摊平了 -------------
  //   旧实现按毫秒等速推进，会在一帧里跨过整个导入日 ⇒ 一帧放出 700+ 个
  //   （见 test/timeline-pacing-probe.js 的旧/新对照表）。
  const DI = makeGraph(1200, 'import', 7);
  const ri = play(DI);
  check('前提：大簇确实存在（60% 挤在导入当天）',
    ri.tl.rate > 0 && ri.tl.pacedCount > 1000, `paced=${ri.tl.pacedCount} rate=${ri.tl.rate.toFixed(1)}/s`);

  const perFrameSupply = ri.tl.rate * DT;
  check('扎堆的大簇被摊平，没有一帧炸开',
    ri.peak <= Math.max(3, Math.ceil(perFrameSupply * 3)),
    `峰值 ${ri.peak} 个/帧（稳态供给 ${perFrameSupply.toFixed(2)}/帧）`);
  check('摊平之后一个节点都没丢',
    ri.pending === 0 && ri.total === ri.tl.pacedCount,
    `揭示 ${ri.total}/${ri.tl.pacedCount}，结束时残留 ${ri.pending}`);

  // ---- B. 完全相同的时间戳 —— 只能靠逐帧揭示额度，按秩救不了 ---------------
  //   ⚠ 这是「两个机制都必须有」的证据：同一批节点共享同一毫秒时，
  //     cutoff = sortedTs[k] 一步就把整簇置 want=1，rank 再怎么细分也没用。
  function playInstant(burst) {
    T.burstSmoothing = burst;
    return play(makeGraph(1200, 'instant', 7));
  }
  const burstOff = playInstant(false);
  const burstOn = playInstant(true);
  T.burstSmoothing = true;
  check('对照：同一毫秒的大簇，关掉额度确实一帧炸开（额度有牙齿）',
    burstOff.peak > 200, `关额度峰值 ${burstOff.peak} 个/帧`);
  check('同一毫秒的大簇被额度摊开',
    burstOn.peak <= Math.max(3, Math.ceil(perFrameSupply * 3)),
    `开额度峰值 ${burstOn.peak} 个/帧`);
  check('额度摊开之后同样一个节点都没丢',
    burstOn.pending === 0 && burstOn.total === burstOn.tl.pacedCount,
    `揭示 ${burstOn.total}/${burstOn.tl.pacedCount}，结束时残留 ${burstOn.pending}`);

  // ---- C. 稳态下额度从不触发 —— 均匀分布不该被拖慢 -------------------------
  const on = play(makeGraph(600, 'uniform', 11));
  T.burstSmoothing = false;
  const off = play(makeGraph(600, 'uniform', 11));
  T.burstSmoothing = true;
  const skew = Math.abs(on.seconds - off.seconds) / Math.max(1e-6, off.seconds);
  check('均匀分布下平滑不引入额外时长（额度从不触发）', skew < 0.02,
    `开 ${on.seconds.toFixed(2)}s / 关 ${off.seconds.toFixed(2)}s，差 ${(skew * 100).toFixed(2)}%`);

  // ---- D. 全程时长由节点数反推，并被速率上下限钳制 -------------------------
  // 只验 create 期算出来的数，不跑播放（几千帧物理太贵）
  function durationOf(N, rate) {
    const keep = T.revealRate;
    if (rate !== undefined) T.revealRate = rate;
    const D = makeGraph(N, 'uniform', 3);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);
    const tl = GFI.Timeline.create(D, sim, fx, {});
    T.revealRate = keep;
    return tl;
  }

  const r60 = durationOf(600, 60);
  check('速率 60/秒 × 600 个节点 ⇒ 正好 10 秒（时长是算出来的）',
    Math.abs(r60.rate - 60) < 1e-9 && Math.abs(r60.playDurationSec - 10) < 1e-9,
    `rate=${r60.rate}/s 全程 ${r60.playDurationSec.toFixed(2)}s`);

  // ⚠⚠ 回归守卫。曾经是「设总时长 → 反推速率 → 再用 revealRateMin=2.5 钳速率」，
  //   结果用户把时长调到 60 / 120 秒【全都不生效】，实际永远卡在 32 秒 ——
  //   一个自动护栏把用户的显式设置顶掉了。现在速率是唯一旋钮，谁都不许覆盖它。
  const slow = durationOf(81, 0.5);
  check('速率 0.5/秒 × 81 个节点 ⇒ 正好 162 秒（想调慢就一定调得下去）',
    Math.abs(slow.rate - 0.5) < 1e-9 && Math.abs(slow.playDurationSec - 162) < 1e-9,
    `rate=${slow.rate}/s 全程 ${slow.playDurationSec.toFixed(1)}s`);
  const slower = durationOf(81, 0.2);
  check('再慢到 0.2/秒也没人顶它（全程 405 秒）',
    Math.abs(slower.playDurationSec - 405) < 1e-9, `全程 ${slower.playDurationSec.toFixed(0)}s`);

  // 0 = 自动套用 Obsidian 的原公式（实测 app.js：progressionSpeed）
  const auto = durationOf(100, 0);
  check('速率设成 0 ⇒ 自动套用 Obsidian 公式 clamp(0.5·√边数, 5, 100)',
    auto.rateAuto === true && auto.rate >= 5 && auto.rate <= 100,
    `rate=${auto.rate.toFixed(2)}/s 全程 ${auto.playDurationSec.toFixed(1)}s（rateAuto=${auto.rateAuto}）`);

  const bad = durationOf(100, -5);
  check('速率设成负数 ⇒ 钳到 0.05 下限，不除零、不倒流',
    bad.rateAuto === false && bad.rate === 0.05 && Number.isFinite(bad.playDurationSec),
    `rate=${bad.rate}/s 全程 ${bad.playDurationSec}s`);

  // ---- E. 拖滑块必须即时，不能被额度挡住 -----------------------------------
  const DS = makeGraph(400, 'import', 5);
  const simS = GFI.Physics.create(DS, GFI.config.physics);
  const fxS = GFI.Effects.create(DS, simS);
  const tlS = GFI.Timeline.create(DS, simS, fxS, {});
  tlS.setCutoff(tlS.range.min, { silent: true, pulse: false });
  tlS.setSliderValue(tlS.range.duration, {});          // 一次调用拖到最右
  let visNow = 0;
  for (let i = 0; i < DS.n; i++) if (DS.wantVisible[i]) visNow++;
  check('拖滑块一次到位（额度只作用于播放路径）', visNow === tlS.pacedCount,
    `一次 setSliderValue 后 ${visNow}/${tlS.pacedCount} 可见`);

  // 游标同步：拖回最左，rank 必须跟着回到「range.min 之前」
  tlS.setSliderValue(0, {});
  check('拖回起点后秩游标同步归零（否则下一次播会凭空跳过一段）',
    tlS.rank <= 1, `rank=${tlS.rank}`);

  // 游标初值必须与 cutoff 初值（range.max，全可见）一致 ——
  // 否则「不拖滑块、直接从中间按播放」会从 rank 0 起跳，时间轴重放一段。
  const DM = makeGraph(300, 'uniform', 9);
  const simM = GFI.Physics.create(DM, GFI.config.physics);
  const fxM = GFI.Effects.create(DM, simM);
  const tlM = GFI.Timeline.create(DM, simM, fxM, {});
  check('create 后游标初值与「全可见」一致（不是字面量里的 0）',
    tlM.rank === tlM.pacedCount, `rank=${tlM.rank} pacedCount=${tlM.pacedCount}`);
  tlM.setSliderValue(tlM.range.duration * 0.5, {});
  check('拖到中段后游标随之落到中段（不是从头开始）',
    Math.abs(tlM.rank / tlM.pacedCount - 0.5) < 0.05,
    `rank=${tlM.rank}/${tlM.pacedCount} = ${(tlM.rank / tlM.pacedCount * 100).toFixed(1)}%`);

  // ---- G. 倒带必须一帧清空（instantHide）----------------------------------
  //   beginHide 是【动画】，节点要 0.26s 才真的 visible=0。若倒带走淡出，
  //   这 0.26s 里所有节点仍是 visible=1，下一帧揭示会整簇命中 cancelHide
  //   分支 —— 于是逐帧揭示额度被整个绕过（实测 1200 节点里一帧放回 704 个）。
  const DR = makeGraph(1200, 'instant', 7);
  const simR = GFI.Physics.create(DR, GFI.config.physics);
  const fxR = GFI.Effects.create(DR, simR);
  const tlR = GFI.Timeline.create(DR, simR, fxR, {});
  let visBefore = 0;
  for (let i = 0; i < DR.n; i++) if (DR.visible[i]) visBefore++;
  tlR.setPlaying(true);                       // 起点在末端 ⇒ 触发倒带
  let visAfter = 0;
  for (let i = 0; i < DR.n; i++) if (DR.visible[i]) visAfter++;
  check('前提：倒带前整张图确实都是可见的', visBefore === DR.n, `${visBefore}/${DR.n}`);
  check('倒带一帧清空（不是 0.26s 的淡出）', visAfter === 0,
    `倒带后仍可见 ${visAfter} 个`);
  check('倒带后没有残留的淡出列表（否则会继续淡出并抢 reveal 路径）',
    fxR.fadeCount === 0 && fxR.popCount === 0,
    `fadeCount=${fxR.fadeCount} popCount=${fxR.popCount}`);

  // ---- H. 设置接线：界面上那个「演变节奏」真的能走到 config -----------------
  //   ⚠ 键名写错、校验器漏写、pick() 忘了加 —— 任何一种都会让设置项【静默失效】：
  //     界面能改、存档能存、config 纹丝不动。上一轮翻车正是这个形态
  //     （用户把时长调到 60 秒没反应）。所以这里从 syncSettings 入口正着测。
  (function testSettingWiring() {
    const snap = JSON.parse(JSON.stringify(GFI.config));
    // ⚠ 必须【原地】还原，不能 GFI.config[k] = snap[k] 整体替换 ——
    //   本文件顶部有 `const T = GFI.config.timeline` 这样的长期引用，
    //   一替换对象身份，后续所有 T.xxx = ... 都会写进孤儿对象、静默失效。
    //   （踩过：块 I / J 的 revealRate 因此没生效，跑的还是 40/秒。）
    const restore = () => {
      for (const k of Object.keys(snap)) {
        const cur = GFI.config[k], ref = snap[k];
        if (cur && typeof cur === 'object' && !Array.isArray(cur) && ref && typeof ref === 'object') {
          for (const kk of Object.keys(cur)) delete cur[kk];
          Object.assign(cur, ref);
        } else {
          GFI.config[k] = ref;
        }
      }
    };
    const DEFR = GFI.configDefaults.timeline.revealRate;

    // 旧存档：只有 timelapseDuration，没有 timelapseRate
    GFI.syncSettings({ __cfg: GFI.CFG_VERSION, timelapseDuration: 60 });
    check('旧存档（只有 timelapseDuration）⇒ 新键取默认值，不是 undefined/NaN',
      T.revealRate === DEFR, `revealRate=${T.revealRate}（默认 ${DEFR}）`);

    GFI.syncSettings({ __cfg: GFI.CFG_VERSION, timelapseRate: 0.5 });
    check('设置里把「演变节奏」改成 0.5 ⇒ 真的进到 config',
      T.revealRate === 0.5, `revealRate=${T.revealRate}`);

    GFI.syncSettings({ __cfg: GFI.CFG_VERSION, timelapseRate: 9999 });
    check('超出合法区间 ⇒ 回落默认值（不是静默按 9999 生效）',
      T.revealRate === DEFR, `revealRate=${T.revealRate}`);

    restore();
  })();

  // ---- I. Obsidian 出生缓动（pop.mode = 'obsidian'）----------------------
  //   实测来源：Obsidian app.asar!/app.js
  //     uZ(e,t,n){ n??=0.9; return e*n+t*(1-n) }   节点 render(): fadeAlpha = uZ(fadeAlpha, 1)
  //   判据钉在【两件可证伪的事】上：
  //     ① 渲染：scaleMul 恒为 1（Obsidian 节点出现不做缩放），alpha 按 ×0.9+0.1 走
  //     ② 物理：新节点不被注入初速，母节点不被反冲
  (function testObsidianEasing() {
    const keepMode = GFI.config.pop.mode;
    const keepRate = T.revealRate;
    GFI.config.pop.mode = 'obsidian';

    const D = makeGraph(200, 'uniform', 17);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);

    // ① 渲染曲线：直接对着公式验，不靠肉眼
    fx.beginReveal(7, 0);
    check('缓动起点是 alpha=0、scale=1（不是弹簧的 1.0 起始缩放）',
      D.renderAlpha[7] === 0 && D.scaleMul[7] === 1,
      `alpha=${D.renderAlpha[7]} scaleMul=${D.scaleMul[7]}`);
    fx.update(DT);
    check('一帧后 alpha = 0.1（×0.9 + 0.1，照抄 Obsidian 的 uZ 默认系数）',
      Math.abs(D.renderAlpha[7] - 0.1) < 1e-6, `alpha=${D.renderAlpha[7].toFixed(4)}`);
    fx.update(DT);
    check('两帧后 alpha = 0.19', Math.abs(D.renderAlpha[7] - 0.19) < 1e-5,
      `alpha=${D.renderAlpha[7].toFixed(4)}`);

    let maxScale = 1, frames = 2;
    while (D.popT[7] === D.popT[7] && frames < 400) {   // 跑到缓动收尾
      fx.update(DT); frames++;
      if (D.scaleMul[7] > maxScale) maxScale = D.scaleMul[7];
    }
    check('整个出生过程 scaleMul 恒为 1 —— 没有弹簧、没有过冲',
      Math.abs(maxScale - 1) < 1e-9, `峰值 scaleMul=${maxScale}`);
    check('缓动在 ~44 帧内收尾（0.9^n<0.01），不是永远挂着',
      frames <= 46 && D.renderAlpha[7] === 1, `${frames} 帧后 alpha=${D.renderAlpha[7]}`);
    check('收尾后从活跃列表摘除（不变量：计数 = 列表长度）',
      D.popT[7] !== D.popT[7], `popT=${D.popT[7]} popCount=${fx.popCount}`);

    // ② 物理：Obsidian 模式不许注入初速 / 后坐力
    const D2 = makeGraph(120, 'uniform', 19);
    const sim2 = GFI.Physics.create(D2, GFI.config.physics);
    const fx2 = GFI.Effects.create(D2, sim2);
    const tl2 = GFI.Timeline.create(D2, sim2, fx2, {});
    tl2.setPlaying(true);
    let hit = null;
    for (let k = 0; k < 60 * 400 && !hit; k++) {
      tl2.update(DT, 800);
      for (let i = 0; i < D2.n; i++) {
        if (D2.visible[i] && D2.popT[i] === 0) { hit = i; break; }   // 刚出生的
      }
    }
    check('前提：抓到了一个刚出生的节点', hit !== null, `index=${hit}`);
    if (hit !== null) {
      check('Obsidian 模式：新节点【没有】喷射初速（初速 0，不是 22）',
        D2.vx[hit] === 0 && D2.vy[hit] === 0,
        `v=(${D2.vx[hit].toFixed(3)}, ${D2.vy[hit].toFixed(3)})`);
    }

    GFI.config.pop.mode = keepMode;
    T.revealRate = keepRate;
  })();

  // ---- J. 节点出现 → 给其他节点的力（Obsidian 机制）-----------------------
  //   实测来源：app.js setData()
  //     · 落点 = 【已存在邻居位置均值】± (rand-.5)*F，F = 60·√I
  //     · 数据一变唯一动作：worker.postMessage({..., alpha:.3, run:true})
  //   本节验两件事：
  //     ① 落点必须贴着「可见邻居质心」（不是 spring 的「单个母体旁 3px」）
  //     ② 有节点出生的窗口，全场位移必须【远大于】没有出生的窗口
  //        ⚠ ② 必须做这个对照 —— 只看"出生窗口位移大"是假的，背景一直在动也会大
  (function testBirthForce() {
    const keepMode = GFI.config.pop.mode;
    const keepRate = T.revealRate;
    const keepPlay = GFI.config.reheat.timelinePlay;
    GFI.config.pop.mode = 'obsidian';
    // ⚠ 必须 1.0/秒：出生间隔 60 帧，30 帧窗才真的能采到「不在重热尾巴里」的对照窗。
    //   1.5/秒（间隔 40 帧）时上一发的 alpha 还有 0.15，两类窗口测出来一模一样（1.0×）。
    T.revealRate = 1;
    GFI.config.reheat.timelinePlay = 0.30;
    const LD = GFI.config.physics.linkDistance;

    const D = makeGraph(100, 'uniform', 29);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);
    let h = 0; while (sim.isAwake() && h++ < 60 * 120) sim.tick(DT);
    const tl = GFI.Timeline.create(D, sim, fx, {});
    tl.setPlaying(true);

    // ① 落点 vs 可见邻居质心：按【本帧新生数】算当帧的抖动上界，逐节点精确对账
    let worst = 0, worstBound = 0, anchorSamples = 0;
    // ② 窗口对照
    const bornW = [], quietW = [];
    const x0 = new Float64Array(D.n), y0 = new Float64Array(D.n);
    const watch = new Uint8Array(D.n);
    let g = 0, timer = 0, sawBirth = false;

    while (tl.playing && g++ < 60 * 400) {
      if (timer === 0) {
        for (let i = 0; i < D.n; i++) {
          x0[i] = D.x[i]; y0[i] = D.y[i];
          // ⚠ 必须把「本窗内才出生的节点」排除掉：它的落点是从种子位置瞬移过来的，
          //   位移几百 wu，会把邻居那几十 wu 完全盖住 —— 指标就退化成了在量瞬移。
          //   （踩过：不排除时，把重热压到 0.0001 这条断言照样通过。）
          watch[i] = (D.visible[i] && D.popT[i] !== D.popT[i]) ? 1 : 0;
        }
        sawBirth = false;
      }

      tl.update(DT, 800);

      // 本帧新生数（决定抖动半径 F = 0.12·linkDistance·√I）
      let batch = 0;
      for (let i = 0; i < D.n; i++) if (D.popT[i] === 0) batch++;
      if (batch > 0) {
        sawBirth = true;
        // ⚠ Obsidian 的抖动是 x、y 【各自】±F/2 ⇒ 径向最大 = spread·√2
        const bound = 0.12 * LD * Math.sqrt(batch) * Math.SQRT2 + 1e-6;
        for (let i = 0; i < D.n; i++) {
          if (D.popT[i] !== 0) continue;
          let cx = 0, cy = 0, k = 0;
          for (let p = D.adjStart[i]; p < D.adjStart[i + 1]; p++) {
            const j = D.adjList[p];
            if (j === i || !D.visible[j]) continue;
            cx += D.x[j]; cy += D.y[j]; k++;
          }
          if (k < 1) continue;
          anchorSamples++;
          const off = Math.hypot(D.x[i] - cx / k, D.y[i] - cy / k);
          if (off > worst) { worst = off; worstBound = bound; }
        }
      }

      if (sim.isAwake()) sim.tick(DT);
      fx.update(DT);

      if (++timer === 30) {
        let mx = 0;
        for (let i = 0; i < D.n; i++) {
          if (!watch[i]) continue;
          const d = Math.hypot(D.x[i] - x0[i], D.y[i] - y0[i]);
          if (d > mx) mx = d;
        }
        (sawBirth ? bornW : quietW).push(mx);
        timer = 0;
      }
    }

    check('① 前提：采到了落点样本', anchorSamples > 20, `${anchorSamples} 个`);
    check('① Obsidian 落点 = 可见邻居质心 ± 抖动（逐个节点对当帧上界对账）',
      anchorSamples > 0 && worst <= worstBound,
      `最大偏离 ${worst.toFixed(3)} wu ≤ 当帧上界 ${worstBound.toFixed(3)} wu（linkDistance=${LD}）`);

    const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const bAvg = avg(bornW), qAvg = avg(quietW);
    check('② 前提：两种窗口都采到了', bornW.length > 5 && quietW.length > 5,
      `有出生 ${bornW.length} 窗 / 无出生 ${quietW.length} 窗`);
    // ⚠ 判据必须钉在【绝对位移】上，不能只看比值 ——
    //   实测：把出生时的 sim.reheat 整个删掉后，两类窗口的位移双双塌到 0.7 / 0.3 wu，
    //   而【比值反而从 1.5× 涨到 2.7×】。纯比值判据对「机制被删掉」是瞎的。
    check('②a 出生确实给其他节点注入了力（绝对位移够大）',
      bAvg > 0.2 * LD,
      `有出生窗口 ${bAvg.toFixed(1)} wu > 阈值 ${(0.2 * LD).toFixed(1)} wu（0.2×linkDistance）`);
    check('②b 且这份位移确实来自出生（有出生窗口 > 无出生窗口）',
      bAvg > 1.15 * Math.max(0.5, qAvg),
      `有出生 ${bAvg.toFixed(1)} wu vs 无出生 ${qAvg.toFixed(1)} wu（${(bAvg / Math.max(0.1, qAvg)).toFixed(1)}×）`);

    GFI.config.pop.mode = keepMode;
    T.revealRate = keepRate;
    GFI.config.reheat.timelinePlay = keepPlay;
  })();

  // ---- K. 出生时的受力权重渐入（pop.simWeightRamp）-----------------------
  //   新节点落在邻居质心上、斥力又是恒定幅值（chargeFalloff=0），首帧全受力
  //   等于给邻居一记闷棍。实测把邻居逐帧 Δv 分解：首帧 1.14、前 3 帧占 49% 冲量；
  //   渐入 0.3s 后 → 首帧 0.11、前 3 帧 16%。
  (function testSimWeightRamp() {
    const keepRamp = GFI.config.pop.simWeightRamp;
    const keepMode = GFI.config.pop.mode;
    const keepRate = T.revealRate;
    // ⚠ 刻意取 0.9（比淡入的 0.73 秒【长】）：这正是「渐入还没走完就被踢出
    //   活跃列表、simWeight 永远卡住」那个坑的复现条件。默认 0.3 短于淡入，碰不到。
    GFI.config.pop.simWeightRamp = 0.9;
    GFI.config.pop.mode = 'obsidian';
    T.revealRate = 5;

    const D = makeGraph(200, 'uniform', 31);
    const sim = GFI.Physics.create(D, GFI.config.physics);
    const fx = GFI.Effects.create(D, sim);
    const tl = GFI.Timeline.create(D, sim, fx, {});
    tl.setPlaying(true);

    // 跑到一个节点出生的那一帧（setCutoff 之后、fx.update 之前）
    let born = -1, g = 0;
    while (born < 0 && g++ < 60 * 600) {
      tl.update(DT, 800);
      for (let i = 0; i < D.n; i++) if (D.popT[i] === 0) { born = i; break; }
    }
    check('前提：抓到一个刚出生的节点', born >= 0, `index=${born}`);
    check('出生瞬间受力权重是 0（不是首帧全开的 1.0）',
      born >= 0 && D.simWeight[born] === 0,
      `simWeight[${born}]=${born >= 0 ? D.simWeight[born] : "n/a"}`);

    // 渐入应该在 0.3s ≈ 18 帧内到 1
    let fr = 0;
    while (born >= 0 && D.simWeight[born] < 1 && fr < 200) { fx.update(DT); fr++; }
    check('渐入在 ramp 时间内到达 1（0.9s = 54 帧）',
      born >= 0 && D.simWeight[born] === 1 && fr >= 50 && fr <= 58,
      `${fr} 帧后 simWeight=${born >= 0 ? D.simWeight[born] : "n/a"}`);

    // 全程播完：不许有节点带着没走完的权重留在场上
    //   ⚠ 这条是防回退的：曾经 obsidian 分支只在 renderAlpha>=0.99（0.73s）时收尾，
    //     而渐入可能更长 —— 节点被提前踢出活跃列表，simWeight 卡在 0.8148 再不上升。
    // ⚠ 播放结束后必须继续推 fx 直到 anyActive() 为假 —— 这正是主循环的行为：
    //   main.js 的 busy 判定含 P.fx.anyActive()，而它在 pop 列表非空时为真，
    //   所以还有节点在渐入时循环不会停。测试若在 playing=false 就收手，
    //   最后出生的几个节点会被误判成「卡住」（实测 2 个卡在 0.0556 = 恰好一帧的渐入量）。
    while (tl.playing && g++ < 60 * 900) { tl.update(DT, 800); sim.tick(DT); fx.update(DT); }
    let drain = 0;
    while (fx.anyActive() && drain++ < 60 * 30) { if (sim.isAwake()) sim.tick(DT); fx.update(DT); }
    let stuck = 0, worst = 1;
    for (let i = 0; i < D.n; i++) {
      if (!D.visible[i] || D.simWeight[i] >= 1) continue;
      stuck++; if (D.simWeight[i] < worst) worst = D.simWeight[i];
    }
    check('播完整段后没有节点卡在半个权重上',
      stuck === 0, stuck ? `${stuck} 个未归位，最小 ${worst.toFixed(4)}` : '全部 = 1');

    // 反向：ramp = 0 时必须回到「首帧全受力」（保住那条老行为的开关）
    GFI.config.pop.simWeightRamp = 0;
    const D2 = makeGraph(200, 'uniform', 31);
    const sim2 = GFI.Physics.create(D2, GFI.config.physics);
    const fx2 = GFI.Effects.create(D2, sim2);
    const tl2 = GFI.Timeline.create(D2, sim2, fx2, {});
    tl2.setPlaying(true);
    let b2 = -1, g2 = 0;
    while (b2 < 0 && g2++ < 60 * 600) {
      tl2.update(DT, 800);
      for (let i = 0; i < D2.n; i++) if (D2.popT[i] === 0) { b2 = i; break; }
    }
    check('ramp = 0 时回到旧行为（首帧全受力）—— 开关有效',
      b2 >= 0 && D2.simWeight[b2] === 1,
      `simWeight[${b2}]=${b2 >= 0 ? D2.simWeight[b2] : "n/a"}`);

    GFI.config.pop.simWeightRamp = keepRamp;
    GFI.config.pop.mode = keepMode;
    T.revealRate = keepRate;
  })();
  T.revealRate = saved.rate; T.burstSmoothing = saved.burst;
})();

// ===========================================================================
// 19. 预热布局 —— 「点进去就是最终形态」的物理前提
// ===========================================================================
// 守的是 src/warm.js + GFI.Data.applyLayout + sim.reset() 这条新通路。
// 进图谱的观感问题（原生图谱 → 种子螺旋 → 缓动适配视野）在无头环境里
// 量不到，但它【依赖的那条物理通路】可以在这里逐位对账：
//
//   ① 预热跑到底之后，按 id 取出来的坐标必须能【精确】还原到新 build 出来的 D
//      上 —— 差一个 bit 都意味着第一帧和"最终形态"不是同一张图，
//      那么用户看到的就仍然是"先一个样、再变成另一个样"。
//   ② 灌完坐标之后模拟必须【睡着】。醒着的话第一帧之后图谱会继续塌，
//      于是"一步到位"变成"一步到位之后再动一下"。
//   ③ 睡着之后网格必须仍然收录所有节点。睡眠期没有 tick、也就没有
//      chargeGrid.build，而渲染剔除与命中测试都查这张网格 ——
//      不补 rebuildGrid 的后果是【整张图一个节点都不画】（空白画布）。
(function testWarmLayout() {
  const demo = GFI.DataSource.demo(200, { seed: 23 });

  // ---- 预热方：跑到底，按 id 取出坐标（复刻 src/warm.js 的做法）----
  const D0 = GFI.Data.build(demo.nodes, demo.links, null);
  const sim0 = GFI.Physics.create(D0, GFI.config.physics);
  const maxTicks = Math.ceil(GFI.config.physics.settleTicks * 2.5);
  let t = 0;
  while (sim0.isAwake() && t < maxTicks) { sim0.tick(DT); t++; }
  check('预热能在上限内睡着（否则缓存里是一张没沉降完的图）',
    !sim0.isAwake(), `${t} tick（上限 ${maxTicks}）alpha=${sim0.alpha.toExponential(2)}`);

  const layout = new Map();
  for (let i = 0; i < D0.n; i++) layout.set(D0.id[i], { x: D0.x[i], y: D0.y[i] });

  // 顺带把包围盒与种子布局做个对照 —— 这就是"②③两段观感"的量化来源
  const bbSettled = GFI.Data.bounds(D0, false);
  const Dseed = GFI.Data.build(demo.nodes, demo.links, null);   // 不灌 → 种子螺旋
  const bbSeed = GFI.Data.bounds(Dseed, false);
  const wSettled = bbSettled.maxX - bbSettled.minX, wSeed = bbSeed.maxX - bbSeed.minX;
  check('前提：种子布局与沉降布局的尺度确实差很多（否则那两段观感无从谈起）',
    wSettled > wSeed * 1.5,
    `种子宽 ${wSeed.toFixed(0)} → 沉降宽 ${wSettled.toFixed(0)}（${(wSettled / wSeed).toFixed(2)}×）`);

  // ---- 接管方：重建管线时把坐标灌进去 ----
  const D1 = GFI.Data.build(demo.nodes, demo.links, null, layout);
  check('全部节点都命中预热坐标', D1.adopted === D1.n, `${D1.adopted}/${D1.n}`);

  let maxDelta = 0, nan = 0;
  for (let i = 0; i < D1.n; i++) {
    const p = layout.get(D1.id[i]);
    const d = Math.abs(D1.x[i] - p.x) + Math.abs(D1.y[i] - p.y);
    if (d > maxDelta) maxDelta = d;
    if (!Number.isFinite(D1.x[i]) || !Number.isFinite(D1.y[i])) nan++;
  }
  check('① 灌进来的坐标与预热结果逐位一致', maxDelta === 0, `最大偏差 ${maxDelta}`);
  check('① 没有非有限坐标（applyLayout 的防御没被绕过）', nan === 0, `NaN=${nan}`);

  // ---- 速度必须清零 ----
  // 上一轮用过的 D 会带着残余速度（拖拽 / 时间轴都会写 vx/vy）。不清的话
  // 第一帧就带着速度起步，画面会自己抖一下。
  let maxVel = 0;
  for (let i = 0; i < D1.n; i++) maxVel = Math.max(maxVel, Math.abs(D1.vx[i]), Math.abs(D1.vy[i]));
  check('① 速度全部归零（不会带着上一轮的余速起步）', maxVel === 0, `最大 |v| = ${maxVel}`);

  // ---- ② 模拟必须睡着 ----
  const sim1 = GFI.Physics.create(D1, GFI.config.physics);
  check('前提：新建的 sim 是从 alpha=1 醒着起步的（不 reset 就会继续塌）',
    sim1.isAwake() && Math.abs(sim1.alpha - 1) < 1e-9, `alpha=${sim1.alpha}`);
  sim1.reset();
  check('② reset 之后模拟睡着', !sim1.isAwake(), `alpha=${sim1.alpha}`);
  check('② reset 把 alphaTarget 也归零（残留会让图永远醒着）',
    sim1.alphaTarget === 0, `alphaTarget=${sim1.alphaTarget}`);

  // ---- ③ 睡眠期网格必须能查到所有节点 ----
  // 复刻 main.js setData 里 warm 分支的调用顺序：reset → rebuildGrid
  sim1.rebuildGrid();
  check('③ reset 之后位置没被动过（首帧画的就是最终形态）', (() => {
    let d = 0;
    for (let i = 0; i < D1.n; i++) {
      const p = layout.get(D1.id[i]);
      d = Math.max(d, Math.abs(D1.x[i] - p.x) + Math.abs(D1.y[i] - p.y));
    }
    return d === 0;
  })());

  const buf = new Int32Array(D1.n);
  const bb = GFI.Data.bounds(D1, false);
  const found = sim1.grid.collectRect(D1, bb.minX - 1, bb.minY - 1, bb.maxX + 1, bb.maxY + 1, buf, D1.visible);
  check('③ 睡眠期网格收录全部节点（否则剔除会把整张图滤成 0 个）',
    found === D1.n, `网格 ${found}/${D1.n}`);

  // ---- 边界：给一份对不上的 layout，必须【部分命中】而不是崩 ----
  // index.js 的判据是 adopted === n 才算"一步到位"；这里守的是另一半：
  // 库变了（新增页面）时 applyLayout 只命中一部分，绝不能抛错、也不能
  // 把没命中的节点写成 NaN。
  const layout2 = new Map(layout);
  layout2.delete(String(demo.nodes[0].id));
  layout2.set('完全不存在的新节点', { x: 123, y: 456 });
  const D2 = GFI.Data.build(demo.nodes, demo.links, null, layout2);
  check('部分命中：命中数 = n-1，且调用方能据此拒绝"一步到位"',
    D2.adopted === D2.n - 1, `adopted=${D2.adopted}/${D2.n}`);
  let bad = 0;
  for (let i = 0; i < D2.n; i++) if (!Number.isFinite(D2.x[i]) || !Number.isFinite(D2.y[i])) bad++;
  check('部分命中：漏掉的那个节点落回种子坐标（不是 NaN）', bad === 0, `非有限 ${bad}`);

  // ---- 边界：layout 里带 NaN 的条目必须被跳过 ----
  const layout3 = new Map();
  for (const [id, p] of layout) layout3.set(id, p);
  layout3.set(D1.id[0], { x: NaN, y: 0 });
  const D3 = GFI.Data.build(demo.nodes, demo.links, null, layout3);
  check('layout 里的 NaN 条目被跳过（写进去就永远画不出来）',
    D3.adopted === D3.n - 1 && Number.isFinite(D3.x[0]), `adopted=${D3.adopted}`);
})();

// ===========================================================================
// 20. 设置面板：双语 schema + 默认值单一来源
// ===========================================================================
// 守两件事：
//  ① 每一屏文案两套语言齐全，且两种语言编译出来的 schema 结构完全一致
//     （漏翻一条就会在面板上露出空白或另一种语言）
//  ② 每个 schema 条目都有绑定到 configDefaults 的默认值 ——
//     旧代码里 schema.default 是写死的（linkDistance: 45），而真值是 50，
//     于是面板显示、描述文字、实际生效是【三套】。这条断言就是为了防止
//     再有人把默认值写回 schema 字面量里。
(function testSettingsI18n() {
  const i18n = GFI.i18n;
  check('i18n 模块已加载', !!i18n && typeof i18n.schema === 'function');

  const missing = i18n.audit();
  check('两套语言的 title/description(含 short) 都齐全', missing.length === 0,
    missing.length ? missing.slice(0, 6).join(' / ') : `${i18n.SCHEMA.length} 条全齐`);

  // ⚠ 面板高度直接由描述长度决定。实机实测：22 条长描述把 Logseq 主内容区
  //   撑到 scrollHeight 10572px、而可视高度只有 286px —— 用户滚不到下面的项。
  //   所以面板上只用 short，并在这里卡一个长度上界防止它再长回去。
  const tooLong = i18n.SCHEMA.filter((e) => !e.short).map((e) => e.key);
  check('每条都有 short（面板专用短描述）', tooLong.length === 0,
    tooLong.length ? '缺 short: ' + tooLong.join(', ') : '');

  const zhSchema = i18n.schema(i18n.SCHEMA);
  const over = zhSchema.filter((e) => String(e.description || '').length > 130)
    .map((e) => `${e.key}(${String(e.description).length})`);
  check('面板描述都 ≤130 字（否则把设置面板撑得滚不到底）', over.length === 0,
    over.length ? over.join(' ') : `最长 ${Math.max(...zhSchema.map((e) => String(e.description || '').length))} 字`);

  const zh = i18n.schema(i18n.SCHEMA);
  const en = i18n.schema(i18n.SCHEMA);

  check('语言选项排在第一位（用户第一眼要做的选择）',
    zh[0] && zh[0].key === 'language', `第一条是 ${zh[0] && zh[0].key}`);
  check('语言选项有两个选择', JSON.stringify(zh[0].enumChoices) === JSON.stringify(['中文', 'English']),
    JSON.stringify(zh[0].enumChoices));

  check('两种语言的条目数一致', zh.length === en.length && zh.length > 20,
    `zh=${zh.length} en=${en.length}`);

  const keysZh = zh.map((e) => e.key).join(',');
  const keysEn = en.map((e) => e.key).join(',');
  check('两种语言的键名与顺序完全一致', keysZh === keysEn, keysZh === keysEn ? '' : `${keysZh}\n≠ ${keysEn}`);

  // 真正切到 en 之后 title 必须变（否则等于没翻）
  let zhTitle, enTitle;
  i18n.set('zh'); zhTitle = i18n.schema()[1].title;
  i18n.set('en'); enTitle = i18n.schema()[1].title;
  i18n.set('zh');
  check('切换语言后 title 真的变了', zhTitle !== enTitle, `zh="${zhTitle}" en="${enTitle}"`);

  // 语言归一化：存档里可能是【字符串】也可能是 Logseq enum 的【索引】
  // —— 实机「上次选了英文，这次进去还是中文」最可能就是索引形态没被识别。
  check('语言归一化能吃下字符串形态',
    i18n.normalize('EN') === 'en' && i18n.normalize('English') === 'en' &&
    i18n.normalize('zh-CN') === 'zh' && i18n.normalize('乱七八糟') === 'zh');
  check('语言归一化能吃下 enum 索引形态（0=中文 1=English）',
    i18n.normalize(1) === 'en' && i18n.normalize(0) === 'zh' &&
    i18n.normalize('1') === 'en' && i18n.normalize('0') === 'zh',
    `1→${i18n.normalize(1)} 0→${i18n.normalize(0)} '1'→${i18n.normalize('1')}`);
  check('语言归一化能吃下 enumChoices 的原文',
    i18n.normalize('English') === 'en' && i18n.normalize('中文') === 'zh');
  check('ENUM_CHOICES 与 LANGS 顺序一一对应（normalize 的索引映射靠它）',
    i18n.ENUM_CHOICES.length === i18n.LANGS.length &&
    i18n.normalize(i18n.ENUM_CHOICES.indexOf('English')) === 'en' &&
    i18n.normalize(i18n.ENUM_CHOICES.indexOf('中文')) === 'zh',
    JSON.stringify(i18n.ENUM_CHOICES) + ' vs ' + JSON.stringify(i18n.LANGS));

  // ---- ② 默认值单一来源 ----
  const bind = GFI.SCHEMA_BINDINGS || {};
  const noBind = zh.filter((e) => e.key !== 'language' && !bind[e.key]).map((e) => e.key);
  check('每个条目都绑定了 configDefaults（不许在 schema 里写死默认值）',
    noBind.length === 0, noBind.length ? '缺绑定: ' + noBind.join(', ') : `${Object.keys(bind).length} 个绑定`);

  const d = GFI.configDefaults;
  check('linkDistance 的面板默认值 = 实际生效值（旧代码写死 45，真值 50）',
    zh.find((e) => e.key === 'linkDistance').default === d.physics.linkDistance,
    `面板 ${zh.find((e) => e.key === 'linkDistance').default} vs 真值 ${d.physics.linkDistance}`);
  check('velocityRetain 的面板默认值 = 实际生效值（旧代码写死 0.8，真值 0.6）',
    zh.find((e) => e.key === 'velocityRetain').default === d.physics.velocityRetain,
    `面板 ${zh.find((e) => e.key === 'velocityRetain').default} vs 真值 ${d.physics.velocityRetain}`);
  check('新增的预热开关也已接线',
    zh.find((e) => e.key === 'prewarm').default === d.warm.enabled &&
    zh.find((e) => e.key === 'syncSettleMs').default === d.warm.syncSettleMs &&
    zh.find((e) => e.key === 'revealAnimMs').default === d.warm.revealAnimMs);

  // ---- ③ language / warm.* 真的能从设置走通 ----
  // ⚠⚠ 先守一条回归：schema 必须按【当前语言】重新编译，不能复用加载时的快照。
  //   这正是实机「存档是英文、界面还是中文」的根因 ——
  //   index.js 原来是先 `useSettingsSchema(GFI.settingsSchema)`（config.js 加载时
  //   按默认语言编译的快照）再 applySettings（才读到 language）。
  {
    const keepL = i18n.get();
    try {
      i18n.set('zh');
      const snapZh = i18n.schema();                 // 模拟 config.js 加载时的快照
      i18n.set('en');                               // 模拟 applySettings 读到了 English
      const fresh = i18n.schema();                  // ← registerSettingsSchema 做的就是这件事
      check('⚠ 按当前语言重新编译后拿到英文（不能沿用加载时的中文快照）',
        fresh[1].title === i18n.t(i18n.SCHEMA[1].title, 'en') && fresh[1].title !== snapZh[1].title,
        `${snapZh[1].title} → ${fresh[1].title}`);
      check('重新编译后所有条目标题都是英文',
        fresh.every((e, i) => e.title === i18n.t(i18n.SCHEMA[i].title, 'en')),
        `${fresh.length} 条`);
    } finally {
      i18n.set(keepL);
    }
  }

  const keepLang = i18n.get();
  const keepWarm = JSON.stringify(GFI.config.warm);
  try {
    GFI.syncSettings({ __cfg: GFI.CFG_VERSION, language: 'English', prewarm: false, syncSettleMs: 456, revealAnimMs: 0 });
    check('设置里选 English ⇒ i18n 真的切过去了', i18n.get() === 'en', `lang=${i18n.get()}`);
    check('关掉预热 ⇒ config.warm.enabled = false', GFI.config.warm.enabled === false);
    check('抢跑预算/淡入时长能改', GFI.config.warm.syncSettleMs === 456 && GFI.config.warm.revealAnimMs === 0,
      `${GFI.config.warm.syncSettleMs} / ${GFI.config.warm.revealAnimMs}`);

    // ⚠ 回归：prewarm 默认是 true，老存档里没有这个键时【不能】被 !!undefined 关掉
    GFI.syncSettings({ __cfg: GFI.CFG_VERSION });
    check('老存档没有 prewarm 键 ⇒ 保持默认开着（不被 !!undefined 关掉）',
      GFI.config.warm.enabled === d.warm.enabled, `enabled=${GFI.config.warm.enabled} 期望 ${d.warm.enabled}`);
    check('超出区间的抢跑预算 ⇒ 回落默认值',
      (() => { GFI.syncSettings({ __cfg: GFI.CFG_VERSION, syncSettleMs: 999999 }); return GFI.config.warm.syncSettleMs === d.warm.syncSettleMs; })(),
      `${GFI.config.warm.syncSettleMs}`);
  } finally {
    GFI.syncSettings({ __cfg: GFI.CFG_VERSION });
    i18n.set(keepLang);
    Object.assign(GFI.config.warm, JSON.parse(keepWarm));
  }
})();

// ===========================================================================
// 21. 面板文案就地改写 —— 带行内格式的描述也必须能切换
// ===========================================================================
// 回归一个实机问题：用户报「某些简介不切换」。
// 根因是 relabelPanel 原先只改【叶子】元素（内部没有元素子节点），
// 而 Logseq 会把描述里的 **粗体** / `代码` 渲染成 <strong> / <code> ——
// 那条描述所在的元素就带上了元素子节点，于是被整条跳过。
// 这里用假 DOM 复刻两种节点：纯文本的 + 带行内 <strong> 的，两者都必须被改写。
(function testRelabelPanel() {
  const i18n = GFI.i18n;

  // 迷你假 DOM（只需要 relabelPanel 用到的那几个成员）
  // ⚠ textContent 必须实现【写】—— relabelPanel 靠"整体替换内容"来改写，
  //   只实现读的话这个夹具根本测不出真实行为。写的行为照浏览器来：
  //   清掉全部子节点，换成一个文本节点。
  function mkFake(leaf) {
    const parent = { className: 'settings-panel', id: '', childNodes: [], parentElement: null };
    const el = {
      className: 'settings-item-desc', id: '', __gfiSkip: false,
      childNodes: leaf ? [{ nodeType: 3, nodeValue: '' }] : [],
      parentElement: parent,
      get textContent() {
        return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : (c.textContent || ''))).join('');
      },
      set textContent(v) {
        this.childNodes.length = 0;
        this.childNodes.push({ nodeType: 3, nodeValue: String(v) });
      },
    };
    return el;
  }

  // 造三个节点：
  //   plain   —— 纯文本（基线）
  //   rich    —— 文本 + 行内元素（模拟 "描述里有 <strong>"）
  //   onlyEl  —— 内部【只有】元素子节点、没有裸文本（最刁的那种）
  // ⚠ 每个节点必须有【自己的】行内元素对象 —— 共用会让断言互相污染（写错过一次）
  const mkSpan = () => ({ nodeType: 1, nodeValue: undefined, textContent: '' });

  const plain = mkFake(true);

  const richSpan = mkSpan();
  const rich = mkFake(false);
  rich.childNodes = [{ nodeType: 3, nodeValue: '' }, richSpan];

  const onlyElSpan = mkSpan();
  const onlyEl = mkFake(false);
  onlyEl.childNodes = [onlyElSpan];

  const nodes = [plain, rich, onlyEl];

  const doc = {
    querySelectorAll: () => nodes,
    getElementById: () => null,
  };
  const keepDoc = GFI.topDoc;
  GFI.topDoc = doc;
  try {
    // 拿一条真实文案当靶子
    // ⚠ 期望值必须用 i18n.t() 现取，【不能】用 i18n.schema() ——
    //   schema() 是插件启动时按当时的语言编译好的快照，这里早就变成中文了，
    //   拿它当英文期望值会得到假失败（自己踩过）。
    const entry = i18n.SCHEMA.find((e) => e.key === 'popZeta');
    const zhText = i18n.t(entry.short, 'zh');
    const enText = i18n.t(entry.short, 'en');

    plain.childNodes[0].nodeValue = zhText;
    rich.childNodes[0].nodeValue = zhText;
    richSpan.textContent = '';
    onlyElSpan.textContent = zhText;
    // 模拟它已经是"目标语言"（改写前应当是中文）
    i18n.set('en');
    const hits = i18n.relabelPanel();

    check('纯文本节点被改写（基线）', plain.textContent === enText, JSON.stringify(plain.textContent.slice(0, 40)));
    check('⚠ 带行内元素的描述【也】被改写（旧的"只改叶子"逻辑会漏掉它）',
      rich.textContent === enText, JSON.stringify(String(rich.textContent).slice(0, 40)));
    check('⚠ 内部只有元素子节点的描述也能改写（整体替换，不留旧文案）',
      onlyEl.textContent === enText, JSON.stringify(String(onlyEl.textContent).slice(0, 60)));
    check('一次改写命中三个节点', hits === 3, `hits=${hits}`);
    check('已经是目标语言时不重复改写（幂等）', i18n.relabelPanel() === 0, `第二次 hits=${i18n.relabelPanel()}`);

    // debug 模式要能报出"看起来像我们的文案但没匹配上"的内容
    plain.childNodes[0].nodeValue = '这是一条我们完全不认识的很长的描述文本，用来触发 debug 收集';
    const dbg = i18n.relabelPanel({ debug: true });
    check('debug 模式返回结构化的扫描结果',
      dbg && typeof dbg.scanned === 'number' && Array.isArray(dbg.missed),
      JSON.stringify({ hits: dbg && dbg.hits, scanned: dbg && dbg.scanned, missedN: dbg && dbg.missed.length }));

    // ---- ⚠ 绝不能碰含交互控件的元素（实机事故：点完语言"可选框没了"）----
    // 复刻 Logseq 的 enum：容器里是 <input type=radio> + <label>，
    // 而容器的整段文本恰好等于我们某条 enum 的候选文案 ——
    // 整体替换会把单选框一起抹掉。
    const radio = { tagName: 'INPUT', nodeType: 1, textContent: '' };
    const enumContainer = {
      className: 'settings-enum-item', id: '', __gfiSkip: false,
      tagName: 'DIV', parentElement: { className: 'settings-panel', id: '', parentElement: null },
      childNodes: [{ nodeType: 3, nodeValue: i18n.t(entry.short, 'zh') }, radio],
      get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); },
      set textContent(v) { this.childNodes.length = 0; this.childNodes.push({ nodeType: 3, nodeValue: String(v) }); },
      querySelector: (sel) => (/input/i.test(sel) ? radio : null),
    };
    const keepDoc2 = GFI.topDoc;
    GFI.topDoc = { querySelectorAll: () => [enumContainer], getElementById: () => null };
    try {
      i18n.set('zh');
      const before = enumContainer.childNodes.length;
      const n2 = i18n.relabelPanel();
      check('⚠ 含单选控件的容器不被改写（否则"可选框没了"）',
        enumContainer.childNodes.length === before && enumContainer.childNodes.indexOf(radio) >= 0,
        `改写 ${n2} 条，子节点数 ${before} → ${enumContainer.childNodes.length}`);
      check('控件被跳过时会计入 skippedControls（可观测）',
        (GFI.__relabelStat && GFI.__relabelStat.skippedControls) === 1,
        JSON.stringify(GFI.__relabelStat));
      check('hasInteractive 能识别 input 容器', i18n.hasInteractive(enumContainer) === true);
      check('hasInteractive 对纯文本节点返回 false', i18n.hasInteractive(plain) === false);
    } finally {
      GFI.topDoc = keepDoc2;
    }
  } finally {
    GFI.topDoc = keepDoc;
    i18n.set('zh');
  }
})();

// ===========================================================================
// 22. 库变动 → 图谱刷新：过滤器必须既不漏、也不自激
// ===========================================================================
// 实机反馈：「删掉某些页面、改了部分正文，图谱自加载后就不再更新」。
// 修法的一半是"数据一律现查"（见 §19），另一半是这里 —— 加刷新机制。
// 但这个机制有两条很容易踩的纪律：
//   ① 不能自激：刷新会改画布、也会改我们自己的工具栏（innerHTML 换图标、
//      textContent 写日期），而那些正好都是"内容类变动"。
//      不过滤的话就是 刷新 → 改 DOM → 又触发 → 又刷新 …… 死循环。
//   ② 不能太贵：每次刷新 = 一次完整查库（300~500ms）。所以必须防抖，
//      而且"没挂载就不刷"。
const testLiveWatch = (function () {
  const LW = GFI.LiveWatch;
  check('LiveWatch 模块已加载', !!LW && typeof LW.looksLikeContentEdit === 'function');

  const mkEl = (tag, cls, parent) => ({
    nodeType: 1, tagName: String(tag).toUpperCase(), className: cls || '',
    parentNode: parent || null, childNodes: [],
    querySelector() { return null; },
  });
  const mkText = (v) => ({ nodeType: 3, nodeValue: v, parentNode: null });
  const mut = (type, target, addedNodes) => ({ type, target, addedNodes: addedNodes || [] });

  const body = mkEl('div', 'app-body');
  const contentP = mkEl('p', 'block-content', body);
  const gfiRoot = mkEl('div', 'gfi-root', body);
  gfiRoot.__gfiSkip = true;
  const gfiLabel = mkEl('span', 'gfi-label', gfiRoot);
  const settingsPanel = mkEl('div', 'settings-panel', body);

  // ---- ① 真的编辑：必须认得出来 ----
  check('新增 <p> 算内容变动', LW.looksLikeContentEdit([mut('childList', contentP, [mkEl('p', '', contentP)])]) === true);
  check('characterData 算内容变动（改正文就是这种）',
    LW.looksLikeContentEdit([mut('characterData', mkEl('span', 'x', contentP))]) === true);
  check('新增非空文本节点算内容变动',
    LW.looksLikeContentEdit([mut('childList', contentP, [mkText('新写的正文')])]) === true);
  check('深层容器里含 <p> 也算（编辑器插入的是外层 div）', (() => {
    const wrap = mkEl('div', 'wrap', contentP);
    wrap.querySelector = (sel) => (/p/.test(sel) ? mkEl('p') : null);
    return LW.looksLikeContentEdit([mut('childList', contentP, [wrap])]) === true;
  })());

  // ---- ② 噪音：不能误判 ----
  check('纯空白文本节点不算内容变动',
    LW.looksLikeContentEdit([mut('childList', contentP, [mkText('   \n  ')])]) === false);
  check('新增 <canvas> / <style> 不算内容变动',
    LW.looksLikeContentEdit([
      mut('childList', body, [mkEl('canvas')]),
      mut('childList', body, [mkEl('style')]),
    ]) === false);
  check('空变动数组不算', LW.looksLikeContentEdit([]) === false && LW.looksLikeContentEdit(null) === false);

  // ---- ③ 自激闸门：我们自己的容器一律忽略 ----
  check('⚠ 落在 .gfi-root 里的 characterData 被忽略（否则自激死循环）',
    LW.looksLikeContentEdit([mut('characterData', gfiLabel)]) === false);
  check('⚠ 新增到 .gfi-root 里的 <span> 被忽略',
    LW.looksLikeContentEdit([mut('childList', gfiRoot, [mkEl('span', 'gfi-btn', gfiRoot)])]) === false);
  check('⚠ 带 __gfiSkip 标记的容器内部一律忽略（无需 .gfi- 类名）', (() => {
    const marked = mkEl('div', '随便什么', body);
    marked.__gfiSkip = true;
    const inner = mkEl('span', 'inner', marked);
    return LW.looksLikeContentEdit([mut('characterData', inner)]) === false;
  })());
  check('设置面板里的 input 变动被忽略（改设置不该白查一次库）',
    LW.looksLikeContentEdit([mut('childList', settingsPanel, [mkEl('input', '', settingsPanel)])]) === false);

  // ---- ④ 调度器：防抖 + 没挂载不刷 + cancel ----
  return new Promise((resolve) => {
    let calls = 0;
    const s = LW.createScheduler({ debounceMs: 20, isMounted: () => true, refresh: () => { calls++; } });
    s.notify([mut('childList', contentP, [mkEl('p')])], 'a');
    s.notify([mut('characterData', mkEl('span', 'x', contentP))], 'b');
    s.notify([mut('childList', contentP, [mkText('更多正文')])], 'c');
    check('多次变动会合并（防抖窗口内只排一次）', s.pending === true);

    const s2 = LW.createScheduler({ debounceMs: 20, isMounted: () => true, refresh: () => {} });
    check('我们自己的变动不排队', s2.notify([mut('characterData', gfiLabel)], 'self') === false);

    const s3 = LW.createScheduler({ debounceMs: 20, isMounted: () => false, refresh: () => {} });
    check('图谱没挂载时不排队（下次打开会现查）',
      s3.notify([mut('childList', contentP, [mkEl('p')])], 'unmounted') === false);

    setTimeout(() => {
      check('防抖后只刷新了一次（3 次变动 → 1 次）', calls === 1, `refresh 调用 ${calls} 次`);
      check('刷新结束后 pending 归假', s.pending === false);

      let calls2 = 0;
      const s4 = LW.createScheduler({ debounceMs: 20, isMounted: () => true, refresh: () => { calls2++; } });
      s4.notify([mut('childList', contentP, [mkEl('p')])], 'cancel-test');
      s4.cancel();
      check('cancel 之后 pending 归假', s4.pending === false);
      setTimeout(() => {
        check('cancel 真的阻止了刷新（图谱关闭时不该再查库）', calls2 === 0, `refresh 调用 ${calls2} 次`);
        resolve();
      }, 40);
    }, 60);
  });
})();

// ===========================================================================
// 结果
// ===========================================================================
//   §22 是异步的（要等真实定时器），所以结果必须等它跑完再打。
testLiveWatch.then(() => {
  console.log(`\n${'═'.repeat(60)}`);
  if (fail === 0) {
    console.log(`\x1b[32m全部通过\x1b[0m  ${pass} 项`);
  } else {
    console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 通过 ${pass} 项`);
    console.log('失败清单:');
    for (const f of failures) console.log('  · ' + f);
  }
  process.exit(fail === 0 ? 0 : 1);
});
