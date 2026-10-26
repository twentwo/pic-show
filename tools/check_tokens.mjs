#!/usr/bin/env node
/**
 * 主题令牌检查器。
 *
 * 为什么需要它：深浅色混杂的 bug 有个共同特征 —— **写的时候看不出来**。
 * 某个组件偷偷写了一个十六进制色值，在当时的默认主题下看着完全正常，切换
 * 之后才串味，而要在一千行 CSS 里找出那一个色值，靠肉眼基本不可能。
 *
 * 于是把「样式卫生」变成断言：
 *   1. 令牌之外不许出现颜色字面量；
 *   2. 两套主题必须定义**同名同数量**的令牌（少一个就继承对面的值，变成怪胎）；
 *   3. `var(--x)` 用的变量必须真有定义（拼错变量名的后果是整条声明失效，
 *      浏览器一声不响地忽略掉，元素回到 UA 默认样式）；
 *   4. 默认深色：不允许 `prefers-color-scheme` 反过来推翻默认值；
 *   5. `index.html` 的防闪内联脚本必须排在样式表之前，且里面的底色必须与
 *      CSS 令牌里的 `--bg` 同值 —— 这两件事漂移了，加载时又会开始闪。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../ui/styles/app.css');
const htmlPath = resolve(here, '../ui/index.html');

const css = readFileSync(cssPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');

let problems = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  problems += 1;
};

/* ---------------- 令牌区定位 ---------------- */

/**
 * 取出某个选择器块的内容。
 * @param {string} selector 形如 `:root[data-theme="light"]`
 */
function blockOf(selector) {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('\n}', open);
  if (open < 0 || close < 0) return null;
  return {
    text: css.slice(open + 1, close),
    start: open,
    end: close
  };
}

const dark = blockOf(':root,\n:root[data-theme="dark"]');
const light = blockOf(':root[data-theme="light"]');

if (!dark) fail('找不到深色令牌块 `:root, :root[data-theme="dark"]`');
if (!light) fail('找不到浅色令牌块 `:root[data-theme="light"]`');
if (!dark || !light) process.exit(1);

/* ---------------- 1. 令牌之外不许有颜色字面量 ---------------- */

// 先剥注释：注释里提到色值是在解释「为什么不能用这个值」，不是在用
const strippedComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) =>
  m.replace(/[^\n]/g, ' ')
);

/** 允许的例外，每条都要写清楚理由 */
const COLOR_ALLOWLIST = [
  // 品牌渐变：logo 的识别色，两个主题下都应该是这一组明快的颜色
  /linear-gradient\(135deg, #ffd166/,
  // mask-image 的色标：取的是 alpha，`#000` 只表示「不透明」，与主题无关
  /#000 28px/,
  /#000 calc\(100% - 28px\)/
];

const RE_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g;

for (const line of strippedComments.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (COLOR_ALLOWLIST.some((re) => re.test(trimmed))) continue;
  // 只检查 dark/light 两块之外的内容
  const pos = strippedComments.indexOf(line);
  if (pos >= dark.start && pos <= dark.end) continue;
  if (pos >= light.start && pos <= light.end) continue;
  const hit = trimmed.match(RE_COLOR);
  if (hit) fail(`令牌之外出现了颜色字面量 \`${hit[0]}\`：${trimmed}`);
}

/* ---------------- 2. 两套主题令牌必须一一对应 ---------------- */

const tokensOf = (text) =>
  new Map(
    [...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
  );

const darkTokens = tokensOf(dark.text);
const lightTokens = tokensOf(light.text);

for (const name of darkTokens.keys()) {
  if (!lightTokens.has(name)) fail(`浅色主题缺少令牌 ${name}（会继承深色的值）`);
}
for (const name of lightTokens.keys()) {
  if (!darkTokens.has(name)) fail(`深色主题缺少令牌 ${name}（会继承浅色的值）`);
}

/* ---------------- 3. var(--x) 用的变量必须真有定义 ---------------- */

/** 由 JS / 组件自己写进 style 的变量，CSS 里查不到定义是正常的 */
const JS_PROVIDED = new Set([
  '--w', // slide 里图片的适配尺寸
  '--h',
  '--strip-item-w', // 胶片条缩略图宽度
  '--strip-item-h'
]);

const definedEverywhere = new Set([
  ...[...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
  ...JS_PROVIDED
]);

for (const m of css.matchAll(/var\((--[\w-]+)/g)) {
  if (!definedEverywhere.has(m[1])) {
    fail(`CSS 用了未定义的变量 ${m[1]}`);
  }
}

/* ---------------- 4. 默认深色：不许被系统外观推翻 ---------------- */

if (/@media\s*\(prefers-color-scheme/.test(strippedComments)) {
  fail(
    '样式表里出现了 @media (prefers-color-scheme)：默认值会被系统外观推翻，' +
      '「未手动选择时为深色」这条就不成立了，还会带来首帧闪一下'
  );
}

/**
 * 深色的默认值必须写在**不带属性选择器**的 `:root` 里。
 * 只写在 `[data-theme="dark"]` 上，万一 data-theme 没落地（JS 被拦、脚本报错）
 * 就会掉回 UA 默认样式 —— 那就是最大的一次「浅色闪烁」。
 */
if (!/^:root,\n:root\[data-theme="dark"\]/m.test(css)) {
  fail('深色必须同时挂在裸 `:root` 上，否则 data-theme 缺失时会掉回 UA 默认样式');
}

/* ---------------- 5. index.html 的防闪脚本 ---------------- */

const scriptAt = html.indexOf('localStorage.getItem(');
const styleLinkAt = html.indexOf('rel="stylesheet"');
if (scriptAt < 0) {
  fail('index.html 缺少在样式表前落地主题的内联脚本');
} else if (styleLinkAt < 0) {
  fail('index.html 找不到样式表引用，防闪顺序无从判断');
} else if (scriptAt > styleLinkAt) {
  fail('防闪脚本排在样式表之后 —— 浏览器已经按默认色画过一帧了，还是会闪');
}

// 内联脚本里的底色必须与 CSS 令牌一致
if (darkTokens.has('--bg') && lightTokens.has('--bg')) {
  const darkBg = darkTokens.get('--bg');
  const lightBg = lightTokens.get('--bg');
  if (!html.includes(`'${darkBg}'`) && !html.includes(`"${darkBg}"`)) {
    fail(`内联脚本的深色底色不是令牌里的 ${darkBg}`);
  }
  if (!html.includes(`'${lightBg}'`) && !html.includes(`"${lightBg}"`)) {
    fail(`内联脚本的浅色底色不是令牌里的 ${lightBg}`);
  }
}

// localStorage 的键名必须与 theme.js 一致
const themeJs = readFileSync(join(here, '../ui/js/theme.js'), 'utf8');
const keyMatch = themeJs.match(/THEME_KEY\s*=\s*'([^']+)'/);
if (!keyMatch) {
  fail('theme.js 里没有 THEME_KEY');
} else if (!html.includes(keyMatch[1])) {
  fail(`index.html 的防闪脚本没用 THEME_KEY（${keyMatch[1]}），读写会对不上`);
}

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n主题令牌检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}

console.log(
  `✓ 主题令牌检查通过（深色 ${darkTokens.size} 项 / 浅色 ${lightTokens.size} 项一一对应）`
);
