/**
 * storage.js — 持久化层（规划 §7-P1）
 * 1. 读：文件字节 → 文本（BOM / UTF-8 fatal 探测，失败回退并在编码标签上说明）。
 * 2. 存：正文经 OSFS 写入根目录「文档」；已落盘笔记的后续编辑做防抖写回。
 * 3. 草稿：store 快照以 localStorage 为即时快照；落盘成功后再往 AppData/notepad/temp
 *    补一份恢复副本。副本不是第二个真相源，只在 localStorage 缺失/被瘦身时用于恢复，
 *    写顺序永远 localStorage 在前。
 * 4. 读：除文件选择器（File API）外，已落盘笔记的正文可从根目录回读（见 rehydrateFromVfs）。
 *
 * 老笔记在「桌面」：同一棵根目录树上照样读得到，所以不做迁移。
 */

import { OSFS } from '../../../src/javascripts/osfs.js';
import { i18n } from '../../../src/javascripts/i18n.js';

export { OSFS };

const DRAFT_KEY = 'webstartos-notepad-draft';
const DRAFT_DEBOUNCE = 600;    // 草稿写入节流
const AUTOSAVE_DEBOUNCE = 2000; // 已落盘笔记的写回节流
const SCOPE_ID = 'notepad';
const DRAFT_MIRROR = 'temp/draft.json';

let osfsReady = null;

/** OSFS 懒初始化（内核 init 幂等，重复调用安全） */
function ensureOsfs() {
    if (!osfsReady) {
        osfsReady = Promise.resolve()
            .then(() => OSFS.init())
            .catch((err) => {
                console.warn('[notepad] OSFS 初始化失败：', err);
                osfsReady = null;
            });
    }
    return osfsReady;
}

/** 笔记落盘路径：顶层目录只有 OSFS.TOP 一个来源，别处不写 /文档 字面量 */
function notePath(name) { return OSFS.joinPath(OSFS.TOP.documents.path, name); }

/** 生成合法文件名：去掉路径分隔与控制字符 */
export function safeFileName(name, ext) {
    const base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'note';
    return `${base}.${ext}`;
}

/**
 * 挂载的真实文件夹权限过期了吗：需要一次用户手势重新授权。
 * 只在 osfs 已初始化时判定，没起来算「不需要」（那只是初始化失败，不是权限态）。
 */
export async function osfsNeedsReauth() {
    await ensureOsfs();
    try { return OSFS.status().needsReauth === true; } catch (err) { return false; }
}

/**
 * 在用户手势里补授权。OSFS.reauthorize 内部走 requestPermission，
 * 必须挂在按钮点击上调用，静默调用 Chrome 会直接拒。
 */
export async function osfsReauth() {
    await ensureOsfs();
    return OSFS.reauthorize();
}

/**
 * 解码文件字节，返回文本与实际采用的编码标签。
 * UTF-8 解码失败时回退 GB18030 / windows-1252，并在标签上标注「推断」，不谎报 UTF-8。
 */
export function decodeBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    const bom = readBom(bytes);
    if (bom) {
        const text = tryDecode(bytes.subarray(bom.skip), bom.label, false);
        if (text !== null) return { text, encoding: bom.badge, guessed: false };
    }
    const strict = tryDecode(bytes, 'utf-8', true);
    if (strict !== null) return { text: strict, encoding: 'UTF-8', guessed: false };

    const guess = tryDecode(bytes, 'gb18030', true);
    if (guess !== null) return { text: guess, encoding: encodingBadge('GB18030'), guessed: true };

    const latin = tryDecode(bytes, 'windows-1252', false);
    if (latin !== null) return { text: latin, encoding: encodingBadge('windows-1252'), guessed: true };

    const lossy = tryDecode(bytes, 'utf-8', false);
    return { text: lossy === null ? '' : lossy, encoding: encodingBadge('UTF-8'), guessed: true };
}

function encodingBadge(label) {
    return label + i18n.t('notepad.encodingGuessedSuffix', '(推断)');
}

function readBom(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { label: 'utf-8', badge: 'UTF-8', skip: 3 };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { label: 'utf-16le', badge: 'UTF-16LE', skip: 2 };
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { label: 'utf-16be', badge: 'UTF-16BE', skip: 2 };
    return null;
}

function tryDecode(bytes, label, fatal) {
    try {
        return new TextDecoder(label, { fatal }).decode(bytes);
    } catch (err) {
        return null;
    }
}

/** 读取 File 对象（按真实编码解码） */
export async function readTextFile(file) {
    const buffer = await file.arrayBuffer();
    return decodeBuffer(buffer);
}

/**
 * 从根目录回读单个落盘笔记。
 * @param {string} path saveNote() 返回的路径，形如 /文档/name.md
 * @returns {Promise<{text: string, encoding: string, guessed: boolean}|null>} 读不到返回 null
 */
