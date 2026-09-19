(() => {
  'use strict';

  // 1. 默认物理配置 / Default Physics Configuration
  const CONFIG = {
    stiffness: 0.092,           // 刚度 / Spring tension
    damping: 0.285,             // 阻尼 / Damping ratio
    overshootMultiplier: 3.6,   // 冲量倍率 / Momentum multiplier
    minTriggerSpeed: 1.0,       // 最低触发速度 / Min trigger speed
    minDragDist: 7.0,           // 最小拖拽距离 / Min drag distance
    maxSpeed: 32.0,             // 极速钳制 / Max speed clamp
    sampleWindow: 75,           // 采样窗口 / Sampling window (ms)
    stopSpeed: 0.12,            // 停机速度阈值 / Rest velocity threshold
    stopDistance: 0.35,         // 停机位移阈值 / Rest distance threshold
  };

  // 2. 修复后的合规设置表单 (移除非法的 heading，使用标准的 4 种类型)
  const settingsSchema = [
    {
      key: 'stiffness',
      type: 'number',
      title: '🌀 [Physics] Spring Stiffness / 弹簧刚度',
      description: 'Determines return tension. Higher values snap back faster; lower values feel softer. (Recommended: 0.05 - 0.20)\n决定回弹拉力强度。数值越大回弹越迅猛，数值越小越松散绵柔。(推荐: 0.05 ~ 0.20)',
      default: 0.092,
    },
    {
      key: 'damping',
      type: 'number',
      title: '🌀 [Physics] Damping Ratio / 阻尼系数',
      description: 'Controls friction and energy loss. Lower values oscillate longer; higher values feel more viscous. (Recommended: 0.15 - 0.45)\n决定阻力衰减速度。数值越小震荡晃动越持久，数值越大越粘滞。(推荐: 0.15 ~ 0.45)',
      default: 0.285,
    },
    {
      key: 'overshootMultiplier',
      type: 'number',
      title: '🌀 [Physics] Momentum Multiplier / 惯性冲量倍率',
      description: 'Impulse factor applied to release speed. Higher values fling nodes further away. (Recommended: 1.5 - 6.0)\n甩出节点时的初速度倍数。数值越大甩得越远。(推荐: 1.5 ~ 6.0)',
      default: 3.6,
    },
    {
      key: 'maxSpeed',
      type: 'number',
      title: '🌀 [Physics] Maximum Speed Clamp / 极速钳制',
      description: 'Caps maximum release velocity to prevent nodes from flying off-screen. (Recommended: 15.0 - 60.0)\n限制节点甩出时的最高线速度，防止节点瞬间飞出屏幕。(推荐: 15 ~ 60)',
      default: 32.0,
    },
    {
      key: 'minTriggerSpeed',
      type: 'number',
      title: '🎯 [Trigger] Minimum Trigger Speed / 最低触发速度',
      description: 'Minimum release velocity required to activate spring momentum. Slower releases place nodes statically.\n松开鼠标时的线速度阈值。低于此速度视为精准定位放置，不触发弹簧。',
      default: 1.0,
    },
    {
      key: 'minDragDist',
      type: 'number',
      title: '🎯 [Trigger] Minimum Drag Distance / 最低拖拽距离',
      description: 'Minimum drag distance (px) required. Prevents accidental node shaking during regular clicks.\n拖拽的像素距离阈值，防止单击节点时误触发晃动。',
      default: 7.0,
    }
  ];

  // 3. 安全同步配置（带类型校验）
  function syncSettings() {
    if (!window.logseq || !logseq.settings) return;
    const s = logseq.settings;
    if (s.stiffness !== undefined && !isNaN(Number(s.stiffness))) {
      CONFIG.stiffness = Number(s.stiffness);
    }
    if (s.damping !== undefined && !isNaN(Number(s.damping))) {
      CONFIG.damping = Number(s.damping);
    }
    if (s.overshootMultiplier !== undefined && !isNaN(Number(s.overshootMultiplier))) {
      CONFIG.overshootMultiplier = Number(s.overshootMultiplier);
    }
    if (s.maxSpeed !== undefined && !isNaN(Number(s.maxSpeed))) {
      CONFIG.maxSpeed = Number(s.maxSpeed);
    }
    if (s.minTriggerSpeed !== undefined && !isNaN(Number(s.minTriggerSpeed))) {
      CONFIG.minTriggerSpeed = Number(s.minTriggerSpeed);
    }
    if (s.minDragDist !== undefined && !isNaN(Number(s.minDragDist))) {
      CONFIG.minDragDist = Number(s.minDragDist);
    }
    console.log('[FluidSpring] Settings synced:', CONFIG);
  }

  let observer = null;
  let scanRafId = null;
  const teardownRegistry = new Set();

  const topWin = window.parent || window;
  let topDoc = null;
  try {
    topDoc = topWin.document;
  } catch (e) {
    topDoc = window.document;
  }

  function setupGraphCanvas(canvas) {
    if (canvas.__lsFluidSpringMounted) return;
    canvas.__lsFluidSpringMounted = true;

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return;

    let isPressing = false;
    let isSpringing = false;
    let dragTrail = [];
    let animFrameId = null;
    let startX = 0, startY = 0;

    const locationStateMap = new Map();

    const trackMatrixData = (location, tx, ty) => {
      if (!isPressing || !location) return;
      let state = locationStateMap.get(location);
      if (!state) {
        state = { initX: tx, initY: ty, maxDelta: 0 };
        locationStateMap.set(location, state);
      } else {
        const delta = Math.hypot(tx - state.initX, ty - state.initY);
        if (delta > state.maxDelta) state.maxDelta = delta;
      }
    };

    const origUniformMatrix3fv = gl.uniformMatrix3fv;
    gl.uniformMatrix3fv = function (location, transpose, data) {
      if (data && data.length >= 9) trackMatrixData(location, data[6], data[7]);
      return origUniformMatrix3fv.apply(this, arguments);
    };

    const origUniformMatrix4fv = gl.uniformMatrix4fv;
    gl.uniformMatrix4fv = function (location, transpose, data) {
      if (data && data.length >= 16) trackMatrixData(location, data[12], data[13]);
      return origUniformMatrix4fv.apply(this, arguments);
    };

    const emitPointerEvent = (type, x, y, buttons) => {
      try {
        const event = new topWin.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          view: topWin,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 0,
          buttons: buttons,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        });
        event.__lsSpringInjected = true;
        canvas.dispatchEvent(event);
      } catch (e) {}
    };

    const killSpring = () => {
      if (animFrameId) {
        topWin.cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
      isSpringing = false;
    };

    const handlePointerDown = (e) => {
      if (e.__lsSpringInjected || e.button !== 0) return;
      if (isSpringing) {
        killSpring();
        emitPointerEvent('pointerup', e.clientX, e.clientY, 0);
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      isPressing = true;
      locationStateMap.clear();
      startX = e.clientX;
      startY = e.clientY;
      dragTrail = [{ x: e.clientX, y: e.clientY, t: topWin.performance.now() }];
    };

    const handlePointerMove = (e) => {
      if (e.__lsSpringInjected) return;
      if (isSpringing) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      if (!isPressing) return;
      const now = topWin.performance.now();
      dragTrail.push({ x: e.clientX, y: e.clientY, t: now });
      while (dragTrail.length > 0 && now - dragTrail[0].t > CONFIG.sampleWindow) {
        dragTrail.shift();
      }
    };

    const handlePointerUp = (e) => {
      if (e.__lsSpringInjected || !isPressing) return;
      isPressing = false;

      const totalDist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (totalDist < CONFIG.minDragDist || dragTrail.length < 2) return;

      let isViewportPan = false;
      for (const [_, state] of locationStateMap) {
        if (state.maxDelta > 3.0) {
          isViewportPan = true;
          break;
        }
      }
      if (isViewportPan) return;

      const firstSample = dragTrail[0];
      const lastSample = dragTrail[dragTrail.length - 1];
      const dt = (lastSample.t - firstSample.t) || 16.67;
      let vx = ((lastSample.x - firstSample.x) / dt) * 16.67;
      let vy = ((lastSample.y - firstSample.y) / dt) * 16.67;
      let speed = Math.hypot(vx, vy);

      if (speed < CONFIG.minTriggerSpeed) return;

      e.stopImmediatePropagation();
      e.preventDefault();

      if (speed > CONFIG.maxSpeed) {
        vx = (vx / speed) * CONFIG.maxSpeed;
        vy = (vy / speed) * CONFIG.maxSpeed;
      }

      isSpringing = true;

      const targetX = lastSample.x + vx * CONFIG.overshootMultiplier;
      const targetY = lastSample.y + vy * CONFIG.overshootMultiplier;

      let currX = lastSample.x;
      let currY = lastSample.y;
      let prevTime = topWin.performance.now();

      const loop = (currentTime) => {
        if (!isSpringing) return;

        const rawDt = Math.min(currentTime - prevTime, 32.0);
        prevTime = currentTime;

        const subDt = (rawDt / 2) / 16.667;
        for (let i = 0; i < 2; i++) {
          const ax = -CONFIG.stiffness * (currX - targetX) - CONFIG.damping * vx;
          const ay = -CONFIG.stiffness * (currY - targetY) - CONFIG.damping * vy;
          vx += ax * subDt;
          vy += ay * subDt;
          currX += vx * subDt;
          currY += vy * subDt;
        }

        emitPointerEvent('pointermove', currX, currY, 1);

        const currentSpeed = Math.hypot(vx, vy);
        const distToTarget = Math.hypot(currX - targetX, currY - targetY);

        if (currentSpeed < CONFIG.stopSpeed && distToTarget < CONFIG.stopDistance) {
          killSpring();
          emitPointerEvent('pointerup', currX, currY, 0);
          return;
        }

        animFrameId = topWin.requestAnimationFrame(loop);
      };

      animFrameId = topWin.requestAnimationFrame(loop);
    };

    canvas.addEventListener('pointerdown', handlePointerDown, { capture: true });
    topWin.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
    topWin.addEventListener('pointerup', handlePointerUp, { capture: true, passive: false });

    const teardown = () => {
      killSpring();
      try {
        gl.uniformMatrix3fv = origUniformMatrix3fv;
        gl.uniformMatrix4fv = origUniformMatrix4fv;
        canvas.removeEventListener('pointerdown', handlePointerDown, { capture: true });
        topWin.removeEventListener('pointermove', handlePointerMove, { capture: true });
        topWin.removeEventListener('pointerup', handlePointerUp, { capture: true });
      } catch (e) {}
      delete canvas.__lsFluidSpringMounted;
      teardownRegistry.delete(teardown);
    };

    teardownRegistry.add(teardown);
  }

  function scanAndMount() {
    if (!topDoc) return;
    const canvases = Array.from(topDoc.querySelectorAll('canvas')).filter(c => {
      return (c.clientWidth > 250 && c.clientHeight > 250) &&
             (c.closest('.graph-canvas, #global-graph, .page-graph, .cp__right-sidebar'));
    });
    canvases.forEach(setupGraphCanvas);
  }

  function throttledScan() {
    if (scanRafId) return;
    scanRafId = topWin.requestAnimationFrame(() => {
      scanAndMount();
      scanRafId = null;
    });
  }

  function initObserver() {
    scanAndMount();

    observer = new topWin.MutationObserver((mutations) => {
      let shouldCheck = false;
      for (let i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          shouldCheck = true;
          break;
        }
      }
      if (shouldCheck) throttledScan();
    });

    observer.observe(topDoc.body, { childList: true, subtree: true });
  }

  function destroyAll() {
    console.log('[FluidSpring] Cleaning up and unloading plugin...');
    if (scanRafId) {
      topWin.cancelAnimationFrame(scanRafId);
      scanRafId = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    for (const teardown of teardownRegistry) {
      teardown();
    }
    teardownRegistry.clear();
    console.log('[FluidSpring] Fully unloaded.');
  }

  function main() {
    try {
      initObserver();
    } catch (err) {
      console.error('[FluidSpring] Init error:', err);
    }
  }

  // 4. 规范注册与挂载
  if (typeof logseq !== 'undefined' && logseq.ready) {
    if (logseq.beforeunload) {
      logseq.beforeunload(async () => {
        destroyAll();
      });
    }

    logseq.ready().then(() => {
      // 注册标准合规的配置项
      logseq.useSettingsSchema(settingsSchema);

      // 读取初始配置
      syncSettings();

      // 监听变更
      logseq.onSettingsChanged(() => {
        syncSettings();
      });

      // 避开启动峰值执行初始化
      setTimeout(main, 300);
    }).catch(console.error);
  } else {
    setTimeout(main, 300);
  }
})();