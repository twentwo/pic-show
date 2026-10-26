/**
 * 后端 API 门面：命令调用 + 图片地址构造 + 前端解码缓存。
 */

import { invoke, listen, isTauri, showWindow } from './tauri.js';

export { isTauri, showWindow };

/* ------------------------------------------------------------------ *
 * 图片地址（由 src-tauri/src/protocol.rs 提供）
 * ------------------------------------------------------------------ */

/** 网格目标行高（px） */
export const GRID_ROW_H = 210;

/**
 * 缩略图请求尺寸。
 *
 * 关键点：网格和全屏查看器必须用**同一个**尺寸，这样从网格点开大图时
 * 低分辨率底图能直接命中 webview 缓存，做到「秒开」而不是重新解码。
 */
export const THUMB_SIZE = (() => {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(1024, Math.round(GRID_ROW_H * 2 * dpr));
})();

/** 缩略图：最长边 = size 像素 */
export const thumbUrl = (id, size = THUMB_SIZE) =>
    `img://localhost/thumb/${id}?s=${size}`;

/** 模糊占位图：~24px，几百字节 */
export const placeholderUrl = (id) => `img://localhost/placeholder/${id}`;

/** 原图；传 max 则超过时等比缩小后重编码 */
export const fullUrl = (id, max = 0) =>
    `img://localhost/full/${id}${max ? `?max=${max}` : ''}`;

/** 超过这个像素量就改用降采样原图，避免 webview 解码爆内存 */
const HUGE_PIXELS = 40_000_000;
const HUGE_EDGE = 4096;

export function maxEdgeFor(item) {
    return item?.width && item?.height && item.width * item.height > HUGE_PIXELS
        ? HUGE_EDGE
        : 0;
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

/** 弹出系统选择框；结果通过 onItems 事件异步返回 */
export const pickImages = (kind = 'files') => invoke('pick_images', { kind });

export const openFolder = (path) => invoke('open_folder', { path });

export const openPaths = (paths) => invoke('open_paths', { paths });

export const revealImage = (id) => invoke('reveal_image', { id });

export const cacheStats = () => invoke('cache_stats');

/** 监听图片集合更新（弹窗选择 / 拖放都会触发） */
export const onItems = (handler) =>
    listen('picshow://items', (event) => handler(event.payload));

/* ------------------------------------------------------------------ *
 * 前端解码缓存
 *
 * 后端已有「内存 LRU + 磁盘」两级缓存，这里再补一层：只要把 Image 对象
 * 持有住不放，浏览器就不会回收它的解码结果，于是回看上一张/下一张是零延迟。
 * 容量用简单的 FIFO 控制。
 * ------------------------------------------------------------------ */

const MAX_KEPT = 12;
const kept = [];

/**
 * 预加载一张图片（不阻塞、不抛错）。
 * @param {string} src
 * @param {'high'|'low'|'auto'} priority
 * @returns {Promise<HTMLImageElement|null>}
 */
export function preload(src, priority = 'low') {
    if (!src) return Promise.resolve(null);

    const img = new Image();
    img.decoding = 'async';
    try {
        img.fetchPriority = priority;
    } catch {
        /* 老版本 webview 忽略 */
    }

    const promise = new Promise((resolve) => {
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
    });

    img.src = src;

    kept.push(img);
    while (kept.length > MAX_KEPT) kept.shift();

    return promise;
}
