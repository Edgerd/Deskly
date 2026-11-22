/**
 * sound.js — 声音 owner：主音量、静音与提示音
 *
 * 这里是「主音量」唯一真正落到可听输出的地方。此前控制中心的音量滑块只把数字写进
 * webstartos_controlcenter 槽里，没有任何消费者读过它 —— 拖到 0 屏幕也不会安静，
 * 属于典型的假开关。本模块把那条数据接成一条真实链路：
 *
 *   滑块 / 系统设置 → settings.set("sound.master") → 校验 + 写入 JSON 槽
 *     → apply(生效函数) → 调整提示音实例与页内所有 media 元素 → 广播
 *
 * 三条约定：
 * 1. **存储槽与控制中心共用**：音量、静音住在 `webstartos_controlcenter` 这同一个
 *    JSON blob 的 `volume` / `volumeMuted` 字段里，由 `slot` + `jsonPath` 声明。
 *    两个界面无需互相同步内存镜像，读写的都是同一份字节。
 * 2. **单一 Audio 实例**：提示音不复用 WebAudio 图 —— 一个 Audio 元素足够，
 *    `volume` 与 `muted` 都是原生属性，创建 AudioContext 只会白占一份音频资源。
 *    实例按音色惰性创建并复用，模块求值期不申请解码。
 * 3. **自动播放被拒是预期行为**：首次用户手势之前 `play()` 必然 reject，静默吞掉即可，
 *    不能让它冒成「未处理的 Promise 拒绝」进运行记录。
 *
 * 提示音的门控（F-50）：`sound.effects` 关掉时 playTone 直接不开口；音量按
 * 主音量 × 提示音音量两级相乘。已知但暂无素材的音色（倒废纸篓 / 音量反馈 /
 * 错误 / 弹出）登记在 SILENT_TONES 里 —— 请求它们时如实返回 false（没出声），
 * 等素材文件到位后把它们挪进 TONES 即自动可响。
 *
 * 页内已有的 <audio>/<video>（照片预览与视频类插件）在 `play` 事件的捕获阶段统一套上主音量：
 * media 事件不冒泡，但捕获监听仍会收到，因此插件不必 import 本模块也能被音量管住。
 */
import { settings } from "./settings.js";
import { assetPath } from "./paths.js";

/** 提示音素材表：name -> 资源路径（资源 URL 一律经 paths.js 生成）。 */
const TONES = {
    alert: assetPath("sounds/alert.ogg"),
    capture: assetPath("sounds/capture.aif"),
    // notify 复用 alert 素材：通知横幅需要独立音色名，素材到位后可单独换文件
    notify: assetPath("sounds/alert.ogg"),
};

/** 已知但暂无素材的音色：请求它们时如实返回 false（没出声），绝不假装播过。
 *  素材（如 trash.ogg / volume.ogg / error.ogg / pop.ogg）放入 assets/sounds/ 并
 *  挪进 TONES 后即自动可响。 */
const SILENT_TONES = ["trash", "volume", "error", "pop"];

/** 默认主音量，与控制中心 DEFAULT_STATE.volume 对齐。 */
const DEFAULT_MASTER = 0.65;
/** 提示音音量的默认值（独立于主音量的二级滑块）。 */
const DEFAULT_EFFECTS = 1;

/** 复用的提示音实例与其音色名（音色变化时才换 src）。 */
let audio = null;
let audioTone = "";

/** 把任意值收成 0..1 的合法音量比。 */
function ratio(value, fallback) {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(1, Math.max(0, num));
}

/** 注册本模块托管的四个设置项（音量 / 静音共用控制中心的 JSON 槽；提示音门控独立成槽）。 */
function defineSchema() {
    settings.defineMany([
        {
            key: "sound.master", slot: "webstartos_controlcenter", jsonPath: "volume",
            type: "number", default: DEFAULT_MASTER, min: 0, max: 1, step: 0.01,
            format: "percent", control: "slider", pane: "sound", group: "声音", order: 10,
            label: "音量",
            apply: () => applyToPage(),
        },
        {
            key: "sound.muted", slot: "webstartos_controlcenter", jsonPath: "volumeMuted",
            type: "boolean", default: false,
            control: "switch", pane: "sound", group: "声音", order: 20,
            label: "静音", hint: "立即静音：提示音与页内媒体都不再出声",
            apply: () => applyToPage(),
        },
        {
            key: "sound.effects", slot: "sound-effects", type: "boolean", default: true,
            control: "switch", pane: "sound", group: "提示音", order: 30,
            label: "提示音音效", hint: "关掉后提示音不再出声",
        },
        {
            key: "sound.effectsVolume", slot: "sound-effects-volume",
            type: "number", default: DEFAULT_EFFECTS, min: 0, max: 1, step: 0.01,
            format: "percent", control: "slider", pane: "sound", group: "提示音", order: 40,
            label: "提示音音量",
            apply: () => applyToPage(),
        },
    ]);
}

/** 当前主音量比（0..1）。 */
function getMaster() {
    return ratio(settings.get("sound.master"), DEFAULT_MASTER);
}

/** 提示音音效是否开启。 */
function isEffectsEnabled() {
    return settings.get("sound.effects") !== false;
}

/** 提示音音量比（0..1，独立于主音量）。 */
function getEffectsVolume() {
    return ratio(settings.get("sound.effectsVolume"), DEFAULT_EFFECTS);
}

/** 当前是否静音。 */
function isMuted() {
    return Boolean(settings.get("sound.muted"));
}

