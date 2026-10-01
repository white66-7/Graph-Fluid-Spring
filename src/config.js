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
      // 🌟 -0.12（原 -0.10）：配合 collidePad 一起把团簇之间推开 —— 实测
      //   500 节点最近邻间距变异系数 CV 0.888 → 0.379（探针 test/uniformity-probe.js）。
      charge: -0.12,          // 整体疏密。绝对值×1.5 更空灵，×0.6 更结团
      chargeFalloff: 0,
      chargeDegGain: 0.5,     // 斥力随度数增长：×(1 + gain·√deg)
      chargeDegCap: 8,        // 上述倍率的上限
      distanceMin: 16,        // 软化近距奇点（配合增大后的节点半径）
      distanceMax: 420,       // 斥力截断半径
      // 🌟 Obsidian 黄金比例连线距离：相连节点间距约 30~34 屏幕像素。
      // 原来比纯节点比例大了一档（45 → 50），理由是"名字画在节点右侧、水平方向
      // 要多留标签空间"。⚠ 标签现已改到节点【正下方】（见 renderer.drawOne），
      // 那条理由不再成立 —— 但数值没动：改它会直接改变整套观感，要动请先在
      // test/label-occlusion-probe.js 与 uniformity-probe.js 上量一遍。
      linkDistance: 50,
      linkStrength: 0.3,      // 边刚度
      velocityRetain: 0.80,   // 每帧速度保留率
      settleTicks: 400,       // alpha 1→alphaMin 的 tick 数
      collideStrength: 1.0,   // 重叠消解强度（1 = d3 forceCollide 约定：每遍完全解消）
      // 🌟 d3 forceCollide 的 padding：每节点外扩该值，静止间距 = r_i+r_j+2·pad。
      //   这是「节点之间永远有可见空隙」的来源 —— 没有 padding 时斥力/弹簧/重力
      //   的压力会把节点一路压到【接触距离】才停（实测最近邻 p10 = 13.6 ≈
      //   两片叶子半径之和 6.8+6.8），表现就是整团挤成一坨。
      //   探针实测：pad 6 → CV 0.549、间距 25.6/26.3/41.6（p10/p50/p90）。
      collidePad: 6,
      skipIsolatedCharge: true,
      // 🌟 2（原 3）：向心压缩减 1/3。gravity 是唯一把图谱往一起收的力，
      //   减弱它 = 团簇之间松开 = 分布更均匀。
      gravity: 2,             // 向心恒力
      gravityDeadzone: 40,    // 死区半径
      centerStrength: 0.02,   // 刚性回正
      alphaMin: 0.001,
      collideCell: 48,        // 碰撞微网格边长（容纳放大后的 hub 节点）

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
      // 🌟 0.3（原 0.4）：松手不额外加压 —— d3 拖拽惯例是全程 alphaTarget 0.3、
      //   松手让它自然衰减。松手瞬间比拖拽时更热只会放大「弹簧把节点拽回去」。
      dragRelease: 0.3,
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
      // 🌟 拖动期间给【被拖节点关联的边】临时加刚度 —— 邻居跟着走，图不被扯裂。
      //
      //   lstr[e] = clamp(linkStrength / minDeg, 0.02, 0.5)，边刚度按两端较【低】
      //   度数衰减；被拖的恰恰就是这个低度数叶子，它连到 hub 的边只有 0.3/3 = 0.1，
      //   再乘 alpha 0.3 → 邻居每 tick 只拿到约 0.7wu 加速度。
      //   实测（test/drag-probe.js，拖 234wu）：邻居只跟出 91wu，关联边被拉伸到
      //   379%，松手瞬间被拖节点离最近邻居 142wu（基线 26.4、平衡边长 50）。
      //   加 ×16 → 撕裂 379%→187%，小拖甩飞峰值 112→27wu。
      //   ⚠ 上限 24：实测 2~3 跳增益更差（局部硬斑对抗全局布局，全局撕裂
      //     63%→110%），hop3×40 会让坐标发散到无穷、网格分配直接 OOM。
      linkBoost: 16,
      // 🌟 被拖节点【直接邻居】的额外速度阻尼（velocityRetain 的覆盖值）。
      //
      //   刚度倍率只放大弹簧力、不放大阻尼，所以必须配套补阻尼，否则进深欠阻尼区：
      //   离散步进 trace = 1 + D(1−k)、det = D，k = a·lstr·be·biasT。
      //   拖 hub 时邻居是叶子（lstr = clamp(0.3/1,…) = 0.3）且 biasT = 56/57 ≈ 0.98，
      //   k = 0.3×0.3×16×0.98 ≈ 1.41 → 振荡周期 ≈ 5.3 帧（11Hz）、每周期只衰减 15%
      //   —— 肉眼就是「大节点周围在抽搐」。实测（test/drag-jitter-probe.js）：
      //   be=16 时邻居位移折返率 21.9%，be=1 时 0.1%。
      //   临界阻尼条件 (1 + D(1−k))² = 4D → k=1.41 时 D ≈ 0.21。
      //   ⚠ 只在拖拽期间、只作用于被拖节点的一环，不影响图的其他部分。
      linkBoostDamp: 0.22,
      // 🌟 松手时把 alpha 压到这个水平（而不是停在拖拽期的 0.3）。
      //   这是「停在放下点」的关键：回弹幅度几乎正比于松手后的 alpha。
      //   实测大拖回弹 156（alpha .30）→ 94（.08）→ 83（.05）；小拖峰值 112 → 29。
      //   ⚠ 不能压到 0.02：图会僵住，残余变形收不回来（末尾邻距 27 → 43）。
      releaseAlpha: 0.05,
      minDragDist: 5.0,
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
      // 沉降后那一次自动适配视野的缓动时长。瞬变会让整个画面"啪"地跳一下 ——
      // 从种子布局到沉降完的图谱，包围盒能差 40% 以上，那一下很明显。
      fitAnimMs: 320,
    },

    // =======================================================================
    // 渲染
    // =======================================================================
    render: {
      maxDpr: 2,
      bgFallback: '#0d0f14',
      bgCssVar: '--ls-primary-background-color',

      // 🌟 Obsidian 风格节点尺寸：叶子节点直径约 6~7px，核心 hub 直径约 14~20px，
      // 摆脱原有 1px 尘埃质感，呈现出星图般的晶莹实体感。
      radiusBase: 5.0,
      radiusScale: 1.8,
      radiusMin: 4.0,
      radiusMax: 22.0,
      nodeSize: 1.0,

      glowRadiusBuckets: [5, 7, 10, 14, 18, 24],
      glowSpread: 1.8,

      // 🌟 Obsidian 风格连线：半透明纤细星轨（0.38 alpha），让节点成为视觉主角；
      // hover 时高亮爆发（0.95 alpha），背景自动压暗（0.12 alpha）。
      edgeColor: 'rgba(180,200,230,0.38)',
      edgeColorDim: 'rgba(180,200,230,0.12)',
      edgeColorHi: 'rgba(160,200,255,0.95)',
      edgeWidthMin: 0.8,
      edgeWidthMax: 2.2,
      edgeWidthBase: 0.7,
      edgeWidthSlope: 0.4,

      // 🌟 Obsidian 行为：名字在几乎所有缩放级别都显示（只在互相重叠时让位），
      // 所以显示阈值压得很低（fitK 的 35%）。
      labelShowScaleRatio: 0.35,
      labelHideScaleRatio: 0.28,
      labelFallbackShow: 0.20,
      labelFallbackHide: 0.16,
      // 🌟 标签重叠让位。【false = Obsidian 的真实做法】。
      //
      //   查证：Obsidian 官方论坛 Bug graveyard 帖「Graph view - titles overlap」
      //   （2022-10 归档 = 不会修）里，开发者 Silver 的原话是「我们没有任何计划
      //   修复这个，因为对文字标签做碰撞检测在技术上并不简单。想读文字就放大；
      //   只想看节点位置就缩小，文字会消失」。
      //   其物理引擎（d3-force 复刻）的 forceCollide 也只按【节点半径】算，标签
      //   完全不参与布局 —— 所以 Obsidian 的取舍手段【只有】按缩放的文字淡变。
      //
      //   true  = 重叠的标签互相让位（本插件早先的做法）。实测代价：视口内 299 个
      //           节点只有 52 个拿到名字，而让位只压掉 7 个、其余是真的放不下 ——
      //           即「很多节点没名字」是这套机制的必然结果，不是 bug。
      //   false = 每个节点都画名字、允许重叠，密度完全交给缩放门槛（见
      //           labelShowScaleRatio / labelHideScaleRatio）—— 与 Obsidian 一致。
      labelYield: false,
      // 🌟 与已画出的标签重叠时，alpha 压到这个倍率（不是藏起来）。
      //
      //   实机截图反馈「标签重叠易混淆」—— 全是同亮度的字叠在一起没法看。
      //   让位（藏起来）会丢名字，全画（等亮度）会糊，这是中间档：
      //   先画的高名次节点（hub）保持清晰，被压住的退到背景，名字一个不少。
      //   0 = 完全不画重叠的（等价于让位）；1 = 不做任何区分（全都同亮）。
      labelOverlapDim: 0.35,
      // 🌟 Obsidian 从不截断名字。0 = 不截断；设成正数则超过该字数加「…」。
      labelMaxChars: 0,
      labelFont: '12px ui-sans-serif, -apple-system, "Segoe UI", sans-serif',
      labelColor: '#d9e2f0',
      labelColorDim: 'rgba(217,226,240,0.45)',
      labelColorHi: '#ffffff',
      labelHaloColor: 'rgba(8,10,14,0.7)',
      labelHaloWidth: 1.5,
      labelAlpha: 0.8,
      // 🌟 日记节点默认【不显示名字标签】—— 日期圆点安静地待在图上（Obsidian 式）。
      // 节点本身仍在图上、仍参与力场；悬浮时邻域标签不受此开关影响
      // （想看某颗绿点是哪天，hover 一下就行）。
      labelJournal: false,
      // 🌟 Obsidian：所有节点都是名字候选（1.0），密集处的取舍完全交给
      // 占位让位（重叠的藏起来），而不是按度数砍掉 70%。
      labelMaxRatio: 1.0,
      // 占位格边长（CSS px）。占位按标签的【整个包围盒】标记，不再只标落点一格，
      // 所以这个值只决定重叠判定的精细度：调小 = 判定更严、留下的标签更少。
      labelCell: 14,
      // 标签精灵缓存上限。⚠ 必须【大于最高的 labelCap】（L0 = 800），否则单帧
      // 就要建比上限更多的精灵，缓存会退化成每帧重建。
      labelCacheMax: 1000,

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
        // 🌟 labelCap 大幅放宽（240→800 等）：Obsidian 的做法是【所有节点】都
        //   有名字，密集处靠重叠让位自动取舍 —— cap 只是防极端帧的首帧建精灵
        //   爆炸（800 张 ≈ 80ms 一次性成本），不是常规取舍手段。
        { maxN: 800,  glow: 'all',      glowMinScale: 0,    labelCap: 800, collideIter: 2, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        { maxN: 2200, glow: 'deg2',     glowMinScale: 0,    labelCap: 600, collideIter: 1, skipIsolatedCharge: false, chargeEveryNth: 1, pulses: true },
        // ⚠ 降档链必须【单调变便宜】。L2 原来写的是 glow:'all'，而 L1 是 'deg2' ——
        //   于是从 L1 降到 L2、且相机缩放 k ≥ glowMinScale 时，反而给全部叶子
        //   节点补上了辉光：在"因为太慢所以降档"的那一刻增加了绘制量。
        //   glow 是纯 fill-rate 开销（半尺寸 spread×rScreen 的 alpha 混合大位图），
        //   是这个渲染器最贵的一项，绝不能反向。
        { maxN: 5000, glow: 'deg2',     glowMinScale: 0.5,  labelCap: 400, collideIter: 1, skipIsolatedCharge: true,  chargeEveryNth: 1, pulses: true },
        // 🌟 L3 collideIter 0→1：碰撞参与「均匀分布」（配合 collidePad 保持间距），
        //   且它是位置修正不是力，只在醒着时跑，沉降后零成本。降档链仍单调变便宜：
        //   L3 相比 L2 还有 chargeEveryNth:2 / glow:'hover' / pulses:false / labelCap 200。
        { maxN: Infinity, glow: 'hover', glowMinScale: 1,   labelCap: 200, collideIter: 1, skipIsolatedCharge: true,  chargeEveryNth: 2, pulses: false },
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
      // 🌟 系统节点是否删去
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
        'card','Property','Comment','Card','Cards','Alias', 'Bidirectional property title', 'Contents', 'Due',
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
      description: '节点之间的排斥力，决定整体疏密。(default -0.12)',
      default: -0.12,
    },
    {
      key: 'linkDistance',
      type: 'number',
      title: '🔗 连接线长度 / Link Distance',
      description: '相连节点之间的静止距离。(default 45)',
      default: 45,
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
      key: 'linkBoost',
      type: 'number',
      title: '🧲 拖动带动邻域 / Neighbour Pull',
      description:
        '拖动节点时邻居跟随的力度。只作用于被拖节点自己的连线，图的其他部分不受影响。\n' +
        '调高 = 邻域跟得更紧、图不易被扯变形；调低 = 邻居基本不动。\n' +
        '实测 16 最优；超过 24 有让布局发散的风险。(default 16)',
      default: 16,
    },
    {
      key: 'releaseAlpha',
      type: 'number',
      title: '🪂 松手停位 / Drop Firmness',
      description:
        '松手后布局的活跃度。数值越低，节点越能停在你放下的地方；\n' +
        '越高则越会被连线拉回原来的位置。实测 0.05 最优，低于 0.02 图会僵住收不回来。(default 0.05)',
      default: 0.05,
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
      description: '多少比例的节点有资格显示名字（1 = 全部，密集处自动让位）。(default 1)',
      default: 1,
    },
    {
      key: 'labelJournal',
      type: 'boolean',
      title: '📅 显示日记名字 / Journal Labels',
      description: '日记节点旁是否显示名字标签（默认关：日记只显示圆点，悬浮时仍可见）。\nShow name labels on journal nodes? (default false: dots only, hover to see names)',
      default: false,
    },
    {
      key: 'labelYield',
      type: 'boolean',
      title: '🈳 标签重叠时让位 / Hide Overlapping Labels',
      description:
        '关闭（默认，与 Obsidian 一致）= 每个节点都显示名字，允许互相重叠；\n' +
        '密集处靠「放大才显示」控制，也就是缩小后文字自然消失。\n' +
        '开启 = 重叠的标签互相让位，同一块地方只留最重要的那个 —— \n' +
        '画面更干净，但会有很多节点永远看不到名字。\n' +
        'Hide overlapping labels? Off = Obsidian behaviour (all names shown, may overlap).',
      default: false,
    },
    {
      key: 'nodeSize',
      type: 'number',
      title: '🔵 节点大小 / Node Size',
      description:
        '节点圆点的大小倍率。调大 = 图看起来更密，且【完全不改动布局】——' +
        '它和「连接线长度」是两个正交的旋钮：线长决定间距，这里决定直径。' +
        '范围 0.5~2.5,超过 2.5 节点会被碰撞顶开、反而变松。(default 1.0)',
      default: 1.0,
    },
  ];

  const SCHEMA_BINDINGS = {
    charge: () => GFI.configDefaults.physics.charge,
    linkDistance: () => GFI.configDefaults.physics.linkDistance,
    velocityRetain: () => GFI.configDefaults.physics.velocityRetain,
    settleTicks: () => GFI.configDefaults.physics.settleTicks,
    popAmp: () => GFI.configDefaults.pop.amp,
    popZeta: () => GFI.configDefaults.pop.zeta,
    linkBoost: () => GFI.configDefaults.drag.linkBoost,
    releaseAlpha: () => GFI.configDefaults.drag.releaseAlpha,
    shockMagnitude: () => GFI.configDefaults.shock.magnitude,
    timelapseDuration: () => GFI.configDefaults.timeline.baseDurationSec,
    labelMaxRatio: () => GFI.configDefaults.render.labelMaxRatio,
    labelJournal: () => GFI.configDefaults.render.labelJournal,
    labelYield: () => GFI.configDefaults.render.labelYield,
    nodeSize: () => GFI.configDefaults.render.nodeSize,
    hideSystemJournal: () => GFI.configDefaults.data.hideSystemJournal,
    hideSystemPages: () => GFI.configDefaults.data.hideSystemPages,
    hideNames: () => GFI.configDefaults.data.hideNames.join(', '),
  };
  for (const item of GFI.settingsSchema) {
    const bind = SCHEMA_BINDINGS[item.key];
    if (bind) item.default = bind();
  }

  // 🌟 14：日记标签默认关闭（labelJournal = false）。
  // ⚠ 提升版本号的【代价】是 fresh 分支会把所有面板设置重置成 configDefaults，
  //   然后写回 Logseq —— 这是设计用途（换一套新默认值），不是 bug。
  //   受影响最大的是 hideNames 那个自定义过滤文本框（它只在面板里，config 里没有）。
  GFI.CFG_VERSION = 14;

  const SANE_RANGE = {
    charge: (v) => v <= 0 && v >= -5,
    linkDistance: (v) => v >= 10 && v <= 500,
    velocityRetain: (v) => v > 0.3 && v < 1,
    settleTicks: (v) => v >= 50 && v <= 5000,
    popAmp: (v) => v >= 0 && v <= 2,
    popZeta: (v) => v > 0.05 && v < 1,
    linkBoost: (v) => v >= 1 && v <= 24,
    linkBoostDamp: (v) => v > 0.05 && v < 1,
    releaseAlpha: (v) => v >= 0.02 && v <= 1,
    shockMagnitude: (v) => v >= 0 && v <= 2000,
    timelapseDuration: (v) => v >= 2 && v <= 300,
    labelMaxRatio: (v) => v > 0 && v <= 1,
    nodeSize: (v) => v >= 0.5 && v <= 2.5,
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

    c.drag.linkBoost = pick('linkBoost', d.drag.linkBoost);
    c.drag.releaseAlpha = pick('releaseAlpha', d.drag.releaseAlpha);

    c.shock.magnitude = pick('shockMagnitude', d.shock.magnitude);
    c.timeline.baseDurationSec = pick('timelapseDuration', d.timeline.baseDurationSec);
    c.render.labelMaxRatio = pick('labelMaxRatio', d.render.labelMaxRatio);
    c.render.labelJournal = fresh ? d.render.labelJournal : !!s.labelJournal;
    // 布尔默认 false 时不能照抄 !!s.xxx —— 这里默认就是 false，所以「缺省 = 关」
    // 与「用户显式关掉」是同一个值，直接 !!s 即可，不会翻转语义。
    c.render.labelYield = fresh ? d.render.labelYield : !!s.labelYield;
    c.render.nodeSize = pick('nodeSize', d.render.nodeSize);

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
          linkBoost: c.drag.linkBoost,
          releaseAlpha: c.drag.releaseAlpha,
          shockMagnitude: c.shock.magnitude,
          timelapseDuration: c.timeline.baseDurationSec,
          labelMaxRatio: c.render.labelMaxRatio,
          labelJournal: c.render.labelJournal,
          labelYield: c.render.labelYield,
          nodeSize: c.render.nodeSize,
          hideSystemJournal: c.data.hideSystemJournal,
          hideSystemPages: c.data.hideSystemPages,
          hideNames: c.data.hideNames.join(', '),
        });
      } catch (e) {}
    }
    return c;
  };
})(window.GFI = window.GFI || {});