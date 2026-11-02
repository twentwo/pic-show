/**
 * 前端 JS 语法检查。
 *
 * 为什么要有这一步：项目里其余的检查器全是**正则匹配源码文本**，它们看不见
 * 「这个文件根本解析不了」。于是 `const X` 重复声明、少一个括号这类错误一路
 * 绿灯，直到跑浏览器探针才炸，而那一轮要几分钟。这个检查跑在 `npm run check`
 * 的最前面，几毫秒就能把这一整类问题挡在门外。
 *
 * 做法：把每个 `.js` 复制成临时 `.mjs` 再交给 `node --check`。
 * `node --check` 按 CommonJS 解析 `.js`，顶层 `import` 会被判为语法错误；
 * 换成 `.mjs` 才按 ES module 解析 —— 而 `ui/js` 全是原生 ESM。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 收集目录下所有 .js 文件（递归） */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [
  ...collect(join(root, 'ui', 'js')),
  ...collect(join(root, 'tools'))
];

let problems = 0;
const tmp = mkdtempSync(join(tmpdir(), 'picshow-syntax-'));

try {
  for (const file of files) {
    const rel = file.slice(root.length + 1);
    const staged = join(tmp, 'check.mjs');
    copyFileSync(file, staged);
    try {
      execFileSync(process.execPath, ['--check', staged], { stdio: 'pipe' });
    } catch (error) {
      const message = String(error.stderr ?? error.message)
        .split('\n')
        .filter(Boolean)
        .slice(0, 4)
        .join('\n      ');
      console.log(`  ✗ ${rel}\n      ${message}`);
      problems += 1;
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems) {
  console.error(`\n语法检查未通过：${problems} 个文件解析失败`);
  process.exit(1);
}
console.log(`  ✓ ${files.length} 个 JS 文件语法正确（按 ES module 解析）`);