/** 实际输出电平：静音优先于主音量。 */
function level() {
    return isMuted() ? 0 : getMaster();
}

/** 提示音的实际输出电平：静音 × 主音量 × 提示音音量；音效关掉即为 0。 */
function effectsLevel() {
    if (isMuted() || !isEffectsEnabled()) return 0;
    return getMaster() * getEffectsVolume();
}

/**
 * 把当前音量状态套到一个媒体元素上。
 * @param {HTMLAudioElement|HTMLVideoElement} [el] 目标元素；省略时套到页内全部媒体元素
 * @returns {boolean} 是否有元素被应用
 */
function applyVolume(el) {
    const value = level();
    if (el) {
        if (typeof el.volume === "number") el.volume = value;
        // 只在全局静音开启时压 muted：全局未静音时不能替应用解除它自己设的静音（BUG-43）
        if ("muted" in el && isMuted()) el.muted = true;
        return true;
    }
    const list = document.querySelectorAll("audio, video");
    list.forEach((node) => applyVolume(node));
    return list.length > 0;
}

/** 生效函数：音量变更后重算提示音实例并广播式套用到页内媒体。 */
function applyToPage() {
    if (audio) {
        audio.volume = level();
        audio.muted = isMuted();
    }
    applyVolume();
}

/**
 * 取得（并按需重建）指定音色的复用 Audio 实例。
 * @param {string} name 音色名
 * @returns {HTMLAudioElement} 音频实例
 */
function toneOf(name) {
    const key = TONES[name] ? name : "alert";
    if (!audio || audioTone !== key) {
        audio = new Audio(TONES[key]);
        audio.preload = "auto";
        audioTone = key;
    }
    return audio;
}

/**
 * 播放一段提示音。
 * @param {string} [name="alert"] 音色名（alert / capture / notify；trash、volume、error、pop 暂无素材）
 * @returns {boolean} 是否真的发起了播放（音效被关、静音、音色缺素材时都是 false；自动播放被拒是 true，只是没出声）
 */
function playTone(name = "alert") {
    if (isMuted() || !isEffectsEnabled()) return false;
    if (SILENT_TONES.includes(name) && !TONES[name]) return false;
    try {
        const el = toneOf(name);
        el.volume = effectsLevel();
        el.muted = isMuted();
        if (el.currentTime > 0) el.currentTime = 0;
        const result = el.play();
        // 浏览器自动播放策略拒绝（尚无用户手势）是预期路径：静默，不冒成未处理拒绝
        if (result && typeof result.catch === "function") result.catch(() => { /* 忽略 */ });
        return true;
    } catch {
        // 资源缺失 / 格式不支持：提示音可有可无，调用方（通知等）不该因此中断
        return false;
    }
}

/** playTone 的语义化别名：调用方写 play("trash") 比 playTone 更像一句系统行为。 */
const play = playTone;

/**
 * 经设置中枢写入主音量。
 * @param {number} ratioValue 0..1 的音量比
 * @returns {boolean} 是否已生效
 */
function setMaster(ratioValue) {
    return settings.set("sound.master", ratio(ratioValue, getMaster()), { source: "sound" }).ok;
}

/**
 * 经设置中枢写入静音开关。
 * @param {boolean} on 是否静音
 * @returns {boolean} 是否已生效
 */
function setMuted(on) {
    return settings.set("sound.muted", Boolean(on), { source: "sound" }).ok;
}

/** 声音模块对外 API（挂到 window.__sound 供插件与各界面调用）。 */
const sound = {
    /** 可用音色名列表。 */
    tones: () => Object.keys(TONES),
    getMaster,
    setMaster,
    isMuted,
    setMuted,
    isEffectsEnabled,
    getEffectsVolume,
    playTone,
    /** playTone 的别名：sound.play("trash") 这样的调用更像一句系统行为。 */
    play,
    applyVolume,
};

let initialized = false;

/** 音量反馈的节流窗口（毫秒）：拖动滑块期间只在停顿后响一次。 */
const VOLUME_TONE_THROTTLE_MS = 150;

/**
 * 初始化声音模块：接管页内媒体的播放音量，并接上两处系统提示音的触发源
 * （倒废纸篓 / 音量调节反馈；素材未到位的音色请求会如实返回 false）。
 * @returns {boolean} 是否完成初始化（重复调用幂等）
 */
function initSound() {
    if (initialized) return true;
    initialized = true;
    // play 事件不冒泡，但捕获阶段仍能收到：任何 audio/video 起播前先套上主音量，
    // 插件不必 import 本模块也遵守同一个音量设置。
    document.addEventListener("play", (event) => applyVolume(event.target), true);
    // 倒空 / 清空废纸篓的提示音（音色暂无素材，playTone 如实返回 false）
    document.addEventListener("trash-changed", () => playTone("trash"));
    // 音量调节反馈音：节流 150ms，拖动结束才响
    let volumeToneTimer = 0;
    settings.on("sound.master", () => {
        clearTimeout(volumeToneTimer);
        volumeToneTimer = setTimeout(() => playTone("volume"), VOLUME_TONE_THROTTLE_MS);
    });
    applyToPage();
    window.__log?.info("kernel/sound", `声音就绪：主音量 ${Math.round(getMaster() * 100)}%${isMuted() ? "（已静音）" : ""}`);
    return true;
}

defineSchema();

globalThis.__sound = sound;

export { sound, initSound, getMaster, setMaster, isMuted, setMuted, isEffectsEnabled, getEffectsVolume, playTone, play, applyVolume };
