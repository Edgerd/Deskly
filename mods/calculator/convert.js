/**
 * mods/calculator/convert.js — 计算器「转换」功能的纯逻辑层
 *
 * 为什么单独成文件、零 import、零 DOM：换算表和换算规则要么靠人肉按计算器验证，要么在磁盘上
 * 自动判对错。后者才能被 `node dev/calc-convert-check.mjs` 守住——所以这个文件必须能在 Node 里
 * 直接求值，界面（script.js）只消费它导出的数据结构与函数，不参与任何单位定义。
 *
 * 取值依据：国际码表（1959 国际英寸/国际磅定义）、SI 定义常数（电子伏特、瓦时）、
 * 中国市制（1 斤 = 500 g、1 亩 = 2000/3 m²）、美制习惯量（1 加仑 = 231 in³ 的派生链）。
 * 货币是随包快照（见 RATES），扩展是 MV3 离线包，换算一律不许联网。
 */

/* ───────────────────────── 精确定义常数 ───────────────────────── */

// 1959 国际码表把英寸与磅钉成精确小数，英尺/码/英里是它的整数倍关系；
// 这里写「定义值」而不是各自独立的小数近似，避免 1 英里 ≠ 5280 英尺这类内部矛盾。
const INCH_M = 0.0254;
const FOOT_M = 0.3048;
const YARD_M = 0.9144;
const MILE_M = 1609.344;
const NAUTICAL_M = 1852;          // 国际海里 1852 m 精确（旧英制 6080 ft = 1853.184 m 已废弃）
const POUND_KG = 0.45359237;
const OUNCE_KG = POUND_KG / 16;   // 常衡盎司 = 1/16 磅
const CARAT_KG = 0.0002;          // 公制克拉 = 200 mg，珠宝计量法定值

// 磅力、平方英寸压力、机械马力都要跨量纲，统一挂在标准重力加速度上，
// 这样 psi、lbf、hp 之间互为派生，不会出现三个各四舍五入的孤立常数。
const G_N = 9.80665;
const LBF_N = POUND_KG * G_N;

// 体积基准是立方米：立方英寸/立方英尺直接由长度定义取立方，美制液量再从 231 in³ 派生，
// 于是 mL、L、gal、in³、ft³ 全在同一条精确链上（1 gal 因此等于 3.785411784 L 而非近似值）。
const IN3_M3 = INCH_M ** 3;
const FT3_M3 = FOOT_M ** 3;
const GAL_M3 = 231 * IN3_M3;

// 面积基准是平方米，同理取平方；公顷与平方千米是十进制整倍，英亩由平方英尺派生。
const FOOT2_M2 = FOOT_M ** 2;
const INCH2_M2 = INCH_M ** 2;
const ACRE_M2 = 43560 * FOOT2_M2;
const MU_M2 = 2000 / 3;           // 1 市亩 = 60 平方丈 = 2000/3 m²，用分数而不是 666.667 的截断

/* ───────────────────────── 货币汇率快照 ───────────────────────── */

/**
 * 汇率基准日。为什么钉一个日期：换算结果会被用户当成事实，快照与实时的差别必须显式声明，
 * 界面（script.js）必须把「汇率快照 · RATE_DATE」显示出来，不能只给一个数字。
 */
export const RATE_DATE = "2026-10";

/**
 * 相对美元的单位汇率：`RATES.代码` = 1 美元可兑换多少该货币。
 *
 * 为什么是随包快照而不是运行时拉取：本扩展是 MV3 离线包，CSP 与离线可用都不允许 fetch 第三方
 * 接口，任何「打开计算器要等网络」的设计都是错的。快照会过期，界面上必须标出 RATE_DATE，
 * 并且不承诺与银行牌价一致。
 */
