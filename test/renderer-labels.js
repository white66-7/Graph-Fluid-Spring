/*
 * 标签系统验证 —— node test/renderer-labels.js
 * ===========================================================================
 * 为什么需要单独一个脚本：
 *   headless-sim.js 明确不覆盖 renderer —— 它要真实的 Canvas2D 上下文。
 *   所以标签逻辑（占位抑制 / 精灵缓存 / 悬浮标签那一路）此前完全没有回归保护。
 *
 * 这个脚本加载【真实的】 src/renderer.js + src/camera.js + src/data.js，
 * 只把 2D 上下文换成一个计数桩。measureText 用固定字宽（7px × 字符数）——
 * 这些断言验的是【标签摆放与缓存逻辑】，不是字形度量，所以固定宽度既够用又稳定。
 *
 * 覆盖的是这次重写的三条：
 *   1. 占位格从"只标落点一格"改成"标满整个包围盒" —— 相邻标签现在真的会互相让位
 *   2. 标签走精灵预渲染 —— 每帧 strokeText 归零、fillText 归零，只剩 drawImage
 *   3. 精灵缓存有界、且可复用；悬浮标签绕过缓存且不被让位
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DPR = 2;
const VW = 400, VH = 400;      // 视口 CSS 尺寸

// ---------------------------------------------------------------------------
// Canvas2D 桩
// ---------------------------------------------------------------------------
const madeCanvases = [];

function makeStubCtx(canvas) {
  const calls = {
    fillText: 0, strokeText: 0, drawImage: 0,
    fill: 0, stroke: 0, clearRect: 0, measureText: 0,
    // L1/L2/L3 断言用：drawImage 的来源精灵画布（同一字符串 = 同一张精灵）
    // 与调用瞬间的 globalAlpha。数组型计数在 draw() 里清空方式不同。
    srcs: [], alphas: [], arcs: [], strokeAlphas: [],
    // 绝对摆放断言用：drawImage 的目标矩形（精灵左缘/上缘/宽/高，CSS 像素）
    dsts: [],
  };
  const ctx = {
    calls,
    canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '12px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    lineJoin: 'miter', lineCap: 'butt', miterLimit: 10,
    setTransform() {}, save() {}, restore() {},
    clearRect() { calls.clearRect++; },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    // 出生淡入断言用：记录每个圆的圆心与画它时的 globalAlpha
    arc(x, y, r) { calls.arcs.push({ x, y, r, a: this.globalAlpha }); },
    fill() { calls.fill++; },
    stroke() { calls.stroke++; calls.strokeAlphas.push(this.globalAlpha); },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {},
    // 固定字宽 —— 7px/字符，可预测，便于精确推算标签包围盒
    measureText(t) { calls.measureText++; return { width: String(t).length * 7 }; },
    fillText() { calls.fillText++; },
    strokeText() { calls.strokeText++; },
    drawImage(src, dx, dy, dw, dh) {
      calls.drawImage++; calls.srcs.push(src); calls.alphas.push(this.globalAlpha);
      calls.dsts.push({ dx, dy, dw, dh });
    },
  };
  return ctx;
}

function makeStubCanvas() {
  const c = {
    width: 0, height: 0, style: {}, isConnected: true,
    getContext() { return (c._ctx = c._ctx || makeStubCtx(c)); },
  };
  madeCanvases.push(c);
  return c;
}

// ---------------------------------------------------------------------------
// 最小 window shim（与 headless-sim.js 同一套路）
// ---------------------------------------------------------------------------
const sandbox = {
  console, Math, Date, Number, Array, Object, JSON, Map, Set,
  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
  isNaN, parseInt, parseFloat, Infinity, NaN,
  devicePixelRatio: DPR,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  document: { documentElement: {}, createElement: () => makeStubCanvas() },
  setTimeout, clearTimeout,
};
sandbox.window = sandbox;
sandbox.parent = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}

// renderer 依赖 camera / data / config / ns。不需要 spatial / physics。
for (const f of ['ns', 'config', 'data', 'camera', 'renderer']) load(`src/${f}.js`);

const GFI = sandbox.GFI;

// 关掉辉光：辉光也是用 drawImage 画的，不关掉就没法用 drawImage 计数反推标签数。
// （辉光走 spriteCache 与标签的 labelCache 完全独立，对标签逻辑没有任何影响。）
GFI.config.lod.levels[0].glow = 'hover';

// 🌟 本文件绝大多数用例测的是【占位让位机制】本身（谁占住格子、谁被挤掉、胜者滞回、
//   幽灵余晖……），所以这里显式把它打开。
// ⚠ 产品默认是 `labelYield = false`（Obsidian 行为：都画、可重叠），
//   那条路径由文件末尾的 §11 单独覆盖 —— 不要因为这里设了 true 就以为默认变了。
GFI.config.render.labelYield = true;

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

// ---------------------------------------------------------------------------
// 场景搭建
// ---------------------------------------------------------------------------
// 视口 400×400、k=1、相机在原点 → 屏幕坐标 = 世界坐标 + 200。
// 🌟 标签摆放：文字画在节点【正下方】、水平居中于节点，间隙 6px（renderer 的 LABEL_GAP）。
//    place(i, sx, sy) 的语义因此是【文字左缘、文字垂直中线】——不是节点圆心，
//    所以它要按摆法【反解】出节点圆心（见下面 place 的实现）。
// 节点度数 0 → radius = clamp(radiusBase, min, max) × nodeSize = 5。
const SCREEN_OFF = VW / 2;

function screenToWorldX(sx) { return sx - SCREEN_OFF; }
function screenToWorldY(sy) { return sy - SCREEN_OFF; }

// 标签几何（必须与 config 对齐，否则断言算错）
const FONT_PX = 12;
const PAD = Math.ceil(GFI.config.render.labelHaloWidth) + 2;      // 1.5 → 2 + 2 = 4
const BOX_H = Math.ceil(FONT_PX * 1.3) + PAD * 2;                 // 16 + 8 = 24
const labelW = (str) => Math.ceil(str.length * 7) + PAD * 2;      // 7 字符 → 57

function makeScene(labels) {
  // 条目可以是字符串（默认 kind=page）或 {label, kind}
  const nodes = labels.map((s, i) => ({
    id: 'n' + i,
    label: typeof s === 'string' ? s : s.label,
    kind: typeof s === 'string' ? 'page' : (s.kind || 'page'),
  }));
  const D = GFI.Data.build(nodes, [], null);
  const cam = GFI.Camera.create(VW, VH);
  cam.k = 1; cam.x = 0; cam.y = 0;
  const canvas = makeStubCanvas();
  const renderer = GFI.Renderer.create(canvas, D, cam);
  renderer.resize(VW, VH, DPR);
  // 直接摆到指定屏幕坐标上（sx = 文字左缘，sy = 文字垂直中线）
  //   这是 renderer.drawOne 摆放公式的【逆运算】，改摆法必须同步改这里，否则
  //   所有几何断言会静默算错（不是报错，是算出一个错的期望值）。
  return {
    D, cam, renderer, canvas,
    ctx: canvas.getContext('2d'),
    place(i, sx, sy) {
      const rScr = Math.max(2, D.radius[i] * D.scaleMul[i] * cam.k);
      const w = labelW(D.label[i]);
      // 正下方 + 水平居中：文字水平中点 == 节点圆心 x；
      // 节点圆心在文字上方 (文字半高 + 间隙 + 节点半径)。
      // ⚠ 间隙从【文字】下缘算，不是精灵盒下缘 —— 盒子上下各留了 PAD 的透明 padding。
      D.x[i] = screenToWorldX(sx - PAD + w * 0.5);
      D.y[i] = screenToWorldY(sy - (BOX_H * 0.5 - PAD) - 3 - rScr);
    },
    draw(view) {
      const c = canvas.getContext('2d');
      for (const k in c.calls) {
        if (Array.isArray(c.calls[k])) c.calls[k].length = 0;
        else c.calls[k] = 0;
      }
      return renderer.render(Object.assign(
        { hoverIdx: -1, selectedIdx: -1, lod: 0, labelsOn: true }, view || {}));
    },
  };
}

// 包围盒：x ∈ [左缘-PAD, 左缘-PAD+w]，y ∈ [中线±h/2]
function labelBox(sx, sy, str) {
  const w = labelW(str), hh = BOX_H / 2;
  return { x0: sx - PAD, x1: sx - PAD + w, y0: sy - hh, y1: sy + hh };
}

// ===========================================================================
section('1. 占位抑制 —— 相邻标签必须互相让位');
// ===========================================================================
(function testOverlapSuppression() {
  const S = makeScene(['abcdefg', 'abcdefg']);
  // 文字左缘 x = 100 / 130（相距 30px），同一 y → 两个包围盒必然重叠
  S.place(0, 100, 200);
  S.place(1, 130, 200);

  const boxA = labelBox(100, 200, 'abcdefg');
  const boxB = labelBox(130, 200, 'abcdefg');
  const overlap = boxA.x1 > boxB.x0 && boxB.x1 > boxA.x0;

  // 关键前提：两者包围盒的【左上角落点格】不同 —— 所以旧的"只标一格"逻辑对 B 是放行的
  const cell = GFI.config.render.labelCell;
  const cellA = Math.floor(boxA.x0 / cell), cellB = Math.floor(boxB.x0 / cell);

  check('前提：两个标签的包围盒重叠', overlap,
    `A=[${boxA.x0.toFixed(0)},${boxA.x1.toFixed(0)}] B=[${boxB.x0.toFixed(0)},${boxB.x1.toFixed(0)}]`);
  check('前提：两者落点格不同（旧逻辑会放行 B）', cellA !== cellB,
    `格 ${cellA} vs ${cellB}（cell=${cell}）`);
  check('前提：两者在同一个 y 带上', boxA.y0 === boxB.y0 && boxA.y1 === boxB.y1,
    `y ∈ [${boxA.y0}, ${boxA.y1}]`);

  const st = S.draw();
  check('重叠的第二个标签被抑制', st.labelN === 1, `画出 ${st.labelN} 个（期望 1）`);
})();

// ===========================================================================
section('2. 精灵预渲染 —— 每帧不再有字形描边/填充');
// ===========================================================================
(function testSpritePath() {
  const S = makeScene(['aaaa', 'bbbb', 'cccc', 'dddd']);
  // 摆开，互不重叠：标签宽 4*7+8 = 36，间距 120 足够
  S.place(0, 60, 100);
  S.place(1, 180, 100);
  S.place(2, 300, 100);
  S.place(3, 60, 300);

  S.draw();                       // 首帧：建精灵
  const st = S.draw();            // 次帧：应该全部命中缓存

  check('全部标签都画出来了', st.labelN === 4, `画出 ${st.labelN} 个`);
  check('零次 strokeText（描边已烘进精灵）', S.ctx.calls.strokeText === 0,
    `strokeText ${S.ctx.calls.strokeText} 次`);
  check('零次 fillText（文字已烘进精灵）', S.ctx.calls.fillText === 0,
    `fillText ${S.ctx.calls.fillText} 次`);
  check('每个标签一次 drawImage', S.ctx.calls.drawImage === st.labelN,
    `drawImage ${S.ctx.calls.drawImage} 次 / 标签 ${st.labelN} 个`);

  // 缓存复用最硬的证据：次帧没有再新建任何 canvas
  const before = madeCanvases.length;
  for (let f = 0; f < 5; f++) S.draw();
  const grow = madeCanvases.length - before;
  check('连续 5 帧不再新建任何 canvas（精灵全部命中缓存）', grow === 0,
    `新建 ${grow} 个`);
  check('缓存条目数稳定', S.renderer.labelCacheSize() === 4,
    `缓存 ${S.renderer.labelCacheSize()} 条（期望 4）`);
})();

// ===========================================================================
section('3. 悬浮标签 —— 绕过缓存，且永不被让位');
// ===========================================================================
(function testHoverLabel() {
  const S = makeScene(['abcdefg', 'abcdefg']);
  S.place(0, 100, 200);
  S.place(1, 130, 200);

  // 1 号是 §1 里【被让位】的那个（落点格 9，与 0 号的格 7 不同，
  // 但包围盒重叠）。现在悬浮它 —— 它必须被画出来。
  // hl 保持默认全 1：模式 A 只额外画 hl>=2 的邻居，这样本帧有且只有悬浮标签一个。
  const st = S.draw({ hoverIdx: 1 });
  check('悬浮的标签不被让位（模式 A 优先权）', st.labelN === 1, `画出 ${st.labelN} 个`);
  check('悬浮标签走直绘路径：strokeText + fillText 各一次',
    S.ctx.calls.strokeText === 1 && S.ctx.calls.fillText === 1,
    `strokeText ${S.ctx.calls.strokeText} / fillText ${S.ctx.calls.fillText}`);
  check('悬浮标签不吃精灵缓存', S.renderer.labelCacheSize() === 0,
    `缓存 ${S.renderer.labelCacheSize()} 条（期望 0）`);

  // 把 0 号标成邻接高亮 → 模式 A 会连它一起画。
  // ⚠ 关键：邻域标签【不做重叠让位】。它和悬浮标签的包围盒是重叠的（见 §1），
  //   但仍然必须画出来 —— 悬浮的意图就是"把这一圈邻居全亮出来"。
  //   让位只属于常态模式（§1 验的就是那个）。
  S.D.hl[0] = 2;
  const st2 = S.draw({ hoverIdx: 1 });
  check('邻域标签不受重叠让位影响（悬浮时邻居全显示）',
    st2.labelN === 2 && S.renderer.labelCacheSize() === 1,
    `画出 ${st2.labelN} 个（期望 2）/ 缓存 ${S.renderer.labelCacheSize()} 条`);

  // 回到常态 → 全部改走缓存，且不再有字形描边
  S.D.hl[0] = 1;
  const st3 = S.draw();
  check('回到常态后恢复走缓存', st3.labelN === 1 && S.renderer.labelCacheSize() === 1,
    `画出 ${st3.labelN} 个 / 缓存 ${S.renderer.labelCacheSize()} 条`);
  check('常态下无字形描边', S.ctx.calls.strokeText === 0, `strokeText ${S.ctx.calls.strokeText} 次`);
})();

// ===========================================================================
section('4. 精灵缓存有界');
// ===========================================================================
(function testCacheBounded() {
  const S = makeScene(['aaaa', 'bbbb']);
  S.place(0, 60, 200);
  S.place(1, 300, 200);

  const saved = GFI.config.render.labelCacheMax;
  GFI.config.render.labelCacheMax = 3;

  let maxSeen = 0, over = 0;
  for (let f = 0; f < 40; f++) {
    // 每帧换一套全新标签 → 每帧都是缓存未命中
    S.D.label[0] = 'x' + f.toString(36) + 'zz';
    S.D.label[1] = 'y' + f.toString(36) + 'zz';
    S.draw();
    const sz = S.renderer.labelCacheSize();
    if (sz > maxSeen) maxSeen = sz;
    if (sz > 3) over++;
  }
  check('缓存始终不超过 labelCacheMax', over === 0,
    `40 帧中越界 ${over} 次，峰值 ${maxSeen} 条（上限 3）`);
  check('超限时不会整体清空（那样会每帧重建）', maxSeen >= 2,
    `峰值 ${maxSeen} 条 —— 若为 0 说明被整体 clear 了`);

  GFI.config.render.labelCacheMax = saved;
})();

// ===========================================================================
section('5. 尺寸 / 视口裁剪');
// ===========================================================================
(function testClipping() {
  const S = makeScene(['abcdefg']);
  S.place(0, 100, 200);

  const stIn = S.draw();
  check('正常位置能画出', stIn.labelN === 1, `labelN=${stIn.labelN}`);

  // 包围盒左缘在视口内、右缘溢出 → 仍画（按真实包围盒判可见）
  S.place(0, VW - 20, 200);
  const stHalf = S.draw();
  check('一部分在视口外仍画（按包围盒判可见）', stHalf.labelN === 1, `labelN=${stHalf.labelN}`);

  // 包围盒整体推出视口右缘 → 不画
  S.place(0, VW + 10, 200);
  const stOut = S.draw();
  check('完全移出视口不画', stOut.labelN === 0, `labelN=${stOut.labelN}`);
})();

// ===========================================================================
section('6. 日记标签默认不显示（config.render.labelJournal）');
// ===========================================================================
(function testJournalLabel() {
  const S = makeScene(['我的页面', { label: '2026-09-28 Mon', kind: 'journal' }]);
  // 摆开，互不重叠
  S.place(0, 80, 200);
  S.place(1, 280, 200);

  const stOff = S.draw();
  check('默认：日记节点只显示圆点不显示名字', stOff.labelN === 1,
    `labelN=${stOff.labelN}（期望 1，只有页面）`);

  GFI.config.render.labelJournal = true;
  const stOn = S.draw();
  check('开启 labelJournal 后日记名字显示', stOn.labelN === 2, `labelN=${stOn.labelN}`);
  GFI.config.render.labelJournal = false;

  // 悬浮日记节点：邻域模式（模式 A）不受开关影响 —— 想读日期正是悬浮时
  const stHover = S.draw({ hoverIdx: 1 });
  check('悬浮日记节点时名字仍显示（模式 A 不受开关影响）', stHover.labelN === 1,
    `labelN=${stHover.labelN}（期望 1，悬浮的那个）`);
})();

// ===========================================================================
section('7. 标签淡入淡出 —— 让位不再"啪"地掐断（L1）');
// ===========================================================================
// 胜者 alpha 每帧爬升 RISE(1/6)，败者/未遍历者每帧衰减 FALL(1/4)。
// 刚起步的标签只有 1/6 余晖 → 恰好多画 1 帧；已稳定的标签 1.0 → 4 帧。
(function testLabelFade() {
  const S = makeScene(['aaaa', 'bbbb']);
  S.place(0, 100, 200);
  S.place(1, 130, 200);            // 重叠：A（index 0）先画先占

  const c = S.ctx;
  const st1 = S.draw();
  check('第一帧：胜者 A 画出，败者 B 被抑制',
    st1.labelN === 1 && c.calls.drawImage === 1,
    `labelN=${st1.labelN} drawImage=${c.calls.drawImage}`);

  // 让 B 挪开 → 两帧不重叠，两个都胜出、alpha 各自爬升
  S.place(1, 300, 200);
  S.draw();
  const st3 = S.draw();
  check('分开后两个都画出', st3.labelN === 2, `labelN=${st3.labelN}`);

  // 挪回重叠 → B 判负，但仍有 2/6 的余晖 → 幽灵补画一帧（drawImage 计 2、
  // labelN 只计胜者 1）—— 这就是「让位不掐断」的全部含义
  S.place(1, 130, 200);
  const st4 = S.draw();
  check('回归重叠：B 以幽灵余晖多画一帧',
    st4.labelN === 1 && c.calls.drawImage === 2,
    `labelN=${st4.labelN} drawImage=${c.calls.drawImage}（期望 1 / 2）`);

  // 余晖按 FALL=1/4 逐帧衰减直至归零：B 退场时已爬到 2/6，需要两帧淡完。
  // 关键不是"几帧"，而是【渐变而非掐断】—— 所以断言帧数落在 (1, 6) 开区间
  // 且幽灵 alpha 单调下降。
  const alphas = [];
  let framesToVanish = 1;    // 上面 st4 那一帧的幽灵已经画过，从 1 起算
  for (let f = 0; f < 6; f++) {
    const st = S.draw();
    if (c.calls.drawImage >= 2) {
      framesToVanish++;
      alphas.push(c.calls.alphas[1]);      // [0] 是胜者 A，[1] 才是 B 的幽灵
    } else {
      check('余晖完全消失后只剩胜者一个', st.labelN === 1 && c.calls.drawImage === 1,
        `labelN=${st.labelN} drawImage=${c.calls.drawImage}`);
      break;
    }
  }
  let monotone = true;
  for (let i = 1; i < alphas.length; i++) if (alphas[i] >= alphas[i - 1]) monotone = false;
  check('余晖渐变收敛（1 < 帧数 < 6，alpha 单调降）',
    framesToVanish > 1 && framesToVanish < 6 && monotone,
    `${framesToVanish} 帧淡完 [${alphas.map((x) => x.toFixed(3)).join(' → ')}]`);
})();

// ===========================================================================
section('8. 胜者滞回 —— 让位胜负不许帧间翻转（L2）');
// ===========================================================================
// 占位格每帧清零，胜负由遍历顺序决定；顺序里的空间序随漂移/平移变化，
// 于是竞争区标签一闪一闪。修法是上一帧的胜者先画先占（H 遍）。
(function testLabelHysteresis() {
  const S = makeScene(['aaaa', 'bbbb']);
  const D = S.D, c = S.ctx;

  // 人为设定名次：B 的 rank 更小（=度数更高）→ 无滞回时 N 遍里 B 必胜
  D.labelRank[0] = 200;
  D.labelRank[1] = 0;
  S.place(0, 100, 200);
  S.place(1, 130, 200);            // 重叠

  S.draw();
  const bSprite = c.calls.srcs[c.calls.srcs.length - 1];
  check('首帧按名次：高名次 B 占位（A 让位）', c.calls.drawImage >= 1,
    `drawImage=${c.calls.drawImage}`);

  // 翻转名次：A 变成 rank 0。若无滞回，N 遍里 A 会在第一个档位把格子抢走
  // → 胜者从 B 翻到 A（视觉上就是闪一下）。
  D.labelRank[0] = 0;
  D.labelRank[1] = 200;
  S.draw();
  const winner2 = c.calls.srcs[0];
  check('名次反转后：胜者仍是上一帧的 B（滞回守擂）',
    winner2 === bSprite, winner2 === bSprite ? '同一张精灵' : '胜者被翻转了');

  // 相机突变（k 变化 > 10%）必须作废滞回 —— 否则陈旧胜者会挂在失效位置上
  S.cam.k = 1.5;
  S.draw();
  const winner3 = c.calls.srcs[0];
  check('相机突变后滞回作废：A 按新名次夺回格子',
    winner3 !== bSprite, winner3 !== bSprite ? '已重排' : '仍挂着陈旧胜者');
  S.cam.k = 1;
})();

// ===========================================================================
section('9. 全局淡变系数 —— labelsOn 不再瞬切（L3）');
// ===========================================================================
(function testGlobalFade() {
  const S1 = makeScene(['aaaa']);
  S1.place(0, 100, 200);
  const c1 = S1.ctx;
  const a = [];
  for (let f = 0; f < 8; f++) { S1.draw({ labelFade: 1 }); a.push(c1.calls.alphas[c1.calls.alphas.length - 1]); }
  const full = a[a.length - 1];

  const S2 = makeScene(['aaaa']);
  S2.place(0, 100, 200);
  const c2 = S2.ctx;
  const b = [];
  for (let f = 0; f < 8; f++) { S2.draw({ labelFade: 0.5 }); b.push(c2.calls.alphas[c2.calls.alphas.length - 1]); }
  const half = b[b.length - 1];

  check('alpha 逐帧爬升（不是一步到位）', a[0] < a[3] && a[3] < a[7],
    `帧 1/4/8 = ${a[0].toFixed(3)} / ${a[3].toFixed(3)} / ${a[7].toFixed(3)}`);
  check('全局系数线性缩放 alpha', Math.abs(half * 2 - full) < 1e-4,
    `全亮 ${full.toFixed(4)} vs 半亮 ${half.toFixed(4)}`);

  const S3 = makeScene(['aaaa']);
  S3.place(0, 100, 200);
  const st0 = S3.draw({ labelFade: 0 });
  check('labelFade = 0：整层跳过（一个标签都不画）',
    st0.labelN === 0 && S3.ctx.calls.drawImage === 0,
    `labelN=${st0.labelN} drawImage=${S3.ctx.calls.drawImage}`);
})();

// ===========================================================================
section('10. 标签绝对摆放 —— 节点正下方、水平居中');
// ===========================================================================
// ⚠ 上面所有几何断言都建立在 place() 之上，而 place() 是摆放公式的【逆运算】：
//   摆法整体平移时【相对】几何不变，断言照样全绿 —— 实测把标签改到节点【上方】，
//   35 项依然全过。所以摆法本身必须单独钉一条【绝对坐标】的断言，不能靠 place()。
(function testLabelPlacement() {
  const S = makeScene(['abcd']);
  const nodeX = 200, nodeY = 150;
  // 直接摆节点，【不】经过 place() —— 那个函数会按摆法反解，把摆法错误掩盖掉
  S.D.x[0] = screenToWorldX(nodeX);
  S.D.y[0] = screenToWorldY(nodeY);
  const st = S.draw();

  check('画出了一个标签', st.labelN === 1, `labelN=${st.labelN}`);
  const d = S.ctx.calls.dsts[0];
  if (!d) { check('拿到了 drawImage 的目标矩形', false, '没有 drawImage'); return; }

  const rScr = Math.max(2, S.D.radius[0] * S.D.scaleMul[0] * S.cam.k);
  const w = labelW('abcd');
  // blit 的目标矩形会按设备像素取整（dpr=2 → 舍入误差 ≤ 0.25px），留 0.51 余量
  const TOL = 0.51;

  check('精灵水平居中于节点（左缘 + 宽/2 == 节点 x）',
    Math.abs(d.dx + d.dw / 2 - nodeX) <= TOL,
    `中心 ${(d.dx + d.dw / 2).toFixed(2)} vs 节点 ${nodeX}`);
  // 精灵上缘 = 节点下缘 + 间隙 + (盒半高 − 文字半高)，即【文字】上缘正好在 节点下缘+3
  const boxTop = nodeY + rScr + 3 + (BOX_H * 0.5 - PAD) - BOX_H * 0.5;
  check('文字上缘 == 节点下缘 + 3（间隙按文字算，不按精灵盒）',
    Math.abs(d.dy - boxTop) <= TOL,
    `上缘 ${d.dy.toFixed(2)} vs 期望 ${boxTop.toFixed(2)}`);
  check('精灵宽度 == 文字宽 + 两侧 pad', Math.abs(d.dw - w) <= TOL, `${d.dw} vs ${w}`);
  check('精灵高度 == 标签盒高', Math.abs(d.dh - BOX_H) <= TOL, `${d.dh} vs ${BOX_H}`);
})();

// ===========================================================================
section('11. labelYield = false（Obsidian 默认）—— 每个节点都画名字，不互相让位');
// ===========================================================================
// 查证：Obsidian 官方（论坛 Bug graveyard 帖「Graph view - titles overlap」）明确
// 拒绝做标签碰撞 ——「想读文字就放大；只想看节点位置就缩小，文字会消失」。
// 其 forceCollide 也只按节点半径算，标签不参与布局。所以它的做法就是：全画、允许
// 重叠，密度只靠缩放淡变控制（main.js 的 labelFade）。
// 本文件开头把 labelYield 设成了 true 以便覆盖让位机制，这一节把它切回产品默认值。
(function testNoYield() {
  const prev = GFI.config.render.labelYield;

  // ---- 六个标签全叠在同一点 ----
  GFI.config.render.labelYield = false;
  const S = makeScene(['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff']);
  for (let i = 0; i < 6; i++) S.place(i, 120, 120);
  const stOff = S.draw();
  check('全部重叠时仍画出全部 6 个（不让位）', stOff.labelN === 6, `labelN=${stOff.labelN}`);

  // ---- 对照：同一场景打开让位必须只剩一个，证明上一条不是恒真 ----
  GFI.config.render.labelYield = true;
  const S2 = makeScene(['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff']);
  for (let i = 0; i < 6; i++) S2.place(i, 120, 120);
  const stOn = S2.draw();
  check('同场景开启让位后只剩 1 个（对照，防上一条假通过）', stOn.labelN === 1, `labelN=${stOn.labelN}`);

  // ---- force 路径不能顺手绕过其它过滤：日记开关必须照样生效 ----
  GFI.config.render.labelYield = false;
  const S3 = makeScene(['普通页', { label: '2026-09-28 Mon', kind: 'journal' }]);
  S3.place(0, 80, 200);
  S3.place(1, 300, 200);
  const stJ = S3.draw();
  check('关掉让位后日记标签仍被跳过（force 只跳过占位，不跳过过滤）', stJ.labelN === 1,
    `labelN=${stJ.labelN}（期望 1，只有页面）`);

  // ---- 重叠的标签必须【变暗】（这是"重叠易混淆"的对策：名字不丢，但退到背景）----
  GFI.config.render.labelYield = false;
  const S4 = makeScene(['aaa', 'bbb']);
  S4.place(0, 120, 120);
  S4.place(1, 120, 120);          // 完全重叠
  const stD = S4.draw();
  const al = S4.ctx.calls.alphas;
  check('重叠的两个都画出来了', stD.labelN === 2, `labelN=${stD.labelN}`);
  check('后画的那个被压暗（alpha 明显更低）',
    al.length === 2 && al[1] < al[0] * 0.99,
    `alphas=${al.map((v) => v.toFixed(3)).join(' / ')}`);
  check('压暗倍率 = config.render.labelOverlapDim',
    al.length === 2 && Math.abs(al[1] / Math.max(1e-9, al[0]) - GFI.config.render.labelOverlapDim) < 0.02,
    `比值 ${(al[1] / Math.max(1e-9, al[0])).toFixed(3)} vs ${GFI.config.render.labelOverlapDim}`);

  // ---- 稀疏场景两种策略结果必须一致 ----
  const sparse = (yieldOn) => {
    GFI.config.render.labelYield = yieldOn;
    const Sx = makeScene(['aaa', 'bbb']);
    Sx.place(0, 60, 60);
    Sx.place(1, 320, 320);
    return Sx.draw().labelN;
  };
  check('稀疏场景两种策略一致（都是 2）', sparse(false) === 2 && sparse(true) === 2,
    `off=${sparse(false)} on=${sparse(true)}`);

  GFI.config.render.labelYield = prev;
})();

// ===========================================================================
section('12. 出生淡入必须【连续】—— 不能被 8 级量化切成台阶');
// ===========================================================================
// 背景：drawCores 为了批处理（一次 fill 只能一个 globalAlpha）把 alpha 量化成 8 级。
// 出生中的节点因此会变成：
//   · 台阶 +0.143（Obsidian 的连续曲线是 +0.100）
//   · a ∈ [6/7, 1) 全被压成 0.9286 —— 实测最后连续 24 帧（0.4 秒）画面纹丝不动，
//     然后猛地跳到 1.0。观感就是「节点一下子蹦出来」。
// 修法：出生中的节点（popT 为数字）不进桶，走 drawMidBirth 的【精确 alpha】路径。
(function testBirthAlpha() {
  const S = makeScene(['a', 'b', 'c', 'd', 'e']);
  const D = S.D;
  // 摆到互不重合的位置，便于按圆心反查每个圆的 alpha
  for (let i = 0; i < 5; i++) {
    D.x[i] = screenToWorldX(60 + i * 70);
    D.y[i] = screenToWorldY(200);
    D.visible[i] = 1;
  }
  // 0/1/2/3 出生中（popT 为数字）；4 是常态节点
  const VALS = [0.103, 0.342, 0.721, 0.950];
  const EXPECT_Q = [0.0714, 0.3571, 0.7857, 0.9286];   // 量化后本会变成的值
  for (let i = 0; i < 4; i++) { D.popT[i] = 0; D.renderAlpha[i] = VALS[i]; }
  D.popT[4] = NaN; D.renderAlpha[4] = 0.342;

  S.draw({});
  const arcs = S.ctx.calls.arcs;
  const alphaAt = (i) => {
    const sx = S.cam.worldToScreenX(D.x[i]), sy = S.cam.worldToScreenY(D.y[i]);
    const hit = arcs.find((c) => Math.abs(c.x - sx) < 0.6 && Math.abs(c.y - sy) < 0.6);
    return hit ? hit.a : null;
  };

  let ok = true, detail = [];
  for (let i = 0; i < 4; i++) {
    const got = alphaAt(i);
    if (got === null || Math.abs(got - VALS[i]) > 1e-6) ok = false;
    detail.push(`n${i}: ${got === null ? "没画" : got.toFixed(4)}(期望${VALS[i].toFixed(3)})`);
  }
  check('出生中的节点按【精确 alpha】绘制（4 个不同值全部命中）', ok, detail.join(' '));

  const q4 = alphaAt(4);
  check('对照：常态节点仍然走 8 级量化（批处理路径没被破坏）',
    q4 !== null && Math.abs(q4 - 2.5 / 7) < 1e-9,
    `n4 alpha=${q4 === null ? "没画" : q4.toFixed(4)}，量化值应为 2.5/7=0.35714（原始 0.342）`);

  const q4raw = q4 !== null;
  check('且这个值确实【不等于】原值 —— 证明对照有效（不是恰好相等）',
    q4raw && Math.abs(q4 - 0.342) > 1e-3,
    `|${q4 === null ? 0 : q4.toFixed(4)} − 0.342| = ${q4 === null ? 0 : Math.abs(q4 - 0.342).toFixed(4)}`);

  // 曾经的死区：a ∈ [6/7, 1) 一律 0.9286，直到 44 帧收尾才跳 1.0
  const hi = alphaAt(3);
  check('a=0.950 不再被压成 0.9286（原来的 24 帧死区）',
    hi !== null && Math.abs(hi - 0.95) < 1e-6 && Math.abs(hi - 0.9286) > 1e-3,
    `alpha=${hi === null ? "没画" : hi.toFixed(4)}`);
})();
// ===========================================================================
section('13. 边必须跟着节点淡入 —— 不能满亮度瞬现');
// ===========================================================================
// Obsidian 的连边也在缓动：app.js 连边类 render() 里 `n.alpha = uZ(n.alpha, c)`，
// 初始值是 initGraphics 给的 cZ·颜色alpha（cZ=0.2，只有两成）。
// 而我们原先是一条 path 一次性 stroke 全亮度，且边的可见性是二值的
// （visible[] 在 beginReveal 里立刻置 1）—— 出生那一帧就会冒出一条满亮度的线，
// 挂在一个 alpha 才 0.1 的节点上。这是「节点出现得突然」的最后一个来源。
(function testEdgeFade() {
  const nodes = [{ id: 'a', label: 'a', kind: 'page' }, { id: 'b', label: 'b', kind: 'page' }];
  const links = [{ source: 'a', target: 'b' }];
  const D = GFI.Data.build(nodes, links, null);
  const cam = GFI.Camera.create(VW, VH);
  cam.k = 1; cam.x = 0; cam.y = 0;
  const canvas = makeStubCanvas();
  const renderer = GFI.Renderer.create(canvas, D, cam);
  renderer.resize(VW, VH, DPR);
  D.x[0] = screenToWorldX(100); D.y[0] = screenToWorldY(200);
  D.x[1] = screenToWorldX(300); D.y[1] = screenToWorldY(200);
  D.visible[0] = 1; D.visible[1] = 1;
  const ctx = canvas.getContext(2 ? "2d" : "2d");
  const clear = () => { for (const kk in ctx.calls) {
    if (Array.isArray(ctx.calls[kk])) ctx.calls[kk].length = 0; else ctx.calls[kk] = 0; } };

  // 一端刚出生（alpha 0.3），另一端早已就位（alpha 1）
  D.renderAlpha[0] = 0.30; D.renderAlpha[1] = 1.0;
  clear();
  renderer.render({ hoverIdx: -1, selectedIdx: -1, lod: 0, labelsOn: false });
  const a1 = ctx.calls.strokeAlphas.slice();
  check("新节点那侧的边按 min(两端 alpha) 淡入（不是满亮度）",
    a1.length === 1 && Math.abs(a1[0] - 0.30) < 1e-6,
    `stroke globalAlpha=[${a1.map((v) => v.toFixed(3)).join(", ")}]（期望 0.300）`);

  // 对照：两端都到 1 之后必须回到批量路径（一帧一次 stroke，alpha=1）
  D.renderAlpha[0] = 1.0;
  clear();
  renderer.render({ hoverIdx: -1, selectedIdx: -1, lod: 0, labelsOn: false });
  const a2 = ctx.calls.strokeAlphas.slice();
  check("两端都出现后回到批量路径（一次 stroke、alpha=1，没有逐条退化）",
    a2.length === 1 && Math.abs(a2[0] - 1) < 1e-6,
    `stroke 次数=${a2.length}，alpha=[${a2.map((v) => v.toFixed(3)).join(", ")}]`);

  // 反向：把 alpha 调到稳态值 1 之前的典型中间值，再验一次（防止上面只是特例）
  D.renderAlpha[0] = 0.72;
  clear();
  renderer.render({ hoverIdx: -1, selectedIdx: -1, lod: 0, labelsOn: false });
  const a3 = ctx.calls.strokeAlphas.slice();
  check("中间值同样精确（0.72，不是被量化/被忽略）",
    a3.length === 1 && Math.abs(a3[0] - 0.72) < 1e-6,
    `stroke globalAlpha=[${a3.map((v) => v.toFixed(3)).join(", ")}]`);
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
