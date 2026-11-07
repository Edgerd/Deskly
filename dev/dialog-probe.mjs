/**
 * dialog-probe.mjs — 弹窗 API 的 Node 探针
 *
 * 不需要浏览器：决策规则在 ui/dialog-model.js 里是不碰 DOM 的纯函数，
 * 这里直接 import 它对约定逐条断言；文案一致性读四个语言包 JSON 与
 * api-grants 的权限表做脚本检查（同权限措辞、双空格、中英混排、禁用词、感叹号）。
 *
 * 运行：node dev/dialog-probe.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import {
    DISMISS,
    PERMISSION,
    defaultFocusIndex,
    keyAction,
    nextFocusIndex,
    dismissOnOverlay,
    permissionValue,
    isPermissionCallerTrusted,
    promptValue,
} from "../src/javascripts/ui/dialog-model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let checks = 0;
const failures = [];
/** 单项断言：失败只记录，不中断，最后统一打印。 */
function check(name, fn) {
    checks += 1;
    try {
        fn();
    } catch (err) {
        failures.push(`${name}\n    ${err.message.split("\n").join("\n    ")}`);
    }
}

const LANGS = ["zh-CN", "en", "ja-JP", "cat"];
const locales = Object.fromEntries(
    LANGS.map((lang) => [lang, JSON.parse(read(`assets/locales/${lang}.json`))]),
);

const PERMISSION_KEYS = [
    "apps:launch", "default-apps:read", "default-apps:write", "widgets", "dynamic-icons",
    "window-style:self", "window-style:others", "theme:apply", "files:read", "files:write",
    "system-patch:dock", "system-patch:finderbar", "system-patch:desktop",
    "system-patch:wallpaper", "system-patch:menu", "window:read-others",
    "window:manage-others", "window:chrome", "window:level", "quicklook:register",
    "menus:register", "shortcuts:write",
];

/* ── 一、取消约定 ── */

check("确认对话：取消值为 false，不是 undefined", () => {
    // dialog.confirm 的实现契约：dismissValue=false，遮罩 / Esc 都走这里
    const src = read("src/javascripts/ui/dialog.js");
    assert.match(src, /dismissValue:\s*false/);
});

check("输入对话：取消值恒为 null", () => {
    assert.equal(DISMISS, null);
    assert.equal(promptValue(null), null);
    assert.equal(promptValue(undefined), null);
    assert.equal(promptValue(false), null);
    assert.equal(promptValue(""), "");
    assert.equal(promptValue("report.txt"), "report.txt");
});

check("权限请求：关闭 / 未知值一律拒绝", () => {
    assert.equal(permissionValue(undefined), PERMISSION.DENY);
    assert.equal(permissionValue(null), PERMISSION.DENY);
    assert.equal(permissionValue("maybe"), PERMISSION.DENY);
    assert.equal(permissionValue(false), PERMISSION.DENY);
});

/* ── 二、危险操作的默认焦点 ── */

const cancelThenDelete = [
    { label: "取消", value: false, style: "secondary" },
    { label: "删除", value: true, style: "destructive" },
];
const cancelThenSave = [
    { label: "取消", value: false, style: "secondary" },
    { label: "保存", value: true, style: "primary" },
];

check("危险操作：初始焦点落在安全选项（取消）", () => {
    assert.equal(defaultFocusIndex(cancelThenDelete, { danger: true }), 0);
});

check("普通确认：初始焦点落在主按钮", () => {
    assert.equal(defaultFocusIndex(cancelThenSave), 1);
});

check("危险操作里按回车也只触发安全选项", () => {
    assert.deepEqual(keyAction("Enter", { buttons: cancelThenDelete, danger: true }), { type: "choose", index: 0 });
    // 焦点已被用户移到删除按钮上才允许回车删除
    assert.deepEqual(keyAction("Enter", { buttons: cancelThenDelete, focusIndex: 1, danger: true }), { type: "choose", index: 1 });
});

/* ── 三、Esc / 遮罩 / Tab ── */