export const RATES = {
    USD: 1,
    CNY: 7.1,
    EUR: 0.92,
    JPY: 148.5,
    GBP: 0.78,
    HKD: 7.81,
    TWD: 32.4,
    KRW: 1355,
    AUD: 1.52,
    CAD: 1.38,
    CHF: 0.88,
    SGD: 1.33,
    RUB: 92.5,
    INR: 83.8,
    BRL: 5.42,
    CZK: 23.1,
    BOB: 6.96,
};

/* ───────────────────────── 导出接口形状 ───────────────────────── */

/**
 * @typedef {Object} Unit
 * @property {string} id 全局唯一的单位 id（小写）
 * @property {string} name 中文名，界面直接展示
 * @property {string} symbol 缩写；货币用 ISO 代码，因为「¥」同时属于人民币与日元
 * @property {number} [factor] 线性类别：1 个该单位等于多少基准单位
 * @property {number} [decimalsHint] 界面小数位提示（见各表注释）
 */

/**
 * @typedef {Object} Category
 * @property {string} id 类别 id
 * @property {string} label 中文名
 * @property {"linear"|"temp"|"currency"} kind 换算规则类型
 * @property {Unit[]} units 该类别下的单位；顺序即界面下拉顺序
 * @property {string[]} [ladder] 参与「人类可读」自动建议的单位 id 白名单（见 suggestUnit）
 */

/**
 * 温度非线性也非比例（只有差值可比，比值无意义），因此不存 factor，改存到/离开基准
 * （开尔文）的函数对 toBase/fromBase。
 *
 * 为什么华氏走「先减 32 再乘 5/9」而不是 (v+459.67)*5/9：后者要先加一个大常数再抵消，
 * 二进制舍入会把 0 °C → 32 °F、100 °C → 212 °F 这两个定义锚点变成 31.99999999999994；
 * 现在这种顺序让锚点在双精度下精确落回，往返也精确。
 */
const TEMP = {
    c: { toBase: (v) => v + 273.15, fromBase: (k) => k - 273.15 },
    f: { toBase: (v) => (v - 32) * (5 / 9) + 273.15, fromBase: (k) => (k - 273.15) * (9 / 5) + 32 },
    k: { toBase: (v) => v, fromBase: (k) => k },
    r: { toBase: (v) => v * (5 / 9), fromBase: (k) => k * (9 / 5) },
};

/**
 * 类别与单位总表。基准单位（factor 为 1 的那个）：长度=米、重量=千克、体积=立方米、
 * 面积=平方米、速度=米每秒、时间=秒、数据=比特、能量=焦耳、压力=帕、功率=瓦、角度=度、货币=美元。
 *
 * `decimalsHint` 只给「默认位数会把小量读成 0」或「ISO 4217 规定辅币位数」这两类单位，
 * 其余留给 formatValue 的有效位规则；温度统一提示 1 位（体感精度用不到更多）。
 */
