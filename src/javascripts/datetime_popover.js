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
 */

// 当前显示月份的状态（year/month，month: 0-11）
let _viewYear = 0;
let _viewMonth = 0;
// 选中日期（默认今天），格式 {y, m, d}
let _selected = null;
// 面板 DOM 元素
let _panelEl = null;
// 是否已打开
let _isOpen = false;
// 当前锚点元素（用于定位）
let _anchorEl = null;

// 星期名称（短名），顺序固定从周日开始，渲染时会按周起始日旋转
const WEEKDAY_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
// 月份全名
const MONTH_FULL = [
    "一月", "二月", "三月", "四月", "五月", "六月",
    "七月", "八月", "九月", "十月", "十一月", "十二月",
];
// 周起始日：0=周日，1=周一（macOS 默认周一）
const WEEK_START = 1;

/**
 * 获取今天的日期信息 {y, m, d}
 */
function _getToday() {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
}

/**
 * 判断两个日期对象是否同一天
 */
function _isSameDay(a, b) {
    return a && b && a.y === b.y && a.m === b.m && a.d === b.d;
}

/**
 * 返回指定年月的第一天是星期几（0-6）以及该月总天数
 */
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
    const navPrev = makeNavBtn("dtp-prev", "上个月", -1);
    const navNext = makeNavBtn("dtp-next", "下个月", 1);

    const title = document.createElement("div");
    title.className = "dtp-title";
    title.id = "dtp-title";

    const todayBtn = document.createElement("button");
    todayBtn.className = "dtp-today-btn";
    todayBtn.type = "button";
    todayBtn.textContent = "今天";
    todayBtn.title = "跳转到今天";
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

    // 星期表头
    const weekdays = document.createElement("div");
    weekdays.className = "dtp-weekdays";
    weekdays.id = "dtp-weekdays";
    // 按周起始日旋转
    const rotated = _rotate(WEEKDAY_SHORT, WEEK_START);
    rotated.forEach((w) => {
        const el = document.createElement("div");
        el.className = "dtp-weekday";
        el.textContent = w;
        weekdays.appendChild(el);
    });
    panel.appendChild(weekdays);

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

    // 分隔线
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

/**
 * 渲染月份标题与日期网格
 */
function _render() {
    _ensurePanel();
    const today = _getToday();
    if (!_selected) _selected = { ...today };

    // 标题
    const titleEl = document.getElementById("dtp-title");
    if (titleEl) {
        titleEl.textContent = `${_viewYear} 年 ${MONTH_FULL[_viewMonth]}`;
    }

    const { firstDay, totalDays } = _getMonthMeta(_viewYear, _viewMonth);
    // 起始偏移：让该月第一天对齐正确的列
    const offset = ((firstDay - WEEK_START) % 7 + 7) % 7;
    // 上月天数
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
        const isWeekend = ((idx % 7) === (6 - WEEK_START + 7) % 7) || ((idx % 7) === (5 - WEEK_START + 7) % 7);

        cell.classList.toggle("in-month", inMonth);
        cell.classList.toggle("out-month", !inMonth);
        cell.classList.toggle("today", isToday);
        cell.classList.toggle("selected", isSelected && !isToday);
        cell.classList.toggle("weekend", isWeekend);
    });
}

/**
 * 渲染底部今日信息
 */
function _updateFooter() {
    const footer = document.getElementById("dtp-footer");
    if (!footer) return;
    const today = _getToday();
    const weekday = WEEKDAY_SHORT[new Date(today.y, today.m, today.d).getDay()];
    footer.innerHTML = `<strong>${today.y} 年 ${today.m + 1} 月 ${today.d} 日</strong>  星期${weekday}`;
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

/**
 * 打开日历面板
 * @param {HTMLElement} anchor  锚点元素，用于定位
 */
export function openPopover(anchor) {
    _ensurePanel();
    if (_isOpen) return;

    const today = _getToday();
    if (_viewYear === 0) {
        _viewYear = today.y;
        _viewMonth = today.m;
    }
    _anchorEl = anchor;
    _render();
    _updateFooter();
    _positionTo(anchor);

    // 触发显示动画
    requestAnimationFrame(() => {
        _panelEl.classList.add("open");
    });
    _isOpen = true;
    _attachGlobalClose();
}

/**
 * 关闭日历面板
 */
export function closePopover() {
    if (!_isOpen || !_panelEl) return;
    _panelEl.classList.remove("open");
    _isOpen = false;
    _detachGlobalClose();
    // 动画结束后不隐藏 DOM（方便下次淡入），仅保留隐藏状态
}

/**
 * 切换面板显示
 * @param {HTMLElement} anchor 锚点元素
 */
export function togglePopover(anchor) {
    if (_isOpen) closePopover();
    else openPopover(anchor);
}

// 全局点击关闭监听器（单独引用以便移除）
let _onDocClick = null;
let _onWinResize = null;
let _onWinScroll = null;

function _attachGlobalClose() {
    _onDocClick = () => closePopover();
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

    if (timeEl) {
        timeEl.style.cursor = "default";
        timeEl.addEventListener("click", onClick);
    }
    if (dateEl) {
        dateEl.style.cursor = "default";
        dateEl.addEventListener("click", onClick);
    }

    // ESC 关闭
    document.addEventListener("keydown", (e) => {
        if (!_isOpen) return;
        if (e.key === "Escape") closePopover();
    });
}
