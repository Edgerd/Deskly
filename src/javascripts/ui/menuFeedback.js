/**
 * menuFeedback.js — 菜单项按下反馈
 *
 * macOS 的菜单项在鼠标按下时会先填强调色、短暂停留，再收起菜单并执行动作。
 * 点完立刻销毁菜单会让高亮连一帧都画不出来，所以这里统一把「标记 → 等一帧 →
 * 保持 → 收起/执行」的时序收进一个入口，共享菜单与插件自绘菜单都调用它。
 */

/** 按下态类名，样式见 assets/stylesheets/ui/ui.scss（全站统一覆盖层） */
export const MENU_PRESSED_CLASS = "menu-pressed";

/** 高亮保持时长：加一帧合成后约 100ms 总时长，落在 80–120ms 的手感区间 */
const PRESS_HOLD_MS = 90;

/** 禁用项不参与反馈，也不应执行动作（调用方可能漏判） */
function isDisabled(item) {
    return item.disabled === true
        || item.hasAttribute("disabled")
        || item.getAttribute("aria-disabled") === "true";
}

/** 子菜单入口：展开下一级菜单时不闪，只有真正的动作项才有按下态 */
function isSubmenuTrigger(item) {
    return item.classList.contains("has-submenu")
        || item.getAttribute("aria-haspopup") === "menu"
        || item.getAttribute("aria-haspopup") === "true";
}

/**
 * 先让菜单项进入按下态并保证被合成，再执行收起菜单与动作。
 *
 * @param {HTMLElement|null} item 被激活的菜单项
 * @param {Function} run 收起菜单并执行动作
 * @param {{submenu?: boolean, hold?: number}} [options]
 *        submenu=true 表示这是一次子菜单展开，跳过闪烁；
 *        hold 仅用于个别需要更长停留的入口，默认 90ms
 */
export function pressMenuItem(item, run, options = {}) {
    const action = typeof run === "function" ? run : () => {};
    if (!item || isDisabled(item)) return;

    // 子菜单展开保持即时响应；带子菜单的项悬停/点击都不该闪。
    if (options.submenu || isSubmenuTrigger(item)) {
        action();
        return;
    }

    // 同一项在保持期内被重复点击时只执行一次，避免动作叠加。
    if (item.classList.contains(MENU_PRESSED_CLASS)) return;

    item.classList.add(MENU_PRESSED_CLASS);
    const hold = Number.isFinite(options.hold) ? options.hold : PRESS_HOLD_MS;

    // rAF 保证按下态先被合成一帧，再由计时器给出可感知的停留时长。
    const waitFrame = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 0);

    waitFrame(() => {
        setTimeout(() => {
            item.classList.remove(MENU_PRESSED_CLASS);
            action();
        }, hold);
    });
}
