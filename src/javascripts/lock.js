/**
 * lock.js — 锁屏 owner：macOS Sequoia 风格锁屏 + 口令闸门 + 跨刷新持久化
 *
 * 设计约束（改动前先读完）：
 *
 * 1. **口令绝不进设置中枢**。`settings.snapshot()` 会把所有已注册键的原始存储值导出成
 *    备份文本，口令材料一旦进那条链路就等于把口令打进备份里。因此这里只存
 *    `SHA-256(盐:口令)` 的十六进制摘要（槽 `deskly-lock-hash`）与随机盐
 *    （槽 `deskly-lock-salt`），盐由 `crypto.getRandomValues` 生成。日志里既不出现
 *    明文也不出现摘要。
 * 2. **锁定态跨刷新持久化**：锁定期间 `deskly-lock-state` 恒为 "1"，解锁即清除。
 *    刷新后 initLock() 在 bootstrap 关键路径上被调用（早于可选模块的空闲点亮），
 *    读到持久标记就立即重建锁屏遮罩 —— 刷新不能解锁。另有 `lock.lockAtBoot`
 *    （开机锁定）开关：设了口令且要求口令时，每次进入桌面先锁。
 * 3. **递增惩罚持久化**：连续输错达到 MAX_ATTEMPTS 触发冷却，冷却时长按
 *    LOCKOUT_LADDER 逐级升级（15s → 60s → 300s → 900s），级别与截止时间写入
 *    `deskly-lock-penalty` —— 刷新不能洗白惩罚。口令验证通过才清零。
 * 4. **界面与动画**：整屏遮罩在 `Z.SESSION`，毛玻璃来自 `backdrop-filter`。
 *    项目铁律是 **backdrop-filter 元素上不得加 transform**（transform 会改变它的
 *    包含块与模糊范围），所以抖动、进场、退场动画全部做在内层 content 包装元素上，
 *    遮罩本体只做 opacity 过渡。外观对齐 macOS Sequoia：大号细体时钟 + 日期、
 *    头像圆 + 用户名、胶囊密码框内嵌圆形确认钮。
 * 5. **没有逃生口**：口令闸门（gated）下唯一的解锁分支是「口令哈希校验通过」。
 *    界面上没有强制解锁按钮/隐藏点击区/快捷键；对外暴露的 `lock.unlock()` 在
 *    口令闸门期间直接拒绝（防控制台绕过）。设了口令却忘了：只能清除本站数据
 *    （浏览器站点设置里清 Storage），锁屏配置连同桌面配置一起重置 —— 锁屏界面
 *    以纯文本写明这一点，不给可点击的入口。
 * 6. **闸门状态钉死在加锁瞬间**：`state.gatedLock` 在 lockNow 时定型。锁定期间
 *    即使有人从控制台把 `lock.requirePassword` 关掉、或调 setPassword/clearPassword，
 *    闸门也不会降级：口令材料的操作在锁定态一律拒绝，重绘只认钉死的闸门。
 *    遮罩节点被外力从 DOM 摘掉时，时钟节拍会把它重新挂回。
 */
import { settings } from "./settings.js";
import { Z } from "./zindex.js";
import { i18n } from "./i18n.js";
import { APP_NAME } from "./version.js";
import { dismissAllNotifications } from "./ui/notification.js";

/** 口令材料槽：摘要 + 盐，与设置槽分开，绝不进 snapshot()。 */
const HASH_SLOT = "deskly-lock-hash";
const SALT_SLOT = "deskly-lock-salt";
/** 锁定态持久槽："1" = 锁定中，删除 = 未锁定。 */
const STATE_SLOT = "deskly-lock-state";
/** 递增惩罚槽：JSON {until:number, level:number}。 */
const PENALTY_SLOT = "deskly-lock-penalty";

const OVERLAY_ID = "deskly-lock-screen";

/** 口令错误达到该次数后触发一次冷却。 */
const MAX_ATTEMPTS = 5;
/** 递增冷却阶梯（秒）：连续触发逐级升级，验证通过后清零。 */
const LOCKOUT_LADDER = [15, 60, 300, 900];

/** 算作「用户活动」的事件（与 macOS 的空闲判定同一套输入源）。 */
const IDLE_EVENTS = ["mousemove", "keydown", "click", "touchstart", "scroll"];

