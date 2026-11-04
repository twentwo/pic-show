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
  revealImage
} from './api.js';
import { fitBox, clamp, mapBoxToRect } from './geometry.js';
import { withTimeout } from './async.js';
import { Gestures } from './gestures.js';
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
 * 连续横滑时沿滑动方向预热的张数。
 *
 * 一次快速甩动能一口气跨过好几张，而 `preloadNeighbors()` 是切完才排的、只
 * 预热前后各一张，跟不上连续推进。取 4 是因为轮转出去的那个槽要走过两屏
 * 才会重新进入视口 —— 至少给它留两屏的提前量，且缩略图与原图都要备齐：
 * `fill()` 真正画的是缩略图，只预热原图等于预热错了资源。
 */
const PREFETCH_RUN = 4;
/**
 * wheel 流结束吸附那一小段收尾的最长时长。
 *
 * 整段流里画面都是 1:1 跟着手指走的，最后只补「不足一屏的余数」。若还按
 * 键盘切图的 300ms 播，节奏会在松手那一下突然慢下来，就是「顿挫」。
 */
const WHEEL_LAND_MS = 180;
/** 跳转到相隔很远的一张时用的淡入时长 */
const JUMP_MS = 200;
/** 到首尾回弹提示的幅度（px） */
const NUDGE_PX = 22;

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
    this.fill(this.slots[0], this.index - 1);
    this.fill(this.slots[1], this.index);
    this.fill(this.slots[2], this.index + 1);
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
      // 转场跑完再拉原图，避免大图解码抢走转场的帧
      anim.finished
        .then(() => {
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
        if (this.g) this.g.enabled = true;
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
   * 连续横滑：累计位移跨过一整屏时的**同步换页**。
   *
   * 与 `go()` 的区别是这里什么都不等：不播收尾动画、不设 `switching` 闸门、
   * 不关 `enabled`、不重建 `Gestures`（只把变换目标 `retarget` 到新的当前槽）。
   * 这一段 wheel 流还在跑，任何一次「等动画 / 重建监听器 / 落锁」都会把下一段
   * 跟手位移吞掉 —— 连续快滑的卡顿与反馈延迟累积正是这么来的。
   *
   * 视觉连续性由 `rebalance()` 保证：DOM 轮转一格的同时把 `trackOffset` 对齐到
   * 新的中间槽，此刻画面正好停在「下一张完整显示」的位置；手势随后写回
   * `trackOffset + swipeX`（`swipeX` 已扣掉刚跨过的那一屏），一帧都不差。
   *
   * 原图**不在这里拉**：连续快滑一帧能跨过好几张，逐张取原图只会让解码挤满
   * 主线程。槽里已有的低分辨率底图（与网格同一 URL，命中缓存）先顶着，流结束
   * 时由 `onWheelRest` 补给最终那一张 —— 这也是「供给不及即降级」的落点。
   *
   * @param {number} direction +1 下一张 / -1 上一张
   * @returns {boolean} false = 到首尾了，调用方改走阻尼
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

    // 连续推进的热路径：视口只量一次，往下传给 rebalance / fill，别在
    // appendChild 之后、写完 transform 之前再读 clientWidth（强制同步重排）。
    const view = this.view();
    this.index = target;
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
    // 沿滑动方向连续预热，别等结算帧才撞上解码
    this.prefetchNeighbor(step, PREFETCH_RUN);
    return true;
  }

  /**
   * @param {number} delta +1 下一张 / -1 上一张
   * @param {object} [opts]
   * @param {boolean} [opts.fromSwipe] 由手指横滑触发 —— 从手指当前位置接着播
   * @param {boolean} [opts.fromWheel] 由触控板 wheel 流结束吸附触发。整段流用的是
   *   **同一个** Gestures 实例（轴向 / 累计 / 结算定时器都挂在它身上），重建实例
   *   会拆掉监听器、把关掉的 enabled 留到动画结束 —— 紧跟着的下一段横滑要么被吞、
   *   要么等重试，就是「松手之后发木」。这条路径只 retarget、不碰闸门。
   */
  async go(delta, { fromSwipe = false, fromWheel = false } = {}) {
    const step = delta > 0 ? 1 : -1;
    if (!this.isOpen || this.switching || this.closing) return;

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
    // wheel 流整段都是 1:1 跟手，最后只补不足一屏的余数：固定用 WHEEL_LAND_MS，
    // 不再按 SWITCH_MS 缩放（那样会把最后一下拖成键盘切图的节奏，就是「顿挫」）。
    const dist = Math.abs(toX - fromX);
    const duration = fromWheel
      ? WHEEL_LAND_MS
      : fromSwipe
        ? clamp((SWITCH_MS * dist) / Math.max(1, width), SWITCH_EXIT_MIN_MS, SWITCH_MS)
        : SWITCH_MS;

    await this.animateTrack(fromX, toX, duration);
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
    if (target === this.index) return;
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
    slide.style.opacity = '0';
    slide.animate({ opacity: [0, 1] }, { duration: JUMP_MS, easing: TWEEN_FADE_EASE, fill: 'none' });

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
   * @param {?object} [opts.view] 调用方量好的视口。连续推进时传入，可避开
   *   「appendChild / insertBefore 改了 DOM 结构 → 再读 clientWidth」的强制重排。
   * @param {boolean} [opts.skipTransform] 为 true 时不写静止基准那条 transform。
   *   连续推进专用：紧跟着的 `Gestures.applyTrack()` 会在同一任务里写回
   *   「基准 + 剩余位移」，两条写入之间不会渲染，中间这条纯属多余。
   */
  rebalance({ view = null, skipTransform = false } = {}) {
    if (this.slotIndex === 1) return;

    // 一次量好：下面要改 DOM 结构（会脏布局），之后再读 clientWidth 就是一次
    // 同步重排。连续推进时 view 由 advanceBy 传入，这里完全不碰布局。
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
   * 连续横滑时这个槽会在**一两屏之后**就滚进视口，所以「换内容」不能等它
   * 露出来才现取：优先把预取阶段已经 `decode()` 好的 <img> 直接换进来（同一
   * 帧就有像素），池里没有才退回设 src（字节也已在内存缓存里，只是多一次
   * 绘制）。原图同理 —— 预热过就直接给清晰的，不要每次轮转都掉回模糊底图，
   * 那种清晰度跳变在快滑里看起来就是「闪」。
   *
   * @param {?object} view 由调用方量好的视口；连续推进时一次量好往下传，
   *   免得每个槽都读一次 clientWidth（前面刚改过 DOM 顺序、又写过 transform，
   *   那就是强制重排）。空槽直接返回，连这一次都不量。
   */
  fill(slot, itemIndex, view = null) {
    if (!slot) return;
    // 越界统一记成 -1，槽位状态只有「装着第几张」和「空」两种
    const at = itemIndex >= 0 && itemIndex < this.items.length ? itemIndex : -1;
    if (slot.__index === at) return;
    slot.__index = at;

    slot.classList.remove('is-full', 'is-failed', 'is-low-failed', 'is-zoomed', 'is-grabbing');
    slot.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
    slot.style.removeProperty('opacity');
    // 上一次可能换进来一张带着 inline opacity:1 的已解码原图，先清掉
    slot.__full.style.removeProperty('opacity');

    const item = at >= 0 ? this.items[at] : null;
    if (!item) {
      slot.__box = { w: 0, h: 0 };
      setSrc(slot.__low, '');
      setSrc(slot.__full, '');
      slot.style.removeProperty('--w');
      slot.style.removeProperty('--h');
      return;
    }

    // 按需才量：连续推进时由 advanceBy 量好一次传下来。
    const v = view ?? this.view();
    this.refitSlot(slot, item, v);

    const lowUrl = thumbUrl(item.id);
    if (!this.adoptSlotImage(slot, '__low', lowUrl, 'slide-low')) {
      setSrc(slot.__low, lowUrl);
    }

    const fullSrc = fullUrl(item.id, maxEdgeFor(item));
    if (this.adoptSlotImage(slot, '__full', fullSrc, 'slide-full')) {
      // 已解码 → 直接定格，别让 CSS 的 0.32s 淡入在连续横滑里变成一张张淡出来
      slot.__full.style.opacity = '1';
      slot.classList.add('is-full');
    } else {
      setSrc(slot.__full, '');
    }
    slot.__full.alt = item.name ?? '';
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

  /** 槽位回收：清空内容，下次 fill 时再填 */
  resetSlots() {
    for (const slot of this.slots) {
      slot.__index = -2; // 强制下次 fill 重新执行
      this.fill(slot, -1);
      slot.style.removeProperty('transform');
      slot.style.removeProperty('opacity');
    }
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
      // 手势 —— 轴向、视口宽与本段累计必须交接过去，否则实例一换就重新攒
      // 10px 判一次轴，起手又要慢半拍。连续推进本身不重建实例（见 advanceBy），
      // 这里只服务流结束吸附那一次 go()。
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
      // 连续横滑：累计位移每跨过一整屏就同步换一张（不播动画、不重建手势）。
      // 返回 false 表示到首尾，手势自己改走阻尼。
      onWheelAdvance: (direction) => this.advanceBy(direction),
      // 流结束吸附：补完最后一张时与单指松手共用 `fromSwipe`（从当前跟手位置
      // 接着把剩下的位移播完），但额外标 `fromWheel` —— 走不重建手势、不落闸、
      // 固定 WHEEL_LAND_MS 的那条轻量收尾。
      onWheelSwipe: (direction, opts = {}) => {
        this.go(direction, { fromSwipe: true, fromWheel: true, ...opts });
      },
      // 一段流结算完：连续推进期间只让底图顶着，这时才补给最终那一张的原图
      onWheelRest: () => {
        this.startFullLoad();
        this.preloadNeighbors();
      },
      // 跟手一开始就把目标那张的原图取回来解码：切过去的第一帧不必等解码
      onSwipeIntent: (direction) => this.prefetchNeighbor(direction),
      onTap: (x, y) => this.onTap(x, y),
      onDoubleTap: (x, y) => this.toggleZoom(x, y),
      onUserActivity: () => this.bumpChrome()
    });
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
   * `preloadNeighbors()` 是每次切完之后才排的、只备前后各一张；打开预览后立刻
   * 甩一下时，目标那张可能还在路上，结算那帧刚好撞上解码。跟手阶段主线程
   * 本来就是空的，这时提前取最划算。连续推进会一次跨过好几张，`count` 因此
   * 由 `advanceBy` 扩到 `PREFETCH_RUN`，让供给跟着滚动方向走。
   *
   * **缩略图必须一起预热**：`fill()` 往槽里画的是 `thumbUrl()`，只预热原图
   * 的话，轮转进来的那个槽仍要现取一次，一两屏之后就露出空白 —— 连续快滑里
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

  /** 预取前后各一张的原图，让方向键切换几乎无等待 */
  preloadNeighbors() {
    for (const offset of [1, -1]) {
      const index = this.index + offset;
      if (index >= 0 && index < this.items.length) {
        const item = this.items[index];
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
 * 等某个槽里的图片真正落地（底图与原图谁先到算谁）。
 *
 * 焦点必须等这一刻：早了会落在「还没画出来的画面」上，用户按方向键以为
 * 没反应。`timeout` 是必须的 —— 图片加载失败时 error 事件会到，但个别
 * webview 在协议层出错时连 error 都不给，那时不能把调用方永远挂住。
 */
function imageReady(slide, timeout = 4000) {
  const imgs = [slide?.__low, slide?.__full].filter(Boolean);
  return new Promise((resolve) => {
    if (!imgs.length) {
      resolve();
      return;
    }
    let done = false;
    let timer = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const img of imgs) {
        img.removeEventListener('load', finish);
        img.removeEventListener('error', finish);
      }
      resolve();
    };
    timer = setTimeout(finish, timeout);
    for (const img of imgs) {
      if (img.complete && img.naturalWidth > 0) {
        finish();
        return;
      }
      img.addEventListener('load', finish);
      img.addEventListener('error', finish);
    }
  });
}