export async function readNoteByPath(path) {
    if (!path) return null;
    await ensureOsfs();
    try {
        const file = await OSFS.read(path);
        if (!file) return null;
        return await readTextFile(file);
    } catch (err) {
        // 权限过期不是「没有这个文件」：如实抛出去，调用方好提示重新授权，
        // 而不是把已有正文的空笔记当成读不到。
        if (err && err.name === 'NeedsReauthError') throw err;
        console.warn('[notepad] 根目录回读失败：', path, err);
        return null;
    }
}

/**
 * 把「正文被草稿瘦身丢弃」的已落盘笔记从根目录补回来。
 * saveDraft() 配额不足时会把 path 且非脏的笔记正文写成空串，下次启动若不回读，
 * 编辑器就会拿空正文覆盖磁盘上的旧内容（真丢数据）。
 * 只处理有路径 / 正文空 / 非脏的笔记，写回前再确认一次，避免覆盖用户这段时间的输入。
 * @param {object} store core/store.js 单例
 * @returns {Promise<number>} 实际补回的条数
 */
export async function rehydrateFromVfs(store) {
    const pending = store.notes.filter((n) => n.path && !n.content && n.dirty === false);
    let restored = 0;
    for (const n of pending) {
        let read;
        try {
            read = await readNoteByPath(n.path);
        } catch (err) {
            // 挂载权限过期：后面所有磁盘读都会抛，没逐条试的必要，直接上抛让调用方提示重新授权
            if (err && err.name === 'NeedsReauthError') throw err;
            read = null;
        }
        if (!read || n.content || n.dirty) continue;
        n.content = read.text;
        restored++;
    }
    if (restored) store.emit('notes-changed', store.notes);
    return restored;
}

/** 写入根目录「文档」，返回内核规范化后的路径 */
export async function saveNote(note) {
    await ensureOsfs();
    const name = safeFileName(note.title, note.format === 'txt' ? 'txt' : 'md');
    return OSFS.write(notePath(name), note.content);
}

/** 载入草稿：localStorage 即时快照优先，恢复副本只在快照缺正文时才读 */
export async function loadDraft() {
    const local = readLocalDraft();
    if (!needsMirrorRecovery(local)) return local;
    const mirror = await readMirror();
    if (!mirror) return local;
    return local ? mergeDraft(local, mirror) : mirror;
}

/** localStorage 草稿快照（同步，关闭前 flush 依赖它） */
function readLocalDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.warn('[notepad] 草稿读取失败：', err);
        return null;
    }
}

function needsMirrorRecovery(state) {
    if (!state) return true;
    return (state.notes || []).some((n) => n.path && !n.content);
}

async function readMirror() {
    try {
        await ensureOsfs();
        const file = await OSFS.scope(SCOPE_ID).read(DRAFT_MIRROR);
        if (!file) return null;
        return JSON.parse(await file.text());
    } catch (err) {
        console.warn('[notepad] 草稿恢复副本读取失败：', err);
        return null;
    }
}

/** 只按 id 回填「有路径但正文为空」的条目，其它一律以 localStorage 快照为准 */
function mergeDraft(local, mirror) {
    const byId = new Map((mirror.notes || []).map((n) => [n.id, n]));
    return {
        ...local,
        notes: (local.notes || []).map((n) => {
            if (!n.path || n.content) return n;
            const source = byId.get(n.id);
            return source && source.content ? { ...n, content: source.content } : n;
        }),
    };
}

/** 落盘成功后补一份恢复副本；失败不影响主链路，所以只 warn */
export function mirrorDraft(snapshot) {
    if (!snapshot) return;
    ensureOsfs()
        .then(() => OSFS.scope(SCOPE_ID).write(DRAFT_MIRROR, JSON.stringify(snapshot)))
        .catch((err) => console.warn('[notepad] 草稿恢复副本写入失败：', err));
}

/** 写入草稿缓存；配额不足时丢弃已落盘笔记的正文后重试一次 */
export function saveDraft(snapshot) {
    const attempt = (state) => {
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
            return true;
        } catch (err) {
            return false;
        }
    };
    if (attempt(snapshot)) return true;
    const slim = {
        ...snapshot,
        notes: (snapshot.notes || []).map((n) => (n.path && n.dirty === false ? { ...n, content: '' } : n)),
    };
    if (attempt(slim)) return true;
    try {
        localStorage.removeItem(DRAFT_KEY);
    } catch (err) {
        // 清缓存也失败：仅剩内存态
    }
    return false;
}

export function clearDraft() {
    try {
        localStorage.removeItem(DRAFT_KEY);
    } catch (err) {
        console.warn('[notepad] 草稿清除失败：', err);
    }
}