/** 活动事件的最小重记间隔（毫秒）：mousemove 一秒能来上百次，不必每次都重排计时器。 */
const ACTIVITY_THROTTLE = 2000;

/** 统一缓动：项目标准出/入场曲线。 */
const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

/** 解锁退场时长（毫秒）。 */
const EXIT_MS = 340;

/**
 * 遮罩样式：整屏毛玻璃压暗。注意本元素永不加 transform（backdrop-filter 铁律）。
 * 文字色写死 #fff：遮罩在任何主题下都是暗场（底色不随主题变），用全局令牌会在
 * 浅色主题下推导出黑字，压在暗场上反而看不清。
 */
const OVERLAY_STYLE = "position:fixed;inset:0;box-sizing:border-box;color:#fff;"
    + "background:rgba(0,0,0,0.30);backdrop-filter:blur(var(--surface-blur-4)) saturate(var(--surface-saturate));"
    + "-webkit-backdrop-filter:blur(var(--surface-blur-4)) saturate(var(--surface-saturate));cursor:default;"
    + "user-select:none;-webkit-user-select:none;opacity:0;"
    + `transition:opacity ${EXIT_MS}ms ${EASING};`;

/** 内层内容包装：一切 transform 动画都挂这里，它不带 backdrop-filter。 */
const CONTENT_STYLE = "position:absolute;inset:0;display:flex;flex-direction:column;"
    + "align-items:center;justify-content:space-between;text-align:center;";

/** 确认按钮里的右箭头（SVG，禁用 emoji 的项目约束）。 */
const ARROW_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** 运行时状态。 */
const state = {
    overlay: null,
    refs: null,
    clockTimer: null,
    idleTimer: null,
    cooldownTimer: null,
    penalty: { until: 0, level: 0 },
    attempts: 0,
    lastActivity: 0,
    watching: false,
    detachInput: null,
    unlocking: false,
    /** 加锁瞬间钉死的闸门状态：锁定期间外部改设置也不能让它降级。 */
    gatedLock: false,
};

/** localStorage 不可用（隐私模式）时口令材料与持久态的内存替身。 */
const memory = new Map();

/**
 * 读持久槽；存储读不到时回退内存替身。
 * @param {string} slot 槽名
 * @returns {string} 原始文本
 */
function readSlot(slot) {
    try {
        const raw = globalThis.localStorage?.getItem(slot);
        return raw ? String(raw) : (memory.get(slot) || "");
    } catch {
        return memory.get(slot) || "";
    }
}

/**
 * 写持久槽（空值即删除）。
 * @param {string} slot 槽名
 * @param {string} value 内容
 * @returns {void}
 */
function writeSlot(slot, value) {
    try {
        if (value) globalThis.localStorage.setItem(slot, String(value));
        else globalThis.localStorage.removeItem(slot);
        return;
    } catch {
        if (value) memory.set(slot, String(value));
        else memory.delete(slot);
    }
}

/** 注册本模块托管的设置项。 */
function defineSchema() {
    settings.defineMany([
        {
            key: "lock.autoLockMinutes", type: "number", default: 0, min: 0, max: 120, step: 5,
            units: "分钟", control: "slider", pane: "lock-screen", group: "锁定屏幕", order: 10,
            label: "无操作后锁定", hint: "0 表示从不。",
            apply: () => armIdleTimer(),
        },
        {
            key: "lock.requirePassword", type: "boolean", default: false,
            control: "switch", pane: "lock-screen", group: "锁定屏幕", order: 20,
            label: "解锁需要密码",
            apply: () => rerenderIfLocked(),
        },
        {
            key: "lock.lockAtBoot", type: "boolean", default: false,
            control: "switch", pane: "lock-screen", group: "锁定屏幕", order: 30,
            label: "启动时锁定", hint: "每次打开新标签页先进入锁定屏幕。",
        },
    ]);
}

