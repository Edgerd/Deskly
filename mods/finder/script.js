/**
 * script.js — 访达（Finder）插件入口：编排子模块初始化、VFS 渲染调度、打开/预览、授权弹窗与菜单命令。
 * 冷加载入口（type="module"），每次开窗重新执行；子模块为常驻单例，故 init 起始调 FinderState.reset()，窗口关闭（plugin-unload）时逐个 dispose()。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderLayout } from './finder-layout.js';
import { FinderSidebar } from './finder-sidebar.js';
import { FinderToolbar } from './finder-toolbar.js';
import { FinderTabs } from './finder-tabs.js';
import { FinderViews } from './finder-views.js';
import { FinderSearch } from './finder-search.js';
import { FinderTags } from './finder-tags.js';
import { FinderActions } from './finder-actions.js';
import { FinderContextMenu } from './finder-contextmenu.js';
import { FinderChrome } from './finder-chrome.js';
import { FinderSettings } from './finder-settings.js';
import { readInternalDrag, endInternalDrag } from '../../src/javascripts/ui/dnd.js';

// ---------- Deskly 门面（Q6 收口：不直接 import 内核模块） ----------
const Deskly = () => window.Deskly;
/** 信封 → 值/异常：EREAUTH 还原成 NeedsReauthError 形态，沿用既有按 name 判别的分支。 */
const unwrap = (env) => {
    if (!env || !env.ok) {
        const err = new Error((env && env.reason) || 'Deskly 调用失败');
        err.code = (env && env.code) || 'EIO';
        if (err.code === 'EREAUTH' || err.code === 'REAUTH') err.name = 'NeedsReauthError';
        throw err;
    }
    return env.value;
};
/** 与旧直连同名的本地门面，调用点零改动 */
const VFS = {
    list: async (p) => unwrap(await Deskly().vfs.list(p)),
    readFile: async (p) => unwrap(await Deskly().vfs.readFile(p)),
    init: async () => unwrap(await Deskly().vfs.init()),
    authorize: async () => unwrap(await Deskly().vfs.authorize()),
    reauthorize: async () => unwrap(await Deskly().vfs.reauthorize()),
    decline: async () => unwrap(await Deskly().vfs.decline()),
    getAuthStatus: () => Deskly().vfs.authStatus(),
    whereStored: () => Deskly().vfs.whereStored(),
    normalizePath: (p) => Deskly().fs.paths.normalize(p),
    TOP_FOLDERS: Deskly().vfs.topFolders(),
    BOOKMARKS_PATH: Deskly().vfs.bookmarksPath(),
    RECENT_PATH: Deskly().vfs.recentPath(),
};
const OSFS = {
    normalizePath: (p) => Deskly().fs.paths.normalize(p),
    sanitizeName: (n, fb) => Deskly().fs.paths.sanitizeName(n, fb),
    joinPath: (a, b) => Deskly().fs.paths.join(a, b),
    baseName: (p) => Deskly().fs.paths.baseName(p),
    parentOf: (p) => Deskly().fs.paths.parentOf(p),
    exists: async (p) => unwrap(await Deskly().fs.existsAt(p)),
    mkdir: async (p) => unwrap(await Deskly().fs.mkdirAt(p)),
    TOP: { trash: { path: Deskly().fs.paths.trash } },
};
const TRASH_ORIGIN_SUFFIX = Deskly().fs.trash.originSuffix;
const QuickLook = { open: (items, idx) => Deskly().quicklook.open(items, idx), isOpen: () => Deskly().quicklook.isOpen() };
const createContextMenu = (x, y, items) => Deskly().ui.contextMenu(x, y, items);

// ---------- DOM 引用 ----------
const finder = document.querySelector('.finder.window');
const authModal = document.getElementById('auth-modal');
const authNote = document.getElementById('auth-note');
const authAllow = document.getElementById('auth-allow');
const authDeny = document.getElementById('auth-deny');

// 需要常驻释放的子模块（dispose 由各模块自身实现，入口只做统一编排）
const SUBMODULES = [FinderLayout, FinderSidebar, FinderToolbar, FinderTabs, FinderViews, FinderSearch, FinderTags, FinderActions];

/** 渲染请求序号：只允许最后一次请求落地，慢目录不得覆盖新目录 */
let renderSeq = 0;

/** @type {Function[]} 本脚本注册的全局监听的释放回调 */
let disposers = [];
/** 本窗口实例是否已释放；FinderState 是跨实例常驻单例，释放后不得再往里写目录。 */
let disposed = false;

/** 登记一个释放回调。 */
function track(fn) { disposers.push(fn); }

/** 执行并清空全部释放回调（可重复调用）。 */
function dispose() {
    disposed = true; // 关闭后再有在途 VFS.list 落地，也不得写常驻的 FinderState
    // 同时把两个请求序号推过一格：下一次开窗会把 disposed 复位，而 renderSeq 是模块级的、
    // 不会重来 —— 若这里不推进，上一窗口那条还在 await 的目录请求返回时
    // 「seq === renderSeq」仍然成立，就会把旧目录写进刚 reset() 过的常驻状态里。
    renderSeq++;
    SUBMODULES.forEach((m) => {
        try { m.dispose(); } catch (err) { console.warn('[finder] 子模块释放失败：', err); }
    });
    const list = disposers;
    disposers = [];
    list.forEach(fn => fn());
}

