#!/usr/bin/env node
/**
 * 「退出预览」路径的端到端回归。
 *
 * 为什么单独一个：`ui/probe.html` 里的 viewer 是探针自己 new 出来的，走的是
 * `viewer.open()` —— 那条路**不经过**宿主的形态切换（`useImmersiveStage`）、
 * 不经过幕布（`prime()`），也不经过「关闭前把窗口形态还回来」那个钩子。而
 * 「退出预览后页面卡死」恰恰只可能发生在宿主这条链上：探针全绿而真机卡死，
 * 正是因为这一段从来没有被覆盖过。
 *
 * 所以这里加载**真实的 `main.js`**，用一份可记录、可失败的假 IPC 驱动它，
 * 跑三种退出方式 × 多次进出，外加连按 Esc、快速连击、幕布期取消。
 *
 * 用法：`npm run test:exit`（会自己起静态服务器；浏览器路径可用
 * `PICTAURI_BROWSER` 覆盖）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PICTAURI_PORT || 1499);
const URL_PROBE = `http://127.0.0.1:${PORT}/exit_probe.html`;
const BROWSER =
  process.env.PICTAURI_BROWSER ||
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((done) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    sock.on('connect', () => {
      sock.destroy();
      done(true);
    });
    sock.on('error', () => done(false));
  });
}

async function ensureServer() {
  const child = spawn(process.execPath, [resolve(here, 'serve.js')], {
    stdio: 'ignore',
    env: { ...process.env, PICTAURI_PORT: String(PORT) }
  });
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    if (await portOpen(PORT)) return child;
  }
  child.kill();
  throw new Error('静态服务器未能启动');
}

const server = await ensureServer();
let failed = 0;
try {
  const res = spawnSync(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      // 同上：`--no-sandbox` 只用于本地无头探针（只加载 127.0.0.1 上的自有
      // 页面）；部分环境下 Chrome 起不来自己的沙箱会直接崩退出，那看起来
      // 就像「页面脚本卡住」，其实是浏览器没起来。
      '--no-sandbox',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      `--window-size=${process.env.PICTAURI_SIZE || '1440,900'}`,
      '--virtual-time-budget=120000',
      '--dump-dom',
      URL_PROBE
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240000 }
  );
  const dom = res.stdout ?? '';
  const m = dom.match(/<pre[^>]*id="out"[^>]*>([\s\S]*?)<\/pre>/);
  const text = m
    ? m[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim()
    : null;

  if (!text || text === 'running') {
    console.error('✗ 退出路径探针未跑完（脚本被卡住或抛错）');
    process.exitCode = 1;
  } else {
    const lines = text.split('\n').filter(Boolean);
    const bad = lines.filter((l) => !l.startsWith('PASS'));
    for (const line of bad) console.log(`  ${line}`);
    console.log(`  ${lines.length - bad.length} / ${lines.length} 项通过`);
    failed = bad.length;
  }
} finally {
  server?.kill();
}

if (failed) {
  console.error(`\n退出路径探针未通过：${failed} 处`);
  process.exitCode = 1;
} else {
  console.log('\n✓ 退出路径探针全部通过');
}
