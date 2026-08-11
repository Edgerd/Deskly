/**
 * app-store.js — 应用商店逻辑
 *
 * 职责：
 * 1. 从插件注册表读取已注册插件，渲染成卡片网格。
 * 2. 支持按名称搜索过滤、按分类（全部/已安装/待更新）切换。
 * 3. 支持拖拽 ZIP 到安装热区，调用 JSZip 解压并注册插件。
 * 4. 应用商店本体以插件形式运行（mods/app-store/），本模块负责商店容器内的逻辑。
 *
 * 注意：
 * - 本模块被 mods/app-store/script.js 引用，两者配合。
 * - 远程插件源加载暂不实现（界面占位）。
 */

import {
    getPlugins,
    getPlugin,
    getIcon,
    load as loadPlugin,
    registerInstalledPlugin,
} from "./plugin-manager.js";

/**
 * 渲染应用商店主体：绑定搜索、分类、ZIP 拖放事件。
 * 在应用商店插件加载完成（DOM 注入）后调用。
 * @returns {void}
 */
export function initStore() {
    const container = document.querySelector(".appstore");
    if (!container) return;

    const searchInput = container.querySelector(".search-input");
    const categoryList = container.querySelectorAll(".category");
    const grid = container.querySelector(".grid");
    const dropZone = container.querySelector(".drop-zone");

    // 当前分类：all / installed / updates
    let currentCategory = "all";

    // 渲染插件卡片
    function renderPlugins() {
        if (!grid) return;
        grid.innerHTML = "";
        const keyword = searchInput ? searchInput.value.trim().toLowerCase() : "";
        const plugins = getPlugins().filter((m) => {
            if (keyword && !(m.name || "").toLowerCase().includes(keyword)) return false;
            if (currentCategory === "installed") return !!m._installed; // 仅显示用户安装的插件
            return currentCategory !== "updates";  // 暂无远程更新
        });

        if (plugins.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = "没有找到插件";
            grid.appendChild(empty);
            return;
        }

        const mk = (tag, cls, text) => {
            const el = document.createElement(tag);
            if (cls) el.className = cls;
            if (text != null) el.textContent = text;
            return el;
        };

        plugins.forEach((m) => {
            const iconPath = getPlugin(m.id) ? getIcon(m.id) : "";
            const icon = mk("img", "icon");
            icon.src = iconPath ? `${iconPath}?v=${Date.now()}` : "";
            icon.onerror = () => (icon.src = "./assets/icons/App Store.png");

            const card = mk("div", "card");
            card.append(
                icon,
                mk("p", "name", m.name || m.id),
                mk("p", "desc", m.description || ""),
                mk("p", "version", "v" + (m.version || "1.0.0")),
            );
            const btn = mk("button", "action", "打开");
            btn.addEventListener("click", () => loadPlugin(m.id));
            card.append(btn);
            grid.appendChild(card);
        });
    }

    // 搜索过滤
    searchInput?.addEventListener("input", renderPlugins);

    // 分类切换
    categoryList.forEach((cat) => {
        cat.addEventListener("click", () => {
            categoryList.forEach((c) => c.classList.remove("active"));
            cat.classList.add("active");
            currentCategory = cat.dataset.category || "all";
            renderPlugins();
        });
    });

    // 拖拽 ZIP 安装
    if (dropZone) {
        dropZone.addEventListener("dragover", (e) => {
            e.preventDefault();
            dropZone.classList.add("over");
        });
        dropZone.addEventListener("dragleave", () => {
            dropZone.classList.remove("over");
        });
        dropZone.addEventListener("drop", (e) => {
            e.preventDefault();
            dropZone.classList.remove("over");
            const files = Array.from(e.dataTransfer.files || []);
            const zipFile = files.find((f) => f.name.toLowerCase().endsWith(".zip"));
            zipFile ? installZip(zipFile) : setDropStatus("请拖入 .zip 格式的插件包", "error");
        });
    }

    renderPlugins();
}

/**
 * 设置 ZI 拖放热区的状态提示（依赖全局 dropZone 状态元素）。
 * @param {string} text 提示文本
 * @param {"info"|"error"|"success"} type 提示类型
 * @returns {void}
 */
function setDropStatus(text, type = "info") {
    const status = document.querySelector(".appstore .drop-status");
    if (!status) return;
    status.textContent = text;
    status.dataset.type = type;
}

/**
 * 计算包内文件的公共顶层目录前缀（如全部位于 myplugin/ 下则返回 "myplugin/"）。
 * 用于安装时剥离该前缀，使资源键名与 ./mods/<id>/<file> 对齐。
 * @param {string[]} names ZIP 内文件相对路径
 * @returns {string} 公共根目录前缀（无则返回空串）
 */
function computeCommonRoot(names) {
    const dirs = names
        .map((n) => n.replace(/^\.\//, ""))
        .filter((n) => n.includes("/"))
        .map((n) => n.split("/")[0]);
    if (dirs.length === 0) return "";
    const first = dirs[0];
    return dirs.every((d) => d === first) ? first + "/" : "";
}

/**
 * 归一化文件键名：去掉前导 "./" 与公共根目录前缀。
 * @param {string} name 原始路径
 * @param {string} rootPrefix 公共根目录前缀
 * @returns {string} 归一化键名
 */
function normalizeKey(name, rootPrefix) {
    let n = name.replace(/^\.\//, "");
    if (rootPrefix && n.startsWith(rootPrefix)) n = n.slice(rootPrefix.length);
    return n;
}

/**
 * 解压并安装一个插件 ZIP 包。
 * 使用全局 JSZip（CDN 引入）；若未加载则提示。
 * @param {File} zipFile 用户拖入的 .zip 文件
 * @returns {Promise<void>}
 */
async function installZip(zipFile) {
    if (typeof JSZip === "undefined") {
        setDropStatus("JSZip 未加载，无法解压 ZIP", "error");
        return;
    }
    try {
        setDropStatus("正在解压：", "info");
        const zip = await JSZip.loadAsync(zipFile);
        const manifestFile = zip.file("manifest.json");
        if (!manifestFile) {
            setDropStatus("插件包缺少 manifest.json", "error");
            return;
        }
        const manifest = JSON.parse(await manifestFile.async("string"));
        if (!manifest || !manifest.id) {
            setDropStatus("manifest.json 缺少 id 字段", "error");
            return;
        }

        // 收集包内文件为 Blob（二进制安全：图标等二进制资源不再被当作文本损坏），
        // 并归一化键名：去掉前导 "./" 及可能的公共根目录前缀（如 myplugin/），
        // 使 Service Worker 能以 ./mods/<id>/<file> 直接命中。
        const rawEntries = Object.entries(zip.files).filter(([name, f]) => !f.dir);
        const rootPrefix = computeCommonRoot(rawEntries.map(([name]) => name));
        const files = {};
        for (const [name, f] of rawEntries) {
            const norm = normalizeKey(name, rootPrefix);
            if (norm) files[norm] = await f.async("blob");
        }

        const ok = await registerInstalledPlugin(manifest, files);
        setDropStatus(ok ? `已安装插件：${manifest.name || manifest.id}` : "注册失败", ok ? "success" : "error");

        // 重新渲染
        const grid = document.querySelector(".appstore .grid");
        if (grid) {
            const { initStore } = await import("./app-store.js");
            initStore();
        }
    } catch (err) {
        console.error("[app-store] 安装失败", err);
        setDropStatus("安装失败：解析错误", "error");
    }
}