/**
 * 静默故障检查器：跨文件核对「被调用的 this.*() 方法」与「导入的符号」是否真实存在。
 *
 * 为什么需要它：本项目前端是零打包器的原生 ES Module。打包器会在构建期
 * 报出「方法未定义」「导入了不存在的符号」，而原生 ESM 只在**运行到那一行**
 * 时才抛错——于是故障表现为「按钮没反应」「列表永远是空的」这类
 * 看不出因果的现象，排查成本极高。这里用静态扫描把它们提前拦住。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsDir = resolve(here, '../ui/js');

/** 通过选项传入、不在本类里定义的回调名 */
const OPTION_CALLBACKS = new Set([
  'onError',
  'onChange',
  'onDismissProgress',
  'onDismissRelease',
  'onTap',
  'onDoubleTap',
  'onUserActivity',
  'onActivate'
]);

/** 类方法：`  name(...) {` / `  async name(...) {` / `  get name(...) {` */
const RE_DEFINED = /^ {2}(?:async\s+|get\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
/** 顶层函数：`function name(` */
const RE_TOP_FN = /^function\s+([A-Za-z_$][\w$]*)/gm;
/** 构造器里通过选项传入的回调：`this.onJump = onJump;` */
const RE_ASSIGNED = /this\.([A-Za-z_$][\w$]*)\s*=[^=]/g;
/** 调用：`this.name(` */
const RE_CALLED = /this\.([A-Za-z_$][\w$]*)\s*\(/g;
/** 可选调用：`this.name?.(` */
const RE_OPT_CALLED = /this\.([A-Za-z_$][\w$]*)\s*\?\.\(/g;
/** 具名导入：`import { a, b as c } from './x.js'` */
const RE_IMPORT = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]+)\}\s+from\s+'([^']+)'/g;

const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const sources = new Map(files.map((f) => [f, readFileSync(join(jsDir, f), 'utf8')]));

let problems = 0;

/* ---------------- 1. this.*() 方法是否都有定义 ---------------- */

for (const [file, src] of sources) {
  const defined = new Set([
    ...[...src.matchAll(RE_DEFINED)].map((m) => m[1]),
    ...[...src.matchAll(RE_TOP_FN)].map((m) => m[1]),
    ...[...src.matchAll(RE_ASSIGNED)].map((m) => m[1])
  ]);

  const called = new Set([
    ...[...src.matchAll(RE_CALLED)].map((m) => m[1]),
    ...[...src.matchAll(RE_OPT_CALLED)].map((m) => m[1])
  ]);

  const missing = [...called].filter(
    (c) => !defined.has(c) && !OPTION_CALLBACKS.has(c)
  );
  if (missing.length) {
    console.log(`✗ ${file}: 未定义的方法 -> ${missing.join(', ')}`);
    problems += missing.length;
  }
}

/* ---------------- 2. 具名导入的符号是否真的被导出 ---------------- */

const exportsOf = (src) => {
  const out = new Set();
  for (const m of src.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  )) out.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop();
      if (alias) out.add(alias.trim());
    }
  }
  return out;
};

for (const [file, src] of sources) {
  for (const m of src.matchAll(RE_IMPORT)) {
    const target = m[2].replace(/^\.\//, '');
    if (!sources.has(target)) {
      console.log(`✗ ${file}: 导入了不存在的模块 ${m[2]}`);
      problems += 1;
      continue;
    }
    const avail = exportsOf(sources.get(target));
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const n of names) {
      if (!avail.has(n)) {
        console.log(`✗ ${file}: ${m[2]} 未导出 ${n}`);
        problems += 1;
      }
    }
  }
}

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}

console.log('✓ 方法 / 导入检查全部通过');
