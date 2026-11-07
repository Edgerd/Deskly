/**
 * paths.js — 站内资源路径的唯一来源
 *
 * 之前同一个资源在多处各拼一遍字符串（Finder 图标 6 处、Folder/通用文档图标 3 处、
 * 下载夹 2 处、壁纸默认值 3 处、`./mods/<id>/` 7 处），目录改名或挪文件时只能靠
 * grep 撞运气。这里集中生成，宿主与插件都用同一组函数：运行时 URL 一律是
 * 站点根相对写法（`./assets/…`、`./mods/<id>/…`），因为解析基准是文档而不是脚本自身。
 *
 * 本模块不 import 任何东西，也不产生副作用：任何文件都能安全引用，不会有循环依赖。
 */

/** 相对站点根（扩展页 URL 基准）拼 assets 下的资源路径。 */
export const assetPath = (rel) => `./assets/${rel}`;

/** `assets/icons/<name>.png`；name 是不带扩展名的图标名（保持与库内文件名一致）。 */
export const assetIcon = (name) => assetPath(`icons/${name}.png`);

/**
 * `assets/images/<name>.svg` —— 界面字形（SF Symbols 风格单色图），给侧栏/按钮取用；
 * 与「应用图标」区分：应用图标只用 PNG（见 plugin-format.md 图标规则）。
 */
export const glyph = (name) => assetPath(`images/${name}.svg`);

/** 插件目录本身，形如 `./mods/notepad/`。 */
export const modDir = (id) => `./mods/${id}/`;

/** 插件目录内的某个文件。 */
export const modFile = (id, file) => `${modDir(id)}${file}`;

/**
 * 带缓存参数（`?v=`）的插件资源 URL。
 * 只允许用在非模块资源上（HTML / CSS / JSON）；入口脚本用 `modDateUrl`，
 * 因为模块脚本必须每次全新 URL，否则 ES module 缓存命中、二次打开不再执行逻辑。
 */
export const modUrl = (id, file, stamp) => `${modFile(id, file)}?v=${stamp}`;

/** 入口脚本专用：每次注入都是全新 URL；`seq` 保证同一毫秒内也互不相同。 */
export const modDateUrl = (id, file, seq) =>
  `${modFile(id, file)}?v=${Date.now()}${seq ? `-${seq}` : ""}`;

/**
 * 运行时资源 URL 一律用**站点根相对**写法：`<img src>`、`fetch()`、`Notification.icon`
 * 的解析基准是文档（index.html 所在目录），不是脚本自身；历史写法 `../../assets/…`
 * 能用只是因为越过根目录后被浏览器截断回了同一处。真正需要 `../../` 的只有
 * ES module 的 `import` 说明符和 CSS 里的 `url()`（相对文件自身解析），不归本模块管。
 */

/* ── 被多处复用的具体资源 ── */

// 通用应用占位图标：任何应用图标缺失或加载失败时的唯一兜底目标。
// 规则见 dev/devdoc/plugin-format.md「图标规则（硬性）」。
export const GENERIC_APP_ICON = assetPath("icons/dock/Launcher.png");

// ZIP 能力（商店安装 ZIP 插件 + office 的 docx/xlsx 编解码）共用的第三方库。
// 不写进 index.html：98KB 只在这两条路径上才用得到，首屏不该付这份下载与解析成本。
// 取用一律走 src/javascripts/vendor.js 的 ensureJSZip()，不要在别处拼这个路径。
export const JSZIP_SCRIPT = assetPath("vendor/jszip.min.js");

// 告警/错误对话框的默认配图，以及文件类图标的通用三件套。
export const FINDER_ICON = assetIcon("Finder");
export const FOLDER_ICON = assetPath("icons/folder/Folder.png");
export const DOWNLOAD_ICON = assetPath("icons/folder/Download.png");
export const GENERIC_DOC_ICON = assetPath("images/GenericDocumentIcon.png");

// Siri 顶栏图标：彩色光球（PNG）。与「应用/启动台图标」区分——后者是
// manifest.icon（mods/siri/Siri.png），走 getIcon("siri")；顶栏要的是这张 Orb。
export const SIRI_BAR_ICON = assetIcon("Siri-Orb");

/* ── 旧式 App（非插件）残留目录 ──
   assets/apps/ 已清空，Safari 也早已插件化；下面三个只是 window.js 的 create()
   在「名字没注册成插件」时的兜底路径，走到那里必然 404 并弹提示。
   集中放这里是为了让路径只有一个出处，删这套逻辑时一并删掉即可。 */
export const legacyAppHtml = (name) => assetPath(`apps/${name}.html`);
export const legacyAppScript = (name) => `./src/javascripts/apps/${name}.js`;
export const legacyAppCss = (name) => assetPath(`stylesheets/apps/${name}/index.css`);