export const CATEGORIES = [
    {
        id: "length",
        label: "长度",
        kind: "linear",
        ladder: ["um", "mm", "cm", "m", "km"],
        units: [
            { id: "um", name: "微米", symbol: "μm", factor: 1e-6, decimalsHint: 6 },
            { id: "mm", name: "毫米", symbol: "mm", factor: 1e-3, decimalsHint: 4 },
            { id: "cm", name: "厘米", symbol: "cm", factor: 0.01, decimalsHint: 3 },
            { id: "m", name: "米", symbol: "m", factor: 1 },
            { id: "km", name: "千米", symbol: "km", factor: 1000 },
            { id: "in", name: "英寸", symbol: "in", factor: INCH_M, decimalsHint: 4 },
            { id: "ft", name: "英尺", symbol: "ft", factor: FOOT_M, decimalsHint: 4 },
            { id: "yd", name: "码", symbol: "yd", factor: YARD_M, decimalsHint: 4 },
            { id: "mi", name: "英里", symbol: "mi", factor: MILE_M, decimalsHint: 4 },
            { id: "nmi", name: "海里", symbol: "nmi", factor: NAUTICAL_M, decimalsHint: 4 },
        ],
    },
    {
        id: "mass",
        label: "重量",
        kind: "linear",
        ladder: ["mg", "g", "jin", "kg", "t"],
        units: [
            { id: "mg", name: "毫克", symbol: "mg", factor: 1e-6, decimalsHint: 6 },
            { id: "g", name: "克", symbol: "g", factor: 1e-3, decimalsHint: 4 },
            { id: "kg", name: "千克", symbol: "kg", factor: 1 },
            { id: "t", name: "吨", symbol: "t", factor: 1000 },
            { id: "oz", name: "盎司", symbol: "oz", factor: OUNCE_KG, decimalsHint: 6 },
            { id: "lb", name: "磅", symbol: "lb", factor: POUND_KG, decimalsHint: 6 },
            { id: "jin", name: "斤", symbol: "斤", factor: 0.5 },
            { id: "ct", name: "克拉", symbol: "ct", factor: CARAT_KG, decimalsHint: 4 },
        ],
    },
    {
        id: "volume",
        label: "容量",
        kind: "linear",
        ladder: ["ml", "l", "m3"],
        units: [
            { id: "ml", name: "毫升", symbol: "mL", factor: 1e-6, decimalsHint: 4 },
            { id: "l", name: "升", symbol: "L", factor: 1e-3, decimalsHint: 3 },
            { id: "m3", name: "立方米", symbol: "m³", factor: 1 },
            { id: "tsp", name: "茶匙", symbol: "tsp", factor: GAL_M3 / 768, decimalsHint: 4 },
            { id: "tbsp", name: "汤匙", symbol: "tbsp", factor: GAL_M3 / 256, decimalsHint: 4 },
            { id: "cup", name: "杯", symbol: "cup", factor: GAL_M3 / 16, decimalsHint: 4 },
            { id: "pt", name: "品脱", symbol: "pt", factor: GAL_M3 / 8, decimalsHint: 4 },
            { id: "qt", name: "夸脱", symbol: "qt", factor: GAL_M3 / 4, decimalsHint: 4 },
            { id: "gal", name: "加仑", symbol: "gal", factor: GAL_M3, decimalsHint: 6 },
            { id: "floz", name: "液盎司", symbol: "fl oz", factor: GAL_M3 / 128, decimalsHint: 4 },
            { id: "in3", name: "立方英寸", symbol: "in³", factor: IN3_M3, decimalsHint: 4 },
            { id: "ft3", name: "立方英尺", symbol: "ft³", factor: FT3_M3, decimalsHint: 4 },
        ],
    },
    {
        id: "area",
        label: "面积",
        kind: "linear",
        ladder: ["m2", "mu", "ha", "km2"],
        units: [
            { id: "m2", name: "平方米", symbol: "m²", factor: 1 },
            { id: "km2", name: "平方千米", symbol: "km²", factor: 1e6 },
            { id: "ha", name: "公顷", symbol: "ha", factor: 1e4 },
            { id: "ac", name: "英亩", symbol: "ac", factor: ACRE_M2, decimalsHint: 4 },
            { id: "ft2", name: "平方英尺", symbol: "ft²", factor: FOOT2_M2, decimalsHint: 4 },
            { id: "in2", name: "平方英寸", symbol: "in²", factor: INCH2_M2, decimalsHint: 4 },
            { id: "mu", name: "亩", symbol: "亩", factor: MU_M2, decimalsHint: 4 },
        ],
    },
    {
        id: "temperature",
        label: "温度",
        kind: "temp",
        units: [
            { id: "c", name: "摄氏度", symbol: "°C", decimalsHint: 1 },
            { id: "f", name: "华氏度", symbol: "°F", decimalsHint: 1 },
            { id: "k", name: "开尔文", symbol: "K", decimalsHint: 1 },
            { id: "r", name: "兰氏度", symbol: "°R", decimalsHint: 1 },
        ],
    },
    {
        id: "speed",
        label: "速度",
        kind: "linear",
        ladder: ["mps", "kph", "mach"],
        units: [
            { id: "mps", name: "米每秒", symbol: "m/s", factor: 1 },
            { id: "kph", name: "千米每时", symbol: "km/h", factor: 1000 / 3600 },
            { id: "mph", name: "英里每时", symbol: "mph", factor: MILE_M / 3600 },
            { id: "kn", name: "节", symbol: "kn", factor: NAUTICAL_M / 3600 },
            // 声速随温度与气压变化，这里只取 ISO 标准大气海平面（15 °C）的 340.29 m/s 一档，
            // 不做温压修正：马赫数在界面上是「大约多快」，不是飞行仪表精度。
            { id: "mach", name: "马赫", symbol: "Ma", factor: 340.29, decimalsHint: 4 },
        ],
    },
    {
        id: "time",
        label: "时间",
        kind: "linear",
        ladder: ["ms", "s", "min", "h", "d", "wk", "mo", "yr"],
        units: [
            { id: "ms", name: "毫秒", symbol: "ms", factor: 1e-3, decimalsHint: 3 },
            { id: "s", name: "秒", symbol: "s", factor: 1 },
            { id: "min", name: "分钟", symbol: "min", factor: 60 },
            { id: "h", name: "小时", symbol: "h", factor: 3600 },
            { id: "d", name: "天", symbol: "d", factor: 86400 },
            { id: "wk", name: "周", symbol: "wk", factor: 604800 },
            // 月按 30 天、年按 365 天：历法长度本身不固定，转换器的职责是给一个可解释的
            // 平均档，不是复刻闰年规则；界面标注「月(30天)/年(365天)」即可。
            { id: "mo", name: "月", symbol: "mo", factor: 30 * 86400 },
            { id: "yr", name: "年", symbol: "yr", factor: 365 * 86400 },
        ],
    },
    {
        id: "data",
        label: "数据",
        kind: "linear",
        ladder: ["bit", "byte", "kb", "mb", "gb", "tb", "pb"],
        units: [
            // 严格按 1024（二进制倍数）定义，界面仍写 KB/MB/GB 以与 macOS Finder、
            // Windows 资源管理器的历史显示一致；IEC 严格写法是 KiB/MiB/GiB。
            // 硬件厂商标称用 1000，所以「1 TB 硬盘」在界面里显示为约 0.91 TiB 不是 bug。
            { id: "bit", name: "比特", symbol: "bit", factor: 1, decimalsHint: 0 },
            { id: "byte", name: "字节", symbol: "B", factor: 8, decimalsHint: 0 },
            { id: "kb", name: "千字节", symbol: "KB", factor: 8 * 1024, decimalsHint: 2 },
            { id: "mb", name: "兆字节", symbol: "MB", factor: 8 * 1024 ** 2, decimalsHint: 2 },
            { id: "gb", name: "吉字节", symbol: "GB", factor: 8 * 1024 ** 3, decimalsHint: 2 },
            { id: "tb", name: "太字节", symbol: "TB", factor: 8 * 1024 ** 4, decimalsHint: 2 },
            { id: "pb", name: "拍字节", symbol: "PB", factor: 8 * 1024 ** 5, decimalsHint: 2 },
        ],
    },
    {
        id: "energy",
        label: "能量",
        kind: "linear",
        ladder: ["j", "cal", "kj", "wh", "kcal", "kwh"],
        units: [
            { id: "j", name: "焦耳", symbol: "J", factor: 1 },
            { id: "kj", name: "千焦", symbol: "kJ", factor: 1000 },
            // 卡有热化学卡（4.184 J）与国际表卡（4.1868 J）两套；食品标签与计算器都用热化学卡。
            { id: "cal", name: "卡路里", symbol: "cal", factor: 4.184, decimalsHint: 4 },
            { id: "kcal", name: "千卡", symbol: "kcal", factor: 4184, decimalsHint: 4 },
            { id: "wh", name: "瓦时", symbol: "W·h", factor: 3600 },
            { id: "kwh", name: "千瓦时", symbol: "kW·h", factor: 3.6e6 },
            // BTU 取国际表值 1055.05585262 J（热化学 BTU 是 1054.350…，差约 0.07 %），
            // 界面读数四舍五入到 1055.05585。
            { id: "btu", name: "英热单位", symbol: "BTU", factor: 1055.05585262, decimalsHint: 5 },
            // 2019 SI 重新定义基本电荷后，1 eV 是精确的 1.602176634e-19 J。
            { id: "ev", name: "电子伏特", symbol: "eV", factor: 1.602176634e-19, decimalsHint: 12 },
        ],
    },
    {
        id: "pressure",
        label: "压力",
        kind: "linear",
        ladder: ["pa", "kpa", "mpa", "bar", "atm"],
        units: [
            { id: "pa", name: "帕", symbol: "Pa", factor: 1, decimalsHint: 2 },
            { id: "kpa", name: "千帕", symbol: "kPa", factor: 1e3, decimalsHint: 3 },
            { id: "mpa", name: "兆帕", symbol: "MPa", factor: 1e6, decimalsHint: 3 },
            { id: "bar", name: "巴", symbol: "bar", factor: 1e5, decimalsHint: 3 },
            { id: "atm", name: "标准大气压", symbol: "atm", factor: 101325, decimalsHint: 6 },
            // 毫米汞柱按汞密度 13595.1 kg/m³ × 标准重力 × 1 mm 定义（133.322387415 Pa）；
            // 它与 1 Torr（101325/760）只差千万分之一，历史上常被当同一个数，这里保留定义区别。
            { id: "mmhg", name: "毫米汞柱", symbol: "mmHg", factor: 13595.1 * G_N * 1e-3, decimalsHint: 4 },
            { id: "psi", name: "磅每平方英寸", symbol: "psi", factor: LBF_N / INCH2_M2, decimalsHint: 4 },
        ],
    },
    {
        id: "power",
        label: "功率",
        kind: "linear",
        ladder: ["w", "kw"],
        units: [
            { id: "w", name: "瓦", symbol: "W", factor: 1 },
            { id: "kw", name: "千瓦", symbol: "kW", factor: 1000 },
            // 机械马力 = 550 ft·lbf/s；公制马力 = 75 kgf·m/s，两者差约 1.3 %，
            // 车标里哪个都有，必须分成两档而不是取一个平均值。
            { id: "hp", name: "马力（机械）", symbol: "hp", factor: 550 * FOOT_M * LBF_N, decimalsHint: 4 },
            { id: "ps", name: "马力（公制）", symbol: "PS", factor: 75 * G_N, decimalsHint: 4 },
        ],
    },
    {
        id: "angle",
        label: "角度",
        kind: "linear",
        ladder: ["arcsec", "arcmin", "deg", "rad"],
        units: [
            { id: "deg", name: "度", symbol: "°", factor: 1 },
            { id: "rad", name: "弧度", symbol: "rad", factor: 180 / Math.PI, decimalsHint: 6 },
            { id: "grad", name: "百分度", symbol: "gon", factor: 0.9 },
            { id: "arcmin", name: "角分", symbol: "′", factor: 1 / 60, decimalsHint: 4 },
            { id: "arcsec", name: "角秒", symbol: "″", factor: 1 / 3600, decimalsHint: 4 },
        ],
    },
    {
        id: "currency",
        label: "货币",
        kind: "currency",
        // factor 由 RATES 取倒数得到：RATES 记「1 美元 = X 外币」，而线性换算需要
        // 「1 单位 = 多少基准（美元）」；只维护 RATES 一处，汇率与换算不会各说各话。
        units: [
            ["usd", "美元", 2],
            ["cny", "人民币", 2],
            ["eur", "欧元", 2],
            ["jpy", "日元", 0],
            ["gbp", "英镑", 2],
            ["hkd", "港币", 2],
            ["twd", "新台币", 2],
            ["krw", "韩元", 0],
            ["aud", "澳元", 2],
            ["cad", "加元", 2],
            ["chf", "瑞士法郎", 2],
            ["sgd", "新加坡元", 2],
            ["rub", "俄罗斯卢布", 2],
            ["inr", "印度卢比", 2],
            ["brl", "巴西雷亚尔", 2],
            ["czk", "捷克克朗", 2],
            ["bob", "玻利维亚诺", 2],
        ].map(([id, name, decimalsHint]) => ({
            id,
            name,
            symbol: id.toUpperCase(),
            decimalsHint,
            factor: 1 / RATES[id.toUpperCase()],
        })),
    },
];

