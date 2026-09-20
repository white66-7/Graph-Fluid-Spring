/*
 * GFI.Data — 原始数据 → 定型数组 (SoA) + CSR 邻接
 * ===========================================================================
 * 一切数组只在 build() 时分配一次，之后整个生命周期零分配。
 * 热循环里不允许出现对象字面量、闭包、forEach。
 *
 * 关键技巧：createdAt 缺失存 NaN。
 *   可见性判定退化为单次比较  !(createdAt[i] > cutoff)
 *   NaN > cutoff 恒为 false → 无时间戳的节点永远可见，无需存在性分支。
 */
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

  // -------------------------------------------------------------------------
  // 种子布局：黄金角螺旋（phyllotaxis）
  // 作用：给模拟一个不重叠、无聚集的初值。若全部从原点出发，
  //       1/d² 斥力会产生巨大冲量直接发散成 NaN。
  // -------------------------------------------------------------------------
  function seedPositions(data) {
    const { n, x, y, deg } = data;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spacing = 26;
    for (let i = 0; i < n; i++) {
      // 度数高的节点放内圈，视觉上先立起骨架
      const t = i + 0.5;
      const r = spacing * Math.sqrt(t);
      const a = t * golden;
      x[i] = r * Math.cos(a);
      y[i] = r * Math.sin(a);
    }
    // 一点点确定性噪声，打破完美螺旋的对称性（否则退化情形下会锁在对称态）
    for (let i = 0; i < n; i++) {
      x[i] += (hash11(i * 2) - 0.5) * 8;
      y[i] += (hash11(i * 2 + 1) - 0.5) * 8;
    }
  }

  // -------------------------------------------------------------------------
  // build
  // -------------------------------------------------------------------------
  /**
   * @param {Array<{id,label,kind,createdAt?,color?,degree?}>} rawNodes
   * @param {Array<{source,target,label?}>} rawLinks
   * @param {object} [prev] 上一次的 GraphData —— 存活 id 的位置会被继承，
   *                        这样数据重载时图谱不会整个跳回随机位置
   */
  function build(rawNodes, rawLinks, prev) {
    rawNodes = rawNodes || [];
    rawLinks = rawLinks || [];

    const cfg = GFI.config.physics;
    const rcfg = GFI.config.render;

    // ---- 索引 id 并丢弃重复 / 非法 ----
    const indexById = new Map();
    const nodes = [];
    for (let i = 0; i < rawNodes.length; i++) {
      const nd = rawNodes[i];
      if (!nd || nd.id === undefined || nd.id === null) continue;
      const id = String(nd.id);
      if (indexById.has(id)) continue;
      indexById.set(id, nodes.length);
      nodes.push(nd);
    }
    const n = nodes.length;

    // ---- 只保留两端都存在的边 ----
    const links = [];
    const seenEdge = new Set();
    for (let i = 0; i < rawLinks.length; i++) {
      const lk = rawLinks[i];
      if (!lk) continue;
      const s = indexById.get(String(lk.source));
      const t = indexById.get(String(lk.target));
      if (s === undefined || t === undefined || s === t) continue;
      const key = s < t ? s * 0x100000 + t : t * 0x100000 + s;
      if (seenEdge.has(key)) continue;   // 去重：无向图，同一对只留一条
      seenEdge.add(key);
      links.push({ s, t, label: lk.label });
    }
    const m = links.length;

    // =====================================================================
    // 分配
    // =====================================================================
    const D = {
      n, m, nodes, links, indexById,
      KIND, KIND_NAMES,

      // 输入派生，build 后不变
      id: new Array(n),
      label: new Array(n),
      kind: new Uint8Array(n),
      colorIdx: new Uint8Array(n),
      colorTable: [],          // 固定调色板；渲染器按索引批量分组，避免每帧字符串比较
      deg: new Uint16Array(n),
      radius: new Float32Array(n),
      charge: new Float32Array(n),
      createdAt: new Float64Array(n),
      labelRank: new Uint8Array(n),
      adjStart: new Uint32Array(n + 1),
      adjList: new Uint32Array(Math.max(1, m * 2)),

      // 模拟状态
      x: new Float32Array(n),
      y: new Float32Array(n),
      vx: new Float32Array(n),
      vy: new Float32Array(n),
      ax: new Float32Array(n),
      ay: new Float32Array(n),
      pinMode: new Uint8Array(n),
      fx: new Float32Array(n),
      fy: new Float32Array(n),
      tx: new Float32Array(n),
      ty: new Float32Array(n),
      simWeight: new Float32Array(n),

      // 特效 / 渲染状态
      // visible      = 当前是否绘制（淡出动画播完才置 0）
      // wantVisible  = 按 cutoff 计算出的目标可见性（时间轴写的，特效读的）
      // 两者分离是必须的：否则 cutoff 一过节点就消失，淡出动画根本没机会播。
      visible: new Uint8Array(n),
      wantVisible: new Uint8Array(n),
      // 按类型（kind）的显示开关，5 个元素对应 KIND 枚举。全部默认开。
      // 类型过滤走 wantVisible 这条既有通路，于是能白拿淡入淡出/弹出/重热一整套机制，
      // 不用在渲染层另开一个"部分隐藏"的概念。
      kindOn: new Uint8Array(5).fill(1),
      renderAlpha: new Float32Array(n),
      scaleMul: new Float32Array(n),
      popT: new Float32Array(n),      // NaN = 未激活
      popDur: new Float32Array(n),
      fadeT: new Float32Array(n),     // NaN = 未激活
      fadeFrom: new Float32Array(n),

      // 边
      lsrc: new Uint32Array(m),
      ltgt: new Uint32Array(m),
      ldist: new Float32Array(m),
      lstr: new Float32Array(m),
      lvisible: new Uint8Array(m),

      // 渲染暂存
      hl: new Uint8Array(n),          // 0=压暗 1=邻接 2=自身
    };

    // =====================================================================
    // 调色板表
    // =====================================================================
    // 先放入 5 个 kind 色，之后允许少量自定义色，总量封顶。
    // 超出后回退到 kind 色 —— 宁可颜色近似，也不能让渲染器的分桶数和精灵缓存爆炸。
    const MAX_COLORS = 12;
    D.colorTable = PALETTE_ORDER.map((k) => rcfg.palette[k] || '#8a8f98');
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

    // =====================================================================
    // 逐节点填充
    // =====================================================================
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      D.id[i] = String(nd.id);
      D.label[i] = nd.label == null ? '' : String(nd.label);
      D.kind[i] = kindToEnum(nd.kind);

      // 调色板索引。渲染器按 colorIdx 分组批量 fill，所以颜色表必须很小 ——
      // 若每页都有独立颜色，精灵缓存和分桶都会被撑爆。
      const pal = KIND_NAMES[D.kind[i]] || 'page';
      const kindHex = rcfg.palette[pal] || rcfg.palette.page;
      D.colorIdx[i] = colorIdxFor(nd.color ? String(nd.color) : kindHex, kindHex);

      // createdAt：缺失 → NaN（见文件头说明）
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

    // =====================================================================
    // 度数 + CSR 邻接
    // =====================================================================
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
    // scatter（用一份游标副本）
    const cursor = D.adjStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      const { s, t } = links[e];
      D.adjList[cursor[s]++] = t;
      D.adjList[cursor[t]++] = s;
    }

    // =====================================================================
    // 由度数派生：半径 / 斥力 / 标签优先级 / 边参数
    // =====================================================================
    for (let i = 0; i < n; i++) {
      const d = D.deg[i];
      const sd = Math.sqrt(d);

      D.radius[i] = clamp(rcfg.radiusBase + rcfg.radiusScale * sd, rcfg.radiusMin, rcfg.radiusMax);

      // 斥力随度数增长 —— 最"Obsidian"的一个参数：hubs 撑开空地，叶子保持紧密
      const gain = 1 + cfg.chargeDegGain * sd;
      D.charge[i] = -Math.abs(cfg.charge) * Math.min(gain, cfg.chargeDegCap);
    }

    // 标签优先级：按度数排名映射到 0..255（0 = 最优先显示）
    // 绝不在每帧排序 —— 排序在 build 时做一次
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const ordArr = Array.from(order);
    ordArr.sort((a, b) => (D.deg[b] - D.deg[a]) || (a - b));
    for (let r = 0; r < n; r++) {
      D.labelRank[ordArr[r]] = n > 1 ? Math.round((r / (n - 1)) * 255) : 0;
    }

    // 边：长度按两端较小度数微调，强度按度数归一
    for (let e = 0; e < m; e++) {
      const { s, t } = links[e];
      const minDeg = Math.max(1, Math.min(D.deg[s], D.deg[t]));
      D.lsrc[e] = s;
      D.ltgt[e] = t;
      D.ldist[e] = cfg.linkDistance * (1 + 0.35 / minDeg);
      D.lstr[e] = clamp(cfg.linkStrength / minDeg, 0.02, 0.5);
      D.lvisible[e] = 1;
    }

    // =====================================================================
    // 初始位置
    // =====================================================================
    let inherited = 0;
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
      // 新节点用螺旋种子补位，再叠加到已有质心上，避免新节点全挤在原点
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

    return D;
  }

  // -------------------------------------------------------------------------
  // 时间轴过滤 —— 单次比较，O(n)，可直接在滑块拖动时每帧调用
  // -------------------------------------------------------------------------
  /**
   * 只写 wantVisible，【不碰 visible】。
   * 实际切换交给 Timeline —— 它要在淡出动画播完之后才把 visible 置 0。
   * @returns {number} 目标状态发生变化的节点数
   */
  function applyCutoff(D, cutoff) {
    const n = D.n;
    const ts = D.createdAt, want = D.wantVisible;
    const kindOn = D.kindOn, kind = D.kind;
    let changed = 0;
    for (let i = 0; i < n; i++) {
      // NaN > cutoff === false  →  无时间戳的节点永远可见
      const w = (!(ts[i] > cutoff) && kindOn[kind[i]]) ? 1 : 0;
      if (w !== want[i]) { want[i] = w; changed++; }
    }
    return changed;
  }

  // 边的可见性由两端派生，不存储（避免滑块拖动时还要维护 m 个状态）
  function refreshEdgeVisibility(D) {
    const { m, lsrc, ltgt, lvisible, visible } = D;
    for (let e = 0; e < m; e++) {
      lvisible[e] = (visible[lsrc[e]] && visible[ltgt[e]]) ? 1 : 0;
    }
  }

  // -------------------------------------------------------------------------
  // 包围盒 / 视口适配
  // -------------------------------------------------------------------------
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

  // 时间轴范围（ms epoch），从可见节点派生
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

  // -------------------------------------------------------------------------
  // 调试 / 标定
  // -------------------------------------------------------------------------
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

  GFI.Data = { build, applyCutoff, refreshEdgeVisibility, bounds, timeRange, centroid, stats, KIND, KIND_NAMES, seedPositions };
})(window.GFI);
