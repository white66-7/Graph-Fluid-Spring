/*
 * GFI.Renderer — Canvas2D 绘制
 * ===========================================================================
 * 性能铁律（违反任何一条都会掉到 10fps 以下）：
 *
 *   1. 【绝不用 shadowBlur】—— 它是 Chromium Canvas2D 里每次绘制的 CPU 高斯模糊，
 *      比普通填充慢 30~100×。3000 节点下是 3ms 和 300ms 的差别。
 *      辉光改用预渲染的离屏径向渐变精灵 + 'lighter' 混合。
 *
 *   2. 【不用 Path2D】—— 它没有 clear()，每帧都得新建 = 每帧分配。
 *      用 ctx.beginPath()/moveTo/lineTo + 单次 stroke()，零分配且一样快。
 *
 *   3. 【ctx 始终留在屏幕空间】—— 不做 ctx.scale(k,k) 的世界变换。
 *      那会缩放线宽（0.15px 的边直接消失），还会逼着字号和精灵尺寸走变换。
 *      12000 个端点换算约 0.1ms，换来对线宽/字号/精灵分桶的完全控制。
 *
 *   4. 【绝不每帧拼 rgba(...) 字符串】—— 用 ctx.globalAlpha 存浮点。
 *
 * 绘制顺序（Obsidian 是边在节点下面）：
 *   清屏 → 剔除 → 辉光(lighter) → 边 → 节点头 → 标签 → 覆盖层
 */
