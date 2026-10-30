/**
 * lock.js — 锁屏 owner：空闲自动锁定 + 真实的口令闸门
 *
 * 此前的「锁定屏幕」只是 session.js 的一块黑底遮罩，点一下就去掉，既没有口令也没有
 * 空闲自动触发，等于没有锁。本模块给出真正的锁：
 *
 * 1. **口令绝不进设置中枢**。`settings.snapshot()` 会把所有已注册键的原始存储值导出成
 *    备份文本，口令材料一旦进那条链路就等于把口令打进备份里。因此这里只存
 *    `SHA-256(口令 + 盐)` 的十六进制摘要（槽 `deskly-lock-hash`）与随机盐
 *    （槽 `deskly-lock-salt`），盐由 `crypto.getRandomValues` 生成，摘要由
 *    `crypto.subtle.digest` 计算。日志里既不出现明文也不出现摘要。
 * 2. **空闲看门狗**：mousemove / keydown / click / touch / scroll 都算活动，按
 *    `lock.autoLockMinutes` 重新计时；0 表示「从不」。计时器只在有值时挂着，
 *    设成 0 就摘干净，不留空转的 timeout。
 * 3. **界面**：整屏遮罩在 `Z.SESSION`（盖过亮度压暗层与 Night Shift），毛玻璃模糊来自
 *    `backdrop-filter`。项目铁律是 **backdrop-filter 元素上不得加 transform**
 *    （transform 会改变它的包含块与模糊范围），所以「口令错误」的抖动动画做在
 *    内层卡片上，卡片不带 backdrop-filter，遮罩本体始终不带 transform。
 * 4. **绝不把人锁死**：口令错误 5 次进入 15 秒冷却，界面上始终有「强制解锁」出口，
 *    它只是把锁解开，不清摘要、不改设置。
 */
import { settings } from "./settings.js";
import { Z } from "./zindex.js";
import { i18n } from "./i18n.js";
import { dismissAllNotifications } from "./ui/notification.js";

/** 口令材料槽：摘要 + 盐，与设置槽分开，绝不进 snapshot()。 */
const HASH_SLOT = "deskly-lock-hash";
const SALT_SLOT = "deskly-lock-salt";

/** 遮罩元素 id。 */
const OVERLAY_ID = "deskly-lock-screen";

/** 口令错误达到该次数后进入冷却。 */
const MAX_ATTEMPTS = 5;
/** 冷却秒数。 */
const COOLDOWN_SECONDS = 15;

/** 算作「用户活动」的事件（与 macOS 的空闲判定同一套输入源）。 */
const IDLE_EVENTS = ["mousemove", "keydown", "click", "touchstart", "scroll"];

/** 活动事件的最小重记间隔（毫秒）：mousemove 一秒能来上百次，不必每次都重排计时器。 */
const ACTIVITY_THROTTLE = 2000;

/**
 * 遮罩样式：整屏毛玻璃。注意本元素永不加 transform（backdrop-filter 铁律）。
 * 文字色是写死的 #fff，这是**有意偏离** --surface-text 自动推导的唯一表面：
 * 遮罩底色 rgba(18,18,20,.35) 不随主题变（锁屏在任何主题下都是暗场），
 * 换成全局令牌会在浅色主题下推导出黑字，压在暗场上反而看不清。#fff 本身仍是纯白，
 * 符合「表面文字只允许黑白」的约束。模糊值走系统令牌（42px → 4 档，最浓的一档）。
 */
const OVERLAY_STYLE = "position:fixed;inset:0;display:flex;flex-direction:column;"
    + "align-items:center;justify-content:center;box-sizing:border-box;color:#fff;"
    + "background:rgba(18,18,20,0.35);backdrop-filter:blur(var(--surface-blur-4)) saturate(var(--surface-saturate));"
    + "-webkit-backdrop-filter:blur(var(--surface-blur-4)) saturate(var(--surface-saturate));cursor:default;"
    + "user-select:none;-webkit-user-select:none;";

/** 内层卡片样式：抖动动画挂在这里，所以卡片自身不带 backdrop-filter。 */
const CARD_STYLE = "display:flex;flex-direction:column;align-items:center;gap:10px;"
    + "padding:34px 46px;border-radius:22px;background:rgba(28,28,30,0.42);"
    + "box-shadow:0 18px 60px rgba(0,0,0,.38);border:1px solid rgba(255,255,255,.14);";

/** 运行时状态。 */
const state = {
    overlay: null,
    refs: null,
    clockTimer: null,
    idleTimer: null,
    cooldownTimer: null,
    cooldownUntil: 0,
    attempts: 0,
    lastActivity: 0,
    watching: false,
    detachInput: null,
};

/** localStorage 不可用（隐私模式）时口令材料的内存替身。 */
const memory = new Map();

