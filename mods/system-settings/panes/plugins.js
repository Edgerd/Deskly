/**
 * panes/plugins.js — 「系统设置 › App」面板（自动面板 + App 列表 + App 详情）
 *
 * 面板 id 与文件名仍叫 plugins：注册表、深链（?pane=plugins）、语言包命名空间
 * ss.plugins.* 都拿它当标识，改名会一起断掉；界面上的称呼已经统一成 App。
 *
 * 三段结构：
 * 1. App 自己注册进来的设置项（autoRow 按 owner 分组）与统计 —— 行为原样保留；
 * 2. App 列表：一行一个 App，整行可点（role="button"）进详情，行尾只留「重新加载」；
 * 3. App 详情：头部（图标 / 名称 / 一句话 / 署名 / 动作）→ 截图 → 简介 → 能力 →
 *    使用方法 → 包含的应用 → 权限 → 信息 → 主页。分区顺序照应用商店的详情页，
 *    但一切用设置界面的视觉语言（.ss-section / .ss-group / .ss-row）重画，不复制它的代码。
 *
 * 子视图导航：详情是本面板内部的一层视图，栈与指针都留在本模块。外壳只按可选导出
 * canGoBack() / onBack() / canGoForward() / onForward() 问一句「这次导航你消费吗」，
 * 消费完再调 ctx.syncNav() 让工具栏的前进/后退跟着亮灭。语言切换会带 reason:"language"
 * 重建，此时把详情留住（换语言不该把人踢回列表）；其它任何重建都回列表。
 *
 * 清单里来的文本（名称、文案、截图路径、主页地址）一律走 textContent：这一页展示的是
 * 第三方包自填的内容，界面绝不把它们当标签解析，也不自行拼装 HTML 片段。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { log } from "../../../src/javascripts/log.js";
import { load, unload, openApp } from "../../../src/javascripts/plugin-manager.js";
import { listEntries, getEntry, setEnabled, PLACEHOLDER_ICON } from "../../../src/javascripts/store-api.js";
import {
    t, el, note, group, section, row, autoRow, statusRow, usePaneStyle, track,
} from "../ui.js";

/** 面板 id 是身份不是文案，不能改（见文件头注释）。 */
export const paneId = "plugins";

/** 行内动作结果的停留时长：不自动收的话，三行前那次「已打开」会一直挂在页面上装成现状。 */
const STATUS_MS = 4000;

