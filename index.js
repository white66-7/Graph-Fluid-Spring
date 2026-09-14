(() => {
  'use strict';

  const topWin = window.parent || window;
  const topDoc = topWin.document;

  const CONFIG = {
    stiffness: 0.092,
    damping: 0.285,
    overshootMultiplier: 3.6,
    minTriggerSpeed: 1.0,
    minDragDist: 7.0,
    maxSpeed: 32.0,
    sampleWindow: 75,
    stopSpeed: 0.12,
    stopDistance: 0.35,
  };

  let observer = null;

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

    canvas.__lsFluidSpringTeardown = () => {
      killSpring();
      gl.uniformMatrix3fv = origUniformMatrix3fv;
      gl.uniformMatrix4fv = origUniformMatrix4fv;
      canvas.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      topWin.removeEventListener('pointermove', handlePointerMove, { capture: true });
      topWin.removeEventListener('pointerup', handlePointerUp, { capture: true });
      delete canvas.__lsFluidSpringMounted;
      delete canvas.__lsFluidSpringTeardown;
    };
  }

  function scanAndMount() {
    const canvases = Array.from(topDoc.querySelectorAll('canvas')).filter(c => {
      return c.clientWidth > 250 && c.clientHeight > 250 &&
             (c.closest('.graph-canvas, #global-graph, .page-graph, .cp__right-sidebar'));
    });
    canvases.forEach(setupGraphCanvas);
  }

  function initObserver() {
    scanAndMount();
    observer = new topWin.MutationObserver(() => {
      scanAndMount();
    });
    observer.observe(topDoc.body, {
      childList: true,
      subtree: true
    });
  }

  function destroyAll() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    const mountedCanvases = Array.from(topDoc.querySelectorAll('canvas')).filter(c => c.__lsFluidSpringMounted);
    mountedCanvases.forEach(c => {
      if (typeof c.__lsFluidSpringTeardown === 'function') {
        c.__lsFluidSpringTeardown();
      }
    });
  }

  function main() {
    initObserver();
    if (window.logseq) {
      window.logseq.beforeunload(async () => {
        destroyAll();
      });
    }
  }

  if (window.logseq) {
    window.logseq.ready(main).catch(console.error);
  } else {
    main();
  }
})();