/**
 * 读口令槽；存储读不到时回退内存替身。
 * @param {string} slot 槽名
 * @returns {string} 原始十六进制串
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
 * 写口令槽（空值即删除）。
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

/** 注册本模块托管的两项设置。 */
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
    ]);
}

/** 空闲分钟数（0 = 从不）。 */
function autoLockMinutes() {
    const value = Number(settings.get("lock.autoLockMinutes"));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 是否要求口令。 */
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
    const had = hasPassword();
    writeSlot(HASH_SLOT, "");
    writeSlot(SALT_SLOT, "");
    if (had) window.__log?.info("kernel/lock", "解锁口令已清除");
    rerenderIfLocked();
    return had;
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
 * 日期一行（含星期）。
 * @param {Date} now 时间
 * @returns {string} 日期文本
 */
function dateText(now) {
    try {
        return new Intl.DateTimeFormat(locale(), {
            year: "numeric", month: "long", day: "numeric", weekday: "long",
        }).format(now);
    } catch {
        return now.toDateString();
    }
}

// ---- 遮罩界面 ----

/**
 * 建一个只含文本的元素（本模块不拼 HTML，全部走 textContent）。
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

/** 冷却剩余秒数。 */
function cooldownLeft() {
    return Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000));
}

/**
 * 进入冷却：锁住输入框并倒计时。
 * @param {object} refs buildOverlay 的元素引用
 * @returns {void}
 */
function startCooldown(refs) {
    state.cooldownUntil = Date.now() + COOLDOWN_SECONDS * 1000;
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
    const tick = () => {
        const left = cooldownLeft();
        if (left > 0) {
            refs.status.textContent = `错误次数过多，请 ${left} 秒后重试`;
            return;
        }
        clearInterval(state.cooldownTimer);
        state.cooldownTimer = null;
        state.attempts = 0;
        refs.input.disabled = false;
        refs.button.disabled = false;
        refs.status.textContent = i18n.t("lock.prompt", "输入口令解锁");
        try { refs.input.focus(); } catch { /* 遮罩已移除 */ }
    };
    tick();
    state.cooldownTimer = setInterval(tick, 500);
    refs.input.disabled = true;
    refs.input.value = "";
    refs.button.disabled = true;
}

/**
 * 构建锁定界面。
 * @returns {{overlay:HTMLElement, card:HTMLElement, clock:HTMLElement, date:HTMLElement,
 *            status:HTMLElement, input:HTMLInputElement|null, button:HTMLButtonElement|null,
 *            gated:boolean}} 元素引用与「是否需要口令」
 */
function buildOverlay() {
    const overlay = textOf("div", "", OVERLAY_STYLE);
    overlay.id = OVERLAY_ID;
    overlay.className = "lock-overlay os-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", i18n.t("lock.title", "锁定屏幕"));
    overlay.style.zIndex = String(Z.SESSION);

    const card = document.createElement("div");
    card.style.cssText = CARD_STYLE;

    const now = new Date();
    const clock = textOf("div", clockText(now),
        "font-size:76px;line-height:1;font-weight:300;letter-spacing:-.02em;font-variant-numeric:tabular-nums;");
    const date = textOf("div", dateText(now), "font-size:16px;opacity:.85;margin-bottom:16px;");
    card.append(clock, date);

    const gated = requiresPassword() && hasPassword();
    const status = textOf("div",
        gated ? i18n.t("lock.prompt", "输入口令解锁") : i18n.t("lock.tapToUnlock", "点击或按任意键解锁"),
        "font-size:13px;opacity:.75;min-height:18px;");
    card.appendChild(status);

    let input = null;
    let button = null;
    if (gated) {
        const form = document.createElement("form");
        form.style.cssText = "display:flex;gap:8px;align-items:center;";
        input = document.createElement("input");
        input.type = "password";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.placeholder = i18n.t("lock.passwordPlaceholder", "口令");
        input.setAttribute("aria-label", i18n.t("lock.passwordLabel", "解锁口令"));
        input.style.cssText = "width:210px;padding:9px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.28);"
            + "background:rgba(255,255,255,.12);color:#fff;font-size:14px;outline:none;";
        button = document.createElement("button");
        button.type = "submit";
        button.textContent = i18n.t("lock.unlock", "解锁");
        button.style.cssText = "padding:9px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.3);"
            + "background:rgba(255,255,255,.18);color:#fff;font-size:14px;cursor:pointer;";
        form.append(input, button);
        card.appendChild(form);
    }

    const escape = document.createElement("button");
    escape.type = "button";
    escape.textContent = i18n.t("lock.forceUnlock", "强制解锁");
    escape.style.cssText = "margin-top:18px;padding:6px 12px;border:0;background:transparent;"
        + "color:rgba(255,255,255,.66);font-size:12px;cursor:pointer;text-decoration:underline;";
    card.appendChild(escape);
    overlay.appendChild(card);

    return { overlay, card, clock, date, status, input, button, escape, gated };
}

