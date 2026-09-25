/*
 * GFI — 配置中心
 * ===========================================================================
 * 所有可调参数集中在这里。物理量的单位约定：
 *   力 = "alpha=1 时每 1/60 秒的速度增量"（沿用 d3-force 的约定，
 *        这样所有 d3 教程里的数值可以直接搬过来）
 *   长度单位是"世界单位"(wu)，绝对值无意义 —— fitView 会做归一化，只有比值重要
 *   时间单位是秒
 */
(function (GFI) {
  'use strict';
  if (GFI.config) return;

  const defaults = {
    // =======================================================================
    // 物理
    // =======================================================================
    physics: {
      charge: -0.10,          // 整体疏密。绝对值×1.5 更空灵，×0.6 更结团
      chargeFalloff: 0,
      chargeDegGain: 0.5,     // 斥力随度数增长：×(1 + gain·√deg)
      chargeDegCap: 8,        // 上述倍率的上限
      distanceMin: 12,        // 软化近距奇点
      distanceMax: 420,       // 斥力截断半径
      linkDistance: 82,       // 边长
      linkStrength: 0.3,      // 边刚度
      velocityRetain: 0.80,   // 每帧速度保留率
      settleTicks: 400,       // alpha 1→alphaMin 的 tick 数
      collideStrength: 0.85,  // 重叠消解强度
      skipIsolatedCharge: true,
      gravity: 3,             // 向心恒力
      gravityDeadzone: 40,    // 死区半径
      centerStrength: 0.02,   // 刚性回正
      alphaMin: 0.001,
      collideCell: 32,        // 碰撞微网格边长

      // 零度节点（无连边）锚定外圈环
      isolatedRing: {
        enabled: true,
        factor: 1.18,
        strength: 0.05,
      },
    },

    // 重热幅度（alpha 下限，取 max）
    reheat: {
      dataChange: 0.6,
      cutoff: 0.45,
      // 🌟 0.32：赋予整个团簇足够的物理动能去吸纳新节点并自然膨胀
      timelinePlay: 0.32,
      dragStart: 0.3,
      dragRelease: 0.4,
      pulse: 0.5,
      fadeStart: 0.2,
      resize: 0.2,
      filter: 0.3,
    },

    // =======================================================================
    // pop-out 弹簧（纯渲染层，绝不进模拟）
    // =======================================================================
    pop: {
      amp: 0.55,
      // 🌟 调优黄金频率：24（既不拖沓，又能看清弹簧缩放细节）
      omega: 24,
      zeta: 0.30,
      // 🌟 0.5 秒从容收敛，收放自如
      maxDuration: 0.50,
      fadeInTime: 0.08,
      simWeightRamp: 0.01,
      radialWaveSpeed: 1200,
      maxRadialDelay: 0.35,
      maxIndexDelay: 0.25,
    },

    // =======================================================================
    // 激波 —— 行进波前
    // =======================================================================
    shock: {
      speed: 2400,
      decayLen: 1800,
      // 🌟 关闭全屏扩散激波，彻底消除“远近节点被先后击中”的时差拖沓感
      magnitude: 0,
      jitter: 0.30,
      massFactor: 0.06,
      maxRadiusFactor: 1.25,
      maxRadius: 2600,
      maxDisplacementRatio: 0.22,
      backwardSign: -1,
    },

    // =======================================================================
    // 拖拽
    // =======================================================================
    drag: {
      snapBackRatio: 0.22,
      // 🌟 保留你测试最舒适的果冻手感参数
      elasticStiffness: 3.5,
      jellyDamping: 0.65,
      flingMomentum: 1.4,
      minDragDist: 5.0,
      sampleWindow: 60,
      maxFlingSpeed: 1800,
      handoffTail: 0.45,
      handoffMinTime: 0.2,
      maxSettleTime: 1.5,
      clickMaxMs: 600,
    },

    // =======================================================================
    // 相机
    // =======================================================================
    camera: {
      minZoom: 0.05,
      maxZoom: 6,
      zoomBase: 1.0012,
      fitPadding: 72,
    },

    // =======================================================================
    // 渲染
    // =======================================================================
    render: {
      maxDpr: 2,
      bgFallback: '#0d0f14',
      bgCssVar: '--ls-primary-background-color',

      radiusBase: 2.0,
      radiusScale: 0.95,
      radiusMin: 2.0,
      radiusMax: 14,

      glowRadiusBuckets: [3, 4, 6, 8, 11, 16, 22],
      glowSpread: 2.0,

      edgeColor: 'rgba(180,200,230,0.75)',
      edgeColorDim: 'rgba(180,200,230,0.22)',
      edgeColorHi: 'rgba(160,200,255,0.95)',
      edgeWidthMin: 1.0,
      edgeWidthMax: 2.5,
      edgeWidthBase: 0.8,
      edgeWidthSlope: 0.6,

      labelShowScaleRatio: 0.60,
      labelHideScaleRatio: 0.50,
      labelFallbackShow: 0.30,
      labelFallbackHide: 0.24,
      labelMaxChars: 24,
      labelFont: '12px ui-sans-serif, -apple-system, "Segoe UI", sans-serif',
      labelColor: '#d9e2f0',
      labelColorDim: 'rgba(217,226,240,0.45)',
      labelColorHi: '#ffffff',
      labelHaloColor: 'rgba(8,10,14,0.7)',
      labelHaloWidth: 1.5,
      labelAlpha: 0.8,
      labelMaxRatio: 0.3,
      labelCell: 14,

      hoverScale: 1.35,
      selectionRingOffset: 2.5,

      palette: {
        tag: '#8b7bd8',
        page: '#7aa2f7',
        journal: '#5fa87a',
        object: '#8a8f98',
        property: '#c9a227',
      },
    },

    // =======================================================================
    // LOD 档位
    // =======================================================================
    lod: {
      auto: true,
      levels: [
        { maxN: 800,  glow: 'all',      glowMinScale: 0,    labelCap: 240, collideIter: 2, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        { maxN: 2200, glow: 'deg2',     glowMinScale: 0,    labelCap: 160, collideIter: 1, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        { maxN: 5000, glow: 'all',      glowMinScale: 0.5,  labelCap: 90,  collideIter: 1, skipIsolatedCharge: true,  chargeEveryNth: 1, pulses: true },
        { maxN: Infinity, glow: 'hover', glowMinScale: 1,   labelCap: 40,  collideIter: 0, skipIsolatedCharge: true,  chargeEveryNth: 2, pulses: false },
      ],
      sampleFrames: 30,
      downshiftMs: 15,
      upshiftMs: 8,
      upshiftHoldFrames: 120,
    },

    // =======================================================================
    // 时间旅行
    // =======================================================================
    timeline: {
      pulseThrottleMs: 900,
      pulseMinReveal: 2,
      maxPulses: 2,
      poolSize: 4,
      hideFadeTime: 0.26,
      hideShrink: 0.85,
      revealAnchorJitter: 30,
      revealFringeJitter: 80,
      // 🌟 全程演化定在 28 秒：节奏紧凑，欣赏舒适
      baseDurationSec: 28,
      speeds: [0.5, 1, 2, 4],
    },

    // =======================================================================
    // 数据层
    // =======================================================================
    data: {
      // 🌟 系统节点是否删去（默认 false：不删，保留在图谱中）
      hideSystemJournal: false,
      hideSystemPages: false,

      hideClassIdents: [
        'logseq.class/Tag',
        'logseq.class/Whiteboard',
        'logseq.class/Comments',
        'logseq.class/Asset',
        'logseq.class/Root',
        'logseq.class/Template',
      ],
      hideNames: [
        'Alias', 'Bidirectional property title', 'Contents', 'Due',
        'Enable bidirectional properties', 'Extends', 'External URL',
        'Hide from Node', 'Library', 'Published URL',
        'Repeating recur frequency', 'Repeating recur unit', 'Repeating type',
        'State', 'Tag Properties', 'Title Format',
        'User Avatar', 'User Email', 'User Name',
        'include', 'Whiteboard', 'Template', 'PDF Annotation',
      ],
    },

    runtime: {
      maxSubsteps: 3,
      maxFrameMs: 100,
      idleFrames: 30,
      degenerateCheckEvery: 30,
      debug: false,
      dataSource: 'logseq',
      demoCount: 400,
    },
  };

  function clone(o) {
    if (Array.isArray(o)) return o.slice();
    if (o && typeof o === 'object') {
      const r = {};
      for (const k in o) r[k] = clone(o[k]);
      return r;
    }
    return o;
  }

  GFI.config = clone(defaults);
  GFI.configDefaults = defaults;

  // -------------------------------------------------------------------------
  // Logseq 设置面板 schema
  // -------------------------------------------------------------------------
  GFI.settingsSchema = [
    {
      key: 'useNativeGraph',
      type: 'boolean',
      title: '🔄 使用原生图谱 / Use Native Graph',
      description: '回退到 Logseq 内置的图谱视图。\nFall back to Logseq\'s built-in graph.',
      default: false,
    },
    // 🌟 1. 自定义 Journal 系统节点（默认 false：不删）
    {
      key: 'hideSystemJournal',
      type: 'boolean',
      title: '📅 删去 Journal 系统节点 / Hide Journal System Node',
      description: '是否从图谱中删去 Journal 系统节点（默认关：不删，保留展示）。\nDelete/hide the Journal system node? (default false: keep)',
      default: false,
    },
    // 🌟 2. 自定义 Page/Pages 系统节点（默认 false：不删）
    {
      key: 'hideSystemPages',
      type: 'boolean',
      title: '📄 删去 Page/Pages 系统节点 / Hide Page System Node',
      description: '是否从图谱中删去 Page / Pages 系统节点（默认关：不删，保留展示）。\nDelete/hide the Page/Pages system node? (default false: keep)',
      default: false,
    },
    // 🌟 3. 自定义过滤其他节点名称
    {
      key: 'hideNames',
      type: 'string',
      input: 'textarea',
      title: '🚫 自定义过滤名称 / Custom Excluded Names',
      description: '填入需过滤的节点名称，用逗号或换行分隔。',
      default: '',
    },
    {
      key: 'charge',
      type: 'number',
      title: '⚡ 斥力强度 / Repulsion',
      description: '节点之间的排斥力，决定整体疏密。(default -0.10)',
      default: -0.10,
    },
    {
      key: 'linkDistance',
      type: 'number',
      title: '🔗 连接线长度 / Link Distance',
      description: '相连节点之间的静止距离。(default 82)',
      default: 82,
    },
    {
      key: 'velocityRetain',
      type: 'number',
      title: '🌀 速度保留率 / Velocity Retain',
      description: '每帧保留多少速度。(default 0.80)',
      default: 0.8,
    },
    {
      key: 'settleTicks',
      type: 'number',
      title: '⏱ 活跃时长 / Settle Duration',
      description: '图谱从开始布局到完全静止经过多少帧。(default 400)',
      default: 400,
    },
    {
      key: 'flingMomentum',
      type: 'number',
      title: '🎯 甩掷惯性 / Fling Momentum',
      description: '快速甩出节点时的惯性倍率。(default 1.4)',
      default: 1.4,
    },
    {
      key: 'jellyDamping',
      type: 'number',
      title: '🍮 松手回弹 / Release Damping',
      description: '拖动后松手时的阻尼。数值越低回弹越明显。(default 0.65)',
      default: 0.65,
    },
    {
      key: 'popAmp',
      type: 'number',
      title: '💥 节点弹出幅度 / Pop Overshoot',
      description: '新节点出现时向外过冲的幅度。(default 0.55)',
      default: 0.55,
    },
    {
      key: 'popZeta',
      type: 'number',
      title: '💥 弹出阻尼比 / Pop Damping',
      description: '越低回弹次数越多。(default 0.30)',
      default: 0.30,
    },
    {
      key: 'shockMagnitude',
      type: 'number',
      title: '🌊 时间波强度 / Shockwave',
      description: '时间轴推进时，向外扩散的斥力波前强度。设为 0 可完全关闭。(default 0)',
      default: 0,
    },
    {
      key: 'timelapseDuration',
      type: 'number',
      title: '⏳ 演变周期 / Timelapse Duration',
      description: '走完整个时间跨度需要多少秒。(default 28)',
      default: 28,
    },
    {
      key: 'labelMaxRatio',
      type: 'number',
      title: '🏷 标签密度 / Label Density',
      description: '常态下最多给多少比例的节点显示名字。(default 0.3)',
      default: 0.3,
    },
  ];

  const SCHEMA_BINDINGS = {
    charge: () => GFI.configDefaults.physics.charge,
    linkDistance: () => GFI.configDefaults.physics.linkDistance,
    velocityRetain: () => GFI.configDefaults.physics.velocityRetain,
    settleTicks: () => GFI.configDefaults.physics.settleTicks,
    popAmp: () => GFI.configDefaults.pop.amp,
    popZeta: () => GFI.configDefaults.pop.zeta,
    jellyDamping: () => GFI.configDefaults.drag.jellyDamping,
    flingMomentum: () => GFI.configDefaults.drag.flingMomentum,
    shockMagnitude: () => GFI.configDefaults.shock.magnitude,
    timelapseDuration: () => GFI.configDefaults.timeline.baseDurationSec,
    labelMaxRatio: () => GFI.configDefaults.render.labelMaxRatio,
    hideSystemJournal: () => GFI.configDefaults.data.hideSystemJournal,
    hideSystemPages: () => GFI.configDefaults.data.hideSystemPages,
    hideNames: () => GFI.configDefaults.data.hideNames.join(', '),
  };
  for (const item of GFI.settingsSchema) {
    const bind = SCHEMA_BINDINGS[item.key];
    if (bind) item.default = bind();
  }

  // 🌟 配置版本号升级到 10，确保覆盖旧缓存
  GFI.CFG_VERSION = 10;

  const SANE_RANGE = {
    charge: (v) => v <= 0 && v >= -5,
    linkDistance: (v) => v >= 10 && v <= 500,
    velocityRetain: (v) => v > 0.3 && v < 1,
    settleTicks: (v) => v >= 50 && v <= 5000,
    popAmp: (v) => v >= 0 && v <= 2,
    popZeta: (v) => v > 0.05 && v < 1,
    jellyDamping: (v) => v > 0.05 && v < 1,
    flingMomentum: (v) => v >= 0 && v <= 5,
    shockMagnitude: (v) => v >= 0 && v <= 2000,
    timelapseDuration: (v) => v >= 2 && v <= 300,
    labelMaxRatio: (v) => v > 0 && v <= 1,
  };

  GFI.syncSettings = function syncSettings(s) {
    const c = GFI.config;
    const d = GFI.configDefaults;
    if (!s) s = {};

    const stale = [];
    const savedVersion = Number(s.__cfg || 0);
    const fresh = savedVersion !== GFI.CFG_VERSION;

    const pick = (key, cfgDefault) => {
      if (fresh) return cfgDefault;
      const raw = s[key];
      if (raw === undefined || raw === null || raw === '' || isNaN(Number(raw))) return cfgDefault;
      const v = Number(raw);
      const check = SANE_RANGE[key];
      if (check && !check(v)) {
        stale.push(`${key}=${v}（区间外）→ 用 ${cfgDefault}`);
        return cfgDefault;
      }
      return v;
    };

    c.useNativeGraph = !!s.useNativeGraph;

    c.physics.charge = pick('charge', d.physics.charge);
    c.physics.linkDistance = pick('linkDistance', d.physics.linkDistance);
    c.physics.velocityRetain = pick('velocityRetain', d.physics.velocityRetain);
    c.physics.settleTicks = pick('settleTicks', d.physics.settleTicks);

    c.pop.amp = pick('popAmp', d.pop.amp);
    c.pop.zeta = pick('popZeta', d.pop.zeta);

    c.drag.jellyDamping = pick('jellyDamping', d.drag.jellyDamping);
    c.drag.flingMomentum = pick('flingMomentum', d.drag.flingMomentum);

    c.shock.magnitude = pick('shockMagnitude', d.shock.magnitude);
    c.timeline.baseDurationSec = pick('timelapseDuration', d.timeline.baseDurationSec);
    c.render.labelMaxRatio = pick('labelMaxRatio', d.render.labelMaxRatio);

    // -----------------------------------------------------------------------
    // 🌟 自定义 Journal、Page/Pages 系统节点显隐（默认不删）
    // -----------------------------------------------------------------------
    c.data.hideSystemJournal = fresh ? d.data.hideSystemJournal : !!s.hideSystemJournal;
    c.data.hideSystemPages = fresh ? d.data.hideSystemPages : !!s.hideSystemPages;

    // 解析 hideNames
    let userNames = d.data.hideNames.slice();
    if (!fresh && s.hideNames !== undefined && s.hideNames !== null) {
      if (Array.isArray(s.hideNames)) {
        userNames = s.hideNames.map((x) => String(x).trim()).filter(Boolean);
      } else if (typeof s.hideNames === 'string') {
        userNames = s.hideNames
          .split(/[,\n]/)
          .map((x) => x.trim())
          .filter(Boolean);
      }
    }

    let classIdents = d.data.hideClassIdents.slice();

    // 1. 处理 Journal：仅当用户明确开启开关时才删除，否则强制保留
    if (c.data.hideSystemJournal) {
      if (!classIdents.includes('logseq.class/Journal')) classIdents.push('logseq.class/Journal');
      if (!userNames.includes('Journal')) userNames.push('Journal');
    } else {
      classIdents = classIdents.filter((x) => x !== 'logseq.class/Journal');
      userNames = userNames.filter((x) => x.toLowerCase() !== 'journal');
    }

    // 2. 处理 Page/Pages：仅当用户明确开启开关时才删除，否则强制保留
    if (c.data.hideSystemPages) {
      if (!classIdents.includes('logseq.class/Page')) classIdents.push('logseq.class/Page');
      if (!userNames.includes('Page')) userNames.push('Page');
      if (!userNames.includes('Pages')) userNames.push('Pages');
    } else {
      classIdents = classIdents.filter((x) => x !== 'logseq.class/Page');
      userNames = userNames.filter((x) => x.toLowerCase() !== 'page' && x.toLowerCase() !== 'pages');
    }

    c.data.hideClassIdents = classIdents;
    c.data.hideNames = userNames;

    if (fresh && GFI.onFreshSettings) {
      try {
        GFI.onFreshSettings({
          __cfg: GFI.CFG_VERSION,
          charge: c.physics.charge,
          linkDistance: c.physics.linkDistance,
          velocityRetain: c.physics.velocityRetain,
          settleTicks: c.physics.settleTicks,
          popAmp: c.pop.amp,
          popZeta: c.pop.zeta,
          jellyDamping: c.drag.jellyDamping,
          flingMomentum: c.drag.flingMomentum,
          shockMagnitude: c.shock.magnitude,
          timelapseDuration: c.timeline.baseDurationSec,
          hideSystemJournal: c.data.hideSystemJournal,
          hideSystemPages: c.data.hideSystemPages,
          hideNames: c.data.hideNames.join(', '),
        });
      } catch (e) {}
    }
    return c;
  };
})(window.GFI = window.GFI || {});