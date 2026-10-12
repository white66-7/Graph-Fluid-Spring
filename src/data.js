/* 原始数据转换SoA + CSR 邻接 */
(function (GFI) {
  'use strict';
  if (GFI.Data) return;

  const { clamp, hash11 } = GFI.util;

  // kind 枚举
  const KIND = { page: 0, tag: 1, journal: 2, object: 3, property: 4 };
  const KIND_NAMES = ['page', 'tag', 'journal', 'object', 'property'];
  const PALETTE_ORDER = ['page', 'tag', 'journal', 'object', 'property'];

  function kindToEnum(k) {
    if (typeof k === 'number') return k | 0;
    const i = KIND_NAMES.indexOf(String(k));
    return i < 0 ? 0 : i;
  }


  // 黄金角螺旋节点初始位置
  function seedPositions(data) {
    const { n, x, y, deg } = data;
    //  2.39996弧度即137.5°
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spacing = 26;
    for (let i = 0; i < n; i++) {
      // 度数高的节点放内圈
      const t = i + 0.5;
      const r = spacing * Math.sqrt(t);
      const a = t * golden;
      x[i] = r * Math.cos(a);
      y[i] = r * Math.sin(a);
    }
    // 扰动防止完全对称
    for (let i = 0; i < n; i++) {
      x[i] += (hash11(i * 2) - 0.5) * 8;
      y[i] += (hash11(i * 2 + 1) - 0.5) * 8;
    }
  }

  // build
  /**
   * @param {Array<{id,label,kind,createdAt?,color?,degree?}>} rawNodes
   * @param {Array<{source,target,label?}>} rawLinks
   * @param {object} [prev] 上一次的 GraphData 
   * @param {Map<string,{x:number,y:number}>} [layout] 预热布局
   *        给了就在种子布局之后整体覆盖，并把命中数挂在 D.adopted 上。
   */
  function build(rawNodes, rawLinks, prev, layout) {
    rawNodes = rawNodes || [];
    rawLinks = rawLinks || [];

    const cfg = GFI.config.physics;
    const rcfg = GFI.config.render;

    // 丢弃重复与非法节点 
    const indexById = new Map();
    const nodes = [];
    for (let i = 0; i < rawNodes.length; i++) {
      const nd = rawNodes[i];
      // 三层检测对应
      if (!nd || nd.id === undefined || nd.id === null) continue;
      const id = String(nd.id);
      if (indexById.has(id)) continue;
      // 给每个节点编号

      indexById.set(id, nodes.length);

      nodes.push(nd);
    }
    const n = nodes.length;

    // 只保留两端都存在的边 
    const links = [];
    const seenEdge = new Set();
    for (let i = 0; i < rawLinks.length; i++) {
      const lk = rawLinks[i];
      if (!lk) continue;
      const s = indexById.get(String(lk.source));
      const t = indexById.get(String(lk.target));
      if (s === undefined || t === undefined || s === t) continue;
      // 0x100000是2^20
      const key = s < t ? s * 0x100000 + t : t * 0x100000 + s;
      if (seenEdge.has(key)) continue;   // 无向图去重
      seenEdge.add(key);
      links.push({ s, t });
    }
    const m = links.length;

    // 创建
    const D = { 
      n,  // 节点数
      m,  // 边数
      nodes, // 节点数组
      links,  // 边数组
      indexById, // ID到下标
      KIND,  // 类
      KIND_NAMES,  // 类名

      // 节点 ID
      id: new Array(n),  
      // 节点标题
      label: new Array(n),
      kind: new Uint8Array(n),
      colorIdx: new Uint8Array(n),
      // 调色板
      colorTable: [],         
      // 度数-节点连了多少条边
      deg: new Uint16Array(n),
      // 节点半径(随度数变大)
      radius: new Float32Array(n),
      // 斥力强度
      charge: new Float32Array(n),
      // 时间戳
      createdAt: new Float64Array(n),
      // 标签优先级
      labelRank: new Uint8Array(n),
      // CSR
      adjStart: new Uint32Array(n + 1),
      adjList: new Uint32Array(Math.max(1, m * 2)),

      // 模拟状态
      x: new Float32Array(n),
      y: new Float32Array(n),
      vx: new Float32Array(n),
      vy: new Float32Array(n),
      ax: new Float32Array(n),
      ay: new Float32Array(n),
      // 固定模式
      pinMode: new Uint8Array(n),
      // 固定位置的坐标
      fx: new Float32Array(n),
      fy: new Float32Array(n),

      tx: new Float32Array(n),
      ty: new Float32Array(n),
      // 受力权重
      simWeight: new Float32Array(n),

      // 实际可见性
      visible: new Uint8Array(n),
      // 目标可见性
      wantVisible: new Uint8Array(n),
      // 类型是否可见
      kindOn: new Uint8Array(5).fill(1),
      // 渲染透明度
      renderAlpha: new Float32Array(n),
      // 缩放倍率
      scaleMul: new Float32Array(n),
      // 出生动画进度
      popT: new Float32Array(n),      
      // 出生动画总长
      popDur: new Float32Array(n),
      // 淡出
      fadeT: new Float32Array(n),    
      fadeFrom: new Float32Array(n),

      // 边
      lsrc: new Uint32Array(m),
      ltgt: new Uint32Array(m),
      // 静止距离
      ldist: new Float32Array(m),
      // 刚度
      lstr: new Float32Array(m),
      lvisible: new Uint8Array(m),

      // hover 时高亮邻域
      // 0=压暗 1=邻接 2=自身
      hl: new Uint8Array(n),          
    };

    // 后续分配

    // 调色板表
    const MAX_COLORS = 12;

    // 颜色值
    D.colorTable = PALETTE_ORDER.map((k) => rcfg.palette[k] || '#8a8f98');

    // 根据颜色返回索引
    const colorKeyToIdx = new Map();
    for (let ci = 0; ci < D.colorTable.length; ci++) colorKeyToIdx.set(D.colorTable[ci], ci);

    function colorIdxFor(hex, fallbackHex) {
      let idx = colorKeyToIdx.get(hex);
      if (idx !== undefined) return idx;
      if (D.colorTable.length < MAX_COLORS) {
        idx = D.colorTable.length;
        D.colorTable.push(hex);
        colorKeyToIdx.set(hex, idx);
        return idx;
      }
      return colorKeyToIdx.get(fallbackHex) !== undefined ? colorKeyToIdx.get(fallbackHex) : 0;
    }

    // 节点填充
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      D.id[i] = String(nd.id);
      D.label[i] = nd.label == null ? '' : String(nd.label);

      D.kind[i] = kindToEnum(nd.kind);

      // 调色板索引
      const pal = KIND_NAMES[D.kind[i]] || 'page';
      const kindHex = rcfg.palette[pal] || rcfg.palette.page;
      D.colorIdx[i] = colorIdxFor(nd.color ? String(nd.color) : kindHex, kindHex);

      // createdAt缺失则NaN
      const ca = nd.createdAt != null ? Number(nd.createdAt) : (nd['block/created-at'] != null ? Number(nd['block/created-at']) : NaN);
      D.createdAt[i] = Number.isFinite(ca) ? ca : NaN;

      D.visible[i] = 1;

      D.renderAlpha[i] = 1;

      D.scaleMul[i] = 1;
      D.simWeight[i] = 1;
      D.popT[i] = NaN;
      D.fadeT[i] = NaN;
      D.pinMode[i] = 0;
      D.hl[i] = 1;
    }


    // 度数
    for (let e = 0; e < m; e++) {
      D.deg[links[e].s]++;
      D.deg[links[e].t]++;
    }

    // 前缀和
    let acc = 0;
    for (let i = 0; i < n; i++) {
      D.adjStart[i] = acc;
      acc += D.deg[i];
    }
    D.adjStart[n] = acc;
    const cursor = D.adjStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      const { s, t } = links[e];
      D.adjList[cursor[s]++] = t;
      D.adjList[cursor[t]++] = s;
    }

    // 由度数派生半径 / 斥力 / 标签优先级
    for (let i = 0; i < n; i++) {
      const d = D.deg[i];
      const sd = Math.sqrt(d);

      // 算圆直径
      D.radius[i] = clamp(rcfg.radiusBase + rcfg.radiusScale * sd, rcfg.radiusMin, rcfg.radiusMax) * rcfg.nodeSize;

      // 斥力随度数增长
      const gain = 1 + cfg.chargeDegGain * sd; 
      // 斥力是负数,有上下限
      D.charge[i] = -Math.abs(cfg.charge) * Math.min(gain, cfg.chargeDegCap);
    }

    // 标签优先级
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const ordArr = Array.from(order);
    // 度数不同时大的在前，相同时用a-b(下标)决定
    ordArr.sort((a, b) => (D.deg[b] - D.deg[a]) || (a - b));
    for (let r = 0; r < n; r++) {
      // orrArr[r] 表示节点
      D.labelRank[ordArr[r]] = n > 1 ? Math.round((r / (n - 1)) * 255) : 0;
    }

    // 长度按两端较小度数微调
    for (let e = 0; e < m; e++) {
      const { s, t } = links[e];
      const minDeg = Math.max(1, Math.min(D.deg[s], D.deg[t]));
      D.lsrc[e] = s;
      D.ltgt[e] = t;
      D.ldist[e] = cfg.linkDistance * (1 + 0.35 / minDeg);
      D.lstr[e] = clamp(cfg.linkStrength / minDeg, 0.02, 0.5);
      D.lvisible[e] = 1;
    }

    // 初始位置
    let inherited = 0;
    // prev 是上次的D
    if (prev && prev.indexById && prev.indexById.size) {
      for (let i = 0; i < n; i++) {
        const pi = prev.indexById.get(D.id[i]);
        if (pi !== undefined) {
          D.x[i] = prev.x[pi];
          D.y[i] = prev.y[pi];
          inherited++;
        } else {
          D.x[i] = NaN;   // 标记：待 seed 补充
        }
      }
    } else {
      for (let i = 0; i < n; i++) D.x[i] = NaN;
    }

    if (inherited < n) {
      // 新节点螺旋种子补位
      let cx = 0, cy = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        if (!isNaN(D.x[i])) { cx += D.x[i]; cy += D.y[i]; cnt++; }
      }
      if (cnt > 0) { cx /= cnt; cy /= cnt; } else { cx = 0; cy = 0; }

      const golden = Math.PI * (3 - Math.sqrt(5));
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (!isNaN(D.x[i])) continue;
        const t = k + 0.5; k++;
        const r = 26 * Math.sqrt(t);
        const a = t * golden;
        D.x[i] = cx + r * Math.cos(a) + (hash11(i * 2) - 0.5) * 8;
        D.y[i] = cy + r * Math.sin(a) + (hash11(i * 2 + 1) - 0.5) * 8;
      }
    }

    // 预热布局覆盖
    D.adopted = applyLayout(D, layout);

    return D;
  }

  // 把预算好的坐标灌进刚 build 出来的 D
  /**
   * @param {object} D build() 的产物
   * @param {Map<string, {x:number,y:number}>} layout 节点 id → 坐标
   * @returns {number} 
   */
  function applyLayout(D, layout) {
    if (!D || !layout || !layout.size || !D.n) return 0;
    const { x, y, vx, vy } = D;
    let hit = 0;
    for (let i = 0; i < D.n; i++) {
      const p = layout.get(D.id[i]);
      if (!p) continue;
      const px = p.x, py = p.y;
      // 非有限值（NaN / Infinity）绝不能写进去 —— 那会让节点永远画不出来，
      // 而且任何一次 !Number.isFinite 检查都救不回来
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      x[i] = px; y[i] = py;
      vx[i] = 0; vy[i] = 0;
      hit++;
    }
    return hit;
  }

  // 时间轴过滤 —— 单次比较，O(n)，可直接在滑块拖动时每帧调用
  /**
   * @returns {number} 目标状态发生变化的节点数
   */
  function applyCutoff(D, cutoff) {
    const n = D.n;
    const ts = D.createdAt, want = D.wantVisible;
    const kindOn = D.kindOn, kind = D.kind;
    let changed = 0;
    for (let i = 0; i < n; i++) {
      // NaN > cutoff === false
      // 无时间戳的节点永远可见
      const w = (!(ts[i] > cutoff) && kindOn[kind[i]]) ? 1 : 0;
      if (w !== want[i]) { want[i] = w; changed++; }
    }
    return changed;
  }

  // 边的可见性由两端生成
  function refreshEdgeVisibility(D) {
    const { m, lsrc, ltgt, lvisible, visible } = D;
    for (let e = 0; e < m; e++) {
      lvisible[e] = (visible[lsrc[e]] && visible[ltgt[e]]) ? 1 : 0;
    }
  }

  // 包围盒算法
  // 相机,时间线等
  // 所有节点的最小外接矩形
  function bounds(D, onlyVisible) {
    const n = D.n;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (onlyVisible && !D.visible[i]) continue;
      const x = D.x[i], y = D.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (minX === Infinity) return { minX: -1, minY: -1, maxX: 1, maxY: 1, empty: true };
    return { minX, minY, maxX, maxY, empty: false };
  }

  // 时间轴范围，从可见节点派生
  function timeRange(D) {
    let min = Infinity, max = -Infinity, any = false;
    for (let i = 0; i < D.n; i++) {
      const t = D.createdAt[i];
      if (!Number.isFinite(t)) continue;
      any = true;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    if (!any || !(max > min)) return null;
    return { min, max, duration: max - min };
  }

  // 质心
  function centroid(D, onlyVisible, out) {
    let cx = 0, cy = 0, k = 0;
    for (let i = 0; i < D.n; i++) {
      if (onlyVisible && !D.visible[i]) continue;
      cx += D.x[i]; cy += D.y[i]; k++;
    }
    if (k === 0) { out.x = 0; out.y = 0; out.k = 0; return out; }
    out.x = cx / k; out.y = cy / k; out.k = k;
    return out;
  }

  // 调试
  function stats(D) {
    const { n, m, deg, lsrc, ltgt, x, y } = D;
    let degSum = 0, degMax = 0;
    for (let i = 0; i < n; i++) { degSum += deg[i]; if (deg[i] > degMax) degMax = deg[i]; }
    const lengths = [];
    for (let e = 0; e < m; e++) {
      const a = lsrc[e], b = ltgt[e];
      lengths.push(Math.hypot(x[a] - x[b], y[a] - y[b]));
    }
    lengths.sort((p, q) => p - q);
    const pct = (p) => (lengths.length ? lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * p))] : 0);
    const bb = bounds(D, false);
    return {
      n, m,
      avgDeg: n ? +(degSum / n).toFixed(2) : 0,
      maxDeg: degMax,
      p50LinkLen: +pct(0.5).toFixed(1),
      p90LinkLen: +pct(0.9).toFixed(1),
      boundingRadius: +((Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY)) / 2).toFixed(0),
      isolated: (() => { let c = 0; for (let i = 0; i < n; i++) if (deg[i] === 0) c++; return c; })(),
    };
  }

  GFI.Data = { build, applyLayout, applyCutoff, refreshEdgeVisibility, bounds, timeRange, centroid, stats, KIND, KIND_NAMES, seedPositions };
})(window.GFI);
