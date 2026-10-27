/**
 * 启动路径检查器：「打开方式」那条路必须做到「主界面不露面 + 焦点自动落在
 * 预览上」，且不能影响常规启动。
 *
 * 为什么单独一个文件：这两件事横跨 Rust 与 JS 两侧，且**失败表现都是静默
 * 的** —— 主界面闪一下、`window_ready` 里的点亮顺序被人挪动一行、焦点少要
 * 一次，都能通过编译、通过令牌检查，只有真机打开才能看出来。这里用静态
 * 扫描把「顺序」和「闸门」钉死。
 *
 * 断言分两类：
 *   1. 存在性 —— 该有的命令 / 方法在不在；
 *   2. 顺序 —— 谁必须排在谁后面（这类最容易被「顺手挪一下」破坏）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const commands = read('src-tauri/src/commands.rs');
const lib = read('src-tauri/src/lib.rs');
const main = read('ui/js/main.js');
const viewer = read('ui/js/viewer.js');
const api = read('ui/js/api.js');
const html = read('ui/index.html');

let problems = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${extra ? ' :: ' + extra : ''}`);
    problems += 1;
  }
};

/* ---------------- 1. 主界面绝不能在这条路上出现 ---------------- */

console.log('启动：主界面不露面');

// 后端的最后一道闸门：被要求打开图片、且那份请求还没被取走 → 拒绝点亮。
ok(
  'window_ready 对「已被预览接管」的启动拒绝点亮',
  /was_launched\(\)\s*&&\s*state\.has_pending_launch\(\)/.test(commands)
);
ok(
  '闸门只拦「还有待取件」的那一瞬间（取走之后仍可兜底点亮）',
  /has_pending_launch\(&self\) -> bool/.test(read('src-tauri/src/state.rs')) &&
    /launch\.read\(\)\.is_some\(\)/.test(read('src-tauri/src/state.rs'))
);

// 启动意图在最前面判定，不能等到前端加载完再猜。
ok(
  '进程参数在 build() 之前就判定（不等首屏竞速）',
  lib.indexOf('let cli_targets = commands::argv_targets();') <
    lib.indexOf('tauri::Builder::default()'),
  `${lib.indexOf('let cli_targets')} / ${lib.indexOf('tauri::Builder::default()')}`
);

// 前端：只有「确认不是预览启动」之后才点亮主界面。
const showAt = main.indexOf('await api.showWindow();');
const decideAt = main.indexOf('await takeLaunchOrWait()');
ok(
  '顺序是「先判定启动意图 → 才可能点亮主界面」',
  decideAt > 0 && showAt > decideAt,
  `${decideAt} / ${showAt}`
);
ok(
  '预览分支点亮窗口后直接 return，不再走主界面那条路',
  /if \(pending\?\.items\?\.length\) \{\s*await bootLaunch[\s\S]*?return;/.test(main)
);

// macOS 的文件不进 argv，只能等事件循环送来 —— 这段等待必须存在且带预算。
ok('前端有「等一等启动意图」的分支', /async function takeLaunchOrWait/.test(main));
ok(
  '等待用的是后端给的绝对预算（不是前端自己拍一个时长）',
  /api\.launchDecisionBudget\(\)/.test(main) && /launch_decision_budget/.test(api)
);
ok(
  '预算从**进程启动时刻**起算（常规启动不被拖慢）',
  /started: Instant::now\(\)/.test(read('src-tauri/src/state.rs')) &&
    /launch_decision_budget\(&self, budget_ms: u64\)/.test(read('src-tauri/src/state.rs'))
);

// 两条通道（事件 / 待取件）同时到达时只能处理一次，否则会「开→关→再开」。
ok(
  '同一请求不会被两条通道各处理一遍',
  /function claimLaunch\(payload\)/.test(main) &&
    /if \(launchHandled\) return null;/.test(main) &&
    /const taken = claimLaunch\(payload\);/.test(main)
);

/* ---------------- 2. 焦点：窗口显示 + 图片落地之后 ---------------- */

console.log('焦点：显示之后、图片落地之后');

// show → maximize → set_focus，顺序不能变。
// 只看 `prepare_launch_window` 自己的函数体：文件里别处也有 maximize
// （apply_immersive_window），整文件比下标会认错人。
const prepareBody = (() => {
  const start = commands.indexOf('pub fn prepare_launch_window');
  const end = commands.indexOf('#[tauri::command]', start);
  return start < 0 ? '' : commands.slice(start, end < 0 ? undefined : end);
})();
const showIdx = prepareBody.indexOf('reveal_main_window(&app);');
const maxIdx = prepareBody.indexOf('window.maximize();');
const focusIdx = prepareBody.indexOf('window.set_focus()');
ok(
  'maximize 排在 show 之后（对隐藏窗口 maximize 不可靠）',
  showIdx > 0 && maxIdx > showIdx,
  `${showIdx} / ${maxIdx}`
);
ok(
  'set_focus 排在 maximize 之后（zoom 会把 key window 让出去）',
  focusIdx > maxIdx,
  `${focusIdx} / ${maxIdx}`
);
ok(
  '有一条独立的「要焦点」命令供前端在图片落地后调用',
  /pub fn focus_window\(/.test(commands) && /invoke\('focus_window'\)/.test(api)
);
ok(
  '对还没点亮的窗口不白要焦点（平台会直接忽略）',
  /is_visible\(\)\.unwrap_or\(false\)/.test(commands)
);
ok(
  '两个新命令都注册进了 invoke_handler',
  /commands::focus_window/.test(lib) && /commands::launch_decision_budget/.test(lib)
);

ok(
  '预览视图可聚焦（tabindex="-1"）',
  /id="viewer"[^>]*tabindex="-1"/.test(html) &&
    /setAttribute\('tabindex', '-1'\)/.test(viewer)
);
ok('viewer 有「把焦点交给预览」的方法', /  focusView\(\) \{/.test(viewer));
ok('viewer 有「等首图落地再给焦点」的方法', /async focusWhenReady\(/.test(viewer));
ok(
  '焦点交接排在启动分支的最后一步',
  /async function handOverFocus\(\)/.test(main) &&
    main.indexOf('await handOverFocus();') > main.indexOf('viewer.openLaunch(')
);
ok(
  '等首图有超时兜底（加载失败也不能把焦点一直吊着）',
  /function imageReady\(slide, timeout/.test(viewer) && /setTimeout\(finish, timeout\)/.test(viewer)
);

/* ---------------- 3. 常规启动不能被连累 ---------------- */

console.log('常规启动：行为不变');

ok(
  '无参数启动时仍会点亮主界面',
  /await api\.showWindow\(\);\s*\n\s*windowShown = true;/.test(main)
);
ok(
  '网格焦点只在非沉浸式分支上给（不再无条件抢焦点）',
  /if \(!document\.body\.classList\.contains\('is-immersive'\)\) dom\.grid\.focus\(\);/.test(
    main
  ) && !/^dom\.grid\.focus\(\);$/m.test(main)
);
ok(
  '应用已在跑时再从 Finder 打开，走的是「关掉旧的再开新的」',
  /if \(!windowShown\) \{\s*await bootLaunch\(payload\);\s*return;/.test(main) &&
    /if \(viewer\.isOpen\) \{/.test(main)
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 启动路径与焦点检查全部通过');
