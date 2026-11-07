/**
 * core/menuProviders.js — 系统级右键菜单的 provider 装配器。
 *
 * 桌面与访达共用：条目由内建 provider（core/fileMenu.js）+ 插件 provider 组合，
 * 本模块只做注册、判定、排序、分隔线收敛与 ⌥ 键实时替换，不渲染 DOM
 * （渲染仍是 ui/contextMenu.js 的 createContextMenu）。
 *
 * provider 契约（将来写进 devdocs/api/menus.html 的形状）：
 *   registerProvider({
 *     id: 'office',                       // 必填，唯一
 *     match: (sel) => boolean,            // 本菜单是否适用；抛错按不适用计并 console.warn
 *     items: (sel) => MenuItem[],         // 见下；抛错按空数组计
 *     order: 100,                         // 数值小者靠前；内建占用 0-99
 *   }) → unregister()
 *
 * sel = {
 *   location: 'desktop' | 'finder',       // 菜单弹在哪个界面
 *   items: [{ path, name, type }],        // 当前选中项（空数组=空白处）
 *   isBackground: boolean,                // 是否点在空白处
 * }
 *
 * MenuItem = {
 *   id, label, action(sel, x, y), disabled?, checked?,
 *   type: 'separator',                    // 或省略
 *   hasSubmenu?,                          // action 负责在 (x,y) 弹下一级
 *   alt?: { label, action },              // 按住 ⌥ 时的替换项（macOS 语义）
 * }
 */

import { createContextMenu } from "../ui/contextMenu.js";

const providers = new Map();   // id → provider

function registerProvider(provider) {
    if (!provider || !provider.id) throw new Error("provider 必须有 id");
    if (typeof provider.match !== "function" || typeof provider.items !== "function") {
        throw new Error("provider 必须有 match 与 items 函数");
    }
    providers.set(provider.id, { order: 100, ...provider });
    return () => providers.delete(provider.id);
}

/** 测试/收口用：当前注册的 provider 清单（只读快照）。 */
function listProviders() {
    return [...providers.values()].map((p) => ({ id: p.id, order: p.order }));
}

/**
 * 装配一次菜单的条目：内建条目在前，插件条目按 order 追加，分隔线统一收敛。
 * 单个 provider 出错不连累整份菜单（隔离在各自 try 里）。
 * @param {object} sel 见文件头
 * @param {Array<object>} builtinItems 内建 provider 已生成的条目
 */
function assemble(sel, builtinItems) {
    const out = [...(builtinItems || [])];
    const extra = [];
    for (const p of [...providers.values()].sort((a, b) => a.order - b.order)) {
        let hit = false;
        try { hit = Boolean(p.match(sel)); } catch (err) {
            console.warn(`[menuProviders] ${p.id}.match 抛错，按不适用计：`, err);
            continue;
        }
        if (!hit) continue;
        try {
            const items = p.items(sel);
            if (Array.isArray(items)) extra.push(...items.filter(Boolean));
        } catch (err) {
            console.warn(`[menuProviders] ${p.id}.items 抛错，按空计：`, err);
        }
    }
    if (extra.length) out.push({ type: "separator" }, ...extra);
    return out;
}

/**
 * 弹出菜单，并托管 ⌥ 键的实时替换：按住 Alt/Option 时把带 alt 的项换成替代项，
 * 松开换回来（同一坐标原地重建，与 macOS 菜单行为一致）。
 * @param {number} x
 * @param {number} y
 * @param {object} sel
 * @param {Array<object>} builtinItems
 * @returns {{ close: Function }} 句柄（调用方一般不需要，菜单自管理关闭）
 */
function show(x, y, sel, builtinItems) {
    let menu = null;

    const rebuild = (altDown) => {
        const items = assemble(sel, builtinItems).map((item) => {
            if (altDown && item && item.alt) {
                return { ...item, label: item.alt.label, action: item.alt.action, alt: undefined };
            }
            return item;
        });
        if (menu) menu.remove();
        menu = createContextMenu(x, y, items);
    };

    const onKey = (e) => {
        if (e.key !== "Alt") return;
        rebuild(e.type === "keydown");
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKey);
    // 菜单关闭时摘下这对监听：createContextMenu 的关闭路径不收编我们，
    // 用 MutationObserver 观察菜单离开文档，避免监听器永久泄漏。
    const observer = new MutationObserver(() => {
        if (menu && document.contains(menu)) return;
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("keyup", onKey);
        observer.disconnect();
    });
    observer.observe(document.body, { childList: true });

    rebuild(false);
    return { close: () => { if (menu) menu.remove(); } };
}

const MenuProviders = Object.freeze({ registerProvider, listProviders, assemble, show });
globalThis.__menuProviders = MenuProviders;
export { MenuProviders };
