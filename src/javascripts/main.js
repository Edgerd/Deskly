/**
 * main.js — 宿主首屏入口
 *
 * index.html 里 main.js 排在所有模块之前，而 ES module 的求值顺序就是 import
 * 声明顺序，所以这里只做一件事：把 log.js 提前求值。log.js 一求值就接管
 * console.* 与全局异常，随后 plugin-manager / finderbar / dock 在求值期打的
 * warn、error 才有地方归档；反过来（把 log 留给 bootstrap 这个最后一个 script）
 * 就会漏掉启动最早的报错 —— 而那正是最需要留证据的一段。
 *
 * 设置定义表与其余初始化统一由 bootstrap.js 排序，避免两处重复调用。
 */

import "./log.js";

/** 把 body 高度钉成视口高度，规避移动端地址栏伸缩造成的 100vh 抖动。 */
function resetHeight() {
    document.body.style.height = `${window.innerHeight}px`;
}

resetHeight();

["resize", "orientationchange", "load"].forEach((e) => window.addEventListener(e, resetHeight));

// 禁用浏览器原生右键菜单（开关本身是一个设置项，见 contextMenuSettings.js）
import "./contextMenuSettings.js";

// 挂载全局通知接口 window.__notify（模块无副作用调用，仅注册入口，见 ui/notification.js）
import "./ui/notification.js";
