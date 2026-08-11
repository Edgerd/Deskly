/**
 * toolbar-format.js — 格式化工具栏逻辑
 * 绑定所有格式化按钮（粗体/斜体/删除线/标题/代码/引用/列表/链接/图片/分割线/表格）到 WYSIWYG 编辑器。
 */

export function initFormatToolbar(root, { wysiwyg }) {
    const bind = (selector, fn) => {
        root.querySelectorAll(selector).forEach(btn => {
            // mousedown 阻止默认，避免点击按钮时编辑器失焦丢失选区
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', () => {
                if (wysiwyg) fn(btn);
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
}
