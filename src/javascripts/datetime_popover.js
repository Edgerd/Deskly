/**
 * datetime_popover.js — 菜单栏时间/日期点击弹出的日历面板
 *
 * 复刻 macOS 菜单栏日历工具（Itsycal 风格）的下拉面板：
 *   - 月份标题 + 上月/下月/今日导航
 *   - 周一~周日表头（可配置周起始日）
 *   - 6x7 日期网格（今天蓝色高亮圆形、非本月日期灰色、选中态）
 *   - 底部显示当前详细日期信息
 *   - 毛玻璃材质（backdrop-filter）+ 淡入缩放动画
 *   - 点击外部自动关闭，重复点击时间/日期可切换
 *
 * 使用方法：
 *   import { initDatetimePopover } from "./datetime_popover.js";
 *   initDatetimePopover(timeElement, dateElement);
 *
 * 暴露方法：
 *   openPopover(anchorElement)  打开面板并定位到指定锚点下方
 *   closePopover()              关闭面板
 *   togglePopover(anchorElement) 切换面板显示
 *
 * 设置来源：周起始日读 general.weekStart（0=周日 / 1=周一），变更时重排表头与网格；
 * 本面板只渲染日期不渲染时刻，因此 general.timeFormat / showSeconds 在这里没有落点——
 * 顶栏时钟（finderbar.js）才是那两项的消费者。
 */

import { i18n } from "./i18n.js";
import { settings } from "./settings.js";
// 菜单栏弹层互斥：控制中心面板与日历面板同为 PANEL 层（z-index 9630），macOS 的行为是
// 「打开一个就收起另一个」。控制中心图标在菜单栏里（z 9999，高于控制中心自己的遮罩层），
// 点击它落不到遮罩上，所以「日历先开、控制中心后开」这条路径没人负责收起；
// 反向（点控制中心图标时日历先开）由本模块的全局捕获 click 处理。
// 只这一个方向依赖 controlcenter.js，它不反向引用本文件，不构成加载环。
import { hide as hideControlCenter } from "./controlcenter.js";

// 当前显示月份的状态（year/month，month: 0-11）
let _viewYear = 0;
let _viewMonth = 0;
// 选中日期（默认今天），格式 {y, m, d}
let _selected = null;
let _panelEl = null;
let _isOpen = false;
/** 开/关序号：同帧 show→hide 时作废在途的 rAF 显示回调（BUG-13）。 */
let _openSeq = 0;
// 当前锚点元素（用于定位）
let _anchorEl = null;
// 语言变更重建监听（init 可能多次调用，用它做幂等，避免重复注册）
let _langListener = null;
// 日期/时间格式变更监听（同上，幂等）
let _formatListener = null;
// ESC 监听（同上，幂等）
let _escListener = null;
// 已绑定点击的锚点元素：init 重复调用时不再给同一元素挂第二份 toggle
const _boundAnchors = new WeakSet();

// 星期名称（短名），顺序固定从周日开始，渲染时会按周起始日旋转
const WEEKDAY_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_FULL = [
    "一月", "二月", "三月", "四月", "五月", "六月",
    "七月", "八月", "九月", "十月", "十一月", "十二月",
];

/**
 * 一周的第一天：读 general.weekStart（0=周日，1=周一，默认周一与 macOS 一致）。
 * 定义表还没注册时（独立加载本模块）走默认值，非法取值一律回退周一。
 * @returns {0|1} 周起始日
 */
function weekStart() {
    return Number(settings.get("general.weekStart", 1)) === 0 ? 0 : 1;
}

// 语言感知的星期 / 月份名：优先取当前语言包（datetime.weekdayShort / monthFull 为数组），
// 缺省回退到内置中文常量。i18n.t 的第三个语义（值为数组）由 lookup 原样返回。
const _weekdayShort = () => i18n.t("datetime.weekdayShort", WEEKDAY_SHORT) || WEEKDAY_SHORT;
const _monthFull = () => i18n.t("datetime.monthFull", MONTH_FULL) || MONTH_FULL;
// 月标题格式（各语言词序不同：en 为 “October 2026”，zh 为 “2026 年 十月”）
const _monthTitle = (y, m) =>
    i18n.t("datetime.monthTitle", "{y} 年 {m}")
        .replace("{y}", String(y))
        .replace("{m}", _monthFull()[m]);
// 底部「详细日期 / 星期」同样按占位模板取词：把「星期」当固定前缀拼在 locale 数组元素前面，
// en/ja 下会输出「星期Tue」这种中英混排的半成品（词序与缀词都是各语言自己的事）。
const _dayTitle = (t) =>
    i18n.t("datetime.dayFormat", "{y} 年 {m} 月 {d} 日")
        .replace("{y}", String(t.y))
        .replace("{m}", String(t.m + 1))
        .replace("{d}", String(t.d));