(function (GFI) {
  'use strict';
  if (GFI.Renderer) return;

  const { clamp, hexToRgb } = GFI.util;
  const TAU = Math.PI * 2;

  function create(canvas, D, cam) {
    const rcfg = GFI.config.render;
    const topDoc = GFI.topDoc;

    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('[GFI] 无法获取 2D 上下文');

    let dpr = 1;
    let W = 1, H = 1;                 // CSS 像素尺寸
    let bgColor = rcfg.bgFallback;

    // 预分配绘制表
    let nodeList = new Int32Array(Math.max(64, D.n));
    let edgeList = new Int32Array(Math.max(64, D.m));
    let nodeCount = 0, edgeCount = 0;

    // 剔除复用物理的空间网格。模拟睡着时网格是上一次构建的 —— 那种情况下
    // 没有任何东西移动过，所以那张旧网格恰好是精确的，平移缩放零成本。
    let cullGrid = null;

    // 标签测量缓存 —— measureText 单次 5~20µs，220 个标签不缓存就是整个标签预算
    const measureCache = new Map();

    // 标签占位网格（抑制密集处互相糊）
    let occW = 0, occH = 0;
    let occGrid = new Uint8Array(0);

    // 精灵缓存
    const spriteCache = new Map();
    const BUCKETS = rcfg.glowRadiusBuckets;
    // 半径(整数) → 桶索引 的查表，避免每帧搜索
    const bucketLut = new Uint8Array(256);
    (function buildLut() {
      let bi = 0;
      for (let r = 0; r < 256; r++) {
        while (bi < BUCKETS.length - 1 && BUCKETS[bi] < r) bi++;
        bucketLut[r] = bi;
      }
    })();

    const rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

    // 节点头的分桶：colorIdx × 8 级 alpha × 2 级明暗。
    // 为什么不用逐节点 globalAlpha —— 一次 fill() 只能有一个 alpha，
    // 逐节点画会退化成 3000 次 fill。计数排序把它们重新聚成几十个批次。
    const ALPHA_LEVELS = 8;
    let bucketCount = new Uint32Array(0);
    let bucketStart = new Uint32Array(0);
    let bucketCursor = new Uint32Array(0);
    let bucketed = new Int32Array(0);

    function ensureBuckets(nBuckets, n) {
      if (bucketCount.length < nBuckets + 1) {
        bucketCount = new Uint32Array(nBuckets + 1);
        bucketStart = new Uint32Array(nBuckets + 1);
        bucketCursor = new Uint32Array(nBuckets + 1);
      }
      if (bucketed.length < n) bucketed = new Int32Array(n);
    }

    // alpha → 量化等级。最高级必须精确等于 1.0，否则全不透明的节点会被整体压暗
    function alphaLevel(a) {
      return a >= 0.985
        ? ALPHA_LEVELS - 1
        : Math.min(ALPHA_LEVELS - 2, (a * (ALPHA_LEVELS - 1)) | 0);
    }
    function levelAlpha(l) {
      return l === ALPHA_LEVELS - 1 ? 1 : (l + 0.5) / (ALPHA_LEVELS - 1);
    }

    // -----------------------------------------------------------------------
    // 尺寸 / DPR
    // -----------------------------------------------------------------------
    function resize(cssW, cssH, newDpr) {
      if (newDpr !== undefined && newDpr !== dpr) {
        dpr = newDpr;
        invalidateSprites();          // 精灵是按 DPR 分辨率渲染的
      }
      W = Math.max(1, cssW);
      H = Math.max(1, cssH);
      const pw = Math.max(1, Math.round(W * dpr));
      const ph = Math.max(1, Math.round(H * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      // 基础变换只设一次；之后 ctx 坐标 == CSS 像素
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (D.n > nodeList.length) nodeList = new Int32Array(D.n);
      if (D.m > edgeList.length) edgeList = new Int32Array(D.m);
    }

    // -----------------------------------------------------------------------
    // 辉光精灵
    // -----------------------------------------------------------------------
    function makeGlowSprite(hex) {
      const rgb = hexToRgb(hex);
      const spread = rcfg.glowSpread;
      // 精灵按最大桶尺寸渲染，绘制时缩放到目标尺寸 —— 这样每种颜色只需要一张
      const rCss = BUCKETS[BUCKETS.length - 1];
      const size = Math.max(4, Math.ceil(2 * spread * rCss * dpr));
      const c = topDoc.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d');
      const half = size * 0.5;
      const grad = g.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0.00, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
      grad.addColorStop(0.28, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`);
      grad.addColorStop(0.60, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.12)`);
      grad.addColorStop(1.00, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      return c;
    }

    function getGlowSprite(hex) {
      let s = spriteCache.get(hex);
      if (!s) { s = makeGlowSprite(hex); spriteCache.set(hex, s); }
      return s;
    }

    function invalidateSprites() { spriteCache.clear(); }

    // -----------------------------------------------------------------------
    // 剔除
    // -----------------------------------------------------------------------
    function cull(extraMargin) {
      cam.visibleRect(extraMargin, rect);
      const grid = cullGrid;
      if (grid && grid.cols) {
        nodeCount = grid.collectRect(D, rect.x0, rect.y0, rect.x1, rect.y1, nodeList, D.visible);
      } else {
        nodeCount = 0;
        for (let i = 0; i < D.n; i++) if (D.visible[i]) nodeList[nodeCount++] = i;
      }

      // 边：线段包围盒与视口求交。
      // ⚠ 不要用「两端都在视口内」——放大或图谱较大时，大量边都有一端在视口外，
      //   那条件会把它们全丢掉，看起来就是"连线不见了"。
      // 可见性直接查 visible[]：D.lvisible 只在 build 时写过一次、之后没人维护，
      //   拿它判断会让已隐藏节点的边残留（时间轴擦除时尤其明显）。
      const { lsrc, ltgt, x, y, visible } = D;
      edgeCount = 0;
      const cap = edgeList.length;
      for (let e = 0; e < D.m; e++) {
        const s = lsrc[e], t = ltgt[e];
        if (!visible[s] || !visible[t]) continue;
        const sx = x[s], sy = y[s], tx = x[t], ty = y[t];
        if ((sx < rect.x0 && tx < rect.x0) || (sx > rect.x1 && tx > rect.x1)) continue;
        if ((sy < rect.y0 && ty < rect.y0) || (sy > rect.y1 && ty > rect.y1)) continue;
        if (edgeCount >= cap) break;
        edgeList[edgeCount++] = e;
      }
    }

    // -----------------------------------------------------------------------
    // 主绘制
    // -----------------------------------------------------------------------
    /**
     * @param {object} view { hoverIdx, selectedIdx, lod, labelsOn }
     */
    function render(view) {
      const t0 = GFI.util.now();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);      // 背景靠 canvas 的 CSS background，省掉全屏 fillRect

      if (!D.n) return { cull: 0, total: GFI.util.now() - t0 };

      const maxR = rcfg.radiusMax;
      cull(maxR + 16);
      const tCull = GFI.util.now();

      const hoverIdx = view.hoverIdx | 0;
      const selectedIdx = view.selectedIdx | 0;
      const hot = hoverIdx >= 0 ? hoverIdx : selectedIdx;
      const lod = clamp(view.lod | 0, 0, GFI.config.lod.levels.length - 1);
      const lodCfg = GFI.config.lod.levels[lod];
      const k = cam.k;

      drawEdges(hot, k);
      const tEdges = GFI.util.now();

      drawGlow(nodeList, nodeCount, lodCfg, k, hoverIdx, selectedIdx);
      const tGlow = GFI.util.now();

      drawCores(nodeList, nodeCount, k, lodCfg, hoverIdx);
      const tCore = GFI.util.now();

      if (view.labelsOn) drawLabels(nodeList, nodeCount, lodCfg, k, hot);
      const tLabel = GFI.util.now();

      drawOverlay(hoverIdx, selectedIdx, k, lodCfg);
      const tEnd = GFI.util.now();

      return {
        cull: +(tEdges - tCull).toFixed(3),
        edges: +(tGlow - tEdges).toFixed(3),
        glow: +(tCore - tGlow).toFixed(3),
        cores: +(tLabel - tCore).toFixed(3),
        labels: +(tEnd - tLabel).toFixed(3),
        total: +(tEnd - t0).toFixed(3),
        nodes: nodeCount,
        edgesN: edgeCount,
        // 排查"连线看不见"用：hot >= 0 时大部分边会被压到 edgeColorDim
        hot: hot,
        边色: hot < 0 ? rcfg.edgeColor : rcfg.edgeColorHi,
        压暗色: rcfg.edgeColorDim,
      };
    }

    // -----------------------------------------------------------------------
    // 边：三个色类 → 最多 3 次 stroke()
    // -----------------------------------------------------------------------
    function drawEdges(hot, k) {
      if (!edgeCount) return;
      const { lsrc, ltgt, x, y, hl } = D;
      const wNormal = clamp(rcfg.edgeWidthBase + rcfg.edgeWidthSlope * k, rcfg.edgeWidthMin, rcfg.edgeWidthMax);
      const wHi = Math.max(1.0, wNormal * 1.4);

      if (hot < 0) {
        ctx.strokeStyle = rcfg.edgeColor;
        ctx.lineWidth = wNormal;
        ctx.beginPath();
        for (let p = 0; p < edgeCount; p++) {
          const e = edgeList[p];
          const s = lsrc[e], t = ltgt[e];
          ctx.moveTo(cam.worldToScreenX(x[s]), cam.worldToScreenY(y[s]));
          ctx.lineTo(cam.worldToScreenX(x[t]), cam.worldToScreenY(y[t]));
        }
        ctx.stroke();
        return;
      }

      // 有高亮：分两趟（压暗的 / 高亮的）
      ctx.strokeStyle = rcfg.edgeColorDim;
      ctx.lineWidth = wNormal;
      ctx.beginPath();
      for (let p = 0; p < edgeCount; p++) {
        const e = edgeList[p];
        const s = lsrc[e], t = ltgt[e];
        if (hl[s] >= 2 && hl[t] >= 2) continue;
        ctx.moveTo(cam.worldToScreenX(x[s]), cam.worldToScreenY(y[s]));
        ctx.lineTo(cam.worldToScreenX(x[t]), cam.worldToScreenY(y[t]));
      }
      ctx.stroke();

      ctx.strokeStyle = rcfg.edgeColorHi;
      ctx.lineWidth = wHi;
      ctx.beginPath();
      for (let p = 0; p < edgeCount; p++) {
        const e = edgeList[p];
        const s = lsrc[e], t = ltgt[e];
        if (!(hl[s] >= 2 && hl[t] >= 2)) continue;
        ctx.moveTo(cam.worldToScreenX(x[s]), cam.worldToScreenY(y[s]));
        ctx.lineTo(cam.worldToScreenX(x[t]), cam.worldToScreenY(y[t]));
      }
      ctx.stroke();
    }

    // -----------------------------------------------------------------------
    // 辉光：预渲染精灵 + 'lighter' 累加
    // Obsidian 的 bloom 就是这么来的 —— 重叠处自然叠加变亮，白送
    // -----------------------------------------------------------------------
    function drawGlow(list, count, lodCfg, k, hoverIdx, selectedIdx) {
      if (lodCfg.glow === 'hover' && hoverIdx < 0 && selectedIdx < 0) return;

      const { x, y, radius, renderAlpha, scaleMul, colorIdx, deg, hl, visible } = D;
      const table = D.colorTable;
      const spread = rcfg.glowSpread;
      const minScale = lodCfg.glowMinScale;

      ctx.globalCompositeOperation = 'lighter';
      let lastIdx = -1;
      let sprite = null;

      for (let p = 0; p < count; p++) {
        const i = list[p];
        if (!visible[i]) continue;
        const a = renderAlpha[i];
        if (a <= 0.01) continue;
        if (k < minScale) continue;
        if (lodCfg.glow === 'deg2' && deg[i] < 2) continue;
        if (lodCfg.glow === 'hover' && i !== hoverIdx && i !== selectedIdx) continue;

        const rScreen = Math.max(0.8, radius[i] * scaleMul[i] * k);
        const ci = colorIdx[i];
        if (ci !== lastIdx) { lastIdx = ci; sprite = getGlowSprite(table[ci]); }

        // 辉光强度跟着缩放走：放得很大时不该糊成一团光
        const glowGain = clamp(1.15 - 0.35 * Math.log10(Math.max(1, rScreen)), 0.25, 1.15);
        const half = spread * rScreen;
        const dim = hl[i] === 0 ? 0.3 : 1;
        ctx.globalAlpha = clamp(a * glowGain * dim, 0, 1);

        const sx = cam.worldToScreenX(x[i]) - half;
        const sy = cam.worldToScreenY(y[i]) - half;
        ctx.drawImage(sprite, sx, sy, half * 2, half * 2);
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // -----------------------------------------------------------------------
    // 节点头：按颜色分组，每组一次 fill()
    // -----------------------------------------------------------------------
    function drawCores(list, count, k, lodCfg, hoverIdx) {
      const { x, y, radius, renderAlpha, scaleMul, colorIdx, hl, visible } = D;
      const table = D.colorTable;
      const nColors = table.length;
      const nBuckets = nColors * ALPHA_LEVELS * 2;   // [color][alphaLevel][dim]
      ensureBuckets(nBuckets, count);

      bucketCount.fill(0, 0, nBuckets);

      // ---- 计数 ----
      let total = 0;
      for (let p = 0; p < count; p++) {
        const i = list[p];
        if (!visible[i]) continue;
        const a = renderAlpha[i];
        if (a <= 0.01) continue;
        const dim = hl[i] === 0 ? 1 : 0;
        bucketCount[(colorIdx[i] * ALPHA_LEVELS + alphaLevel(a)) * 2 + dim]++;
        total++;
      }
      if (!total) { ctx.globalAlpha = 1; return; }

      // ---- 前缀和 ----
      let acc = 0;
      for (let b = 0; b < nBuckets; b++) { bucketStart[b] = acc; acc += bucketCount[b]; }
      bucketStart[nBuckets] = acc;
      bucketCursor.set(bucketStart.subarray(0, nBuckets + 1));

      // ---- 散射 ----
      for (let p = 0; p < count; p++) {
        const i = list[p];
        if (!visible[i]) continue;
        const a = renderAlpha[i];
        if (a <= 0.01) continue;
        const dim = hl[i] === 0 ? 1 : 0;
        bucketed[bucketCursor[(colorIdx[i] * ALPHA_LEVELS + alphaLevel(a)) * 2 + dim]++] = i;
      }

      // ---- 每个非空桶一次 beginPath/fill ----
      const perColor = ALPHA_LEVELS * 2;
      for (let b = 0; b < nBuckets; b++) {
        const s = bucketStart[b], e = bucketStart[b + 1];
        if (s === e) continue;

        const colorI = (b / perColor) | 0;
        const rem = b - colorI * perColor;
        const alvl = (rem / 2) | 0;
        const dim = rem & 1;

        ctx.fillStyle = table[colorI];
        ctx.globalAlpha = levelAlpha(alvl) * (dim ? 0.35 : 1);
        ctx.beginPath();
        for (let p = s; p < e; p++) {
          const i = bucketed[p];
          const r = Math.max(0.6, radius[i] * scaleMul[i] * k);
          const sx = cam.worldToScreenX(x[i]);
          const sy = cam.worldToScreenY(y[i]);
          // moveTo 起新子路径，否则 arc 之间会连成一片
          ctx.moveTo(sx + r, sy);
          ctx.arc(sx, sy, r, 0, TAU);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // -----------------------------------------------------------------------
    // 标签
    // -----------------------------------------------------------------------
    function measure(text) {
      let w = measureCache.get(text);
      if (w === undefined) {
        w = ctx.measureText(text).width;
        measureCache.set(text, w);
      }
      return w;
    }

    function drawLabels(list, count, lodCfg, k, hot) {
      if (!count) return;

      // 占位网格
      const cell = rcfg.labelCell;
      const cw = Math.ceil(W / cell), ch = Math.ceil(H / cell);
      if (cw !== occW || ch !== occH) {
        occW = cw; occH = ch;
        occGrid = new Uint8Array(Math.max(1, cw * ch));
      } else {
        occGrid.fill(0);
      }

      const { x, y, label, labelRank, radius, renderAlpha, scaleMul, visible, hl } = D;
      const n = D.n;
      // labelRank 是均匀分布在 0..255 的名次（0 = 度数最高）；据此换算阈值按名次截断。
      // 取两个上限的较小者：LOD 档位的 labelCap，以及按节点总数算的比例上限 ——
      // 后者保证小图谱也不会"每个节点都带标签"。
      const cap = Math.min(lodCfg.labelCap, Math.max(8, Math.round(n * rcfg.labelMaxRatio)));
      const rankCap = n > 1 ? Math.min(255, Math.floor((cap / (n - 1)) * 255)) : 255;

      ctx.font = rcfg.labelFont;
      ctx.strokeStyle = rcfg.labelHaloColor;
      ctx.lineWidth = rcfg.labelHaloWidth;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;

      // ---- 模式 A：悬浮/选中时，只显示该节点与它直接相连的邻居 ----
      // 这是一条明确的规则，而不是"按名次截一部分"——
      // 视线聚焦在邻域上，其余标签全部让位。
      if (hot >= 0) {
        ctx.globalAlpha = 1;
        // 悬浮的那个先画，占位格的优先权归它
        if (visible[hot]) {
          ctx.fillStyle = rcfg.labelColorHi;
          drawOne(hot, cell, cw, ch, x, y, label, radius, scaleMul, k, true);
        }
        ctx.fillStyle = rcfg.labelColor;
        ctx.globalAlpha = rcfg.labelAlpha;
        for (let p = 0; p < count; p++) {
          const i = list[p];
          if (i === hot || !visible[i] || hl[i] < 2) continue;
          if (renderAlpha[i] < 0.55) continue;
          drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, false);
        }
        return;
      }

      // ---- 模式 B：常态下按度数名次画到上限 ----
      // 分档遍历：度数高的先画、先占住占位格。
      // 直接一趟遍历 nodeList 的话，先到先得的是网格顺序（≈空间顺序），
      // 密集区里谁能留下完全随机，hub 反而可能被叶子挤掉。
      ctx.fillStyle = rcfg.labelColor;
      ctx.globalAlpha = rcfg.labelAlpha;
      const PASSES = 4;
      const step = Math.max(1, Math.ceil((rankCap + 1) / PASSES));
      for (let lo = -1; lo < rankCap; lo += step) {
        const hi = Math.min(rankCap, lo + step);
        for (let p = 0; p < count; p++) {
          const i = list[p];
          if (!visible[i]) continue;
          const rk = labelRank[i];
          if (rk <= lo || rk > hi) continue;
          if (renderAlpha[i] < 0.55) continue;
          drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, false);
        }
      }
    }

    function drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, force) {
      const text = label[i];
      if (!text) return;
      const sx = cam.worldToScreenX(x[i]);
      const sy = cam.worldToScreenY(y[i]) - Math.max(3, radius[i] * scaleMul[i] * k + 9);
      if (sx < -60 || sx > W + 60 || sy < -20 || sy > H + 20) return;

      const gx = (sx / cell) | 0;
      const gy = (sy / cell) | 0;
      if (gx < 0 || gy < 0 || gx >= cw || gy >= ch) return;
      const gi = gy * cw + gx;
      if (!force && occGrid[gi]) return;             // 密集处互相抑制
      occGrid[gi] = 1;

      const shown = text.length > rcfg.labelMaxChars
        ? text.slice(0, rcfg.labelMaxChars - 1) + '…'
        : text;
      // 先描边再加字 —— 深色光晕把文字从辉光背景里"抠"出来
      if (rcfg.labelHaloWidth > 0) ctx.strokeText(shown, sx, sy);
      ctx.fillText(shown, sx, sy);
    }

    // -----------------------------------------------------------------------
    // 覆盖层：hover 环 / 选中环
    // -----------------------------------------------------------------------
    function drawOverlay(hoverIdx, selectedIdx, k, lodCfg) {
      if (hoverIdx >= 0) {
        const r = Math.max(3, D.radius[hoverIdx] * D.scaleMul[hoverIdx] * k) + 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cam.worldToScreenX(D.x[hoverIdx]), cam.worldToScreenY(D.y[hoverIdx]), r, 0, TAU);
        ctx.stroke();
      }
      if (selectedIdx >= 0 && selectedIdx !== hoverIdx) {
        const r = Math.max(3, D.radius[selectedIdx] * D.scaleMul[selectedIdx] * k)
          + rcfg.selectionRingOffset;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cam.worldToScreenX(D.x[selectedIdx]), cam.worldToScreenY(D.y[selectedIdx]), r, 0, TAU);
        ctx.stroke();
      }
    }

    // -----------------------------------------------------------------------
    function setBackground(color) {
      bgColor = color || rcfg.bgFallback;
      canvas.style.background = bgColor;
      invalidateSprites();
    }

    function destroy() {
      spriteCache.clear();
      measureCache.clear();
      nodeList = edgeList = null;
      occGrid = new Uint8Array(0);
    }

    return {
      resize, render, setBackground, invalidateSprites, destroy,
      setGrid(g) { cullGrid = g; },
      get ctx() { return ctx; },
      get dpr() { return dpr; },
      get width() { return W; },
      get height() { return H; },
      get bgColor() { return bgColor; },
      get nodeCount() { return nodeCount; },
      get edgeCount() { return edgeCount; },
      measureCacheSize: () => measureCache.size,
    };
  }

  GFI.Renderer = { create };
})(window.GFI);