/** 空闲分钟数（0 = 从不）。 */
function autoLockMinutes() {
    const value = Number(settings.get("lock.autoLockMinutes"));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function requiresPassword() {
    return Boolean(settings.get("lock.requirePassword"));
}

// ---- 口令材料 ----

/**
 * 生成 n 字节随机十六进制串。
 * @param {number} bytes 字节数
 * @returns {string} 十六进制文本
 */
function randomHex(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 算 SHA-256 十六进制摘要。
 * @param {string} text 待摘要文本
 * @returns {Promise<string>} 摘要；没有 WebCrypto（非安全上下文）时为空串
 */
async function digestHex(text) {
    if (!crypto?.subtle?.digest) return "";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 本机是否已设置解锁口令。
 * @returns {boolean} 摘要与盐是否都在
 */
function hasPassword() {
    return Boolean(readSlot(HASH_SLOT)) && Boolean(readSlot(SALT_SLOT));
}

/**
 * 设置解锁口令：生成新盐并重算摘要。
 * @param {string} plain 口令明文（只存在于参数里，不落盘、不进日志）
 * @returns {Promise<boolean>} 是否设置成功
 */
async function setPassword(plain) {
    // 锁定态拒绝改口令：否则「先改掉密码再输新密码」就成了一键绕过。
    if (isLocked()) {
        window.__log?.warn("kernel/lock", "锁定状态下拒绝修改口令");
        return false;
    }
    const text = typeof plain === "string" ? plain : "";
    if (!text) {
        window.__log?.warn("kernel/lock", "未设置口令：内容为空");
        return false;
    }
    if (!crypto?.subtle?.digest) {
        window.__log?.error("kernel/lock", "当前上下文没有 WebCrypto（需安全上下文），无法设置解锁口令");
        return false;
    }
    try {
        const salt = randomHex(16);
        const hash = await digestHex(`${salt}:${text}`);
        if (!hash) return false;
        writeSlot(SALT_SLOT, salt);
        writeSlot(HASH_SLOT, hash);
        state.attempts = 0;
        window.__log?.info("kernel/lock", "解锁口令已更新（仅存随机盐与 SHA-256 摘要）");
        rerenderIfLocked();
        return true;
    } catch (err) {
        window.__log?.error("kernel/lock", "口令写入失败", err);
        return false;
    }
}

/**
 * 校验口令。
 * @param {string} plain 待验证明文
 * @returns {Promise<boolean>} 是否匹配；从未存过口令时恒为 false
 */
async function checkPassword(plain) {
    if (!hasPassword()) return false;
    const text = typeof plain === "string" ? plain : "";
    if (!text) return false;
    try {
        const actual = await digestHex(`${readSlot(SALT_SLOT)}:${text}`);
        return Boolean(actual) && actual === readSlot(HASH_SLOT);
    } catch (err) {
        window.__log?.error("kernel/lock", "口令校验异常", err);
        return false;
    }
}

/**
 * 清除口令材料：只删摘要与盐，不动 lock.requirePassword 设置。
 * @returns {boolean} 之前是否存有口令
 */
function clearPassword() {
    // 锁定态拒绝清口令：否则「清掉密码再点任意处」就成了一键绕过。
    if (isLocked()) {
        window.__log?.warn("kernel/lock", "锁定状态下拒绝清除口令");
        return false;
    }
    const had = hasPassword();
    writeSlot(HASH_SLOT, "");
    writeSlot(SALT_SLOT, "");
    if (had) window.__log?.info("kernel/lock", "解锁口令已清除");
    rerenderIfLocked();
    return had;
}

// ---- 递增惩罚 ----

/** 从持久槽恢复惩罚状态（刷新不能洗白冷却；已过期的冷却只保留递增级别）。 */
function loadPenalty() {
    try {
        const raw = readSlot(PENALTY_SLOT);
        if (!raw) return;
        const data = JSON.parse(raw);
        const until = Number(data?.until);
        const level = Number(data?.level);
        if (Number.isFinite(level)) {
            state.penalty.level = Math.max(0, Math.min(LOCKOUT_LADDER.length - 1, level));
        }
        if (Number.isFinite(until) && until > Date.now()) {
            state.penalty.until = until;
        }
        if (!state.penalty.until && !state.penalty.level) writeSlot(PENALTY_SLOT, "");
    } catch {
        writeSlot(PENALTY_SLOT, "");
    }
}

/** 落盘惩罚状态。 */
function savePenalty() {
    if (!state.penalty.until && !state.penalty.level) writeSlot(PENALTY_SLOT, "");
    else writeSlot(PENALTY_SLOT, JSON.stringify(state.penalty));
}

/** 触发一次冷却：时长按当前级别取阶梯，级别升一级。 */
function escalatePenalty() {
    const level = Math.min(state.penalty.level, LOCKOUT_LADDER.length - 1);
    state.penalty.until = Date.now() + LOCKOUT_LADDER[level] * 1000;
    state.penalty.level = Math.min(level + 1, LOCKOUT_LADDER.length - 1);
    savePenalty();
    window.__log?.warn("kernel/lock", `连续输错 ${MAX_ATTEMPTS} 次，冷却 ${LOCKOUT_LADDER[level]} 秒`);
}

/** 口令验证通过：惩罚与失败计数全部清零。 */
function resetPenalty() {
    state.penalty = { until: 0, level: 0 };
    state.attempts = 0;
    savePenalty();
}

/** 冷却剩余秒数。 */
function cooldownLeft() {
    return Math.max(0, Math.ceil((state.penalty.until - Date.now()) / 1000));
}

// ---- 时钟文本 ----

/** 当前界面语言（i18n 未就绪时退回中文）。 */
function locale() {
    try {
        return i18n.getLanguage?.() || "zh-CN";
    } catch {
        return "zh-CN";
    }
}

/**
 * 按 general.timeFormat 格式化时钟。
 * @param {Date} now 时间
 * @returns {string} 时钟文本
 */
function clockText(now) {
    const use24 = settings.get("general.timeFormat") !== "12h";
    try {
        return new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hour12: !use24 }).format(now);
    } catch {
        return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    }
}

/**
 * 日期一行（macOS 锁屏格式：星期 + 月日，不带年份）。
 * @param {Date} now 时间
 * @returns {string} 日期文本
 */
function dateText(now) {
    try {
        return new Intl.DateTimeFormat(locale(), {
            month: "long", day: "numeric", weekday: "long",
        }).format(now);
    } catch {
        return now.toDateString();
    }
}

// ---- 遮罩界面 ----

/**
 * 建一个只含文本的元素（本模块不拼 HTML，全部走 textContent；SVG 图标除外，常量字符串）。
 * @param {string} tag 标签名
 * @param {string} text 文本
 * @param {string} style 内联样式
 * @returns {HTMLElement} 元素
 */
function textOf(tag, text, style) {
    const el = document.createElement(tag);
    el.textContent = text;
    if (style) el.style.cssText = style;
    return el;
}

/**
 * 抖动一下（口令错误的视觉反馈）。
 * @param {HTMLElement} el 目标元素（不带 backdrop-filter）
 * @returns {void}
 */
function shake(el) {
    if (!el || typeof el.animate !== "function") return;
    el.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-9px)" }, { transform: "translateX(9px)" },
            { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "translateX(0)" }],
        { duration: 340, easing: "ease-in-out" },
    );
}

