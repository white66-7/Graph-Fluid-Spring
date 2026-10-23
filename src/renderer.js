// Canvas2D 绘制
// 清屏 → 剔除 → 辉光(lighter) → 边 → 节点头 → 标签 → 覆盖层
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

    // 这一帧要画的节点下标
    let nodeList = new Int32Array(Math.max(64, D.n));
    // 这一帧要画的边下标
    let edgeList = new Int32Array(Math.max(64, D.m));
    let nodeCount = 0, edgeCount = 0;

    // 剔除复用物理的空间网格
    let cullGrid = null;

    // 标签精灵缓存
    const labelCache = new Map();
    // 帧计数器
    let labelFrame = 0;
    // 标签绘制数
    let labelDrawn = 0;

    // 精灵盒四周的透明 padding
    let labelPad = 4;
    // 精灵盒的高度
    var labelBoxH = 24;

    // 标签文字与节点下缘之间的间隙
    const LABEL_GAP = 3;


    function refreshLabelMetrics() {
      const m = /(\d+(?:\.\d+)?)px/.exec(rcfg.labelFont);
      const size = m ? parseFloat(m[1]) : 12;
      labelPad = Math.ceil(rcfg.labelHaloWidth) + 2;
      labelBoxH = Math.ceil(size * 1.3) + labelPad * 2;
    }
    refreshLabelMetrics();

    let occW = 0, occH = 0;
    // 记录每个格子是否已被某个标签占用
    let occGrid = new Uint8Array(0);
    
    // 节点 i 的标签当前透明度
    let labelA = new Float32Array(D.n);
    let labelShown = new Uint8Array(D.n);
    let labelWon = new Uint8Array(D.n);
    const RISE = 1 / 6, RISE_HI = 1 / 3, FALL = 1 / 4;

    // 全局淡变系数
    let labelFadeMul = 1, lblPrevFade = -1;

    // 相机突变检测。
    let lblK = 0, lblTx = 0, lblTy = 0, lblInit = false;

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

    // 屏幕刷新率
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

    // 辉光精灵图
    function makeGlowSprite(hex) {
      const rgb = hexToRgb(hex);
      // 辉光相对节点半径的外扩倍数
      const spread = rcfg.glowSpread;
      // 精灵按最大桶尺寸渲染，绘制时缩放到目标尺寸
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

    // 标签精灵
    function makeLabelSprite(text) {
      ctx.font = rcfg.labelFont;
      const wCss = Math.ceil(ctx.measureText(text).width) + labelPad * 2;
      const hCss = labelBoxH;

      // 设备像素必须取整
      const devW = Math.max(1, Math.round(wCss * dpr));
      const devH = Math.max(1, Math.round(hCss * dpr));

      const c = topDoc.createElement('canvas');
      c.width = devW; c.height = devH;
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = rcfg.labelFont;
      // 文字左对齐
      g.textAlign = 'left';
      // 文字垂直对齐基准
      g.textBaseline = 'middle';
      // 描边转角处
      g.lineJoin = 'round';

      // 中线测量
      const ty = devH / dpr * 0.5;

      // 先描边再加字
      if (rcfg.labelHaloWidth > 0) {
        // 颜色
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
      refreshLabelMetrics();
      labelA.fill(0, 0, D.n);
      labelShown.fill(0, 0, D.n);
      labelWon.fill(0, 0, D.n);
      lblInit = false;
    }

    // 挑出视口内显示的节点和边
    function cull(extraMargin) {
      // 视口外扩多少像素
      cam.visibleRect(extraMargin, rect);
      const grid = cullGrid;
      // 有网格时
      if (grid && grid.cols) {
        // 找出落在某个矩形范围内的所有节点
        nodeCount = grid.collectRect(D, rect.x0, rect.y0, rect.x1, rect.y1, nodeList, D.visible);
      } else {
        nodeCount = 0;
        // nodeList 
        for (let i = 0; i < D.n; i++) if (D.visible[i]) nodeList[nodeCount++] = i;
      }

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
        // 以节点数当索引
        edgeList[edgeCount++] = e;
      }
    }

    // 主绘制
    /**
     * @param {object} view { hoverIdx, selectedIdx, lod, labelsOn }
     */
    function render(view) {
      const t0 = GFI.util.now();

      // 重置画布状态
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 混合模式 - 新内容盖在旧内容上
      ctx.globalCompositeOperation = 'source-over';
      // 全局透明度
      ctx.globalAlpha = 1;

      // 清屏
      ctx.clearRect(0, 0, W, H);
      if (!D.n) return { cull: 0, total: GFI.util.now() - t0 };

      cull(rcfg.radiusMax * rcfg.nodeSize * rcfg.glowSpread + 16);
      const tCull = GFI.util.now();

      // 鼠标悬浮的节点
      const hoverIdx = view.hoverIdx | 0;
      // 选中的节点
      const selectedIdx = view.selectedIdx | 0;
      const hot = hoverIdx >= 0 ? hoverIdx : selectedIdx;
      // lod 挡位
      const lod = clamp(view.lod | 0, 0, GFI.config.lod.levels.length - 1);

      const lodCfg = GFI.config.lod.levels[lod];
      const k = cam.k;

      drawEdges(hot, k);
      const tEdges = GFI.util.now();
      // 画辉光
      drawGlow(nodeList, nodeCount, lodCfg, k, hoverIdx, selectedIdx);
      const tGlow = GFI.util.now();
      // 画节点头
      drawCores(nodeList, nodeCount, k, lodCfg, hoverIdx);
      const tCore = GFI.util.now();

      labelDrawn = 0;

      // 全局淡变系数
      const lf = view.labelFade;
      labelFadeMul = lf === undefined ? 1 : (lf > 0 ? (lf < 1 ? +lf : 1) : 0);
      const fadeRising = labelFadeMul > 0 && lblPrevFade <= 0;
      lblPrevFade = labelFadeMul;
      //  画标签
      if (view.labelsOn && labelFadeMul > 0) drawLabels(nodeList, nodeCount, lodCfg, k, hot, fadeRising);
      const tLabel = GFI.util.now();

      // 画 hover高亮
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
        // 不计被占位格挡掉的标签数
        labelN: labelDrawn,
        // 精灵缓存条目数
        labelCacheN: labelCache.size,
        hot: hot,
        边色: hot < 0 ? rcfg.edgeColor : rcfg.edgeColorHi,
        压暗色: rcfg.edgeColorDim,
      };
    }

    // 边的 alpha = 两端节点 alpha 的 min
    const fadingEdges = [];        // style: 0 普通 / 1 压暗 / 2 高亮
    function edgeAlpha(e) {
      const ra = D.renderAlpha, a = ra[D.lsrc[e]], b = ra[D.ltgt[e]];
      return a < b ? a : b;
    }
    function drawFadingEdges(fn, wNormal, wHi) {
      if (!fn) return;
      const { lsrc, ltgt, x, y } = D;
      let curStyle = -1;
      for (let q = 0; q < fn; q += 3) {
        const e = fadingEdges[q], a = fadingEdges[q + 1], st = fadingEdges[q + 2];
        if (st !== curStyle) {
          curStyle = st;
          ctx.strokeStyle = st === 2 ? rcfg.edgeColorHi : (st === 1 ? rcfg.edgeColorDim : rcfg.edgeColor);
          ctx.lineWidth = st === 2 ? wHi : wNormal;
        }
        const s = lsrc[e], t = ltgt[e];
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.moveTo(cam.worldToScreenX(x[s]), cam.worldToScreenY(y[s]));
        ctx.lineTo(cam.worldToScreenX(x[t]), cam.worldToScreenY(y[t]));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function drawEdges(hot, k) {
      if (!edgeCount) return;
      const { lsrc, ltgt, x, y, hl } = D;
      const wNormal = clamp(rcfg.edgeWidthBase + rcfg.edgeWidthSlope * k, rcfg.edgeWidthMin, rcfg.edgeWidthMax);
      const wHi = Math.max(1.0, wNormal * 1.4);
      let fn = 0;

      if (hot < 0) {
        ctx.strokeStyle = rcfg.edgeColor;
        ctx.lineWidth = wNormal;
        ctx.beginPath();
        let nb = 0;
        for (let p = 0; p < edgeCount; p++) {
          const e = edgeList[p];
          const ea = edgeAlpha(e);
          if (ea < 0.999) { fadingEdges[fn++] = e; fadingEdges[fn++] = ea; fadingEdges[fn++] = 0; continue; }
          const s = lsrc[e], t = ltgt[e];
          ctx.moveTo(cam.worldToScreenX(x[s]), cam.worldToScreenY(y[s]));
          ctx.lineTo(cam.worldToScreenX(x[t]), cam.worldToScreenY(y[t]));
          nb++;
        }
        // 全被抽去逐条淡入时别描空气
        if (nb) ctx.stroke();
        drawFadingEdges(fn, wNormal, wHi);
        return;
      }

      // 有高亮：分两趟（压暗的 / 高亮的）
      ctx.strokeStyle = rcfg.edgeColorDim;
      ctx.lineWidth = wNormal;
      ctx.beginPath();
      let nb1 = 0;
      for (let p = 0; p < edgeCount; p++) {
        const e = edgeList[p];
        const s = lsrc[e], t = ltgt[e];
        if (hl[s] >= 2 && hl[t] >= 2) continue;
        const ea = edgeAlpha(e);
        if (ea < 0.999) { fadingEdges[fn++] = e; fadingEdges[fn++] = ea; fadingEdges[fn++] = 1; continue; }
        ctx.moveTo(cam.worldToScreenX(x[s]), cam.worldToScreenY(y[s]));
        ctx.lineTo(cam.worldToScreenX(x[t]), cam.worldToScreenY(y[t]));
        nb1++;
      }
      if (nb1) ctx.stroke();

      ctx.strokeStyle = rcfg.edgeColorHi;
      ctx.lineWidth = wHi;
      ctx.beginPath();
      let nb2 = 0;
      for (let p = 0; p < edgeCount; p++) {
        const e = edgeList[p];
        const s = lsrc[e], t = ltgt[e];
        if (!(hl[s] >= 2 && hl[t] >= 2)) continue;
        const ea = edgeAlpha(e);
        if (ea < 0.999) { fadingEdges[fn++] = e; fadingEdges[fn++] = ea; fadingEdges[fn++] = 2; continue; }
        ctx.moveTo(cam.worldToScreenX(x[s]), cam.worldToScreenY(y[s]));
        ctx.lineTo(cam.worldToScreenX(x[t]), cam.worldToScreenY(y[t]));
        nb2++;
      }
      if (nb2) ctx.stroke();

      drawFadingEdges(fn, wNormal, wHi);
    }

    // 辉光
    function drawGlow(list, count, lodCfg, k, hoverIdx, selectedIdx) {
      if (lodCfg.glow === 'hover' && hoverIdx < 0 && selectedIdx < 0) return;

      const { x, y, radius, renderAlpha, scaleMul, colorIdx, deg, hl, visible } = D;
      const table = D.colorTable;
      const spread = rcfg.glowSpread;
      const minScale = lodCfg.glowMinScale;

      // 新旧内容相加
      ctx.globalCompositeOperation = 'lighter';
      let lastIdx = -1;
      let sprite = null;

      for (let p = 0; p < count; p++) {
        const i = list[p];
        if (!visible[i]) continue;
        const a = renderAlpha[i];
        // 几乎透明
        if (a <= 0.01) continue;

        // 缩放过小
        if (k < minScale) continue;

        // 度数 < 2 不给辉光
        if (lodCfg.glow === 'deg2' && deg[i] < 2) continue;
        if (lodCfg.glow === 'hover' && i !== hoverIdx && i !== selectedIdx) continue;

        const rScreen = Math.max(0.8, radius[i] * scaleMul[i] * k);
        const ci = colorIdx[i];
        if (ci !== lastIdx) { lastIdx = ci; sprite = getGlowSprite(table[ci]); }

        // 辉光强度跟着缩放走
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

    // 节点头按颜色分组，每组 fill() 一次
    const midBirth = [];
    function drawMidBirth(list2, cnt, k, hl) {
      const table = D.colorTable, ra = D.renderAlpha;
      for (let q = 0; q < cnt; q++) {
        const i = list2[q];
        const r = Math.max(0.6, D.radius[i] * D.scaleMul[i] * k);
        const sx = cam.worldToScreenX(D.x[i]);
        const sy = cam.worldToScreenY(D.y[i]);
        ctx.fillStyle = table[D.colorIdx[i]];
        ctx.globalAlpha = ra[i] * (hl[i] === 0 ? 0.35 : 1);
        ctx.beginPath();
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, TAU);
        ctx.fill();
      }
    }

    function drawCores(list, count, k, lodCfg, hoverIdx) {
      const { x, y, radius, renderAlpha, scaleMul, colorIdx, hl, visible } = D;
      const table = D.colorTable;
      const nColors = table.length;
      const nBuckets = nColors * ALPHA_LEVELS * 2;   // [color][alphaLevel][dim]
      ensureBuckets(nBuckets, count);

      bucketCount.fill(0, 0, nBuckets);

      // ---- 计数 ----
      let total = 0, midN = 0;
      for (let p = 0; p < count; p++) {
        const i = list[p];
        if (!visible[i]) continue;
        const a = renderAlpha[i];
        if (a <= 0.01) continue;
        // 出生中的节点不进桶 —— 它们的淡入必须是连续的
        if (D.popT[i] === D.popT[i]) { midBirth[midN++] = i; continue; }
        const dim = hl[i] === 0 ? 1 : 0;
        bucketCount[(colorIdx[i] * ALPHA_LEVELS + alphaLevel(a)) * 2 + dim]++;
        total++;
      }
      if (!total) { ctx.globalAlpha = 1; drawMidBirth(midBirth, midN, k, hl); return; }

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
        if (D.popT[i] === D.popT[i]) continue;      // 已在计数趟摘出
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
      drawMidBirth(midBirth, midN, k, hl);
    }

    // 标签
    function drawLabels(list, count, lodCfg, k, hot, fadeRising) {
      if (!count) return;
      labelFrame++;      // 精灵缓存的"最近使用"时间戳

      // 失效检测
      const tx0 = cam.worldToScreenX(0), ty0 = cam.worldToScreenY(0);
      const jumped = !lblInit
        || Math.abs(k - lblK) > 0.1 * Math.max(1e-9, lblK)
        || Math.abs(tx0 - lblTx) > 40
        || Math.abs(ty0 - lblTy) > 40
        || !!fadeRising;
      lblInit = true; lblK = k; lblTx = tx0; lblTy = ty0;
      if (jumped) labelShown.fill(0, 0, D.n);

      // 
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
      // 日记默认不显示名字
      const journalLabelsOn = !!rcfg.labelJournal;
      const n = D.n;
      const cap = Math.min(lodCfg.labelCap, Math.max(8, Math.round(n * rcfg.labelMaxRatio)));
      const rankCap = n > 1 ? Math.min(255, Math.floor((cap / (n - 1)) * 255)) : 255;

      ctx.font = rcfg.labelFont;
      ctx.strokeStyle = rcfg.labelHaloColor;
      ctx.lineWidth = rcfg.labelHaloWidth;
      ctx.lineJoin = 'round';
      // 文字左对齐
      ctx.textAlign = 'left';

      // 悬浮显示该节点与它直接相连的邻居
      if (hot >= 0) {
        if (visible[hot]) drawOne(hot, cell, cw, ch, x, y, label, radius, scaleMul, k, true, true);
        for (let p = 0; p < count; p++) {
          const i = list[p];
          if (i === hot || !visible[i] || hl[i] < 2) continue;
          if (renderAlpha[i] <= 0.01) continue;   // 阈值降到与节点同样的剔除线，渐变交给 renderAlpha
          drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, false, true);
        }
        finishLabelFrame(n);
        return;
      }

      // ---- 模式 B：常态下画标签 —— 🌟 L2 两遍遍历（滞回）----
      //
      // ⚠ 两遍遍历与下面的名次分档，作用都只是【在开启让位时决定谁先占位】。
      //   `render.labelYield = false`（默认）时 drawOne 全部走 force 路径 ——
      //   不查也不标占位格，人人都画，先后顺序不再有胜负含义，但遍历本身照跑
      //   （代价只是多一趟 O(视口节点数) 的循环，与画精灵的开销比可忽略）。
      //
      // H 遍：上一帧的胜者先画先占。占位格每帧清零，胜负原本完全由遍历的
      //   空间序决定 —— 漂移/平移时节点跨格，两个竞争标签的胜负帧间翻转，
      //   观感就是一闪一闪。让守擂者先落子，竞争只剩「守擂 vs 新挑战」，
      //   布局连续时守擂必赢 → 胜负稳定。胜者集合只增不减也没关系：
      //   收尾扫描会把本帧没画的从集合里除名。
      for (let p = 0; p < count; p++) {
        const i = list[p];
        if (!labelShown[i] || !visible[i]) continue;
        if (!journalLabelsOn && kind[i] === JK) continue;
        if (renderAlpha[i] <= 0.01) continue;   // 阈值降到与节点同样的剔除线，渐变交给 renderAlpha
        drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, false, false);
      }

      // N 遍：新候选按度数名次分档补空位（原有逻辑）。
      // 分档的意义：度数高的先画、先占住占位格 —— 直接一趟遍历的话，
      // 先到先得的是网格顺序（≈空间顺序），密集区里 hub 反而可能被叶子挤掉。
      // ⚠ 占位格是真抑制，先后顺序是决定性的 —— 先画的赢。
      const PASSES = 4;
      const step = Math.max(1, Math.ceil((rankCap + 1) / PASSES));
      for (let lo = -1; lo < rankCap; lo += step) {
        const hiRank = Math.min(rankCap, lo + step);
        for (let p = 0; p < count; p++) {
          const i = list[p];
          if (labelShown[i] || !visible[i]) continue;   // 已在 H 遍处理过
          // 日记标签开关在【精灵创建之前】跳过 —— 顺便不为不会画的标签预热缓存
          if (!journalLabelsOn && kind[i] === JK) continue;
          const rk = labelRank[i];
          if (rk <= lo || rk > hiRank) continue;
          if (renderAlpha[i] <= 0.01) continue;   // 阈值降到与节点同样的剔除线，渐变交给 renderAlpha
          drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, false, false);
        }
      }

      finishLabelFrame(n);
    }

    // 🌟 L1/L2 每帧收尾：胜者滚入滞回集合；其余（败者 / 被剔除出屏的 / 超出
    // labelCap 的 / 悬浮时非邻域的）alpha 统一衰减 —— 只要不胜出就淡出，
    // 所以任何路径都不会把标签「啪」地掐断。
    function finishLabelFrame(n) {
      for (let i = 0; i < n; i++) {
        if (labelWon[i]) {
          labelWon[i] = 0;
          labelShown[i] = 1;
          continue;
        }
        if (labelShown[i]) labelShown[i] = 0;
        const a = labelA[i];
        if (a > 0) labelA[i] = a > FALL ? a - FALL : 0;
      }
    }

    /**
     * @param {boolean} hi 悬浮/选中的那一个。它每帧至多一个，颜色与 alpha 都与
     *   常态标签不同，所以【不吃精灵缓存】（直绘）。
     * @param {boolean} force 跳过重叠让位。邻域模式（模式 A）下全部为 true ——
     *   悬浮的意图就是把这一圈邻居全亮出来，让位只属于常态模式。
     */
    /** 节点名字最终显示成什么（labelMaxChars = 0 时表示从不截断，Obsidian 行为） */
    function displayText(full) {
      return (rcfg.labelMaxChars > 0 && full.length > rcfg.labelMaxChars)
        ? full.slice(0, rcfg.labelMaxChars - 1) + '…'
        : full;
    }

    function drawOne(i, cell, cw, ch, x, y, label, radius, scaleMul, k, hi, force) {
      const full = label[i];
      if (!full) return;
      // 🌟 labelMaxChars = 0 表示【从不截断】（Obsidian 行为：名字永远显示全）。
      //   截断规则收在 displayText 里 —— 布局层算标签宽度时用的是同一个函数，
      //   两处不一致的话，预留的空间就会与实际画出来的对不上。
      const text = displayText(full);

      // 常态标签走精灵缓存（宽度也一起缓存，不再每帧 measureText）；
      // 悬浮标签直接光栅化 —— 每帧最多一个，不值得为它再开一档缓存。
      // ⚠ 必须先拿到 w/h —— 下面【水平居中】要用到宽度，不能像原来那样先定位。
      let sprite = null, w, h;
      if (hi) {
        ctx.font = rcfg.labelFont;
        w = Math.ceil(ctx.measureText(text).width) + labelPad * 2;
        h = labelBoxH;
      } else {
        sprite = getLabelSprite(text);
        w = sprite.w; h = sprite.h;
      }

      // 🌟 摆放：名字画在节点【正下方】、水平居中于节点。
      //   精灵左缘居中到节点圆心（bx0 = cx − w/2）；精灵内部文字左缘在 labelPad 处，
      //   所以文字自己也正好居中。
      //
      // ⚠ 间隙要按【文字】的下缘算，不是按精灵盒 —— 精灵盒上下各留了 labelPad 的
      //   透明 padding（只为容纳描边外溢），按盒心摆会把文字又推远 4px。
      //   实测观感：那样每个标签看起来都"飘"在节点下方，认不出属于谁。
      //   所以文字垂直中线 = 节点下缘 + LABEL_GAP + 文字半高(th)。
      //   两条绘制路径共用这套坐标：sx = 文字左缘，sy = 文字垂直中线
      //   （全局 ctx.textBaseline 是 middle，精灵内部同样是 middle，两者一致）。
      const hh = h * 0.5;
      const th = hh - labelPad;                       // 文字半高
      const rScr = Math.max(2, radius[i] * scaleMul[i] * k);
      const bx0 = cam.worldToScreenX(x[i]) - w * 0.5;
      const sx = bx0 + labelPad;
      const sy = cam.worldToScreenY(y[i]) + rScr + LABEL_GAP + th;

      // 包围盒：x ∈ [bx0, bx0+w]，y ∈ [sy-h/2, sy+h/2]。按真实包围盒判可见 ——
      // 一半在屏幕里就该画。
      const bx1 = bx0 + w;
      if (bx1 < 0 || bx0 > W || sy + hh < 0 || sy - hh > H) return;

      // ---- 🌟 占位胜负判定 ----
      // 胜 → 标满包围盒、alpha 爬升；败 → 不标不挡，若还有余晖（labelA>0）
      // 作幽灵画一遍（~70ms 淡出让位）。出屏/空串的 return 不改任何状态 ——
      // 收尾扫描按 labelWon=0 统一衰减，所以任何离开方式都是渐隐。
      // ⚠ 初值必须是 true：占位循环只负责把「撞车」置负。写成 `won = force`
      //   会让常态标签（force=false）一进来就判负，全部不画。
      let won = true;                      // 邻域模式（force）：不查也不标，恒胜
      // 🌟 与已画出的标签重叠时的处理，两种策略共用同一套占位判定：
      //     labelYield = true  → 让位（won=false，不画，靠 L1 淡出）
      //     labelYield = false → 【变暗】（照画，但 alpha 压到 labelOverlapDim）
      //   变暗是 Obsidian 式"全都画"和让位式"藏起来"之间的中间档：名字一个不少，
      //   但先画的高名次节点（hub）保持清晰、被压住的退到背景 —— 否则密密麻麻
      //   同亮度的字叠在一起完全没法看（实机截图反馈："标签重叠易混淆"）。
      let dim = 1;
      let gx0 = 0, gy0 = 0, gx1 = 0, gy1 = 0;
      if (!force) {
        // ---- 占位：按【文字本身的包围盒】外扩 halo 宽度来标 ----
        //
        // 原先只标落点的那【一格】（labelCell = 14），而长标签实际宽上百 px ——
        // 一格占位等于完全没有抑制。密集处的取舍全靠这里。
        //
        // ⚠ 但也【不能】直接标整个精灵盒：精灵盒比文字大一圈（左右各 labelPad、
        //   上下各 labelPad），按它占位等于凭空多占约 1/3 面积，把本来放得下的
        //   标签挤掉了。实测（test/label-occlusion-probe.js，300 节点 k=0.6）：
        //   标精灵盒 → 46 个标签；标文字盒 → 57 个（+24%），而画出来的像素一个
        //   没变，纯粹是原来少算了。收窄到文字 ± (halo+1) 即可，两个标签的光晕
        //   贴在一起也不影响阅读。
        const infl = rcfg.labelHaloWidth + 1;        // 光晕外扩 + 1px 余量（th 已在上面算好）
        gx0 = Math.floor((sx - infl) / cell);
        gx1 = Math.floor((sx + w - 2 * labelPad + infl) / cell);
        gy0 = Math.floor((sy - th - infl) / cell);
        gy1 = Math.floor((sy + th + infl) / cell);
        if (gx0 < 0) gx0 = 0;
        if (gy0 < 0) gy0 = 0;
        if (gx1 >= cw) gx1 = cw - 1;
        if (gy1 >= ch) gy1 = ch - 1;
        if (gx0 > gx1 || gy0 > gy1) return;

        // 与已经画出来的标签重叠 → 让位 或 变暗
        // （H 遍守擂者与名次高的先画，它们保持清晰）
        let hit = false;
        outer:
        for (let gy = gy0; gy <= gy1; gy++) {
          const rowBase = gy * cw;
          for (let gx = gx0; gx <= gx1; gx++) {
            if (occGrid[rowBase + gx]) { hit = true; break outer; }
          }
        }
        if (hit) {
          if (rcfg.labelYield) won = false;
          else dim = rcfg.labelOverlapDim;
        }
      }

      if (won) {
        labelWon[i] = 1;
        const cur = labelA[i];
        labelA[i] = cur >= 1 ? 1 : Math.min(1, cur + (hi ? RISE_HI : RISE));
      }
      const a01 = labelA[i];
      if (a01 <= 0) return;

      if (won) {
        if (!force) {
          for (let gy = gy0; gy <= gy1; gy++) {
            const rowBase = gy * cw;
            for (let gx = gx0; gx <= gx1; gx++) occGrid[rowBase + gx] = 1;
          }
        }
        labelDrawn++;                    // 只计胜者 —— 幽灵余晖不算「本帧真正画出」
      }

      // 🌟 L1×L3：精灵 alpha = 常态系数 × 个体渐变 × 全局淡变 × 重叠变暗
      if (hi) {
        ctx.globalAlpha = a01 * labelFadeMul * dim * D.renderAlpha[i];
        ctx.fillStyle = rcfg.labelColorHi;
        // 先描边再加字（font / strokeStyle / lineWidth / textAlign 由 drawLabels 设好）
        if (rcfg.labelHaloWidth > 0) ctx.strokeText(text, sx, sy);
        ctx.fillText(text, sx, sy);
      } else {
        ctx.globalAlpha = rcfg.labelAlpha * a01 * labelFadeMul * dim * D.renderAlpha[i];
        // 精灵内部文字左缘在 labelPad 处 → 精灵左缘 = bx0。
        // 贴到设备像素栅格再 blit —— 落在半像素上同样会引入重采样（见 makeLabelSprite）
        ctx.drawImage(sprite.canvas,
          Math.round(bx0 * dpr) / dpr,
          Math.round((sy - hh) * dpr) / dpr,
          w, h);
      }
    }

    // 覆盖层：hover 环 / 选中环
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

    // 背景色设置
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
      labelA = labelShown = labelWon = null;
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
