/**
 * 带兜底的异步小工具。
 *
 * 存在的理由只有一条：**`requestAnimationFrame` 是会停的**。
 *
 * 窗口在做全屏转场、被最小化、被别的程序盖住、用户切走了 Space —— 这些时候
 * 浏览器不再产生帧，rAF 的回调就停摆，而且不通知任何人。于是任何「await 到
 * 下一帧」的写法在这些时刻都会把整条 await 链**永久挂起**；而那条链一旦排在
 * 关闭流程上，界面就再也收不回来 —— 表现正是「退出预览后页面卡死」。
 *
 * 所以这里每个「等帧」的函数都同时挂一个 `setTimeout` 兜底：帧来了就按帧走
 * （快且准），帧不来也一定在预算内兑现。多等几十毫秒没人看得出来，卡死不能
 * 接受。同理，给任意 Promise 加硬超时的 `withTimeout()` 也放在这里 ——
 * 「等一个 IPC / 等一段动画」跟「等一帧」是同一类风险。
 */

/**
 * 给任意 Promise 加硬超时。
 *
 * 超时**不会**取消原来那个 Promise —— 它继续在后台跑（比如切全屏那一段平台
 * 转场该走完还是会走完），只是调用方不再等它。这正是想要的性质：界面不能
 * 等，但活儿还得干完。
 *
 * @template T
 * @param {Promise<T>|T} promise
 * @param {number} ms 最多等这么久
 * @returns {Promise<T|undefined>} 超时兑现为 undefined
 */
export function withTimeout(promise, ms) {
  let timer = 0;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    guard
  ]);
}

/**
 * 等 n 个渲染帧（帧停摆时按预算兜底兑现）。
 *
 * @param {number} n
 * @param {number} [budgetMs] 兜底预算。默认给足 8 帧的余量。
 */
export function nextFrames(n, budgetMs = 400) {
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = n;
    let timer = 0;
    const finish = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      resolve();
    };
    timer = setTimeout(finish, budgetMs);
    const step = () => {
      if (!timer) return; // 兜底已经兑现，别再重复 resolve
      left -= 1;
      if (left <= 0) finish();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * 等条件成立，最多等 `maxFrames` 帧（帧停摆时按预算兜底兑现）。
 *
 * 为什么要有上限：万一某个平台到了帧数还没把布局铺到目标尺寸，宁可按旧
 * 尺寸先跑起来，也不能让用户盯着黑屏 —— 更不能在帧停摆时永远等下去。
 *
 * @param {() => boolean} predicate
 * @param {number} [maxFrames]
 * @param {number} [budgetMs]
 */
export function waitFor(predicate, maxFrames = 8, budgetMs = 600) {
  return new Promise((resolve) => {
    let left = maxFrames;
    let timer = 0;
    const finish = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      resolve();
    };
    timer = setTimeout(finish, budgetMs);
    const step = () => {
      if (!timer) return;
      let hit = false;
      try {
        hit = Boolean(predicate());
      } catch {
        // 判定自己炸了就别再等：那说明环境已经不是我们预期的样子
        hit = true;
      }
      if (hit) {
        finish();
        return;
      }
      left -= 1;
      if (left <= 0) finish();
      else requestAnimationFrame(step);
    };
    // 第一次同步判一次：条件已经成立时不该白等一帧
    step();
  });
}
