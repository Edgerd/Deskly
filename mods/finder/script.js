/**
 * script.js — 访达（Finder）插件入口（macOS 15 还原）
 *
 * 编排各子模块初始化、VFS 渲染调度、打开/预览、授权弹窗与菜单命令。
 * 作为冷加载入口（type="module"），由 plugin-manager 注入并在每次开窗重新执行；
 * 子模块是常驻单例，因此本入口负责：init 起始调用 FinderState.reset()，
 * 窗口关闭（plugin-unload）时逐个调用子模块的 dispose()。
 */

import { VFS } from '../../src/javascripts/vfs.js';
import { OSFS } from '../../src/javascripts/osfs.js';
import { getAppByExtension, openApp } from '../../src/javascripts/plugin-manager.js';
import { i18n } from '../../src/javascripts/i18n.js';
import { createContextMenu } from '../../src/javascripts/ui/contextMenu.js';
import { FinderState } from './finder-state.js';
import { FinderLayout } from './finder-layout.js';
import { FinderSidebar } from './finder-sidebar.js';
import { FinderToolbar } from './finder-toolbar.js';
import { FinderTabs } from './finder-tabs.js';
import { FinderViews } from './finder-views.js';
import { FinderSearch } from './finder-search.js';
import { FinderQuickLook } from './finder-quicklook.js';
import { FinderTags } from './finder-tags.js';
import { FinderActions } from './finder-actions.js';
import { FinderContextMenu } from './finder-contextmenu.js';

// ---------- DOM 引用 ----------
const finder = document.querySelector('.finder.window');
const authModal = document.getElementById('auth-modal');
const authNote = document.getElementById('auth-note');
const authAllow = document.getElementById('auth-allow');
const authDeny = document.getElementById('auth-deny');

// 需要常驻释放的子模块（dispose 由各模块自身实现，入口只做统一编排）
const SUBMODULES = [FinderLayout, FinderSidebar, FinderToolbar, FinderTabs, FinderViews, FinderSearch, FinderQuickLook, FinderTags, FinderActions];

// 图片 / 文本扩展名
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];
const TEXT_EXTS = ['txt', 'md', 'json', 'js', 'css', 'html', 'htm', 'xml', 'log', 'ini', 'yaml', 'yml', 'csv', 'py', 'ts'];

/** 渲染请求序号：只允许最后一次请求落地，慢目录不得覆盖新目录 */
let renderSeq = 0;
/** Quick Look 请求序号：晚到的预览结果直接丢弃并回收其对象 URL */
let qlSeq = 0;

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
    qlSeq++;
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
        const entries = await VFS.list(path);
        if (disposed || seq !== renderSeq) return;
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

// ---------- 打开条目 ----------

/**
 * 打开条目：文件夹导航、书签打开、声明了 `apps[].formats` 的应用接管，其余走 Quick Look。
 * @param {object} entry
 * @param {number} [index] 条目在渲染序列中的序号
 */
async function openEntry(entry, index) {
    if (entry.type === 'folder') {
        navigate(entry.path).catch((err) => console.error('[finder] 打开文件夹失败：', entry.path, err));
        return;
    }
    if (entry.type === 'bookmark') {
        if (entry.url) window.open(entry.url, '_blank');
        return;
    }
    // 按扩展名问路：清单里声明了能打开该格式的应用就交给它，并把 VFS 路径带过去。
    // 只认应用级 formats（不是插件级那个纯文档字段），且插件必须实现 plugin-app-open；
    // 没装对应插件时 getAppByExtension 返回 undefined，行为完全退回原来的 Quick Look。
    const rec = getAppByExtension(getExt(entry.name));
    if (rec) {
        openApp(rec.appId, { file: entry.path }).catch((err) => {
            console.warn('[finder] 交给应用打开失败，回退预览：', entry.path, err);
            return openQuickLook(entry, index);
        });
        return;
    }
    await openQuickLook(entry, index);
}

/**
 * Quick Look 打开条目（图片 / 文本 / 不支持类型）。
 * @param {object} entry
 * @param {number} [index] 条目在「渲染后列表」中的序号（决定计数与上下翻页）
 */
