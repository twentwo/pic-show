/**
 * 启动路径检查器：「打开方式」那条路必须做到「主界面不露面 + 焦点自动落在
 * 预览上」，且不能影响常规启动。
 *
 * 为什么单独一个文件：这两件事横跨 Rust 与 JS 两侧，且**失败表现都是静默
 * 的** —— 主界面闪一下、`window_ready` 里的点亮顺序被人挪动一行、焦点少要
 * 一次，都能通过编译、通过令牌检查，只有真机打开才能看出来。这里用静态
 * 扫描把「顺序」和「闸门」钉死。
 *
 * 预览现在是**独立的物理窗口**（`viewer`），所以这里还多盯一件事：两条启动
 * 路径都只能去唤起那个窗口，**绝不能**去碰主窗口的几何 / 形态 / 可见性。
 * 主窗口这次就是不露面的 —— 这是「退出预览后回到原尺寸」的根本保证。
 *
 * 断言分三类：
 *   1. 存在性 —— 该有的命令 / 方法在不在；
 *   2. 顺序 —— 谁必须排在谁后面（这类最容易被「顺手挪一下」破坏）；
 *   3. 分家 —— 全屏只切在预览窗口上，主窗口的几何终身只读。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/**
 * 去掉 Rust 注释，只留代码。
 *
 * 「某个危险调用不该存在」这类断言必须扫代码而不是原文：解释「为什么删掉它」
 * 的注释里必然要提这个名字，扫原文会永远报假警。
 */
function stripComments(src) {
  let out = '';
  let mode = 'code';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === '"') {
        mode = 'string';
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    out += ch;
    if (ch === '"') mode = 'code';
    i += 1;
  }
  return out;
}

