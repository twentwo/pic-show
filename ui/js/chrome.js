/**
 * 控件层（标题栏 / 左右按钮 / 胶片条）的自动隐藏参数。
 *
 * 这三样东西必须**同时**出现、同时消失：任何一处提前或延后，观感就是
 * 「界面在抽搐」。所以阈值与动画参数只在这里定义一份：
 *   * JS 侧 —— `Viewer.bumpChrome()` 用它倒计时；
 *   * CSS 侧 —— `installChromeTokens()` 把时长与缓动写进 `--chrome-fade` /
 *     `--chrome-ease`，样式表统一引用这两个变量。
 * 两边从此不可能各改一半。
 */

/** 静止多久后自动隐藏控件（ms） */
export const CHROME_IDLE_MS = 2200;
/** 到期时若还在交互（指针按着 / 手势进行中），隔多久再试一次 */
export const CHROME_RETRY_MS = 300;
/** 显示 / 隐藏的动画时长（ms） */
export const CHROME_FADE_MS = 300;
/** 显示 / 隐藏的缓动 */
export const CHROME_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * 把动画参数写进 CSS 变量。
 *
 * 只在 `<html>` 上写一次；样式表里 `--chrome-fade` / `--chrome-ease` 的
 * 默认值只是兜底（比如有人单独打开 CSS 看），真正生效的是这里。
 */
export function installChromeTokens(root = document.documentElement) {
  if (!root) return;
  root.style.setProperty('--chrome-fade', `${CHROME_FADE_MS}ms`);
  root.style.setProperty('--chrome-ease', CHROME_EASE);
}
