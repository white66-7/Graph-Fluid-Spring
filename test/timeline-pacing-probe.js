/*
 * 时间线节奏探针 —— node test/timeline-pacing-probe.js
 * ===========================================================================
 * 目的：白盒量化时间线播放节奏，并对照【旧实现（按毫秒推进）】与
 *       【新实现（按秩推进 + 每帧揭示额度）】。
 *
 * 加载的是真实 timeline.js / data.js / physics.js / effects.js，不是 mock。
 * 「旧」列忠实复现改动【之前】的完整行为：按毫秒等速推进 + 无揭示额度 +
 * 倒带走 range.min + 动画淡出。
 *
 * 用法：
 *   node test/timeline-pacing-probe.js           # 旧/新对照表
 *   node test/timeline-pacing-probe.js sweep     # 额外扫描 N × 分布
 *   node test/timeline-pacing-probe.js desync    # 只上额度不上按秩 ⇒ 进度条脱节
 *
 * 分布是自变量。真实图谱的 createdAt 长什么样，用主窗口 DevTools 的
 * __GFI__.tlState() 看「有时间戳节点 / 诞生速率 / 实际全程秒」三项即可。
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
const SPAN = 900 * DAY;              // 约 2.5 年

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// createdAt 分布 —— 这是本探针的自变量
// ---------------------------------------------------------------------------
const SHAPES = {
  // 均匀铺满 2.5 年：教科书式的理想分布
  uniform(nd, i, N, rnd) { nd.createdAt = NOW - SPAN + (SPAN * i) / Math.max(1, N - 1); },

  // 越新越多（rnd^0.6 偏老，这里反过来用 1-x 做偏新）
  recency(nd, i, N, rnd) { nd.createdAt = NOW - SPAN * (1 - Math.pow(rnd(), 0.6)); },

  // 批量导入 / 重建 DB：60% 挤在导入当天，其余铺开
  import(nd, i, N, rnd) {
    const t0 = NOW - SPAN;
    nd.createdAt = rnd() < 0.6 ? t0 + rnd() * DAY : t0 + DAY + rnd() * (SPAN - DAY);
  },

  // 导入 → 停用 → 回归：三个大簇 + 长尾
  trimodal(nd, i, N, rnd) {
    const t0 = NOW - SPAN, r = rnd();
    if (r < 0.45) nd.createdAt = t0 + rnd() * DAY;
    else if (r < 0.75) nd.createdAt = t0 + 400 * DAY + rnd() * 3 * DAY;
    else nd.createdAt = t0 + rnd() * SPAN;
  },

  // 60% 落在【同一毫秒】、其余铺开 —— 按秩推进救不了这种，只能靠揭示额度
  bulk(nd, i, N, rnd) {
    const t0 = NOW - SPAN;
    nd.createdAt = rnd() < 0.6 ? t0 : t0 + DAY + rnd() * (SPAN - DAY);
  },

  // 全部同一毫秒（退化：timeRange 直接返回 null，时间旅行整个不可用）
  instant(nd) { nd.createdAt = NOW - SPAN; },
};

function build(N, shape, seed) {
  const demo = GFI.DataSource.demo(N, { seed, clusters: Math.max(3, Math.round(Math.sqrt(N) / 2)) });
  const rnd = mulberry32(seed + 991);
  demo.nodes.forEach((nd, i) => SHAPES[shape](nd, i, N, rnd));
  return GFI.Data.build(demo.nodes, demo.links, null);
}

// ---------------------------------------------------------------------------
// 旧实现（改动前的 tl.update 原文）—— 按毫秒等速推进
// ---------------------------------------------------------------------------
function installLegacyUpdate(tl, range) {
  const base = Math.max(1, tl.playDurationSec);
  tl.update = function (dt, vh) {
    if (!tl.playing || !range) return;
    const advance = (dt / base * tl.speed) * range.duration;
    if (advance <= 0) return;
    const prev = tl.cutoff;
    let next = prev + advance;
    if (next >= range.max) next = range.max;
    tl.setCutoff(next, { forward: true, prevCutoff: prev, viewportWorldHeight: vh, playing: true });
    if (next >= range.max) tl.playing = false;
  };
}

// ---------------------------------------------------------------------------
// 跑一遍完整播放
// ---------------------------------------------------------------------------
function run(N, shape, mode, seed) {
  // 速率是唯一旋钮 ⇒ 全程 = N/rate。这里把它设成 N/28，让新旧两模式的
  // 总时长同为 ~28 秒 —— 只在同分母下比较「节奏分布」才有意义。
  GFI.config.timeline.revealRate = N / 28;
  const D = build(N, shape, seed);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  const fx = GFI.Effects.create(D, sim);

  let clock = 0;
  const events = [];
  const tl = GFI.Timeline.create(D, sim, fx, {
    onChange(e) { if (e.revealed || e.hidden) events.push({ t: clock, revealed: e.revealed, hidden: e.hidden }); },
  });

  const out = { N, shape, mode, n: D.n, paced: tl.pacedCount, rate: tl.rate, playSec: tl.playDurationSec };
  if (!tl.range) { out.noRange = true; return out; }

  const savedBurst = GFI.config.timeline.burstSmoothing;
  if (mode === 'old') {
    // 「旧」= 忠实复现改动【之前】的完整行为，不是只换 update：
    //   · 按毫秒等速推进
    //   · 无逐帧揭示额度
    //   · 倒带走 range.min + 动画淡出（这才是旧的「重新开始播放」）
    GFI.config.timeline.burstSmoothing = false;
    installLegacyUpdate(tl, tl.range);
    tl.setCutoff(tl.range.min, { forward: false, pulse: true });
    tl.playing = true;
  } else {
    tl.setPlaying(true);            // 真实入口：会先倒带回空白（instantHide）
  }
  events.length = 0;

  let guard = 0;
  while (tl.playing && guard++ < 60 * 1800) { tl.update(DT, 800); clock += DT; }
  GFI.config.timeline.burstSmoothing = savedBurst;

  out.clock = clock;
  out.events = events;
  // 收尾：把被额度挡在门外的队列排空（只在 new 模式可能非空）
  let pending = 0;
  for (let i = 0; i < D.n; i++) if (D.wantVisible[i] && !D.visible[i]) pending++;
  out.pendingAtEnd = pending;
  return out;
}

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------
function metrics(r) {
  if (r.noRange) return { 分布: r.shape, N: r.N, 备注: 'range=null（全部同一时间戳）—— 时间旅行整个不可用' };

  const frames = Math.max(1, Math.round(r.clock / DT));
  const perFrame = new Float64Array(frames);
  let total = 0;
  for (const e of r.events) {
    const f = Math.min(frames - 1, Math.floor(e.t / DT));
    perFrame[f] += e.revealed;
    total += e.revealed;
  }

  let peak = 0, busy = 0, burstFrames = 0;
  for (let i = 0; i < frames; i++) {
    const v = perFrame[i];
    if (v > peak) peak = v;
    if (v > 0) busy++;
    if (v > 5) burstFrames++;              // 「一帧冒出 5 个以上」= 观感上的炸
  }

  let cum = 0, t50 = null, t90 = null;
  for (const e of r.events) {
    cum += e.revealed;
    if (t50 === null && cum >= total * 0.5) t50 = e.t;
    if (t90 === null && cum >= total * 0.9) t90 = e.t;
  }

  return {
    分布: r.shape, N: r.N, 模式: r.mode,
    节点: r.n, 有时间戳: r.paced,
    速率: +r.rate.toFixed(1),
    全程秒: +r.clock.toFixed(1),
    揭示总数: total,
    峰值帧: peak,
    炸裂帧数: burstFrames,
    忙帧占比: +(busy / frames).toFixed(3),
    t50秒: t50 === null ? null : +t50.toFixed(2),
    t90秒: t90 === null ? null : +t90.toFixed(2),
    结束时残留: r.pendingAtEnd,
  };
}

// ---------------------------------------------------------------------------
// desync 模式：证明「额度必须配按秩推进」
// ---------------------------------------------------------------------------
// 只上额度、不上按秩推进（= 旧的按毫秒推进 + 额度）时：进度条按【时间戳】走，
// 画面按【额度】放，两者脱节。timeline.js 顶部注释里引用的就是这张表。
function desync(N, shape, seed) {
  GFI.config.timeline.revealRate = N / 28;   // 同 run()：全程 ~28 秒
  const D = build(N, shape, seed);
  const sim = GFI.Physics.create(D, GFI.config.physics);
  const fx = GFI.Effects.create(D, sim);
  const tl = GFI.Timeline.create(D, sim, fx, {});
  if (!tl.range) { console.log('  range=null'); return; }

  const base = Math.max(1, tl.playDurationSec);
  const pending = () => { for (let i = 0; i < D.n; i++) if (D.wantVisible[i] && !D.visible[i]) return true; return false; };
  // 旧推进 + 新额度
  tl.update = function (dt, vh) {
    if (!tl.playing) return;
    const prev = tl.cutoff;
    const next = Math.min(tl.range.max, prev + (dt / base * tl.speed) * tl.range.duration);
    tl.setCutoff(next, {
      forward: true, prevCutoff: prev, viewportWorldHeight: vh, playing: true,
      revealBudget: Math.max(1, Math.ceil(tl.rate * tl.speed * dt)),
    });
    if (next >= tl.range.max && !pending()) tl.playing = false;
  };

  tl.setPlaying(true);
  let clock = 0, guard = 0, worst = 0;
  console.log('  t(s)   进度条(cutoff)   实际画面   脱节');
  while (tl.playing && guard++ < 60 * 1800) {
    tl.update(DT, 800); clock += DT;
    if (guard % 300 === 0) {
      let vis = 0;
      for (let i = 0; i < D.n; i++) if (D.visible[i]) vis++;
      const bar = tl.progress() * 100, pic = vis / D.n * 100;
      if (Math.abs(bar - pic) > Math.abs(worst)) worst = bar - pic;
      console.log(`  ${clock.toFixed(1).padStart(5)}  ${bar.toFixed(1).padStart(11)}%  ${pic.toFixed(1).padStart(8)}%  ${(bar - pic).toFixed(1).padStart(6)}pp`);
    }
    if (clock > 60) break;
  }
  console.log(`  最大脱节 ${worst.toFixed(1)} 个百分点（负 = 画面跑在进度条前面）`);
}

if (process.argv[2] === 'desync') {
  console.log('只上揭示额度、不上按秩推进（N=1200，60% 挤在同一毫秒）：');
  desync(1200, 'bulk', 7);
  process.exit(0);
}

// ---------------------------------------------------------------------------
const sweepMode = process.argv[2] === 'sweep';
const NS = sweepMode ? [60, 200, 600, 2000, 5000] : [100, 300, 1000, 3000];
const KEYS = sweepMode ? ['uniform', 'recency', 'import', 'trimodal'] : ['uniform', 'recency', 'import', 'trimodal', 'bulk', 'instant'];

console.log(`burstSmoothing=${GFI.config.timeline.burstSmoothing}  ` +
  `（每个 N 的「演变节奏」都设成 N/28 ⇒ 新旧两模式全程同为 ~28 秒，同分母才可比）`);

for (const shape of KEYS) {
  console.log(`\n══════════ 分布: ${shape} ══════════`);
  for (const N of NS) {
    const oldR = run(N, shape, 'old', 42);
    const newR = run(N, shape, 'new', 42);
    const a = metrics(oldR), b = metrics(newR);
    if (a.备注) { console.log(`N=${N}  ${a.备注}`); continue; }
    const fmt = (m) => `全程${String(m.全程秒).padStart(6)}s 峰值${String(m.峰值帧).padStart(5)} 炸裂帧${String(m.炸裂帧数).padStart(5)} 忙${String(m.忙帧占比).padStart(5)} t50@${String(m.t50秒).padStart(6)}s 速率${String(m.速率).padStart(5)}/s`;
    console.log(`  N=${String(N).padStart(4)}  旧 ${fmt(a)}`);
    console.log(`            新 ${fmt(b)}  残留=${b.结束时残留}`);
  }
}
