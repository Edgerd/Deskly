/**
 * toolbar-view.js — 视图切换逻辑（所见即所得 / 分屏 / 源码）
 * 选中态一律从 store.view 派生：按钮状态与数据不可能各说一套。
 */

export function initViewSwitch(root, { store, onViewChange }) {
    const switchEl = root.querySelector('.view-switch');
    const buttons = Array.from(root.querySelectorAll('.btn-view'));

    function syncActive() {
        buttons.forEach((btn) => {
            const active = btn.dataset.view === store.view;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function onClick(e) {
        const btn = e.target.closest('.btn-view');
        if (!btn) return;
        onViewChange(btn.dataset.view);
    }

    switchEl.addEventListener('click', onClick);
    const unsubscribe = store.subscribe('view-changed', syncActive);

    syncActive();

    return {
        dispose: () => {
            switchEl.removeEventListener('click', onClick);
            unsubscribe();
        },
    };
}
