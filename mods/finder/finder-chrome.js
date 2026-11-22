/**
 * finder-chrome.js — 状态栏与路径栏（保真清单 F-44）：
 *  - 状态栏：N 个项目 / 选中数（含多选计数与体积合计，文件夹不计大小）；
 *  - 路径栏：面包屑，点击段落导航；虚拟目录（最近使用/应用程序/收藏夹）同样成段；
 *  - 显隐持久化走 finder-settings（finder.showStatusBar / finder.showPathBar），
 *    并订阅 document 的 settings-changed 实时同步（后续「显示」菜单接入即生效）。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderSettings } from './finder-settings.js';

const Deskly = () => window.Deskly;

const FinderChrome = (() => {
    let statusbar = null, countEl = null, selEl = null;
    let pathbar = null, onNavigate = null;

    /** @type {Function[]} 资源释放回调 */
    let disposers = [];
    function track(fn) { disposers.push(fn); }
    function dispose() {
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /**
     * 初始化。
     * @param {object} options
     * @param {Function} [options.navigate] 路径栏点击导航回调
     */
    function init(options = {}) {
        dispose();
        onNavigate = options.navigate || null;

        statusbar = document.getElementById('finder-statusbar');
        countEl = document.getElementById('statusbar-count');
        selEl = document.getElementById('statusbar-selection');
        pathbar = document.getElementById('finder-pathbar');

        track(FinderState.on('entries-changed', updateCounts));
        track(FinderState.on('selection-changed', updateCounts));
        track(FinderState.on('search-changed', updateCounts));
        track(FinderState.on('search-results-changed', updateCounts));
        track(FinderState.on('path-changed', renderPathbar));
        track(FinderState.on('state-reset', renderPathbar));
        track(FinderState.on('locale-changed', () => { updateCounts(); renderPathbar(); }));

        // 显隐偏好变化（含其它面板/快捷键改动）实时同步
        const onSettings = () => syncVisibility();
        document.addEventListener('settings-changed', onSettings);
        track(() => document.removeEventListener('settings-changed', onSettings));

        pathbar?.addEventListener('click', (e) => {
            const crumb = e.target.closest('.pathbar-crumb[data-path]');
            if (crumb) onNavigate?.(crumb.dataset.path);
        });

        syncVisibility();
        updateCounts();
        renderPathbar();
    }

    /** 按偏好显隐两栏。 */
    function syncVisibility() {
        if (statusbar) statusbar.hidden = !FinderSettings.bool('finder.showStatusBar');
        if (pathbar) pathbar.hidden = !FinderSettings.bool('finder.showPathBar');
    }

    /** 「N 个项目，选中 M 个（共 X）」 */
    function updateCounts() {
        if (!countEl || !selEl) return;
        const s = FinderState.getState();
        const searching = Boolean(s.searchQuery);
        const list = searching && Array.isArray(s.searchResults) ? s.searchResults : (s.entries || []);
        const noun = searching
            ? i18n.t('finder.statusResults', '个结果')
            : i18n.t('finder.statusItems', '个项目');
        countEl.textContent = searching
            ? `${list.length} ${noun}`
            : i18n.t('finder.statusCount', '{n} 个项目').replace('{n}', String(list.length));
        const sel = s.selectedPaths;
        if (!sel.size) { selEl.textContent = ''; return; }
        let bytes = 0, hasFolder = false;
        const pool = list.length ? list : (s.entries || []);
        pool.forEach((e) => {
            if (!sel.has(e.path)) return;
            if (e.type === 'folder') hasFolder = true;
            else if (typeof e.size === 'number') bytes += e.size;
        });
        const sizeText = bytes > 0 ? ` · ${formatBytes(bytes)}` : '';
        selEl.textContent = `${i18n.t('finder.statusSelected', '已选中')} ${sel.size}${hasFolder ? '' : sizeText}`;
    }

    function formatBytes(n) {
        const f = Deskly().vfs.formatSize;
        if (typeof f === 'function') return f(n);
        return `${n} B`;
    }

    /** 面包屑：根 + 逐级；段落过长时保留末 5 级（前方收成「…」，点击回根）。 */
    function renderPathbar() {
        if (!pathbar) return;
        pathbar.innerHTML = '';
        let cur = '/';
        try { cur = Deskly().fs.paths.normalize(FinderState.getState().currentPath || '/'); } catch { cur = '/'; }
        const parts = cur.split('/').filter(Boolean);
        const crumbs = ['/'].concat(parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/')));
        const keep = crumbs.slice(-6);
        if (crumbs.length > keep.length) {
            const dots = document.createElement('span');
            dots.className = 'pathbar-crumb pathbar-dots';
            dots.textContent = '…';
            dots.dataset.path = '/';
            pathbar.appendChild(dots);
        }
        keep.forEach((p, i) => {
            if (i > 0 || keep.length > 1) {
                const sep = document.createElement('span');
                sep.className = 'pathbar-sep';
                sep.textContent = '›';
                pathbar.appendChild(sep);
            }
            const c = document.createElement('span');
            c.className = 'pathbar-crumb' + (i === keep.length - 1 ? ' active' : '');
            c.dataset.path = p;
            c.textContent = p === '/' ? i18n.t('finder.rootLabel', 'Deskly') : (parts[crumbs.indexOf(p) - 1] || p);
            pathbar.appendChild(c);
        });
    }

    return { init, dispose };
})();

export { FinderChrome };