const _weekdayTitle = (w) => i18n.t("datetime.weekdayFormat", "星期{w}").replace("{w}", String(w));

function _getToday() {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
}

function _isSameDay(a, b) {
    return a && b && a.y === b.y && a.m === b.m && a.d === b.d;
}

function _getMonthMeta(year, month) {
    const firstDay = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    return { firstDay, totalDays };
}

/**
 * 旋转数组（用于周起始日）
 */
function _rotate(arr, n) {
    n = ((n % arr.length) + arr.length) % arr.length;
    return arr.slice(n).concat(arr.slice(0, n));
}

/**
 * 按当前周起始日重建星期表头（周日…周六 旋转到 周一…周日 或原样）。
 * @param {HTMLElement} [host=按 id 查找] 表头容器；_ensurePanel 里容器尚未入 DOM，需显式传入
 * @returns {void}
 */
function _renderWeekdays(host) {
    const container = host || document.getElementById("dtp-weekdays");
    if (!container) return;
    container.textContent = "";
    _rotate(_weekdayShort(), weekStart()).forEach((name) => {
        const cell = document.createElement("div");
        cell.className = "dtp-weekday";
        cell.textContent = name;
        container.appendChild(cell);
    });
}

/**
 * 创建日历面板 DOM（若未创建）
 */
function _ensurePanel() {
    if (_panelEl) return;

    const panel = document.createElement("div");
    panel.id = "datetime-popover";
    panel.className = "datetime-popover";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "日历");

    // 头部：月份标题 + 导航
    const header = document.createElement("div");
    header.className = "dtp-header";

    const makeNavBtn = (cls, title, delta) => {
        const btn = document.createElement("button");
        btn.className = `dtp-nav ${cls}`;
        btn.type = "button";
        btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M${delta < 0 ? "6.5 1.5L3 5L6.5 8.5" : "3.5 1.5L7 5L3.5 8.5"}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        btn.title = title;
        btn.addEventListener("click", (e) => { e.stopPropagation(); _shiftMonth(delta); });
        return btn;
    };
    const navPrev = makeNavBtn("dtp-prev", i18n.t("datetime.prevMonth", "上个月"), -1);
    const navNext = makeNavBtn("dtp-next", i18n.t("datetime.nextMonth", "下个月"), 1);

    const title = document.createElement("div");
    title.className = "dtp-title";
    title.id = "dtp-title";

    const todayBtn = document.createElement("button");
    todayBtn.className = "dtp-today-btn";
    todayBtn.type = "button";
    todayBtn.textContent = i18n.t("datetime.today", "今天");
    todayBtn.title = i18n.t("datetime.todayTitle", "跳转到今天");
    todayBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = _getToday();
        _viewYear = t.y;
        _viewMonth = t.m;
        _selected = { ...t };
        _render();
    });

    header.appendChild(navPrev);
    header.appendChild(title);
    header.appendChild(navNext);
    header.appendChild(todayBtn);
    panel.appendChild(header);

    // 星期表头（内容按周起始日旋转，设置变更时由 _renderWeekdays 重建）
    const weekdays = document.createElement("div");
    weekdays.className = "dtp-weekdays";
    weekdays.id = "dtp-weekdays";
    panel.appendChild(weekdays);
    _renderWeekdays(weekdays);

    // 日期网格（42格）
    const grid = document.createElement("div");
    grid.className = "dtp-grid";
    grid.id = "dtp-grid";
    for (let i = 0; i < 42; i++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "dtp-cell";
        cell.dataset.idx = String(i);
        cell.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(cell.dataset.idx, 10);
            const data = cell._dtpDate;
            if (!data) return;
            _selected = { y: data.y, m: data.m, d: data.d };
            // 若点了非本月日期，同步切换视图月份
            if (data.m !== _viewMonth || data.y !== _viewYear) {
                _viewYear = data.y;
                _viewMonth = data.m;
            }
            _render();
            _updateFooter();
        });
        grid.appendChild(cell);
    }
    panel.appendChild(grid);

    const sep = document.createElement("div");
    sep.className = "dtp-sep";
    panel.appendChild(sep);

    // 底部：今天详细日期信息
    const footer = document.createElement("div");
    footer.className = "dtp-footer";
    footer.id = "dtp-footer";
    panel.appendChild(footer);

    // 面板本身阻止点击冒泡（避免点击面板内容被当作外部点击关闭）
    panel.addEventListener("click", (e) => e.stopPropagation());

    document.body.appendChild(panel);
    _panelEl = panel;
}

