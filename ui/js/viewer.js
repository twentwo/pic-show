/**
 * 全屏画廊查看器。
 *
 * 结构上是一条**横向轨道**（track）里串着三张 slide，永远只保持
 * 「上一张 / 当前 / 下一张」三个槽位：
 *
 *   ┌──────┬──────┬──────┐
 *   │ prev │  cur │ next │      track 的 translateX = -cur × 视口宽
 *   └──────┴──────┴──────┘
 *
 * 为什么不是「一张 slide + 切换动画」：那样做滑动只能等松手再播一段动画，
 * 手指跟不上画面；而且每次切换都要新建/销毁节点，低分辨率底图会重新解码，
 * 中途必然闪一下。三槽复用之后：
 *   * 手指按下就能**实时**拖着相邻那张进画面，松手只是把剩下的位移播完；
 *   * 切完把 DOM 顺序轮转一格（appendChild / insertBefore），配合基准偏移
 *     同步改回去，视觉位置一帧都不动，只有视口外那个槽需要换内容 —— 不会闪；
 *   * 两张图始终并排、各自完全不透明，不存在交叉淡入淡出导致的中间帧变暗。
 *
 * 三种变换各写各的元素，互不打架：
 *   * `track` —— 横向槽位偏移（滑动切换）；
 *   * 当前 `slide` —— 缩放 / 平移 / 下拉关闭 / 打开与关闭的 FLIP 转场。
 */

import {
  fullUrl,
  thumbUrl,
  maxEdgeFor,
  preload,
  takeDecoded,
  decodedImage,
  revealImage
} from './api.js';
import { fitBox, clamp, mapBoxToRect } from './geometry.js';
import { withTimeout } from './async.js';
import { Gestures, WHEEL_EDGE_RUBBER } from './gestures.js';
import { CENTER_ZOOM_SCALE } from './launch.js';
import { Strip } from './strip.js';
import {
  CHROME_EASE,
  CHROME_FADE_MS,
  CHROME_IDLE_MS,
  CHROME_RETRY_MS,
  installChromeTokens
} from './chrome.js';

/** 位移动画（轨道切换这类「已经在同一屏里挪一挪」）用的缓动：起步快、尾段长 */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
/**
 * **跨窗口那一次转场**专用的缓动：起步慢一点、全程减速、不过冲。
 *
 * 不能沿用 `EASE`：那条曲线前 20% 就走完大半程，用在「从缩略图长到整屏」上
 * 就是「啪」地弹开 —— 它适合元素在同一屏里挪动，不适合一次跨越两个窗口的
 * 变形。这里要的是 iOS 相册那种曲线：开头有一点从容的加速，之后一路减速收
 * 尾，末端不越过终点（过冲会让画面在最后一帧抖一下）。
 */
const MORPH_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
/**
 * 转场里透明度专用的缓动。
 *
 * 与位移分开不是多此一举：`EASE` 那种「前段猛冲」的曲线用在淡入上，会让
 * 画面在前 20% 就亮了大半，观感是「啪」地跳出来；透明度要的是匀速或缓出。
 * 以前这里混着 `linear` / `ease-out` / `EASE` 三种，同一种淡入在不同入口
 * 上是三种节奏。
 *
 * 名字带 `TWEEN_` 是为了和下面那个 `FADE_EASE` 区分开：后者属于**控件层**
 * （标题栏 / 按钮 / 胶片条的显隐），这一条属于**转场**，两者各管一段，别混。
 */
const TWEEN_FADE_EASE = 'linear';
/**
 * 「减少动态效果」开关（系统辅助功能）。
 *
 * 开着的时候不做缩放位移，只留一段很短的淡入淡出 —— 完全去掉动画会让
 * 「预览开了 / 关了」这件事失去提示，反而更难用。
 */
const REDUCED_MS = 120;
const reduceMotionQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
/** 当前该不该播带位移的转场 */
const motionOK = () => !reduceMotionQuery?.matches;
/** 把一段时长按「减少动态效果」换算 */
const motionMs = (ms) => (motionOK() ? ms : REDUCED_MS);
/**
 * 静止多久后自动隐藏控件。
 * 导出给 `ui/probe.html` 用 —— 探针要等这个时长，硬编码一份迟早会漂移。
 * 真正的定义在 `chrome.js`：标题栏、按钮、胶片条共用它。
 */
export const IDLE_MS = CHROME_IDLE_MS;
/** 与 CSS `--chrome-fade` 同源，供测试核对「JS 阈值与 CSS 动画没漂移」 */
export const FADE_MS = CHROME_FADE_MS;
export const FADE_EASE = CHROME_EASE;
/** 双击放大的目标倍率（相对适配尺寸） */
const DOUBLE_TAP_SCALE = 2.6;
/**
 * 展开动画的时长与缓动。导出是为了让探针能核对「启动动画与预览已有的
 * 转场是同一套参数」—— 硬编码一份去比对，迟早会漂。
 *
 * 时长取 380ms 而不是常见的 300：这次变形要跨过两个窗口（那边刚点亮、这边才
 * 开始长），中间还夹着一段平台转场，短了就像「闪一下就到位」，长了又拖沓。
 * 380ms 是「看得清它是从哪儿来的，又不等人」的那个点。
 */
export const OPEN_EASE = MORPH_EASE;
export const OPEN_MS = 380;
/**
 * 关闭时长。比开场短一档：退出是「还回去」，用户已经知道画面要去哪儿，
 * 拖长只是等。缓动与开场同一条，来回才是同一次运动。
 */
const CLOSE_MS = 320;
/** 背景淡入淡出与画面**同长同缓动** —— 以前背景是各自硬编码的 280 / 200，
 *  于是「画面到了、背景还没到」在两个方向上各撕开一点。 */
const BACKDROP_OPEN_MS = OPEN_MS;
/** 关闭时幕布退去那一段。比画面短一点：此刻已无事可做，拖长了只是干等。 */
const CURTAIN_MS = 180;
/**
 * 单段动画的等待上限。
 *
 * `animation.finished` 在渲染帧停摆（窗口转场、最小化、切走 Space）时不会
 * 兑现，直接 await 它等于把关闭流程交给「浏览器什么时候高兴」决定。
 */
const ANIM_SLACK_MS = 400;
/**
 * 幕布的保险丝时长。
 *
 * 幕布是「点击反馈」，不是状态。挂上之后若迟迟没有 `open()` 接手（形态切不
 * 过去、IPC 挂住、预览正忙被拒），它会自己撤掉 —— 一层不透明的全屏遮罩留在
 * 屏幕上，看起来就是整个程序死了。
 */
const PRIME_FUSE_MS = 4000;
/** 左右切换：轨道位移时长 */
const SWITCH_MS = 300;
/**
 * 横滑跟手之后收尾动画的最短时长。
 *
 * 收尾只需要补完「手指还没走完的那一段」：推了 200px 再翻页，剩余 100px 用
 * 300ms 走完就显得黏；按剩余比例缩到 100ms 上下，观感是「顺着手指滑进去的」。
 * 留 110ms 下限，剩余距离为 0 时也不会变成瞬移。
 */
const SWITCH_EXIT_MIN_MS = 110;
/**
 * 横滑时沿滑动方向预热的张数。
 *
 * `preloadNeighbors()` 是切完才排的、只备前后各一张；连着滑好几下时目标那张
 * 可能还在路上，结算那一帧刚好撞上解码。取 4 是给相邻几次手势留两屏的提前量
 * （每次手势只切一张，但会一张张往前走），且缩略图与原图都要备齐：`fill()`
 * 真正画的是缩略图，只预热原图等于预热错了资源。
 */
const PREFETCH_RUN = 4;
/**
 * wheel 流结束吸附那一小段收尾的**最长**时长（同时是键盘 SWITCH_MS 的上限）。
 *
 * 整段流里画面都是 1:1 跟着手指走的，最后只补「不足一屏的余数」。若还按
 * 键盘切图的 300ms 播，节奏会在松手那一下突然慢下来，就是「顿挫」。
 * 注意这是**上限而不是固定值**：落位时长随剩余距离收缩（见 `wheelLandTiming`），
 * 只剩几 px 时不会再铺满 180ms 慢慢爬。
 */
const WHEEL_LAND_MS = 180;
/**
 * 一次 wheel 落位的时长下限（ms）与初速区间（px/ms）。
 *
 * `v0` 是「从手势交接过来的跟手速度」：`WHEEL_LAND_MIN_V` 兜住「图片刚进视口
 * 时」的节奏（惯性尾巴末尾 / 橡皮筋压缩会把测得速度压到近 0，不设下限就会
 * 退化成缓慢居中）；`WHEEL_LAND_MAX_V` 挡住异常大的单帧增量把落位压成一瞬。
 * `WHEEL_LAND_MIN_MS` 只挡「几 px 的余数被压成 0 帧」：取 24ms（≈120Hz 三帧）。
 * 它不能取大 —— 剩 60px 时若硬凑到 60ms，所需初速就超过匀减速的两倍，
 * 曲线退化成「猛起 + 近零速度慢尾」，恰好是本次要消除的毛病。
 */
const WHEEL_LAND_MIN_MS = 24;
const WHEEL_LAND_MIN_V = 1.4;
const WHEEL_LAND_MAX_V = 4;
/**
 * 落位缓动的 x 控制点。
 *
 * 缓动取 `cubic-bezier(x1, y1, x2, 1)`：`y1 = x1 · v0·T/dist` 让**起点速度
 * 正好等于 v0**，末控制点 y=1 让**终点速度恒为 0**。整段只有一次平滑减速，
 * 既没有旧 `EASE`（.22,1,.36,1）那种「前 13% 时间走完近半程、末 1/3 时间只挪
 * 1%」的快起慢尾，也不会在接近居中处出现速度断层。y1 ≤ 1 保证不过冲。
 */
const WHEEL_LAND_X1 = 1 / 3;
const WHEEL_LAND_X2 = 2 / 3;
/**
 * 开场时等「相邻两槽已有像素」的上限，与 FLIP 同长。
 *
 * 转场那 380ms 本来就冻结手势（防 FLIP 与滑动打架），把邻槽解码塞进这段
 * 等待里不额外占时间；手势开放的那一刻，左右两槽一定已经画着东西，目标图
 * 才能从对应侧边缘**第一帧就**跟着手指进来。图片实在没到也必须按时放行 ——
 * 不能因为一个自定义协议请求把整个预览锁死。
 */
const NEIGHBOR_READY_MS = OPEN_MS;
/**
 * 目标图「贴边跟随」在收尾期的归位时长与缓动。
 *
 * 跟手期间把目标图按进度贴到槽位近边（见 `followWheelSeam`），流一结束就得
 * 收回居中：补完最后一张走 `wheelLandTiming()`（与轨道 `animateTrack` 同一份
 * 时长 / 缓动），取消走 `Gestures.animateTrackTo`。两边必须用**同一段时长和
 * 同一条缓动**，否则收尾末了目标图会相对轨道突跳一下。
 *
 * 时长仍是 200ms：快速滑动达标时走补完那条路径，与这里无关，「快滑复位迅速」
 * 的观感不受影响。慢滑未达标才走回弹 —— 原来固定 `EASE_SOFT`（起点速度约为
 * 平均速度 3 倍），而手指末速只有 0.1~0.3 px/ms，松手那一下画面会突然加速，
 * 就是「生硬」。现在由 `wheelReboundTiming()` 把**起点速度接回交接速度**、终点
 * 仍为 0；速度足够高时 y1 顶到 1，直接返回原来的 `WHEEL_SEAM_SOFT_EASE`，
 * 边界快滑等行为逐字不变。这里的字符串与 gestures.js 的 EASE_SOFT 保持一致。
 */
const WHEEL_SEAM_REBOUND_MS = 200;
const WHEEL_SEAM_SOFT_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)';
/**
 * 回弹初速地板（px/ms）：慢滑到几乎静止时也不把 y1 压成 0，否则前段会先黏住
 * 再加速，反而更不自然。取值贴近「轻甩 0.06」，**远低于落位的 1.4** —— 落位
 * 要补完一屏，回弹只收回几十 px，套用同一个下限会把 y1 顶回 1、等于没改。
 */
const WHEEL_REBOUND_MIN_V = 0.08;
/** 跳转到相隔很远的一张时用的淡入时长 */
const JUMP_MS = 200;
/** 到首尾回弹提示的幅度（px） */
const NUDGE_PX = 22;
/**
 * 边界阴影的最大不透明度。到首 / 末张时它只是「到头了」的一层提示，不能盖住
 * 图片本身；宽度固定在 CSS 的 `.viewer-edge-shade`，跟手期只改 transform /
 * opacity，不触发布局。颜色取 `var(--viewer-bg)`，深浅主题都自动跟着预览背景。
 */
const WHEEL_EDGE_SHADE_ALPHA = 0.45;