/** 停掉时钟与冷却计时。 */
function stopTimers() {
    if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; }
    if (state.cooldownTimer) { clearInterval(state.cooldownTimer); state.cooldownTimer = null; }
}

/**
 * 进入/恢复冷却：锁住输入框并倒计时。刷新后惩罚槽里还有未过期的冷却时，
 * 重建遮罩也会走这里把剩余时间续上。
 * @param {object} refs buildOverlay 的元素引用
 * @returns {void}
 */
function startCooldown(refs) {
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
    const tick = () => {
        const left = cooldownLeft();
        if (left > 0) {
            refs.status.textContent = `${i18n.t("lock.tooMany", "错误次数过多，请")} ${left} ${i18n.t("lock.tooManySuffix", "秒后重试")}`;
            return;
        }
        clearInterval(state.cooldownTimer);
        state.cooldownTimer = null;
        state.penalty.until = 0;
        savePenalty();
        state.attempts = 0;
        if (refs.input) refs.input.disabled = false;
        if (refs.button) refs.button.disabled = false;
        refs.status.textContent = refs.gated ? i18n.t("lock.prompt", "输入密码解锁") : "";
        try { refs.input?.focus(); } catch { /* 遮罩已移除 */ }
    };
    tick();
    state.cooldownTimer = setInterval(tick, 500);
    if (refs.input) { refs.input.disabled = true; refs.input.value = ""; }
    if (refs.button) refs.button.disabled = true;
}

/**
 * 圆形头像：半透明底 + 用户名首字符。
 * @returns {HTMLElement} 头像元素
 */