function _render() {
    _ensurePanel();
    const today = _getToday();
    if (!_selected) _selected = { ...today };

    const titleEl = document.getElementById("dtp-title");
    if (titleEl) {
        titleEl.textContent = _monthTitle(_viewYear, _viewMonth);
    }

    const { firstDay, totalDays } = _getMonthMeta(_viewYear, _viewMonth);
    const start = weekStart();
    // 起始偏移：让该月第一天对齐正确的列
    const offset = ((firstDay - start) % 7 + 7) % 7;
    const prevTotal = new Date(_viewYear, _viewMonth, 0).getDate();

    const gridEl = document.getElementById("dtp-grid");
    if (!gridEl) return;
    const cells = gridEl.querySelectorAll(".dtp-cell");

    cells.forEach((cell, idx) => {
        let y = _viewYear;
        let m = _viewMonth;
        let d = 0;
        let inMonth = true;

        if (idx < offset) {
            // 上月尾部
            inMonth = false;
            m = _viewMonth - 1;
            if (m < 0) { m = 11; y = _viewYear - 1; }
            d = prevTotal - (offset - 1 - idx);
        } else if (idx < offset + totalDays) {
            // 本月
            d = idx - offset + 1;
        } else {
            // 下月头部
            inMonth = false;
            m = _viewMonth + 1;
            if (m > 11) { m = 0; y = _viewYear + 1; }
            d = idx - (offset + totalDays) + 1;
        }

        cell._dtpDate = { y, m, d };
        cell.textContent = String(d);

        const thisDay = { y, m, d };
        const isToday = _isSameDay(thisDay, today);
        const isSelected = _isSameDay(thisDay, _selected);
        // 列号 → 星期几：(周起始日 + 列) % 7，周六(6) 与周日(0) 记为周末。
        // 旧公式的第二项写的是 5，算出来是周五，而真正的周日那一列反而不算周末。
        const weekdayOfCol = (start + (idx % 7)) % 7;
        const isWeekend = weekdayOfCol === 0 || weekdayOfCol === 6;

        cell.classList.toggle("in-month", inMonth);
        cell.classList.toggle("out-month", !inMonth);
        cell.classList.toggle("today", isToday);
        cell.classList.toggle("selected", isSelected && !isToday);
        cell.classList.toggle("weekend", isWeekend);
    });
}

/**
 * 渲染底部今日信息（日期 + 星期）。
 * 用节点拼装而不是把日期拼进 HTML 串：文本全部走 textContent，
 * 与全站「innerHTML 不得带动态文本」的约定一致（`.dtp-footer strong` 的样式照旧命中）。
 */
function _updateFooter() {
    const footer = document.getElementById("dtp-footer");
    if (!footer) return;
    const today = _getToday();
    const weekday = _weekdayShort()[new Date(today.y, today.m, today.d).getDay()];
    footer.textContent = "";
    const date = document.createElement("strong");
    date.textContent = _dayTitle(today);
    footer.appendChild(date);
    footer.appendChild(document.createTextNode(`  ${_weekdayTitle(weekday)}`));
}

/**
 * 切换视图月份（-1 上月 / +1 下月）
 */
function _shiftMonth(delta) {
    let m = _viewMonth + delta;
    let y = _viewYear;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    _viewYear = y;
    _viewMonth = m;
    _render();
}

/**
 * 定位面板到锚点元素（菜单栏的时间/日期）下方，右对齐
 */