check("Esc 返回取消动作", () => {
    assert.deepEqual(keyAction("Escape", { buttons: cancelThenDelete }), { type: "dismiss" });
});

check("点遮罩才算取消，点弹窗内容不算", () => {
    const overlay = {};
    const child = {};
    assert.equal(dismissOnOverlay(overlay, overlay), true);
    assert.equal(dismissOnOverlay(child, overlay), false);
    assert.equal(dismissOnOverlay(null, overlay), false);
});

check("Tab 循环：正向到头回到第一个，反向到头回到最后一个", () => {
    assert.equal(nextFocusIndex(0, 3), 1);
    assert.equal(nextFocusIndex(2, 3), 0);
    assert.equal(nextFocusIndex(0, 3, true), 2);
    assert.equal(nextFocusIndex(-1, 3), 0);
    assert.equal(nextFocusIndex(-1, 3, true), 2);
});

/* ── 四、权限三选项与越权 ── */

check("权限三选项：once / always 原样返回", () => {
    assert.equal(permissionValue("once"), "once");
    assert.equal(permissionValue("always"), "always");
    assert.equal(permissionValue("deny"), "deny");
});

check("只有内核调用栈（null）可以弹权限框", () => {
    assert.equal(isPermissionCallerTrusted(null), true);
    assert.equal(isPermissionCallerTrusted(undefined), true);
    assert.equal(isPermissionCallerTrusted("evil-plugin"), false);
    // 插件即使冒充自己是申请方也不放行：系统授权只能由内核代问
    assert.equal(isPermissionCallerTrusted("notepad"), false);
});

/* ── 五、单一实现与插件面收敛 ── */

check("alert.js 已无独立弹窗实现，只做门面", () => {
    const src = read("src/javascripts/ui/alert.js");
    assert.doesNotMatch(src, /createElement\("swift-messagebox"\)/);
    assert.doesNotMatch(src, /pendingSettle/);
    assert.match(src, /from "\.\/dialog\.js"/);
});