export class Viewer {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root #viewer
   * @param {(message:string)=>void} opts.onError
   * @param {()=>void} opts.onClosed 每次关闭 / 取消完成后回调。
   *   **唯一的收尾出口** —— 「这次预览要不要连带退出应用」由调用方在它里面
   *   决定（它才知道这次会话是不是从文件管理器来的）。Viewer 自己只管把画面
   *   收干净。
   */
  constructor({ root, onError = () => {}, onClosed = () => {} }) {
    this.root = root;
    this.onError = onError;
    this.onClosed = onClosed;
    /**
     * 开场动画的起点 / 退场动画的落点（**本窗口视口坐标系**）。
     *
     * 预览是独立窗口，网格那一格在**另一个 webview** 里 —— 这里拿不到它的
     * DOM，也就无法在关闭时再去问「这一格现在在哪」。所以来源矩形在开场时
     * 记下来，关闭动画原路缩回去。
     *
     * 翻了页也不更新：那时用户看的是另一张，缩回「最初点开的那一格」仍是
     * 唯一说得通的落点（那一格在另一个窗口里，我们既看不到也改不动）。
     */
    this.originRect = null;
    /** 首尾是否循环；false = 禁用并给回弹提示 */
    this.loop = false;

    this.items = [];
    this.index = -1;
    this.isOpen = false;
    this.closing = false;
    this.switching = false;
    /** 开场世代号：作废「上一次 open 还挂在动画上的手势开放回调」 */
    this.openGen = 0;

    this.box = { w: 0, h: 0 };
    this.backdropOpacity = 0;
    this._idle = 0;

    // 标题栏 / 按钮 / 胶片条共用同一套计时与动画参数（见 chrome.js）
    installChromeTokens();

    this.backdrop = root.querySelector('.viewer-backdrop');
    this.stage = root.querySelector('.viewer-stage');
    this.bar = root.querySelector('.viewer-bar');
    this.titleEl = root.querySelector('.viewer-title');
    this.counterEl = root.querySelector('.viewer-counter');
    this.zoomEl = root.querySelector('.viewer-zoom');
    this.prevBtn = root.querySelector('.nav-btn.prev');
    this.nextBtn = root.querySelector('.nav-btn.next');

    // ---- 轨道与三个槽 -------------------------------------------------
    this.track = document.createElement('div');
    this.track.className = 'viewer-track';
    this.slots = [0, 1, 2].map(() => {
      const slide = this.createSlide();
      this.track.appendChild(slide);
      return slide;
    });
    this.stage.replaceChildren(this.track);
    // 边界阴影层：插在 stage 之后、chrome 之前 —— 压得住画面，控件永远在它上面。
    // 只在到首 / 末张那一段出现，正常切换路径完全不碰它。
    this.edgeShade = this.createEdgeShade();
    /** 当前显示的槽在 `slots` 里的下标（rebalance 之后恒为 1） */
    this.slotIndex = 1;
    /** 轨道当前的基准偏移（px，负值） */
    this.trackOffset = 0;
    this.trackAnim = null;
    /**
     * 切换的世代号：每开一次 `go()` 自增。手势接管动画后会立刻允许新的切换，
     * 于是旧那次 `go()` 的 `await` 可能在新切换开场之后才回来 —— 用它认领
     * 「我还是不是当前那一次」，避免把新实例的闸门提前放开。
     */
    this.switchGen = 0;
    /** 尺寸变化合并用的帧句柄 */
    this._resizeRaf = 0;

    // ---- 底部胶片条 ---------------------------------------------------
    this.strip = new Strip({
      root: root.querySelector('.viewer-strip'),
      inner: root.querySelector('.strip-inner'),
      onJump: (index) => this.jumpTo(index)
    });

    // 尺寸变化用 ResizeObserver 观察 stage，而不是只听 window.resize：
    // 前者还能覆盖 CSS 断点变化（--strip-h）、DPI 变化等所有让 stage 尺寸
    // 改变的情况。window.resize 留作兜底（个别 webview 最小化再还原时
    // ResizeObserver 不回调）。两者都合并到同一帧里执行。
    this._ro = new ResizeObserver(() => this.scheduleResize());
    this._ro.observe(this.stage);

    root.querySelector('.viewer-close').addEventListener('click', () => this.close());
    root.querySelector('.nav-btn.prev').addEventListener('click', () => this.go(-1));
    root.querySelector('.nav-btn.next').addEventListener('click', () => this.go(1));
    root.querySelector('.zoom-in').addEventListener('click', () => this.zoomBy(1.35));
    root.querySelector('.zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.35));
    root.querySelector('.viewer-zoom').addEventListener('click', () => this.fit());
    root.querySelector('.reveal').addEventListener('click', () => {
      const item = this.currentItem;
      if (item) {
        revealImage(item.id).catch((error) => this.onError(String(error)));
      }
    });

    this.backdrop.addEventListener('click', () => this.close());

    this._onKey = (event) => this.onKeyDown(event);
    this._onResize = () => this.scheduleResize();
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('resize', this._onResize);
  }

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    this.strip.setItems(this.items);
    // 只有一张时没有「列表」可言：胶片条与左右按钮都让位给画面
    this.root.classList.toggle('no-strip', this.items.length < 2);
    this.updateNavState();
  }

  /**
   * 把键盘焦点交给预览视图。
   *
   * 为什么必须显式做一次，而不是指望「点开预览时焦点自然就在页面上」：
   *   * 窗口是**隐藏启动**的，webview 创建时不是 key window，第一响应者根本
   *     不在页面上 —— 那之后不点一下画面，按键事件就进不来；
   *   * `#viewer` 默认不可聚焦，`focus()` 打在它上面是空的，得先给它 tabindex。
   *
   * 用 `-1` 而不是 0：语义正是「程序可以聚焦、Tab 遍历不会绕进来」，预览里
   * 没有需要用 Tab 走一遍的控件序列。
   */
  focusView() {
    const node = this.root;
    if (!node) return;
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    try {
      node.focus({ preventScroll: true });
    } catch {
      node.focus();
    }
  }

  /**
   * 首图落地之后再把焦点交给预览视图。
   *
   * 不早设的理由很实在：点亮窗口之后还有全屏切换、布局落定这几帧，它们会
   * 把刚抢到的焦点冲掉；图片还在解码时按下的第一个方向键，落在的是「什么
   * 都还没画出来」的画面。等第一帧真的有图了再落焦点，按下去就是立刻换一张。
   *
   * 带超时兜底：加载失败也不能把焦点一直吊着 —— 那时至少 DOM 焦点已经给了
   * 预览，方向键切到下一张往往就救回来了。
   */
  async focusWhenReady(timeout = 4000) {
    await imageReady(this.currentSlot, timeout);
    this.focusView();
  }

  /** 首尾是否循环。默认 false：到头就禁用按钮并给一次回弹提示。 */
  setLoop(enabled) {
    this.loop = Boolean(enabled);
    this.updateNavState();
  }

  /**
   * 首 / 末张的按钮状态。
   *
   * 不循环时直接置灰，比「点了没反应」清楚得多；循环时始终可用。
   */
  updateNavState() {
    if (!this.prevBtn || !this.nextBtn) return;
    const single = this.items.length < 2;
    this.prevBtn.disabled = single || (!this.loop && this.index <= 0);
    this.nextBtn.disabled =
      single || (!this.loop && this.index >= this.items.length - 1);
  }

  get currentItem() {
    return this.items[this.index] ?? null;
  }

  /** 当前显示的那个槽 */
  get currentSlot() {
    return this.slots[this.slotIndex] ?? null;
  }

  /**
   * 手势与适配用的可视区。注意高度取 stage 而非窗口：
   * 底部胶片条是浮层，stage 已经把它的高度让出来了，平移边界才对得上。
   */
  view() {
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || window.innerHeight;
    return { left: 0, top: 0, w, h };
  }

  /** 一个槽的宽 = stage 宽（track 的三个子项各占 100%） */
  slotWidth() {
    return this.stage.clientWidth || window.innerWidth;
  }

  /**
   * 把**视口坐标**里的矩形折成 **stage 坐标**。
   *
   * 跨窗口送过来的来源矩形是视口坐标（主窗口那边量的是
   * `getBoundingClientRect()`），而 `view()` 给的是 stage 自己的尺寸、原点算
   * (0,0)。stage 并不是整个视口 —— CSS 里它给顶栏让出了 `--chrome-top`、给底
   * 部胶片条让出了 `--strip-h`。两套坐标混着用，起点就会整整偏移一个顶栏的
   * 高度：明明点的是屏幕中间那一格，画面却从偏上的地方长出来。
   *
   * 只在开场/收场各量一次，不在手势的热路径上 —— `getBoundingClientRect()`
   * 会强制一次布局，不能放进 pointermove。
   */
  localRect(rect) {
    if (!rect) return null;
    const host = this.stage.getBoundingClientRect();
    return {
      left: rect.left - host.left,
      top: rect.top - host.top,
      width: rect.width,
      height: rect.height
    };
  }

  /**
   * 转场的**裁切框**：把画面裁到来源矩形那么大。
   *
   * 起点用 cover 取缩放（见 `mapBoxToRect`），画面因此会溢出那一格一点 ——
   * 裁掉溢出量，开头那一帧才是缩略图那一格逐像素相同的画面，尺寸也对得齐。
   *
   * @param {?{left,top,width,height}} local stage 坐标里的矩形
   * @returns {?string} `clip-path` 的 `inset()` 值
   */
  clipFor(local) {
    if (!local || !(local.width > 0) || !(local.height > 0)) return null;
    const view = this.view();
    const l = clamp(local.left, 0, view.w);
    const t = clamp(local.top, 0, view.h);
    const r = clamp(view.w - (local.left + local.width), 0, view.w);
    const b = clamp(view.h - (local.top + local.height), 0, view.h);
    return `inset(${t}px ${r}px ${b}px ${l}px)`;
  }

  /* ------------------------------------------------------------------ *
   * 打开 / 关闭
   * ------------------------------------------------------------------ */

  /**
   * 打开画廊。
   *
   * @param {number} index
   * @param {object} [options]
   * @param {?{left,top,width,height}} [options.fromRect]
   *        视口坐标系里的起点矩形（那一格缩略图的位置）
   * @param {number} [options.centerScale] 什么来源都没有时的起始倍率（中心放大）
   *
   * 不建议直接调用 —— 请用 {@link Viewer#openFullscreen}：它是全屏预览的
   * 唯一入口，负责把「从哪来」折算成这里的一套几何参数。留在这个方法上的
   * options 越自由，各条入口就越容易长得不一样（历史上正是这么分岔的）。
   */
  /**
   * 开场前的「幕布」：只铺一层背景，不放画面。
   *
   * 切全屏是一段平台转场（macOS 上最明显，进出各约 0.3~0.5s），这段等待躲不
   * 掉。不挂幕布的话，用户点下去到画面长出来之间有几百毫秒的「什么都没发
   * 生」，很容易以为点漏了。挂上幕布，点击的反馈是即时的。
   *
   * 之后 `open()` 会从这层幕布**接着**淡入背景，不会先把背景归零再淡一次
   * （那会闪一下），见 `open()` 里对 `is-priming` 的处理。
   */
  prime() {
    if (this.isOpen || this.closing) return;
    this.root.hidden = false;
    this.root.classList.add('is-priming');
    this.root.classList.remove('is-idle');
    this.setBackdrop(1);

    // 保险丝：幕布只负责「点到有反应」这一瞬间，不负责等下去。挂上之后如果
    // 迟迟没有 `open()` 接手（形态切不过去、IPC 挂住、预览正忙被拒），它自己
    // 撤掉 —— 一层不透明的全屏遮罩留在屏幕上，和程序死了没有区别。
    clearTimeout(this._primeFuse);
    this._primeFuse = setTimeout(() => this.cancelPrime(), PRIME_FUSE_MS);
  }

  /**
   * 取消一次**还没落地**的打开。
   *
   * 与 {@link close} 的区别：那一刻画面根本还没画出来，没有退场动画可言，
   * 直接收摊让预览窗口让位。用户的这次打开因此像没发生过一样。
   */
  abort() {
    if (this.isOpen || this.closing) return;
    clearTimeout(this._primeFuse);
    this._primeFuse = 0;
    this.root.classList.remove('is-priming');
    this.setBackdrop(0);
    this.root.hidden = true;
    // 与「关闭完成」同一条出路：预览窗口让位，焦点交还主窗口
    this.onClosed?.();
  }

  /** 撤掉幕布（开场没走通时兜底，别把画面永久盖住） */
  cancelPrime() {
    clearTimeout(this._primeFuse);
    this._primeFuse = 0;
    if (this.isOpen) return;
    this.root.classList.remove('is-priming');
    this.setBackdrop(0);
    this.root.hidden = true;
  }

  /** 现在能不能开一次预览（会话到手时先看一眼，别把一次开到一半的重来）。 */
  get canOpen() {
    return !this.isOpen && !this.closing && this.items.length > 0;
  }