/**
 * 绑定持久化生命周期：内容变化 → 防抖写草稿；已有落盘路径的笔记 → 防抖写回。
 * @param {object} options { store, onNotice }
 * @returns {{flush, dispose, writeThrough, pauseWrites, resumeWrites}}
 */
export function attachAutosave({ store, onNotice }) {
    let draftTimer = null;
    let autosaveTimer = null;
    let disposed = false;
    // 恢复期闸门。loadDraft → rehydrateFromVfs 是异步的，而编辑器从 init 那刻起就能吃输入：
    // 一条「有 path、正文还没从根目录补回来」的笔记如果被用户敲了字就写回，
    // 磁盘上的旧正文就永久没了 —— 这是真丢数据，不是界面闪一下。
    let writesPaused = false;
    // 同一权限态的「需重新授权」提示只弹一次，避免自动保存每 2s 重报
    let warnedReauth = false;

    const scheduleDraft = () => {
        clearTimeout(draftTimer);
        draftTimer = setTimeout(() => {
            if (!saveDraft(store.snapshot()) && onNotice) {
                onNotice(i18n.t('notepad.draftQuota', '本地草稿缓存空间不足，未能保存草稿'));
            }
        }, DRAFT_DEBOUNCE);
    };

    const scheduleAutosave = () => {
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(() => {
            writeThrough().catch((err) => {
                console.warn('[notepad] 自动保存失败：', err);
                if (!onNotice) return;
                if (err && err.name === 'NeedsReauthError') {
                    // 权限过期不是普通失败：给准话，且同一权限态只提一次，
                    // 真正的重新授权入口在启动/保存路径的按钮上（requestPermission 需要用户手势）
                    if (warnedReauth) return;
                    warnedReauth = true;
                    onNotice(i18n.t('notepad.autosaveReauth', '自动保存失败：根目录权限已过期，请重新授权'));
                    return;
                }
                warnedReauth = false;
                onNotice(i18n.t('notepad.autosaveFailed', '自动保存失败'));
            });
        }, AUTOSAVE_DEBOUNCE);
    };

    /** 把当前已落盘且有改动的笔记写回原路径 */
    async function writeThrough() {
        const note = store.current;
        if (!note || !note.path || !note.dirty) return;
        // 恢复期不写回；resumeWrites() 会立刻补排一次，这次的编辑不会丢
        if (writesPaused) return;
        const content = note.content;      // 只写这一份快照，await 期间的改动留给下一轮
        await ensureOsfs();
        const name = safeFileName(note.title, note.format === 'txt' ? 'txt' : 'md');
        const nextPath = await OSFS.write(notePath(name), content);
        // await 期间用户可能已经改了正文或切了标签：markSaved() 作用于「当前笔记」，
        // 直接调用会把没写盘的笔记标成已保存，所以先确认快照仍是这条笔记。
        if (note.content !== content) return;
        if (store.current === note) store.markSaved(nextPath);
        else {
            note.dirty = false;
            note.path = nextPath;
            store.emit('notes-changed', store.notes);
        }
        mirrorDraft(store.snapshot());
    }

    /** 恢复期闸门：暂停写回（草稿照常写，它不会覆盖磁盘正文）。 */
    function pauseWrites() {
        writesPaused = true;
        clearTimeout(autosaveTimer);
    }

    /** 恢复完成：放开闸门，并把暂停期间攒下的改动补排一次。 */
    function resumeWrites() {
        if (!writesPaused) return;
        writesPaused = false;
        const note = store.current;
        if (note && note.path && note.dirty) scheduleAutosave();
    }

    const onContentChanged = () => {
        scheduleDraft();
        scheduleAutosave();
    };

    const onHide = () => flush();

    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);

    const unsubscribes = [
        store.subscribe('content-changed', onContentChanged),
        store.subscribe('notes-changed', scheduleDraft),
        store.subscribe('tabs-changed', scheduleDraft),
        store.subscribe('note-selected', scheduleDraft),
        store.subscribe('view-changed', scheduleDraft),
        store.subscribe('format-changed', scheduleDraft),
        store.subscribe('markdown-changed', scheduleDraft),
        store.subscribe('encoding-changed', scheduleDraft),
    ];

    /** 立即落盘（窗口关闭 / 页面隐藏时调用） */
    function flush() {
        clearTimeout(draftTimer);
        clearTimeout(autosaveTimer);
        if (disposed) return;
        if (!saveDraft(store.snapshot()) && onNotice) {
            onNotice(i18n.t('notepad.draftQuota', '本地草稿缓存空间不足，未能保存草稿'));
        }
    }

    function dispose() {
        disposed = true;
        clearTimeout(draftTimer);
        clearTimeout(autosaveTimer);
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onHide);
        unsubscribes.forEach((off) => typeof off === 'function' && off());
    }

    return { flush, dispose, writeThrough, pauseWrites, resumeWrites };
}