/** 四语言文案。术语统一为 App：界面不再把应用叫作扩展/插件。 */
export const messages = {
    "zh-CN": {
        ss: {
            plugins: {
                ownGroup: "App 设置项",
                officeBrandGroup: "办公套件",
                officeBrand: "名称与图标",
                officeBrandNote: "选 Microsoft Office 需要对应图标文件；缺少时自动沿用 iWork 图标。",
                empty: "还没有 App 注册设置项。",
                listedGroup: "统计",
                listed: "收录的设置项",
                owners: "设置项来源",
                installedGroup: "App",
                none: "暂无 App。",
                detailAria: "查看详情",
                back: "← App",
                openBtn: "打开",
                enableBtn: "启用",
                disableBtn: "禁用",
                reloadBtn: "重新加载",
                opened: "已打开",
                reloaded: "已重新加载",
                reloadSelfBlocked: "不能重新加载正在使用的系统设置，请关闭后重开窗口",
                failed: "操作失败：",
                gone: "这个 App 已经不在了。",
                rowBuiltin: "内置",
                rowInstalled: "已安装",
                infoBuiltin: "系统内置",
                infoZip: "ZIP 安装",
                versionLabel: "版本",
                authorLabel: "开发者",
                appsCountOne: "1 个应用",
                appsCount: "{n} 个应用",
                secShots: "截图",
                secIntro: "简介",
                secFeatures: "能力",
                secUsage: "使用方法",
                secApps: "包含的应用",
                secPerms: "权限",
                secInfo: "信息",
                secHome: "主页",
                noPerms: "不需要任何额外能力。",
                chipSensitive: "敏感",
                idLabel: "标识",
                sourceLabel: "来源",
                stateLabel: "状态",
                stateOn: "已启用",
                stateOff: "已禁用",
                installedAtLabel: "安装时间",
                sizeLabel: "占用",
                updatedLabel: "更新时间",
                filesCount: "{n} 个文件",
            },
        },
    },
    "en": {
        ss: {
            plugins: {
                ownGroup: "App Settings",
                officeBrandGroup: "Office suite",
                officeBrand: "Names and icons",
                officeBrandNote: "The Microsoft Office pack needs its icon files; missing ones fall back to iWork icons.",
                empty: "No App has registered settings yet.",
                listedGroup: "Statistics",
                listed: "Collected settings",
                owners: "Settings sources",
                installedGroup: "Apps",
                none: "No Apps.",
                detailAria: "View details",
                back: "← Apps",
                openBtn: "Open",
                enableBtn: "Enable",
                disableBtn: "Disable",
                reloadBtn: "Reload",
                opened: "Opened",
                reloaded: "Reloaded",
                reloadSelfBlocked: "Can't reload System Settings while you're using it. Close and reopen the window instead.",
                failed: "Action failed: ",
                gone: "This App is no longer here.",
                rowBuiltin: "Built-in",
                rowInstalled: "Installed",
                infoBuiltin: "Built-in",
                infoZip: "Installed from ZIP",
                versionLabel: "Version",
                authorLabel: "Developer",
                appsCountOne: "1 app",
                appsCount: "{n} apps",
                secShots: "Screenshots",
                secIntro: "Overview",
                secFeatures: "Capabilities",
                secUsage: "How to use",
                secApps: "Included apps",
                secPerms: "Permissions",
                secInfo: "Information",
                secHome: "Website",
                noPerms: "No extra capabilities needed.",
                chipSensitive: "Sensitive",
                idLabel: "ID",
                sourceLabel: "Source",
                stateLabel: "Status",
                stateOn: "Enabled",
                stateOff: "Disabled",
                installedAtLabel: "Installed",
                sizeLabel: "Size",
                updatedLabel: "Updated",
                filesCount: "{n} files",
            },
        },
    },
    "ja-JP": {
        ss: {
            plugins: {
                ownGroup: "App の設定",
                officeBrandGroup: "オフィススイート",
                officeBrand: "名前とアイコン",
                officeBrandNote: "Microsoft Office を選ぶには専用アイコンが必要です。無い場合は iWork のアイコンを使います。",
                empty: "App はまだ設定を登録していません。",
                listedGroup: "統計",
                listed: "収録された設定",
                owners: "設定の提供元",
                installedGroup: "App",
                none: "App はありません。",
                detailAria: "詳細を見る",
                back: "← App",
                openBtn: "開く",
                enableBtn: "有効にする",
                disableBtn: "無効にする",
                reloadBtn: "再読み込み",
                opened: "開きました",
                reloaded: "再読み込みしました",
                reloadSelfBlocked: "使用中のシステム設定は再読み込みできません。ウインドウを閉じて開き直してください。",
                failed: "操作失敗：",
                gone: "この App はもうありません。",
                rowBuiltin: "内蔵",
                rowInstalled: "インストール済み",
                infoBuiltin: "システム内蔵",
                infoZip: "ZIP インストール",
                versionLabel: "バージョン",
                authorLabel: "開発者",
                appsCountOne: "1 個の App",
                appsCount: "{n} 個の App",
                secShots: "画面",
                secIntro: "概要",
                secFeatures: "できること",
                secUsage: "使い方",
                secApps: "含まれる App",
                secPerms: "権限",
                secInfo: "情報",
                secHome: "ホームページ",
                noPerms: "追加の能力は要りません。",
                chipSensitive: "機微",
                idLabel: "ID",
                sourceLabel: "提供元",
                stateLabel: "状態",
                stateOn: "有効",
                stateOff: "無効",
                installedAtLabel: "インストール日時",
                sizeLabel: "容量",
                updatedLabel: "更新日",
                filesCount: "{n} 個のファイル",
            },
        },
    },
    "cat": {
        ss: {
            plugins: {
                ownGroup: "App 的设置项喵",
                officeBrandGroup: "办公三件套喵",
                officeBrand: "名字和图标喵",
                officeBrandNote: "选微软那套要有对应的图标喵，缺了就先借 iWork 的用喵。",
                empty: "还没有 App 来登记设置项喵。",
                listedGroup: "数一数喵",
                listed: "长出来的设置项",
                owners: "交设置项的 App",
                installedGroup: "App 喵",
                none: "App 名册上空空的喵。",
                detailAria: "点开看看喵",
                back: "← App 喵",
                openBtn: "打开喵",
                enableBtn: "叫醒喵",
                disableBtn: "让它睡",
                reloadBtn: "重来一遍",
                opened: "打开啦",
                reloaded: "重开好了喵",
                reloadSelfBlocked: "正在用的系统设置不能重来喵，主人先关掉窗口再打开就好啦",
                failed: "没办成：",
                gone: "这只 App 不见了的喵。",
                rowBuiltin: "自带的",
                rowInstalled: "装进来的",
                infoBuiltin: "自带喵",
                infoZip: "ZIP 装进来",
                versionLabel: "第几版",
                authorLabel: "谁做的",
                appsCountOne: "1 只 App",
                appsCount: "{n} 只 App",
                secShots: "长什么样喵",
                secIntro: "说说它",
                secFeatures: "会做什么",
                secUsage: "怎么撸",
                secApps: "一窝里有几只",
                secPerms: "要了什么许可",
                secInfo: "档案喵",
                secHome: "它的小窝",
                noPerms: "什么都没要，很乖喵。",
                chipSensitive: "要报备",
                idLabel: "名字牌",
                sourceLabel: "从哪来",
                stateLabel: "醒着吗",
                stateOn: "醒着喵",
                stateOff: "睡着了",
                installedAtLabel: "什么时候来的",
                sizeLabel: "占多大",
                updatedLabel: "上次打扮",
                filesCount: "{n} 个文件喵",
            },
        },
    },
};

/**
 * 面板私有样式：只引用 style.css 里已有的 --ss-* 令牌与全局强调色，
 * 浅色/深色两套都由这些变量自己翻面；过渡一律 ≤160ms 且只在未要求减少动效时生效。
 */