  open(index, options = {}) {
    // 没有内容时：幕布可能是宿主刚挂上的，完整撤掉（此时没有会话在跑）。
    if (!this.items.length) {
      this.cancelPrime();
      return;
    }
    // 预览正开着 / 上一次关闭还没收尾：动不得。这里只摘掉幕布类，
    // `hidden` 与背景交给那一次 `close()` 收尾 —— 提前归零会把关闭动画
    // 的底色抽掉。
    if (this.isOpen || this.closing) {
      clearTimeout(this._primeFuse);
      this._primeFuse = 0;
      this.root.classList.remove('is-priming');
      return;
    }

    this.index = clamp(index, 0, this.items.length - 1);
    const openGen = ++this.openGen;
    // 记下起点，关闭时原路缩回去（预览窗口里没有网格，无法现问）
    this.originRect = options.fromRect ?? null;

    // 幕布已经在的话，背景就是不透明的：直接接着用，别归零再淡一次（会闪）
    const priming = this.root.classList.contains('is-priming');
    clearTimeout(this._primeFuse);
    this._primeFuse = 0;
    this.root.classList.remove('is-priming');

    // 必须先显示再填充：`hidden` 时 stage 的尺寸是 0，fitBox 会算出 0×0
    this.root.hidden = false;
    this.root.classList.remove('is-idle');
    if (!priming) this.setBackdrop(0);

    this.slotIndex = 1;
    const leftReady = this.fill(this.slots[0], this.index - 1);
    this.fill(this.slots[1], this.index);
    const rightReady = this.fill(this.slots[2], this.index + 1);
    // 手势开放之前，左右两槽必须已经画得出东西 —— 否则「目标图从对应侧边缘
    // 立即进入」的第一帧会是背景。预热与转场并行，等待上限与转场同长，
    // 一次自定义协议请求没赶上也不会把预览锁死。
    const neighborsReady = withTimeout(
      Promise.all([leftReady, rightReady]),
      NEIGHBOR_READY_MS
    );
    this.preloadNeighbors();
    this.box = this.slots[1].__box ?? { w: 0, h: 0 };

    this.trackOffset = -this.slotWidth();
    this.track.style.transform = `translate3d(${this.trackOffset}px, 0, 0)`;

    this.strip.focus(this.index, { immediate: true });
    this.attachGestures();
    this.updateInfo();

    // 「减少动态效果」时不做 FLIP：缩放位移正是这类设置要消掉的东西
    const from = motionOK() ? this.zoomStart(options) : null;
    const slide = this.slots[1];

    // 展开动画期间不接受手势：中途拖一下会同时跑 FLIP 和滑动，画面会打结
    if (this.g) this.g.enabled = false;

    if (from) {
      // 位移与透明度拆成两条动画：一条动画只能给一条缓动曲线，而这两种运动
      // 想要的节奏并不一样（见 `TWEEN_FADE_EASE` 的注释）。两者等长、
      // `fill: 'backwards'`，在同一帧上叠加，观感仍是一次展开。
      //
      // `backwards` 而不是 `none`：动画对象创建出来之后还要等一帧才真正开跑，
      // 那一帧里元素显示的是它自己的基础样式 —— 也就是**全尺寸、不透明**。
      // 于是开场会先闪一帧「画面已经到位」，然后才缩回去重新长大。填满「开跑
      // 之前」那一段就没有这一帧。
      const anim = slide.animate(
        { transform: [from, 'translate3d(0px, 0px, 0) scale(1)'] },
        { duration: OPEN_MS, easing: OPEN_EASE, fill: 'backwards' }
      );
      // 「从某一格长出来」必须配透明度渐变才像透视，纯位移会显得很硬。
      //
      // 这里写死而不再留给调用方开关：以前「打开方式」传 `fadeIn: true`、
      // 网格点击不传，于是同一个全屏预览在两条入口上是两种观感。现在三条
      // 入口都经过 `openFullscreen()`，渐变是这条路的唯一形态。
      slide.animate({ opacity: [0, 1] }, {
        duration: OPEN_MS,
        easing: TWEEN_FADE_EASE,
        fill: 'backwards'
      });
      // 裁切框：起点按 cover 取缩放，画面会溢出那一格一点（见
      // `mapBoxToRect`）。裁掉溢出量，第一帧才是缩略图那一格逐像素相同的
      // 画面 —— 位置和尺寸都对得上，而不是「大致从那边来」。
      const clip = this.clipFor(this.localRect(options.fromRect));
      if (clip) {
        this.stage.animate(
          { clipPath: [clip, 'inset(0px 0px 0px 0px)'] },
          { duration: OPEN_MS, easing: OPEN_EASE, fill: 'backwards' }
        );
      }
      this.fadeBackdrop(1, BACKDROP_OPEN_MS);
      this.boost(slide, anim);
      // 转场跑完再拉原图，避免大图解码抢走转场的帧。开放手势前顺带等一下
      // 两槽的像素（已与转场并行，正常情况下它先兑现，不额外占时间）。
      anim.finished
        .then(() => neighborsReady)
        .then(() => {
          if (openGen !== this.openGen) return;
          if (this.g) this.g.enabled = true;
          this.startFullLoad();
          this.preloadNeighbors();
        })
        .catch(() => {});
    } else {
      const ms = motionMs(OPEN_MS);
      slide.animate({ opacity: [0, 1] }, { duration: ms, easing: TWEEN_FADE_EASE, fill: 'none' });
      this.fadeBackdrop(1, ms);
      setTimeout(() => {
        // 「减少动态效果」时没有 FLIP 那段现成的窗口，不再为了等邻槽额外扣
        // 120ms；此时靠 preloadNeighbors() 已并行发出的预热 + 原子换源保底，
        // 任何时刻换槽都不会露出空白。世代号照旧要挡住上一次开场的回调。
        if (openGen === this.openGen && this.g) this.g.enabled = true;
      }, ms);
      this.startFullLoad();
      this.preloadNeighbors();
    }

    this.isOpen = true;
    this.bumpChrome();
  }

  /**
   * 转场期间给元素开合成层提示，跑完立刻撤掉。
   *
   * 只在动画那几百毫秒里挂 `will-change`：常驻的话，浏览器会为整张预览图
   * 一直留着一张合成层，内存与低速设备上的合成开销都白白吃进去。
   */
  boost(el, anim) {
    if (!el) return;
    el.style.willChange = 'transform, opacity';
    anim?.finished?.then(() => {
      el.style.willChange = '';
    }).catch(() => {
      el.style.willChange = '';
    });
  }

