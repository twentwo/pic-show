/**
 * geometry.js 的纯数学验证。
 *
 * 缩放 / 平移 / FLIP 转场的手感全部压在这几个函数上，
 * 手改参数后跑一遍就能确认没有把边界条件搞坏。
 *
 *   node tools/test_geometry.mjs
 */

import assert from 'node:assert/strict';
import {
  clamp,
  rubberband,
  fitBox,
  panBounds,
  settle,
  zoomAround,
  mapBoxToRect,
  isMostlyVertical
} from '../ui/js/geometry.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
    process.exitCode = 1;
  }
}

const VIEW = { left: 0, top: 0, w: 1200, h: 800 };
const BASE = fitBox(4000, 3000, 1200, 800); // 1200 x 900 → 等比后应为 1067 x 800

console.log('geometry');

test('clamp 收敛到区间', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('fitBox 保持宽高比且不超出容器', () => {
  const box = fitBox(4000, 3000, 1200, 800);
  assert.ok(Math.abs(box.w / box.h - 4 / 3) < 0.01, `比例失真: ${box.w}x${box.h}`);
  assert.ok(box.w <= 1200 && box.h <= 800);
  assert.ok(box.w === 1200 || box.h === 800, '应有一条边贴合容器');
});

test('fitBox 遇到 0 尺寸回退为容器大小', () => {
  assert.deepEqual(fitBox(0, 0, 1200, 800), { w: 1200, h: 800 });
});

test('panBounds 在内容小于视口时为 0', () => {
  const b = panBounds(VIEW, BASE, 1);
  assert.equal(b.maxX, 0);
  assert.equal(b.maxY, 0);
});

test('panBounds 随缩放线性增长', () => {
  const b = panBounds(VIEW, BASE, 2);
  // 高 800 * 2 = 1600，超出视口 800 → 单向可移动 400
  assert.ok(Math.abs(b.maxY - 400) < 0.51, `maxY=${b.maxY}`);
});

test('rubberband 单调递增且渐近于 limit', () => {
  const limit = 140;
  assert.equal(rubberband(0, limit), 0);
  assert.ok(rubberband(10, limit) > 0);
  assert.ok(rubberband(100, limit) > rubberband(10, limit));
  assert.ok(rubberband(10_000_000, limit) < limit, '不得越过上限');
});

test('rubberband 对负向输入对称', () => {
  assert.ok(rubberband(-80, 140) < 0);
  assert.ok(Math.abs(rubberband(-80, 140) + rubberband(80, 140)) < 1e-9);
});

test('settle 在边界内原样返回', () => {
  const s = settle(VIEW, BASE, 2, 100, 100, 140);
  assert.ok(Math.abs(s.x - 100) < 1e-9);
  assert.ok(Math.abs(s.y - 100) < 1e-9);
});

test('settle 超出边界时走阻尼而非硬截断', () => {
  // scale=2 时：maxX=467，maxY=400
  const s = settle(VIEW, BASE, 2, 900, 900, 140);
  assert.ok(s.x > 467, `x 应允许少量越界，实际 ${s.x}`);
  assert.ok(s.x < 467 + 140, `x 越界量应受上限约束，实际 ${s.x}`);
  assert.ok(s.y > 400, `y 应允许少量越界，实际 ${s.y}`);
  assert.ok(s.y < 400 + 140, `y 越界量应受上限约束，实际 ${s.y}`);
});

test('settle 负向越界同样受橡皮筋约束', () => {
  const s = settle(VIEW, BASE, 2, -900, -900, 140);
  assert.ok(s.x < -467, `x 应允许少量负向越界，实际 ${s.x}`);
  assert.ok(s.x > -467 - 140, `x 越界量应受上限约束，实际 ${s.x}`);
  assert.ok(s.y < -400, `y 应允许少量负向越界，实际 ${s.y}`);
  assert.ok(s.y > -400 - 140, `y 越界量应受上限约束，实际 ${s.y}`);
});

test('zoomAround 让锚点在缩放后保持不动', () => {
  // 内容坐标 q 在屏幕上的位置 = t + q*s；缩放后应仍是 p
  const t = { x: 20, y: -30 };
  const p = { x: 120, y: 60 };
  const ratio = 2;
  const t2 = zoomAround(t, p, ratio);
  // q = (p - t) / s；取 s=1，则 q = p - t
  const q = { x: p.x - t.x, y: p.y - t.y };
  // 缩放后 s' = ratio，屏幕上位置 = t' + q * ratio
  assert.ok(Math.abs(t2.x + q.x * ratio - p.x) < 1e-9, 'x 锚点漂移');
  assert.ok(Math.abs(t2.y + q.y * ratio - p.y) < 1e-9, 'y 锚点漂移');
});

test('mapBoxToRect 起点矩形能精确映射回缩略图位置', () => {
  const rect = { left: 300, top: 120, width: 320, height: 240 };
  const { scale, tx, ty } = mapBoxToRect(BASE, rect, VIEW);
  // 把居中内容框按 (scale, tx, ty) 变换后，中心应落在 rect 中心
  const center = {
    x: VIEW.left + VIEW.w / 2 + tx,
    y: VIEW.top + VIEW.h / 2 + ty
  };
  assert.ok(
    Math.abs(center.x - (rect.left + rect.width / 2)) < 0.01,
    `中心 x 偏移: ${center.x}`
  );
  assert.ok(
    Math.abs(center.y - (rect.top + rect.height / 2)) < 0.01,
    `中心 y 偏移: ${center.y}`
  );
  assert.ok(Math.abs(BASE.w * scale - rect.width) < 0.01, '宽度映射不符');
});

test('isMostlyVertical 判定下拉手势方向', () => {
  assert.equal(isMostlyVertical(10, 40), true);
  assert.equal(isMostlyVertical(40, 10), false);
  assert.equal(isMostlyVertical(30, 30), true); // 相等时偏向下拉，避免误判为平移
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}`);