const CSS = `
.ss-plugins .ss-plugins__top { display: flex; flex-direction: column; gap: 20px; }
.ss-plugins .ss-plugins__view { display: flex; flex-direction: column; gap: 20px; }

/* 列表：整行是一个真按钮，图标 + 名称 + 次要信息，右侧动作与指示箭头 */
.ss-plugins .ss-apps__row {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 10px 12px;
    border: 0; border-radius: 0; background: transparent;
    color: var(--ss-text); font: inherit; text-align: start; cursor: pointer;
}
.ss-plugins .ss-apps__row + .ss-apps__row { border-top: 1px solid var(--ss-row-divider); }
.ss-plugins .ss-apps__row:hover { background: var(--ss-hover); }
.ss-plugins .ss-apps__row:active { background: var(--ss-pressed); }
.ss-plugins .ss-apps__row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ss-plugins .ss-apps__icon { flex: 0 0 auto; width: 48px; height: 48px; border-radius: 11px; display: block; }
.ss-plugins .ss-apps__row--off .ss-apps__icon { opacity: .55; }
.ss-plugins .ss-apps__main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ss-plugins .ss-apps__name { font-size: 13px; font-weight: 600; color: var(--ss-text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ss-plugins .ss-apps__meta { font-size: 11.5px; color: var(--ss-text-tertiary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ss-plugins .ss-apps__status { flex: 0 1 auto; max-width: 20ch; font-size: 11.5px; color: var(--ss-text-secondary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ss-plugins .ss-apps__tail { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; }
.ss-plugins .ss-apps__chev {
    flex: 0 0 auto; width: 7px; height: 7px;
    border-right: 1.6px solid var(--ss-text-tertiary); border-bottom: 1.6px solid var(--ss-text-tertiary);
    transform: rotate(-45deg);
}

/* 详情 */
.ss-plugins .ss-apps__detail { display: flex; flex-direction: column; gap: 14px; }
.ss-plugins .ss-apps__back {
    align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 9px 4px 4px; border: 0; border-radius: 7px;
    background: transparent; color: var(--accent); font: inherit; font-size: 12.5px; cursor: pointer;
}
.ss-plugins .ss-apps__back::before {
    content: ""; width: 6px; height: 6px;
    border-left: 1.6px solid currentColor; border-bottom: 1.6px solid currentColor;
    transform: rotate(45deg);
}
.ss-plugins .ss-apps__back:hover { background: var(--ss-hover); }
.ss-plugins .ss-apps__back:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ss-plugins .ss-apps__hero {
    display: flex; align-items: flex-start; gap: 14px;
    padding: 14px; border: 1px solid var(--ss-row-divider); border-radius: 12px; background: var(--ss-row-bg);
}
.ss-plugins .ss-apps__hero-icon { flex: 0 0 auto; width: 64px; height: 64px; border-radius: 14px; display: block; }
.ss-plugins .ss-apps__hero-off { opacity: .55; }
.ss-plugins .ss-apps__hero-main { flex: 1 1 auto; min-width: 0; }
.ss-plugins .ss-apps__hero-name { margin: 0; font-size: 16px; font-weight: 700; color: var(--ss-text); }
.ss-plugins .ss-apps__tagline { margin: 3px 0 0; font-size: 12.5px; color: var(--ss-text-secondary); }
.ss-plugins .ss-apps__byline { margin: 5px 0 0; font-size: 11.5px; color: var(--ss-text-tertiary); }
.ss-plugins .ss-apps__acts { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.ss-plugins .ss-btn--small { height: 22px; padding: 0 9px; font-size: 11.5px; border-radius: 6px; }
.ss-plugins .ss-apps__body {
    padding: 10px 12px; border: 1px solid var(--ss-row-divider); border-radius: 10px;
    background: var(--ss-row-bg); color: var(--ss-text-secondary);
}
.ss-plugins .ss-apps__para { margin: 0; font-size: 12.5px; line-height: 1.55; }
.ss-plugins .ss-apps__feats { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; line-height: 1.5; }
.ss-plugins .ss-apps__shots { display: flex; gap: 10px; overflow-x: auto; }
.ss-plugins .ss-apps__shot { margin: 0; flex: 0 0 auto; border: 1px solid var(--ss-row-divider); border-radius: 10px; overflow: hidden; background: var(--ss-control-bg); }
.ss-plugins .ss-apps__shot img { display: block; width: 220px; height: auto; }
.ss-plugins .ss-apps__chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ss-plugins .ss-apps__chip {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 5px 11px 5px 6px; border: 1px solid var(--ss-control-border); border-radius: 999px;
    background: var(--ss-control-bg); color: var(--ss-text); font: inherit; font-size: 12px; cursor: pointer;
}
.ss-plugins .ss-apps__chip:hover { background: var(--ss-hover); }
.ss-plugins .ss-apps__chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ss-plugins .ss-apps__chip img { width: 22px; height: 22px; border-radius: 6px; display: block; }
.ss-plugins .ss-apps__sensitive {
    padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: var(--ss-danger-bg); color: var(--ss-danger);
}
.ss-plugins .ss-apps__link { color: var(--accent); font-size: 12.5px; overflow-wrap: anywhere; }
/* 空态落在无内边距的分组里（.ss-group--plain），自己补上行的左右留白，不然贴到卡片边 */
.ss-plugins .ss-group--plain .ss-note { padding: 10px 12px; }

@media (prefers-reduced-motion: no-preference) {
    .ss-plugins .ss-apps__row,
    .ss-plugins .ss-apps__back,
    .ss-plugins .ss-apps__chip,
    .ss-plugins .ss-btn { transition: background-color 140ms ease, color 140ms ease; }
}
`;