/**
 * 渲染当前路径：读目录 → 写入状态。
 * 任何失败都必须留下可见状态，不能让窗口静默停在空白。
 * @param {string} path
 */
async function render(path) {
    const seq = ++renderSeq;
    FinderState.setCurrentPath(path);
    try {
        let entries = await VFS.list(path);
        if (disposed || seq !== renderSeq) return;
        // P0-4：/废纸篓 视图隐藏「放回原处」的溯源伴生文件（记账用，不是真实体）
        if (OSFS.normalizePath(path) === OSFS.TOP.trash.path) {
            entries = entries.filter((e) => !e.name.endsWith(TRASH_ORIGIN_SUFFIX));
        }
        FinderState.setEntries(entries);
    } catch (err) {
        if (disposed || seq !== renderSeq) return;
        console.error('[finder] 目录读取失败：', path, err);
        // 权限待补不是「这个文件夹没东西」，必须说清是要重新授权，也不能当空目录显示
        FinderState.setEntries([], err && err.name === 'NeedsReauthError'
            ? i18n.t('finder.auth.needsReauth', '根目录的读写权限需要重新授权，在此之前访达动不了里面的文件。')
            : i18n.t('finder.loadError', '无法读取该文件夹，请重试或重新授权'));
    }
}

/**
 * 导航到指定路径。
 * @param {string} path
 */
async function navigate(path) {
    const norm = VFS.normalizePath?.(path) ?? path;
    FinderState.navigate(norm);
    await render(norm);
}

// ---------- 导航 ----------

async function goBack() { if (FinderState.goBack()) await render(FinderState.getState().currentPath); }

async function goForward() { if (FinderState.goForward()) await render(FinderState.getState().currentPath); }

async function goUp() { FinderState.goUp(); await render(FinderState.getState().currentPath); }

/** 刷新当前路径。 */
async function refresh() {
    await render(FinderState.getState().currentPath);
}

/**
 * 在当前目录新建文件夹（真 mkdir，三处入口共用这一个实现）。
 * mkdir 是幂等的：已存在时静默落进那个目录，所以必须先用 exists 让重名。
 */
async function createFolder() {
    const parent = VFS.normalizePath(FinderState.getState().currentPath);
    // 收藏夹与「最近使用」是门面合成的虚拟节点（vfs.js 用特殊分支接管它们的列表）：
    // 在这儿 mkdir 只会写出一行永远显示不出来的目录，还会顺手让根目录冒出重名节点。
    if (parent === VFS.BOOKMARKS_PATH || parent.startsWith(`${VFS.BOOKMARKS_PATH}/`)
        || parent === VFS.RECENT_PATH) {
        window.__dialog?.alert?.(
            i18n.t('finder.title', '访达'),
            i18n.t('finder.virtualFolder', '这里只是收藏夹与最近使用的快捷视图，不能在里面新建文件夹。'),
        );
        return;
    }
    const raw = await window.__dialog.prompt(i18n.t('finder.newFolder', '新建文件夹'), i18n.t('finder.newFolderPrompt', '新建文件夹名称：'), { value: i18n.t('finder.newFolderDefault', '未命名文件夹') });
    const input = (raw || '').trim();
    if (!input) return;
    const base = OSFS.sanitizeName(input, i18n.t('finder.newFolderDefault', '未命名文件夹'));
    let name = base, i = 1;
    while (await OSFS.exists(OSFS.joinPath(parent, name))) name = `${base} ${++i}`;
    try {
        await OSFS.mkdir(OSFS.joinPath(parent, name));
    } catch (err) {
        // 不能假装建好了：权限待补时把弹窗摆出来，让用户知道下一步该做什么
        if (err && err.name === 'NeedsReauthError') {
            showAuthModal(VFS.getAuthStatus());
            return;
        }
        throw err;
    }
    await refresh();
}

// ---------- 文件操作（F-24 拖拽落点 / F-26 键盘 / F-37 菜单共用） ----------

/** 内部剪贴板：{ op: 'copy'|'cut', paths: string[] } */
let clipboard = null;

/** 最近一次可撤销操作（简化版 undo：单步，新操作顶替旧操作）。 */
let lastUndo = null;

/**
 * 撤销提示 toast：单步「撤销」按钮（拖拽移动 / 移入废纸篓共用）。
 * 复用桌面 pushUndo 的思路，但访达自持一份，不依赖 desktop.js。
 */
