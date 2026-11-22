/**
 * finder-sidebar.js — 侧边栏：静态分区（index.html 结构）+ 动态「边栏收藏」（finder-settings 持久化）。
 * 收藏项点击导航；拖文件到边栏任意项 = 加入收藏（F-24：不移动文件）；右键收藏项可移除。
 * 标签分区由 FinderTags 动态渲染；重新授权改由「更多」菜单触发（见 finder-actions）。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderSettings } from './finder-settings.js';
import { readInternalDrag, endInternalDrag } from '../../src/javascripts/ui/dnd.js';

const Deskly = () => window.Deskly;
const FAVORITES_KEY = 'finder.sidebarFavorites';
const FAVORITE_CAP = 8; // 边栏收藏上限：超出按先到先得保留

const FinderSidebar = (() => {
    let sidebarRoot = null, favoritesBody = null, onNavigate = null;

    /** @type {Function[]} 资源释放回调（重开窗口 / plugin-unload 时执行） */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）。 */
    function dispose() {
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /**
     * 初始化侧边栏。
     * @param {object} options
     * @param {Function} [options.navigate] 导航回调
     */
    function init(options = {}) {
        // 常驻单例：重开窗口先撤销上一次的订阅
        dispose();

        onNavigate = options.navigate || null;
        sidebarRoot = document.querySelector('.finder-sidebar');
        favoritesBody = document.getElementById('sidebar-favorites');

        const onClick = (e) => {
            const item = e.target.closest('.sidebar-item[data-path]');
            if (item) onNavigate?.(item.dataset.path);
        };
        sidebarRoot?.addEventListener('click', onClick);
        track(() => sidebarRoot?.removeEventListener('click', onClick));

        // F-24：拖到侧边栏 = 加入边栏收藏（不移动文件）
        const onDragOver = (e) => {
            if (!readInternalDrag(e)) return;
            e.preventDefault();
            const item = e.target.closest('.sidebar-item, .sidebar-favorite');
            item?.classList.add('dnd-drop-target');
        };
        const onDragLeave = (e) => {
            e.target.closest('.sidebar-item, .sidebar-favorite')?.classList.remove('dnd-drop-target');
        };
        const onDrop = (e) => {
            const payload = readInternalDrag(e);
            if (!payload) return;
            e.preventDefault();
            e.stopPropagation();
            endInternalDrag();
            sidebarRoot?.querySelectorAll('.dnd-drop-target').forEach(el => el.classList.remove('dnd-drop-target'));
            // 只收藏文件夹（文件收藏没有可导航语义）
            const folders = (payload.paths || []).filter((p) => !isDroppedSelf(p));
            // 落点若是收藏项本身且是文件夹，仍按「加入收藏」处理（原版语义：侧栏不是文件落点）
            addFavorites(folders);
        };
        sidebarRoot?.addEventListener('dragover', onDragOver);
        sidebarRoot?.addEventListener('dragleave', onDragLeave);
        sidebarRoot?.addEventListener('drop', onDrop);
        track(() => sidebarRoot?.removeEventListener('dragover', onDragOver));
        track(() => sidebarRoot?.removeEventListener('dragleave', onDragLeave));
        track(() => sidebarRoot?.removeEventListener('drop', onDrop));

        // 收藏项右键移除
        const onContext = (e) => {
            const fav = e.target.closest('.sidebar-favorite');
            if (!fav) return;
            e.preventDefault();
            e.stopPropagation();
            Deskly().ui.contextMenu(e.clientX, e.clientY, [{
                label: i18n.t('finder.removeFavorite', '从边栏移除'),
                action: () => removeFavorite(fav.dataset.path),
            }]);
        };
        sidebarRoot?.addEventListener('contextmenu', onContext);
        track(() => sidebarRoot?.removeEventListener('contextmenu', onContext));

        track(FinderState.on('path-changed', updateHighlight));
        // 打开时的高亮：path-changed 只在路径真正变化时广播，初始态需显式同步一次
        updateHighlight(FinderState.getState().currentPath);
        renderFavorites();
    }

    /** 排除把正在浏览的当前目录拖进收藏（自己收藏自己没意义也不报错）。 */
    function isDroppedSelf(path) {
        return path === '/' || path === '/应用程序' || path === '/最近使用' || path === '/收藏夹';
    }

    /** 追加收藏（去重、上限、持久化、重渲染）。 */
    function addFavorites(paths) {
        if (!paths.length) return;
        const cur = (FinderSettings.get(FAVORITES_KEY) || []).slice();
        paths.forEach((p) => {
            if (!cur.includes(p)) cur.push(p);
        });
        while (cur.length > FAVORITE_CAP) cur.shift();
        FinderSettings.set(FAVORITES_KEY, cur);
        renderFavorites();
    }

    /** 移除收藏项。 @param {string} path */
    function removeFavorite(path) {
        const cur = (FinderSettings.get(FAVORITES_KEY) || []).filter((p) => p !== path);
        FinderSettings.set(FAVORITES_KEY, cur);
        renderFavorites();
    }

    /** 渲染动态收藏区。 */
    function renderFavorites() {
        if (!favoritesBody) return;
        favoritesBody.innerHTML = '';
        const list = FinderSettings.get(FAVORITES_KEY) || [];
        list.forEach((p) => {
            const item = document.createElement('div');
            item.className = 'sidebar-item sidebar-favorite finder-no-drag';
            item.dataset.path = p;
            const icon = document.createElement('span');
            icon.className = 'item-icon item-icon-glyph';
            icon.textContent = '📁';
            icon.style.fontSize = '13px';
            const label = document.createElement('span');
            label.className = 'item-label';
            label.textContent = Deskly().fs.paths.baseName(p) || p;
            label.title = p;
            item.append(icon, label);
            favoritesBody.appendChild(item);
        });
        updateHighlight(FinderState.getState().currentPath);
    }

    /**
     * 更新侧边栏高亮项（前缀匹配当前路径）。
     * @param {string} currentPath
     */
    function updateHighlight(currentPath) {
        if (!sidebarRoot || !currentPath) return;
        sidebarRoot.querySelectorAll('.sidebar-item[data-path]').forEach(item => {
            const p = item.dataset.path;
            item.classList.toggle('active', p !== '/' && (currentPath === p || currentPath.startsWith(p + '/')));
        });
    }

    return { init, dispose };
})();

export { FinderSidebar };
