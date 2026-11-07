/**
 * dev/changelog-check.mjs — 更新日志一致性与格式校验（磁盘即权威，不用浏览器）。
 *
 * 校验五件事：
 * 1. docs/产品更新信息.md 与 docs/changelog.json 逐条一致（版本、日期、类型、条目文本全等）；
 * 2. 主日志只留系统内容：条目不得出现内置插件的产品名（办公/手册/照片/系统设置……）；
 * 3. 每个 mods/<id>/ 都有 changelog.json，结构与排序合法，version 与 manifest.json 对齐；
 * 4. 条目不写实现细节：不得出现反引号、文件路径与源码文件后缀；
 * 5. 界面文案四语齐全：src/javascripts/changelog.js 的词条表四种语言键位一致。
 *
 * 用法：
 *   node dev/changelog-check.mjs           校验（有问题退出码 1）
 *   node dev/changelog-check.mjs --write   用 docs/changelog.json 重写产品更新信息.md（消漂移）
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

const REPO = process.cwd().replace(/\\/g, "/");
const problems = [];
const info = [];
const WRITE = process.argv.includes("--write");

const TYPES = ["added", "improved", "fixed"];
const TYPE_LABEL = { added: "新增", improved: "优化", fixed: "修复" };
const UNRELEASED = "未发布";

/* ── 主日志：Markdown ↔ JSON ───────────────────────────────────────────── */

const systemJson = JSON.parse(readFileSync(join(REPO, "docs", "changelog.json"), "utf8"));

/**
 * 解析 Markdown 主日志：
 *   ## v0.4.0（2026-11-05）  → 版本组（也接受「## 未发布（2026-11-06)」）
 *   ### 新增 / ### 优化 / ### 修复
 *   - 条目文本
 */