/** 外壳给本面板的上下文（syncNav / reason / params），build() 时刷新。 */
let ctx = null;
/** 面板根元素。 */
let root = null;
/** 上半部（App 注册项 + 统计）；进详情时整块让位。 */
let topWrap = null;
/** 列表 / 详情的挂载点，子视图切换只重画这一块。 */
let viewHost = null;
/** 详情头部右侧的状态位：重绘后会换人，动作结果只写当前这一个。 */
let heroStatus = null;
/** 视图栈：下标 0 恒为列表（空串），其后是依次打开的 App id。 */
let trail = [""];
/** 栈指针，支持「后退一步再前进一步」；0 = 列表。 */
let step = 0;
/** destroy() 留下的意图：紧跟着的那次重建若是切换语言，就把子视图续上。 */
let keepViewPending = false;
/** 状态位自动收回的计时器。 */
let statusTimer = 0;

/**
 * 构建面板：上半部一次成型，下半部（列表/详情）交给 paint() 按栈指针渲染。
 * @param {object} context 外壳 makeContext() 给的上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(context) {
    ctx = context || null;
    usePaneStyle(paneId, CSS);

    // 只有「语言切换后的重建」才延续子视图；其余重建（含切走再切回）一律回列表。
    const keep = keepViewPending && ctx && ctx.reason === "language";
    keepViewPending = false;
    if (!keep) { trail = [""]; step = 0; }

    root = el("div", { class: "ss-pane ss-plugins" });
    topWrap = el("div", { class: "ss-plugins__top" }, ...buildOfficeBrandSection(), ...buildSettingSections());
    viewHost = el("div", { class: "ss-plugins__view" });
    root.append(topWrap, viewHost);

    // 深链（?pane=plugins&app=calculator、其它面板的 openPane("plugins", {app})）直接开详情。
    if (step === 0) {
        const target = resolveEntryId(ctx && ctx.params ? ctx.params.app : "");
        if (target) { trail = ["", target]; step = 1; }
    }
    paint();

    // Esc 收起详情：注册进 track()，切面板时由 disposeAll() 统一摘掉。
    const node = root;
    const onKeydown = (event) => { if (event.key === "Escape") onBack(); };
    node.addEventListener("keydown", onKeydown);
    track(() => node.removeEventListener("keydown", onKeydown));

    return root;
}

/** 释放面板引用；栈是否清零由下一次 build() 按 reason 定夺（见文件头）。 */
export function destroy() {
    keepViewPending = step > 0;
    clearTimeout(statusTimer);
    statusTimer = 0;
    root = null;
    topWrap = null;
    viewHost = null;
    heroStatus = null;
    ctx = null;
}

/* ───────────────────────── 子视图导航（外壳协议） ───────────────────────── */

/** @returns {boolean} 本面板内部还能不能后退（列表 = 0 层，不可后退） */
export function canGoBack() { return step > 0; }

/**
 * 后退一层子视图。
 * @returns {boolean} 是否消费了这次导航（已在列表则返回 false，交回外壳走跨面板历史）
 */
export function onBack() {
    if (step <= 0) return false;
    const leaving = trail[step];
    step -= 1;
    paint({ focus: currentId() ? "back" : "row", rowId: leaving });
    syncNav();
    return true;
}

/** @returns {boolean} 本面板内部还能不能前进 */
export function canGoForward() { return step < trail.length - 1; }

/**
 * 前进一步（把刚退掉的详情重新压回界面）。
 * @returns {boolean} 是否消费了这次导航
 */
export function onForward() {
    if (step >= trail.length - 1) return false;
    step += 1;
    paint({ focus: currentId() ? "back" : "row" });
    syncNav();
    return true;
}

/** 通知外壳重算前进/后退按钮可用态。 */
function syncNav() {
    if (ctx && typeof ctx.syncNav === "function") ctx.syncNav();
}

/** @returns {string} 当前栈位上的 App id（列表为空串） */
function currentId() { return trail[step] || ""; }

/**
 * 按栈指针重画下半部：详情整块顶替列表（上半部同步让位），
 * 这样详情页看起来就是「另一个界面」，而不是列表底下多出来的一坨。
 * @param {object} [opts] {focus:"back"|"row", rowId, focusAction} —— 重绘后把焦点送去哪儿
 * @returns {void}
 */
function paint(opts = {}) {
    if (!viewHost) return;
    viewHost.textContent = "";
    heroStatus = null;
    const id = currentId();
    if (topWrap) topWrap.hidden = Boolean(id);
    viewHost.append(id ? buildDetail(id) : buildList());
    if (opts.focus === "back") {
        const back = viewHost.querySelector(".ss-apps__back");
        if (back) back.focus();
    } else if (opts.focus === "row") {
        focusRow(opts.rowId);
    } else if (opts.focusAction) {
        const again = viewHost.querySelector(`[data-action="${opts.focusAction}"]`);
        if (again) again.focus();
    }
}

/**
 * 打开某个 App 的详情（压栈）。
 * @param {string} id App id
 * @returns {void}
 */
function drill(id) {
    if (!id || currentId() === id) return;
    trail = trail.slice(0, step + 1).concat(id);
    step = trail.length - 1;
    paint({ focus: "back" });
    syncNav();
}

/**
 * 把焦点还给进详情之前那一行（后退 / Esc 之后手指该还在原处）。
 * @param {string} id 进来之前的 App id
 * @returns {void}
 */
