/**
 * script.js — 记事本入口（ES module）
 * 装配 store / 三类编辑器 / 侧边栏 / 标签 / 工具栏 / 查找替换 / 快捷键 / 持久化。
 *
 * plugin-manager 每次打开都重新注入本文件（core/*、features/* 仍是同一实例），
 * 所以启动第一件事必须是复位单例：store.clearSubscribers() + store.reset()，
 * 并把 DOM 的 data-view/data-format 与 store 对齐。
 */

import { store, SAVE_STATE } from './core/store.js';
import { createWysiwygEditor } from './core/editor-wysiwyg.js';
import { createSourceEditor } from './core/editor-source.js';
import { createSplitView } from './core/editor-split.js';
import { initSidebar } from './core/sidebar.js';
import { initTabs } from './core/tabs.js';
import { createSearch } from './core/search.js';
import { registerShortcuts } from './core/shortcuts.js';
import { alertBox, errorBox, confirmBox } from './core/dialog.js';
import * as storage from './core/storage.js';
import { initFormatToolbar } from './features/toolbar-format.js';
import { initViewSwitch } from './features/toolbar-view.js';
import { i18n } from '../../src/javascripts/i18n.js';
import { openPopover } from '../../src/javascripts/ui/popover.js';

const notepadWindow = document.querySelector('.notepad');

function t(key, fallback) {
    return i18n.t('notepad.' + key, fallback); // i18n-dynamic-ok: 前缀包装器，键恒以 notepad. 开头且调用点全为字面量
}

/** 字数按码点统计：Array.from 不会把 emoji 之类的代理对算成两个 */
function countChars(text) {
    return Array.from(text || '').length;
}

function countLines(text) {
    return (text || '').split('\n').length || 1;
}

if (notepadWindow) init(notepadWindow);

