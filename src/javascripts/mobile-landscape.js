/**
 * mobile-landscape.js — 手机端强制横屏渲染。
 * 竖屏持机时把 body 旋转 90° 并宽高互换，让桌面始终按横屏布局渲染；
 * 横屏持机或桌面设备不做任何处理。旋转/缩放窗口时重新计算。
 * 不加载 client.js（移动端拦截已移除），本模块只管布局方向。
 */

function isMobileDevice() {
    const ua = navigator.userAgent || navigator.vendor || window.opera || "";
    return /android|iphone|ipod|blackberry|iemobile|opera mini|mobile|windows phone|phone|webos|kindle|tablet/i.test(ua.toLowerCase());
}

function applyLandscape() {
    const portrait = window.matchMedia("(orientation: portrait)").matches;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const s = document.body.style;
    if (portrait && w > 0 && h > 0) {
        // 竖屏 → 旋转 90°：body 以视口宽为偏移、以高为宽，绕左上角顺时针转 90°
        s.position = "absolute";
        s.left = w + "px";
        s.top = "0";
        s.width = h + "px";
        s.height = w + "px";
        s.transform = "rotate(90deg)";
        s.transformOrigin = "0 0";
        s.overflow = "hidden";
        document.documentElement.style.overflow = "hidden";
    } else {
        // 横屏 → 恢复默认布局
        s.position = "";
        s.left = "";
        s.top = "";
        s.width = "";
        s.height = "";
        s.transform = "";
        s.transformOrigin = "";
        s.overflow = "";
        document.documentElement.style.overflow = "";
    }
}

if (isMobileDevice()) {
    applyLandscape();
    window.addEventListener("resize", applyLandscape);
    window.addEventListener("orientationchange", applyLandscape);
}