/* ───────────────────────── 索引 ───────────────────────── */

/** id -> {unit, category}。构建期就查出重复 id，避免「下拉里两个 g」这种要到点击才暴露的错误。 */
const UNIT_INDEX = (() => {
    const index = new Map();
    for (const category of CATEGORIES) {
        for (const unit of category.units) {
            if (index.has(unit.id)) {
                throw new Error(`convert.js 单位 id 重复：${unit.id}`);
            }
            index.set(unit.id, { unit, category });
        }
    }
    return index;
})();

/* ───────────────────────── 换算内核 ───────────────────────── */

/** 进入类别基准单位：线性与货币按 factor 缩放，温度换成开尔文。 */
function toBase(unit, category, value) {
    if (category.kind === "temp") return TEMP[unit.id].toBase(value);
    return value * unit.factor;
}

/** 离开类别基准单位，与 toBase 严格互逆。 */
function fromBase(unit, category, baseValue) {
    if (category.kind === "temp") return TEMP[unit.id].fromBase(baseValue);
    return baseValue / unit.factor;
}

/**
 * 取类别。
 * @param {string} categoryId 类别 id
 * @returns {Category|null} 未知类别返回 null
 */
function categoryById(categoryId) {
    return CATEGORIES.find((c) => c.id === categoryId) ?? null;
}

