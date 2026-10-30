/**
 * toolbar-format.js — 格式化工具栏逻辑
 * 绑定所有格式化按钮（粗体/斜体/删除线/标题/代码/引用/列表/链接/图片/分割线/表格）到 WYSIWYG 编辑器。
 */

export function initFormatToolbar(root, { store, wysiwyg, switchView }) {
    const disposers = [];

    const bind = (selector, fn) => {
        root.querySelectorAll(selector).forEach((btn) => {
            // mousedown 阻止默认，避免点击按钮时编辑器失焦丢失选区
            const prevent = (e) => e.preventDefault();
            const click = () => {
                // 只有所见即所得视图能改 DOM：源码/分屏下 wysiwyg 元素是 display:none 的过期快照，
                // 直接 serialize() 会用旧文本覆盖 store.content（规划 §2.1「仅 MD 模式显示」的前提）
                if (store.view !== 'wysiwyg') switchView('wysiwyg');
                const result = fn(btn);
                if (result && typeof result.catch === 'function') {
                    result.catch((err) => console.warn('[notepad] 格式化命令失败：', err));
                }
            };
            btn.addEventListener('mousedown', prevent);
            btn.addEventListener('click', click);
            disposers.push(() => {
                btn.removeEventListener('mousedown', prevent);
                btn.removeEventListener('click', click);
            });
        });
    };

    bind('.btn-bold', () => wysiwyg.bold());
    bind('.btn-italic', () => wysiwyg.italic());
    bind('.btn-strike', () => wysiwyg.strike());
    bind('.btn-heading', (btn) => wysiwyg.heading(+btn.dataset.level));
    bind('.btn-code', () => wysiwyg.codeBlock());
    bind('.btn-quote', () => wysiwyg.quote());
    bind('.btn-ul', () => wysiwyg.unorderedList());
    bind('.btn-ol', () => wysiwyg.orderedList());
    bind('.btn-link', () => wysiwyg.link());
    bind('.btn-image', () => wysiwyg.image());
    bind('.btn-hr', () => wysiwyg.hr());
    bind('.btn-table', () => wysiwyg.table());

    return { dispose: () => disposers.forEach((off) => off()) };
}
