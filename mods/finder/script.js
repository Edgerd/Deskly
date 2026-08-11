/**
 * script.js — 访达（Finder）插件入口（macOS 15 还原）
 *
 * 编排各子模块初始化、VFS 渲染调度、打开/预览、授权弹窗与菜单命令。
 * 作为冷加载入口（type="module"），由 plugin-manager 注入。
 */

import { VFS } from '../../src/javascripts/vfs.js';
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
import { FinderVfsWrite } from './finder-vfs-write.js';

// ---------- DOM 引用 ----------
const finder = document.querySelector('.finder.window');
const authModal = document.getElementById('auth-modal');
const authNote = document.getElementById('auth-note');
const authAllow = document.getElementById('auth-allow');
const authDeny = document.getElementById('auth-deny');

// 图片 / 文本扩展名
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];
const TEXT_EXTS = ['txt', 'md', 'json', 'js', 'css', 'html', 'htm', 'xml', 'log', 'ini', 'yaml', 'yml', 'csv', 'py', 'ts'];
const UNSUPPORTED_PREVIEW = '<div class="ql-unsupported">暂不支持预览该类型文件</div>';

/**
 * 渲染当前路径。
 * @param {string} path
 */
async function render(path) {
    FinderState.setCurrentPath(path);
    // 注入虚拟文件夹（localStorage 持久化的新建文件夹）
    const entries = FinderVfsWrite.mergeFolders(path, await VFS.list(path));
    FinderState.setEntries(entries);

    // 同步当前标签页标题与路径
    const label = (path === '/' || !path) ? '访达' : path.split('/').filter(Boolean).pop();
    FinderTabs.setCurrentTabPath(path, label);
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

/** 在当前目录新建虚拟文件夹（弹窗命名后写入虚拟写层并刷新）。 */
async function createFolder() {
    const name = window.prompt('新建文件夹名称：', '未命名文件夹');
    if (name && name.trim()) {
        FinderVfsWrite.addFolder(FinderState.getState().currentPath, name.trim());
        await refresh();
    }
}

// ---------- 打开条目 ----------

/**
 * 打开条目：文件夹导航、书签打开、其余走 Quick Look 预览。
 * @param {object} entry
 */
async function openEntry(entry) {
    if (entry.type === 'folder') {
        navigate(entry.path);
        return;
    }
    if (entry.type === 'bookmark') {
        if (entry.url) window.open(entry.url, '_blank');
        return;
    }
    await openQuickLook(entry);
}

/**
 * Quick Look 打开条目（图片 / 文本 / 不支持类型）。
 * @param {object} entry
 * @param {number} [index]
 * @param {Array} [allItems]
 */
async function openQuickLook(entry, index, allItems) {
    const ext = getExt(entry.name);
    let content = '';

    if (IMG_EXTS.includes(ext)) {
        const file = await VFS.readFile(entry.path);
        content = file ? `<img src="${URL.createObjectURL(file)}" alt="${entry.name}" />` : UNSUPPORTED_PREVIEW;
    } else if (TEXT_EXTS.includes(ext)) {
        const file = await VFS.readFile(entry.path);
        content = file ? `<pre>${escapeHtml((await file.text()).slice(0, 50000))}</pre>` : UNSUPPORTED_PREVIEW;
    } else {
        content = UNSUPPORTED_PREVIEW;
    }

    FinderQuickLook.show({
        name: entry.name,
        content,
        allItems: allItems || FinderState.getState().entries,
        index: index ?? 0,
    });
}

/** 转义 HTML 特殊字符。 */
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 提取扩展名。 */
function getExt(name) {
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

// ---------- 授权弹窗 ----------

/** 显示授权弹窗。 */
function showAuthModal(status) {
    if (!authModal) return;
    authNote && (authNote.textContent = status.supported ? '' : '当前浏览器不支持访问真实文件夹，仅显示虚拟文件夹。');
    if (authAllow) authAllow.style.display = status.supported ? '' : 'none';
    authModal.hidden = false;
}

/** 隐藏授权弹窗。 */
function hideAuthModal() {
    if (authModal) authModal.hidden = true;
}

/** 重新授权（更多菜单 / 授权弹窗「好」）。 */
async function reauth() {
    if (!VFS.isSupported?.()) {
        authNote && (authNote.textContent = '当前浏览器不支持真实文件夹访问，请使用 Chrome/Edge 并在 HTTPS 或 localhost 环境运行。');
        return;
    }
    try { await VFS.authorize(); hideAuthModal(); } catch (e) { /* 用户取消：保持现状 */ }
    await refresh();
}

// ---------- 初始化 ----------

async function init() {
    await VFS.init();

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
    FinderActions.init({ navigate, refresh, reauth });
    FinderContextMenu.init({
        createContextMenu,
        openEntry: (entry) => openEntry(entry),
        refresh,
    });

    // 3. Quick Look 导航事件（上/下一项）
    const onQuicklookNavigate = async (e) => {
        const { item, index, items } = e.detail;
        await openQuickLook(item, index, items);
    };
    document.addEventListener('quicklook-navigate', onQuicklookNavigate);

    // 4. 授权弹窗按钮
    if (authAllow) authAllow.addEventListener('click', () => reauth());
    if (authDeny) authDeny.addEventListener('click', () => { VFS.decline?.(); hideAuthModal(); refresh(); });

    // 5. 菜单栏命令（来自顶栏 Finder 菜单）
    const onFinderCommand = async (e) => {
        const { command, args } = e.detail || {};
        switch (command) {
            case 'view-mode':
                if (args && args.mode) FinderState.setViewMode(args.mode);
                break;
            case 'navigate':
                if (args && args.path) await navigate(args.path);
                break;
            case 'go-to-folder': {
                const target = window.prompt('前往文件夹：', '/');
                if (target && target.trim()) await navigate(target.trim());
                break;
            }
            // 注：toggle-path-bar / toggle-status-bar 已下线（路径栏 / 状态栏自 0.2.22 起移除），
            // 但保留 switch 分支兼容旧菜单命令（FinderLayout 内的方法为 no-op）。
            case 'toggle-path-bar':
                FinderLayout.togglePathBar();
                break;
            case 'toggle-status-bar':
                FinderLayout.toggleStatusBar();
                break;
            case 'toggle-tab-bar':
                FinderLayout.toggleTabBar();
                break;
            case 'minimize':
                if (finder && finder._closeWindow) finder._closeWindow();
                break;
            case 'new-folder': {
                await createFolder();
                break;
            }
        }
    };
    document.addEventListener('finder-command', onFinderCommand);

    // 6. 键盘快捷键
    const onFinderKeydown = (e) => {
        const finderVisible = finder && finder.style.display !== 'none';
        if (!finderVisible) return;

        // ⌘1-4 切换视图模式
        if (e.metaKey && ['1', '2', '3', '4'].includes(e.key)) {
            const modes = { '1': 'icon', '2': 'list', '3': 'column', '4': 'gallery' };
            FinderState.setViewMode(modes[e.key]);
        }
        // ⌘↑ 上一级
        if (e.metaKey && e.key === 'ArrowUp') goUp();
        // ⌘[ 后退
        if (e.metaKey && e.key === '[') goBack();
        // ⌘] 前进
        if (e.metaKey && e.key === ']') goForward();
        // ⌘⇧N 新建文件夹（虚拟写层）
        if (e.metaKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
            e.preventDefault();
            createFolder();
        }
        // 空格 预览当前选中项
        if (e.key === ' ' && !isTyping(e)) {
            const sel = [...FinderState.getState().selectedPaths];
            if (sel.length) {
                const entry = FinderState.getState().entries.find(en => en.path === sel[0]);
                if (entry) { e.preventDefault(); openQuickLook(entry); }
            }
        }
    };
    document.addEventListener('keydown', onFinderKeydown);

    // 资源释放：窗口关闭时由 plugin-manager 派发 plugin-unload，
    // 移除本实例注册的全局监听，避免常驻内存与重复绑定累积。
    const onFinderUnload = (e) => {
        if (e.detail.id !== 'finder') return;
        window.removeEventListener('plugin-unload', onFinderUnload);
        document.removeEventListener('quicklook-navigate', onQuicklookNavigate);
        document.removeEventListener('finder-command', onFinderCommand);
        document.removeEventListener('keydown', onFinderKeydown);
    };
    window.addEventListener('plugin-unload', onFinderUnload);

    // 7. 初始授权弹窗（pending 且浏览器支持）
    const status = VFS.getAuthStatus();
    if (status.status === 'pending' && status.supported) {
        showAuthModal(status);
    }

    // 8. 初始渲染
    await render('/');
    FinderToolbar.sync();
}

/** 判断事件目标是否处于输入控件（避免空格/快捷键误触发）。 */
function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

// 启动
init();