function focusRow(id) {
    if (!id || !viewHost) return;
    const hit = [...viewHost.querySelectorAll(".ss-apps__row")].find((node) => node.dataset.app === id);
    if (hit) hit.focus();
}

/* ───────────────────────── 上半部：App 注册的设置项 + 统计 ───────────────────────── */

/**
 * App 自己 define() 的设置项（按 owner 分组）+ 统计行。
 * @returns {Array<HTMLElement>} 分节元素
 */
function buildSettingSections() {
    const defs = settings.list().filter((def) => isAppOwned(def) && !def.hidden);
    const byOwner = new Map();
    defs.forEach((def) => {
        const owner = String(def.owner || "anonymous");
        if (!byOwner.has(owner)) byOwner.set(owner, []);
        const rowNode = autoRow(def);
        if (rowNode) byOwner.get(owner).push(rowNode);
    });

    const sections = [];
    if (byOwner.size === 0) {
        sections.push(group([note("ss.plugins.empty", "还没有 App 注册设置项。")], { title: t("ss.plugins.ownGroup", "App 设置项") }));
    } else {
        [...byOwner.entries()].forEach(([owner, rows]) => {
            if (!rows.length) return;
            sections.push(group(rows, { title: `${t("ss.plugins.ownGroup", "App 设置项")} · ${owner}` }));
        });
    }

    const listedRow = statusRow({ label: t("ss.plugins.listed", "收录的设置项"), value: String(defs.length) });
    const ownersRow = statusRow({ label: t("ss.plugins.owners", "设置项来源"), value: String(byOwner.size) });
    sections.push(group([listedRow, ownersRow], { title: t("ss.plugins.listedGroup", "统计") }));
    return sections;
}

/**
 * 办公套件的名称与图标品牌包（iWork / Microsoft Office，保真清单 F-49）。
 * 这一项不跟随插件启停，属于全局外观选择，所以单独成组放在面板最上方。
 * @returns {Array<HTMLElement>} 分组节点数组（定义缺失时为空）
 */
function buildOfficeBrandSection() {
    const def = settings.info("office.brandPack");
    if (!def) return [];
    const rowNode = autoRow(def, { label: t("ss.plugins.officeBrand", "名称与图标") });
    if (!rowNode) return [];
    return [group([
        rowNode,
        note("ss.plugins.officeBrandNote", "选 Microsoft Office 需要对应图标文件；缺少时自动沿用 iWork 图标。"),
    ], { title: t("ss.plugins.officeBrandGroup", "办公套件") })];
}

/**
 * 判断一项设置该不该归到本面板：owner 不是内核、且没被内核面板认领。
 * @param {object} def 设置定义副本
 * @returns {boolean} 是否属于本面板
 */
function isAppOwned(def) {
    if (!def || !def.key) return false;
    if (def.owner === "system") return false;
    return !def.pane || def.pane === "plugins";
}

/* ───────────────────────── App 列表 ───────────────────────── */

/**
 * App 列表：整行可点进详情，行尾只留「重新加载」（打开 / 禁用这类有后果的动作放详情页）。
 * @returns {HTMLElement} 分组元素
 */
function buildList() {
    const entries = listEntries();
    if (!entries.length) {
        return group([note("ss.plugins.none", "暂无 App。")], { title: t("ss.plugins.installedGroup", "App"), tone: "plain" });
    }
    return group(entries.map(appRow), { title: t("ss.plugins.installedGroup", "App"), tone: "plain" });
}

/**
 * 一行 App。
 *
 * 行本身用 `div[role=button]` 而不是 `<button>`：行尾那颗「重新加载」是真按钮，
 * 按钮里再套按钮是非法内容模型（辅助技术会把内层按钮吞掉）。键盘语义自己补：
 * Enter / 空格进详情，行内按钮的回车不冒泡成「进详情」。
 * @param {object} entry store-api 的条目
 * @returns {HTMLElement} 行元素
 */
function appRow(entry) {
    const status = el("span", { class: "ss-apps__status", hidden: true });
    const meta = el("span", { class: "ss-apps__meta", text: listMeta(entry) });
    const line = el("div", {
        class: `ss-apps__row${entry.enabled ? "" : " ss-apps__row--off"}`,
        attrs: { role: "button", tabindex: "0" },
        dataset: { app: entry.id },
        aria: { label: `${entry.name} · ${t("ss.plugins.detailAria", "查看详情")}` },
    },
        icon(entry.icon, entry.name, "ss-apps__icon"),
        el("span", { class: "ss-apps__main" }, el("span", { class: "ss-apps__name", text: entry.name }), meta),
        status,
        el("span", { class: "ss-apps__tail" }, reloadButton(entry.id, entry.name, status, entry.enabled), chevron()),
    );
    line.addEventListener("click", () => drill(entry.id));
    line.addEventListener("keydown", (event) => {
        // 焦点在行内「重新加载」上时，回车/空格归那颗按钮，不要再把整行当按钮按一次。
        if (event.target !== line) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            drill(entry.id);
        }
    });
    return line;
}

/**
 * 行的次要信息：版本 · 来源 ·（已禁用）。没值的段不硬凑。
 * @param {object} entry 条目
 * @returns {string} 拼接后的文本
 */