function parseMarkdown(text) {
    const entries = [];
    let version = null;
    let date = null;
    let type = null;
    text.split(/\r?\n/).forEach((line) => {
        const h2 = line.match(/^##\s+(?:v)?(.+?)（(\d{4}-\d{2}-\d{2})）\s*$/);
        if (h2) {
            version = h2[1].trim();
            date = h2[2];
            type = null;
            return;
        }
        const h3 = line.match(/^###\s+(新增|优化|修复)\s*$/);
        if (h3) {
            type = Object.keys(TYPE_LABEL).find((k) => TYPE_LABEL[k] === h3[1]) || null;
            return;
        }
        const item = line.match(/^-\s+(.+)$/);
        if (item && version && type) entries.push({ version, date, type, text: item[1].trim() });
    });
    return entries;
}

/** 把 JSON 条目展开成与 Markdown 解析结果同形的行（逐条比对用）。 */
function flattenJson(log) {
    const out = [];
    (log.entries || []).forEach((e) => {
        (e.items || []).forEach((text) => out.push({ version: e.version, date: e.date, type: e.type, text }));
    });
    return out;
}

/** 由 JSON 重新生成 Markdown（--write 用；与校验共用同一套序列化，保证两边写的是一回事）。 */
function renderMarkdown(log) {
    const lines = [
        "# 产品更新信息",
        "",
        "> 本文件是 `docs/changelog.json` 的可读版本，二者由 `node dev/changelog-check.mjs` 校验保持一致，界面读取 JSON。",
        "> 各内置应用自己的更新历史见 `mods/<应用>/changelog.json`；0.3.0 之前的内部版本存档见《产品更新信息-旧版.md》。",
        "",
    ];
    const groups = [];
    const byVersion = new Map();
    (log.entries || []).forEach((e) => {
        if (!byVersion.has(e.version)) {
            const g = { version: e.version, date: e.date, types: new Map() };
            byVersion.set(e.version, g);
            groups.push(g);
        }
        const g = byVersion.get(e.version);
        if (!g.types.has(e.type)) g.types.set(e.type, []);
        g.types.get(e.type).push(...e.items);
    });
    groups.forEach((g) => {
        const label = g.version === UNRELEASED ? UNRELEASED : `v${g.version}`;
        lines.push(`## ${label}（${g.date}）`, "");
        TYPES.filter((ty) => g.types.has(ty)).forEach((ty) => {
            lines.push(`### ${TYPE_LABEL[ty]}`, "");
            g.types.get(ty).forEach((text) => lines.push(`- ${text}`));
            lines.push("");
        });
    });
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const mdPath = join(REPO, "docs", "产品更新信息.md");
const mdText = readFileSync(mdPath, "utf8");
const mdRows = parseMarkdown(mdText);
const jsonRows = flattenJson(systemJson);

if (WRITE) {
    writeFileSync(mdPath, renderMarkdown(systemJson), "utf8");
    info.push("已用 docs/changelog.json 重写 docs/产品更新信息.md");
} else {
    const fmt = (r) => `${r.version} ${r.date} ${r.type}「${r.text.slice(0, 24)}…」`;
    if (mdRows.length !== jsonRows.length) {
        problems.push(`主日志条目数不一致：Markdown ${mdRows.length} 条，JSON ${jsonRows.length} 条`);
    }
    const n = Math.min(mdRows.length, jsonRows.length);
    for (let i = 0; i < n; i += 1) {
        const a = mdRows[i];
        const b = jsonRows[i];
        if (a.version !== b.version || a.date !== b.date || a.type !== b.type || a.text !== b.text) {
            problems.push(`主日志第 ${i + 1} 条不一致：\n    Markdown: ${fmt(a)}\n    JSON:     ${fmt(b)}`);
        }
    }
    info.push(`主日志比对 ${n} 条`);
}

/* ── 通用结构校验 ──────────────────────────────────────────────────────── */

const VERSION_RE = /^0\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 实现细节禁令：反引号、路径目录、源码文件后缀都不该出现在面向用户的条目里
const IMPL_RE = /[`]|(?:^|[\s/])(?:src|mods|assets|dev|dist)\/|\.\w{1,4}\b(?:的)?(?:中|里|文件)/;

/**
 * 校验一份日志文件；errors 直接进 problems。
 * @param {object} log 原始 JSON
 * @param {string} where 位置说明
 * @param {{expectId?: string, expectVersion?: string}} expect 期望的 id / 当前版本
 */
function validateLog(log, where, expect = {}) {
    if (!log || typeof log !== "object" || Array.isArray(log)) { problems.push(`${where}：不是合法的对象`); return; }
    if (expect.expectId && log.id !== expect.expectId) problems.push(`${where}：id "${log.id}" 应为 "${expect.expectId}"`);
    if (typeof log.name !== "string" || !log.name) problems.push(`${where}：缺 name`);
    if (expect.expectVersion && log.version !== expect.expectVersion) {
        problems.push(`${where}：version "${log.version}" 与 manifest 的 "${expect.expectVersion}" 不一致`);
    }
    if (!Array.isArray(log.entries)) { problems.push(`${where}：entries 不是数组`); return; }

    let prev = null;
    log.entries.forEach((e, i) => {
        const at = `${where} 第 ${i + 1} 条`;
        if (!e || typeof e !== "object") { problems.push(`${at}：不是对象`); return; }
        if (e.version !== UNRELEASED && !VERSION_RE.test(String(e.version || ""))) {
            problems.push(`${at}：version "${e.version}" 非法（x.y.z 或「未发布」）`);
        }
        if (!DATE_RE.test(String(e.date || ""))) problems.push(`${at}：date "${e.date}" 不是 YYYY-MM-DD`);
        if (!TYPES.includes(e.type)) problems.push(`${at}：type "${e.type}" 应为 ${TYPES.join("/")}`);
        if (!Array.isArray(e.items) || !e.items.length) problems.push(`${at}：items 为空`);
        (e.items || []).forEach((text, j) => {
            if (typeof text !== "string" || !text.trim()) { problems.push(`${at} 第 ${j + 1} 项：空条目`); return; }
            if (IMPL_RE.test(text)) problems.push(`${at} 第 ${j + 1} 项：写了实现细节（路径/文件名/反引号）→ ${text.slice(0, 40)}`);
        });
        // 排序：日期倒序；同日按版本倒序；同版本按类型 added → improved → fixed
        if (prev) {
            const key = (x) => [x.date, x.version === UNRELEASED ? "999" : x.version, TYPES.indexOf(x.type)];
            const [pd, pv, pt] = key(prev);
            const [cd, cv, ct] = key(e);
            if (pd < cd || (pd === cd && String(pv) < String(cv)) || (pd === cd && pv === cv && pt > ct)) {
                problems.push(`${at}：顺序不对（应按日期倒序、同版本按 新增→优化→修复）`);
            }
        }
        prev = e;
    });
}

validateLog(systemJson, "docs/changelog.json", { expectId: "deskly" });

/* ── 主日志纯度：不出现内置插件产品名 ───────────────────────────────────── */

// 这些名字一出现，说明条目该住在插件自己的 changelog.json 里
// （「聚焦」与常用词同形，不作为判定词）
const PLUGIN_TERMS = [
    "办公套件", "文稿", "表格", "演示", "手册", "照片", "计算器", "记事本",
    "访达", "Safari", "启动台", "Siri", "VS Code", "关于本机",
    "系统设置", "App Store", "应用商店",
];
flattenJson(systemJson).forEach((row) => {
    PLUGIN_TERMS.forEach((term) => {
        if (row.text.includes(term)) {
            problems.push(`主日志 ${row.version} 混入插件条目（含「${term}」）→ ${row.text.slice(0, 40)}`);
        }
    });
});

/* ── 插件日志：每个 mods/<id>/ 一份，与 manifest 对齐 ────────────────────── */

const modsDir = join(REPO, "mods");
readdirSync(modsDir).forEach((id) => {
    const dir = join(modsDir, id);
    if (!existsSync(join(dir, "manifest.json"))) return;
    const file = join(dir, "changelog.json");
    if (!existsSync(file)) { problems.push(`mods/${id}：缺 changelog.json`); return; }
    let log;
    try { log = JSON.parse(readFileSync(file, "utf8")); } catch (err) {
        problems.push(`mods/${id}/changelog.json：JSON 解析失败 ${err.message}`);
        return;
    }
    let manifestVersion = "";
    try { manifestVersion = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version || ""; } catch { /* 结构错误由 static-check 管 */ }
    validateLog(log, `mods/${id}/changelog.json`, { expectId: id, expectVersion: manifestVersion });
});
info.push(`插件日志 ${readdirSync(modsDir).filter((id) => existsSync(join(modsDir, id, "changelog.json"))).length} 份`);

/* ── 界面文案四语齐全（changelog.js 自带词条表） ────────────────────────── */

// changelog.js 依赖 i18n（求值期不碰 DOM，但 applyTranslations 会），先铺最小替身再 import
globalThis.document = {
    documentElement: { lang: "" },
    querySelectorAll: () => [],
    addEventListener() { },
    body: {},
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() { }, removeItem() { } };

function flatKeys(obj, prefix = "", out = []) {
    Object.entries(obj || {}).forEach(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) flatKeys(v, key, out);
        else out.push(key);
    });
    return out;
}

try {
    const { CHANGELOG_MESSAGES } = await import("../src/javascripts/changelog.js");
    const langs = ["zh-CN", "en", "ja-JP", "cat"];
    const base = flatKeys(CHANGELOG_MESSAGES["zh-CN"] || {});
    langs.forEach((lang) => {
        const keys = flatKeys(CHANGELOG_MESSAGES[lang] || {});
        if (!keys.length) { problems.push(`changelog.js 文案缺 ${lang}`); return; }
        base.filter((k) => !keys.includes(k)).forEach((k) => problems.push(`changelog.js 文案 ${lang} 缺键 ${k}`));
        keys.filter((k) => !base.includes(k)).forEach((k) => problems.push(`changelog.js 文案 ${lang} 多键 ${k}`));
    });
    info.push(`界面文案四语各 ${base.length} 键`);
} catch (err) {
    problems.push(`changelog.js 无法在 Node 中求值：${err.message}`);
}

try {
    const { STORE_MESSAGES } = await import("../mods/app-store/messages.js");
    const langs = ["zh-CN", "en", "ja-JP", "cat"];
    const base = flatKeys(STORE_MESSAGES["zh-CN"] || {});
    langs.forEach((lang) => {
        const keys = flatKeys(STORE_MESSAGES[lang] || {});
        if (!keys.length) { problems.push(`App Store 文案缺 ${lang}`); return; }
        base.filter((k) => !keys.includes(k)).forEach((k) => problems.push(`App Store 文案 ${lang} 缺键 ${k}`));
        keys.filter((k) => !base.includes(k)).forEach((k) => problems.push(`App Store 文案 ${lang} 多键 ${k}`));
    });
    info.push(`App Store 文案四语各 ${base.length} 键`);
} catch (err) {
    problems.push(`App Store 文案表无法在 Node 中求值：${err.message}`);
}

/* ── 界面读取路径、摘要可见性与相对时间 ─────────────────────────────────── */

try {
    const { versionGroups, latestGroup, summaryOf, relativeTime } = await import("../src/javascripts/changelog.js");

    const groups = versionGroups(systemJson);
    if (!groups.length) problems.push("系统日志没有可读的版本组");
    else if (groups[0].version !== systemJson.version) {
        problems.push(`系统日志最新版本 ${groups[0].version} 与 version ${systemJson.version} 不一致`);
    }

    const latest = latestGroup(systemJson);
    if (!latest) problems.push("读不到最新一组更新（「新功能」板块会空）");
    else {
        if (!summaryOf(latest)) problems.push("最新一组没有摘要行（「新功能」板块只剩标题）");
        info.push(`最新一条：${latest.version === UNRELEASED ? UNRELEASED : `v${latest.version}`} · ${latest.date} · ${relativeTime(latest.date)}`);
    }

    // 相对时间是本地零点整天差，用本地时间构造 now，避免被时区换算带偏
    const now = new Date(2026, 10, 7, 12).getTime();
    [
        ["2026-11-07", "今天"],
        ["2026-11-06", "昨天"],
        ["2026-11-05", "2 天前"],
        ["2026-10-31", "1 周前"],
        ["2026-08-07", "3 个月前"],
        ["2024-11-07", "2 年前"],
    ].forEach(([date, expect]) => {
        const got = relativeTime(date, now);
        if (got !== expect) problems.push(`relativeTime(${date}) = "${got}"，应为 "${expect}"`);
    });
    info.push("相对时间 6 例通过");

    // 每个有条目的插件日志都要能被界面读出「最新一组 + 一行摘要」
    let readable = 0;
    readdirSync(modsDir).forEach((id) => {
        const file = join(modsDir, id, "changelog.json");
        if (!existsSync(file)) return;
        const log = JSON.parse(readFileSync(file, "utf8"));
        if (!(log.entries || []).length) return;
        const head = latestGroup(log);
        if (!head || !summaryOf(head)) problems.push(`mods/${id}/changelog.json：界面读不到最新摘要`);
        else readable += 1;
    });
    info.push(`插件日志可读摘要 ${readable} 份`);

    // 两处入口都必须真的读系统日志（防止将来把板块接回 Markdown）
    ["mods/system-settings/panes/whats-new.js", "mods/app-store/script.js"].forEach((relPath) => {
        const src = readFileSync(join(REPO, relPath), "utf8");
        if (!src.includes("getSystemChangelog")) problems.push(`${relPath}：没有读取系统更新日志，「新功能」板块会空`);
    });
    info.push("设置与 App Store 两处入口都读取系统日志");
} catch (err) {
    problems.push(`界面读取路径校验失败：${err.message}`);
}

/* ── 输出 ─────────────────────────────────────────────────────────────── */

info.forEach((line) => console.log(`  · ${line}`));
if (problems.length) {
    console.log(`\n发现 ${problems.length} 个问题：`);
    problems.forEach((p) => console.log(`  ✗ ${p}`));
    process.exit(1);
}
console.log("\n更新日志校验通过 ✓");