function init(root) {
    // ── 单例复位：上一次打开的订阅者还引用着已脱离文档的 DOM ──
    store.clearSubscribers();
    store.reset();

    const disposers = [];
    const on = (target, type, handler, opts) => {
        target.addEventListener(type, handler, opts);
        disposers.push(() => target.removeEventListener(type, handler, opts));
    };

    // ── DOM 引用 ──
    const wysiwygEl = root.querySelector('.editor-wysiwyg:not(.split-preview)');
    const sourceTextarea = root.querySelector('.editor-source');
    const sourceLineNumbers = root.querySelector('.editor-source-wrap .line-numbers');
    const splitSourceTextarea = root.querySelector('.editor-source-split');
    const splitLineNumbers = root.querySelector('.editor-split .split-source-pane .line-numbers');
    const splitPreview = root.querySelector('.split-preview');

    const fileInfo = root.querySelector('.file-info');
    const fileNameEl = root.querySelector('.file-name');
    const lineCount = root.querySelector('.line-count');
    const wordCount = root.querySelector('.word-count');
    const cursorInfo = root.querySelector('.cursor-info');
    const encodingEl = root.querySelector('.encoding');
    const formatBadge = root.querySelector('.format-badge');
    const saveStateEl = root.querySelector('.save-state');

    applyI18n(root);

    // ── 编辑器实例（源码/分屏冷加载：只在首次进入对应视图时创建）──
    const wysiwyg = createWysiwygEditor(wysiwygEl, { store, onCursor: updateCursor });
    let sourceEditor = null;
    let splitView = null;

    function ensureSourceEditor() {
        if (!sourceEditor) {
            sourceEditor = createSourceEditor(sourceTextarea, sourceLineNumbers, { store, onCursor: updateCursor });
        }
        return sourceEditor;
    }

    function ensureSplitView() {
        if (!splitView) {
            splitView = createSplitView({
                root,
                textarea: splitSourceTextarea,
                lineNumbers: splitLineNumbers,
                preview: splitPreview,
                store,
                onCursor: updateCursor,
            });
        }
        return splitView;
    }

    /** 把当前视图的编辑内容刷进 store（未渲染过的编辑器不能反向覆盖笔记） */
    function flushActive() {
        if (store.view === 'wysiwyg') { if (wysiwyg.isRendered()) wysiwyg.flush(); }
        else if (store.view === 'source') { if (sourceEditor) sourceEditor.flush(); }
        else if (store.view === 'split') { if (splitView) splitView.flush(); }
    }

    /** 渲染当前视图（只渲染活动视图，隐藏视图留着过期快照也没关系，切回时会重建） */
    function renderActiveView({ focus = false } = {}) {
        root.dataset.view = store.view;
        root.dataset.format = store.format;
        root.dataset.md = store.markdown ? 'on' : 'off';
        if (store.view === 'wysiwyg') {
            wysiwyg.render();
            if (focus) wysiwyg.focus();
        } else if (store.view === 'source') {
            ensureSourceEditor().render();
            if (focus) sourceTextarea.focus();
        } else {
            ensureSplitView().render();
            if (focus) splitSourceTextarea.focus();
        }
        updateStatus();
    }

    // ── 视图切换 ──
    function switchView(view) {
        if (store.view === view) return;
        flushActive();
        store.setView(view);
        renderActiveView({ focus: true });
    }

    // ── 状态栏：唯一写入者 ──
    function updateStatus() {
        const text = store.content;
        lineCount.textContent = `${t('lines', '行数')} ${countLines(text)}`;
        wordCount.textContent = `${t('words', '字数')} ${countChars(text)}`;
        updateFileName();
        updateEncoding();
        updateSaveState();
    }

    function updateCursor({ line, col }) {
        if (line === undefined || col === undefined) return;
        cursorInfo.textContent = `${t('cursorLine', '行')} ${line}, ${t('cursorCol', '列')} ${col}`;
    }

    function updateFileName() {
        const name = store.title;
        const ext = store.format === 'md' ? 'md' : 'txt';
        fileInfo.textContent = `${name}.${ext}`;
        fileNameEl.textContent = name;
        fileNameEl.title = name;
        formatBadge.textContent = store.format.toUpperCase();
    }

    function updateEncoding() {
        encodingEl.textContent = store.encoding;
    }

    const SAVE_STATE_TEXT = {
        [SAVE_STATE.SAVED]: () => t('saved', '已保存'),
        [SAVE_STATE.UNSAVED]: () => t('unsaved', '未保存'),
        [SAVE_STATE.SAVING]: () => t('saving', '保存中'),
        [SAVE_STATE.ERROR]: () => t('saveFailed', '保存失败'),
    };

    function updateSaveState() {
        const label = SAVE_STATE_TEXT[store.saveState] || SAVE_STATE_TEXT[SAVE_STATE.UNSAVED];
        saveStateEl.textContent = label();
        saveStateEl.dataset.state = store.saveState;
    }

    // ── 笔记 / 标签操作 ──
    function selectNote(id) {
        if (id === store.currentId) return;
        flushActive();
        store.selectNote(id);
        renderActiveView({ focus: true });
    }

    function newNote() {
        flushActive();
        store.addNote();
        renderActiveView({ focus: true });
    }

    function closeTab(id) {
        flushActive();
        const note = store.notes.find((n) => n.id === id);
        if (note && note.dirty && !note.path) {
            confirmDiscard(note).then((ok) => {
                if (!ok) return;
                flushActive();
                store.closeTab(id);
                renderActiveView({ focus: true });
            });
            return;
        }
        store.closeTab(id);
        renderActiveView({ focus: true });
    }

    function confirmDiscard(note) {
        return confirmBox(
            t('closeTab', '关闭标签'),
            t('discardConfirm', '「{title}」尚未保存，确定关闭？').replace('{title}', note.title),
        )
            .then((ok) => !!ok)
            .catch((err) => {
                console.warn('[notepad] 关闭确认失败：', err);
                return true;
            });
    }

    function deleteNote(id) {
        const note = store.notes.find((n) => n.id === id);
        flushActive();
        store.removeNote(id);
        if (note && note.path) {
            alertBox(t('noteRemoved', '已从记事本移除'), t('fileKept', '磁盘上的文件仍需手动删除：') + note.path);
        }
        renderActiveView();
    }

    function clearContent() {
        flushActive();
        store.setContent('');
        renderActiveView({ focus: true });
    }

    // ── 保存 / 下载 / 打开 ──
    /** 挂载的真实文件夹权限过期：给一个「重新授权」的手势入口，而不是让笔记空白、反复报错。 */
    function reauthNotice(onDone) {
        const d = window.__dialog;
        if (!d || typeof d.messageBox !== 'function') {
            if (onDone) onDone(false);
            return Promise.resolve();
        }
        return d.messageBox({
            title: t('reauthTitle', '需要重新授权'),
            message: t('reauthMessage', '根目录的访问权限已过期，笔记暂时无法读取。磁盘上的内容没有改动。重新授权后即可继续。'),
            dismissValue: null,
            buttons: [
                { label: t('reauthAction', '重新授权'), value: 'reauth', style: 'primary' },
                { label: i18n.t('common.cancel', '取消'), value: null, style: 'secondary' },
            ],
        }).then((choice) => {
            if (choice !== 'reauth') return onDone && onDone(false);
            storage.osfsReauth()
                .then(() => storage.rehydrateFromVfs(store).catch(() => {}))
                .then(() => onDone && onDone(true))
                .catch((err) => {
                    console.warn('[notepad] 重新授权失败：', err);
                    onDone && onDone(false);
                });
        });
    }

    function saveFile() {
        flushActive();
        const note = store.current;
        if (!note) return;
        store.markSaving();
        Promise.resolve()
            .then(() => storage.saveNote(note))
            .then((path) => {
                // await 期间用户可能切了标签/笔记：markSaved 作用于「当前笔记」，直接调用会把
                // 没写盘的当前笔记误标成已保存、并挂上别人的 path，其未保存改动就此静默丢失。
                if (store.current === note) {
                    store.markSaved(path);
                } else {
                    note.dirty = false;
                    note.path = path;
                    store.emit('notes-changed', store.notes);
                }
                storage.mirrorDraft(store.snapshot());
            })
            .catch((err) => {
                console.warn('[notepad] 保存失败：', err);
                if (store.current === note) store.markSaveError();
                if (err && err.name === 'NeedsReauthError') return reauthNotice(() => saveFile());
                errorBox(t('saveFailed', '保存失败'), err && err.message ? err.message : String(err));
            });
    }

    function downloadFile() {
        flushActive();
        const note = store.current;
        if (!note) return;
        const ext = store.format === 'md' ? 'md' : 'txt';
        const name = storage.safeFileName(note.title, ext);
        const url = URL.createObjectURL(new Blob([note.content], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        // 立即 revoke 会取消下载，交给下一轮事件循环
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function openFile() {
        flushActive();
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.md,.markdown,.json,.js,.css,.html';
        input.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';      // 同一文件再次选择也要能触发
            if (!file) return;
            storage.readTextFile(file)
                .then(({ text, encoding, guessed }) => {
                    const isMd = /\.(md|markdown)$/i.test(file.name);
                    const format = isMd ? 'md' : 'txt';
                    // 先建笔记再同步格式，避免改写上一条笔记
                    store.addNote({
                        title: file.name.replace(/\.(md|txt|markdown|json|js|css|html)$/i, ''),
                        content: text,
                        format,
                        encoding,
                    });
                    renderActiveView({ focus: true });
                    if (guessed) {
                        alertBox(t('openedWithGuess', '已按推断编码打开'), `${file.name} → ${encoding}`);
                    }
                    return undefined;
                })
                .catch((err) => {
                    console.warn('[notepad] 打开文件失败：', err);
                    errorBox(t('openFailed', '打开文件失败'), err && err.message ? err.message : String(err));
                });
        });
        input.click();
    }

    // ── 模块装配 ──
    const sidebar = initSidebar(root.querySelector('.sidebar'), { store, onSelect: selectNote, onDelete: deleteNote });
    const tabs = initTabs(root, { store, onSelect: selectNote, onClose: closeTab, onNew: newNote });
    const viewSwitch = initViewSwitch(root, { store, onViewChange: switchView });
    const formatToolbar = initFormatToolbar(root, { store, wysiwyg, switchView });

    const search = createSearch(root, {
        store,
        resolveTarget: () => {
            if (store.view === 'wysiwyg') return { kind: 'dom', el: wysiwygEl, editor: wysiwyg };
            if (store.view === 'source') return { kind: 'textarea', el: sourceTextarea, afterChange: () => { ensureSourceEditor().updateLineNumbers(); ensureSourceEditor().flush(); } };
            return { kind: 'textarea', el: splitSourceTextarea, afterChange: () => { ensureSplitView().flush(); } };
        },
    });

    // ── 下拉菜单 ──
    const menu = initMenu();

    // ── 快捷键 ──
    const shortcuts = registerShortcuts(root, buildBindings());
    disposers.push(shortcuts.dispose);

    function buildBindings() {
        const inWysiwyg = () => store.view === 'wysiwyg';
        const notTypingInPanel = (e) => {
            const el = e.target;
            if (!el || !el.classList) return true;
            return !el.closest('.search-bar');
        };
        return {
            'mod+n': { run: newNote },
            'mod+shift+o': { run: openFile },
            'mod+shift+s': { run: downloadFile },                    // ⇧⌘S 下载
            'mod+s': { run: saveFile },                              // ⌘S 保存到根目录「文档」
            'mod+f': { run: () => search.toggle() },
            'mod+shift+1': { run: () => formatAction(() => wysiwyg.heading(1)), when: inWysiwyg },
            'mod+shift+2': { run: () => formatAction(() => wysiwyg.heading(2)), when: inWysiwyg },
            'mod+shift+3': { run: () => formatAction(() => wysiwyg.heading(3)), when: inWysiwyg },
            'mod+b': { run: () => formatAction(() => wysiwyg.bold()), when: (e) => inWysiwyg() && notTypingInPanel(e) },
            'mod+i': { run: () => formatAction(() => wysiwyg.italic()), when: (e) => inWysiwyg() && notTypingInPanel(e) },
            'mod+z': { run: () => formatAction(() => wysiwyg.undo()), when: (e) => inWysiwyg() && notTypingInPanel(e) },
            'mod+shift+z': { run: () => formatAction(() => wysiwyg.redo()), when: (e) => inWysiwyg() && notTypingInPanel(e) },
            'mod+y': { run: () => formatAction(() => wysiwyg.redo()), when: (e) => inWysiwyg() && notTypingInPanel(e) },
            escape: {
                run: () => { if (search.isOpen()) search.close(); else menu.close(); },
                when: () => search.isOpen() || menu.isOpen(),
            },
        };
    }

    /** 格式化动作统一收口：吞掉异步命令的异常，避免未处理的 rejection */
    function formatAction(fn) {
        try {
            const r = fn();
            if (r && typeof r.catch === 'function') r.catch((err) => console.warn('[notepad] 格式化命令失败：', err));
        } catch (err) {
            console.warn('[notepad] 格式化命令失败：', err);
        }
    }

    function initMenu() {
        const dropdown = root.querySelector('.menu-dropdown');
        const btn = root.querySelector('.btn-menu');
        const popup = root.querySelector('.menu-popup');
        if (!dropdown || !btn || !popup) return { close: () => {}, isOpen: () => false };

        // 菜单经浮出层显示：窗口根 overflow:hidden + backdrop-filter 会把原地 fixed 元素裁掉，只能搬出窗口；
        // scope 带 menu-dropdown —— 菜单项样式是 .notepad .menu-dropdown .menu-item，搬出后靠浮层载体的类名继续命中。
        let handle = null;
        const isOpen = () => Boolean(handle && handle.isOpen());
        const close = () => { if (handle) handle.close(); };

        on(btn, 'click', (e) => {
            e.stopPropagation();
            if (isOpen()) return close();
            handle = openPopover({
                anchor: btn,
                content: popup,
                align: 'start',
                gap: 6,
                scope: ['notepad', 'menu-dropdown'],
                onDismiss: () => { handle = null; btn.setAttribute('aria-expanded', 'false'); },
            });
            btn.setAttribute('aria-expanded', 'true');
        });
        on(popup, 'click', (e) => {
            // 防御：Text 节点等非 Element 没有 closest
            const item = e.target && e.target.closest ? e.target.closest('.menu-item') : null;
            if (!item) return;
            const action = item.dataset.action;
            if (action === 'new') newNote();
            else if (action === 'open') openFile();
            else if (action === 'search') search.toggle();
            else if (action === 'save') saveFile();
            else if (action === 'download') downloadFile();
            else if (action === 'clear') clearContent();
            else if (action === 'toggle-md') store.setMarkdown(!store.markdown);
            close();
        });
        // 「点菜单外部关闭」与 Esc 由 popover.js 统一负责（旧的 document mousedown 写法只判 .menu-dropdown，菜单搬出窗口后失效）。
        return { close, isOpen };
    }

    // ── store 订阅（init() 已清空旧订阅，这里只会注册一代）──
    disposers.push(store.subscribe('content-changed', (text) => {
        // 分屏预览只在该视图下更新
        if (store.view === 'split' && splitView) splitView.refresh();
        lineCount.textContent = `${t('lines', '行数')} ${countLines(text)}`;
        wordCount.textContent = `${t('words', '字数')} ${countChars(text)}`;
    }));
    disposers.push(store.subscribe('note-selected', updateStatus));
    disposers.push(store.subscribe('format-changed', (format) => {
        root.dataset.format = format;
        updateFileName();
    }));
    disposers.push(store.subscribe('view-changed', (view) => { root.dataset.view = view; }));
    disposers.push(store.subscribe('save-state-changed', updateSaveState));
    disposers.push(store.subscribe('encoding-changed', updateEncoding));
    disposers.push(store.subscribe('markdown-changed', (on) => {
        root.dataset.md = on ? 'on' : 'off';
        updateMenuMarkdownState(on);
    }));

    const menuToggleState = root.querySelector('.menu-toggle-state');

    function updateMenuMarkdownState(isOn) {
        const toggle = root.querySelector('.menu-toggle');
        if (!toggle) return;
        toggle.setAttribute('aria-checked', isOn ? 'true' : 'false');
        if (menuToggleState) menuToggleState.textContent = isOn ? t('on', '开') : t('off', '关');
    }

    // ── 持久化 ──
    const autosave = storage.attachAutosave({
        store,
        onNotice: (message) => alertBox(t('storageTitle', '存储'), message),
    });

    // 语言切换：静态文案 + 状态栏/菜单文案都要跟着换
    on(window, 'languagechange', () => {
        applyI18n(root);
        updateStatus();
        updateMenuMarkdownState(store.markdown);
    });

    // 关闭（plugin-manager 派发 plugin-unload）前先落内容 + 落草稿
    const onUnload = (e) => {
        if (!e.detail || e.detail.id !== 'notepad') return;
        window.removeEventListener('plugin-unload', onUnload);
        try {
            flushActive();
            autosave.flush();
        } catch (err) {
            console.warn('[notepad] 关闭前保存失败：', err);
        }
        dispose();
    };
    window.addEventListener('plugin-unload', onUnload);
    disposers.push(() => window.removeEventListener('plugin-unload', onUnload));

    function dispose() {
        disposers.forEach((fn) => {
            try { fn(); } catch (err) { console.warn('[notepad] 释放资源失败：', err); }
        });
        disposers.length = 0;
        autosave.dispose();
        sidebar.dispose();
        tabs.dispose();
        viewSwitch.dispose();
        formatToolbar.dispose();
        search.dispose();
        wysiwyg.dispose();
        if (sourceEditor) sourceEditor.dispose();
        if (splitView) splitView.dispose();
    }

    // ── 启动 ──
    updateMenuMarkdownState(store.markdown);
    const firstPaint = () => { renderActiveView(); updateStatus(); };

    // 恢复期闸门：loadDraft → rehydrateFromVfs 是异步的，而编辑器从这一刻起就能吃输入；
    // 「有路径、正文未补回」的笔记若被敲脏就写回，旧正文永久丢失——补回完成前一律不写回，放开时再补排一次。
    autosave.pauseWrites();
    storage.loadDraft()
        .catch((err) => {
            console.warn('[notepad] 草稿载入失败：', err);
            return null;
        })
        .then((draft) => {
            if (!store.loadSnapshot(draft)) {
                store.addNote();            // 无草稿才建首条空笔记
                return null;
            }
            // loadSnapshot 不派发事件：侧边栏与标签条还停在 init() 时的空列表，补一次广播
            store.emit('notes-changed', store.notes);
            store.emit('tabs-changed', store.tabs);
            // 配额降级会丢掉已落盘笔记的正文，先从根目录「文档」回读再首帧渲染，
            // 否则编辑器会以空正文覆盖磁盘上的旧内容
            return storage.rehydrateFromVfs(store)
                .catch((err) => {
                    if (err && err.name === 'NeedsReauthError') return reauthNotice(() => renderActiveView());
                    console.warn('[notepad] 草稿回读根目录失败：', err);
                });
        })
        .finally(() => {
            firstPaint();
            autosave.resumeWrites();    // 暂停期间攒下的改动在这里补排一次，不会丢
        });

    return dispose;
}

/** 静态文案：核心 applyTranslations() 只覆盖注入时刻已存在的节点，插件自行补一次 */
function applyI18n(root) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = i18n.t(el.dataset.i18n, el.textContent);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.setAttribute('title', i18n.t(el.dataset.i18nTitle, el.getAttribute('title') || ''));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        const fallback = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
        const value = i18n.t(el.dataset.i18nPlaceholder, fallback);
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.placeholder = value;
        else el.setAttribute('data-placeholder', value);
    });
}