function listMeta(entry) {
    const parts = [];
    if (entry.version) parts.push(`${t("ss.plugins.versionLabel", "版本")} ${entry.version}`);
    parts.push(entry.source === "installed" ? t("ss.plugins.rowInstalled", "已安装") : t("ss.plugins.rowBuiltin", "内置"));
    if (!entry.enabled) parts.push(t("ss.plugins.stateOff", "已禁用"));
    return parts.join(" · ");
}

/** macOS 样式的展开指示箭头（纯边框画的 chevron，不带图片资源）。 */
function chevron() {
    return el("i", { class: "ss-apps__chev", attrs: { "aria-hidden": "true" } });
}

/* ───────────────────────── App 详情 ───────────────────────── */

/**
 * 详情页：头部 + 有数据才出现的分区（顺序照应用商店，视觉语言照设置界面）。
 * @param {string} id App id
 * @returns {HTMLElement} 详情容器
 */
function buildDetail(id) {
    const back = el("button", { class: "ss-apps__back", attrs: { type: "button" }, text: t("ss.plugins.back", "← App") });
    back.addEventListener("click", () => onBack());
    const box = el("div", { class: "ss-apps__detail" }, back);
    const entry = getEntry(id);
    if (!entry) {
        box.append(note("ss.plugins.gone", "这个 App 已经不在了。"));
        return box;
    }
    box.append(hero(entry));
    if (entry.screenshots.length) box.append(section("ss.plugins.secShots", "截图", shotsBox(entry)));
    const summary = (entry.store && entry.store.summary) || entry.description;
    if (summary) box.append(section("ss.plugins.secIntro", "简介", bodyOf(el("p", { class: "ss-apps__para", text: summary }))));
    const features = (entry.store && entry.store.features) || [];
    if (features.length) box.append(section("ss.plugins.secFeatures", "能力", bodyOf(featureList(features))));
    if (entry.store && entry.store.usage) box.append(section("ss.plugins.secUsage", "使用方法", bodyOf(el("p", { class: "ss-apps__para", text: entry.store.usage }))));
    if (entry.apps.length) box.append(section("ss.plugins.secApps", "包含的应用", bodyOf(appChips(entry))));
    box.append(section("ss.plugins.secPerms", "权限", permBlock(entry.permissions)));
    box.append(section("ss.plugins.secInfo", "信息", group(infoRows(entry))));
    if (entry.store && entry.store.homepage) box.append(section("ss.plugins.secHome", "主页", bodyOf(homeLink(entry.store.homepage))));
    return box;
}

/**
 * 详情头部：图标 + 名称 + 一句话 + 署名 + 动作。
 * @param {object} entry 条目
 * @returns {HTMLElement} 头部元素
 */
function hero(entry) {
    const status = el("span", { class: "ss-apps__status", hidden: true });
    heroStatus = status;
    const acts = el("div", { class: "ss-apps__acts" });

    // 禁用态下「打开」换成交换动作的「启用」：用户按下去总该有结果，不该先弹一句“它被禁用了”。
    const primary = el("button", {
        class: "ss-btn ss-btn--accent", attrs: { type: "button" }, dataset: { action: entry.enabled ? "open" : "enable" },
        text: entry.enabled ? t("ss.plugins.openBtn", "打开") : t("ss.plugins.enableBtn", "启用"),
    });
    primary.addEventListener("click", () => {
        if (entry.enabled) runAction(primary, status, entry.id, "open");
        else toggleEnabled(entry.id, true, status);
    });
    acts.append(primary);

    if (entry.enabled && entry.disableable !== false) {
        const off = el("button", { class: "ss-btn", attrs: { type: "button" }, dataset: { action: "disable" }, text: t("ss.plugins.disableBtn", "禁用") });
        off.addEventListener("click", () => toggleEnabled(entry.id, false, status));
        acts.append(off);
    }

    acts.append(reloadButton(entry.id, entry.name, status, entry.enabled, "ss-btn"), status);

    const bylineText = entry.disableable === false && entry.disableReason
        ? `${byline(entry)} · ${entry.disableReason}`
        : byline(entry);
    return el("header", { class: "ss-apps__hero" },
        el("span", { class: entry.enabled ? "" : "ss-apps__hero-off" }, icon(entry.icon, entry.name, "ss-apps__hero-icon")),
        el("div", { class: "ss-apps__hero-main" },
            el("h3", { class: "ss-apps__hero-name", text: entry.name }),
            el("p", { class: "ss-apps__tagline", text: (entry.store && entry.store.tagline) || entry.description || "" }),
            el("p", { class: "ss-apps__byline", text: bylineText }),
            acts));
}

/**
 * 署名行：版本 · 分类或来源 · 开发者 · 应用数。
 * @param {object} entry 条目
 * @returns {string} 拼接后的文本
 */
function byline(entry) {
    const store = entry.store || {};
    const parts = [];
    if (entry.version) parts.push(`${t("ss.plugins.versionLabel", "版本")} ${entry.version}`);
    parts.push(store.category || (entry.source === "installed" ? t("ss.plugins.rowInstalled", "已安装") : t("ss.plugins.infoBuiltin", "系统内置")));
    if (store.author) parts.push(`${t("ss.plugins.authorLabel", "开发者")} ${store.author}`);
    const n = (entry.apps || []).length;
    parts.push(n > 1
        ? t("ss.plugins.appsCount", "{n} 个应用").replace("{n}", String(n))
        : t("ss.plugins.appsCountOne", "1 个应用"));
    return parts.join(" · ");
}

