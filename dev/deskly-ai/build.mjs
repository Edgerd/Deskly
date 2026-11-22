/**
 * build.mjs — 构建 Deskly AI（改造自 deepseek-ai/chat-demo v0.1.1）
 *
 * 流程：
 *   1. 准备上游源码（默认 temp/deskly-ai-src，缺失时按 tag 下载 tar.gz 解开）；
 *   2. 同步到构建目录 temp/deskly-ai-build（保留其中的 node_modules）；
 *   3. 覆盖 dev/deskly-ai/overrides 下的文件，并做少量文本替换；
 *   4. 首次运行安装依赖，rspack 生产构建；
 *   5. 把 dist 复制到 mods/deskly-ai/app。
 *
 * 用法：node dev/deskly-ai/build.mjs [--force]
 */

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const UPSTREAM_TAG = "v0.1.1";
const UPSTREAM_URL = `https://codeload.github.com/deepseek-ai/chat-demo/tar.gz/refs/tags/${UPSTREAM_TAG}`;
const SRC = path.join(REPO, "temp/deskly-ai-src");
const WORK = path.join(REPO, "temp/deskly-ai-build");
const DEST = path.join(REPO, "mods/deskly-ai/app");
const FORCE = process.argv.includes("--force");

const log = (message) => console.log(`[deskly-ai] ${message}`);

/** 下载并解开上游 tarball（仅在源码目录缺失时执行）。 */
function fetchUpstream() {
    if (existsSync(path.join(SRC, "package.json"))) return;
    log("未找到上游源码，开始下载 " + UPSTREAM_TAG);
    mkdirSync(SRC, { recursive: true });
    const archive = path.join(REPO, "temp", `chat-demo-${UPSTREAM_TAG}.tar.gz`);
    execFileSync("curl", ["-L", "--fail", "-o", archive, UPSTREAM_URL], { stdio: "inherit" });
    execFileSync("tar", ["-xzf", archive, "-C", SRC, "--strip-components=1"], { stdio: "inherit" });
}

/** 上游源码 → 构建目录；node_modules 与 dist 不复制，保留构建缓存。 */
function syncSource() {
    mkdirSync(WORK, { recursive: true });
    cpSync(SRC, WORK, {
        recursive: true,
        filter: (file) => {
            const rel = path.relative(SRC, file);
            return !rel.startsWith("node_modules") && !rel.startsWith("dist") && !rel.startsWith(".git");
        },
    });
}

/** 覆盖文件：overrides 内的相对路径与 src 一致。 */
function applyOverrides() {
    cpSync(path.join(HERE, "overrides"), WORK, { recursive: true });
    log("已应用覆盖层");
}

/** 单点文本替换；找不到原文时报告并中止，避免静默产出旧界面。 */
function patch(relative, from, to) {
    const file = path.join(WORK, relative);
    const text = readFileSync(file, "utf8");
    if (text.includes(to) && !text.includes(from)) return;
    if (!text.includes(from)) throw new Error(`补丁找不到目标：${relative}\n${from}`);
    writeFileSync(file, text.replace(from, to));
    log(`已替换 ${relative}`);
}