  /**
   * 开场/收场那次变形的起始（或终止）transform，取不到就返回 null（走普通淡入）。
   *
   * 优先级：来源矩形（那一格缩略图，由主窗口经屏幕坐标折算过来） → 中心缩放
   * （拿不到来源信息时的兜底）。时长与缓动沿用 `OPEN_MS` / `OPEN_EASE`。
   *
   * 来源矩形进来时是**视口坐标**，这里先折成 stage 坐标再用 —— 见
   * {@link localRect}：少这一步，起点会整体偏一个顶栏的高度。
   *
   * @param {{fromRect?: ?object, centerScale?: number}} [options]
   */
  zoomStart(options = {}) {
    const { fromRect = null, centerScale = 0 } = options ?? {};
    const usable = (rect) =>
      rect && Number.isFinite(rect.width) && rect.width > 0 && rect.height > 0;
    const local = this.localRect(fromRect);
    const rect = usable(local) ? local : null;

    if (rect) {
      const { scale, tx, ty } = mapBoxToRect(this.box, rect, this.view());
      return `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    }
    if (centerScale > 0 && centerScale !== 1) {
      return `translate3d(0px, 0px, 0) scale(${centerScale})`;
    }
    return null;
  }

  /**
   * 全屏预览的**唯一**入口。
   *
   * 三条进入预览的路 —— 图片墙点击、图片墙里回车、「打开方式」启动 —— 在
   * 主窗口那边都汇到 `api.openViewer`（差别只是 `immersive` 与来源矩形），
   * 到这边又都汇到 {@link openLaunch}，所以开场几何、透明度渐变、背景淡入、
   * 时长缓动、之后的缩放拖拽切换关闭整套交互，在代码上就是同一份实现。
   *
   * 以前是每条路各自给 `open()` 配一套 options：忘了传 `fadeIn`、忘了给中心
   * 兜底倍率，两条入口的观感就悄悄不一样了，而且这类差异没有任何测试会报错。
   * 收敛成一个入口之后，「有来源矩形 / 没有来源矩形」只是来源的两种情况，
   * 不再是两种呈现。
   *
   * 不返回 Promise、不等任何图片：几何来自 `items` 里的宽高元数据，第一帧
   * 就能动起来，底图到达时自然补上。
   *
   * @param {number} index
   * @param {?{rect?: ?object}} [source] 开场动画的来源矩形（视口坐标系）。
   *   没有（跨窗口那趟没送到、或本来就没有）就从屏幕中心按
   *   {@link CENTER_ZOOM_SCALE} 放大 —— 兜底而非失败，用户看到的仍是同一次
   *   放大，只是少了「从哪儿来」这条信息。
   */
  openFullscreen(index, source = null) {
    this.open(index, {
      fromRect: source?.rect ?? null,
      centerScale: CENTER_ZOOM_SCALE
    });
  }

  /**
   * 预览窗口的专用入口。
   *
   * 来源矩形是**屏幕坐标经折算**得来的：主窗口把那一格的位置折到桌面坐标系
   * 再送过来，这里再按预览窗口自己的原点折回视口 —— 预览是独立窗口，全屏落
   * 在哪块屏取决于主窗口在哪块屏。
   *
   * @param {number} index
   * @param {?{left,top,width,height}} rect 视口坐标系里的来源矩形
   */
  openLaunch(index, rect) {
    this.openFullscreen(index, { rect });
  }

  /**
   * 关闭预览。
   *
   * 分两段，顺序是这次动效的关键：
   *
   *   1. **画面退场** —— 图片缩回开场时那一格的方向并淡出。背景**不动**，
   *      仍是不透明的；
   *   2. **幕布退去** —— 根容器连它那层不透明背景一起淡掉。之后后端把预览
   *      窗口**整个销毁**（见 `finishClose` 的注释），用户看到的直接是图片墙。
   *
   * 以前这里夹着第三段「幕后换场」：趁幕布还盖着把窗口形态还回去、让网格
   * 重排。分家之后那一段整个消失了 —— 预览是独立窗口，图片墙那条窗口在这
   * 次关闭里一个像素都没被动过，也就没有什么需要藏在幕布后面。
   */
  async close({ fromDismiss = false } = {}) {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    // 关闭动画期间冻结手势，否则中途再拖一下会打断 FLIP
    if (this.g) this.g.enabled = false;

    // 收尾放进 `finally`：从这一行到 `finishClose()` 之间横着动画回执、幕后
    // 换场的 IPC、幕布淡出三段异步，任何一段抛错或永不兑现，都不能把那层
    // `position:fixed; inset:0` 的预览留在屏幕上 —— 那正是「退出后界面卡死」
    // 的直接形态。`finishClose()` 本身是幂等的。
    try {
      await this.playClose({ fromDismiss });
    } finally {
      this.finishClose();
    }
  }

  /** 关闭的动画部分（不含收尾）；`close()` 保证它一定跟得上 `finishClose()`。 */
  async playClose({ fromDismiss = false } = {}) {
    const slide = this.currentSlot;
    if (!slide) return;

    // 放大状态下先收回适配尺寸，这样 FLIP 的起点矩形才是确定的
    if (!fromDismiss && this.g?.isZoomed) {
      await withTimeout(this.g.reset(true), 400);
    }

    // 落点就是开场时记下的那一格。预览窗口里没有网格 DOM，关不掉时才去问
    // 「这一格现在在哪」—— 那种问法在跨窗口之后不再成立。
    //
    // 与开场一样要先折成 stage 坐标（`localRect`），并配裁切框：收场是开场的
    // 逆过程，两边用同一套几何才是对称的来回 —— 否则「长出来」和「缩回去」
    // 落点差几十像素，看着就是一次抖动。
    const target = this.localRect(this.originRect);

    const start = slide.style.transform || 'translate3d(0px, 0px, 0) scale(1)';
    const startOpacity = this.backdropOpacity;

    // 「减少动态效果」时只淡出，不做缩回位移
    const useFlip = motionOK() && target && target.width > 0;
    let end = 'translate3d(0px, 0px, 0) scale(0.94)';
    if (useFlip) {
      const { scale, tx, ty } = mapBoxToRect(this.box, target, this.view());
      end = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    }

    const ms = motionMs(CLOSE_MS);
    // 缓动与开场同一条（`OPEN_EASE`）：来回是同一次运动，不能一边弹开一边收。
    const anim = slide.animate({ transform: [start, end] }, {
      duration: ms,
      easing: OPEN_EASE,
      fill: 'none'
    });
    const clip = useFlip ? this.clipFor(target) : null;
    if (clip) {
      this.stage.animate(
        { clipPath: ['inset(0px 0px 0px 0px)', clip] },
        { duration: ms, easing: OPEN_EASE, fill: 'none' }
      );
    }
    // 收尾淡出：掩盖「全屏原图 → 网格缩略图」的分辨率落差。
    // 前 55% 保持不透明（画面在飞行中始终是实的），后段再缓出淡掉 —— 用
    // offset 加分段缓动，比整段 linear 少一点「到点突然开始消失」的生硬。
    slide.animate({ opacity: [1, 1, 0], offset: [0, 0.55, 1] }, {
      duration: ms,
      easing: ['linear', 'ease-out'],
      fill: 'none'
    });
    this.boost(slide, anim);

    // 背景这一段的走向分两种：
    //   * 普通关闭 —— 原地不动。幕布要留到**根容器**那一段才退，现在就把它
    //     淡掉，等于让画面在半透明状态下被抽走；
    //   * 下拉关闭 —— 背景早被手势拖淡了，这时补回不透明反而是闪一下，照
    //     原样淡到 0 收尾。
    const backdropEnd = fromDismiss ? 0 : startOpacity;
    const exit = this.backdrop.animate(
      { opacity: [startOpacity, backdropEnd] },
      { duration: ms, easing: TWEEN_FADE_EASE, fill: 'none' }
    );
    this.backdropOpacity = backdropEnd;

    this.root.classList.remove('is-idle');

    await withTimeout(
      Promise.all([anim.finished, exit.finished]).catch(() => {}),
      ms + ANIM_SLACK_MS
    );
    // 动画是 `fill: 'none'`，一结束透明度就会弹回元素本身的 1 —— 下面还要
    // 整屏隐去，画面绝不能这时候又冒出来。
    slide.style.opacity = '0';

    // 幕布退去。根容器上那层不透明背景跟着一起淡掉之后，窗口隐去只是一下
    // 消失（而不是「啪」地把画面抽走）。
    //
    // 以前这两步之间还夹着「后台换场」—— 趁幕布还盖着把窗口形态还回来、让
    // 网格重排。分家之后那件事整个没了：预览是独立窗口，收摊时它被**整个销毁**，
    // 图片墙那条窗口的布局从头到尾没被顶过一下。
    //
    // 淡的是**根容器**而不是 `.viewer-backdrop`：根容器自己就带着一层不透明
    // 背景（`--viewer-bg` 是实心色），只淡背景层的话底下还是黑的 —— 那一层
    // 从来没真正"退去"过，以前是靠 `root.hidden = true` 硬切掉的。
    await withTimeout(
      this.root
        .animate({ opacity: [1, 0] }, {
          duration: motionMs(CURTAIN_MS),
          easing: TWEEN_FADE_EASE,
          fill: 'none'
        })
        .finished.catch(() => {}),
      CURTAIN_MS + ANIM_SLACK_MS
    );
    this.root.style.opacity = '';
  }

  finishClose() {
    // 幂等：`close()` 把收尾放在 `finally` 里，任何一条路径都要保证它跑，
    // 也都要保证它不会跑第二次（否则 `onClosed` 会把焦点抢两遍）。
    if (!this.isOpen && !this.closing) return;
    // 作废上一次开场还挂在动画 / 预热上的回调，别让它把新实例的手势提前放开
    this.openGen += 1;

    clearTimeout(this._primeFuse);
    this._primeFuse = 0;
    this.root.style.opacity = '';
    // 「空闲隐藏」这个类是预览**开着**时才有意义的显示状态，收摊时必须一并
    // 撤掉：留着它，下一次开场的第一帧会因为 `.viewer.is-idle` 而把控件的
    // 透明度定在 0，控件要到第一次 `bumpChrome()` 才冒出来。
    this.root.classList.remove('is-idle');
    this.g?.detach();
    this.g = null;
    this.resetSlots();
    // 撤幕布走的是根容器的透明度，背景层这一路下来始终停在 1。归零，下次
    // 开场才不会从「背景已经满了」的状态开始（那样就没有淡入可言）。
    this.setBackdrop(0);
    this.root.hidden = true;
    this.root.classList.remove('is-priming');
    this.isOpen = false;
    this.closing = false;
    clearTimeout(this._idle);
    // 唯一的收尾出口：要不要连带退出应用是**会话语义**，由调用方在这个回调
    // 里决定 —— Viewer 只保证画面收干净、这一次通知一定送到。
    //
    // 早先这里还并行着一条 `onExit`（`exitOnClose` 为真时再调一次），于是
    // 「打开方式」那条会话关一次会退出两次：一次来自 `onClosed` 里的分支，
    // 一次来自这里。两条出口并存是这类重复动作的温床，现在只留一条。
    this.onClosed?.();
  }

  /**
   * 彻底卸载预览层：拆掉观察器与全局监听器。
   *
   * 平时用不到（预览窗口退出时整条被销毁，这个 webview 随它一起消失），但
   * 「退出预览」这件事必须有一个明确的、能把所有全局副作用收回去的出口 ——
   * 否则「预览关了之后还有谁在监听键盘 / 还在观察尺寸」只能靠读代码回答。
   */
  destroy() {
    this.finishClose();
    this._ro?.disconnect();
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = 0;
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('resize', this._onResize);
    this.strip?.destroy?.();
  }

  /* ------------------------------------------------------------------ *
   * 切换
   * ------------------------------------------------------------------ */

  /**
   * 单步同步换页原语：**当前 wheel 流不调用它**。
   *
   * 一次触控板横滑现在只在流停下时由 `onWheelSwipe → go()` 结算一张，流中间
   * 的累计位移只用来跟手、被压缩在不足一屏，因此不会走进这里。保留它是为了
   * 不牵动 `rebalance` / 预热 / 已解码图片池那一串配套改动；若将来重新启用
   * 逐屏换页，与 `go()` 的区别仍是这里什么都不等：不播收尾动画、不设
   * `switching` 闸门、不关 `enabled`、不重建 `Gestures`（只 `retarget` 到新槽）。
   *
   * 视觉连续性由 `rebalance()` 保证：DOM 轮转一格的同时把 `trackOffset` 对齐到
   * 新的中间槽，此刻画面正好停在「下一张完整显示」的位置。原图不在这里拉，
   * 由 `onWheelRest` 在流结束时补给。
   *
   * @param {number} direction +1 下一张 / -1 上一张
   * @returns {boolean} false = 到首尾了
   */
  advanceBy(direction) {
    const step = direction > 0 ? 1 : -1;
    if (!this.isOpen || this.closing) return false;
    const target = this.index + step;
    if (target < 0 || target >= this.items.length) return false;

    // 作废任何还在跑的切换 / 收尾动画及其世代号：连续流不欠它一次 await
    if (this.trackAnim) {
      try {
        this.trackAnim.cancel();
      } catch {
        /* 已结束的动画忽略 */
      }
      this.trackAnim = null;
    }
    this.switchGen += 1;
    this.switching = false;

    // 单步换页的热路径：视口只量一次，往下传给 rebalance / fill，别在
    // appendChild 之后、写完 transform 之前再读 clientWidth（强制同步重排）。
    const view = this.view();
    this.index = target;
    // 预热必须排在 rebalance **之前**：它接下来填的正是「再下一张」那个槽，
    // 若等填完才预热，每一次推进都注定错过自己那一轮的已解码节点。反方向
    // 也备一张 —— 一段流里中途掉头是常态，反向第一帧同样不能露白。
    this.prefetchNeighbor(step, PREFETCH_RUN);
    this.prefetchNeighbor(-step, 1);
    this.slotIndex = 1 + step;
    this.box = this.slots[this.slotIndex].__box ?? this.box;
    // 轮转三槽：当前张回到中间，视口外那个槽换上「再下一张」的内容。
    // skipTransform：紧跟其后的 applyTrack() 会在同一任务里写回「基准 + 剩余
    // 位移」，这里再写一次静止基准纯属多余（同一帧第二次 transform 写入）。
    this.rebalance({ view, skipTransform: true });
    // 手势实例不重建，只把变换目标换到新的当前槽
    this.g?.retarget(this.currentSlot);

    this.updateInfo();
    this.strip.focus(target);
    this.bumpChrome();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 目标图贴边跟随（触控板 wheel 横滑专用）
   * ------------------------------------------------------------------ */

  /**
   * 跟手每一帧：让「正从对应侧边缘进视口」的目标图贴住槽位近边。
   *
   * `.slide img` 是 `object-fit: contain` 居中排的，槽里左右各留
   * `m = (视口宽 - 图片宽) / 2` 的黑边（竖幅照片能到三四百像素）。轨道明明
   * 已经动了，先进视口的却是这段留白 —— 目标图要滑过小半屏才露面，这就是
   * 「目标图片出现不明显」：不是槽空了，是**图片没贴着边缘**。
   *
   * 这里把目标槽里的两张 `<img>`（底图 + 原图）按 `m` 挪到**朝向视口的那条
   * 边**：从起手第一帧起，目标图的可见宽度就等于轨道移过的宽度，与
   * `swipeX` 1:1 连续同步；随进度接近一整屏，贴边量线性收回 0，目标图在
   * 变成当前张的那一刻正好回到居中，收尾没有跳变。
   *
   * 只用缓存的 `slot.__box.w` 算留白，不读 clientWidth / getBoundingClientRect
   * —— 120Hz 的 wheel 流里一次强制重排就是一次掉帧。
   *
   * @param {number} swipeX 本帧轨道相对中间槽基准的横移（负 = 下一张从右边进）
   * @param {number} viewW 这一段手势开始时量好的视口宽
   */
  followWheelSeam(swipeX, viewW) {
    if (!this.isOpen || this.closing || !swipeX) return;
    const width = viewW || this.slotWidth();
    const dir = swipeX < 0 ? 1 : -1;
    const progress = clamp(Math.abs(swipeX) / Math.max(1, width), 0, 1);
    const target = this.slots[1 + dir];
    if (!target) return;

    // 内容先对齐：一段流里中途掉头、或上一段在首尾阻尼过，目标槽可能还装着
    // 旧像素 / 当前图的保底。只有这里能保证「进视口的确实是目标那一张」。
    const wanted = this.index + dir;
    const at = wanted >= 0 && wanted < this.items.length ? wanted : -1;
    const shown = at >= 0 ? at : clamp(this.index, 0, this.items.length - 1);
    if (target.__index !== at || target.__shown !== shown) this.fill(target, wanted);
    // `fill()` 是同步的，而 `preload()` 的 decode 在之后的微任务才把节点放进
    // 池里；早期实现没有回头再取一次，那一槽就一直挂着没画出来的 <img>。
    this.bindSlotPixels(target);

    for (const slot of this.slots) {
      const shift = slot === target
        ? -dir * this.seamMargin(slot, width) * (1 - progress)
        : 0;
      this.setSlotSeam(slot, shift);
    }
  }

  /**
   * 到首 / 末张的边界跟手：**轨道不动、越界槽不碰**，只让当前图弹性偏一点。
   *
   * 旧路径把 90px 阻尼写进轨道，还会由 `followWheelSeam()` 给越界槽（装着当前
   * 图副本，见 `fill()` 的保底）贴边 —— 从边缘进来的其实是同一张图，看着正是
   * 「末张进入下一张的过渡状态」。现在边界段只改当前槽两张 `<img>` 的 transform，
   * 流停下 `releaseWheelSeam(true)` 用 200ms / EASE_SOFT 弹回居中，就是一次自然
   * 的边界反弹；三个槽的内容、排版与轨道基准一个像素都不变。
   *
   * 回弹过程中再次起手时，上一段的 CSS transition 可能还在半路：先把它此刻的
   * 视觉位移接过来再叠加本段弹性量，接管那一帧才不会从半路跳到新值。只在
   * transition 还挂着时读一次 computed（`setSlotSeam` 随后把 transition 置回
   * none），不进逐事件热路径。
   *
   * @param {number} offset 本段弹性位移（px，负 = 朝「下一张」方向拉）
   */
  followWheelEdge(offset) {
    if (!this.isOpen || this.closing) return;
    const cur = this.currentSlot;
    if (!cur) return;
    let carry = 0;
    const low = cur.__low;
    if (low?.style.transition && low.style.transition !== 'none') {
      try {
        carry = new DOMMatrixReadOnly(getComputedStyle(low).transform).m41;
      } catch {
        carry = 0;
      }
    }
    const elastic = clamp(carry + offset, -WHEEL_EDGE_RUBBER, WHEEL_EDGE_RUBBER);
    for (const slot of this.slots) {
      // 只有当前槽带弹性量；越界槽与另一侧邻槽一律回到居中。setSlotSeam 的
      // 守卫在已经是 0 时直接返回，不会去掐别的槽正在跑的 transition。
      this.setSlotSeam(slot, slot === cur ? elastic : 0);
    }
    // 同一份弹性量顺手驱动边缘阴影：距离决定拉长多少、符号决定哪一侧。
    this.paintEdgeShade(elastic);
  }

  /** 居中排版下，槽位近边到图片近边的那段留白（px） */
  seamMargin(slot, width) {
    return Math.max(0, (width - (slot.__box?.w ?? width)) / 2);
  }

  /** 把贴边量写进槽里两张图；0 表示回到原来的居中形态 */
  setSlotSeam(slot, px) {
    if (!slot || slot.__seam === px) return;
    slot.__seam = px;
    const value = px ? `translate3d(${px}px, 0, 0)` : '';
    for (const img of [slot.__low, slot.__full]) {
      if (!img) continue;
      // 跟手期间必须即时生效：收尾留下的 transition 若还挂着，逐帧写入会
      // 变成一条永远追不上的缓动。
      img.style.transition = 'none';
      img.style.transform = value;
    }
  }

  /** 真正清空（换内容 / 关闭时用，连 transition 一起摘掉） */
  clearSlotSeam(slot) {
    if (!slot) return;
    slot.__seam = 0;
    for (const img of [slot.__low, slot.__full]) {
      if (!img) continue;
      img.style.transition = '';
      img.style.removeProperty('transform');
    }
  }

  /** 新换进来的 <img> 必须继承当前贴边量，否则换源那一帧会跳回居中 */
  paintSlotSeam(slot, img) {
    img.style.transform = slot.__seam
      ? `translate3d(${slot.__seam}px, 0, 0)`
      : '';
  }

  /**
   * 收尾：把贴边偏移与轨道收尾动画**同步**归零。
   * 补完最后一张走 `animateTrack`（wheelLandTiming），取消回弹走
   * `Gestures.animateTrackTo`；同一时刻起跑、同一条缓动，目标图从贴边平滑回到
   * 居中，结束态与键盘 / 按钮切图完全一致。
   *
   * 回弹的 timing 由 `wheelReboundTiming()` 算好后**返回**：`onWheelSettle` 的
   * 箭头函数把它原样交给 `reboundWheelSwipe()`，轨道 WAAPI 与这里的 CSS
   * transition 因此共用同一个对象，不会各算一份错开。
   */
  releaseWheelSeam(rebound, velocity = 0) {
    // 补完时贴边归零必须与轨道落位用**同一份**时长 / 缓动：目标图是「轨道位移
    // + 槽内贴边量」两条变换叠出来的，节奏错开就会在收尾里相对轨道漂移。
    const timing = rebound
      ? this.wheelReboundTiming(this.wheelReboundDistance(), velocity)
      : this.wheelLandTiming(this.wheelLandDistance(), velocity);
    const { duration, easing } = timing;
    for (const slot of this.slots) {
      if (!slot.__seam) continue;
      slot.__seam = 0;
      for (const img of [slot.__low, slot.__full]) {
        if (!img) continue;
        img.style.transition = `transform ${duration}ms ${easing}`;
        img.style.transform = '';
      }
    }
    // 阴影与当前图弹性量拿**同一个 timing 对象**：同一段时长、同一条缓动、
    // 同一时刻起跑，收尾末了不会「图回去了、阴影还挂在那儿」。
    this.releaseEdgeShade(timing);
    return timing;
  }

  /**
   * 补装「预热晚于 fill」的已解码节点：底图与原图都只在池命中时同帧换入，
   * 目标图因此不必等结算 / 动画阶段才显示。换的是整个节点，
   * `paintSlotSeam()` 会把当前贴边量带过去，换源当帧不跳。
   */
  bindSlotPixels(slot) {
    const item = this.items[slot.__shown];
    if (!item) return;
    const low = slot.__low;
    const lowUrl = thumbUrl(item.id);
    if (low?.parentNode && (low.__want !== lowUrl || !low.naturalWidth)) {
      this.adoptSlotImage(slot, '__low', lowUrl, 'slide-low');
    }
    const full = slot.__full;
    const fullSrc = fullUrl(item.id, maxEdgeFor(item));
    if (full?.parentNode && !full.naturalWidth) {
      if (this.adoptSlotImage(slot, '__full', fullSrc, 'slide-full')) {
        // 已解码节点不会再派发 load，这里直接定格，别等 CSS 的 0.32s 淡入
        slot.__full.style.opacity = '1';
        slot.classList.add('is-full');
      }
    }
  }

  /**
   * 建立「到头了」的边缘阴影层。
   *
   * 它是 `.viewer` 的直接子节点，排在 `.viewer-stage` 之后、`.viewer-chrome`
   * 之前：DOM 顺序保证它压在画面上、控件压在它上面，不需要再引入 z-index。
   * 上下沿用 stage 让出的 `--chrome-top` / `--strip-h`，阴影不会盖到标题栏或
   * 胶片条；`pointer-events: none` 让点击 / 双击 / 拖拽一律穿透。
   */
  createEdgeShade() {
    const node = document.createElement('div');
    node.className = 'viewer-edge-shade';
    const chrome = this.root.querySelector('.viewer-chrome');
    // chrome 缺席时（结构被替换 / 纯逻辑宿主）退化为追加，不影响功能。
    this.root.insertBefore(node, chrome || null);
    this.edgeShadeSide = null;
    this.edgeShadeActive = false;
    return node;
  }

  /**
   * 边界跟手的那一帧：阴影与当前图弹性量**同源、同号**。
   *
   * `elastic` 已夹在 `±WHEEL_EDGE_RUBBER` 内：绝对值决定 `scaleX()` 拉长多少
   * （0 → 1），符号决定从哪条边往里长 —— 负是内容被往左拉（想看下一张），
   * 阴影落在右边缘；正则落在左边缘。用 scaleX 而不是改 width，全程只动合成
   * 属性，不进逐事件热路径的布局。
   */
  paintEdgeShade(elastic) {
    const node = this.edgeShade;
    if (!node) return;
    const strength = clamp(Math.abs(elastic) / WHEEL_EDGE_RUBBER, 0, 1);
    const side = elastic < 0 ? 'right' : 'left';
    if (this.edgeShadeSide !== side) {
      node.classList.toggle('is-right', side === 'right');
      node.classList.toggle('is-left', side === 'left');
      this.edgeShadeSide = side;
    }
    // 跟手期禁掉缓动：否则逐帧写入会变成一条永远追不上的 transition。
    node.style.transition = 'none';
    node.style.transform = `scaleX(${strength.toFixed(4)})`;
    node.style.opacity = String(strength * WHEEL_EDGE_SHADE_ALPHA);
    this.edgeShadeActive = strength > 0;
  }

  /**
   * 流停下：把阴影用与贴边量**完全相同的时长 / 缓动**收回 0。
   * 只认 `releaseWheelSeam()` 传进来的那一个 timing 对象，不另算一份。
   */
  releaseEdgeShade(timing) {
    if (!this.edgeShadeActive || !this.edgeShade) return;
    const { duration, easing } = timing;
    const node = this.edgeShade;
    node.style.transition = `transform ${duration}ms ${easing}, opacity ${duration}ms ${easing}`;
    node.style.transform = 'scaleX(0)';
    node.style.opacity = '0';
    this.edgeShadeActive = false;
  }

  /** 换内容 / 关闭：连 transition 一起摘掉，别把阴影带到下一次开场 */
  clearEdgeShade() {
    const node = this.edgeShade;
    if (!node) return;
    node.style.transition = 'none';
    node.style.transform = 'scaleX(0)';
    node.style.opacity = '0';
    node.classList.remove('is-left', 'is-right');
    this.edgeShadeSide = null;
    this.edgeShadeActive = false;
  }

  /**
   * 一次 wheel 落位的时长与缓动：**从交接过来的跟手速度平滑收束到 0，恰好停在
   * 居中位置**。
   *
   * 旧实现固定 180ms + `EASE`（.22,1,.36,1）：那条曲线前 13% 时间走完约一半
   * 行程、最后 1/3 时间只挪约 1% —— 目标图在接近居中处「猛地停住」，再用近零
   * 速度慢慢爬完最后一点。跟手末速（长甩≈0 / 轻甩 0.06 px/ms）与落位首帧
   * （可达 28 px/ms）相差几百倍，就是这次要消掉的速度断层。这里改成：
   *
   * | 量 | 做法 |
   * | --- | --- |
   * | 时长 | `T = clamp(2·dist / v0, MIN_MS, WHEEL_LAND_MS)`：剩余距离越小收得越快，几 px 的余数不再铺满 180ms |
   * | 缓动 | `cubic-bezier(x1, y1, x2, 1)`，`y1 = x1 · v0·T/dist`。起点斜率 `y1/x1` 乘 `dist/T` 后**起点速度正好是 v0**；末控制点 y=1 让**终点速度恒为 0**。整段只有一次连续减速，没有快起、没有慢尾 |
   * | 初速 | `v0 = clamp(velocity, MIN_V, MAX_V)`，兜住「刚进视口时」的节奏，也挡住异常增量；时长被上下限夹住时再收到不过冲的上限 |
   *
   * 纯函数、不读布局：`releaseWheelSeam()` 与 `go()` 用同一份参数，轨道 WAAPI
   * 与槽内贴边量的 CSS transition 同一帧起跑、同一条曲线。
   */
  wheelLandTiming(dist, velocity) {
    const v0 = clamp(Math.abs(velocity) || 0, WHEEL_LAND_MIN_V, WHEEL_LAND_MAX_V);
    const d = Math.max(1, dist);
    const duration = clamp((2 * d) / v0, WHEEL_LAND_MIN_MS, WHEEL_LAND_MS);
    // 时长被下限 / 上限夹住后，v0·T/dist 可能超过 1/x1 —— 那需要 y1>1，曲线会
    // 越过居中再弹回。把初速收到不过冲的上限，作为**实际起点速度**交回去：
    // 宁可略慢一点，也不制造过冲或慢尾。正常长甩 / 轻甩下 T=2d/v0，斜率恒为 2
    // （标准匀减速），这个上限不会介入。
    const vStart = Math.min(v0, (d / duration) * (1 / WHEEL_LAND_X1));
    const slope = (vStart * duration) / d;
    const y1 = WHEEL_LAND_X1 * slope;
    const easing =
      `cubic-bezier(${WHEEL_LAND_X1.toFixed(3)}, ${y1.toFixed(3)}, ` +
      `${WHEEL_LAND_X2.toFixed(3)}, 1)`;
    return { duration, easing, velocity: vStart };
  }

  /**
   * 取消回弹的时长 / 缓动：**起点速度 = 这一段交接过来的跟手速度，终点 = 0**。
   *
   * 与 `wheelLandTiming()` 同一条 `cubic-bezier(x1, y1, x2, 1)` 曲线族，但两处
   * 刻意不同：
   *   * 时长固定 `WHEEL_SEAM_REBOUND_MS`（200ms）。落位要补完「不足一屏的余数」，
   *     时长随距离收缩；回弹只收回几十 px，保持原刻度才不动快滑观感。
   *   * 初速地板取 `WHEEL_REBOUND_MIN_V`（0.08），不套用落位的 1.4 —— 慢滑的
   *     真实末速就在这里，抬到 1.4 会把 y1 顶回 1，等于没改。
   *
   * `y1 >= 0.999`（边界弹性量很小 / 速度偏高）时直接返回原 `EASE_SOFT` 字符串：
   * 那条路径的复位观感逐字不变。纯函数、不读布局。
   */
  wheelReboundTiming(dist, velocity) {
    const duration = WHEEL_SEAM_REBOUND_MS;
    const d = Math.max(1, dist);
    const v0 = clamp(Math.abs(velocity) || 0, WHEEL_REBOUND_MIN_V, WHEEL_LAND_MAX_V);
    // 与落位同样的「不过冲」夹取：y1 不许越过 1。
    const vStart = Math.min(v0, (d / duration) * (1 / WHEEL_LAND_X1));
    const y1 = WHEEL_LAND_X1 * ((vStart * duration) / d);
    if (y1 >= 0.999) {
      return { duration, easing: WHEEL_SEAM_SOFT_EASE, velocity: vStart };
    }
    const easing =
      `cubic-bezier(${WHEEL_LAND_X1.toFixed(3)}, ${y1.toFixed(3)}, ` +
      `${WHEEL_LAND_X2.toFixed(3)}, 1)`;
    return { duration, easing, velocity: vStart };
  }

  /**
   * 回弹要收回的显示位移。边界段 `swipeX` 恒 0（弹性量走当前槽的 `<img>`，
   * 轨道没动），退化成 1 让 `y1` 自动顶到 1、保持原来的边界回弹曲线。
   */
  wheelReboundDistance() {
    return Math.max(1, Math.abs(this.g?.swipeX ?? 0));
  }

  /**
   * 落位还差多少 px 到居中（`go()` 里 `dist` 的同一份量）。
   *
   * 轨道基准是中间槽，目标槽还差 `一屏 - |跟手位移|`；`wheelFollowOffset()`
   * 把显示位移压在不足一屏内，所以恒为正。`releaseWheelSeam()` 在 `go()` 之前
   * 调用，此时 `g.swipeX` 还没被清零，读它即可，不必预先算一遍动画参数。
   */
  wheelLandDistance() {
    return Math.max(1, this.slotWidth() - Math.abs(this.g?.swipeX ?? 0));
  }

  /**
   * @param {number} delta +1 下一张 / -1 上一张
   * @param {object} [opts]
   * @param {boolean} [opts.fromSwipe] 由手指横滑触发 —— 从手指当前位置接着播
   * @param {number} [opts.velocity] wheel 结算交接过来的跟手速度（px/ms），落位
   *   动画拿它当起点速度，见 `wheelLandTiming()`。其他入口不传。
   * @param {boolean} [opts.fromWheel] 由触控板 wheel 流结束吸附触发。整段流用的是
   *   **同一个** Gestures 实例（轴向 / 累计 / 结算定时器都挂在它身上），重建实例
   *   会拆掉监听器、把关掉的 enabled 留到动画结束 —— 紧跟着的下一段横滑要么被吞、
   *   要么等重试，就是「松手之后发木」。这条路径只 retarget、不碰闸门。
   */
  async go(delta, { fromSwipe = false, fromWheel = false, velocity = 0 } = {}) {
    const step = delta > 0 ? 1 : -1;
    if (!this.isOpen || this.switching || this.closing) return;

    // 键盘 / 按钮 / 单指拖拽可能在一段 wheel 流没结算完时插进来：那一格带着
    // 贴边量，被 rebalance 轮成当前张就会歪着居中。wheel 自己的收尾走
    // releaseWheelSeam()（与动画同步归零），这里只兜住非 wheel 的打断。
    if (!fromWheel) {
      for (const slot of this.slots) this.clearSlotSeam(slot);
      // 键盘 / 按钮 / 单指打断一段还没结算的边界流：阴影也要一起硬清掉。
      this.clearEdgeShade();
    }

    const target = this.index + step;
    if (target < 0 || target >= this.items.length) {
      // 只有两张以上才有「转到另一头」的意义，否则就是原地打转
      if (!this.loop || this.items.length < 2) {
        // 到头了，给一个轻微的横向回弹，比无反应友好
        this.nudgeAtEdge(step);
        return;
      }
      // 循环：跨过首尾用淡入，别让轨道飞过整条画廊。
      // 必须把 promise 交出去，否则调用方（键盘、按钮）无法知道何时切完。
      return this.jumpTo((target + this.items.length) % this.items.length);
    }

    // 槽位理论上恒为 1（每次切完都 rebalance），万一对不上就先归位
    if (this.slotIndex !== 1) this.rebalance();

    this.switching = true;
    const gen = ++this.switchGen;

    // 手指已经拖出去的那段位移，动画要从这里接着走
    const carried = fromSwipe ? this.g?.swipeX ?? 0 : 0;
    if (this.g) this.g.swipeX = 0;

    // 放大状态下切走：先把旧图收回适配尺寸，否则它会以放大姿态留在邻槽
    if (this.g?.isZoomed) this.g.reset(false);

    const targetSlot = this.slotIndex + step;
    const width = this.slotWidth();
    const fromX = this.trackOffset + carried;
    const toX = -targetSlot * width;

    this.slotIndex = targetSlot;
    this.index = target;
    this.box = this.slots[targetSlot].__box ?? this.box;

    // 立刻起拉原图：动画只动 transform，跑在合成器线程上，解码抢不走它的帧
    this.startFullLoad();

    this.updateInfo();
    this.strip.focus(target);
    if (fromWheel) {
      // 不重建手势、不关 enabled：同一个实例接着处理紧随其后的下一段 wheel。
      // 只把变换目标换到新的当前槽（那一格稍后由 rebalance 轮到中间）。
      this.g?.retarget(this.currentSlot);
    } else {
      this.attachGestures();
      if (this.g) this.g.enabled = false;
    }
    this.bumpChrome();

    // 收尾动画只补完剩下的那段距离 —— 跟手已经推掉大半时，固定 300ms 会让
    // 「手指早就到那儿了、画面还在慢慢挪」的拖沓感非常明显。
    // 键盘 / 按钮（carried = 0）的剩余距离恒为一屏，因此仍是完整的 SWITCH_MS。
    // wheel 落位：时长随剩余距离收缩、缓动从交接过来的跟手速度平滑收束到 0
    // （见 wheelLandTiming），不再固定 180ms / EASE 那条「快起 + 近零速度慢尾」。
    // 键盘 / 按钮 / 单指拖拽的时长与缓动一行未动。
    const dist = Math.abs(toX - fromX);
    const landing = fromWheel ? this.wheelLandTiming(dist, velocity) : null;
    const duration = fromWheel
      ? landing.duration
      : fromSwipe
        ? clamp((SWITCH_MS * dist) / Math.max(1, width), SWITCH_EXIT_MIN_MS, SWITCH_MS)
        : SWITCH_MS;

    await this.animateTrack(fromX, toX, duration, landing?.easing ?? EASE);
    // 这一格已经被手势接管（`claimTrack` 就地落位并把 switching 放回 false），
    // 或者又开了新的一次切换 —— 都不要再动，否则会把新实例的闸门提前放开
    if (gen !== this.switchGen) return;
    // DOM 轮转一格 + 基准偏移同步改回中间槽 —— 两者同一帧生效，画面不动
    this.rebalance();
    this.preloadNeighbors();
    if (!fromWheel && this.g) this.g.enabled = true;
    this.switching = false;
  }

  /** 从胶片条直接跳到某一张（可能隔得很远，用淡入而不是长距离滑动） */
  async jumpTo(index) {
    if (!this.isOpen || this.switching || this.closing) return;
    const target = clamp(index, 0, this.items.length - 1);
    if (target === this.index) {
      // index 没变不等于画面没错：预览已经开着时后端可以送来**另一份图片集合**
      // （跨窗口会话中转）。三槽还画着上一份 items 的 id，直接返回就停在旧图上。
      // 只在这种确实不一致时强制重画，正常跳转不做无谓的换源。
      const item = this.items[target] ?? null;
      const want = item ? thumbUrl(item.id) : '';
      if (this.currentSlot?.__low?.__want !== want) {
        for (const slot of this.slots) {
          slot.__index = -2;
          slot.__shown = -2;
        }
        const view = this.view();
        this.fill(this.slots[0], target - 1, view);
        this.fill(this.slots[1], target, view);
        this.fill(this.slots[2], target + 1, view);
        this.startFullLoad();
        this.updateInfo();
        this.strip.focus(target, { immediate: true });
      }
      return;
    }
    if (Math.abs(target - this.index) === 1) {
      this.go(target - this.index);
      return;
    }

    this.switching = true;
    const gen = ++this.switchGen;
    if (this.g?.isZoomed) this.g.reset(false);
    if (this.g) this.g.swipeX = 0;

    this.index = target;
    this.slotIndex = 1;
    this.fill(this.slots[1], target);
    this.box = this.slots[1].__box ?? this.box;

    const slide = this.slots[1];
    // WAAPI 提交纪律（与 animateTrack 同一套）：起点写进 inline，动画用
    // fill:'forwards' 让它全程（含 finished 那一帧）负责终值，只在动画真正
    // 落地时把终值交回基础样式再 cancel。
    //
    // 旧写法是「inline 写 0 + fill:'none'」且从不提交：动画一结束元素就回到
    // inline 的 0，当前槽**永久全透明**。胶片条跳到隔很远的一张、循环跨首尾、
    // 或跨窗口换会话之后预览区一片空白；更糟的是后续 go() 的 rebalance() 只
    // 填轮转出去的那个槽，不会碰当前槽，这个 0 会一直残留到下一次 fill()，
    // 于是连续切换也张张空白 —— 正是「切换后不显示目标图片」。
    slide.style.opacity = '0';
    const fade = slide.animate(
      { opacity: [0, 1] },
      { duration: JUMP_MS, easing: TWEEN_FADE_EASE, fill: 'forwards' }
    );
    // 提交独立于 switching 的等待：动画真结束（或帧停摆时按预算兜底）就把
    // inline 交回可见状态。提交的是终值「不透明」，与世代号无关 —— 即使这
    // 期间被新的切换接管，也不能跳过，否则残留的 0 会带到后续每一次换页。
    withTimeout(fade.finished.catch(() => {}), JUMP_MS + ANIM_SLACK_MS)
      .then(() => {
        slide.style.removeProperty('opacity');
        fade.cancel();
      })
      .catch(() => {});

    this.trackOffset = -this.slotWidth();
    this.track.style.transform = `translate3d(${this.trackOffset}px, 0, 0)`;

    // 邻槽等淡入结束再填，避免同一帧里三张图一起解码
    this.fill(this.slots[0], target - 1);
    this.fill(this.slots[2], target + 1);

    this.startFullLoad();
    this.updateInfo();
    this.strip.focus(target, { immediate: true });
    this.attachGestures();
    this.bumpChrome();

    await new Promise((resolve) => setTimeout(resolve, JUMP_MS));
    if (gen !== this.switchGen) return;
    this.rebalance();
    this.preloadNeighbors();
    this.switching = false;
  }

  /**
   * 把正在跑的轨道切换动画就地结束，交给手势接管。
   *
   * 为什么必须接管：切换的收尾动画跑在 `track` 上（WAAPI 关键帧），而关键帧的
   * 优先级**高于内联样式**。动画没播完时手势写进 `track.style.transform` 的
   * 那笔位移是完全看不见的 —— 要等动画结束才突然生效。连续快切时用户几乎总是
   * 在上一次的收尾里再次起手，于是每一段跟手都被吞掉，观感就是「连续切了几张
   * 之后就不跟手、按下去要等一下才动」。
   *
   * 接管做三件事：
   *   1. 读当前**视觉**位移（computed transform），取消动画 —— 视觉上停在原地；
   *   2. 让这一格立即完成轮转（`rebalance`），基准回到中间槽 —— 否则槽位与
   *      偏移对不上，后续 `go()` 会跳；
   *   3. 把 `switching` / `enabled` 立刻放开 —— 新手势不必再等一次动画才结算。
   *
   * 返回的偏移交给手势当作「已经推到哪儿了」，它与随后的第一笔 `applyTrack`
   * 相加正好等于刚才的视觉位置，所以接管那一帧不会跳。
   *
   * @returns {number|null} 相对中间槽基准的偏移；没有动画在跑时 null
   */
  claimTrack() {
    const anim = this.trackAnim;
    if (!anim || anim.playState !== 'running') return null;

    // 动画的视觉当前位置。这一步会强制一次样式计算，但一段手势只发生一次，
    // 且只在「上一次切换还没播完」时才会走到这里。
    let visual = this.trackOffset;
    try {
      visual = new DOMMatrixReadOnly(getComputedStyle(this.track).transform).m41;
    } catch {
      /* 解析不出来就退回代码里的终值 */
    }

    anim.cancel();
    this.trackAnim = null;

    this.switching = false;
    this.rebalance();
    this.trackOffset = -this.slotWidth();
    this.track.style.transform = `translate3d(${this.trackOffset}px, 0, 0)`;
    if (this.g) this.g.enabled = true;

    return visual - this.trackOffset;
  }

  /**
   * 轨道位移：**起点**先落地，动画 `fill:'forwards'`，终点在 finished 里提交。
   *
   * 以前是把**终点**写进 inline style、动画 `fill:'none'` 靠关键帧盖住起点：
   * 为了保证「收尾不闪回」，代价是 WAAPI 关键帧要等下一帧才采样，中间那一帧
   * 显示的是 inline 的终点 —— 于是每次收尾都先「闪到终点、再弹回起点」，
   * 正是「顿挫 / 跳变 / 闪烁」。改成起点落地之后，起点帧与终点帧都不跳；
   * `forwards` 让动画期间由关键帧接管，跑完把终值提交到 inline 再 cancel，
   * 收尾同样不闪回。
   *
   * 被 `claimTrack()` 取消时它已经把轨道落到新基准、并把 `trackAnim` 清空，
   * 所以这里只在「仍是我这一次」时才提交终值 —— 否则会把刚接管的画面又拽回
   * 终点，那是一次位置跳变。
   */
  animateTrack(fromX, toX, duration, easing = EASE) {
    const from = `translate3d(${fromX}px, 0, 0)`;
    const to = `translate3d(${toX}px, 0, 0)`;

    this.trackOffset = toX;
    this.track.style.transform = from;

    if (duration <= 0 || from === to) {
      this.track.style.transform = to;
      return Promise.resolve();
    }

    const anim = this.track.animate(
      { transform: [from, to] },
      { duration, easing, fill: 'forwards' }
    );
    this.trackAnim = anim;
    return anim.finished
      .then(() => {
        if (this.trackAnim !== anim) return;
        this.track.style.transform = to;
        try {
          anim.cancel();
        } catch {
          /* 已结束的动画忽略 */
        }
        this.trackAnim = null;
      })
      .catch(() => {
        if (this.trackAnim === anim) this.trackAnim = null;
      });
  }

  /**
   * 轮转 DOM 顺序，让当前槽回到中间。
   * 关键：只有被挪到视口外的那个槽需要换内容，正在看的那张纹丝不动。
   *
   * @param {object} [opts]
   * @param {?object} [opts.view] 调用方量好的视口。单步换页时传入，可避开
   *   「appendChild / insertBefore 改了 DOM 结构 → 再读 clientWidth」的强制重排。
   * @param {boolean} [opts.skipTransform] 为 true 时不写静止基准那条 transform。
   *   单步换页专用：紧跟着的 `Gestures.applyTrack()` 会在同一任务里写回
   *   「基准 + 剩余位移」，两条写入之间不会渲染，中间这条纯属多余。
   */
  rebalance({ view = null, skipTransform = false } = {}) {
    if (this.slotIndex === 1) return;

    // 一次量好：下面要改 DOM 结构（会脏布局），之后再读 clientWidth 就是一次
    // 同步重排。单步换页时 view 由 advanceBy 传入，这里完全不碰布局。
    const v = view ?? this.view();
    const [a, b, c] = this.slots;
    if (this.slotIndex === 2) {
      // [a,b,c] → [b,c,a]：a 挪到末尾，改填「新的下一张」
      this.track.appendChild(a);
      this.slots = [b, c, a];
      this.fill(a, this.index + 1, v);
    } else {
      // [a,b,c] → [c,a,b]：c 挪到最前，改填「新的上一张」
      this.track.insertBefore(c, a);
      this.slots = [c, a, b];
      this.fill(c, this.index - 1, v);
    }

    this.slotIndex = 1;
    this.trackOffset = -v.w;
    if (!skipTransform) {
      this.track.style.transform = `translate3d(${this.trackOffset}px, 0, 0)`;
    }
  }

  /** 到首尾时给一下回弹，告诉用户「没有了」 */
  nudgeAtEdge(direction) {
    const base = this.trackOffset;
    const to = base - direction * NUDGE_PX;
    this.animateTrack(base, to, 120).then(() => {
      // 回弹途中可能刚好改了窗口尺寸，基准偏移已被重算过 —— 那就别再拉回去
      if (this.trackOffset !== to) return;
      this.animateTrack(to, base, 240);
    });
  }

  /* ------------------------------------------------------------------ *
   * 槽位内容
   * ------------------------------------------------------------------ */

  createSlide() {
    const slide = document.createElement('div');
    slide.className = 'slide';
    slide.__index = -1;
    slide.__shown = -1;
    slide.__swapGen = 0;
    slide.__seam = 0;
    slide.__box = { w: 0, h: 0 };

    const low = document.createElement('img');
    low.className = 'slide-low';
    low.decoding = 'async';
    low.draggable = false;
    low.alt = '';

    const full = document.createElement('img');
    full.className = 'slide-full';
    full.decoding = 'async';
    full.draggable = false;

    const error = document.createElement('div');
    error.className = 'slide-error';
    error.innerHTML =
      '<span class="slide-error-text">无法加载此图片</span>' +
      '<button type="button" class="slide-retry">重试</button>';

    low.addEventListener('error', () => {
      if (isRealFailure(low)) slide.classList.add('is-low-failed');
    });
    full.addEventListener('load', () => {
      slide.classList.add('is-full');
      slide.classList.remove('is-failed');
    });
    full.addEventListener('error', () => {
      if (isRealFailure(full)) slide.classList.add('is-failed');
    });
    error.querySelector('.slide-retry').addEventListener('click', (event) => {
      event.stopPropagation();
      this.retry(slide);
    });
    // 别让「点图片外关闭」把重试按钮的点击吞掉
    error.addEventListener('pointerdown', (event) => event.stopPropagation());

    slide.append(low, full, error);
    slide.__low = low;
    slide.__full = full;
    return slide;
  }

  /**
   * 把某张图装进某个槽。
   *
   * **槽位永不空白**：跟手期间画面里真正画着的是底图（`thumbUrl`），所以
   * `fill()` 绝不原地给底图设新 src —— 那会先把旧像素抹掉，再等一次
   * `img://` 请求 + 解码，恰好在「目标图该从边缘进视口」的那一两帧露成背景。
   * 改为 `swapSlotImage()` 原子换源：池里有已解码节点就同帧替换；没有就
   * **旧像素原样留着继续画**，后台把新图解码好再一次 `replaceWith`。
   *
   * 越界槽同样不清空：首尾阻尼会把这一小条拉进视口，清空就等于主动露出
   * 背景占位。用当前图的缩略图填一份「延伸」，阻尼的方向、幅度、手感都不变，
   * 只是不再有空白。
   *
   * 原图仍只走「池里已有就同帧换入」这条快速路径：跟手期间刻意不逐张拉原图，
   * 也不在滑动中途异步补入（清晰度突变本身就是一次跳变），流结束由
   * `onWheelRest` → `startFullLoad()` 补给当前那一张。
   *
   * @param {?object} view 由调用方量好的视口；一次量好往下传，
   *   免得每个槽都读一次 clientWidth（前面刚改过 DOM 顺序、又写过 transform，
   *   那就是强制重排）。空槽直接返回，连这一次都不量。
   * @returns {Promise<void>} 底图像素落地（`open()` 拿它当「手势可开放」的前提）
   */
  fill(slot, itemIndex, view = null) {
    if (!slot) return Promise.resolve();
    // `__index` 记逻辑上的第几张（-1 = 越界），`__shown` 记槽里实际画着哪张：
    // 停在首尾但换过当前图时，保底图也要跟着换，不能靠 __index 提前返回。
    const at = itemIndex >= 0 && itemIndex < this.items.length ? itemIndex : -1;
    const shown = at >= 0 ? at : clamp(this.index, 0, this.items.length - 1);
    // 可见性兜底必须排在「内容没变就提前返回」**之前**：jumpTo() 的淡入过去会
    // 把 inline opacity 留在 0，而下面那个提前返回恰好会跳过清理。于是再次
    // 点击打开预览、或换页轮转到这一格时，槽里明明有像素却是全透明的 ——
    // 「预览失败 / 空白」看起来就像图没加载出来。清的是 inline 残留，不碰
    // WAAPI（动画自身仍由 finished 提交），因此不会打断正在播的淡入。
    slot.style.removeProperty('opacity');
    if (slot.__index === at && slot.__shown === shown) return Promise.resolve();
    slot.__index = at;
    slot.__shown = shown;
    // 换内容的槽必须回到居中：它可能正带着上一段 wheel 的贴边量（轮转出去
    // 的那一格就是这么来的），留着会让新图在视口边缘歪一格。
    this.clearSlotSeam(slot);

    slot.classList.remove('is-full', 'is-failed', 'is-low-failed', 'is-zoomed', 'is-grabbing');
    slot.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
    // 槽的 inline opacity 已在提前返回之前统一清过，这里只补原图层：上一次
    // 可能换进来一张带着 inline opacity:1 的已解码原图。
    slot.__full.style.removeProperty('opacity');

    const item = this.items[shown] ?? null;
    if (!item) {
      slot.__box = { w: 0, h: 0 };
      setSrc(slot.__low, '');
      setSrc(slot.__full, '');
      slot.style.removeProperty('--w');
      slot.style.removeProperty('--h');
      return Promise.resolve();
    }

    // 按需才量：单步换页时由 advanceBy 量好一次传下来。
    const v = view ?? this.view();
    this.refitSlot(slot, item, v);

    const lowReady = this.swapSlotImage(slot, '__low', thumbUrl(item.id), 'slide-low');

    const fullSrc = fullUrl(item.id, maxEdgeFor(item));
    if (this.adoptSlotImage(slot, '__full', fullSrc, 'slide-full')) {
      // 已解码 → 直接定格，别让 CSS 的 0.32s 淡入在连续几次横滑里一张张淡出来
      slot.__full.style.opacity = '1';
      slot.classList.add('is-full');
    } else {
      setSrc(slot.__full, '');
    }
    slot.__full.alt = item.name ?? '';
    return lowReady;
  }

  /**
   * 槽位底图换源：**旧像素在替换前一直留在画面里**。
   *
   * 三条路径，按「有没有可能露空白」排序：
   *   1. 已经装着这张且画得出来 → 什么都不做；
   *   2. 池里有已解码节点 → `adoptSlotImage()` 同帧 `replaceWith`；
   *   3. 槽里还没有任何像素（刚开场 / 刚清空）→ 直接设 src，此时没有旧像素
   *      可抹掉，`load` 事件照旧驱动焦点交接；
   *   4. 槽里已有像素但新图还没解码好 → **保留旧节点**，用 `decodedImage()`
   *      备好一个独立且已解码的节点，再原子替换。全程没有一帧是空的。
   *
   * `__swapGen` 是快速连滑的世代号：一次 `advanceBy` 会连着填好几个槽，
   * 后发先至的异步解码不能把已经换好的新图又覆盖回旧图。
   *
   * @returns {Promise<void>} 这张底图落地（失败也兑现 —— 调用方保留旧像素）
   */
  swapSlotImage(slot, key, url, className) {
    const old = slot[key];
    if (!old) return Promise.resolve();
    if (old.__want === url && old.naturalWidth > 0) return Promise.resolve();
    if (this.adoptSlotImage(slot, key, url, className)) return Promise.resolve();

    if (!old.naturalWidth) {
      // 只等这一个节点的 load/error：槽里的原图层每次 fill 都会被清 src，
      // 那也会派发 error，等「整个槽任一图」会让开场门槛提前放行。
      setSrc(old, url);
      return imageLoaded(old);
    }

    const token = (slot.__swapGen = (slot.__swapGen || 0) + 1);
    return decodedImage(url).then((img) => {
      if (!img) return;
      if (slot.__swapGen !== token || slot[key] !== old || !old.parentNode) return;
      this.installSlotImage(slot, key, old, img, url, className);
    });
  }

  /** 把一个已解码、未挂载的节点装进槽（替换是同帧原子操作） */
  installSlotImage(slot, key, old, img, url, className) {
    img.className = className;
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    img.__want = url;
    if (key === '__low') {
      img.addEventListener('error', () => {
        if (isRealFailure(img)) slot.classList.add('is-low-failed');
      });
    }
    this.paintSlotSeam(slot, img);
    old.replaceWith(img);
    slot[key] = img;
  }

  /**
   * 把预取池里**已解码**的 <img> 直接替换进槽。
   * @returns {boolean} false = 池里没有，调用方退回 setSrc
   */
  adoptSlotImage(slot, key, url, className) {
    const old = slot[key];
    // 先确认槽里的节点还挂在 DOM 上，再去池里取：takeDecoded 是「取走即出池」，
    // 若这一步失败而 ready 已经被拿走，那张预热好的节点就白白丢了，调用方
    // 只能退回 setSrc 重新解码。
    if (!old?.parentNode) return false;
    const ready = takeDecoded(url);
    if (!ready) return false;

    ready.className = className;
    ready.decoding = 'async';
    ready.draggable = false;
    ready.alt = '';
    ready.__want = url;
    if (key === '__low') {
      ready.addEventListener('error', () => {
        if (isRealFailure(ready)) slot.classList.add('is-low-failed');
      });
    } else {
      ready.addEventListener('load', () => {
        slot.classList.add('is-full');
        slot.classList.remove('is-failed');
      });
      ready.addEventListener('error', () => {
        if (isRealFailure(ready)) slot.classList.add('is-failed');
      });
    }
    this.paintSlotSeam(slot, ready);
    old.replaceWith(ready);
    slot[key] = ready;
    return true;
  }

  /**
   * 按可视区重新算槽位的适配尺寸，写进 `--w/--h`。
   * 两张图（底图 / 原图）共用同一组尺寸，`object-fit: contain` 保证等比，
   * 于是任何窗口尺寸下都不会被拉伸或裁切。
   */
  refitSlot(slot, item, view) {
    const box = fitBox(item.width, item.height, view.w, view.h);
    slot.__box = box;
    slot.style.setProperty('--w', `${box.w}px`);
    slot.style.setProperty('--h', `${box.h}px`);
    return box;
  }

  retry(slot) {
    const item = this.items[slot.__index];
    if (!item) return;
    slot.classList.remove('is-failed', 'is-low-failed');
    setSrc(slot.__low, thumbUrl(item.id));
    if (slot === this.currentSlot) {
      setSrc(slot.__full, fullUrl(item.id, maxEdgeFor(item)));
    }
  }

  /**
   * 槽位回收：预览关闭时把内容清空，下次 fill 再填。
   *
   * 不走 `fill(slot, -1)` —— 那如今是「越界保底」，会画上当前图；这里要的是
   * 真的空槽，否则下一次开场第一帧会闪出上一场预览的图片。
   */
  resetSlots() {
    for (const slot of this.slots) {
      slot.__index = -2; // 强制下次 fill 重新执行
      slot.__shown = -2;
      slot.__swapGen = (slot.__swapGen || 0) + 1; // 作废还在路上的异步换源
      slot.__box = { w: 0, h: 0 };
      this.clearSlotSeam(slot); // 关闭时归位，别把贴边量带到下一次开场
      slot.classList.remove('is-full', 'is-failed', 'is-low-failed', 'is-zoomed', 'is-grabbing');
      slot.__full.style.removeProperty('opacity');
      setSrc(slot.__low, '');
      setSrc(slot.__full, '');
      slot.style.removeProperty('--w');
      slot.style.removeProperty('--h');
      slot.style.removeProperty('transform');
      slot.style.removeProperty('opacity');
    }
    // 关闭时归位，别把边界阴影与它还在跑的 transition 带到下一次开场。
    this.clearEdgeShade();
  }

  /* ------------------------------------------------------------------ *
   * 缩放
   * ------------------------------------------------------------------ */

  /** 相对「原始像素」的最大倍率：最多放到原图 1.5 倍，且不小于 4 倍适配尺寸 */
  maxScale() {
    const item = this.currentItem;
    if (!item?.width || !this.box?.w) return 8;
    const native = item.width / this.box.w;
    return clamp(Math.max(4, native * 1.5), 4, 32);
  }

  zoomBy(factor) {
    const g = this.g;
    if (!g) return;
    g.zoomTo(g.scale * factor, { x: 0, y: 0 }, true);
    this.bumpChrome();
  }

  fit() {
    this.g?.reset(true);
    this.bumpChrome();
  }

  toggleZoom(x, y) {
    const g = this.g;
    if (!g) return;
    if (g.isZoomed) {
      g.reset(true);
      return;
    }
    const view = this.view();
    g.zoomTo(Math.min(g.o.maxScale, DOUBLE_TAP_SCALE), {
      x: x - view.w / 2,
      y: y - view.h / 2
    }, true);
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  attachGestures() {
    const previous = this.g;
    this.g?.detach();
    // 实例重建 = 这一格已经落位、轨道基准回到中间槽：接管偏移属于**旧基准**，
    // 带过去会让下一次跟手整整错开一屏（键盘切换时尤其明显，那条路上没人清它）
    if (previous?.wheelSwipe) previous.wheelSwipe.base = null;
    this.g = new Gestures(this.currentSlot, {
      track: this.track,
      trackBase: () => this.trackOffset,
      // 收尾动画归 viewer 管，手势够不到它的句柄 —— 交给它「就地结束并接上」
      claimTrack: () => this.claimTrack(),
      // 每次切换都会重建 Gestures，但「一次触控板横滑」是跨实例连续的物理
      // 手势 —— 轴向、视口宽与本段累计 / 结算闸门必须交接过去，否则实例一换
      // 就重新攒 10px 判一次轴，起手又要慢半拍。wheel 自己的结算走
      // `go({ fromWheel: true })` 不重建实例，这里服务键盘 / 按钮 / 单指那条路。
      wheelState: previous?.wheelSwipe,
      base: () => this.box,
      view: () => this.view(),
      maxScale: this.maxScale(),
      canSwipe: (direction) => {
        if (this.items.length < 2) return false;
        const next = this.index + direction;
        return this.loop || (next >= 0 && next < this.items.length);
      },
      onChange: (g) => {
        const slot = this.currentSlot;
        if (!slot) return;
        slot.classList.toggle('is-zoomed', g.isZoomed);
        slot.classList.toggle('is-grabbing', Boolean(g.dragging) && g.mode === 'pan');
        this.updateZoomLabel();
      },
      onDismissProgress: (progress) => {
        // 下拉越远背景越透，形成「把图片摘下来」的感觉
        this.setBackdrop(1 - progress * 0.92);
      },
      onDismissRelease: (shouldClose) => {
        if (shouldClose) {
          this.close({ fromDismiss: true });
        } else {
          this.fadeBackdrop(1, 220);
          this.g?.springBack();
        }
      },
      onSwipeRelease: (direction) => {
        this.go(direction, { fromSwipe: true });
      },
      // 触控板横滑的边界：只认「相邻的一张还在列表里」，**不看循环开关**。
      // 首张继续往左 / 末张继续往右时轨道一格都不动、越界槽不画，只由
      // onWheelEdge 让当前图轻轻一弹（见 followWheelEdge）；索引不动、不循环。
      // fill() 的越界保底仍留给键盘 / 按钮到头的 nudge —— 那条路会短暂挪轨道。
      onWheelCanStep: (direction) => {
        const next = this.index + direction;
        return this.items.length > 1 && next >= 0 && next < this.items.length;
      },
      // 整段 wheel 流的唯一结算点：与单指松手共用 `fromSwipe`（从当前跟手位置
      // 接着把位移播完），额外标 `fromWheel` —— 走不重建手势、不落闸、固定
      // WHEEL_LAND_MS 的轻量收尾。命中只切相邻一张；这里不再注册
      // `onWheelAdvance`，wheel 路径上不存在逐屏换页的入口。
      onWheelSwipe: (direction, opts = {}) => {
        this.go(direction, { fromSwipe: true, fromWheel: true, ...opts });
      },
      // 一段流结算完：补给当前这张的原图与邻图
      onWheelRest: () => {
        this.startFullLoad();
        this.preloadNeighbors();
      },
      // 跟手一开始就把目标那张的原图取回来解码：切过去的第一帧不必等解码
      onSwipeIntent: (direction) => this.prefetchNeighbor(direction),
      // 每个跟手事件：写轨道 transform 之前，先把目标图贴到对应侧边缘
      onWheelFollow: (swipeX, viewW) => this.followWheelSeam(swipeX, viewW),
      // 到首 / 末张：与 onWheelFollow 互斥，轨道 / 越界槽都不碰，只弹当前图
      onWheelEdge: (offset) => this.followWheelEdge(offset),
      // 流结束：贴边量与收尾 / 回弹动画同步归零。补完把同一份跟手速度交给
      // wheelLandTiming()（与 go() 完全相同）；回弹由 wheelReboundTiming() 从
      // 交接速度算出低速曲线，并作为返回值原样交给 reboundWheelSwipe()，
      // 轨道 WAAPI 与这里的 CSS transition 共用同一个 timing 对象。
      onWheelSettle: (rebound, velocity) => this.releaseWheelSeam(rebound, velocity),
      onTap: (x, y) => this.onTap(x, y),
      onDoubleTap: (x, y) => this.toggleZoom(x, y),
      onUserActivity: () => this.bumpChrome()
    });
  }

  /**
   * 原生 wheel 相位（macOS AppKit 本地监视器经 Tauri 事件送到 viewer）。
   *
   * 它只回答「这一段手势什么时候开始 / 结束」，是结算时机与 `settled` 闸门
   * 复位的依据；翻页的方向、位移、速度、触发判定仍全部来自 Web `wheel`，
   * `go()` / 贴边 / 落位 / 边界回弹一条都不经过这里。没有原生相位事件时
   * （`PICSHOW_WHEEL_PHASE=0` 显式关闭、非 macOS、IPC 缺失或被三重过滤挡掉）
   * 这个方法永远不会被调用，65ms 静默仍是唯一的结算判据 —— 兜底不能因为
   * 默认开启就消失。
   *
   * @param {'begin'|'end'} kind 由 `wheel-phase.js` 归一化后的两类语义
   */
  handleWheelPhase(kind) {
    const g = this.g;
    if (!g) return;
    if (kind === 'begin') g.onWheelPhaseBegin();
    else if (kind === 'end') g.onWheelPhaseEnd();
  }

  /**
   * 点击：落在图片上 → 切换控件显隐；落在图片外的黑边上 → 关闭。
   * 槽位现在是铺满视口的（要接住滑动手势），所以「点空白关闭」只能靠算。
   */
  onTap(x, y) {
    if (this.isInsideImage(x, y)) {
      this.bumpChrome();
      return;
    }
    this.close();
  }

  isInsideImage(x, y) {
    const g = this.g;
    const view = this.view();
    if (!g) return true;
    const cx = view.left + view.w / 2 + g.tx;
    const cy = view.top + view.h / 2 + g.ty;
    const halfW = (this.box.w * g.scale) / 2;
    const halfH = (this.box.h * g.scale) / 2;
    return Math.abs(x - cx) <= halfW && Math.abs(y - cy) <= halfH;
  }

  startFullLoad() {
    const item = this.currentItem;
    const slot = this.currentSlot;
    if (!item || !slot) return;
    const src = fullUrl(item.id, maxEdgeFor(item));
    if (slot.__full.__want !== src) setSrc(slot.__full, src);
  }

  /**
   * 横滑方向一确定就把目标那张（以及沿方向的后续几张）取回来解码。
   *
   * `preloadNeighbors()` 只在静止期备前后各一张；连着滑好几下时目标那张可能
   * 还在路上，`count` 因此取 `PREFETCH_RUN`，让供给跟着滑动方向走（每次手势
   * 只切一张，但会一张张往前走）。`onSwipeIntent` 在起手时就调它，结算那一帧
   * 不必等解码。
   *
   * **缩略图必须一起预热**：`fill()` 往槽里画的是 `thumbUrl()`，只预热原图
   * 的话，轮转进来的那个槽仍要现取一次，落地那一两帧就露出空白 ——
   * 「邻图没跟着移入」正是这一帧。`preload()` 按 URL 去重，两份一起备不会
   * 把同一张图解码两遍。
   */
  prefetchNeighbor(direction, count = PREFETCH_RUN) {
    const step = direction > 0 ? 1 : -1;
    for (let n = 1; n <= count; n += 1) {
      const item = this.items[this.index + step * n];
      if (!item) break;
      preload(thumbUrl(item.id), 'high');
      preload(fullUrl(item.id, maxEdgeFor(item)), 'high');
    }
  }

  /**
   * 把某一张的**底图**取回来并解码好，返回一个可以等的 Promise。
   *
   * 跨窗口开场时这一步是「闪不闪」的开关：`open()` 不等图片 —— 几何来自宽高
   * 元数据，第一帧就能动 —— 于是 FLIP 起来的是个**空框**，等缩略图解码完突然
   * 填上，就是一次实打实的跳变。而预览是另一个 webview，它的图片缓存是空的，
   * 这张图必然要现取。
   *
   * 所以由宿主在「切全屏」那段躲不掉的等待里**并行**把它取回来，等开场几何
   * 算完、图片通常也已经就位了。等待必须有限（见调用处）：图片取不到也不能
   * 拖着不开场 —— 那时退化成空框长大，总比永远不响应用户好。
   *
   * @param {number} index
   * @returns {Promise<void>} 图片已解码（或取不到，也一样兑现）
   */
  preload(index) {
    const item = this.items[clamp(index, 0, this.items.length - 1)];
    if (!item) return Promise.resolve();
    const img = new Image();
    img.decoding = 'async';
    img.src = thumbUrl(item.id);
    // `decode()` 兑现 = 这一张已经能画上去了（而不只是「字节到了」）；
    // 平台不支持或解码失败都当作「没预热成」，调用方照常开场。
    if (typeof img.decode !== 'function') return Promise.resolve();
    return img.decode().catch(() => {});
  }

  /**
   * 静止期把前后各一张**备成可直接换进槽的已解码节点**。
   *
   * 只预热原图是个漏洞：跟手期间槽里画的是缩略图，方向键 / wheel 起手那一刻
   * 真正需要的 `thumbUrl()` 反而没人预热，`fill()` 只能现取现解码 —— 目标图
   * 从侧边缘进视口的第一帧就露成背景。两份一起备，反向起手也有货。
   */
  preloadNeighbors() {
    for (const offset of [1, -1]) {
      const index = this.index + offset;
      if (index >= 0 && index < this.items.length) {
        const item = this.items[index];
        preload(thumbUrl(item.id), 'high');
        preload(fullUrl(item.id, maxEdgeFor(item)));
      }
    }
  }

  updateInfo() {
    const item = this.currentItem;
    if (!item) return;
    this.titleEl.textContent = item.name;
    this.counterEl.textContent = `${this.index + 1} / ${this.items.length}`;
    this.updateZoomLabel();
    this.updateNavState();
  }

  updateZoomLabel() {
    const g = this.g;
    const item = this.currentItem;
    if (!g || !item) return;
    const factor = item.width && this.box?.w
      ? (this.box.w * g.scale) / item.width
      : g.scale;
    this.zoomEl.textContent = `${Math.round(factor * 100)}%`;
  }

  setBackdrop(value) {
    this.backdropOpacity = clamp(value, 0, 1);
    this.backdrop.style.opacity = String(this.backdropOpacity);
  }

  /** 背景独立做透明度过渡，便于与手势状态解耦 */
  fadeBackdrop(to, duration) {
    const from = this.backdropOpacity;
    this.backdropOpacity = clamp(to, 0, 1);
    this.backdrop.style.opacity = String(this.backdropOpacity);
    if (duration > 0 && from !== this.backdropOpacity) {
      this.backdrop.animate({ opacity: [from, this.backdropOpacity] }, {
        duration,
        easing: TWEEN_FADE_EASE,
        fill: 'none'
      });
    }
  }

  /**
   * 有交互就重新计时，静止 `CHROME_IDLE_MS` 后自动隐藏**整套控件**
   * —— 标题栏、上一张/下一张按钮、底部胶片条、以及光标。
   *
   * 三者共用**同一个计时器、同一个 class、同一条 CSS 过渡规则**，
   * 所以不存在「标题栏先消失、画廊后消失」之类的错位。
   *
   * 到期时若指针还按着，就**再排一次**而不是直接放弃 —— 放弃的话，
   * 这一次交互结束后计时器已经没了，控件会永远停在显示状态。
   *
   * 「还按着就不隐藏」这条不是洁癖，是必须：`.viewer.is-idle .nav-btn` 会
   * 被加上 `pointer-events: none`，而此时 nav-btn 可能正持有指针捕获。
   * 给捕获中的元素加 `pointer-events:none`，浏览器会隐式释放捕获并改派
   * `pointercancel`，pointerup 就再也不会来了（各内核实现还不完全一致）。
   */
  bumpChrome() {
    clearTimeout(this._idle);
    this.root.classList.remove('is-idle');

    const arm = () => {
      this._idle = setTimeout(() => {
        if (!this.isOpen || this.closing) return;
        if (this.g?.busy) {
          this._idle = setTimeout(arm, CHROME_RETRY_MS);
          return;
        }
        this.root.classList.add('is-idle');
      }, CHROME_IDLE_MS);
    };

    arm();
  }

  /** `bumpChrome()` 的旧名（外部与探针仍在用），保留以免调用方漏改。 */
  bumpControls() {
    this.bumpChrome();
  }

  /** 连续拖窗口时 RO 会每帧回调，合并到一帧里算一次 */
  scheduleResize() {
    // 取消上一帧再重排：既让「最后一次尺寸」生效，也避免句柄被丢掉后
    // 永远卡在「已排过」的状态（那样 resize 就再也不响应了）
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = 0;
      this.onResize();
    });
  }

  /**
   * 容器尺寸变了 —— 重新适配。三件事必须一起做，缺一个就会出现
   * 「拉伸变形 / 超出边界 / 大量留白」：
   *   1. 三个槽的适配尺寸 `--w/--h` 重算（图片靠它们等比缩放，不拉伸）；
   *   2. 轨道基准偏移重算（槽宽 = stage 宽，宽度一变偏移就得跟着变，
   *      否则当前那张会被推到屏幕外）；
   *   3. 手势状态按新尺寸收敛：保留缩放倍率，只把平移夹回新边界。
   *
   * 尺寸为 0（窗口最小化 / 元素隐藏）直接跳过：那时 `fitBox` 会算出 0×0，
   * 把图片写死成 0 尺寸；等尺寸恢复时再算一次即可。
   */
  onResize() {
    if (!this.isOpen) return;

    const view = this.view();
    if (view.w <= 0 || view.h <= 0) return;

    // ---- 1. 重新适配三个槽 --------------------------------------------
    for (const slot of this.slots) {
      const item = slot.__index >= 0 ? this.items[slot.__index] : null;
      if (item) this.refitSlot(slot, item, view);
    }
    this.box = this.currentSlot?.__box ?? this.box;

    // ---- 2. 轨道基准偏移重算 ------------------------------------------
    // 正在播的切换动画是按旧槽宽算的，先取消再直接落到新位置
    if (this.trackAnim) {
      try {
        this.trackAnim.cancel();
      } catch {
        /* 已结束的动画忽略 */
      }
      this.trackAnim = null;
    }
    this.trackOffset = -this.slotIndex * this.slotWidth();
    this.track.style.transform = `translate3d(${this.trackOffset}px, 0, 0)`;

    // ---- 3. 手势状态收敛 ----------------------------------------------
    // 手指还按着的时候不要插手，否则会把正在进行的拖拽/下拉打断。
    // 判据用 `busy`（pointers 是否为空）而不是 `dragging` —— 后者只是个标记，
    // 万一某次 pointerup 丢失就会永远卡在 true，这里就再也不会收敛了。
    if (this.g && !this.g.busy) {
      this.g.refit({
        base: this.box,
        view,
        // 最大倍率依赖「原图 ÷ 适配尺寸」，适配尺寸变了上限也跟着变
        maxScale: this.maxScale()
      });
      this.updateZoomLabel();
    }
  }

  onKeyDown(event) {
    // 预览还没真正打开：切全屏那一串 IPC 还没走完，画面一格都没画。这时 Esc
    // 的语义是「取消这次打开」，而它必须是**直接收摊**，不是 `close()` ——
    // 后者要求 `isOpen` 为真，在这里会被挡掉。
    //
    // 少了这一条，用户在等待的那几百毫秒里按 Esc 是**毫无反应**的：预览没开
    // 所以关闭分支不认，幕布又还盖着，然后预览会在形态切换落定后自己打开
    // —— 看着就是「按了没用、界面还卡着」。那段等待在慢机器或转场被打断时
    // 能拖到好几秒，正是最容易让人以为程序死了的窗口。
    if (!this.isOpen && !this.closing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.abort();
      }
      return;
    }
    // 任何按键都算「有操作」：按下就唤醒整套控件（标题栏 + 按钮 + 画廊），
    // 不能只有方向键才唤醒 —— 用户按了别的键却什么都没出现，就是不同步。
    this.bumpChrome();
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.go(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.go(1);
        break;
      case 'Home':
        event.preventDefault();
        this.jumpTo(0);
        break;
      case 'End':
        event.preventDefault();
        this.jumpTo(this.items.length - 1);
        break;
      case '+':
      case '=':
        event.preventDefault();
        this.zoomBy(1.3);
        break;
      case '-':
      case '_':
        event.preventDefault();
        this.zoomBy(1 / 1.3);
        break;
      case '0':
        event.preventDefault();
        this.fit();
        break;
      default:
        break;
    }
  }
}