/** 锁定时重绘界面（设置里刚勾上「解锁需要密码」、或刚改完口令时用）。 */
function rerenderIfLocked() {
    if (!state.overlay || !state.refs) return;
    const refs = buildOverlay();
    state.overlay.replaceWith(refs.overlay);
    state.overlay = refs.overlay;
    wireLockInteractions(refs);
}

/**
 * 把交互接到底层遮罩上：解锁途径只有三条 —— 口令正确、任意输入（无口令时）、强制解锁。
 * @param {object} refs buildOverlay 的元素引用
 * @returns {void}
 */
function wireLockInteractions(refs) {
    state.detachInput?.();
    const onClick = () => { if (!refs.gated) unlock("input"); };
    const onKey = () => { if (!refs.gated) unlock("input"); };
    refs.overlay.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    refs.escape.addEventListener("click", (event) => {
        event.stopPropagation();
        unlock("forced");
    });
    if (refs.gated && refs.input && refs.button) {
        const form = refs.input.closest("form");
        const submit = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (cooldownLeft() > 0) return;
            const value = refs.input.value;
            refs.input.value = "";
            if (await checkPassword(value)) { unlock("password"); return; }
            state.attempts += 1;
            shake(refs.card);
            if (state.attempts >= MAX_ATTEMPTS) startCooldown(refs);
            else refs.status.textContent = `口令不正确（第 ${state.attempts} / ${MAX_ATTEMPTS} 次）`;
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
 * @param {string} [reason="manual"] 触发来源（menu / idle / sleep），只进日志
 * @returns {boolean} 是否真的锁上（已处于锁定态时 false）
 */
function lockNow(reason = "manual") {
    if (state.overlay) return false;
    state.attempts = 0;
    state.cooldownUntil = 0;
    dismissAllNotifications();
    const refs = buildOverlay();
    document.body.appendChild(refs.overlay);
    state.overlay = refs.overlay;
    wireLockInteractions(refs);

    stopTimers();
    state.clockTimer = setInterval(() => {
        const now = new Date();
        const nextClock = clockText(now);
        const nextDate = dateText(now);
        if (refs.clock.textContent !== nextClock) refs.clock.textContent = nextClock;
        if (refs.date.textContent !== nextDate) refs.date.textContent = nextDate;
    }, 1000);

    document.dispatchEvent(new CustomEvent("lock-screen-change", { detail: { locked: true, reason }, bubbles: true }));
    window.__log?.info("kernel/lock", `屏幕已锁定（${reason}）`, { gated: refs.gated });
    return true;
}

/**
 * 解锁：只摘遮罩，不清口令、不改设置。
 * @param {string} [reason="manual"] 解锁途径，只进日志
 * @returns {boolean} 是否从锁定态回到未锁定
 */
function unlock(reason = "manual") {
    if (!state.overlay) return false;
    state.detachInput?.();
    state.detachInput = null;
    state.refs = null;
    stopTimers();
    state.overlay.remove();
    state.overlay = null;
    state.attempts = 0;
    state.cooldownUntil = 0;
    document.dispatchEvent(new CustomEvent("lock-screen-change", { detail: { locked: false, reason }, bubbles: true }));
    window.__log?.info("kernel/lock", `已解锁（${reason}）`);
    armIdleTimer();
    return true;
}

/**
 * 当前是否处于锁定态。
 * @returns {boolean} 是否锁定
 */
function isLocked() {
    return Boolean(state.overlay);
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

/** 锁屏模块对外 API（挂到 window.__lock，供设置面板与命令调用）。 */
const lock = {
    hasPassword,
    setPassword,
    checkPassword,
    clearPassword,
    lockNow,
    unlock,
    isLocked,
    /** 当前空闲自动锁定分钟数（0 = 从不）。 */
    getAutoLockMinutes: autoLockMinutes,
    /** 是否要求口令。 */
    requiresPassword,
    /** 冷却前允许的失败次数。 */
    maxAttempts: MAX_ATTEMPTS,
    /** 冷却秒数。 */
    cooldownSeconds: COOLDOWN_SECONDS,
    /** 当前冷却剩余秒数。 */
    cooldownLeft,
};

let initialized = false;

/**
 * 初始化锁屏模块：挂上空闲看门狗。
 * @returns {boolean} 是否完成初始化（重复调用幂等）
 */
function initLock() {
    if (initialized) return true;
    initialized = true;
    startWatching();
    const minutes = autoLockMinutes();
    window.__log?.info("kernel/lock",
        `锁屏就绪：自动锁定 ${minutes ? `${minutes} 分钟无操作` : "从不"}`
        + `，口令${hasPassword() ? "已设置" : "未设置"}${requiresPassword() ? "（解锁需口令）" : ""}`);
    return true;
}

defineSchema();

globalThis.__lock = lock;

export { lock, initLock, hasPassword, setPassword, checkPassword, clearPassword, lockNow, unlock, isLocked };