function pushUndo(kind, detail) {
    lastUndo = { kind, ...detail };
    const host = document.querySelector('.finder-clip');
    if (!host) return;
    host.querySelector('.finder-undo-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'finder-undo-toast finder-no-drag';
    const label = kind === 'trash'
        ? i18n.t('finder.undoneTrash', '已移入废纸篓')
        : i18n.t('finder.undoneMove', '已移动');
    const text = document.createElement('span');
    text.textContent = `${label}（${detail.paths.length}）`;
    const btn = document.createElement('button');
    btn.textContent = i18n.t('finder.undo', '撤销');
    btn.addEventListener('click', async () => {
        const job = lastUndo;
        lastUndo = null;
        toast.remove();
        if (!job) return;
        try {
            for (const it of job.paths) {
                if (job.kind === 'trash') {
                    // 废纸篓 → 原位置
                    await unwrap(await Deskly().fs.trash.putBack(it.to ? it.to : it));
                } else {
                    await unwrap(await Deskly().fs.moveAt(it.to, it.from));
                }
            }
            await refresh();
        } catch (err) {
            console.warn('[finder] 撤销失败：', err);
        }
    });
    toast.append(text, btn);
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
}

/**
 * 目标名冲突处理：重名自动加「 副本 n」后缀（move/copy 共用）。
 * @returns {Promise<string>} 落点全路径
 */
async function uniqueTarget(destDir, name) {
    const join = OSFS.joinPath;
    let candidate = join(destDir, name);
    if (!(await OSFS.exists(candidate))) return candidate;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; i < 100; i++) {
        candidate = join(destDir, `${stem} ${i}${ext}`);
        if (!(await OSFS.exists(candidate))) return candidate;
    }
    return candidate; // 100 次都撞名就交给内核抛 EEXIST，不再人为造名字
}

/**
 * 把一批路径移动/复制到目标目录（F-24 拖入文件夹、⌘V 粘贴共用）。
 * 跳过把父目录移进自己子目录的情况；完成后刷新当前列表 + fs-changed 会通知其它视图。
 * @param {string[]} paths
 * @param {string} targetDir
 * @param {boolean} [copy]
 */
async function movePaths(paths, targetDir, copy = false) {
    const cur = OSFS.normalizePath(FinderState.getState().currentPath || '/');
    const done = [];
    let failed = 0;
    for (const p of paths) {
        const src = OSFS.normalizePath(p);
        if (src === OSFS.normalizePath(targetDir)) continue;
        // 不能把目录移进它自己的子目录
        if (targetDir.startsWith(src + '/')) { failed++; continue; }
        const name = OSFS.baseName(src);
        try {
            const dest = await uniqueTarget(targetDir, name);
            if (copy) await unwrap(await Deskly().fs.copyAt(src, dest));
            else await unwrap(await Deskly().fs.moveAt(src, dest));
            done.push({ from: src, to: dest });
        } catch (err) {
            if (err && err.name === 'NeedsReauthError') { showAuthModal(VFS.getAuthStatus()); return; }
            failed++;
        }
    }
    if (done.length) {
        if (cur === OSFS.normalizePath(targetDir) || paths.some((p) => OSFS.normalizePath(p) === cur)) await refresh();
        if (!copy) pushUndo('move', { paths: done });
    }
    if (failed && !done.length) {
        window.__dialog?.alert?.(i18n.t('finder.title', '访达'), i18n.t('finder.moveFailed', '移动/复制失败：目标重名或位置无效。'));
    }
}

/** 移入废纸篓（Delete 键 / ⌘⌫ / 菜单共用；走内核 trash.moveToTrash，禁止硬删除）。 */
async function trashSelection(paths) {
    if (!paths || !paths.length) return;
    const done = [];
    for (const p of paths) {
        try {
            const to = await unwrap(await Deskly().fs.trash.moveToTrash(p));
            done.push({ from: p, to: to || null });
        } catch (err) {
            if (err && err.name === 'NeedsReauthError') { showAuthModal(VFS.getAuthStatus()); return; }
            console.warn('[finder] 移入废纸篓失败：', p, err);
        }
    }
    if (done.length) {
        pushUndo('trash', { paths: done });
        FinderState.clearSelection();
        await refresh();
    }
}

/** 重命名（右键/菜单）：dialog.prompt 预填原名，renameAt 真改名。 */
async function renameEntry(item) {
    if (!item || !item.path) return;
    const parent = OSFS.normalizePath(OSFS.parentOf(item.path));
    if (parent === VFS.BOOKMARKS_PATH || parent.startsWith(`${VFS.BOOKMARKS_PATH}/`) || parent === VFS.RECENT_PATH) {
        window.__dialog?.alert?.(i18n.t('finder.title', '访达'), i18n.t('finder.virtualRename', '这里的条目是虚拟节点，不能重命名。'));
        return;
    }
    const raw = await window.__dialog.prompt(i18n.t('finder.rename', '重新命名'), '', { value: item.name || '' });
    const next = (raw || '').trim();
    if (!next || next === item.name) return;
    try {
        await unwrap(await Deskly().fs.renameAt(item.path, OSFS.sanitizeName(next, item.name)));
        await refresh();
    } catch (err) {
        if (err && err.name === 'NeedsReauthError') { showAuthModal(VFS.getAuthStatus()); return; }
        window.__dialog?.alert?.(i18n.t('finder.title', '访达'), i18n.t('finder.renameFailed', '重命名失败（重名或权限不足）。'));
    }
}

/**
 * 画廊旋转落盘（F-35）：读原图 → canvas 旋转 → 写回原路径（真实改文件，不是假装转预览）。
 * @param {string} path
 * @param {number} deltaDeg -90 | 90
 */