/**
 * 列出某个类别的单位。
 * @param {string} categoryId 类别 id
 * @returns {Unit[]} 单位数组（模块内部数据，调用方不要原地改写）；未知类别返回 []
 */
export function unitsOf(categoryId) {
    const category = categoryById(categoryId);
    return category ? category.units : [];
}

/**
 * 按 id 找单位，并带上它所属的类别。
 * @param {string} unitId 单位 id
 * @returns {{unit: Unit, category: Category}|null} 未知 id 返回 null
 */
export function findUnit(unitId) {
    return UNIT_INDEX.get(unitId) ?? null;
}

/**
 * 单位所属类别。
 * @param {string} unitId 单位 id
 * @returns {Category|null} 未知 id 返回 null
 */
export function categoryOfUnit(unitId) {
    return UNIT_INDEX.get(unitId)?.category ?? null;
}

/**
 * 单位换算。
 *
 * 只在同一类别内进行；跨类别、未知单位、非有限输入一律返回 null，
 * 界面据此禁用「换算」而不是显示一个假数。
 *
 * @param {number} value 待换算数值（以 fromId 为单位）
 * @param {string} fromId 源单位 id
 * @param {string} toId 目标单位 id
 * @returns {number|null} 换算结果（以 toId 为单位）；不合法或跨类别返回 null。
 *                        极端量级可能溢出为 Infinity，由 formatValue 兜成「错误」显示。
 */
