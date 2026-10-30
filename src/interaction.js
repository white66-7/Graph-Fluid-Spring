(function (GFI) {
  'use strict';
  if (GFI.Interaction) return;

  const HIT_BUF = 64;          // 命中候选上限

  // 侧边栏或是主图谱
  let activeCanvas = null;

  function claimActive(canvas) { activeCanvas = canvas; }

  function isActive(canvas) { return activeCanvas === null || activeCanvas === canvas; }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} hooks { onNodeActivate(node), onHoverChange(i), onSelectionChange(i), onWake() }
   */
  function create(canvas, D, cam, sim, hooks) {
    const cfg = GFI.config;
    const reg = GFI.util.createListenerRegistry();
    hooks = hooks || {};

    // ---- 命中测试缓冲 ----
    const hitBuf = new Int32Array(HIT_BUF);

    // ---- 状态 ----
    const state = {
      hoverIdx: -1,  // 悬停
      selectedIdx: -1,  // 选中
      downNode: -1,  
      dragNode: -1,  // 拖动节点
      panning: false,  // 平移
      moved: false,
      downX: 0, downY: 0, downT: 0,
      // 抓取时节点相对指针的偏移
      offX: 0, offY: 0,               
      interacted: false,
      // 双指缩放
      pointers: new Map(),
      pinchDist0: 0,
      pinchK0: 1,
    };

    const inter = state;

    // 坐标
    function localPoint(e) {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    // 命中测试
    function hitTest(sx, sy) {
      const wx = cam.screenToWorldX(sx);
      const wy = cam.screenToWorldY(sy);
      // 4 屏幕像素的容差
      const tol = 4 / cam.k;                 
      const rcfg = GFI.config.render;
      const maxR = rcfg.radiusMax * rcfg.nodeSize / Math.max(0.01, cam.k) + tol;

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

    // 邻域高亮
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

    // 指针事件
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
      state.downX = sx; state.downY = sy;
      state.downT = GFI.util.now();
      state.moved = false;

      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}

      const hit = hitTest(sx, sy);
      state.downNode = hit;

      if (hit >= 0) {
        const wx = cam.screenToWorldX(sx);
        const wy = cam.screenToWorldY(sy);
        // 抓取偏移：节点中心不跳到指针上，保持你按下时的相对位置（不"跳手"）
        state.offX = wx - D.x[hit];
        state.offY = wy - D.y[hit];

        // 抓起：硬 pin + 抬高 alpha 目标，让邻域活起来。
        //
        // ⚠ 孤立节点（度数 0）不能抬 alpha —— alpha 一抬，【所有】节点都受力，
        //   而孤立节点根本没有邻居，没有理由牵动别人。
        //   之前无条件抬高，拖动一个空节点会让整张图一起抖。
        sim.pin(hit, D.x[hit], D.y[hit]);
        // 抬高 alpha 目标：让你【握着】的这段时间里邻域一直是活的
        // （否则 alpha 会在 ~1s 内自己衰减掉，握着也不动）。
        //
        //  这里【只】设目标，绝不能顺手 reheat —— 因为此刻还分不清"点一下"和
        //   "抓起来拖"。reheat 是瞬时的，放在这儿的话，一次普通点击（pin 完立刻
        //   unpin）也会把整张图重热到 dragStart：力全部按 0.3 重新作用约 1.7 秒，
        //   图谱会先抖 / 重排一下再跳转 —— 看起来就是"点一下会跳"。
        //   重热推迟到 onPointerMove 里首次越过 minDragDist 的那一刻。
        if (D.deg[hit] > 0) sim.setAlphaTarget(cfg.reheat.dragStart);
        // ⚠ 局部弹簧增益【不在这里挂】—— 与 reheat 同理：此刻还分不清"点一下"和
        //   "抓起来拖"。实测（test/drag-jitter-probe.js）在 pointerdown 就挂上，
        //   指针【还没动】邻居峰速就从 1.7 涨到 4.0 wu/tick —— 一按就抖。
        //   推迟到 onPointerMove 首次越过 minDragDist 的那一刻。
        state.dragNode = hit;
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
        const wx = cam.screenToWorldX(sx);
        const wy = cam.screenToWorldY(sy);
        const nx = wx - state.offX;
        const ny = wy - state.offY;

        if (!state.moved && Math.hypot(sx - state.downX, sy - state.downY) >= cfg.drag.minDragDist) {
          state.moved = true;
          // ⚠ 重热发生在【拖拽真正开始】的这一刻，而不是 pointerdown。
          //   reheat 是"alpha 下限，取 max"，瞬时生效 —— 这是手感的关键
          //   （只靠 setAlphaTarget 的话，alpha 按 alphaDecay 指数爬升，
          //     实测到目标一半要 41 个 tick ≈ 683ms，抓起 hub 后邻域一秒才活）。
          //   但正因为它是瞬时的，就只能在"确定是拖拽"之后调：放在 pointerdown
          //   会让普通点击也重热整张图，图谱先抖一下再跳转。
          //   0.0 的悬停不算 —— 只有真的动了 minDragDist 才重热。
          //
          //   同一条理由也适用于局部弹簧增益：它同样是"确定是拖拽了"才挂。
          if (D.deg[state.dragNode] > 0) {
            sim.reheat(cfg.reheat.dragStart);
            // 只增益【被拖节点自己的】关联边，让邻居跟着走（见 physics.js forceLink）
            sim.setDragLinkBoost(state.dragNode, cfg.drag.linkBoost);
          }
        }

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
        sim.setDragLinkBoost(-1, 1);

        const isClick = !moved && dt < cfg.drag.clickMaxMs && state.downNode === i;
        if (isClick) {
          sim.unpin(i);
          inter.setSelected(i);
          if (hooks.onNodeActivate) hooks.onNodeActivate(D.nodes[i]);
          wake();
          return;
        }

        // ---- 松手：交还给物理，但把 alpha 压到低位 ----
        //
        // d3-drag 的官方惯例是 dragend 时 alphaTarget(0)、让 alpha 从拖拽期的
        // 0.3 自然衰减。实测（test/drag-probe.js）那样节点会被连线一路拽回去：
        // 拖 234wu 回弹 156wu，【轻推 50wu 更是被甩到 112wu —— 冲过原位 60wu】。
        // 因为回弹幅度几乎正比于松手后的 alpha（弹簧力同样乘 alpha）。
        // 压到 releaseAlpha 之后：大拖回弹 156→83wu，小拖峰值 112→29wu。
        //
        // ⚠ 不能压到 0.02 以下：图会僵住，拖拽期间留下的残余变形收不回来
        //   （末尾最近邻距离 27 → 43wu）。
        //
        // 坐标不用补：sim.pin() 是同步写 x/y 的，而 applyPins 每 tick 还会把被钉
        // 节点的速度清零 —— 所以下面这两行是显式重申，不依赖那个不变量。
        sim.unpin(i);
        D.vx[i] = 0; D.vy[i] = 0;
        if (D.deg[i] > 0 && sim.alpha > cfg.drag.releaseAlpha) sim.alpha = cfg.drag.releaseAlpha;
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
    }

    function onPointerLeave() {
      if (state.dragNode < 0 && !state.panning) setHover(-1);
    }

    function cancelDrag() {
      if (state.dragNode >= 0) {
        sim.unpin(state.dragNode);
        state.dragNode = -1;
      }
      sim.setDragLinkBoost(-1, 1);
      sim.setAlphaTarget(0);
    }

    // 右键后固定或解除固定节点
    function onContextMenu(e) {
      e.preventDefault();
      e.stopPropagation();
      const [sx, sy] = localPoint(e);
      const hit = hitTest(sx, sy);
      if (hit < 0) return;
      if (sim.isPinned(hit)) {
        sim.unpin(hit);
        // 解放回物理
        if (D.deg[hit] > 0) sim.reheat(cfg.reheat.dragRelease);
      } else {
        sim.pin(hit, D.x[hit], D.y[hit]);
      }
      wake();
    }

    function onWheel(e) {
      e.preventDefault();
      e.stopPropagation();
      state.interacted = true;
      const [sx, sy] = localPoint(e);
      const changed = cam.zoomByWheel(sx, sy, e.deltaY);
      //  缩放也不唤醒模拟（否则滚一下就要重跑一遍布局）。
      //   但必须重绘 —— 相机变了但画面没变就是"滚轮没反应"。
      if (changed && hooks.onCameraChange) hooks.onCameraChange();
    }

    // 键盘 —— 必须判断焦点，用户正在 Logseq 里打字时抢按键是严重 bug
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
      // 只认活跃画布 —— 否则在侧边栏按 Esc 会连全屏图谱的选中一起清掉
      if (!isActive(canvas)) return;
      if (e.key === 'Escape') {
        if (state.dragNode >= 0) { cancelDrag(); wake(); }
        else inter.setSelected(-1);
      }
    }

    // 指针碰过哪块画布哪块活跃
    reg.add(canvas, 'pointerenter', () => claimActive(canvas));
    reg.add(canvas, 'pointerdown', () => claimActive(canvas));
    if (activeCanvas === null) activeCanvas = canvas;

    // 鼠标左键按下
    reg.add(canvas, 'pointerdown', onPointerDown);
    // 鼠标移动
    reg.add(canvas, 'pointermove', onPointerMove);
    // 鼠标松开左键
    reg.add(canvas, 'pointerup', onPointerUp);

    // 浏览器/系统取消
    reg.add(canvas, 'pointercancel', onPointerCancel);

    // 移出canvas边界
    reg.add(canvas, 'pointerleave', onPointerLeave);  

    // 滚轮
    reg.add(canvas, 'wheel', onWheel, { passive: false });

    // 固定节点
    reg.add(canvas, 'contextmenu', onContextMenu);

    // 键盘
    reg.add(GFI.topWin, 'keydown', onKeyDown);

    inter.destroy = function destroy() {
      cancelDrag();
      reg.removeAll();
      state.pointers.clear();
      if (activeCanvas === canvas) activeCanvas = null;
    };

    // 初始：全部正常亮度
    rebuildHighlight(-1);

    return inter;
  }

  GFI.Interaction = { create };
})(window.GFI);