function buildAvatar() {
    const avatar = textOf("div", "", "width:76px;height:76px;border-radius:50%;display:flex;"
        + "align-items:center;justify-content:center;background:rgba(255,255,255,.22);"
        + "box-shadow:inset 0 0 0 1px rgba(255,255,255,.18),0 6px 24px rgba(0,0,0,.25);");
    avatar.appendChild(textOf("span", (APP_NAME || "D").charAt(0).toUpperCase(),
        "font-size:34px;font-weight:500;color:rgba(255,255,255,.92);"));
    return avatar;
}

/**
 * 胶囊密码输入区：圆角输入框 + 内嵌圆形确认钮。
 * @returns {{form:HTMLFormElement, input:HTMLInputElement, button:HTMLButtonElement}} 部件
 */
function buildPasswordForm() {
    const form = document.createElement("form");
    form.style.cssText = "position:relative;display:flex;align-items:center;";

    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = i18n.t("lock.passwordPlaceholder", "输入密码");
    input.setAttribute("aria-label", i18n.t("lock.passwordLabel", "解锁密码"));
    input.style.cssText = "width:216px;height:38px;box-sizing:border-box;padding:0 44px 0 18px;"
        + "border-radius:999px;border:1px solid rgba(255,255,255,.26);outline:none;"
        + "background:rgba(255,255,255,.20);color:#fff;font-size:14px;text-align:center;"
        + "caret-color:#fff;";
    // 聚焦态只改纯绘制属性（background/box-shadow），不碰 filter/transform。
    input.addEventListener("focus", () => {
        input.style.background = "rgba(255,255,255,.28)";
        input.style.boxShadow = "0 0 0 3px rgba(255,255,255,.18)";
    });
    input.addEventListener("blur", () => {
        input.style.background = "rgba(255,255,255,.20)";
        input.style.boxShadow = "none";
    });

    const button = document.createElement("button");
    button.type = "submit";
    button.setAttribute("aria-label", i18n.t("lock.unlock", "解锁"));
    button.style.cssText = "position:absolute;right:5px;width:28px;height:28px;border-radius:50%;border:0;"
        + "display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;"
        + "background:rgba(255,255,255,.30);";
    button.innerHTML = ARROW_SVG;
    button.addEventListener("mouseenter", () => { button.style.background = "rgba(255,255,255,.45)"; });
    button.addEventListener("mouseleave", () => { button.style.background = "rgba(255,255,255,.30)"; });

    form.append(input, button);
    return { form, input, button };
}

/**
 * 构建锁定界面（macOS Sequoia：上方大号时钟，下方头像 + 用户名 + 密码区）。
 * @returns {{overlay:HTMLElement, content:HTMLElement, clock:HTMLElement, date:HTMLElement,
 *            status:HTMLElement, input:HTMLInputElement|null, button:HTMLButtonElement|null,
 *            escape:HTMLElement, gated:boolean, formRow:HTMLElement|null}} 元素引用
 */
