/**
 * toolbar-view.js — 视图切换逻辑（所见即所得 / 分屏 / 源码）
 */

export function initViewSwitch(root, { onViewChange }) {
    const buttons = root.querySelectorAll('.btn-view');

    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            buttons.forEach(b => b.classList.toggle('active', b === btn));
            onViewChange(view);
        });
    });

    return {
        setActive(view) {
            buttons.forEach(b => b.classList.toggle('active', b.dataset.view === view));
        }
    };
}
