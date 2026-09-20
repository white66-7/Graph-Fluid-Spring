/*
 * GFI.Interaction — 指针 / 滚轮 / 键盘
 * ===========================================================================
 * 因为我们拥有 overlay canvas 并用 setPointerCapture，这里全是自己元素上的
 * 【普通事件处理】。v1 那套 capture 阶段的 topWin 监听 + WebGL uniformMatrix3fv
 * 补丁 + 合成 PointerEvent 傀儡，全部不再需要。
 *
 * 命中测试复用物理的均匀网格：模拟醒着时每 tick 重建，睡着时【沿用上一次的】——
 * 纯相机操作期间没有任何东西移动，那张旧网格恰好是精确的，所以平移缩放零成本。
 */
(function (GFI) {
  'use strict';
  if (GFI.Interaction) return;

  const { clamp } = GFI.util;

  const TRAIL_K = 16;          // 速度采样环形缓冲容量
  const HIT_BUF = 64;          // 命中候选上限

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} hooks { onNodeActivate(node), onHoverChange(i), onSelectionChange(i), onWake() }
   */
  function create(canvas, D, cam, sim, fx, hooks) {
    const cfg = GFI.config;
    const reg = GFI.util.createListenerRegistry();
    hooks = hooks || {};

    // ---- 速度采样环形缓冲（预分配，不用 push/shift 分配）----
    const trailX = new Float64Array(TRAIL_K);
    const trailY = new Float64Array(TRAIL_K);
    const trailT = new Float64Array(TRAIL_K);
    let trailHead = 0, trailLen = 0;

    function trailPush(x, y, t) {
      if (trailLen < TRAIL_K) {
        const idx = (trailHead + trailLen) % TRAIL_K;
        trailX[idx] = x; trailY[idx] = y; trailT[idx] = t;
        trailLen++;
      } else {
        trailX[trailHead] = x; trailY[trailHead] = y; trailT[trailHead] = t;
        trailHead = (trailHead + 1) % TRAIL_K;
      }
    }

    function trailPrune(now) {
      const win = cfg.drag.sampleWindow;
      while (trailLen > 1 && now - trailT[trailHead] > win) {
        trailHead = (trailHead + 1) % TRAIL_K;
        trailLen--;
      }
    }

    function trailReset(x, y, t) {
      trailHead = 0; trailLen = 0;
      trailPush(x, y, t);
    }

    // ---- 命中测试缓冲 ----
    const hitBuf = new Int32Array(HIT_BUF);

    // ---- 状态 ----
    const state = {
      hoverIdx: -1,
      selectedIdx: -1,
      downNode: -1,
      dragNode: -1,
      panning: false,
      moved: false,
      downX: 0, downY: 0, downT: 0,
      grabNodeX: 0, grabNodeY: 0,     // 世界坐标
      offX: 0, offY: 0,               // 抓取时节点相对指针的偏移（世界坐标）
      downWorldX: 0, downWorldY: 0,
      activePointer: -1,
      // 用户是否自己操作过相机（平移/缩放/拖节点）。
      // 用于让自动适配视野让位 —— 不能跟人抢镜头。
      // 注意不能靠 onWake 来设置：平移【刻意不唤醒模拟】（否则每拖一下相机
      // 就重热整张图），所以那条路径不会触发。
      interacted: false,
      // 双指缩放
      pointers: new Map(),
      pinchDist0: 0,
      pinchK0: 1,
    };

    const inter = state;

    // =======================================================================
    // 坐标
    // =======================================================================
    function localPoint(e) {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    // =======================================================================
    // 命中测试 —— 网格粗筛 + 精确判定
    // =======================================================================
    function hitTest(sx, sy) {
      const wx = cam.screenToWorldX(sx);
      const wy = cam.screenToWorldY(sy);
      const tol = 4 / cam.k;                 // 4 屏幕像素的容差，换成世界单位
      const maxR = GFI.config.render.radiusMax / Math.max(0.01, cam.k) + tol;

      const cnt = sim.grid.collectRadius(D, wx, wy, maxR, hitBuf, D.visible);
      if (!cnt) return -1;

      let best = -1, bestD2 = Infinity, bestDeg = -1;
      for (let p = 0; p < cnt; p++) {
        const i = hitBuf[p];
        if (!D.visible[i]) continue;
        const dx = D.x[i] - wx, dy = D.y[i] - wy;
        const d2 = dx * dx + dy * dy;
        const rr = D.radius[i] / Math.max(0.01, cam.k) + tol;
        if (d2 > rr * rr) continue;
        // 度数高的优先，这样叶子叠在 hub 上时仍抓得住 hub
        if (D.deg[i] > bestDeg || (D.deg[i] === bestDeg && d2 < bestD2)) {
          best = i; bestD2 = d2; bestDeg = D.deg[i];
        }
      }
      return best;
    }

    // =======================================================================
    // 邻域高亮（只在 hover 变化时重建，不是每帧）
    // =======================================================================
    function rebuildHighlight(hot) {
      const hl = D.hl;
      if (hot < 0) { hl.fill(1, 0, D.n); return; }
      hl.fill(0, 0, D.n);
      hl[hot] = 2;
      const s = D.adjStart[hot], e = D.adjStart[hot + 1];
      for (let p = s; p < e; p++) hl[D.adjList[p]] = 2;
    }

    function setHover(i) {
      i = (typeof i === 'number' && i >= 0 && i < D.n) ? i : -1;
      if (i === state.hoverIdx) return;
      state.hoverIdx = i;
      rebuildHighlight(i >= 0 ? i : state.selectedIdx);
      canvas.style.cursor = i >= 0 ? 'pointer' : (state.panning ? 'grabbing' : 'default');
      if (hooks.onHoverChange) hooks.onHoverChange(i);
    }

    inter.setSelected = function setSelected(i) {
      i = (typeof i === 'number' && i >= 0 && i < D.n) ? i : -1;
      if (i === state.selectedIdx) return;
      state.selectedIdx = i;
      rebuildHighlight(state.hoverIdx >= 0 ? state.hoverIdx : i);
      if (hooks.onSelectionChange) hooks.onSelectionChange(i);
    };

    inter.refreshHighlight = function refreshHighlight() {
      rebuildHighlight(state.hoverIdx >= 0 ? state.hoverIdx : state.selectedIdx);
    };

    // =======================================================================
    // 指针事件
    // =======================================================================
    function wake() { if (hooks.onWake) hooks.onWake(); }

    function onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.stopPropagation();

      state.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (state.pointers.size === 2) {
        // 进入双指缩放，取消其他一切
        const pts = Array.from(state.pointers.values());
        state.pinchDist0 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
        state.pinchK0 = cam.k;
        cancelDrag();
        state.panning = false;
        return;
      }
      if (state.pointers.size > 2) return;

      const [sx, sy] = localPoint(e);
      state.interacted = true;
      state.activePointer = e.pointerId;
      state.downX = sx; state.downY = sy;
      state.downT = GFI.util.now();
      state.moved = false;

      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}

      const hit = hitTest(sx, sy);
      state.downNode = hit;

      if (hit >= 0) {
        const wx = cam.screenToWorldX(sx);
        const wy = cam.screenToWorldY(sy);
        state.grabNodeX = D.x[hit];
        state.grabNodeY = D.y[hit];
        state.offX = wx - D.x[hit];
        state.offY = wy - D.y[hit];
        state.downWorldX = wx; state.downWorldY = wy;

        // 抓起：硬 pin + 抬高 alpha 目标，让邻域活起来。
        //
        // ⚠ 孤立节点（度数 0）不能抬 alpha —— alpha 一抬，【所有】节点都受力，
        //   而孤立节点根本没有邻居，没有理由牵动别人。
        //   之前无条件抬高，拖动一个空节点会让整张图一起抖。
        sim.pin(hit, D.x[hit], D.y[hit]);
        if (D.deg[hit] > 0) sim.setAlphaTarget(cfg.reheat.dragStart);
        state.dragNode = hit;
        trailReset(sx, sy, state.downT);
        wake();
      } else {
        cam.beginPan(sx, sy);
        state.panning = true;
        canvas.style.cursor = 'grabbing';
        setHover(-1);
        // 必须唤醒渲染循环。沉降后循环是停机的，而 panning 只写在 state 上 ——
        // 停掉的循环不会再去算 busy，于是平移完全没有视觉反馈。
        wake();
      }
    }

    function onPointerMove(e) {
      e.stopPropagation();

      if (state.pointers.has(e.pointerId)) {
        state.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      }

      // 双指缩放
      if (state.pointers.size === 2) {
        const pts = Array.from(state.pointers.values());
        const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
        const mxs = (pts[0][0] + pts[1][0]) * 0.5;
        const mys = (pts[0][1] + pts[1][1]) * 0.5;
        const r = canvas.getBoundingClientRect();
        cam.zoomAt(mxs - r.left, mys - r.top, (state.pinchK0 * (d / state.pinchDist0)) / cam.k);
        wake();
        return;
      }

      const [sx, sy] = localPoint(e);

      if (state.dragNode >= 0) {
        // 用合并事件按真实输入率采样，而不是 rAF 率 —— 明显的甩掷手感提升
        const now = GFI.util.now();
        const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
        if (events && events.length) {
          const r = canvas.getBoundingClientRect();
          for (let i = 0; i < events.length; i++) {
            trailPush(events[i].clientX - r.left, events[i].clientY - r.top, now);
          }
        } else {
          trailPush(sx, sy, now);
        }
        trailPrune(now);

        const wx = cam.screenToWorldX(sx);
        const wy = cam.screenToWorldY(sy);
        const nx = wx - state.offX;
        const ny = wy - state.offY;

        if (Math.hypot(sx - state.downX, sy - state.downY) >= cfg.drag.minDragDist) state.moved = true;

        sim.pin(state.dragNode, nx, ny);
        wake();
        return;
      }

      if (state.panning) {
        if (Math.hypot(sx - state.downX, sy - state.downY) >= cfg.drag.minDragDist) state.moved = true;
        cam.panTo(sx, sy);       // 硬刹：直接赋值，没有惯性
        // ⚠ 平移【绝不】唤醒模拟 —— 每拖一下相机就重热整个图是不可接受的。
        //   但必须请求重绘（相机变了画面就得跟着变）。
        if (hooks.onCameraChange) hooks.onCameraChange();
        return;
      }

      setHover(hitTest(sx, sy));
    }

    function onPointerUp(e) {
      e.stopPropagation();
      state.pointers.delete(e.pointerId);

      if (state.pointers.size < 2) { state.pinchDist0 = 0; }
      if (state.pointers.size > 0) return;      // 还有别的手指按着

      const [sx, sy] = localPoint(e);
      const now = GFI.util.now();
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}

      if (state.dragNode >= 0) {
        const i = state.dragNode;
        const moved = state.moved;
        const dt = now - state.downT;
        state.dragNode = -1;
        sim.setAlphaTarget(0);

        const isClick = !moved && dt < cfg.drag.clickMaxMs && state.downNode === i;
        if (isClick) {
          sim.unpin(i);
          inter.setSelected(i);
          if (hooks.onNodeActivate) hooks.onNodeActivate(D.nodes[i]);
          wake();
          return;
        }

        // ---- 松手：解析解沉降 + 加权混合交接 ----
        trailPush(sx, sy, now);
        trailPrune(now);

        let vxScreen = 0, vyScreen = 0;
        if (trailLen >= 2) {
          const first = trailHead;
          const last = (trailHead + trailLen - 1) % TRAIL_K;
          const dtx = Math.max(1, trailT[last] - trailT[first]);
          vxScreen = ((trailX[last] - trailX[first]) / dtx) * 1000;
          vyScreen = ((trailY[last] - trailY[first]) / dtx) * 1000;
        }
        // 速度上限，保持方向
        const sp = Math.hypot(vxScreen, vyScreen);
        if (sp > cfg.drag.maxFlingSpeed) {
          vxScreen = (vxScreen / sp) * cfg.drag.maxFlingSpeed;
          vyScreen = (vyScreen / sp) * cfg.drag.maxFlingSpeed;
        }

        const k = Math.max(0.01, cam.k);
        const vxW = vxScreen / k;
        const vyW = vyScreen / k;

        const upWorldX = cam.screenToWorldX(sx);
        const upWorldY = cam.screenToWorldY(sy);
        const deltaX = upWorldX - state.downWorldX;
        const deltaY = upWorldY - state.downWorldY;

        const targetX = state.grabNodeX + deltaX * (1 - cfg.drag.snapBackRatio) + (vxW / 60) * cfg.drag.flingMomentum;
        const targetY = state.grabNodeY + deltaY * (1 - cfg.drag.snapBackRatio) + (vyW / 60) * cfg.drag.flingMomentum;

        const releaseX = state.grabNodeX + deltaX;
        const releaseY = state.grabNodeY + deltaY;

        // 先解 pin：之后节点由模拟积分，我们只在每帧末尾按权重混合解析解
        sim.unpin(i);
        D.x[i] = releaseX; D.y[i] = releaseY;
        // vxW 是 wu/s（解析解用的单位）；模拟内部速度是 wu/tick
        D.vx[i] = vxW * GFI.DT; D.vy[i] = vyW * GFI.DT;

        fx.startSettle(i, releaseX, releaseY, vxW, vyW, targetX, targetY, k);
        // 同样只对【有邻居】的节点重热 —— 孤立节点甩完就该安安静静停住，
        // 不该让整张图跟着一起晃。
        if (D.deg[i] > 0) sim.reheat(cfg.reheat.dragRelease);
        wake();
        return;
      }

      if (state.panning) {
        const wasMoved = state.moved;
        state.panning = false;
        cam.endPan();                    // 硬刹：什么都不做
        canvas.style.cursor = state.hoverIdx >= 0 ? 'pointer' : 'default';
        if (!wasMoved) {
          // 点空白 = 清除选中
          const hit = hitTest(sx, sy);
          if (hit < 0) inter.setSelected(-1);
        }
        return;
      }

      setHover(hitTest(sx, sy));
    }

    function onPointerCancel(e) {
      state.pointers.delete(e.pointerId);
      cancelDrag();
      if (state.panning) { state.panning = false; cam.endPan(); }
      state.activePointer = -1;
    }

    function onPointerLeave() {
      if (state.dragNode < 0 && !state.panning) setHover(-1);
    }

    function cancelDrag() {
      if (state.dragNode >= 0) {
        sim.unpin(state.dragNode);
        state.dragNode = -1;
      }
      sim.setAlphaTarget(0);
      fx.cancelSettle();
    }

    function onWheel(e) {
      e.preventDefault();
      e.stopPropagation();
      state.interacted = true;
      const [sx, sy] = localPoint(e);
      const changed = cam.zoomByWheel(sx, sy, e.deltaY);
      // ⚠ 缩放也不唤醒模拟（否则滚一下就要重跑一遍布局）。
      //   但必须重绘 —— 相机变了但画面没变就是"滚轮没反应"。
      if (changed && hooks.onCameraChange) hooks.onCameraChange();
    }

    // -----------------------------------------------------------------------
    // 键盘 —— 必须判断焦点，用户正在 Logseq 里打字时抢按键是严重 bug
    // -----------------------------------------------------------------------
    function typingInHost() {
      try {
        const el = GFI.topDoc.activeElement;
        if (!el) return false;
        const tag = (el.tagName || '').toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
      } catch (err) { return false; }
    }

    function onKeyDown(e) {
      if (typingInHost()) return;
      if (e.key === 'Escape') {
        if (state.dragNode >= 0 || fx.settleActive) { cancelDrag(); wake(); }
        else inter.setSelected(-1);
      }
    }

    // -----------------------------------------------------------------------
    reg.add(canvas, 'pointerdown', onPointerDown);
    reg.add(canvas, 'pointermove', onPointerMove);
    reg.add(canvas, 'pointerup', onPointerUp);
    reg.add(canvas, 'pointercancel', onPointerCancel);
    reg.add(canvas, 'pointerleave', onPointerLeave);
    reg.add(canvas, 'wheel', onWheel, { passive: false });
    reg.add(canvas, 'contextmenu', (e) => e.stopPropagation());
    reg.add(GFI.topWin, 'keydown', onKeyDown);

    inter.destroy = function destroy() {
      cancelDrag();
      reg.removeAll();
      state.pointers.clear();
    };

    // 初始：全部正常亮度
    rebuildHighlight(-1);

    return inter;
  }

  GFI.Interaction = { create };
})(window.GFI);