check("window.__dialog 不暴露权限请求", () => {
    const src = read("src/javascripts/ui/alert.js");
    assert.doesNotMatch(src, /__dialog[\s\S]{0,400}permission\s*\(/);
});

check("插件面 Deskly.ui.dialog 不含 permission", () => {
    const src = read("src/javascripts/os-api.js");
    const block = src.match(/const pluginDialog = Object\.freeze\(\{[\s\S]*?\}\);/);
    assert.ok(block, "找不到 pluginDialog 定义");
    assert.doesNotMatch(block[0], /permission/);
    assert.match(block[0], /confirm/);
    assert.match(block[0], /progress/);
});

check("权限弹窗由 api-grants 发起且内部代号不变", () => {
    const src = read("src/javascripts/api-grants.js");
    assert.match(src, /dialog\.permission\(/);
    assert.match(src, /"files:write"/);
    assert.match(src, /"files:write": \["文件存储"/);
});

check("不再出现「写入文件」这一可见名称", () => {
    const files = [
        "src/javascripts/api-grants.js",
        "assets/locales/zh-CN.json",
        "assets/locales/en.json",
        "assets/locales/ja-JP.json",
        "assets/locales/cat.json",
    ];
    for (const file of files) {
        assert.doesNotMatch(read(file), /写入文件|寫入檔案/, `${file} 仍有旧名称`);
    }
});

/* ── 六、文案一致性 ── */

check("四语权限弹窗键齐全", () => {
    for (const lang of LANGS) {
        const d = locales[lang].dialog?.permission;
        assert.ok(d, `${lang} 缺 dialog.permission`);
        for (const key of ["title", "description", "footer", "deny", "once", "always", "unavailable", "none", "version", "checklistNote", "installTitle", "install"]) {
            assert.equal(typeof d[key], "string", `${lang} 缺 dialog.permission.${key}`);
        }
    }
});

check("四语权限名表齐全且无空值", () => {
    for (const lang of LANGS) {
        const perms = locales[lang].perms;
        assert.ok(perms, `${lang} 缺 perms`);
        for (const key of PERMISSION_KEYS) {
            assert.ok(perms[key], `${lang} 缺 perms.${key}`);
            assert.ok(String(perms[key].label || "").trim(), `${lang} perms.${key} 缺 label`);
            assert.ok(String(perms[key].hint || "").trim(), `${lang} perms.${key} 缺 hint`);
        }
    }
});

check("中文文案无中英混排（权限名与说明、弹窗正文）", () => {
    const zh = locales["zh-CN"];
    const texts = [zh.dialog.permission, ...Object.values(zh.perms)]
        .map((x) => Object.values(x).join("\n")).join("\n")
        .replace(/\{(app|capability)\}/g, ""); // 占位符不是可见文案
    // 允许的专有名词：版本号、设备名等不在此列；中文文案只应出现中文与标点
    const latin = texts.match(/[A-Za-z][A-Za-z.+#-]*/g) || [];
    assert.deepEqual(latin, [], `中文文案出现拉丁字母：${latin.join(", ")}`);
});

check("四语文案无双空格、无标点前后多余空格", () => {
    for (const lang of LANGS) {
        const texts = [locales[lang].dialog.permission, ...Object.values(locales[lang].perms)]
            .map((x) => Object.values(x).join("\n")).join("\n");
        assert.doesNotMatch(texts, /  +/, `${lang} 出现连续空格`);
        assert.doesNotMatch(texts, /\s+[,.;:!?，。；：！？]/, `${lang} 标点前有空格`);
        // 半角逗号 / 分号 / 冒号后面必须跟空格；全角标点在中文里本来就不带空格
        assert.doesNotMatch(texts, /[,;:][^\s\n]/, `${lang} 半角标点后缺空格`);
    }
});

check("四语文案无感叹号与禁用词", () => {
    const banned = ["赋能", "一站式", "无缝", "极致", "重新定义", "未来已来", "解锁", "颠覆", "引领", "生态闭环", "亲", "哦"];
    for (const lang of LANGS) {
        const texts = [locales[lang].dialog.permission, ...Object.values(locales[lang].perms)]
            .map((x) => Object.values(x).join("\n")).join("\n");
        assert.doesNotMatch(texts, /[！!]/u, `${lang} 出现感叹号`);
        for (const word of banned) assert.doesNotMatch(texts, new RegExp(word), `${lang} 出现禁用词「${word}」`);
    }
});

check("猫语保留喵尾，不出现乱码", () => {
    const cat = locales.cat.dialog.permission;
    assert.match(cat.always, /喵/);
    assert.match(cat.footer, /喵/);
    assert.doesNotMatch(JSON.stringify(locales.cat), /[�]/u);
});

/* ── 七、样式与动效规范 ── */

check("弹窗动画只动 transform / opacity，并遵守减少动态效果", () => {
    const src = read("src/javascripts/ui/dialog.js");
    const styleBlock = src.match(/style\.textContent = `([\s\S]*?)`;/);
    assert.ok(styleBlock, "找不到注入的样式块");
    const css = styleBlock[1];
    const transitions = css.match(/transition:\s*([^;]+);/g) || [];
    assert.ok(transitions.length > 0, "缺少过渡声明");
    for (const line of transitions) assert.doesNotMatch(line, /(width|height|top|left|margin|padding|box-shadow)/);
    assert.match(css, /data-reduce-motion="on"/);
    assert.match(css, /@keyframes os-dialog-indeterminate[\s\S]*?transform:/);
});

check("弹窗界面无 emoji", () => {
    const files = ["src/javascripts/ui/dialog.js", "src/javascripts/ui/alert.js", "src/javascripts/api-grants.js"];
    for (const file of files) {
        const src = read(file);
        assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${file} 出现 emoji`);
    }
});

/* ── 结果 ── */

if (failures.length) {
    console.error(`\n弹窗探针失败 ${failures.length}/${checks}：\n`);
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
}

console.log(`弹窗探针通过 ✓（${checks} 项：取消约定 / 危险焦点 / Esc·遮罩·Tab / 权限三选项 / 越权拒绝 / 四语文案 / 动效规范）`);