async function rotateImage(path, deltaDeg) {
    try {
        const file = await VFS.readFile(path);
        if (!file) return;
        const bitmap = await createImageBitmap(file);
        const swap = deltaDeg === 90 || deltaDeg === -90;
        const canvas = document.createElement('canvas');
        canvas.width = swap ? bitmap.height : bitmap.width;
        canvas.height = swap ? bitmap.width : bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((deltaDeg * Math.PI) / 180);
        ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
        bitmap.close?.();
        const type = file.type && file.type.startsWith('image/') ? file.type : 'image/png';
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, type));
        if (!blob) return;
        await unwrap(await Deskly().fs.writeAt(path, blob));
        FinderViews.invalidateThumb(path);
        await refresh();
    } catch (err) {
        console.warn('[finder] 旋转落盘失败：', path, err);
    }
}

// ---------- 打开条目 ----------

/**
 * 打开条目：文件夹导航、应用直启（F-41 /Applications）、书签打开、声明了 `apps[].formats` 的应用接管，其余走 Quick Look。
 * @param {object} entry
 * @param {number} [index] 条目在渲染序列中的序号
 */
async function openEntry(entry, index) {
    if (entry.type === 'folder') {
        navigate(entry.path).catch((err) => console.error('[finder] 打开文件夹失败：', entry.path, err));
        return;
    }
    if (entry.type === 'app') {
        // /Applications 虚拟条目：path = /应用程序/<appId>，双击即启动（F-41）
        const appId = entry.appId || OSFS.baseName(entry.path);
        try {
            await Deskly().apps.launch(appId, {});
        } catch (err) {
            console.warn('[finder] 启动应用失败：', appId, err);
        }
        return;
    }
    if (entry.type === 'bookmark') {
        if (entry.url) window.open(entry.url, '_blank');
        return;
    }
    // 按扩展名问路：清单里声明了能打开该格式的应用就交给它，并把 VFS 路径带过去。
    // 只认应用级 formats（不是插件级那个纯文档字段）；没有候选应用时行为退回 Quick Look。
    const candidates = await Deskly().openWith.appsFor(getExt(entry.name)).then((env) => (env && env.ok ? env.value : []));
    if (candidates.length) {
        try {
            unwrap(await Deskly().openWith.open(entry.path, candidates[0].appId));
        } catch (err) {
            console.warn('[finder] 交给应用打开失败，回退预览：', entry.path, err);
            await openQuickLook(entry, index);
        }
        return;
    }
    await openQuickLook(entry, index);
}

/**
 * Quick Look 打开条目：预览宿主已上移为内核单例（core/quicklook.js），
 * 访达只负责把「渲染后列表」交过去 —— 顺序与过滤和列表一致，「1 / N」与 ←/→ 才对得上。
 * @param {object} entry
 * @param {number} [index] 条目在渲染序列中的序号
 */
async function openQuickLook(entry, index) {
    const rendered = FinderViews.getRenderedEntries();
    const allItems = rendered.length ? rendered : FinderState.getState().entries;
    // 书签没有文件实体（core 按路径取 stat），其余类型都交给 provider 体系
    const items = allItems.filter((en) => en.type !== 'bookmark');
    const found = items.findIndex((en) => en.path === entry.path);
    const idx = found >= 0 ? found : 0;
    await QuickLook.open(items.map((en) => en.path), idx);
}

/**
 * 「显示简介」（⌘I）：把当前多选交给内核单例面板（core/getInfo.js）。
 * 面板与桌面共用同一实现，访达这里只做「选中项 → {path,name,type}」的搬运。
 */
function showInfo() {
    const paths = [...FinderState.getState().selectedPaths];
    if (!paths.length) return;
    const rendered = FinderViews.getRenderedEntries();
    const items = paths.map((path) => {
        const hit = rendered.find((en) => en.path === path);
        return { path, name: hit ? hit.name : Deskly().fs.paths.baseName(path), type: (hit && hit.type) || 'file' };
    });
    Deskly().ui.showGetInfo(items);
}

