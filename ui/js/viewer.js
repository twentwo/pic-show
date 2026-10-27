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
  revealImage
} from './api.js';
import { fitBox, clamp, mapBoxToRect } from './geometry.js';
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

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
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
 */
export const OPEN_EASE = EASE;
/** 转场时长 */
export const OPEN_MS = 340;
const CLOSE_MS = 300;
/** 左右切换：轨道位移时长 */
const SWITCH_MS = 300;
/** 跳转到相隔很远的一张时用的淡入时长 */
const JUMP_MS = 200;
/** 到首尾回弹提示的幅度（px） */
const NUDGE_PX = 22;

export class Viewer {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root #viewer
   * @param {import('./grid.js').Grid} opts.grid
   * @param {(message:string)=>void} opts.onError
   * @param {()=>void} opts.onExit 关闭后是否退出应用（沉浸式预览用）
   */
  constructor({ root, grid, onError = () => {}, onExit = () => {} }) {
    this.root = root;
    this.grid = grid;
    this.onError = onError;
    this.onExit = onExit;
    /** 沉浸式：关闭 = 退出应用（从文件管理器唤起时） */
    this.exitOnClose = false;
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
   * 不早设的理由很实在：点亮窗口之后还有 maximize、布局落定这几帧，它们会
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

  /** 关闭后是否退出应用（「打开方式」进来的窗口，关掉就该彻底消失） */
  setExitOnClose(enabled) {
    this.exitOnClose = Boolean(enabled);
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

  /* ------------------------------------------------------------------ *
   * 打开 / 关闭
   * ------------------------------------------------------------------ */

  /**
   * 打开画廊。
   *
   * @param {number} index
   * @param {?HTMLElement} [originEl] 从网格进来时的那张缩略图（FLIP 起点）
   * @param {object} [options]
   * @param {?{left,top,width,height}} [options.fromRect]
   *        视口坐标系里的起点矩形（「打开方式」启动用）
   * @param {number} [options.centerScale] 没有起点矩形时的起始倍率（中心放大）
   * @param {boolean} [options.fadeIn] 是否叠加透明度渐变
   */
  open(index, originEl = null, options = {}) {
    if (this.isOpen || this.closing || !this.items.length) return;

    this.index = clamp(index, 0, this.items.length - 1);
    this.originEl = originEl?.classList ? originEl : null;

    // 必须先显示再填充：`hidden` 时 stage 的尺寸是 0，fitBox 会算出 0×0
    this.root.hidden = false;
    this.root.classList.remove('is-idle');
    this.setBackdrop(0);

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

    const from = this.zoomStart(offsetBox(originEl), options);
    const slide = this.slots[1];

    // 展开动画期间不接受手势：中途拖一下会同时跑 FLIP 和滑动，画面会打结
    if (this.g) this.g.enabled = false;

    if (from) {
      const keyframes = {
        transform: [from, 'translate3d(0px, 0px, 0) scale(1)']
      };
      // 「从某一格长出来」要配透明度渐变才像透视，纯位移会显得很硬。
      // 网格那条路径原本没有渐变：那里是同一张图的缩略图到原图，中间不该透。
      if (options.fadeIn) keyframes.opacity = [0, 1];

      const anim = slide.animate(keyframes, {
        duration: OPEN_MS,
        easing: EASE,
        fill: 'none'
      });
      this.fadeBackdrop(1, 280);
      // 转场跑完再拉原图，避免大图解码抢走转场的帧
      anim.finished
        .then(() => {
          if (this.g) this.g.enabled = true;
          this.startFullLoad();
          this.preloadNeighbors();
        })
        .catch(() => {});
    } else {
      slide.animate({ opacity: [0, 1] }, { duration: 200, easing: 'ease-out', fill: 'none' });
      this.fadeBackdrop(1, 200);
      setTimeout(() => {
        if (this.g) this.g.enabled = true;
      }, 200);
      this.startFullLoad();
      this.preloadNeighbors();
    }

    if (this.originEl) this.originEl.classList.add('is-origin-hidden');
    this.isOpen = true;
    this.bumpChrome();
  }

  /**
   * 开场动画的起始 transform，取不到就返回 null（走普通淡入）。
   *
   * 优先级：缩略图元素（网格那条路） → 显式矩形（「打开方式」） → 中心缩放
   * （拿不到来源信息时的兜底）。时长与缓动沿用 `OPEN_MS` / `EASE`，与关闭、
   * 切换保持同一套手感。
   *
   * @param {?{width:number,height:number}} thumbRect
   * @param {{fromRect?: ?object, centerScale?: number}} [options]
   */
  zoomStart(thumbRect, { fromRect = null, centerScale = 0 } = {}) {
    const usable = (rect) =>
      rect && Number.isFinite(rect.width) && rect.width > 0 && rect.height > 0;
    const rect = usable(thumbRect) ? thumbRect : usable(fromRect) ? fromRect : null;

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
   * 「打开方式」启动专用开场：从那一格（或屏幕中心兜底）放大到全屏。
   *
   * 不返回 Promise、不等任何图片：几何来自 `items` 里的宽高元数据，
   * 所以第一帧就能动起来，底图到达时自然补上。
   *
   * @param {number} index
   * @param {?{left,top,width,height}} rect 视口坐标系里的来源矩形
   */
  openLaunch(index, rect) {
    this.open(index, null, {
      fromRect: rect,
      centerScale: CENTER_ZOOM_SCALE,
      fadeIn: true
    });
  }

  async close({ fromDismiss = false } = {}) {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    // 关闭动画期间冻结手势，否则中途再拖一下会打断 FLIP
    if (this.g) this.g.enabled = false;

    const slide = this.currentSlot;
    if (!slide) {
      this.finishClose();
      return;
    }

    // 放大状态下先收回适配尺寸，这样 FLIP 的起点矩形才是确定的
    if (!fromDismiss && this.g?.isZoomed) {
      await this.g.reset(true);
    }

    // 此刻背景仍不透明，网格的滚动不会被看见
    this.grid.ensureVisible(this.index);
    const target = this.grid.getRect(this.index);

    const start = slide.style.transform || 'translate3d(0px, 0px, 0) scale(1)';
    const startOpacity = this.backdropOpacity;

    let end = 'translate3d(0px, 0px, 0) scale(0.94)';
    if (target && target.width > 0) {
      const { scale, tx, ty } = mapBoxToRect(this.box, target, this.view());
      end = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    }

    slide.animate({ transform: [start, end] }, { duration: CLOSE_MS, easing: EASE, fill: 'none' });
    // 收尾淡出：掩盖「全屏原图 → 网格缩略图」的分辨率落差
    slide.animate({ opacity: [1, 1, 0] }, { duration: CLOSE_MS, easing: 'linear', fill: 'none' });

    const fade = this.backdrop.animate(
      { opacity: [startOpacity, 0] },
      { duration: CLOSE_MS, easing: 'ease-out', fill: 'none' }
    );
    this.backdropOpacity = 0;

    this.root.classList.remove('is-idle');
    if (this.originEl) this.originEl.classList.remove('is-origin-hidden');

    await fade.finished.catch(() => {});
    this.finishClose();
  }

  finishClose() {
    this.g?.detach();
    this.g = null;
    this.resetSlots();
    this.root.hidden = true;
    this.isOpen = false;
    this.closing = false;
    clearTimeout(this._idle);
    // 沉浸式预览：窗口是为这一张而开的，关掉就等于「回到文件管理器」
    if (this.exitOnClose) this.onExit();
  }

  /* ------------------------------------------------------------------ *
   * 切换
   * ------------------------------------------------------------------ */

  /**
   * @param {number} delta +1 下一张 / -1 上一张
   * @param {object} [opts]
   * @param {boolean} [opts.fromSwipe] 由手指横滑触发 —— 从手指当前位置接着播
   */
  async go(delta, { fromSwipe = false } = {}) {
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

    // 先把目标缩略图滚进视口，关闭动画才有落点
    this.grid.ensureVisible(target);

    // 立刻起拉原图：动画只动 transform，跑在合成器线程上，解码抢不走它的帧
    this.startFullLoad();

    this.updateInfo();
    this.strip.focus(target);
    this.attachGestures();
    if (this.g) this.g.enabled = false;
    this.syncOrigin(target);
    this.bumpChrome();

    await this.animateTrack(fromX, toX, SWITCH_MS);
    // DOM 轮转一格 + 基准偏移同步改回中间槽 —— 两者同一帧生效，画面不动
    this.rebalance();
    this.preloadNeighbors();
    if (this.g) this.g.enabled = true;
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
    if (this.g?.isZoomed) this.g.reset(false);
    if (this.g) this.g.swipeX = 0;

    this.grid.ensureVisible(target);
    this.index = target;
    this.slotIndex = 1;
    this.fill(this.slots[1], target);
    this.box = this.slots[1].__box ?? this.box;

    const slide = this.slots[1];
    slide.style.opacity = '0';
    slide.animate({ opacity: [0, 1] }, { duration: JUMP_MS, easing: 'ease-out', fill: 'none' });

    this.trackOffset = -this.slotWidth();
    this.track.style.transform = `translate3d(${this.trackOffset}px, 0, 0)`;

    // 邻槽等淡入结束再填，避免同一帧里三张图一起解码
    this.fill(this.slots[0], target - 1);
    this.fill(this.slots[2], target + 1);

    this.startFullLoad();
    this.updateInfo();
    this.strip.focus(target, { immediate: true });
    this.attachGestures();
    this.syncOrigin(target);
    this.bumpChrome();

    await new Promise((resolve) => setTimeout(resolve, JUMP_MS));
    this.rebalance();
    this.preloadNeighbors();
    this.switching = false;
  }

  /** 轨道位移：先把终值写进 inline style，动画 fill:'none'，收尾不闪回 */
  animateTrack(fromX, toX, duration, easing = EASE) {
    const from = `translate3d(${fromX}px, 0, 0)`;
    const to = `translate3d(${toX}px, 0, 0)`;

    this.trackOffset = toX;
    this.track.style.transform = to;

    if (duration <= 0 || from === to) return Promise.resolve();

    const anim = this.track.animate(
      { transform: [from, to] },
      { duration, easing, fill: 'none' }
    );
    this.trackAnim = anim;
    return anim.finished
      .then(() => {
        this.trackAnim = null;
      })
      .catch(() => {});
  }

  /**
   * 轮转 DOM 顺序，让当前槽回到中间。
   * 关键：只有被挪到视口外的那个槽需要换内容，正在看的那张纹丝不动。
   */
  rebalance() {
    if (this.slotIndex === 1) return;

    const [a, b, c] = this.slots;
    if (this.slotIndex === 2) {
      // [a,b,c] → [b,c,a]：a 挪到末尾，改填「新的下一张」
      this.track.appendChild(a);
      this.slots = [b, c, a];
      this.fill(a, this.index + 1);
    } else {
      // [a,b,c] → [c,a,b]：c 挪到最前，改填「新的上一张」
      this.track.insertBefore(c, a);
      this.slots = [c, a, b];
      this.fill(c, this.index - 1);
    }

    this.slotIndex = 1;
    this.trackOffset = -this.slotWidth();
    this.track.style.transform = `translate3d(${this.trackOffset}px, 0, 0)`;
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
   * 只设低分辨率底图（与网格同一个 URL，命中缓存）；原图等它成为当前项再拉。
   */
  fill(slot, itemIndex) {
    if (!slot) return;
    // 越界统一记成 -1，槽位状态只有「装着第几张」和「空」两种
    const at = itemIndex >= 0 && itemIndex < this.items.length ? itemIndex : -1;
    if (slot.__index === at) return;
    slot.__index = at;

    slot.classList.remove('is-full', 'is-failed', 'is-low-failed', 'is-zoomed', 'is-grabbing');
    slot.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
    slot.style.removeProperty('opacity');

    const item = at >= 0 ? this.items[at] : null;
    if (!item) {
      slot.__box = { w: 0, h: 0 };
      setSrc(slot.__low, '');
      setSrc(slot.__full, '');
      slot.style.removeProperty('--w');
      slot.style.removeProperty('--h');
      return;
    }

    this.refitSlot(slot, item, this.view());
    slot.__full.alt = item.name ?? '';

    setSrc(slot.__low, thumbUrl(item.id));
    setSrc(slot.__full, '');
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
    this.g?.detach();
    this.g = new Gestures(this.currentSlot, {
      track: this.track,
      trackBase: () => this.trackOffset,
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

  /**
   * 让「原始缩略图」跟随当前索引。切换图片后，关闭动画的落点、以及缩略图
   * 的隐藏态，都得挪到新图对应的格子上 —— 否则关回去时会落到旧图位置，
   * 而且旧缩略图会一直隐形。
   */
  syncOrigin(index) {
    if (this.originEl) {
      this.originEl.classList.remove('is-origin-hidden');
      this.originEl = null;
    }
    const cell = this.grid.cellFor?.(index) ?? null;
    if (cell) {
      cell.classList.add('is-origin-hidden');
      this.originEl = cell;
    }
  }

  startFullLoad() {
    const item = this.currentItem;
    const slot = this.currentSlot;
    if (!item || !slot) return;
    const src = fullUrl(item.id, maxEdgeFor(item));
    if (slot.__full.__want !== src) setSrc(slot.__full, src);
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
        easing: 'ease-out',
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
    if (!this.isOpen) return;
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

/**
 * 起点元素的矩形。
 *
 * 抽出来是因为 `open()` 的起点既可以是网格里的缩略图元素，也可以是「打开
 * 方式」给的一个纯对象；两者混在一起判断，最后一定会漏掉 `getBoundingClientRect`
 * 不存在的情况。
 */
function offsetBox(el) {
  return el?.getBoundingClientRect?.() ?? null;
}
