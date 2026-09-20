/*
 * GFI.Camera — 世界↔屏幕变换、平移缩放
 * ===========================================================================
 * 硬刹：平移是【直接赋值】，松手时什么都不做 —— 零惯性、零漂移。
 *       （顺带一提，Logseq 原生图谱本来也是这样，所以这不是什么增强。）
 *
 * ⚠ 结构性约束：这个模块【不暴露任何 Effects / Timeline 能调用的动画方法】。
 *   激波必须往模拟里注入速度，绝不能靠改相机来伪装。让"缩放"和"波"
 *   在 API 层面就不可能混淆，是防止退化成 v1 那套 Matrix 劫持的最有效手段。
 */
(function (GFI) {
  'use strict';
  if (GFI.Camera) return;

  const { clamp } = GFI.util;

  function create(width, height) {
    const cfg = GFI.config.camera;

    const cam = {
      x: 0, y: 0, k: 1,
      W: width || 1,
      H: height || 1,
      halfW: (width || 1) * 0.5,
      halfH: (height || 1) * 0.5,
      // 拖动平移的起点（屏幕坐标 + 起始相机位置）
      _dragX: 0, _dragY: 0, _camX0: 0, _camY0: 0, _dragging: false,
    };

    cam.resize = function resize(w, h) {
      cam.W = Math.max(1, w);
      cam.H = Math.max(1, h);
      cam.halfW = cam.W * 0.5;
      cam.halfH = cam.H * 0.5;
    };

    // 屏幕 → 世界
    cam.screenToWorldX = (sx) => (sx - cam.halfW) / cam.k + cam.x;
    cam.screenToWorldY = (sy) => (sy - cam.halfH) / cam.k + cam.y;

    // 世界 → 屏幕
    cam.worldToScreenX = (wx) => (wx - cam.x) * cam.k + cam.halfW;
    cam.worldToScreenY = (wy) => (wy - cam.y) * cam.k + cam.halfH;

    // -----------------------------------------------------------------------
    // 平移（硬刹）
    // -----------------------------------------------------------------------
    cam.beginPan = function beginPan(sx, sy) {
      cam._dragging = true;
      cam._dragX = sx; cam._dragY = sy;
      cam._camX0 = cam.x; cam._camY0 = cam.y;
    };

    cam.panTo = function panTo(sx, sy) {
      if (!cam._dragging) return;
      cam.x = cam._camX0 - (sx - cam._dragX) / cam.k;
      cam.y = cam._camY0 - (sy - cam._dragY) / cam.k;
    };

    cam.endPan = function endPan() {
      // 硬刹：这里【故意什么都不做】。没有惯性，没有衰减，没有目标点。
      cam._dragging = false;
    };

    // -----------------------------------------------------------------------
    // 缩放（锚定光标下的世界点）
    // -----------------------------------------------------------------------
    cam.zoomAt = function zoomAt(sx, sy, factor) {
      const wx = cam.screenToWorldX(sx);
      const wy = cam.screenToWorldY(sy);
      const kNew = clamp(cam.k * factor, cfg.minZoom, cfg.maxZoom);
      if (kNew === cam.k) return false;
      cam.k = kNew;
      // 让 (wx, wy) 仍然落在同一个屏幕点上
      cam.x = wx - (sx - cam.halfW) / cam.k;
      cam.y = wy - (sy - cam.halfH) / cam.k;
      return true;
    };

    cam.zoomByWheel = function zoomByWheel(sx, sy, deltaY) {
      const factor = Math.pow(cfg.zoomBase, -deltaY);
      return cam.zoomAt(sx, sy, factor);
    };

    // -----------------------------------------------------------------------
    // 视口适配
    // -----------------------------------------------------------------------
    cam.fitBounds = function fitBounds(b, padding) {
      const pad = padding === undefined ? cfg.fitPadding : padding;
      const w = Math.max(1, b.maxX - b.minX);
      const h = Math.max(1, b.maxY - b.minY);
      const kx = (cam.W - 2 * pad) / w;
      const ky = (cam.H - 2 * pad) / h;
      cam.k = clamp(Math.min(kx, ky), cfg.minZoom, cfg.maxZoom);
      cam.x = (b.minX + b.maxX) * 0.5;
      cam.y = (b.minY + b.maxY) * 0.5;
    };

    // 视口在世界空间的矩形，外扩 margin（用于剔除；节点本身有半径，所以要外扩）
    cam.visibleRect = function visibleRect(margin, out) {
      out = out || {};
      const hw = cam.halfW / cam.k + margin;
      const hh = cam.halfH / cam.k + margin;
      out.x0 = cam.x - hw;
      out.y0 = cam.y - hh;
      out.x1 = cam.x + hw;
      out.y1 = cam.y + hh;
      return out;
    };

    cam.isPanning = () => cam._dragging;

    return cam;
  }

  GFI.Camera = { create };
})(window.GFI);
