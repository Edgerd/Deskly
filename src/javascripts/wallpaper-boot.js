/**
 * wallpaper-boot.js — 首帧壁纸引导（经典脚本，必须先于样式表与模块执行）
 *
 * 为什么单独一份：壁纸配置存在 localStorage 里，正常流程要等 bootstrap 把
 * 设置中枢、插件注册表都拉完才轮到 wallpaper.init()。在那之前样式表里的默认
 * 壁纸（Sequoia 经典）已经画上屏，用户会看到「经典壁纸闪一下再切成自己的」。
 * 模块脚本一律 deferred，无法抢在首帧之前；MV3 CSP 又不允许内联脚本，所以只有
 * 在 <head> 里放一个同步的经典 <script> 能在解析 body 之前读到配置。
 *
 * 做法：只把配置里的图片写进 <html> 的 CSS 自定义属性；main.css 的
 * body > div.wallpaper 用 var(--deskly-wallpaper-image, 默认壁纸) 取值，
 * 于是壁纸元素第一次参与渲染时用的就是用户那张图，不会先画默认图。
 *
 * 与 wallpaper.js 的交接：wallpaper.init() 把同一张图落到壁纸元素的内联样式后，
 * 调用 window.__desklyWallpaperBoot.release() 摘掉这里写的覆盖，避免留下第二份
 * 「当前壁纸」来源。此文件不 import 任何模块，也不依赖 DOM 已解析。
 */
(() => {
    const CONFIG_KEY = "wallpaper-config";
    let url = "";
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (raw) {
            const config = JSON.parse(raw);
            if (config && typeof config.url === "string") url = config.url.trim();
        }
    } catch (err) {
        // 隐私模式 / 配置损坏：保持样式表默认壁纸，交给 wallpaper.init() 正常回退。
        return;
    }
    if (!url) return;

    const root = document.documentElement;
    // 相对地址必须先解析成绝对地址：CSS 自定义属性里的 url() 会按「消费它的样式表」
    // （main.css 在 assets/stylesheets/main/）解析，而不是按文档解析；直接塞 ./assets/…
    // 会变成 assets/stylesheets/main/assets/…。这里按文档基准转成绝对 URL，与
    // wallpaper.js 内联 background-image 的解析结果保持一致。
    let absolute = url;
    try {
        absolute = new URL(url, document.baseURI).href;
    } catch (err) {
        return;
    }
    // JSON.stringify 负责转义引号、反斜杠与换行；外层仍是合法的 CSS 字符串，
    // 不能靠字符串拼接把用户配置直接塞进样式（localStorage 属于本机可写数据）。
    root.style.setProperty("--deskly-wallpaper-image", `url(${JSON.stringify(absolute)})`);

    window.__desklyWallpaperBoot = {
        url: absolute,
        release() {
            root.style.removeProperty("--deskly-wallpaper-image");
            delete window.__desklyWallpaperBoot;
        },
    };
})();
