/**
 * t.js — office 文案统一入口（薄壳）：`t('短键', '中文原句')`，键补 `office.` 前缀后交内核 i18n，
 * 查不到就回退中文原句 —— 漏配键只会「这一句仍是中文」，不会崩、也拿不到 undefined。
 * 日志与写进文档正文的字符串（默认工作表名、示例内容）不走这里：那是要存进文件的数据，翻译等于改文件内容。
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