/** 构建期的零散改动（品牌名、亚克力侧栏、透明底）。 */
function applyPatches() {
    patch("src/main.tsx", "import './app/global.css'", "import './app/global.css'\nimport './app/deskly.css'");
    patch("src/index.html", "<title>API 使用 demo</title>", "<title>Deskly AI</title>");
    patch("src/index.html", 'content="#ffffff"', 'content="#f5f5f7"');

    patch("src/services/chat/store.ts",
        "const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'",
        "const SYSTEM_PROMPT = '该助手为 Deskly AI，由 Deskly 桌面系统提供。'");

    patch("src/i18n/zh.ts", "appName: 'API 使用 demo'", "appName: 'Deskly AI'");
    patch("src/i18n/en.ts", "appName: 'API usage demo'", "appName: 'Deskly AI'");
    // 系统把思考强度设为「不开启」时，开关仍可用，但要提醒实际只按最低强度执行
    patch("src/i18n/zh.ts",
        "  thinkingSwitch: '深度思考',",
        "  thinkingSwitch: '深度思考',\n  thinkingOffFallback: '系统设置中的思考强度为「不开启」，本次将使用最低强度。',");
    patch("src/i18n/en.ts",
        "  thinkingSwitch: 'DeepThink',",
        "  thinkingSwitch: 'DeepThink',\n  thinkingOffFallback: 'Thinking effort is off in System Settings. Using the lowest effort for this chat.',");
    patch("src/i18n/zh.ts",
        "  changeApiKey: '更换 API Key',",
        "  changeApiKey: '更换 API Key',\n  systemManagedTitle: 'AI 服务由系统统一管理',\n  systemManagedDesc: '服务商、密钥与高级参数在「系统设置 → Apple 智能与 Siri」中配置。',");
    patch("src/i18n/en.ts",
        "  changeApiKey: 'Change API Key',",
        "  changeApiKey: 'Change API Key',\n  systemManagedTitle: 'AI service is managed by the system',\n  systemManagedDesc: 'Configure the provider and key in System Settings → Apple Intelligence & Siri.',");

    // 深度思考开关：先照常切换，再问一次系统强度；关闭态下提醒本次按最低强度执行
    patch("src/components/chatInput/ChatInput.tsx",
        "import { ensureApiKey } from '../settings/settingsDialogState.js'",
        "import { ensureApiKey } from '../settings/settingsDialogState.js'\nimport { call } from '../../services/api/bridge.js'");
    patch("src/components/chatInput/ChatInput.tsx",
        "  const togglesRef = useRef<HTMLDivElement>(null)",
        "  const togglesRef = useRef<HTMLDivElement>(null)\n\n"
        + "  // 系统强度为「不开启」时仍允许临时开启，但只按最低强度思考，并提示一次。\n"
        + "  const toggleThinking = async (next: boolean) => {\n"
        + "    setThinking(next)\n"
        + "    if (!next) return\n"
        + "    try {\n"
        + "      const status = await call<{ effort?: string }>('status')\n"
        + "      if (status?.effort === 'off') showToast({ key: 'thinkingOffFallback' })\n"
        + "    } catch {\n"
        + "      // 宿主不可用时保持静默，发送阶段仍会按最低强度执行\n"
        + "    }\n"
        + "  }");
    patch("src/components/chatInput/ChatInput.tsx",
        "onClick={() => setThinking(!thinking)}",
        "onClick={() => void toggleThinking(!thinking)}");

    // 右侧内容区（较深）与窗口画布（完全透明，交给宿主亚克力）
    patch("src/app/App.module.css",
        "  overflow: hidden;\n  background-color: var(--dsw-alias-bg-base);\n}",
        "  overflow: hidden;\n  background-color: transparent;\n}");
    patch("src/app/App.module.css",
        "  flex: 1;\n  min-width: 0;\n}",
        "  flex: 1;\n  min-width: 0;\n  background-color: var(--deskly-pane);\n}");

    // 顶部标题条与输入区底板：不再用不透明底色盖住亚克力
    patch("src/components/session/SessionView.module.css",
        "  background: var(--dsw-alias-bg-base);\n}",
        "  background: transparent;\n}");
    patch("src/components/session/SessionView.module.css",
        "  background: linear-gradient(\n"
        + "    to bottom,\n"
        + "    transparent 0%,\n"
        + "    transparent 30%,\n"
        + "    var(--dsw-alias-bg-base) 30%,\n"
        + "    var(--dsw-alias-bg-base) 100%\n"
        + "  );",
        "  background: none;");
    patch("src/components/messages/UserMessage.module.css",
        "  background-color: var(--dsw-alias-bg-base);\n  overflow: hidden;",
        "  background-color: var(--deskly-input);\n  overflow: hidden;");

    // 侧边栏：左侧更透明，模糊强度由宿主从系统亚克力令牌同步进 iframe
    patch("src/components/sider/Sider.module.css",
        "  background-color: var(--dsw-specific-sidebar-fill);\n}",
        "  background-color: var(--deskly-sidebar);\n"
        + "  -webkit-backdrop-filter: blur(var(--deskly-blur, 20px)) saturate(var(--deskly-saturate, 180%));\n"
        + "  backdrop-filter: blur(var(--deskly-blur, 20px)) saturate(var(--deskly-saturate, 180%));\n}");
    patch("src/components/sider/Sider.module.css",
        "  color: var(--dsw-alias-label-tertiary);\n  background-color: var(--dsw-specific-sidebar-fill);",
        "  color: var(--dsw-alias-label-tertiary);\n  background-color: transparent;");
    patch("src/components/sider/Sider.module.css",
        "  color: var(--dsw-alias-brand-primary);",
        "  color: #0a84ff;\n  letter-spacing: -0.02em;");
}

/** 依赖安装：node_modules 已存在则跳过（--force 时重装）。 */
function install() {
    if (existsSync(path.join(WORK, "node_modules/@rspack/core")) && !FORCE) return;
    log("安装依赖…");
    execSync("npm install --no-audit --no-fund --loglevel=error", { cwd: WORK, stdio: "inherit" });
}

/** rspack 生产构建（上游 build 脚本含 rm -rf，Windows 下直接调用 rspack）。 */
function build() {
    log("rspack 构建…");
    execSync("npx rspack build -c rspack.config.ts", {
        cwd: WORK, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" },
    });
}

/** dist → mods/deskly-ai/app，保留宿主插件的其他文件。 */
function publish() {
    const dist = path.join(WORK, "dist");
    if (!existsSync(path.join(dist, "index.html"))) throw new Error("构建产物缺少 index.html");
    rmSync(DEST, { recursive: true, force: true });
    cpSync(dist, DEST, { recursive: true });
    log("已发布到 mods/deskly-ai/app");
}

fetchUpstream();
syncSource();
applyOverrides();
applyPatches();
install();
build();
publish();
log("完成");