export function convert(value, fromId, toId) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const from = UNIT_INDEX.get(fromId);
    const to = UNIT_INDEX.get(toId);
    if (!from || !to || from.category !== to.category) return null;
    // 同单位直接返回：乘一次再除一次会把 5 变成 4.999999999999999，白白让显示抖动
    if (fromId === toId) return value;
    return fromBase(to.unit, to.category, toBase(from.unit, from.category, value));
}

/**
 * 温度 → 开尔文。
 * @param {number} v 温度值
 * @param {string} unitId 温度单位 id（c/f/k/r）
 * @returns {number|null} 非温度单位、未知 id 或非有限输入返回 null
 */
export function temperatureToKelvin(v, unitId) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const found = UNIT_INDEX.get(unitId);
    if (!found || found.category.kind !== "temp") return null;
    return TEMP[unitId].toBase(v);
}

/**
 * 开尔文 → 温度。
 * @param {number} k 热力学温度（开尔文）
 * @param {string} unitId 目标温度单位 id（c/f/k/r）
 * @returns {number|null} 非温度单位、未知 id 或非有限输入返回 null
 */
export function temperatureFromKelvin(k, unitId) {
    if (typeof k !== "number" || !Number.isFinite(k)) return null;
    const found = UNIT_INDEX.get(unitId);
    if (!found || found.category.kind !== "temp") return null;
    return TEMP[unitId].fromBase(k);
}