/**
 * 只有「确实带着 src 却没加载出来」才算失败。
 * 复用节点时我们会 removeAttribute('src')，那也会触发 error 事件。
 */
function isRealFailure(img) {
  return Boolean(img.__want) && img.getAttribute('src') === img.__want;
}

/** 设置图片地址；`__want` 用来区分「主动清空」与「真的失败」 */
function setSrc(img, url) {
  img.__want = url || '';
  if (!url) {
    img.removeAttribute('src');
    return;
  }
  img.src = url;
}

/**
 * 等**某一个** <img> 节点落地，用来判定「这个槽现在画得出东西了吗」。
 *
 * 与 `imageReady()` 的区别是只认这一个节点：`fill()` 每轮都会把原图层的 src
 * 清掉，那也可能派发 error；若等「槽里任意一张图」，原图清空就会把门槛
 * 提前放行，等于没等到底图。load / error / 超时都兑现，开场绝不被挂住。
 */
function imageLoaded(img) {
  return new Promise((resolve) => {
    if (!img) {
      resolve();
      return;
    }
    if (img.complete && img.naturalWidth > 0) {
      resolve();
      return;
    }
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
      resolve();
    };
    timer = setTimeout(done, 4000);
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}

/**
 * 等某个槽里的图片真正落地（底图与原图谁先到算谁）。
 *
 * 焦点必须等这一刻：早了会落在「还没画出来的画面」上，用户按方向键以为
 * 没反应。`timeout` 是必须的 —— 图片加载失败时 error 事件会到，但个别
 * webview 在协议层出错时连 error 都不给，那时不能把调用方永远挂住。
 */
function imageReady(slide, timeout = 4000) {
  return new Promise((resolve) => {
    if (!slide) {
      resolve();
      return;
    }
    let done = false;
    let timer = 0;
    let observer = null;
    const bound = new Set();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer?.disconnect();
      for (const img of bound) {
        img.removeEventListener('load', finish);
        img.removeEventListener('error', finish);
      }
      resolve();
    };
    const bind = () => {
      // 原子换源会把 <img> 整个 replaceWith 掉；只监听调用那一刻的两个节点
      // 会永远等不到新图的 load。换源后由 MutationObserver 重新绑一次。
      for (const img of [slide.__low, slide.__full]) {
        if (!img || bound.has(img)) continue;
        bound.add(img);
        if (img.complete && img.naturalWidth > 0) {
          finish();
          return;
        }
        img.addEventListener('load', finish, { once: true });
        img.addEventListener('error', finish, { once: true });
      }
    };
    observer = typeof MutationObserver === 'function'
      ? new MutationObserver(bind)
      : null;
    observer?.observe(slide, { childList: true });
    timer = setTimeout(finish, timeout);
    bind();
  });
}
