#!/usr/bin/env node
/**
 * 画廊交互的无头回归探针。
 *
 * 为什么需要它：`ui/` 是零打包器的原生 ES Module，切图状态机、轨道偏移、
 * 槽位轮转、胶片条这些逻辑**没有任何构建期检查**，跑错了只会表现为
 * 「画面跳一下」「点不动」这类难以复现的现象。这里把它们变成可断言的行为。
 *
 * 用法：`npm run probe`（会自己起静态服务器；浏览器路径可用
 * `PICTAURI_BROWSER` 覆盖）。桌面与窄屏两种尺寸各跑一遍。
 *
 * 注意 1：无头环境拿不到合成帧，`element.animate()` 永远不会 finished，
 * 所以探针里把它替换成「立刻完成」的替身。动画的终值本来就是代码预写进
 * inline style 的，状态与布局依然真实，只是省掉了那 300ms 的过程。
 * 注意 2：无头环境下 ResizeObserver 的回调只在**产生渲染帧时**才投递，
 * 而页面里没人请求动画帧（真实 Tauri 窗口每帧都在跑，不存在这个问题）。
 * 所以改完尺寸要手动 `pump()` 泵几帧。虚拟时间下每帧约消耗 1000ms 预算，
 * 故 budget 给到 60s。
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PICTAURI_PORT || 1420);
const URL_PROBE = `http://localhost:${PORT}/probe.html`;

const BROWSER =
  process.env.PICTAURI_BROWSER ||
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const SIZES = [
  { name: '桌面 1440×900', size: '1440,900' },
  { name: '窄屏 414×896', size: '414,896' }
];

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
  if (await portOpen(PORT)) return null;
  const child = spawn(process.execPath, [resolve(here, 'serve.js')], {
    stdio: 'ignore',
    detached: false
  });
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    if (await portOpen(PORT)) return child;
  }
  child.kill();
  throw new Error(`静态服务器未能在 ${PORT} 端口启动`);
}

function runBrowser(size) {
  const res = spawnSync(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      // `--no-sandbox` 只用于这个本地无头探针：它只加载 127.0.0.1 上的
      // 自有页面。某些环境（CI 容器、受限的终端沙箱）里 Chrome 起不来
      // 自己的沙箱，会报 "Failed to initialize sandbox" 并直接崩退出，
      // 于是探针「未跑完」—— 看起来像页面脚本卡住，其实是浏览器没起来。
      '--no-sandbox',
      // 不禁用后台降频的话，页面加载完之后 headless 就不再产生渲染帧，
      // requestAnimationFrame 永不回调，依赖「RO → rAF → 重排」的尺寸
      // 自适应断言就会假失败（真实 Tauri 窗口不存在这个问题）。
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      `--window-size=${size}`,
      '--virtual-time-budget=60000',
      '--dump-dom',
      URL_PROBE
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return res.stdout ?? '';
}

function extract(dom) {
  const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

const server = await ensureServer();
let failed = 0;

try {
  for (const { name, size } of SIZES) {
    const text = extract(runBrowser(size));
    console.log(`\n── ${name} ──`);
    if (!text || text === 'running') {
      console.log('✗ 探针未跑完（页面脚本可能被卡住或抛错）');
      failed += 1;
      continue;
    }
    const lines = text.split('\n').filter(Boolean);
    const bad = lines.filter((l) => !l.startsWith('PASS'));
    for (const line of bad) console.log(`  ${line}`);
    console.log(`  ${lines.length - bad.length} / ${lines.length} 项通过`);
    failed += bad.length;
  }
} finally {
  server?.kill();
}

if (failed) {
  console.error(`\n画廊探针未通过：${failed} 处`);
  process.exit(1);
}
console.log('\n✓ 画廊探针全部通过');
