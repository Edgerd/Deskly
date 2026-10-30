import { createAlert } from "./ui/alert.js";
import { FINDER_ICON } from "./paths.js";

function isMobileDevice() {
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    const mobileRegex = /android|iphone|ipod|blackberry|iemobile|opera mini|mobile|windows phone|phone|webos|kindle|tablet/i;
    return mobileRegex.test(ua.toLowerCase());
}

function clientCheck() {
    if (isMobileDevice()) {
        const overlay = document.createElement("div");
        overlay.className = "overlay";
        document.body.append(overlay);
        document.body.style.overflow = "hidden";
        createAlert(FINDER_ICON, "客户端不兼容", "请使用电脑端访问 Deskly", "好", "close");
        // 隐藏 Dock 要连 .dockcontainer 一起处理：只藏 .dock 的话外层盒子仍在，
        // 移动端下会留出一条占位并挡住点击
        document.querySelector(".dock")?.style.setProperty("display", "none");
        document.querySelector(".dockcontainer")?.style.setProperty("display", "none");
    }
}

// 用 addEventListener 而不是 window.onload =：finderbar.js 也注册了 load 钩子，
// 赋值式写法会让后加载的那个（本文件）直接覆盖掉前一个，finderbar 的初始化从此不执行。
window.addEventListener("load", clientCheck);