/** 提取扩展名（idx > 0：'.gitignore' 这类隐藏文件没有扩展名）。 */
function getExt(name) {
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/**
 * ↑/↓ 移动选中（F-38）：以当前选中末位为锚，在渲染序列内前/后移动；
 * 画廊视图交给 views 的画廊步进（预览区联动）。
 */
function moveSelection(delta) {
    const mode = FinderState.getViewMode();
    if (mode === 'gallery') {
        FinderViews.galleryStep(delta);
        return;
    }
    const list = FinderViews.getRenderedEntries();
    if (!list.length) return;
    const sel = [...FinderState.getState().selectedPaths];
    let idx = sel.length ? FinderViews.indexOfPath(sel[sel.length - 1]) : -1;
    idx = Math.min(Math.max(idx + delta, 0), list.length - 1);
    FinderState.selectSingle(list[idx].path);
    const el = document.querySelector(`.entry[data-path="${CSS.escape(list[idx].path)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
}

/**
 * F-24 文档级拖拽落点（capture）：程序坞废纸篓 / 程序坞应用图标。
 * dock.js 不挂 HTML5 拖拽（本批次冻结），落点判定在这里收口：
 *  - #dock-trash：逐条 moveToTrash（内部载荷）+ 撤销 toast；
 *  - #dock .container[data-app]：应用是否收文件由 openWith.appsFor 的候选含 appId 判定（与桌面 acceptsItems 同语义）。
 * 外部文件（Files）不经此通道，保持桌面/dock 既有行为。
 */
function registerDockDropTargets() {
    const onDragOver = (e) => {
        const payload = readInternalDrag(e);
        if (!payload) return;
        if (e.target.closest?.('#dock-trash') || e.target.closest?.('#dock .container[data-app]')) {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        }
    };
    const onDrop = async (e) => {
        const payload = readInternalDrag(e);
        if (!payload) return;
        const trashZone = e.target.closest?.('#dock-trash');
        const appZone = e.target.closest?.('#dock .container[data-app]');
        if (!trashZone && !appZone) return;
        e.preventDefault();
        e.stopPropagation();
        endInternalDrag();
        const paths = (payload.paths || []).filter(Boolean);
        if (!paths.length) return;
        try {
            if (trashZone) {
                const done = [];
                for (const p of paths) {
                    const to = await unwrap(await Deskly().fs.trash.moveToTrash(p));
                    done.push({ from: p, to: to || null });
                }
                if (done.length) pushUndo('trash', { paths: done });
                return;
            }
            // 程序坞应用：只收「声明了能打开该格式」的文件（verdict 与桌面一致）
            const appName = appZone.dataset.app;
            const current = FinderState.getState().currentPath;
            for (const p of paths) {
                const ext = getExt(OSFS.baseName(p));
                const candidates = await Deskly().openWith.appsFor(ext).then((env) => (env && env.ok ? env.value : []));
                if (!candidates.some((c) => c.appId === appName)) continue;
                try {
                    await Deskly().openWith.open(p, appName);
                } catch (err) {
                    console.warn('[finder] 交给程序坞应用打开失败：', p, err);
                }
            }
            if (OSFS.normalizePath(current) !== OSFS.normalizePath(FinderState.getState().currentPath)) {
                await refresh();
            }
        } catch (err) {
            console.warn('[finder] 程序坞拖放失败：', err);
        }
    };
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    track(() => document.removeEventListener('dragover', onDragOver, true));
    track(() => document.removeEventListener('drop', onDrop, true));
}

// ---------- 授权弹窗 ----------

/**
 * 授权弹窗三态：待补权限 / 未挂载 / 浏览器不支持。
 * 未挂载不是残缺（文件存在应用内根目录里照常可用），所以只给选择、不给警告。
 * @param {object} status VFS.getAuthStatus() 的结果
 */
function showAuthModal(status) {
    if (!authModal) return;
    if (!status.supported) {
        // 没有目录选择器可给，主按钮就是骗人按钮；只留一个能关闭的（弹窗没有别的出口）
        authNote && (authNote.textContent = i18n.t('finder.auth.unsupported', '当前浏览器不支持挂载本地文件夹，文件会存在应用内的根目录里，照常可用。'));
        if (authAllow) authAllow.style.display = 'none';
        if (authDeny) { authDeny.style.display = ''; authDeny.textContent = i18n.t('common.ok', '好'); }
    } else if (status.needsReauth) {
        authNote && (authNote.textContent = i18n.t('finder.auth.needsReauth', '根目录的读写权限需要重新授权，在此之前访达动不了里面的文件。'));
        if (authAllow) { authAllow.style.display = ''; authAllow.textContent = i18n.t('finder.auth.reauthorize', '重新授权'); }
        if (authDeny) { authDeny.style.display = ''; authDeny.textContent = i18n.t('finder.auth.useInApp', '就用应用内根目录'); }
    } else {
        authNote && (authNote.textContent = i18n.t('finder.auth.mountMessage', '文件现在存在应用内的根目录里，一切照常。挂载一个本地文件夹后，同一批路径会逐段映射到那里。'));
        if (authAllow) { authAllow.style.display = ''; authAllow.textContent = i18n.t('finder.mountFolder', '挂载本地文件夹'); }
        if (authDeny) { authDeny.style.display = ''; authDeny.textContent = i18n.t('finder.auth.useInApp', '就用应用内根目录'); }
    }
    authModal.hidden = false;
}

/** 隐藏授权弹窗。 */
function hideAuthModal() {
    if (authModal) authModal.hidden = true;
}

/** 授权入口（更多菜单 / 弹窗主按钮）：已挂载只补权限，未挂载才选文件夹。 */
async function reauth() {
    const status = VFS.getAuthStatus();
    if (!status.supported) {
        showAuthModal(status);
        return;
    }
    try {
        await (status.mounted ? VFS.reauthorize() : VFS.authorize());
        hideAuthModal();
    } catch (err) {
        if (err && err.name === 'AbortError') return;   // 系统选择器里按了取消，不是故障
        console.error('[finder] 授权失败：', err);
        showAuthModal(VFS.getAuthStatus());
    }
    await refresh();
}

// ---------- 初始化 ----------

async function init() {
    // 兜底清理上一次可能残留的注册（正常路径下 plugin-unload 已清过，这里保证幂等）
    dispose();
    disposed = false; // 本实例重新可用
    // 先登记释放：后续任一步失败，窗口关闭时都能干净收尾
    registerUnload();

    await VFS.init();

    // 常驻状态复位（上一次开窗的条目 / 选中 / 搜索词不得残留），并把路径归位到上次激活标签
    FinderState.reset();

    // 1. 布局（侧边栏宽度 / 标签栏显隐）
    FinderLayout.init(finder);

    // 2. 子模块
    FinderSidebar.init({ navigate });
    FinderToolbar.init({ goBack, goForward });
    FinderTabs.init({ tabSwitch: (path) => navigate(path) });
    FinderViews.init({
        entryOpen: (entry) => openEntry(entry),
        contextMenu: (x, y, entry) => FinderContextMenu.showEntry(x, y, entry),
        emptyContextMenu: (x, y) => FinderContextMenu.showEmpty(x, y),
        dropPaths: movePaths,            // F-24：内部拖拽落入文件夹（⌥ 复制）
        rotateImage: rotateImage,        // F-35：画廊旋转落盘
    });
    FinderChrome.init({ navigate });     // F-44：状态栏 + 路径栏
    FinderSearch.init();
    FinderTags.init();
    FinderActions.init({ navigate, refresh, reauth, createFolder });
    FinderContextMenu.init({
        openEntry: (entry) => openEntry(entry),
        refresh,
        createFolder,
        // F-37：fileMenu 动作钩子（打开/预览/重命名/简介/排序）
        hooks: {
            open: (items) => { items.forEach((it) => openEntry(it)); },
            quickLook: (items) => {
                const first = items[0];
                const rendered = FinderViews.getRenderedEntries();
                const idx = rendered.findIndex((en) => en.path === first?.path);
                QuickLook.open(items.map((it) => it.path), Math.max(0, idx)).catch((err) => console.error('[finder] 预览失败：', err));
            },
            rename: (item) => renameEntry(item),
            getInfo: (items) => Deskly().ui.showGetInfo(items),
            sortBy: (field) => FinderState.setSort(field),
            getSort: () => FinderState.getSort(),
        },
    });

    // 3. 授权弹窗按钮
    const onAllow = () => reauth().catch((err) => console.error('[finder] 重新授权失败：', err));
    // 次按钮 = 放弃挂载回到应用内根目录；unmount 只忘掉句柄，磁盘上的东西一个不动
    const onDeny = () => { VFS.decline(); hideAuthModal(); refresh().catch((err) => console.error('[finder] 刷新失败：', err)); };
    authAllow?.addEventListener('click', onAllow);
    authDeny?.addEventListener('click', onDeny);
    track(() => authAllow?.removeEventListener('click', onAllow));
    track(() => authDeny?.removeEventListener('click', onDeny));

    // 5. 菜单栏命令（来自顶栏 Finder 菜单）
    const onFinderCommand = (e) => {
        const { command, args } = e.detail || {};
        const run = async () => {
            switch (command) {
                case 'view-mode':
                    if (args && args.mode) FinderState.setViewMode(args.mode);
                    break;
                case 'navigate':
                    if (args && args.path) await navigate(args.path);
                    break;
                case 'go-to-folder': {
                    const target = await window.__dialog.prompt(i18n.t('finder.goToFolder', '前往文件夹：'), '', { value: '/' });
                    if (target && target.trim()) await navigate(target.trim());
                    break;
                }
                case 'toggle-tab-bar':
                    FinderLayout.toggleTabBar();
                    break;
                case 'toggle-status-bar':
                    FinderSettings.toggle('finder.showStatusBar');
                    break;
                case 'toggle-path-bar':
                    FinderSettings.toggle('finder.showPathBar');
                    break;
                case 'minimize':
                    // 最小化不是关闭：_closeWindow 会走 plugin-unload 把应用整个卸掉。
                    // window.js 在窗口元素上暴露 _toggleMinimizeWindow，缺失时什么也不做。
                    if (typeof finder?._toggleMinimizeWindow === 'function') finder._toggleMinimizeWindow();
                    break;
                case 'new-folder':
                    await createFolder();
                    break;
                case 'get-info':
                    showInfo();
                    break;
            }
        };
        run().catch((err) => console.error('[finder] 菜单命令执行失败：', command, err));
    };
    document.addEventListener('finder-command', onFinderCommand);
    track(() => document.removeEventListener('finder-command', onFinderCommand));

    // 废纸篓内容变化（P0-4：清倒 / 放回 / 从程序坞拖入）时，正在看 /废纸篓 的窗口跟着刷新。
    const onTrashChanged = () => {
        const path = FinderState.getState().currentPath;
        if (OSFS.normalizePath(path || '/') === OSFS.TOP.trash.path) {
            refresh().catch((err) => console.error('[finder] 废纸篓刷新失败：', err));
        }
    };
    document.addEventListener('trash-changed', onTrashChanged);
    track(() => document.removeEventListener('trash-changed', onTrashChanged));

    // F-24：程序坞落点（废纸篓 / 应用图标）以文档级 capture 监听收口（dock.js 本批次冻结）
    registerDockDropTargets();

    // 6. 键盘快捷键
    const onFinderKeydown = (e) => {
        if (!shouldHandleKey(e)) return;

        // ⌘1-4 切换视图模式
        if (e.metaKey && ['1', '2', '3', '4'].includes(e.key)) {
            const modes = { '1': 'icon', '2': 'list', '3': 'column', '4': 'gallery' };
            FinderState.setViewMode(modes[e.key]);
        }
        // ⌘↑ 上一级
        if (e.metaKey && e.key === 'ArrowUp') goUp().catch((err) => console.error('[finder] 返回上级失败：', err));
        // ⌘[ 后退
        if (e.metaKey && e.key === '[') goBack().catch((err) => console.error('[finder] 后退失败：', err));
        // ⌘] 前进
        if (e.metaKey && e.key === ']') goForward().catch((err) => console.error('[finder] 前进失败：', err));
        // ⌘I 显示简介（与桌面共用内核单例面板）
        if (e.metaKey && (e.key === 'I' || e.key === 'i')) {
            e.preventDefault();
            showInfo();
        }
        // ⌘⇧N 新建文件夹
        if (e.metaKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
            e.preventDefault();
            createFolder().catch((err) => console.error('[finder] 新建文件夹失败：', err));
        }
        // Return 打开选中项（多选逐个打开）
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            const sel = [...FinderState.getState().selectedPaths];
            if (sel.length) {
                e.preventDefault();
                const rendered = FinderViews.getRenderedEntries();
                sel.forEach((p) => {
                    const entry = rendered.find((en) => en.path === p);
                    if (entry) openEntry(entry);
                });
            }
        }
        // ⌥⌘I / ⌥Return 不区分：重命名走右键同一实现（保真清单 F-26：Option+Command+I）
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.altKey) {
            e.preventDefault();
            const sel = [...FinderState.getState().selectedPaths];
            if (sel.length === 1) {
                const entry = FinderViews.getRenderedEntries().find((en) => en.path === sel[0]);
                if (entry) renameEntry({ path: entry.path, name: entry.name });
            }
        }
        // ⌫ / Delete 移入废纸篓（⌘⌫ 同效；⌘⇧⌫ 清倒由菜单栏负责）
        if ((e.key === 'Backspace' || e.key === 'Delete') && !(e.metaKey && e.shiftKey)) {
            const sel = [...FinderState.getState().selectedPaths];
            if (sel.length) {
                e.preventDefault();
                trashSelection(sel).catch((err) => console.error('[finder] 移入废纸篓失败：', err));
            }
        }
        // ⌘A 全选（渲染中的可见条目）
        if (e.metaKey && (e.key === 'A' || e.key === 'a')) {
            e.preventDefault();
            FinderState.selectAll(FinderViews.getRenderedEntries().map((en) => en.path));
        }
        // Escape 清空选中（搜索框内 Esc 由输入框自己收起）
        if (e.key === 'Escape') {
            if (FinderState.getState().selectedPaths.size) {
                e.preventDefault();
                FinderState.clearSelection();
            }
        }
        // ⌘. 显示/隐藏 隐藏文件（F-39/F-42；finder-settings 持久化）
        if (e.metaKey && e.key === '.') {
            e.preventDefault();
            FinderSettings.toggle('finder.showHidden');
            FinderState.emit('entries-changed');
        }
        // ⌘J 查看选项：画廊文件名开关（F-26/F-35 原版点名）
        if (e.metaKey && (e.key === 'J' || e.key === 'j')) {
            e.preventDefault();
            FinderState.setGalleryNames(!FinderState.getGalleryNames());
            FinderState.emit('view-changed', FinderState.getViewMode());
        }
        // ⌘C / ⌘X 拷贝 / 剪切（内部剪贴板）
        if (e.metaKey && (e.key === 'C' || e.key === 'c') && !e.shiftKey) {
            const sel = [...FinderState.getState().selectedPaths];
            if (sel.length) clipboard = { op: 'copy', paths: sel };
        }
        if (e.metaKey && (e.key === 'X' || e.key === 'x')) {
            const sel = [...FinderState.getState().selectedPaths];
            if (sel.length) clipboard = { op: 'cut', paths: sel };
        }
        // ⌘V 粘贴到当前文件夹（剪切 = 移动可撤销；拷贝 = 复制）
        if (e.metaKey && (e.key === 'V' || e.key === 'v')) {
            if (clipboard && clipboard.paths.length) {
                e.preventDefault();
                const target = FinderState.getState().currentPath;
                const paths = clipboard.paths.filter((p) => OSFS.normalizePath(OSFS.parentOf(p)) !== OSFS.normalizePath(target));
                if (paths.length) {
                    movePaths(paths, target, clipboard.op === 'copy')
                        .then(() => { if (clipboard && clipboard.op === 'cut') clipboard = null; })
                        .catch((err) => console.error('[finder] 粘贴失败：', err));
                }
            }
        }
        // ⌘T 同目录新标签页
        if (e.metaKey && (e.key === 'T' || e.key === 't') && !e.shiftKey) {
            e.preventDefault();
            const cur = FinderState.getState().currentPath;
            const id = FinderState.addTab(cur);
            FinderState.setActiveTab(id);
            navigate(cur).catch((err) => console.error('[finder] 新建标签页失败：', err));
        }
        // ⌘W 关闭当前标签（只剩一个标签时不关窗，避免误触丢会话）
        if (e.metaKey && (e.key === 'W' || e.key === 'w') && !e.shiftKey) {
            const s = FinderState.getState();
            if (s.tabs.length > 1 && s.activeTabId) {
                e.preventDefault();
                const next = FinderState.closeTab(s.activeTabId);
                if (next) navigate(next.path).catch((err) => console.error('[finder] 关闭标签页失败：', err));
            }
        }
        // ⌘⇧T 重开上一次关闭的标签
        if (e.metaKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
            e.preventDefault();
            FinderTabs.reopenTab();
        }
        // ⌃Tab 循环切换标签（Shift 反向）
        if (e.ctrlKey && e.key === 'Tab') {
            e.preventDefault();
            FinderTabs.cycleTab(e.shiftKey ? -1 : 1);
        }
        // ↑/↓ 移动选中（画廊视图切换画廊项）
        if (e.key === 'ArrowDown' && !e.metaKey) {
            e.preventDefault();
            moveSelection(1);
        }
        if (e.key === 'ArrowUp' && !e.metaKey) {
            e.preventDefault();
            moveSelection(-1);
        }
        // 空格 预览当前选中项（Quick Look 开着时由内核单例接管空格关闭）
        if (e.key === ' ' && !QuickLook.isOpen()) {
            const sel = [...FinderState.getState().selectedPaths];
            if (sel.length) {
                const entry = FinderViews.getRenderedEntries().find(en => en.path === sel[0]);
                if (entry) {
                    e.preventDefault();
                    openQuickLook(entry, FinderViews.indexOfPath(entry.path)).catch((err) => console.error('[finder] 预览失败：', err));
                }
            }
        }
    };
    document.addEventListener('keydown', onFinderKeydown);
    track(() => document.removeEventListener('keydown', onFinderKeydown));

    // 7. 语言切换：JS 渲染的文案（标题 / 标签名 / 空状态 / 标签页）重新翻译
    const onLanguageChange = () => {
        FinderState.emit('locale-changed');
        FinderToolbar.sync();
    };
    window.addEventListener('languagechange', onLanguageChange);
    track(() => window.removeEventListener('languagechange', onLanguageChange));

    // 8. 初始授权弹窗：只有「挂载了却读不了」才值得打扰用户，没挂载时应用内根目录本来就够用
    const status = VFS.getAuthStatus();
    if (status.needsReauth) {
        showAuthModal(status);
    }

    // 9. 初始渲染：落在恢复出来的激活标签路径上，而不是一律回到根目录
    await render(FinderState.getState().currentPath);
    FinderToolbar.sync();
}

/**
 * 本访达窗口是否应当接收这次按键。
 * window.js 从不写 inline display（最小化走 .minimized 类 + opacity），
 * 旧的 `style.display !== 'none'` 判断恒为真，会让快捷键作用在已最小化或后台的访达上
 * （⌘⇧N 甚至会给一个看不见的窗口弹出命名框）。
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function shouldHandleKey(e) {
    if (!finder || !finder.isConnected) return false;
    if (finder.classList.contains('minimized')) return false;
    const style = window.getComputedStyle(finder);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (isTyping(e)) return false;
    // 焦点在其它窗口里时不抢按键（body 视为「无聚焦控件」，仍由访达接收）
    const t = e.target;
    if (t && t !== document.body && !finder.contains(t)) return false;
    return isFrontmost(finder);
}

/**
 * 是否为当前最前层的窗口（与 window.js 一致，按计算后的 z-index 比较）。
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isFrontmost(el) {
    const z = parseInt(window.getComputedStyle(el).zIndex, 10) || 0;
    return !Array.from(document.querySelectorAll('.window')).some((w) => {
        if (w === el || w.classList.contains('closing') || w.classList.contains('minimized')) return false;
        const wz = parseInt(window.getComputedStyle(w).zIndex, 10) || 0;
        if (wz > z) return true;
        // z-index 相同时以 DOM 顺序判先后（后插入者在上方）
        return wz === z && !!(w.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
    });
}

/** 判断事件目标是否处于输入控件（避免空格/快捷键误触发）。 */
function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * 资源释放：窗口关闭时由 plugin-manager 派发 plugin-unload，
 * 移除本实例与本脚本注册的全局监听，避免常驻内存与重复绑定累积。
 */
function registerUnload() {
    const onFinderUnload = (e) => {
        if (e.detail.id !== 'finder') return;
        dispose();
    };
    window.addEventListener('plugin-unload', onFinderUnload);
    track(() => window.removeEventListener('plugin-unload', onFinderUnload));
}

/** 初始化整体失败时的兜底：窗口不能停在无声空白。 */
function showFatalError(err) {
    console.error('[finder] 访达初始化失败：', err);
    const msg = i18n.t('finder.initError', '访达启动失败，请关闭窗口后重试');
    const emptyEl = document.getElementById('finder-empty');
    const textEl = document.getElementById('finder-empty-text');
    const body = document.getElementById('list-body');
    if (textEl) textEl.textContent = msg;
    if (emptyEl) emptyEl.hidden = false;
    if (body) body.innerHTML = '';
    // 空状态浮层可能被侧边栏/滚动区挡在视线外，系统弹窗（若核心层已挂载）保证失败一定可见
    if (window.__dialog) window.__dialog.error(i18n.t('finder.title', '访达'), msg);
}

init().catch(showFatalError);