const commands = read('src-tauri/src/commands.rs');
const commandsCode = stripComments(commands);
const macosCode = stripComments(read('src-tauri/src/macos.rs'));
const lib = read('src-tauri/src/lib.rs');
const libCode = stripComments(lib);
const state = read('src-tauri/src/state.rs');
const conf = read('src-tauri/tauri.conf.json');
const main = read('ui/js/main.js');
const viewer = read('ui/js/viewer.js');
const viewerMain = read('ui/js/viewer-main.js');
const api = read('ui/js/api.js');
const html = read('ui/viewer.html');

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
  /has_pending_launch\(&self\) -> bool/.test(state) &&
    /launch\.read\(\)\.is_some\(\)/.test(state)
);
// 3 秒兜底是「前端没上报就绪」时的最后一根稻草。它在**打开方式**那条路上必
// 须先问「预览起来了没有」—— 否则用户会在看第三张图的时候被一张图片墙盖住。
ok(
  '3 秒兜底在预览已经接管时不插手（否则主界面会盖到预览上面）',
  /get_webview_window\(commands::VIEWER_LABEL\)[\s\S]{0,240}?if viewer_up \{\s*return;/.test(
    libCode
  )
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
// 冷启动那条路**根本不点亮主窗口**：它只去唤起预览窗口，然后直接 return。
ok(
  '预览分支直接 return，不再走主界面那条路',
  /if \(pending\?\.items\?\.length\) \{\s*await bootLaunch\(pending\)[\s\S]*?\n\s*return;\s*\n/.test(
    main
  )
);
ok(
  '预览发起失败时才点亮主界面（宁可露出图片墙，也不留一个隐身窗口）',
  /if \(!ok\) \{[\s\S]{0,300}?await api\.showWindow\(\)/.test(main)
);

// macOS 的文件不进 argv，只能等事件循环送来 —— 这段等待必须存在且带预算。
ok('前端有「等一等启动意图」的分支', /async function takeLaunchOrWait/.test(main));
ok(
  '等待用的是后端给的绝对预算（不是前端自己拍一个时长）',
  /api\.launchDecisionBudget\(\)/.test(main) && /launch_decision_budget/.test(api)
);
ok(
  '预算从**进程启动时刻**起算（常规启动不被拖慢）',
  /started: Instant::now\(\)/.test(state) &&
    /launch_decision_budget\(&self, budget_ms: u64\)/.test(state)
);

// 两条通道（事件 / 待取件）同时到达时只能处理一次，否则会「开→关→再开」。
ok(
  '同一请求不会被两条通道各处理一遍',
  /function claimLaunch\(payload\)/.test(main) &&
    /if \(launchHandled\) return null;/.test(main) &&
    /const taken = claimLaunch\(payload\);/.test(main)
);

/* ---------------- 2. 两个窗口的物理分家 ---------------- */

console.log('两个窗口：物理分家');

// 预览窗口必须在配置里声明 —— 它是**常驻**的（关闭只是隐藏），这样点图到
// 画面出来之间不必再建一个 webview。
ok(
  'tauri.conf.json 声明了两条窗口（main 与 viewer）',
  /"label": "main"/.test(conf) && /"label": "viewer"/.test(conf)
);
ok(
  '预览窗口独立加载 viewer.html（不是主窗口那个页面）',
  /"url": "viewer\.html"/.test(conf)
);
ok(
  '两条窗口都隐藏启动（避免 webview 加载初期闪一帧白底）',
  (conf.match(/"visible": false/g) || []).length === 2,
  String((conf.match(/"visible": false/g) || []).length)
);
// 保留 Titled 才有 FullScreenPrimary：无边框窗口上 `set_fullscreen` 既不报错
// 也不生效。这条是「摘掉标题栏」那条老路的根因，也是必须绕开的坑。
ok(
  '两条窗口都保留装饰（无边框窗口拿不到原生全屏能力）',
  (conf.match(/"decorations": true/g) || []).length === 2,
  String((conf.match(/"decorations": true/g) || []).length)
);
// 创建期给尺寸不算「写几何」（那是窗口自己的初始状态）。但一旦有人把配置
// 改成 maximized / fullscreen，还原目标就变脏了 —— 而且没有任何一行代码
// 看着像有嫌疑。
ok(
  '两条窗口的初始尺寸都是普通尺寸（不是最大化，也不是全屏）',
  (conf.match(/"width": \d+/g) || []).length === 2 &&
    (conf.match(/"height": \d+/g) || []).length === 2 &&
    !/"maximized":\s*true/.test(conf) &&
    !/"fullscreen":\s*true/.test(conf)
);
// 形状：预览窗口才进全屏，主窗口一次都不进。这条是整个方案的核心 ——
// 主窗口的几何终身只读，退出预览后才可能回到原样。
ok(
  '全屏只切在预览窗口上（主窗口一次都不进全屏）',
  /VIEWER_LABEL\)\?;[\s\S]{0,900}?window\.set_fullscreen\(true\)/.test(commands) &&
    !/MAIN_LABEL[\s\S]{0,200}?set_fullscreen/.test(commands)
);
/* ---------------- 1b. 预览窗口的桌面（Space）必须回收 ---------------- */

console.log('\n预览窗口退出即销毁（不留空白窗口 / 不留多余实例）');

// 旧实现是「常驻窗口 + hide()」：hide 不释放原生全屏独占的桌面；想让 AppKit
// 收掉桌面就得先播一段「整屏缩回 1200×800」的退出全屏转场 —— 那一帧正是用户
// 看到的空白窗口，转场收尾还会把刚藏掉的窗口拉回屏幕。现在改成退出即
// `destroy()`：AppKit 关闭全屏窗口时自己走完 `windowDidExitFullScreen:` 回收
// 桌面，窗口同时从层级里移除，中间没有常规尺寸的可见帧（实测见
// `tools/appkit_fullscreen_exit.swift --close-in-fullscreen`）。
const code = stripComments(commands);

ok(
  '关闭预览走 destroy()，不是 hide / 清空内容 / 摘画布',
  /pub\(crate\) fn release_viewer\(app: &AppHandle\) \{[\s\S]*?window\.destroy\(\)/.test(
    code
  ) && !/\.hide\(\)/.test(code) && !/exit_viewer_fullscreen/.test(code)
);
ok(
  '退出预览不请求「退出全屏」（那一帧就是盖在图片墙上的空白窗口）',
  !/set_fullscreen\(false\)/.test(code)
);
ok(
  '进入预览时按需重建窗口：存在就复用，一条都不多建',
  /fn ensure_viewer_window\(app: &AppHandle\) -> bool \{[\s\S]*?get_webview_window\(VIEWER_LABEL\)\.is_some\(\)[\s\S]*?return true;/.test(
    code
  ) && /WebviewWindowBuilder::from_config\(app, &config\)/.test(code)
);
ok(
  '重建用的是 tauri.conf.json 里同一份配置（不手写复制参数）',
  /app\s*\.config\(\)\s*\.app\s*\.windows\s*\.iter\(\)/.test(code) &&
    /\.find\(\|w\| w\.label\.as_str\(\) == VIEWER_LABEL\)/.test(code)
);
ok(
  '重建后把 viewer_listening 作废（新 webview 还没装配，发事件会掉黑洞）',
  /set_viewer_listening\(false\)/.test(code)
);
ok(
  '销毁后确认 label 已从注册表移除，才叫回主窗口（顺序反过来会被一起提到前台）',
  /confirm_viewer_destroyed\(app\)[\s\S]{0,600}?reveal_main_window\(app\)/.test(code) &&
    /fn confirm_viewer_destroyed[\s\S]*?get_webview_window\(VIEWER_LABEL\)\.is_none\(\)/.test(
      code
    )
);
ok(
  '销毁确认跑在后台线程（不阻塞事件循环处理 Destroyed 事件）',
  /std::thread::spawn\(move \|\| release_viewer\(&handle\)\);/.test(code)
);
ok(
  '让位带世代号，销毁确认期间又开预览就自己作废',
  /let epoch = app\.state::<AppState>\(\)\.viewer_epoch\(\);/.test(code) &&
    /viewer_epoch\(\) != epoch/.test(code) &&
    /pub fn bump_viewer_epoch/.test(state)
);
// 交通灯 / Cmd+W 仍要拦：默认直接销毁会跳过退场动画、索引回填与沉浸式退出。
// 拦下来转前端正常关闭，收摊后由 close_viewer 在后端真正 destroy()。
ok(
  '预览窗口的关闭请求被拦下来（转成前端正常关闭路径）',
  /on_window_event\(\|window, event\|/.test(lib) &&
    /WindowEvent::CloseRequested \{ api, \.\. \} = event/.test(lib) &&
    /window\.label\(\) != commands::VIEWER_LABEL/.test(lib) &&
    /api\.prevent_close\(\);/.test(lib)
);
ok(
  '应用退出（沉浸式预览）前直接销毁预览窗口',
  /pub fn exit_app\(app: AppHandle\) \{[\s\S]*?release_viewer_now\(&app\);[\s\S]*?app\.exit\(0\);/.test(
    code
  )
);
ok(
  '进程退出兜底：ExitRequested 时销毁预览窗口',
  /RunEvent::ExitRequested \{ \.\. \} = event/.test(lib) &&
    /commands::release_viewer_now\(handle\)/.test(lib) &&
    /pub fn release_viewer_now/.test(code) &&
    /window\.destroy\(\)/.test(code)
);
ok(
  '仓库里留有可复跑的「全屏中直接销毁」对照探针',
  /--close-in-fullscreen/.test(read('tools/appkit_fullscreen_exit.swift'))
);
// 图片集合在后端留一份**有序**副本：两个 webview 的「第 N 张」必须是同一张，
// 而注册表本身是 HashMap，遍历顺序不确定。
ok(
  '图片集合在后端有一份有序副本（两个窗口的「第 N 张」指同一张）',
  /current: RwLock<Vec<ImageItem>>/.test(state) &&
    /pub fn all_items\(&self\) -> Vec<ImageItem>/.test(state)
);

/* ---------------- 2a. 能力声明：每条窗口都得有 ---------------- */

console.log('能力声明：每条窗口都得有');

// 这条是被**真机 E2E** 逼出来的：`viewer` 窗口加进 `tauri.conf.json` 之后，
// 能力文件里仍然只有 `["main"]`，于是预览里的 `event.listen` 被拒绝 ——
// 表现是「预览永远收不到会话，应用白屏」。而它在静态检查、探针、`cargo check`
// 里全都是绿的：只有真机跑起来才会暴露。
//
// 能力是按 **window** 授权的：不在任何一条 `windows` 列表里的窗口，连
// `core:event:default` 都拿不到。所以「多一条窗口」从来不止是改配置一件事。
const capFiles = readdirSync(join(root, 'src-tauri/capabilities')).filter((f) =>
  f.endsWith('.json')
);
const caps = capFiles.map((f) => JSON.parse(read(`src-tauri/capabilities/${f}`)));
const labels = (conf.match(/"label": "([^"]+)"/g) ?? []).map(
  (s) => s.match(/"label": "([^"]+)"/)[1]
);
const covered = new Set(caps.flatMap((c) => c.windows ?? []));
const missing = labels.filter((l) => !covered.has(l));

ok(
  '每条窗口都被某条能力声明覆盖（漏了会在运行时被静默拒绝 IPC）',
  labels.length > 0 && missing.length === 0,
  `未覆盖：${missing.join(', ') || '无'}`
);
// 预览那边具体要的两样：收会话的事件通道，以及行内标题栏的拖动
const viewerPerms = caps
  .filter((c) => (c.windows ?? []).includes('viewer'))
  .flatMap((c) => c.permissions ?? []);
ok(
  '预览窗口能收事件（跨窗口的会话中转全靠它）',
  viewerPerms.some((p) => p.startsWith('core:event')),
  viewerPerms.join(', ')
);
ok(
  '预览窗口能拖动行内标题栏（页面里那条才是唯一的标题栏）',
  viewerPerms.includes('core:window:allow-start-dragging')
);

/* ---------------- 2b. 焦点：窗口显示 + 图片落地之后 ---------------- */

console.log('焦点：显示之后、图片落地之后');

ok(
  '预览视图可聚焦（tabindex="-1"）',
  /id="viewer"[^>]*tabindex="-1"/.test(html) &&
    /setAttribute\('tabindex', '-1'\)/.test(viewer)
);
ok('viewer 有「把焦点交给预览」的方法', /  focusView\(\) \{/.test(viewer));
ok('viewer 有「等首图落地再给焦点」的方法', /async focusWhenReady\(/.test(viewer));
// 焦点必须在**首图落地**之后：切全屏是一段 Space 过场动画，会把刚抢到的
// key window 让出去；图片还在解码时落焦点，第一个方向键落在空画面上。
ok(
  '预览侧的焦点交接排在首图落地之后',
  viewerMain.indexOf('await viewer.focusWhenReady()') >
    viewerMain.indexOf('viewer.openLaunch(')
);
ok(
  '两条窗口各有自己的「要焦点」命令（名字分开，不会指错人）',
  /pub fn focus_window\(/.test(commands) &&
    /invoke\('focus_window'\)/.test(api) &&
    /pub fn focus_viewer\(/.test(commands) &&
    /invoke\('focus_viewer'\)/.test(api)
);
// 两条「要焦点」的命令各自守自己的可见性：对还没点亮的窗口要焦点是白要，
// 平台会直接忽略（tao 的第一条判断就是 `isVisible`）。守卫还要排在
// `set_focus()` **之前** —— 反过来就成了一行装饰。
ok(
  '对还没点亮的窗口不白要焦点（平台会直接忽略）',
  ['focus_window', 'focus_viewer'].every((name) => {
    const start = commands.indexOf(`pub fn ${name}(`);
    const end = commands.indexOf('#[tauri::command]', start);
    const body = commands.slice(start, end < 0 ? undefined : end);
    return (
      start > 0 &&
      body.indexOf('is_visible()') > 0 &&
      body.indexOf('is_visible()') < body.indexOf('set_focus()')
    );
  })
);
ok(
  '等首图有超时兜底（加载失败也不能把焦点一直吊着）',
  /function imageReady\(slide, timeout/.test(viewer) && /setTimeout\(finish, timeout\)/.test(viewer)
);
/* ---------------- 2b-2. 让位：窗口必须从层级里真的消失 ---------------- */

console.log('\n让位：窗口必须从层级里真的消失');

// `destroy()` 强制关闭窗口、不发 `CloseRequested` 事件，所以不会绕回前端那条
// 关闭流程造成循环。但它仍是异步生效的：Tauri 收到 `Destroyed` 事件才把 label
// 从注册表移除，在那之前 `set_focus()` 的 `activateIgnoringOtherApps:` 仍可能
// 把预览一起提到前台 —— 顺序必须是「确认移除 → 才叫回主窗口」。
const releaseStart = code.indexOf('pub(crate) fn release_viewer(');
const releaseBody = (code.slice(releaseStart).match(/^[\s\S]*?\n\}\n/) ?? [''])[0];

ok(
  '让位路径里没有裸的 hide()（必须 destroy）',
  releaseStart > 0 &&
    /window\.destroy\(\)/.test(releaseBody) &&
    !/\.hide\(\)/.test(releaseBody)
);
// 取**最后**一次 `reveal_main_window`：函数开头那个「窗口没了」的早退分支里也
// 有一次，它跟让位的顺序无关。
ok(
  '顺序是「先确认窗口消失 → 才叫回主窗口」（反过来 activateIgnoringOtherApps 会把它一起提到前台）',
  releaseBody.indexOf('confirm_viewer_destroyed(app)') > 0 &&
    releaseBody.indexOf('confirm_viewer_destroyed(app)') <
      releaseBody.lastIndexOf('reveal_main_window(app)')
);
// 确认判据是「注册表里还有没有这个 label」，不是去猜 `is_visible()` —— 后者
// 回答的是「画没画出来」，不是「窗口实例还在不在」。
ok(
  '销毁确认查的是窗口注册表里的 label（不靠 is_visible 猜）',
  (() => {
    const start = code.indexOf('fn confirm_viewer_destroyed(');
    const body = code.slice(start, code.indexOf('\nfn ', start + 5));
    return (
      start > 0 &&
      /get_webview_window\(VIEWER_LABEL\)\.is_none\(\)/.test(body) &&
      !/is_visible\(\)/.test(body)
    );
  })()
);
ok(
  '销毁确认期间又开预览就停手（否则会把刚重建的窗口盖住）',
  /pub\(crate\) fn release_viewer[\s\S]*?viewer_epoch\(\) != epoch[\s\S]*?return;/.test(
    code
  )
);
ok(
  '销毁确认有上限，超时也照常叫回主窗口（不能把主窗口永远晾在后头）',
  /const DESTROY_CONFIRM_MS: u64 = \d+;/.test(code) &&
    /while Instant::now\(\) < deadline/.test(code)
);

// 预览关闭后焦点交回主窗口：它全程没被改过几何，叫回来的就是用户最后摆放的
// 那个样子 —— 这正是「退出预览后回到原尺寸」的全部实现。
ok(
  '预览关闭时把主窗口叫回前台（它从来没被改过几何）',
  /confirm_viewer_destroyed\(app\)[\s\S]{0,600}?reveal_main_window\(app\);/.test(code)
);
// 「看到第几张」必须**先**送回去：销毁与确认要占一小段线程，图片墙不能陪着
// 一起等 —— 等用户真的回到那一屏时，它早该滚好了。
ok(
  '索引回填排在让位之前（图片墙不等销毁确认）',
  /pub fn close_viewer\(app: AppHandle, index: usize\) \{[\s\S]*?emit\(VIEWER_CLOSED_EVENT, ViewerClosed \{ index \}\)[\s\S]*?std::thread::spawn\(move \|\| release_viewer\(&handle\)\);/.test(
    code
  )
);

/* ---------------- 2c. 窗口装饰：只在启动时设定一次 ---------------- */

console.log('窗口装饰：终身只设定一次');

// 窗口样式只在**每条窗口诞生时**设定一次（见 `src-tauri/src/macos.rs`）：启动
// 时设一次，预览窗口重建时再跑一次幂等函数。带 `Titled` 的
// 常规窗口由 AppKit 自动授予 `FullScreenPrimary`，运行时不需要、也**不允许**
// 再补这项能力 —— 早先补标记的那段代码跑在 `spawn_blocking` 线程上，拿不到
// `MainThreadMarker`，日志里永远是「不在主线程，跳过」，等于从来没生效过。
// 所以这里断言的是：整条链路里**不存在**任何运行时改窗口装饰的调用。
ok(
  '没有任何一处运行时切换窗口装饰（这是标题栏回不来的根因）',
  !/set_decorations\s*\(/.test(commandsCode) &&
    !/set_decorations\s*\(/.test(macosCode)
);
ok(
  '没有任何 maximize / unmaximize（它是不可撤回的一步）',
  !/(un)?maximize\s*\(/.test(commandsCode) &&
    !/(un)?maximize\s*\(/.test(macosCode)
);
ok(
  '只在 macOS 上引入 AppKit（其它平台不该为这件事付依赖成本）',
  /\[target\.'cfg\(target_os = "macos"\)'\.dependencies\]/.test(
    read('src-tauri/Cargo.toml')
  )
);
// 启动阶段设定一次；预览窗口退出即销毁，重建时 `ensure_viewer_window` 再调
// 同一个函数一次。两处都指向同一个幂等实现，绝不散落在「切换预览」的路径上。
ok(
  '窗口样式只在「启动」与「重建预览窗口」两处设定，且调用同一个函数',
  (lib.match(/run_on_main_thread\(crate::macos::apply_immersive_frame\)/g) || [])
    .length === 1 &&
    (commands.match(/run_on_main_thread\(crate::macos::apply_immersive_frame\)/g) || [])
      .length === 1
);
// 遍历所有窗口、跳过已设过的：每条窗口一生只被设定一次，运行时绝不改动已存在
// 窗口的样式（这正是 tao saved_style 覆盖链不会被触发的原因）。
ok(
  '样式设定跳过已设过的窗口（每条窗口一生只设一次）',
  /NSApplication::sharedApplication\(mtm\)\.windows\(\)/.test(macosCode) &&
    /contains\(NSWindowStyleMask::FullSizeContentView\)/.test(macosCode) &&
    /continue;/.test(macosCode)
);

/* ---------------- 3. 常规启动不能被连累 ---------------- */

console.log('常规启动：行为不变');

ok(
  '无参数启动时仍会点亮主界面，并把焦点给网格',
  /await api\.showWindow\(\);[\s\S]{0,140}?dom\.grid\.focus\(\);/.test(main)
);
// 应用已在跑时再从 Finder 打开另一张：后端直接把预览推到那一张，前端只更新
// 网格数据 —— 主窗口一个字都不碰。
ok(
  '应用已在跑时从 Finder 打开，由后端直接唤起预览',
  /if state\.is_ready\(\) \{[\s\S]{0,400}?open_viewer\(app\.clone\(\), payload\.index, None, true\);/.test(
    commands
  )
);
ok(
  '前端那条路只更新网格数据（不重复唤起预览）',
  /function adoptLaunch\(payload\) \{\s*load\(\{ items: payload\.items, source: payload\.source \}\);\s*\}/.test(
    main
  )
);
// 用户在预览里翻到第几张，退出后图片墙就停在第几张。
ok(
  '预览关闭时把当前索引送回主窗口（两个窗口唯一反向的状态流动）',
  /emit\(VIEWER_CLOSED_EVENT, ViewerClosed \{ index \}\)/.test(commands) &&
    /onViewerClosed\(\(payload\) => \{[\s\S]{0,300}?grid\.ensureVisible\(index\);/.test(
      main
    )
);

/* ---------------- 汇总 ---------------- */

if (problems) {
  console.error(`\n检查未通过：共 ${problems} 处问题`);
  process.exit(1);
}
console.log('\n✓ 启动路径与焦点检查全部通过');
