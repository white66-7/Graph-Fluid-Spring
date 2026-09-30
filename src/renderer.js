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

    // 标签精灵缓存 —— key = 最终显示的字符串（已按 labelMaxChars 截断）。
    // 标签在屏幕空间的字体 / 颜色 / 字号是恒定的（不随相机 k 变化），所以每个
    // unique 字符串只需光栅化一次，之后每帧一次 drawImage 取代 strokeText +
    // fillText（后者每帧都要把每个字形轮廓重新描一遍边）。
    // 240 个标签 × ~15 字符 ≈ 7200 次字形描边/填充 → 240 次 blit。
    // 条目同时带着宽度，所以顺带取代了原先那个【从未被调用过的】measureText 缓存。
    const labelCache = new Map();
    let labelFrame = 0;
    let labelDrawn = 0;

    // 标签精灵的尺寸基准。
    // pad 用于容纳 halo 描边的外溢；高度取【行高】而不是逐字符串的实际字形高 ——
    // 否则 "abc" 与 "Äg" 会得到不同的精灵高度，画出来基线互相错位。
    let labelPad = 4, labelBoxH = 24;
    function refreshLabelMetrics() {
      const m = /(\d+(?:\.\d+)?)px/.exec(rcfg.labelFont);
      const size = m ? parseFloat(m[1]) : 12;
      labelPad = Math.ceil(rcfg.labelHaloWidth) + 2;
      labelBoxH = Math.ceil(size * 1.3) + labelPad * 2;
    }
    refreshLabelMetrics();

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

    // -----------------------------------------------------------------------
    // 标签精灵
    // -----------------------------------------------------------------------
    function makeLabelSprite(text) {
      // 必须先量宽度再建画布 —— 尺寸要按内容裁，不然几百个标签就是几百张
      // 全宽的图，内存全浪费。量之前显式设一次 font，不依赖外面设过。
      ctx.font = rcfg.labelFont;
      const wCss = Math.ceil(ctx.measureText(text).width) + labelPad * 2;
      const hCss = labelBoxH;

      // ⚠ 设备像素必须取【整】，且对外暴露的 CSS 尺寸要由它【除回来】。
      //   若按 w*dpr 取浮点再 ceil，drawImage 的目标尺寸（w × dpr）就与源尺寸
      //   差最多 1px —— 于是每次 blit 都触发一次双线性重采样，文字发虚。
      //   除回来之后 dw*dpr === canvas.width，是严格 1:1。
      const devW = Math.max(1, Math.round(wCss * dpr));
      const devH = Math.max(1, Math.round(hCss * dpr));

      const c = topDoc.createElement('canvas');
      c.width = devW; c.height = devH;
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = rcfg.labelFont;
      // 🌟 Obsidian 摆放：文字【左对齐】画在节点右侧 —— 精灵内部同样左对齐，
      //   文字左缘 = labelPad。blit 时把精灵左缘对到 (sx - labelPad) 即可。
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.miterLimit = 2;

      const ty = devH / dpr * 0.5;
      // 先描边再加字 —— 深色光晕把文字从辉光背景里"抠"出来（与主 ctx 同一套参数）
      if (rcfg.labelHaloWidth > 0) {
        g.strokeStyle = rcfg.labelHaloColor;
        g.lineWidth = rcfg.labelHaloWidth;
        g.strokeText(text, labelPad, ty);
      }
      g.fillStyle = rcfg.labelColor;
      g.fillText(text, labelPad, ty);

      return { canvas: c, w: devW / dpr, h: devH / dpr };
    }

    // 条目带 lastFrame，超限时按"最近没用过"清扫。
    // 不用 LRU 的 delete+set：那种写法每帧每标签两次 Map 写，比偶尔清扫一趟更贵。
    function getLabelSprite(text) {
      let e = labelCache.get(text);
      if (e) { e.lastFrame = labelFrame; return e; }

      e = makeLabelSprite(text);
      e.lastFrame = labelFrame;
      labelCache.set(text, e);

      const max = rcfg.labelCacheMax;
      if (labelCache.size > max) {
        const keepAfter = labelFrame - 2;
        for (const [k, v] of labelCache) if (v.lastFrame < keepAfter) labelCache.delete(k);
        // 清完仍超限（单帧就要画比上限还多的不同标签，即 labelCacheMax 配小了）→
        // 从最旧的开始丢到限额内。【不能整体 clear()】：那会把本帧刚建的一起丢掉，
        // 下一帧全部重建，于是每帧都在建精灵 —— 比不缓存还慢。
        // Map 保持插入顺序，所以 keys() 从前往后就是由旧到新。
        if (labelCache.size > max) {
          const it = labelCache.keys();
          while (labelCache.size > max) {
            const k = it.next();
            if (k.done) break;
            labelCache.delete(k.value);
          }
        }
      }
      return e;
    }

    function invalidateSprites() {
      spriteCache.clear();
      labelCache.clear();
      refreshLabelMetrics();     // labelFont / haloWidth / dpr 都可能变了
    }

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

      // 剔除余量要容得下【辉光】，而不是只容下节点本体：辉光以节点为中心向外
      // 摊开 spread × rScreen（见 drawGlow 的 half），而 pop 期间 scaleMul 还能到
      // 1 + pop.amp。只留 radiusMax + 16 的话，贴着视口边缘的节点会在边缘上
      // "啪"地亮起来 —— 因为画布每帧清屏，边缘外的辉光就是没画。
      cull(rcfg.radiusMax * rcfg.nodeSize * (1 + GFI.config.pop.amp) * rcfg.glowSpread + 16);
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

      labelDrawn = 0;
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
        // labelN = 本帧真正画出的标签数（被占位格挡掉的不计）；
        // labelCacheN = 精灵缓存条目数。稳定后这个数应该收敛不动 ——
        // 若它每帧都在涨，说明缓存 key 或失效逻辑坏了。
        labelN: labelDrawn,
        labelCacheN: labelCache.size,
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
    // （原有一个 measure() + measureText 缓存，从未被任何地方调用过 —— 已经删掉。
    //   宽度现在由 labelCache 的精灵条目一并提供，见文件上方 makeLabelSprite。）
    function drawLabels(list, count, lodCfg, k, hot) {
      if (!count) return;
      labelFrame++;      // 精灵缓存的"最近使用"时间戳

      // 占位网格
      const cell = rcfg.labelCell;
      const cw = Math.ceil(W / cell), ch = Math.ceil(H / cell);
      if (cw !== occW || ch !== occH) {
        occW = cw; occH = ch;
        occGrid = new Uint8Array(Math.max(1, cw * ch));
      } else {
        occGrid.fill(0);
      }

      const { x, y, label, labelRank, radius, renderAlpha, scaleMul, visible, hl, kind } = D;
      const JK = D.KIND.journal;
      // 🌟 日记默认不显示名字（config.render.labelJournal，Obsidian 式）。
      // 只作用于常态模式 B —— 悬浮（模式 A）不受影响：想读某颗绿点是哪天，
      // hover 一下就行，那一刻正是"要读名字"的时候。
      const journalLabelsOn = !!rcfg.labelJournal;
      const n = D.n;
      // labelRank 是均匀分布在 0..255 的名次（0 = 度数最高）；据此换算阈值按名次截断。
      // 取两个上限的较小者：LOD 档位的 labelCap，以及按节点总数算的比例上限。
      // 🌟 labelMaxRatio 默认 1.0（Obsidian 行为：全部节点都是候选）之后，
      //   rankCap 基本恒为 255 —— 名次分档只剩"先画谁"的作用（占位让位时 hub 优先）。
      const cap = Math.min(lodCfg.labelCap, Math.max(8, Math.round(n * rcfg.labelMaxRatio)));
      const rankCap = n > 1 ? Math.min(255, Math.floor((cap / (n - 1)) * 255)) : 255;

      ctx.font = rcfg.labelFont;
      ctx.strokeStyle = rcfg.labelHaloColor;
      ctx.lineWidth = rcfg.labelHaloWidth;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      // 🌟 Obsidian 摆放：文字左对齐（resize 里的全局默认是 center）
      ctx.textAlign = 'left';

      // ---- 模式 A：悬浮/选中时，只显示该节点与它直接相连的邻居 ----
      // 这是一条明确的规则，而不是"按名次截一部分"——
      // 视线聚焦在邻域上，其余标签全部让位。
      if (hot >= 0) {
        // ⚠ 邻域模式【全部不做重叠让位】（force=true）。
        //   意图是"视线聚焦在邻域上，其余全部让位" —— 那么邻域内部自己就该
        //   全部显示。之前这里让位，而占位抑制改按整个包围盒标记之后，hub 的
        //   邻居们（它们本来就聚在一起）开始真的互相挤掉，看起来就是
        //   "悬浮后连接的节点显示不全"。**让位只属于常态模式。**
        if (visible[hot]) drawOne(hot, cell, cw, ch, x, y, label, radius, scaleMul, k, true, true);
        for (let p = 0; p < count; p++) {
          const i = list[p];
          if (i === hot || !visible[i] || hl[i] < 2) continue;
          if (renderAlpha[i] < 0.55) continue;
          drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, false, true);
        }
        return;
      }

      // ---- 模式 B：常态下按度数名次画到上限 ----
      // 分档遍历：度数高的先画、先占住占位格。
      // 直接一趟遍历 nodeList 的话，先到先得的是网格顺序（≈空间顺序），
      // 密集区里谁能留下完全随机，hub 反而可能被叶子挤掉。
      // ⚠ 占位格现在是【真抑制】之后，先后顺序从"锦上添花"变成了决定性的 ——
      //   先画的赢，所以这条名次分档是标签质量的关键。
      const PASSES = 4;
      const step = Math.max(1, Math.ceil((rankCap + 1) / PASSES));
      for (let lo = -1; lo < rankCap; lo += step) {
        const hiRank = Math.min(rankCap, lo + step);
        for (let p = 0; p < count; p++) {
          const i = list[p];
          if (!visible[i]) continue;
          // 日记标签开关在【精灵创建之前】跳过 —— 顺便不为不会画的标签预热缓存
          if (!journalLabelsOn && kind[i] === JK) continue;
          const rk = labelRank[i];
          if (rk <= lo || rk > hiRank) continue;
          if (renderAlpha[i] < 0.55) continue;
          drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, false, false);
        }
      }
    }

    /**
     * @param {boolean} hi 悬浮/选中的那一个。它每帧至多一个，颜色与 alpha 都与
     *   常态标签不同，所以【不吃精灵缓存】（直绘）。
     * @param {boolean} force 跳过重叠让位。邻域模式（模式 A）下全部为 true ——
     *   悬浮的意图就是把这一圈邻居全亮出来，让位只属于常态模式。
     */
    function drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, hi, force) {
      const full = label[i];
      if (!full) return;
      // 🌟 labelMaxChars = 0 表示【从不截断】（Obsidian 行为：名字永远显示全）。
      const text = rcfg.labelMaxChars > 0 && full.length > rcfg.labelMaxChars
        ? full.slice(0, rcfg.labelMaxChars - 1) + '…'
        : full;

      // 🌟 Obsidian 摆放：名字画在节点【右侧】、垂直居中于节点、左对齐 ——
      //   不再居中悬在上方。右置的好处：名字沿着连线的走向排开，节点之间
      //   天然多出水平空间，观感上就是"每个节点都有自己的位置"。
      const rScr = Math.max(2, radius[i] * scaleMul[i] * k);
      const sx = cam.worldToScreenX(x[i]) + rScr + 6;   // 文字【左缘】
      const sy = cam.worldToScreenY(y[i]);               // 垂直中线

      // 常态标签走精灵缓存（宽度也一起缓存，不再每帧 measureText）；
      // 悬浮标签直接光栅化 —— 每帧最多一个，不值得为它再开一档缓存。
      let sprite = null, w, h;
      if (hi) {
        ctx.font = rcfg.labelFont;
        w = Math.ceil(ctx.measureText(text).width) + labelPad * 2;
        h = labelBoxH;
      } else {
        sprite = getLabelSprite(text);
        w = sprite.w; h = sprite.h;
      }

      // 包围盒：x ∈ [sx-pad, sx-pad+w]（文字左缘 sx，pad 留给描边外溢），
      // y ∈ [sy-h/2, sy+h/2]。按真实包围盒判可见 —— 一半在屏幕里就该画。
      const bx0 = sx - labelPad, hh = h * 0.5;
      const bx1 = bx0 + w;
      if (bx1 < 0 || bx0 > W || sy + hh < 0 || sy - hh > H) return;

      if (force) {
        // 邻域模式：不查也不标占位格 —— 让位在模式 A 里没有意义
      } else {
        // ---- 占位：标满整个包围盒 ----
        // 原先只标落点的那【一格】（labelCell = 14），而长标签实际宽上百 px ——
        // 一格占位等于完全没有抑制。密集处的取舍全靠这里。
        let gx0 = Math.floor(bx0 / cell), gx1 = Math.floor(bx1 / cell);
        let gy0 = Math.floor((sy - hh) / cell), gy1 = Math.floor((sy + hh) / cell);
        if (gx0 < 0) gx0 = 0;
        if (gy0 < 0) gy0 = 0;
        if (gx1 >= cw) gx1 = cw - 1;
        if (gy1 >= ch) gy1 = ch - 1;
        if (gx0 > gx1 || gy0 > gy1) return;

        // 与已经画出来的标签重叠 → 让位（名次高的先画，所以留下的是 hub）
        for (let gy = gy0; gy <= gy1; gy++) {
          const rowBase = gy * cw;
          for (let gx = gx0; gx <= gx1; gx++) if (occGrid[rowBase + gx]) return;
        }
        for (let gy = gy0; gy <= gy1; gy++) {
          const rowBase = gy * cw;
          for (let gx = gx0; gx <= gx1; gx++) occGrid[rowBase + gx] = 1;
        }
      }

      labelDrawn++;
      if (hi) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = rcfg.labelColorHi;
        // 先描边再加字（font / strokeStyle / lineWidth / textAlign 由 drawLabels 设好）
        if (rcfg.labelHaloWidth > 0) ctx.strokeText(text, sx, sy);
        ctx.fillText(text, sx, sy);
      } else {
        ctx.globalAlpha = rcfg.labelAlpha;
        // 精灵内部文字左缘在 labelPad 处 → 精灵左缘 = bx0。
        // 贴到设备像素栅格再 blit —— 落在半像素上同样会引入重采样（见 makeLabelSprite）
        ctx.drawImage(sprite.canvas,
          Math.round(bx0 * dpr) / dpr,
          Math.round((sy - hh) * dpr) / dpr,
          w, h);
      }
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
      labelCache.clear();
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
      labelCacheSize: () => labelCache.size,
    };
  }

  GFI.Renderer = { create };
})(window.GFI);
