function resetHeight() { document.body.style.height = `${window.innerHeight}px`; }

resetHeight();

["resize", "orientationchange", "load"].forEach((e) => window.addEventListener(e, resetHeight));

// 初始化浏览器原生右键菜单禁用开关（默认禁用，可在系统设置中开启）
import "./contextMenuSettings.js";