/**
 * 判断两个单位是否不可互相换算（跨类别）。
 *
 * 未知 id 也算「跨类别」：界面只要看这一个返回值就能决定按钮是否禁用，不必再分一条
 * 「单位不存在」的分支。
 *
 * @param {string} fromId 源单位 id
 * @param {string} toId 目标单位 id
 * @returns {boolean} 不可换算返回 true
 */
export function isCrossCategory(fromId, toId) {
    const from = UNIT_INDEX.get(fromId);
    const to = UNIT_INDEX.get(toId);
    if (!from || !to) return true;
    return from.category !== to.category;
}

/* ───────────────────────── 显示格式化 ───────────────────────── */

/**
 * 分组只作用于整数部分：小数位里插逗号在中文界面没有先例，也会破坏「1,234.56」的可读性。
 */
function withGrouping(text, separator) {
    const dot = text.indexOf(".");
    const intPart = dot < 0 ? text : text.slice(0, dot);
    const fracPart = dot < 0 ? "" : text.slice(dot);
    return `${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, separator)}${fracPart}`;
}

/** 去掉 toFixed/toExponential 留下的尾零与空小数点。 */
function trimTail(text) {
    if (!text.includes(".")) return text;
    return text.replace(/0+$/, "").replace(/\.$/, "");
}

/** 科学计数：1e-12 → "1e-12"，1e+21 → "1e21"（正指数不带加号，中文界面更常见）。 */
function toScientific(absValue, significant, negative) {
    const [mantissa, exponent] = absValue.toExponential(Math.max(0, significant - 1)).split("e");
    return `${negative ? "-" : ""}${trimTail(mantissa)}e${exponent.replace("+", "")}`;
}

/**
 * 数值 → 显示文本。
 *
 * 与 Number.toString 的区别都在界面上：千位分隔便于读长数、有效位上限切掉
 * 0.1+0.2 这类浮点尾巴、去尾零避免「3.000000」、极小/极大值转科学计数防止面板放不下，
 * 非有限值统一返回中文「错误」（NaN 直接显示会让用户以为是换算算错了）。
 *
 * @param {number} n 待格式化的数值
 * @param {Object} [opts]
 * @param {number|null|"auto"} [opts.decimals="auto"] 固定小数位；"auto"/null/undefined 表示按有效位自动决定
 * @param {number} [opts.sig=12] 自动模式下的小数位上限（按「有效位 − 整数位」推算）；指定 decimals 时不参与
 * @param {boolean} [opts.thousands=true] 千位分隔。选项名与 engine.js / rpn.js 保持一致——界面把同一个
 *                                        options() 对象同时喂给三个格式化器，名字不能各叫各的
 * @param {string} [opts.groupSeparator=","] 千位分隔符
 * @param {number} [opts.exponentBelow=1e-9] 绝对值小于此改用科学计数
 * @param {number} [opts.exponentAbove=1e15] 绝对值大于等于此改用科学计数
 * @param {string} [opts.errorText="错误"] 非有限值/非数值输入的显示文本
 * @returns {string} 格式化后的字符串（不含单位符号）
 */