async function openQuickLook(entry, index) {
    const seq = ++qlSeq;
    const ext = getExt(entry.name);
    // 用渲染后的列表（已过滤 + 已排序）而不是原始 entries，否则「1 / N」与 ←/→ 都对不上
    const rendered = FinderViews.getRenderedEntries();
    const allItems = rendered.length ? rendered : FinderState.getState().entries;
    const found = FinderViews.indexOfPath(entry.path);
    const idx = Number.isInteger(index) && index >= 0 ? index : (found >= 0 ? found : 0);

    let content = '';
    let objectUrl = null;

    if (IMG_EXTS.includes(ext)) {
        const file = await readFileSafe(entry.path);
        if (file) {
            objectUrl = URL.createObjectURL(file);
            content = `<img src="${escapeHtml(objectUrl)}" alt="${escapeHtml(entry.name)}" />`;
        }
    } else if (TEXT_EXTS.includes(ext)) {
        const file = await readFileSafe(entry.path);
        if (file) content = `<pre>${escapeHtml(await readTextSafe(file))}</pre>`;
    }

    // 预览期间又发起了新的请求：本次结果作废，且不能让刚创建的对象 URL 没人回收
    if (seq !== qlSeq) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
    }

    FinderQuickLook.show({
        name: entry.name,
        content,
        objectUrl,
        allItems,
        index: idx,
    });
}

/** 读取文件，失败（无权限 / 已删除）时返回 null 而不是抛出。 */
async function readFileSafe(path) {
    try {
        return await VFS.readFile(path);
    } catch (err) {
        console.warn('[finder] 文件读取失败：', path, err);
        return null;
    }
}

/** 读取文本内容（截断 50000 字符），失败时返回空串。 */
async function readTextSafe(file) {
    try {
        return (await file.text()).slice(0, 50000);
    } catch (err) {
        console.warn('[finder] 文本解码失败：', err);
        return '';
    }
}

/** 转义 HTML 特殊字符（含引号，值会被拼进属性）。 */
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 提取扩展名（idx > 0：'.gitignore' 这类隐藏文件没有扩展名）。 */
function getExt(name) {
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
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
    });
    FinderSearch.init();
    FinderQuickLook.init();
    FinderTags.init();
    FinderActions.init({ navigate, refresh, reauth, createFolder });
    FinderContextMenu.init({
        createContextMenu,
        openEntry: (entry) => openEntry(entry),
        refresh,
        createFolder,
    });

    // 3. Quick Look 导航事件（上/下一项）
    const onQuicklookNavigate = (e) => {
        const { item, index } = e.detail;
        openQuickLook(item, index).catch((err) => console.error('[finder] Quick Look 预览失败：', err));
    };
    document.addEventListener('quicklook-navigate', onQuicklookNavigate);
    track(() => document.removeEventListener('quicklook-navigate', onQuicklookNavigate));

    // 4. 授权弹窗按钮
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
                case 'minimize':
                    // 最小化不是关闭：_closeWindow 会走 plugin-unload 把应用整个卸掉。
                    // window.js 在窗口元素上暴露 _toggleMinimizeWindow，缺失时什么也不做。
                    if (typeof finder?._toggleMinimizeWindow === 'function') finder._toggleMinimizeWindow();
                    break;
                case 'new-folder':
                    await createFolder();
                    break;
            }
        };
        run().catch((err) => console.error('[finder] 菜单命令执行失败：', command, err));
    };
    document.addEventListener('finder-command', onFinderCommand);
    track(() => document.removeEventListener('finder-command', onFinderCommand));

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
        // ⌘⇧N 新建文件夹
        if (e.metaKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
            e.preventDefault();
            createFolder().catch((err) => console.error('[finder] 新建文件夹失败：', err));
        }
        // 空格 预览当前选中项（已打开时不重复打开）
        if (e.key === ' ' && !FinderQuickLook.isOpen()) {
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

// 启动
init().catch(showFatalError);
