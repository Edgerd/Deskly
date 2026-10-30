/**
 * t.js — office 文案统一入口（薄壳）
 *
 * 与记事本/访达同一约定：所有用户可见文案走 `t('短键', '中文原句')`，
 * 键自动加 `office.` 前缀后交给内核 i18n；语言包里查不到就回退中文原句，
 * 因此漏配某个键只会「这一句仍是中文」，不会崩、也不会拿到 undefined。
 *
 * 日志（console.warn / window.__log）不在此列：那是给开发者看的，保持中文。
 * 编解码写进文档正文的字符串（默认工作表名、示例内容）也不走这里：
 * 它们是要存进 .docx/.xlsx/.pptx 的数据，翻译了就等于改了文件内容。
 */

import { i18n } from "../../src/javascripts/i18n.js";

/**
 * 取一条 office 文案。
 * @param {string} key 短键（内部补 `office.` 前缀）
 * @param {string} zh 中文原句（缺失时的回退，也是翻译的源文）
 * @returns {string} 当前语言文案
 */
export function t(key, zh) {
    return i18n.t(`office.${key}`, zh);
}