function _positionTo(anchor) {
    if (!_panelEl || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const pw = 320; // 面板宽度
    // 右对齐：让面板右边距比锚点右边再往外少许，并夹在屏幕内
    const left = Math.max(8, Math.min(rect.right - pw + 8, vw - pw - 8));
    const top = rect.bottom + 6;
    _panelEl.style.left = `${left}px`;
    _panelEl.style.top = `${top}px`;
}

/** @param {HTMLElement} anchor 锚点元素，用于定位 */
export function openPopover(anchor) {
    _ensurePanel();
    if (_isOpen) return;

    // 同层弹层互斥：先收起控制中心，否则两块面板叠在右上角互相盖。
    hideControlCenter();

    const today = _getToday();
    if (_viewYear === 0) {
        _viewYear = today.y;
        _viewMonth = today.m;
    }
    _anchorEl = anchor;
    _render();
    _updateFooter();
    _positionTo(anchor);

    // 触发显示动画（序号守卫：同帧 show→hide 时 rAF 不得把 open 加回，BUG-13）
    const seq = ++_openSeq;
    requestAnimationFrame(() => {
        if (seq !== _openSeq || !_panelEl) return;
        _panelEl.classList.add("open");
    });
    _isOpen = true;
    _attachGlobalClose();
}

export function closePopover() {
    if (!_isOpen || !_panelEl) return;
    _openSeq += 1; // 作废在途的 rAF 回调
    _panelEl.classList.remove("open");
    _isOpen = false;
    _detachGlobalClose();
    // 动画结束后不隐藏 DOM（方便下次淡入），仅保留隐藏状态
}

/** @param {HTMLElement} anchor 锚点元素 */
export function togglePopover(anchor) {
    if (_isOpen) closePopover();
    else openPopover(anchor);
}

// 全局点击关闭监听器（单独引用以便移除）
let _onDocClick = null;
let _onWinResize = null;
let _onWinScroll = null;

function _attachGlobalClose() {
    // 关闭监听挂在捕获阶段，早于锚点自身的 click，因此必须放过锚点上的点击：
    // 否则点一下时钟就是「先关再开」，面板永远无法用同一个入口收起。
    _onDocClick = (e) => {
        if (e.target.closest && e.target.closest("[data-datetime-anchor]")) return;
        // 面板内部（月份导航 / 日期格子 / “今天”）的点击不能算“点外面”：
        // 本监听在捕获阶段跑，早于面板自身的冒泡处理，不放过就会先关面板、按钮功能全落空。
        if (_panelEl && _panelEl.contains(e.target)) return;
        closePopover();
    };
    document.addEventListener("click", _onDocClick, true);

    // 窗口尺寸变化时重新定位或关闭（这里简单处理：重新定位）
    _onWinResize = () => {
        if (_isOpen && _anchorEl) _positionTo(_anchorEl);
    };
    window.addEventListener("resize", _onWinResize);

    // 滚动时关闭（防止错位）
    _onWinScroll = () => closePopover();
    window.addEventListener("scroll", _onWinScroll, true);
}

function _detachGlobalClose() {
    if (_onDocClick) { document.removeEventListener("click", _onDocClick, true); _onDocClick = null; }
    if (_onWinResize) { window.removeEventListener("resize", _onWinResize); _onWinResize = null; }
    if (_onWinScroll) { window.removeEventListener("scroll", _onWinScroll, true); _onWinScroll = null; }
}

/**
 * 初始化日历面板：为时间与日期元素绑定点击事件
 * @param {HTMLElement} timeEl  顶栏时间元素
 * @param {HTMLElement} dateEl  顶栏日期元素
 */
export function initDatetimePopover(timeEl, dateEl) {
    _ensurePanel();

    const onClick = (e) => {
        e.stopPropagation();
        togglePopover(e.currentTarget);
    };

    // 锚点绑定按元素去重：重复 init 若挂上第二份 onClick，一次点击就会 toggle 两次
    // （开→关），净表现是「点了没反应」。本模块其余监听都做了幂等，这里补齐同一约定。
    if (timeEl && !_boundAnchors.has(timeEl)) {
        _boundAnchors.add(timeEl);
        timeEl.setAttribute("data-datetime-anchor", "");
        timeEl.style.cursor = "default";
        timeEl.addEventListener("click", onClick);
    }
    if (dateEl && !_boundAnchors.has(dateEl)) {
        _boundAnchors.add(dateEl);
        dateEl.setAttribute("data-datetime-anchor", "");
        dateEl.style.cursor = "default";
        dateEl.addEventListener("click", onClick);
    }

    // ESC 关闭（同样幂等）
    if (!_escListener) {
        _escListener = (e) => {
            if (!_isOpen) return;
            if (e.key === "Escape") closePopover();
        };
        document.addEventListener("keydown", _escListener);
    }

    // 切换语言时重建面板：星期表头 / 月份名 / 导航与“今天”按钮文案在 _ensurePanel 时一次性烘焙，
    // 语言变更后必须丢弃旧面板，下次展开才会用新语言重新生成（init 可能多次调用，做幂等）。
    if (!_langListener) {
        _langListener = () => {
            closePopover();
            if (_panelEl) { _panelEl.remove(); _panelEl = null; }
            _ensurePanel();
        };
        document.addEventListener("languagechange", _langListener);
    }

    // 周起始日变更（general.weekStart，由 settings-definitions 的生效函数广播）：
    // 表头顺序与网格列的周末判定都跟着起始日走，必须就地重建，不必丢弃面板。
    // 时间格式 / 显示秒也走同一个事件，但本面板不渲染时刻，收到后重排一次即可。
    if (!_formatListener) {
        _formatListener = () => {
            _renderWeekdays();
            _render();
            _updateFooter();
        };
        window.addEventListener("datetime-format-change", _formatListener);
    }
}