export function formatValue(n, opts = {}) {
    const decimals = opts.decimals === undefined || opts.decimals === null || opts.decimals === "auto"
        ? null
        : opts.decimals;
    const sig = opts.sig ?? 12;
    const thousands = opts.thousands !== false;
    const separator = opts.groupSeparator ?? ",";
    const exponentBelow = opts.exponentBelow ?? 1e-9;
    const exponentAbove = opts.exponentAbove ?? 1e15;
    const errorText = opts.errorText ?? "错误";

    if (typeof n !== "number" || !Number.isFinite(n)) return errorText;
    // -0 与 0 走同一支：负零来自「0 减去 0」这类正常运算，显示成 "-0" 会被当成算错
    if (n === 0) return "0";

    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= exponentAbove || abs < exponentBelow) return toScientific(abs, sig, !!sign);

    const integerDigits = Math.max(1, Math.floor(Math.log10(abs)) + 1);
    // sig 只约束小数位：双精度下的整数位本来就是精确值，截掉整数位会把 12,345,678 说成不精确
    const places = decimals === null
        ? Math.max(0, Math.min(20, sig - integerDigits))
        : Math.max(0, Math.round(decimals));
    const text = trimTail(abs.toFixed(places));
    // 自动位数被四舍五入到全零时改用科学计数：把极小值显示成 "0" 会让人以为换算出了零
    if (decimals === null && text === "0") return toScientific(abs, sig, !!sign);
    return sign + (thousands ? withGrouping(text, separator) : text);
}

/**
 * 给一个「人类可读」的单位建议（可选功能，界面若不需要可以不引用）。
 *
 * 规则：value 以该类别基准单位计，在该类别 ladder 白名单里选「读数仍 ≥ 1 的最大单位」，
 * 于是 1500 m → 千米、0.0005 m → 微米。
 *
 * 为什么需要 ladder 而不是全表：英制与市制单位的 factor 会插在公制档之间，
 * 全表参与建议会把 0.5 米推荐成「1.64 英尺」——中文界面读起来不像人话。
 * 温度与货币没有这种档位阶梯（温度各刻度只是同一段数的不同起点，货币之间不存在「小单位」），
 * 返回 null。
 *
 * @param {string} categoryId 类别 id
 * @param {number} value 以该类别基准单位计的数值
 * @returns {{unit: Unit, value: number}|null} 建议单位与换算后的读数；不适用返回 null
 */
export function suggestUnit(categoryId, value) {
    if (!Number.isFinite(value) || value === 0) return null;
    const category = categoryById(categoryId);
    if (!category || category.kind !== "linear") return null;

    const pool = category.ladder
        ? category.units.filter((unit) => category.ladder.includes(unit.id))
        : category.units;
    const magnitude = Math.abs(value);
    let largest = null;
    let smallest = null;
    for (const unit of pool) {
        if (typeof unit.factor !== "number" || !(unit.factor > 0)) continue;
        if (!smallest || unit.factor < smallest.factor) smallest = unit;
        if (magnitude / unit.factor >= 1 && (!largest || unit.factor > largest.factor)) largest = unit;
    }
    // 比最小档还小（如 1e-9 米）时不硬造单位，落到最小档，读数小于 1 也比换类别诚实
    const pick = largest ?? smallest;
    if (!pick) return null;
    return { unit: pick, value: (value < 0 ? -1 : 1) * (magnitude / pick.factor) };
}
