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
      // ── charge 的单位取决于 chargeFalloff ──
      //   falloff=0：就是 d3 / Logseq 的 forceManyBody 强度（每 tick 速度增量幅值）
      //   falloff=1：在距离 = linkDistance 处的幅值
      //   falloff=2：同样的参考点，但按 1/d² 衰减
      // ⚠ 这个数值是 test/quick-cal.js 实测标定出来的，不是猜的。
      //   改力律 / 阻尼 / linkDistance 后必须重新标定，否则图谱会挤成一团或散架。
      charge: -0.10,          // 整体疏密。绝对值×1.5 更空灵，×0.6 更结团

      // 力律指数。d3 与 Logseq 都用 0（恒定幅值）：
      //   0 恒定幅值 → 净力 2πKρR²   有限（靠 distanceMax 截断）—— 【默认，经 Logseq 生产验证】
      //   1  K/d     → 净力 2πKρR    有限 —— Fruchterman-Reingold 的 k²/d
      //   2  K/d²    → 净力 2πKρ·ln(R/r₀) 【对数发散】二维下图会一路膨胀到散架
      // 三维里 1/r² 的积分有限，二维不是 —— 二维力导向布局的经典陷阱。
      chargeFalloff: 0,
      chargeDegGain: 0.5,     // 斥力随度数增长：×(1 + gain·√deg) —— 让 hub 撑开空地
      chargeDegCap: 8,        // 上述倍率的上限
      distanceMin: 12,        // 软化近距奇点。近重合节点抖动就提到 20
      distanceMax: 420,       // 斥力截断半径（与 Logseq 原生一致）
      linkDistance: 82,       // 边长 —— 决定"是图谱还是毛球"的主要旋钮（Logseq all-pages 用 82）
      linkStrength: 0.3,      // 边刚度。太大会让叶子死死抱住 hub

      // ⚠ 这是全组参数里最敏感的一个，直接决定布局稳不稳定。
      //   离散振子的振荡每 tick 衰减 sqrt(retain)：
      //     0.94 → 衰减率 0.9695，时间常数 33 tick；而振荡周期仅约 11 tick
      //            ⇒ 阻尼比 ζ≈0.06，严重欠阻尼 ⇒ 图来回振荡，alpha 耗尽时冻在
      //              某个随机相位上，最终疏密与 charge 的关系完全失去意义
      //     0.60 → 衰减率 0.775，时间常数 4 tick ⇒ d3 的"迅速锁定"手感
      //     0.80 → 衰减率 0.894，时间常数 9 tick ⇒ 兼顾稳定与一点慵懒
      velocityRetain: 0.80,
      settleTicks: 400,       // alpha 1→alphaMin 的 tick 数，直接就是"活跃时长"
      collideStrength: 0.85,  // 重叠消解强度。静止时抖动就降到 0.5
      // ⚠ 孤立节点（度数 0）是二维力导向布局最容易翻车的地方。
      //   它们不受任何连边力约束，只被核心的斥力往外推，而重力是弱力
      //   → 会被一路推到几千单位外，把包围盒撑爆，相机 fitView 后整张图缩成
      //     一个点，看起来就是"白屏"。
      //   它们本来也不在图的"结构"里，不参与斥力是合理的（也是 d3 的常见做法）。
      skipIsolatedCharge: true,
      // 向心恒力。0 → 随 N 增长无限膨胀；过大会把所有孤立节点压在死区半径上
      // 退化成圆环。实测（n=88 / 147 边）：0.3 → 宽 1283，3 → 宽 847 且比值 1.32。
      gravity: 3,
      gravityDeadzone: 40,    // 死区半径，避免中心过度聚集
      centerStrength: 0.02,   // 刚性回正，保持极小
      alphaMin: 0.001,
      collideCell: 32,        // 碰撞微网格边长 = 2 × 最大半径

      // 零度节点（没有任何连边）的归置。
      // 它们不受连边力约束，否则会飘在主干中间挡住别的节点。
      // 用一个【持续拉力】把它们的半径锚定在外圈环上，而不是直接摆位置 ——
      // 这样它们仍然可拖拽、也能被激波推着走，只是会被拉回环上。
      isolatedRing: {
        enabled: true,
        factor: 1.18,         // 环半径 = 连通节点包围半径 × 此值
        // 拉回强度（每 tick 的速度增量）。
        // 0.014 压不住主干对孤立节点的斥力，实测半径会跑到目标的 1.56 倍；
        // 0.05 能在被斥力顶开的同时把半径收在环附近。
        strength: 0.05,
      },
    },

    // 重热幅度（alpha 下限，取 max）
    reheat: {
      dataChange: 0.6,
      cutoff: 0.45,
      // 播放时间轴时每次揭示的重热幅度。
      // ⚠ 必须远小于 cutoff：播放时几乎每十几帧就有节点被揭示，
      //   用 0.45 会让 alpha 被反复抬回高位、永远衰减不下去 ——
      //   表现就是"节点一直抽搐"，整个播放过程图谱都静不下来。
      //   0.12 大约等于"微微沸腾"，既能推动新节点入位，又不会炸开。
      timelinePlay: 0.12,
      dragStart: 0.3,         // 这个走 alphaTarget
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
      amp: 0.55,              // A
      // ω₀ (rad/s)。22 → 峰值 59ms（偏"弹"）；16 → 峰值 81ms（偏"长出来"）。
      // 过冲幅度只由 ζ 决定，所以放慢 ω₀ 不会让弹出变弱，只是更从容。
      omega: 16,
      zeta: 0.35,             // ζ —— 0.35 → 31% 过冲
      maxDuration: 0.9,       // 硬上限；ω₀=16 时自然收敛约 0.72s
      fadeInTime: 0.18,       // 同步的透明度淡入
      // simWeight 从 0 渐入到 1 的时长。
      // ⚠ 这个渐入【必须】实现，不能只把 simWeight 置 0 就完事：
      //   simWeight 是 activeMask 的依据，而空间网格只收录 active 节点。
      //   simWeight 恒为 0 的节点不在网格里 → 视口剔除找不到 → 永远不画。
      simWeightRamp: 0.12,
      radialWaveSpeed: 1200,  // 配激波时按距离错峰 (wu/s)
      maxRadialDelay: 0.35,
      maxIndexDelay: 0.25,    // 无脉冲时按 createdAt 排名错峰的总上限
    },

    // =======================================================================
    // 激波 —— 行进波前，不是单次径向场
    // =======================================================================
    shock: {
      speed: 2400,            // 波前推进速度 (wu/s)
      decayLen: 1800,         // 能量沿路径的衰减长度
      magnitude: 210,         // J：波前峰值速度冲量 (wu/s)
      jitter: 0.30,           // ±15% 随机抖动，打破径向完美性
      massFactor: 0.06,       // massScale = 1/(1 + f·√deg) —— 最强的"反缩放"线索
      // 波的行程上限（图谱尺寸的倍数）与绝对兜底。
      // ⚠ 原来写死 2600：图谱只有 700 单位时，波 0.3 秒就扫完了，
      //   却要继续空跑 1.08 秒才算结束 —— 于是同时有好几道波在飞，
      //   观感就是"前一个还没完下一个就来了"。
      //   现在按图谱尺寸算，波扫完就结束，天然不会叠。
      maxRadiusFactor: 1.25,  // 行程 = 图谱外接半径 × 此倍数
      maxRadius: 2600,         // 绝对上限（图谱很大时的兜底）
      maxDisplacementRatio: 0.22,  // 总位移上限 / 视口高度，超了整体缩放 J
      backwardSign: -1,       // 倒退时 J 取负 → 波前把节点向内吸（内爆）
    },

    // =======================================================================
    // 拖拽
    // =======================================================================
    drag: {
      snapBackRatio: 0.22,    // 回缩比率（沿用 v1 调好的值）
      elasticStiffness: 5.8,  // ω₀
      jellyDamping: 0.76,     // ζ —— 2.5% 过冲，适合沉降（做 pop 就太小了）
      flingMomentum: 1.4,     // 甩掷冲量倍率
      minDragDist: 5.0,       // 防抖阈值 (px)
      sampleWindow: 60,       // 速度采样窗口 (ms)
      maxFlingSpeed: 1800,    // 速度上限 (px/s)，保持方向
      handoffTail: 0.45,      // 沉降段后 45% 用于把控制权交还模拟
      handoffMinTime: 0.2,
      maxSettleTime: 1.5,
      clickMaxMs: 600,        // 超过这个时长就不算点击
    },

    // =======================================================================
    // 相机
    // =======================================================================
    camera: {
      minZoom: 0.05,
      maxZoom: 6,
      zoomBase: 1.0012,       // factor = zoomBase ^ -deltaY
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
      radiusScale: 0.95,      // r = base + scale·√deg
      radiusMin: 2.0,
      radiusMax: 14,

      glowRadiusBuckets: [3, 4, 6, 8, 11, 16, 22],
      glowSpread: 2.0,        // 精灵尺寸 = 4 × 半径

      // 边的可见度。0.075 在深色背景上几乎看不见 —— 只有 hover 高亮能看清，
      // 于是观感变成"悬浮才出现连线"。用偏冷的浅蓝灰而不是纯白，密度高时不容易糊。
      edgeColor: 'rgba(180,200,230,0.75)',
      // 有节点被选中/悬浮时，其余边会被压到这个颜色。
      // 这是个"聚光灯"效果：不能压得太狠，否则默认观感变成"完全看不见连线"。
      edgeColorDim: 'rgba(180,200,230,0.22)',
      edgeColorHi: 'rgba(160,200,255,0.95)',
      edgeWidthMin: 1.0,
      edgeWidthMax: 2.5,
      edgeWidthBase: 0.8,     // width = clamp(base + slope*k, min, max)
      edgeWidthSlope: 0.6,

      // ⚠ 标签阈值是【相对于 fitView 缩放】的倍数，不是绝对 k。
      //   世界单位是任意的：88 个节点的图 fit 之后 k≈0.08，3000 个节点的图 k≈0.01。
      //   用绝对阈值（原来写的 0.85）在真实图谱上永远够不到，标签一条都不会画。
      labelShowScaleRatio: 0.60,   // k >= fitK * 此值 → 显示
      labelHideScaleRatio: 0.50,   // k <  fitK * 此值 → 隐藏
      labelFallbackShow: 0.30,     // fitK 还没算出来时的兜底绝对阈值
      labelFallbackHide: 0.24,
      labelMaxChars: 24,
      labelFont: '12px ui-sans-serif, -apple-system, "Segoe UI", sans-serif',
      // 明度与光晕强度是一对反向旋钮：
      //   只有颜色 → 压在辉光上看不清；加光晕 → 又容易太扎眼。
      //   调参时优先动 labelHaloWidth（0 = 关），颜色保持在略暗于纯白的位置。
      labelColor: '#d9e2f0',
      labelColorDim: 'rgba(217,226,240,0.45)',
      labelColorHi: '#ffffff',
      // 标签底下的深色描边（光晕）。用 strokeText 而不是 shadowBlur ——
      // 后者是逐次绘制的 CPU 高斯模糊，慢 30~100×。
      labelHaloColor: 'rgba(8,10,14,0.7)',
      labelHaloWidth: 1.5,
      labelAlpha: 0.8,
      // ⚠ 标签"太显眼"的主因通常不是样式，而是【数量】。
      //   LOD 的 labelCap（L0 = 240）是为大图谱设的，小图谱下等于每个节点都带标签，
      //   一屏文字会直接压过图形本身。这里再按节点总数收一道：
      //   最多只给度数最高的这一比例的节点画标签。
      labelMaxRatio: 0.3,
      labelCell: 14,          // 占位网格边长，抑制密集处标签互相糊

      hoverScale: 1.35,
      selectionRingOffset: 2.5,

      // 调色板（与 Logseq 原生图谱对齐）
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
        // L0
        { maxN: 800,  glow: 'all',      glowMinScale: 0,    labelCap: 240, collideIter: 2, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        // L1
        { maxN: 2200, glow: 'deg2',     glowMinScale: 0,    labelCap: 160, collideIter: 1, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        // L2
        { maxN: 5000, glow: 'all',      glowMinScale: 0.5,  labelCap: 90,  collideIter: 1, skipIsolatedCharge: true,  chargeEveryNth: 1, pulses: true },
        // L3
        { maxN: Infinity, glow: 'hover', glowMinScale: 1,   labelCap: 40,  collideIter: 0, skipIsolatedCharge: true,  chargeEveryNth: 2, pulses: false },
      ],
      // 自适应控制器
      sampleFrames: 30,
      downshiftMs: 15,
      upshiftMs: 8,
      upshiftHoldFrames: 120,
    },

    // =======================================================================
    // 时间旅行
    // =======================================================================
    timeline: {
      // 两道波之间的最小间隔。
      // ⚠ 这个值决定了"波"读起来是一个【事件】还是一串连续噪声。
      //   曾经是 220ms，叠加"波按图谱尺寸缩短行程"之后变成每 0.18 秒一道 ——
      //   观感就是"很急、前一个还没完下一个就来了"。
      //   900ms 大约是一道波走完 + 一段呼吸的时间。
      pulseThrottleMs: 900,
      // 一次只揭示这么少节点的话不值得发一波 —— 否则滑块微动也会激起冲击波
      pulseMinReveal: 2,
      maxPulses: 2,
      poolSize: 4,
      hideFadeTime: 0.26,     // simWeight 1→0 的时长
      hideShrink: 0.85,       // 淡出时缩到 0.85 倍
      revealAnchorJitter: 30, // 在邻居质心附近的落点抖动 (wu)
      revealFringeJitter: 80, // 无邻居时在图谱质心附近的落点抖动
      // 播放模式 1× 走完全程的秒数。18 秒对节点多的图谱太快，来不及看清生长过程。
      // 也可以不改这里，直接用工具栏的「1×」按钮在 0.5/1/2/4 之间切。
      baseDurationSec: 45,
      speeds: [0.5, 1, 2, 4],
    },

    // =======================================================================
    // 运行
    // =======================================================================
    // =======================================================================
    // 数据层
    // =======================================================================
    data: {
      // 要隐藏的 Logseq 内置【类枢纽】的 ident。
      //
      // 这类节点在图上表现为"连接着一大堆同类节点"的中枢，本身不含信息量。
      // 但注意不能一刀切地把 logseq.class/* 全滤掉：
      //   logseq.class/Page    构成"Page 连着所有页面"的骨架 —— 有用，保留
      //   logseq.class/Journal 构成"Journal 连着所有日记"的骨架 —— 有用，保留
      // 所以这里列的是黑名单而不是白名单，默认只藏 Tag。
      // 想恢复就把数组清空；想再藏别的就往里加 ident。
      hideClassIdents: [
        'logseq.class/Tag',
        'logseq.class/Whiteboard',
        'logseq.class/Comments',
        'logseq.class/Asset',
        'logseq.class/Root',
        'logseq.class/Template',
        // 注：PDF Annotation 的类 ident 猜过两种写法都查不到（实测 +0），
        // 它由下面的 hideNames 兜底处理，不必在这里死磕。
      ],

      // 按【名字】隐藏的噪音节点。
      // ⚠ 只对【零度节点】生效 —— 加这个限制是因为按名字匹配有误伤风险：
      //   万一用户真有个叫 include 的页面且它有链接，那它就是内容，不能删。
      // 名单里的都是 Logseq 内置属性/指令产生的幽灵页面。
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
      maxFrameMs: 100,        // 单帧累加器上限，防死亡螺旋
      idleFrames: 30,         // 连续多少帧无活动后停机
      degenerateCheckEvery: 30,
      debug: false,           // 打开后暴露 top.__GFI__

      // 'logseq' = 真实图谱；'demo' = 合成图谱（渲染器/物理调试用，不需要 Logseq 数据）
      dataSource: 'logseq',
      demoCount: 400,
    },
  };

  // 深克隆默认值，作为运行时可改的活配置
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
  GFI.configDefaults = defaults;   // 只读参考

  // -------------------------------------------------------------------------
  // Logseq 设置面板 schema
  // -------------------------------------------------------------------------
  GFI.settingsSchema = [
    // ── 通用 ──────────────────────────────────────────────────────────────
    {
      key: 'useNativeGraph',
      type: 'boolean',
      title: '🔄 使用原生图谱 / Use Native Graph',
      description:
        '回退到 Logseq 内置的图谱视图。\n' +
        '本项目会接管图谱渲染，万一出问题可以打开这个开关恢复原样。\n\n' +
        'Fall back to Logseq\'s built-in graph. This plugin replaces the graph renderer; ' +
        'turn this on to get the original back.',
      default: false,
    },

    // ── 物理 ──────────────────────────────────────────────────────────────
    {
      key: 'charge',
      type: 'number',
      title: '⚡ 斥力强度 / Repulsion',
      description:
        '节点之间的排斥力，决定整体疏密。绝对值越大越舒展，越小越紧凑。\n' +
        '这是实测标定过的值，改动幅度建议不要超过 ±50%。\n\n' +
        'Overall spread of the graph. Larger magnitude = airier, smaller = tighter.\n' +
        'Calibrated empirically — keep changes within ±50%. (default -0.10)',
      default: -0.10,
    },
    {
      key: 'linkDistance',
      type: 'number',
      title: '🔗 连接线长度 / Link Distance',
      description:
        '相连节点之间的静止距离。决定整张图看起来是"图谱"还是"毛球"。\n\n' +
        'Rest length of edges — the main "graph vs hairball" knob.\n' +
        'Logseq\'s own all-pages graph uses 82. (default 82)',
      default: 82,
    },
    {
      key: 'velocityRetain',
      type: 'number',
      title: '🌀 速度保留率 / Velocity Retain',
      description:
        '每帧保留多少速度。这是全组参数里最敏感的一个：\n' +
        '  0.60 = 迅速锁定，手感偏硬\n' +
        '  0.80 = 兼顾稳定与一点慵懒（默认）\n' +
        '  0.90 以上 = 布局会来回振荡，并在能量耗尽时冻在某个随机相位上\n\n' +
        'Per-tick velocity retention — the single most sensitive setting.\n' +
        'Above ~0.90 the layout oscillates and freezes mid-swing. (default 0.80)',
      default: 0.8,
    },
    {
      key: 'settleTicks',
      type: 'number',
      title: '⏱ 活跃时长 / Settle Duration',
      description:
        '图谱从开始布局到完全静止经过多少帧（60 帧 = 1 秒）。\n' +
        '直接决定"打开图谱后它活多久"。(default 400 = 约 6.7 秒)\n\n' +
        'Frames from start to rest. Directly how long the graph stays lively. (default 400)',
      default: 400,
    },

    // ── 交互手感 ──────────────────────────────────────────────────────────
    {
      key: 'flingMomentum',
      type: 'number',
      title: '🎯 甩掷惯性 / Fling Momentum',
      description:
        '快速甩出节点时的惯性倍率。越大飞得越远。(default 1.4)\n\n' +
        'Momentum multiplier when flinging a node. (default 1.4)',
      default: 1.4,
    },
    {
      key: 'jellyDamping',
      type: 'number',
      title: '🍮 松手回弹 / Release Damping',
      description:
        '拖动后松手时的阻尼。数值越低回弹越明显：\n' +
        '  0.55 ≈ 13% 过冲（有弹跳感）  0.76 ≈ 2.5%（很柔和，默认）  0.85 ≈ 更沉\n\n' +
        'Damping for the drag-release settle. Lower = bouncier. (default 0.76)',
      default: 0.76,
    },

    // ── 动效 ──────────────────────────────────────────────────────────────
    {
      key: 'popAmp',
      type: 'number',
      title: '💥 节点弹出幅度 / Pop Overshoot',
      description:
        '新节点出现时向外过冲的幅度。0.55 约等于 33% 过冲。(default 0.55)\n\n' +
        'Peak scale overshoot when a node appears. (default 0.55)',
      default: 0.55,
    },
    {
      key: 'popZeta',
      type: 'number',
      title: '💥 弹出阻尼比 / Pop Damping',
      description:
        '越低回弹次数越多、越"弹"：\n' +
        '  0.20 → 53%   0.35 → 31%（默认）   0.50 → 16%   0.70 → 4.6%\n\n' +
        'Damping ratio for the pop-out spring. Lower = bouncier. (default 0.35)',
      default: 0.35,
    },
    {
      key: 'shockMagnitude',
      type: 'number',
      title: '🌊 时间波强度 / Shockwave',
      description:
        '时间轴推进时，向外扩散的斥力波前强度。设为 0 可完全关闭。(default 210)\n\n' +
        'Radial velocity impulse as the timeline advances. Set 0 to disable. (default 210)',
      default: 210,
    },

    // ── 时间旅行 ──────────────────────────────────────────────────────────
    {
      key: 'timelapseDuration',
      type: 'number',
      title: '⏳ 演变周期 / Timelapse Duration',
      description:
        '点播放后，走完整个时间跨度需要多少秒。越大越慢、生长过程越看得清。(default 45)\n\n' +
        'Seconds for one full timelapse playback. Larger = slower and more readable. (default 45)',
      default: 45,
    },

    // ── 显示 ──────────────────────────────────────────────────────────────
    {
      key: 'labelMaxRatio',
      type: 'number',
      title: '🏷 标签密度 / Label Density',
      description:
        '常态下最多给多少比例的节点显示名字（按度数从高到低取）。\n' +
        '设为 1 则全部显示；悬浮某个节点时，无论此项如何，都只显示它和它的邻居。\n' +
        '(default 0.3)\n\n' +
        'Fraction of nodes that get a label at rest, highest-degree first. (default 0.3)',
      default: 0.3,
    },
  ];

  // ===========================================================================
  // ⚠ 设置面板的默认值必须与 config 的默认值【同源】
  // ===========================================================================
  // 教训：曾经把标定出的 physics.charge 改成 -0.10，却忘了改面板 schema 里的
  // 默认值 -140。syncSettings() 无条件用面板值覆盖 config，于是插件实际跑的是
  // -140 —— 比标定值强 1400 倍，图谱直接炸开到 5517 单位。标定结果是对的，
  // 代码却从来没用上它。
  //
  // 现在把每条面板默认值都绑到 configDefaults 上，结构上杜绝再次漂移。
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
  };
  for (const item of GFI.settingsSchema) {
    const bind = SCHEMA_BINDINGS[item.key];
    if (bind) item.default = bind();
  }

  // ===========================================================================
  // 配置版本 —— 改动物理默认值时必须 +1
  // ===========================================================================
  // 为什么需要：Logseq 会把设置面板的默认值持久化进图谱。之后我改代码里的默认值
  // 【不会】重写那些已保存的值，它们会在升级后继续生效，而且看起来就像"用户自己的
  // 选择"。曾经因此让标定值失效：代码里 charge 是 -0.10，图谱里存的却是旧默认
  // -140，实际跑的是后者。
  //
  // 版本号一变，本次启动就整体忽略所有已保存的物理值，改用当前标定值，
  // 然后写回新版本号。代价是用户的自定义会在升级时被重置 —— 开发阶段这是想要的。
  // ⚠ 每次改动物理默认值 / 修复迁移逻辑，都必须 +1，否则迁移不会重跑
  //   （图谱里已经存了旧版本号，fresh 判定为 false，旧值继续生效）
  GFI.CFG_VERSION = 4;

  // 合理性区间。
  // 用途：用户图谱里可能存着【旧版本写进去的过期默认值】（改面板默认值并不会
  // 重写已保存的设置）。这些值会在升级后继续生效，而且看上去像是"用户自己的选择"。
  // 落在区间外的一律判为过期，退回 config 默认值并告警。
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

  // 把设置面板的值同步进活配置
  GFI.syncSettings = function syncSettings(s) {
    const c = GFI.config;
    const d = GFI.configDefaults;
    if (!s) s = {};

    const stale = [];

    // 配置版本不匹配 → 本次忽略所有已保存的物理值
    const savedVersion = Number(s.__cfg || 0);
    const fresh = savedVersion !== GFI.CFG_VERSION;

    /**
     * 取值优先级：面板值（在合理区间内）> config 默认值。
     * 区间外的判为旧版本遗留的过期默认值，丢弃并告警。
     */
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

    if (stale.length) {
      console.warn(
        '%c[GFI] 检到过期的已保存设置（旧版本写进图谱的默认值），本次已改用当前标定值：\n  ' +
        stale.join('\n  ') +
        '\n如需保留自定义值，请在插件设置面板里重新填写。',
        'color:#c80;font-weight:bold'
      );
    }
    if (fresh && GFI.onFreshSettings) {
      // 必须把【修正后的值】连同版本号一起写回，不能只写版本号。
      // 只写版本号的话：本次用了 config 默认值，但图谱里存的还是旧值；
      // 下次启动版本号已经对上，于是又读回旧值 —— 迁移只生效一次。
      // 回调由 index.js 注入 —— config.js 不直接依赖 logseq API。
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
        });
      } catch (e) {}
    }
    console.log(`[GFI] 生效参数 charge=${c.physics.charge} linkDistance=${c.physics.linkDistance} ` +
      `retain=${c.physics.velocityRetain} gravity=${c.physics.gravity}` +
      (fresh ? '  （配置版本 ' + savedVersion + ' → ' + GFI.CFG_VERSION + '，已重置）' : ''));

    return c;
  };
})(window.GFI);