function buildOverlay() {
    const overlay = textOf("div", "", OVERLAY_STYLE);
    overlay.id = OVERLAY_ID;
    overlay.className = "lock-overlay os-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", i18n.t("lock.title", "锁定屏幕"));
    overlay.style.zIndex = String(Z.SESSION);

    const content = document.createElement("div");
    content.style.cssText = CONTENT_STYLE;

    // 上方：日期 + 大号细体时钟。
    const now = new Date();
    const top = document.createElement("div");
    top.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px;"
        + "padding-top:11vh;";
    const date = textOf("div", dateText(now), "font-size:21px;font-weight:500;opacity:.92;");
    const clock = textOf("div", clockText(now),
        "font-size:104px;line-height:1;font-weight:200;letter-spacing:-.02em;font-variant-numeric:tabular-nums;");
    top.append(date, clock);

    // 下方：头像 + 用户名 + 密码区 / 无密码提示 + 状态行（+ 忘记密码说明）。
    const bottom = document.createElement("div");
    bottom.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:10px;"
        + "padding-bottom:9vh;";

    const name = textOf("div", APP_NAME, "font-size:17px;font-weight:600;");

    // 闸门判定：锁定中只认加锁瞬间钉死的状态（锁定期间外部改设置不得降级）；
    // 未锁定（lockNow 构建期）才按当下设置与口令材料现算。
    const gated = state.overlay ? state.gatedLock : (requiresPassword() && hasPassword());
    let input = null;
    let button = null;
    let formRow = null;
    if (gated) {
        const parts = buildPasswordForm();
        formRow = parts.form;
        input = parts.input;
        button = parts.button;
    } else {
        formRow = textOf("div", i18n.t("lock.tapToUnlock", "点击或按任意键解锁"),
            "font-size:14px;opacity:.75;");
    }

    const status = textOf("div", gated ? i18n.t("lock.prompt", "输入密码解锁") : "",
        "font-size:13px;opacity:.8;min-height:18px;");

    bottom.append(buildAvatar(), name, formRow, status);

    // 忘记口令的自救说明：纯文本提示，刻意不做成可点击元素（不给任何绕过入口）。
    if (gated) {
        bottom.appendChild(textOf("div",
            i18n.t("lock.forgotHint", "忘记密码？清除本站数据可重置，代价是桌面配置一并丢失。"),
            "margin-top:14px;max-width:340px;font-size:11px;line-height:1.5;"
            + "color:rgba(255,255,255,.45);"));
    }

    content.append(top, bottom);
    overlay.appendChild(content);

    return { overlay, content, clock, date, status, input, button, gated, formRow };
}

/** 锁定时重绘界面（设置里刚勾上「解锁需要密码」、刚改完口令或语言切换时用）。 */
function rerenderIfLocked() {
    if (!state.overlay || !state.refs) return;
    const refs = buildOverlay();
    refs.overlay.style.opacity = "1"; // 重绘不重新播进场动画
    state.overlay.replaceWith(refs.overlay);
    state.overlay = refs.overlay;
    wireLockInteractions(refs);
    if (refs.gated && cooldownLeft() > 0) startCooldown(refs);
}

/**
 * 把交互接到遮罩上：解锁途径只有两条 —— 口令哈希校验通过（有闸门）、
 * 任意输入（无闸门即未设口令/未要求口令时）。没有第三条路。
 * @param {object} refs buildOverlay 的元素引用
 * @returns {void}
 */
function wireLockInteractions(refs) {
    state.detachInput?.();
    const onClick = () => { if (!refs.gated) completeUnlock("input"); };
    const onKey = () => { if (!refs.gated) completeUnlock("input"); };
    refs.overlay.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    if (refs.gated && refs.input && refs.button && refs.formRow) {
        const form = refs.formRow;
        const submit = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (cooldownLeft() > 0) return;
            const value = refs.input.value;
            refs.input.value = "";
            if (await checkPassword(value)) { completeUnlock("password"); return; }
            state.attempts += 1;
            shake(refs.formRow);
            if (state.attempts >= MAX_ATTEMPTS) {
                escalatePenalty();
                startCooldown(refs);
            } else {
                refs.status.textContent = `${i18n.t("lock.wrong", "密码不正确")}（${state.attempts} / ${MAX_ATTEMPTS}）`;
            }
        };
        form.addEventListener("submit", submit);
        form.addEventListener("click", (event) => event.stopPropagation());
        setTimeout(() => { try { refs.input.focus(); } catch { /* 遮罩已移除 */ } }, 0);
    }
    state.refs = refs;
    state.detachInput = () => {
        refs.overlay.removeEventListener("click", onClick);
        window.removeEventListener("keydown", onKey, true);
    };
}

/**
 * 立即锁定屏幕。
 * @param {string} [reason="manual"] 触发来源（menu / idle / sleep / boot / controlcenter），只进日志
 * @returns {boolean} 是否真的锁上（已处于锁定态时 false）
 */