/**
 * 截图：清单声明了才出现；某张取不到就把那一格摘掉（不摆占位图骗人）。
 * @param {object} entry 条目
 * @returns {HTMLElement} 横向图排
 */
function shotsBox(entry) {
    const row2 = el("div", { class: "ss-apps__shots" });
    entry.screenshots.forEach((url, index) => {
        const fig = el("figure", { class: "ss-apps__shot" });
        const img = el("img", { attrs: { src: url, alt: `${entry.name} · ${t("ss.plugins.secShots", "截图")} ${index + 1}`, loading: "lazy" } });
        img.addEventListener("error", () => fig.remove(), { once: true });
        fig.append(img);
        row2.append(fig);
    });
    return row2;
}

/**
 * 能力清单（store.features，条目文本原样显示）。
 * @param {Array<string>} features 条目
 * @returns {HTMLElement} 列表
 */
function featureList(features) {
    const list = el("ul", { class: "ss-apps__feats" });
    features.forEach((text) => list.append(el("li", { text: String(text) })));
    return list;
}

/**
 * 包含的应用：芯片点下去就是 plugin-manager 的 openApp(appId)，与商店一致。
 * @param {object} entry 条目
 * @returns {HTMLElement} 芯片排
 */
function appChips(entry) {
    const box = el("div", { class: "ss-apps__chips" });
    entry.apps.forEach((app) => {
        const chip = el("button", { class: "ss-apps__chip", attrs: { type: "button" } },
            icon(app.icon, app.name, ""), el("span", { text: String(app.name || app.appId) }));
        chip.addEventListener("click", () => {
            openApp(app.appId);
            log.info("system-settings", `从 App 详情打开子应用 ${app.appId}`);
        });
        box.append(chip);
    });
    return box;
}

/**
 * 权限：取自清单声明，与授权账本同源；一条都没有时也要说清楚（空区会被读成“没查”）。
 * @param {Array<object>} permissions 权限说明
 * @returns {HTMLElement} 分组元素
 */
function permBlock(permissions) {
    if (!permissions.length) {
        return group([note("ss.plugins.noPerms", "不需要任何额外能力。")], { tone: "plain" });
    }
    const rows = permissions.map((perm) => {
        const chip = perm.sensitive
            ? el("span", { class: "ss-apps__sensitive", text: t("ss.plugins.chipSensitive", "敏感") })
            : null;
        return row({ label: String(perm.label || perm.name), hint: String(perm.hint || ""), control: chip });
    });
    return group(rows, { tone: "plain" });
}

/**
 * 信息区：标识原样显示（它是身份，不是文案），其余各段没值就不出现。
 * @param {object} entry 条目
 * @returns {Array<HTMLElement>} 行元素
 */
function infoRows(entry) {
    const store = entry.store || {};
    const source = entry.source === "installed"
        ? (entry.from ? `${t("ss.plugins.infoZip", "ZIP 安装")}（${entry.from}）` : t("ss.plugins.infoZip", "ZIP 安装"))
        : t("ss.plugins.infoBuiltin", "系统内置");
    const rows = [
        statusRow({ label: t("ss.plugins.idLabel", "标识"), value: entry.id }),
        statusRow({ label: t("ss.plugins.versionLabel", "版本"), value: entry.version }),
        statusRow({ label: t("ss.plugins.sourceLabel", "来源"), value: source }),
        statusRow({ label: t("ss.plugins.stateLabel", "状态"), value: entry.enabled ? t("ss.plugins.stateOn", "已启用") : t("ss.plugins.stateOff", "已禁用") }),
    ];
    if (entry.installedAt) rows.push(statusRow({ label: t("ss.plugins.installedAtLabel", "安装时间"), value: new Date(entry.installedAt).toLocaleString() }));
    if (entry.bytes) {
        rows.push(statusRow({
            label: t("ss.plugins.sizeLabel", "占用"),
            value: `${(entry.bytes / 1024).toFixed(0)} KB${entry.fileCount ? ` · ${t("ss.plugins.filesCount", "{n} 个文件").replace("{n}", String(entry.fileCount))}` : ""}`,
        }));
    }
    if (store.updated) rows.push(statusRow({ label: t("ss.plugins.updatedLabel", "更新时间"), value: store.updated }));
    return rows;
}

/**
 * 主页外链：地址原样显示，新窗口打开且不带 referrer 关系以外的权限。
 * @param {string} url 已清洗过的 http(s) 地址
 * @returns {HTMLElement} 链接
 */
function homeLink(url) {
    return el("a", { class: "ss-apps__link", attrs: { href: url, target: "_blank", rel: "noopener noreferrer" }, text: url });
}

/** 给正文类区块套一层统一的底（.ss-apps__body），保持与 .ss-group 同宽同圆角。 */
function bodyOf(inner) {
    return el("div", { class: "ss-apps__body" }, inner);
}

/* ───────────────────────── 动作 ───────────────────────── */

/**
 * App 图标：地址全部来自 store-api（它已经带好缓存戳），界面不拼任何路径。
 * @param {string} src 图标 URL
 * @param {string} altName 应用名（alt 用，属清单文本）
 * @param {string} cls 尺寸类
 * @returns {HTMLElement} img 元素
 */
