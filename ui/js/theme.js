/**
 * 主题：默认深色 + 手动切换 + 持久化。
 *
 * 三条规则，按优先级：
 *   1. 用户手动选过 → **永远**用他选的（写进 localStorage，下次启动生效）；
 *   2. 没选过 → 深色，不看系统外观；
 *   3. localStorage 不可用（隐私模式 / file://）→ 深色，本次会话内的切换
 *      记在内存里，至少不会点一下就串味。
 *
 * 为什么**故意不跟随系统**：一旦接上 `prefers-color-scheme`，默认就不再是
 * 「深色」而是「随缘」，而且要多付一笔代价——浏览器先按系统色画第一帧、JS
 * 再改回来，那一下就是肉眼可见的浅色闪烁。见 `index.html` 里的同步内联脚本。
 *
 * 颜色本身一律写在 CSS 变量里（两套：`ui/styles/app.css` 的令牌区），这里
 * 只负责挑用哪一套。组件里出现第二个十六进制色值就是 bug —— `npm run check`
 * 里的 check_tokens.mjs 会把它拦下来。
 */

import { setWindowTheme } from './api.js';

/** localStorage 的键名。index.html 的防闪脚本里有一份同名的，别单独改 */
export const THEME_KEY = 'picshow.theme';
/** 未手动选择时的默认主题 */
export const DEFAULT_THEME = 'dark';
/** 合法取值 */
const THEMES = ['dark', 'light'];

/** localStorage 不可用时退到这里，至少保证本次会话内一致 */
let memoryTheme = null;

/** 归一化成 'dark' / 'light'；不认识的值返回 null */
function normalize(name) {
    return THEMES.includes(name) ? name : null;
}

/** 用户选过的值：`'dark' | 'light'`，没选过返回 null */
export function readPreference() {
    try {
        const normalized = normalize(localStorage.getItem(THEME_KEY));
        if (normalized) return normalized;
    } catch {
        /* 隐私模式 / 禁用存储 */
    }
    return memoryTheme ? normalize(memoryTheme) : null;
}

/**
 * 写入偏好。
 *
 * 存失败不能抛：主题只是外观，因为写不进 localStorage 就让「切换」整个失效，
 * 用户看到的会是「点了没反应」—— 记在内存里至少这次会话是对的。
 */
export function savePreference(name) {
    const theme = normalize(name);
    if (!theme) return null;
    memoryTheme = theme;
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch {
        /* 忽略：见上 */
    }
    return theme;
}

/**
 * 当前**应当**生效的主题：偏好优先，没偏好就默认深色。
 *
 * 与 `currentAppliedTheme()` 的区别：那个是「DOM 上现在挂着什么」，
 * 这个是「应该是什么」。两者不一致说明漏了一步 apply。
 */
export function resolveTheme() {
    return readPreference() ?? DEFAULT_THEME;
}

/** 写入 `<html data-theme>`；顺手同步 `color-scheme`（滚动条/表单跟着改） */
export function applyTheme(name) {
    const theme = normalize(name) ?? DEFAULT_THEME;
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    return theme;
}

/** DOM 上当前生效的主题名 */
export function currentAppliedTheme() {
    return normalize(document.documentElement.dataset.theme) ?? null;
}

/**
 * 应用并记住一个主题。
 * @param {'dark'|'light'} name
 * @param {{remember?: boolean}} [options] remember=false 用于「临时生效」
 *        （比如探针里切换对比），不污染用户的持久化选择
 */
export function setTheme(name, { remember = true } = {}) {
    const theme = applyTheme(name);
    if (remember) savePreference(theme);
    // 原生那一侧（文件对话框等）不听 CSS 的话，得单独通知一次
    setWindowTheme(theme);
    notify();
    return theme;
}

/** 在深/浅之间翻面，返回新的主题 */
export function toggleTheme() {
    return setTheme(currentAppliedTheme() === 'light' ? 'dark' : 'light');
}

/* ------------------------------------------------------------------ *
 * 订阅：主题变化后刷新按钮文案
 * ------------------------------------------------------------------ */

const listeners = new Set();

export function onThemeChange(handler) {
    listeners.add(handler);
    return () => listeners.delete(handler);
}

function notify() {
    const theme = currentAppliedTheme();
    for (const handler of listeners) handler(theme);
}

/* ------------------------------------------------------------------ *
 * 主题切换按钮
 *
 * 两个入口：
 *   * 顶栏（浏览器界面）—— 常规使用；
 *   * 预览标题栏 —— 沉浸式预览下顶栏是 `display:none`，那里够不着，
 *     所以 tuner 也得进预览界面。
 *
 * 图标由 CSS 根据 `[data-theme]` 决定显示太阳还是月亮，这里只同步
 * 「点下去会发生什么」的文案 —— 不然读屏用户拿到的是一个语义不明的按钮。
 * ------------------------------------------------------------------ */

/** 文案写的是「点下去会发生什么」，按**目标**主题生成 —— 写反过一次，
    改成算出来就再也反不了了。 */
const labelFor = (target) => `切换到${target === 'light' ? '浅色' : '深色'}主题`;

/**
 * @param {Iterable<HTMLElement>} nodes
 */
export function mountThemeToggles(nodes) {
    for (const node of nodes) {
        if (!node) continue;
        node.addEventListener('click', () => toggleTheme());
    }
    syncThemeToggles(nodes);
    onThemeChange(() => syncThemeToggles(nodes));
}

function syncThemeToggles(nodes) {
    const theme = currentAppliedTheme() ?? DEFAULT_THEME;
    const next = theme === 'light' ? 'dark' : 'light';
    const label = labelFor(next);
    for (const node of nodes) {
        if (!node) continue;
        node.title = label;
        node.setAttribute('aria-label', label);
    }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/**
 * 装载主题。
 *
 * 正常的生效路径其实是 `index.html` **头部那段同步内联脚本**（比 CSS 还早，
 * 因此没有闪烁）；这里做的是「补齐」：
 *   * 持久化选择变化时同步给原生窗口；
 *   * 清掉为防闪临时写在 `<html>` 上的行内底色（CSS 已经到了，轮到它说话）。
 *
 * 失败不许抛：主题只是外观，不能因为它把整个 boot 流程打断 —— 那会表现为
 * 「窗口黑屏」，而真正的原因只是主题没取到。
 */
export function initTheme() {
    const theme = resolveTheme();
    applyTheme(theme);
    setWindowTheme(theme);
    // 防闪用的临时行内底色到此为止，否则它会一直压着 CSS 的 background
    document.documentElement.style.removeProperty('background-color');
    notify();
    return theme;
}