function lockNow(reason = "manual") {
    if (state.overlay) return false;
    state.attempts = 0;
    state.unlocking = false;
    dismissAllNotifications();
    const refs = buildOverlay();
    document.body.appendChild(refs.overlay);
    state.overlay = refs.overlay;
    state.gatedLock = refs.gated;
    writeSlot(STATE_SLOT, "1");
    wireLockInteractions(refs);

    // 刷新后惩罚槽里可能还有未过期的冷却：续上而不是放过。
    if (refs.gated && cooldownLeft() > 0) startCooldown(refs);

    stopTimers();
    state.clockTimer = setInterval(() => {
        // 引用必须每秒现读 state.refs：rerenderIfLocked 会把遮罩整棵 replaceWith，
        // 闭包钉住旧 refs 的话时钟就永远往已摘除的旧节点写（BUG-41）。
        const live = state.refs || refs;
        const now = new Date();
        const nextClock = clockText(now);
        const nextDate = dateText(now);
        if (live.clock.textContent !== nextClock) live.clock.textContent = nextClock;
        if (live.date.textContent !== nextDate) live.date.textContent = nextDate;
        // 遮罩被外力从 DOM 摘掉（devtools 删节点）时挂回：绕过成本不能只是「选中按 Delete」。
        if (!live.overlay.isConnected) document.body.appendChild(live.overlay);
    }, 1000);

    // 进场：遮罩淡入 + 内容上移（transform 只在无 backdrop-filter 的内层）。
    requestAnimationFrame(() => {
        refs.overlay.style.opacity = "1";
        refs.content.style.willChange = "transform, opacity";
        const enter = refs.content.animate(
            [{ transform: "translateY(14px)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }],
            { duration: 420, easing: EASING },
        );
        enter.onfinish = () => { refs.content.style.willChange = ""; };
    });

    document.dispatchEvent(new CustomEvent("lock-screen-change", { detail: { locked: true, reason }, bubbles: true }));
    window.__log?.info("kernel/lock", `屏幕已锁定（${reason}）`, { gated: refs.gated });
    return true;
}

/**
 * 完成解锁（内部路径）：播退场动画后摘除遮罩、清持久标记。
 * 只摘遮罩，不清口令、不改设置；口令验证通过时惩罚已先行清零。
 * 本函数不对外暴露 —— 暴露给控制台的是带闸门守卫的 requestUnlock。
 * @param {string} [reason="manual"] 解锁途径（password / input），只进日志
 * @returns {boolean} 是否从锁定态进入了解锁流程
 */
function completeUnlock(reason = "manual") {
    if (!state.overlay || state.unlocking) return false;
    state.unlocking = true;
    if (reason === "password") resetPenalty();
    state.detachInput?.();
    state.detachInput = null;
    stopTimers();
    state.attempts = 0;
    writeSlot(STATE_SLOT, "");

    const overlay = state.overlay;
    const refs = state.refs;
    state.refs = null;
    document.dispatchEvent(new CustomEvent("lock-screen-change", { detail: { locked: false, reason }, bubbles: true }));
    window.__log?.info("kernel/lock", `已解锁（${reason}）`);

    const finish = () => {
        overlay.remove();
        if (state.overlay === overlay) state.overlay = null;
        state.unlocking = false;
        state.gatedLock = false;
        armIdleTimer();
    };

    // 退场：遮罩自身走 opacity 过渡（transition 已挂在 OVERLAY_STYLE 上）；
    // 内容上飘 + 淡出，transform 只作用在无 backdrop-filter 的内层包装。
    overlay.style.opacity = "0";
    if (refs?.content && typeof refs.content.animate === "function") {
        refs.content.style.willChange = "transform, opacity";
        const exit = refs.content.animate(
            [{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-26px)", opacity: 0 }],
            { duration: EXIT_MS, easing: EASING, fill: "forwards" },
        );
        exit.onfinish = finish;
        // Web Animations 被取消（极少见：遮罩被外力移除）时兜底收场。
        exit.oncancel = finish;
    } else {
        setTimeout(finish, EXIT_MS);
    }
    return true;
}

/**
 * 对外解锁请求（带闸门守卫）：口令闸门期间一律拒绝 —— 从控制台调
 * `__lock.unlock()` 不能绕过密码。无闸门（未设口令/未要求口令）时才放行，
 * 与界面上「点击任意处解锁」同一条路径。
 * @param {string} [reason="manual"] 调用来源，只进日志
 * @returns {boolean} 是否真正进入了解锁流程
 */
function requestUnlock(reason = "manual") {
    if (state.gatedLock) {
        window.__log?.warn("kernel/lock", `口令闸门期间拒绝外部解锁请求（${reason}）`);
        return false;
    }
    return completeUnlock(reason);
}

/**
 * 当前是否处于锁定态（含解锁退场动画进行中）。
 * @returns {boolean} 是否锁定
 */
function isLocked() {
    return Boolean(state.overlay);
}

/**
 * 口令闸门是否生效：读加锁瞬间钉死的快照（锁定期间外部改设置不降级）。
 * 键盘闸门（keyboard.js）据此区分「只放行口令输入键」与「任意键解锁」。
 * @returns {boolean} 是否带口令闸门
 */
function isGated() {
    return Boolean(state.overlay) && state.gatedLock;
}

// ---- 空闲看门狗 ----

/** 按当前设置重排空闲计时器（0 分钟 = 从不，计时器直接摘掉）。 */
function armIdleTimer() {
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
    const minutes = autoLockMinutes();
    if (!minutes || state.overlay) return;
    state.idleTimer = setTimeout(() => {
        state.idleTimer = null;
        if (autoLockMinutes() > 0 && !isLocked()) lockNow("idle");
    }, minutes * 60000);
}

/** 用户活动：节流后重排计时器。 */
function onActivity() {
    const now = Date.now();
    if (now - state.lastActivity < ACTIVITY_THROTTLE) return;
    state.lastActivity = now;
    armIdleTimer();
}

/** 挂上活动监听（只挂一次）。 */
function startWatching() {
    if (state.watching) return;
    state.watching = true;
    IDLE_EVENTS.forEach((type) => window.addEventListener(type, onActivity, { passive: true }));
    armIdleTimer();
}

/**
 * 刷新重锁判定：持久标记在，或「开机锁定 + 已设口令 + 要求口令」成立时立即上锁。
 * 由 initLock 在 bootstrap 关键路径调用，早于桌面可交互。
 * @returns {boolean} 是否执行了重锁
 */
function relockIfNeeded() {
    if (state.overlay) return true;
    if (readSlot(STATE_SLOT) === "1") return lockNow("boot-resume");
    if (settings.get("lock.lockAtBoot") && hasPassword() && requiresPassword()) {
        return lockNow("boot");
    }
    return false;
}

/** 锁屏模块对外 API（挂到 window.__lock，供设置面板与命令调用）。 */
const lock = {
    hasPassword,
    setPassword,
    checkPassword,
    clearPassword,
    lockNow,
    unlock: requestUnlock,
    isLocked,
    /** 口令闸门是否生效（加锁瞬间钉死；键盘闸门用）。 */
    isGated,
    /** 刷新重锁判定（bootstrap 关键路径调用）。 */
    relockIfNeeded,
    /** 语言包晚于遮罩就绪时按新语言重绘文本（bootstrap 在 i18n.init 后调用）。 */
    refreshTexts: rerenderIfLocked,
    /** 当前空闲自动锁定分钟数（0 = 从不）。 */
    getAutoLockMinutes: autoLockMinutes,
    /** 是否要求口令。 */
    requiresPassword,
    /** 冷却前允许的失败次数。 */
    maxAttempts: MAX_ATTEMPTS,
    /** 递增冷却阶梯（秒）。 */
    lockoutLadder: LOCKOUT_LADDER.slice(),
    /** 当前冷却剩余秒数。 */
    cooldownLeft,
};

let initialized = false;

/**
 * 初始化锁屏模块：恢复惩罚状态、挂空闲看门狗、按需刷新重锁。
 * bootstrap 关键路径与可选模块空闲点亮都可能调到这里（重复调用幂等）。
 * @returns {boolean} 是否完成初始化
 */
function initLock() {
    if (initialized) return true;
    initialized = true;
    loadPenalty();
    startWatching();
    // 语言包可能晚于锁屏遮罩就绪：语言一切换就按新语言重绘遮罩文本。
    document.addEventListener("languagechange", () => rerenderIfLocked());
    const relocked = relockIfNeeded();
    const minutes = autoLockMinutes();
    window.__log?.info("kernel/lock",
        `锁屏就绪：自动锁定 ${minutes ? `${minutes} 分钟无操作` : "从不"}`
        + `，口令${hasPassword() ? "已设置" : "未设置"}${requiresPassword() ? "（解锁需口令）" : ""}`
        + `${relocked ? "，已按持久态重锁" : ""}`);
    return true;
}

defineSchema();

globalThis.__lock = lock;

export { lock, initLock, hasPassword, setPassword, checkPassword, clearPassword, lockNow, isLocked, isGated };
export { requestUnlock as unlock };
