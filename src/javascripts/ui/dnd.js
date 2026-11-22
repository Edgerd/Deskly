/**
 * ui/dnd.js — 系统级拖拽底座（保真清单 F-24 / F-07 / F-06 共用）。
 *
 * 两条通道：
 *  - 内部拖拽（访达 / 桌面条目）：DataTransfer 自定义类型携带 {paths, from}，
 *    同文档内另留模块级 payload 兜底（dragover 阶段读不到 getData，只能靠它判目标合法性）；
 *  - 外部文件（操作系统拖入）：types 含 "Files"。
 *
 * 视觉：半透明幽灵 + 数量角标（setDragImage），目标高亮 class 由消费方自管。
 * 本模块不碰文件系统：move/copy/trash 全由消费方调 Deskly.fs / trash 完成。
 */

export const DND_MIME = "application/x-deskly-paths";

let internalPayload = null;

/** 拖起内部条目。paths 为绝对虚拟路径数组；from 为来源界面标识（finder/desktop）。 */
export function setInternalDrag(e, { paths, from }) {
    internalPayload = { paths: [...paths], from };
    const dt = e.dataTransfer;
    if (!dt) return;
    try {
        dt.setData(DND_MIME, JSON.stringify(internalPayload));
        dt.setData("text/plain", paths.join("\n"));
    } catch { /* 某些嵌入上下文 setData 受限，模块级兜底仍在 */ }
    dt.effectAllowed = "copyMove";
}

/** dragover/drop 阶段读取内部载荷；非内部拖拽返回 null。 */
export function readInternalDrag(e) {
    const dt = e.dataTransfer;
    if (dt) {
        const types = Array.from(dt.types || []);
        if (types.includes(DND_MIME)) {
            if (e.type === "drop") {
                try {
                    const raw = dt.getData(DND_MIME);
                    if (raw) {
                        const o = JSON.parse(raw);
                        if (o && Array.isArray(o.paths)) return o;
                    }
                } catch { /* 落回模块级兜底 */ }
            }
            if (internalPayload) return internalPayload;
        }
    }
    return null;
}

/** 操作系统真实文件拖入。 */
export function hasFiles(e) {
    const dt = e.dataTransfer;
    return !!dt && Array.from(dt.types || []).includes("Files");
}

/** 拖拽结束（dragend）清理模块级兜底，避免下一次 dragover 误判。 */
export function endInternalDrag() {
    internalPayload = null;
}

/** Option/Alt 按下 = 复制，否则移动。 */
export function wantsCopy(e) {
    return Boolean(e.altKey);
}

/**
 * 半透明幽灵 + 数量角标。元素挂到 body 供 setDragImage 截取，dragend 后移除。
 * @param {DragEvent} e
 * @param {string} label 首个条目名
 * @param {number} count 携带数量
 */
export function dragGhost(e, label, count) {
    const dt = e.dataTransfer;
    if (!dt || typeof dt.setDragImage !== "function") return;
    const ghost = document.createElement("div");
    ghost.className = "deskly-dnd-ghost";
    const name = document.createElement("span");
    name.className = "deskly-dnd-ghost__name";
    name.textContent = label;
    ghost.appendChild(name);
    if (count > 1) {
        const badge = document.createElement("span");
        badge.className = "deskly-dnd-ghost__count";
        badge.textContent = String(count);
        ghost.appendChild(badge);
    }
    document.body.appendChild(ghost);
    try { dt.setDragImage(ghost, 12, 12); } catch { /* 忽略 */ }
    const cleanup = () => {
        ghost.remove();
        document.removeEventListener("dragend", cleanup, true);
    };
    document.addEventListener("dragend", cleanup, true);
    setTimeout(() => ghost.remove(), 0);
}

/** 注入幽灵样式（一次）。 */
export function ensureGhostStyle() {
    if (document.getElementById("deskly-dnd-style")) return;
    const style = document.createElement("style");
    style.id = "deskly-dnd-style";
    style.textContent = `
.deskly-dnd-ghost{position:fixed;left:-1000px;top:-1000px;display:flex;align-items:center;gap:6px;
  padding:6px 10px;border-radius:8px;background:var(--window-bg,rgba(255,255,255,.85));
  border:1px solid var(--hairline,rgba(0,0,0,.15));box-shadow:0 6px 18px rgba(0,0,0,.25);
  font:12px/1.2 -apple-system,system-ui,sans-serif;color:var(--surface-text,#1d1d1f);opacity:.85;max-width:220px}
.deskly-dnd-ghost__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deskly-dnd-ghost__count{flex:none;min-width:18px;height:18px;border-radius:9px;background:var(--accent,#0a84ff);
  color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 5px}
.dnd-drop-target{outline:2px solid var(--accent,#0a84ff);outline-offset:-2px;border-radius:6px}
.dnd-drop-invalid{cursor:no-drop !important}`;
    document.head.appendChild(style);
}