function icon(src, altName, cls) {
    const img = el("img", { class: cls, attrs: { src: src || PLACEHOLDER_ICON, alt: altName || "" } });
    img.addEventListener("error", () => { img.src = PLACEHOLDER_ICON; }, { once: true });
    return img;
}

/**
 * 行尾的重新加载：不打开详情，所以要把冒泡掐在按钮上。
 * 已禁用的 App 给不出这次重载（load() 会按用户意图直接拦下），按钮就明说不能按，
 * 不是一次按下去、再报一句「已重新加载」的假成功。
 * @param {string} id App id
 * @param {string} name 应用名（aria-label 用）
 * @param {HTMLElement} status 行内状态位
 * @param {boolean} enabled 该 App 当前是否启用
 * @param {string} [cls] 按钮外观类（列表用小号，详情用常规号）
 * @returns {HTMLElement} 按钮
 */
function reloadButton(id, name, status, enabled, cls = "ss-btn ss-btn--small") {
    const btn = el("button", {
        class: cls,
        attrs: { type: "button", disabled: !enabled, "aria-label": `${t("ss.plugins.reloadBtn", "重新加载")} · ${name}` },
        text: t("ss.plugins.reloadBtn", "重新加载"),
    });
    btn.addEventListener("click", (event) => {
        event.stopPropagation();
        runAction(btn, status, id, "reload");
    });
    return btn;
}

/**
 * 执行打开或重新加载：写日志、按钮忙状态、失败时把原因显示在同一行的状态位里。
 * @param {HTMLButtonElement} button 触发按钮
 * @param {HTMLElement} status 行内状态元素
 * @param {string} id App id
 * @param {"open"|"reload"} kind 动作类型
 * @returns {Promise<void>} 完成
 */
async function runAction(button, status, id, kind) {
    if (button.disabled || !id) return;
    // 重载自己 = 当场拆掉用户正在看的窗口，flash 写进已 detach 的节点，用户什么都看不到（BUG-63）
    if (kind === "reload" && id === "system-settings") {
        flash(status, t("ss.plugins.reloadSelfBlocked", "不能重新加载正在使用的系统设置，请关闭后重开窗口"));
        return;
    }
    button.disabled = true;
    try {
        if (kind === "reload") {
            unload(id);
            await load(id);
            log.info("system-settings", `重载 App ${id}`);
            flash(status, t("ss.plugins.reloaded", "已重新加载"));
        } else {
            await load(id);
            log.info("system-settings", `打开 App ${id}`);
            flash(status, t("ss.plugins.opened", "已打开"));
        }
    } catch (err) {
        log.error("system-settings", `App ${id} ${kind === "reload" ? "重载" : "打开"}失败`, err);
        flash(status, failText(err && err.message ? err.message : String(err)));
    } finally {
        button.disabled = false;
    }
}

/**
 * 启用 / 禁用：store-api 可能拒绝系统应用（visibility.system 的启动台等），
 * 拒绝理由写进状态位，不抛错也不弹窗。
 * @param {string} id App id
 * @param {boolean} on 目标状态
 * @param {HTMLElement} status 详情头部状态位
 * @returns {void}
 */
function toggleEnabled(id, on, status) {
    const res = setEnabled(id, on);
    if (!res.ok) {
        log.warn("system-settings", `App ${id} ${on ? "启用" : "禁用"}被拒绝`, res.reason);
        flash(status, failText(res.reason));
        return;
    }
    log.info("system-settings", `${on ? "启用" : "禁用"} App ${id}`);
    // 状态变了要重画整页详情（按钮组、署名、信息里的状态行都跟着翻面），再把结果写回新的状态位。
    // 焦点跟着落回头部那颗主按钮：刚点的「启用」翻成了「打开」，反之亦然，手指不该被丢到页头。
    paint({ focusAction: on ? "open" : "enable" });
    flash(heroStatus || status, t(on ? "ss.plugins.stateOn" : "ss.plugins.stateOff", on ? "已启用" : "已禁用"));
}

/**
 * 失败文案：前缀本地化，原因取自接口/异常（可能是第三方包写的），只截一段免得撑破行。
 * @param {string} reason 原因
 * @returns {string} 提示文本
 */
function failText(reason) {
    return `${t("ss.plugins.failed", "操作失败：")}${String(reason || "").slice(0, 60)}`;
}

/**
 * 在状态位上写一句临时结果，几秒后自己收走。
 * @param {HTMLElement} node 状态位
 * @param {string} text 文本（空串表示立刻收走）
 * @returns {void}
 */
function flash(node, text) {
    if (!node) return;
    say(node, text);
    if (!text) return;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { if (node.isConnected) say(node, ""); }, STATUS_MS);
}

/** 状态位的显隐（hidden 而不是空文本，免得留一块占位的空隙）。 */
function say(node, text) {
    node.textContent = text || "";
    node.hidden = !text;
}

/**
 * 把深链参数解析成条目 id：既接受 App id，也接受子应用 id / 显示名（?app=calculator 这种）。
 * @param {string} raw 参数原值
 * @returns {string} 条目 id，解析不到返回空串
 */
function resolveEntryId(raw) {
    const key = String(raw || "");
    if (!key) return "";
    const entries = listEntries();
    if (entries.some((entry) => entry.id === key)) return key;
    const hit = entries.find((entry) => (entry.apps || []).some((app) => app.appId === key || String(app.name) === key));
    return hit ? hit.id : "";
}
