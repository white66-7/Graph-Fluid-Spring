/*
 * GFI.Spatial — CSR 均匀网格
 * ===========================================================================
 * 一个网格四处复用：斥力截断求和、碰撞检测、鼠标命中测试、视口剔除。
 *
 * 为什么用网格而不是 Barnes-Hut：
 *   Logseq 原生图谱的斥力就有 distanceMax=420 硬截断（logic.cljs charge-strength）。
 *   有硬截断时，Barnes-Hut 反而【更不准】—— 它会去近似那些本该为零的远场相互作用。
 *   均匀网格做精确截断求和是 O(N)，且完全等价。
 *
 * 零分配：两趟计数 + 前缀和 + 散射。容量不足时才重新分配。
 *
 * ⚠ 网格几何陷阱（会静默丢力）：
 *   用「固定 5×5 扫描」时，节点在格内偏移 u ∈ [0,c) 看到的世界范围是 [-2c-u, 3c-u]，
 *   要覆盖 ±R 需要 c ≥ R/2（在 u=c 时最紧）。这里改用【按节点精确位置算索引区间】，
 *   不需要那个论证，只多两次乘法和两次取整。
 */
(function (GFI) {
  'use strict';
  if (GFI.Spatial) return;

  const EMPTY_MASK = null;

  function create(cellSize) {
    const grid = {
      cellSize,
      inv: 1 / cellSize,
      minX: 0, minY: 0,
      cols: 0, rows: 0,
      // 公开给热循环直接内联遍历
      cellStart: new Uint32Array(0),
      items: new Uint32Array(0),
      count: 0,
      // 内部复用缓冲
      _counts: new Uint32Array(0),
      _cursor: new Uint32Array(0),
    };

    function ensureCellCapacity(cells) {
      if (grid.cellStart.length < cells + 1) grid.cellStart = new Uint32Array(cells + 1);
      if (grid._counts.length < cells) grid._counts = new Uint32Array(cells);
      if (grid._cursor.length < cells) grid._cursor = new Uint32Array(cells);
    }

    function ensureItemCapacity(k) {
      if (grid.items.length < k) grid.items = new Uint32Array(Math.max(k, 64));
    }

    /**
     * 重建网格。
     * @param {object} D GraphData（读 x/y，以及 mask）
     * @param {Uint8Array|null} mask 长度 n 的包含掩码；null = 全部纳入
     * @returns {number} 纳入的节点数
     */
    grid.build = function build(D, mask) {
      const n = D.n;
      if (n === 0) { grid.cols = grid.rows = 0; grid.count = 0; return 0; }

      // ---- 1. 包围盒（只看纳入的节点；用 mask 先过滤，否则空节点会把网格撑大）----
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) continue;
        const x = D.x[i], y = D.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (minX === Infinity) { grid.cols = grid.rows = 0; grid.count = 0; return 0; }

      const cs = grid.cellSize;
      const inv = 1 / cs;
      // 左右各留一格余量，让「按半径算出的索引区间」不会越界
      grid.minX = minX - cs;
      grid.minY = minY - cs;
      grid.inv = inv;

      const cols = Math.max(1, Math.ceil((maxX - grid.minX) * inv) + 1);
      const rows = Math.max(1, Math.ceil((maxY - grid.minY) * inv) + 1);
      const cells = cols * rows;
      grid.cols = cols;
      grid.rows = rows;

      ensureCellCapacity(cells);
      const counts = grid._counts;
      counts.fill(0, 0, cells);

      // ---- 2. 第一趟：计数 ----
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) continue;
        const x = D.x[i], y = D.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const cx = ((x - grid.minX) * inv) | 0;
        const cy = ((y - grid.minY) * inv) | 0;
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        counts[cy * cols + cx]++;
        k++;
      }
      grid.count = k;

      // ---- 3. 前缀和 ----
      const cellStart = grid.cellStart;
      let acc = 0;
      for (let c = 0; c < cells; c++) {
        cellStart[c] = acc;
        acc += counts[c];
      }
      cellStart[cells] = acc;

      // ---- 4. 第二趟：散射 ----
      ensureItemCapacity(k);
      const items = grid.items;
      const cursor = grid._cursor;
      cursor.set(cellStart.subarray(0, cells), 0);

      for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) continue;
        const x = D.x[i], y = D.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const cx = ((x - grid.minX) * inv) | 0;
        const cy = ((y - grid.minY) * inv) | 0;
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        items[cursor[cy * cols + cx]++] = i;
      }

      return k;
    };

    /**
     * 收集落在世界矩形内的节点索引（视口剔除用）。
     * @param {Int32Array} out 预分配输出数组
     * @returns {number} 写入个数
     */
    grid.collectRect = function collectRect(D, x0, y0, x1, y1, out, mask) {
      const cols = grid.cols, rows = grid.rows;
      if (!cols || !rows) return 0;

      const inv = grid.inv, minX = grid.minX, minY = grid.minY;
      let cx0 = ((x0 - minX) * inv) | 0;
      let cy0 = ((y0 - minY) * inv) | 0;
      let cx1 = ((x1 - minX) * inv) | 0;
      let cy1 = ((y1 - minY) * inv) | 0;
      if (cx0 < 0) cx0 = 0;
      if (cy0 < 0) cy0 = 0;
      if (cx1 >= cols) cx1 = cols - 1;
      if (cy1 >= rows) cy1 = rows - 1;
      if (cx0 > cx1 || cy0 > cy1) return 0;

      const cellStart = grid.cellStart, items = grid.items;
      const xs = D.x, ys = D.y;
      let outN = 0;
      const cap = out.length;

      for (let cy = cy0; cy <= cy1; cy++) {
        const rowBase = cy * cols;
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = rowBase + cx;
          const end = cellStart[c + 1];
          for (let p = cellStart[c]; p < end; p++) {
            const i = items[p];
            if (mask && !mask[i]) continue;
            const x = xs[i], y = ys[i];
            if (x < x0 || x > x1 || y < y0 || y > y1) continue;
            if (outN >= cap) return outN;      // 静默截断由调用方通过返回数 < cap 检测
            out[outN++] = i;
          }
        }
      }
      return outN;
    };

    /**
     * 命中测试：返回世界坐标 (x,y) 附近 tol 半径内的候选节点。
     * 只做粗筛，精确判定（含每节点半径）交给调用方。
     */
    grid.collectRadius = function collectRadius(D, x, y, r, out, mask) {
      const cols = grid.cols, rows = grid.rows;
      if (!cols || !rows) return 0;

      const inv = grid.inv, minX = grid.minX, minY = grid.minY;
      let cx0 = ((x - r - minX) * inv) | 0;
      let cy0 = ((y - r - minY) * inv) | 0;
      let cx1 = ((x + r - minX) * inv) | 0;
      let cy1 = ((y + r - minY) * inv) | 0;
      if (cx0 < 0) cx0 = 0;
      if (cy0 < 0) cy0 = 0;
      if (cx1 >= cols) cx1 = cols - 1;
      if (cy1 >= rows) cy1 = rows - 1;
      if (cx0 > cx1 || cy0 > cy1) return 0;

      const cellStart = grid.cellStart, items = grid.items;
      const xs = D.x, ys = D.y;
      const r2 = r * r;
      let outN = 0;
      const cap = out.length;

      for (let cy = cy0; cy <= cy1; cy++) {
        const rowBase = cy * cols;
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = rowBase + cx;
          const end = cellStart[c + 1];
          for (let p = cellStart[c]; p < end; p++) {
            const i = items[p];
            if (mask && !mask[i]) continue;
            const dx = xs[i] - x, dy = ys[i] - y;
            if (dx * dx + dy * dy > r2) continue;
            if (outN >= cap) return outN;
            out[outN++] = i;
          }
        }
      }
      return outN;
    };

    return grid;
  }

  GFI.Spatial = { create, EMPTY_MASK };
})(window.GFI);
