/**
 * script.js — 系统设置入口（每次打开都会重新执行）
 *
 * 注入方式决定了这个文件的写法：plugin-manager 用 `?v=Date.now()` 的全新 URL 追加
 * `<script type="module" plugin="system-settings">`，所以本文件每次打开都是一份**新实例**，
 * 顶层代码每次都会跑；而 app.js / ui.js / 各面板模块的 URL 是稳定的，整个会话只有一份实例。
 *
 * 由此得出两条分工：
 * - 本文件只做一件事：调用 boot()，让 app.js 先释放上一次遗留的全局监听与面板状态，再重新装配；
 * - 一切 document/window 级监听都登记在 app.js 里（摘掉再挂），绝不写在这里，
 *   否则每次打开都多挂一份，且旧的那份还拖着已经卸载的 DOM。
 */

import { boot } from "./app.js";

boot();
