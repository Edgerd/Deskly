/**
 * templates.js — 三件套「新建自模板」的内容工厂：buildTemplate 产出初始模型
 * （与视图 / 编解码同一份形状约定），走 view.load() 装入，等价于打开一份新文档。
 * 模板名走 t() 即时翻译；模板正文固定中文 —— 那是要写进文档的数据，翻译等于改用户的文件内容。
 */

import { t } from "./t.js";

/** 模板目录：appId -> [{ id, key, zh }]（key 供 t() 查译，zh 是中文回退） */
export const TEMPLATES = {
    "office.word": [
        { id: "meeting", key: "tmplMeeting", zh: "会议纪要" },
        { id: "todo", key: "tmplTodo", zh: "待办清单" },
    ],
    "office.excel": [
        { id: "budget", key: "tmplBudget", zh: "收支记录" },
    ],
    "office.ppt": [
        { id: "report", key: "tmplReport", zh: "项目汇报" },
    ],
};

/**
 * 取一个模板的显示名。
 * @param {string} appId 应用 id
 * @param {string} templateId 模板 id
 * @returns {string} 当前语言下的模板名
 */
export function templateLabel(appId, templateId) {
    const entry = (TEMPLATES[appId] || []).find((tp) => tp.id === templateId);
    return entry ? t(entry.key, entry.zh) : "";
}

/** 文稿块简写：正文段 */
const para = (text, extra) => ({ kind: "paragraph", text, ...(extra || {}) });
/** 文稿块简写：标题段 */
const head = (text, level) => ({ kind: "heading", level, text });

const BUILDERS = {
    "office.word": {
        meeting: () => ({
            blocks: [
                head("会议纪要", 1),
                para("时间："),
                para("地点："),
                para("参会人："),
                para("记录人："),
                head("议题", 2),
                para("· "),
                para("· "),
                head("讨论要点", 2),
                para("· "),
                para("· "),
                head("待办事项", 2),
                para("· （负责人 / 截止时间）"),
                para("· （负责人 / 截止时间）"),
            ],
            page: { size: "a4", background: null, header: "", footer: "" },
        }),
        todo: () => ({
            blocks: [
                head("待办清单", 1),
                para("□ 事项一"),
                para("□ 事项二"),
                para("□ 事项三"),
                head("已完成", 2),
                para(""),
            ],
            page: { size: "a4", background: null, header: "", footer: "" },
        }),
    },
    "office.excel": {
        budget: () => ({
            name: "收支记录",
            rows: [
                ["项目", "类别", "金额", "备注"],
                ["工资", "收入", "10000", ""],
                ["餐饮", "支出", "-320", ""],
                ["交通", "支出", "-96", ""],
                ["合计", "", "=SUM(C2:C4)", ""],
            ],
            styles: [
                [{ bold: true, align: "center" }, { bold: true, align: "center" }, { bold: true, align: "center" }, { bold: true, align: "center" }],
                [null, null, { format: "0.00" }, null],
                [null, null, { format: "0.00" }, null],
                [null, null, { format: "0.00" }, null],
                [{ bold: true }, null, { bold: true, format: "0.00" }, null],
            ],
            filter: null,
            widths: null,
        }),
    },
    "office.ppt": {
        report: () => ({
            slides: [
                { title: "项目汇报", bullets: [], bulletsRight: [], layout: "titleOnly", background: null, color: null, titleColor: null, size: null, notes: "" },
                { title: "本期进展", bullets: ["要点一", "要点二", "要点三"], bulletsRight: [], layout: "titleContent", background: null, color: null, titleColor: null, size: null, notes: "" },
                { title: "现状与计划", bullets: ["现状一", "现状二"], bulletsRight: ["计划一", "计划二"], layout: "twoColumn", background: null, color: null, titleColor: null, size: null, notes: "" },
                { title: "需要支持", bullets: ["资源 / 决策 / 风险"], bulletsRight: [], layout: "titleContent", background: null, color: null, titleColor: null, size: null, notes: "" },
            ],
        }),
    },
};

/**
 * 产出一份模板初始模型（每次现建，调用方可以直接 load / 再编辑，不会共享内部数组）。
 * @param {string} appId 应用 id
 * @param {string} templateId 模板 id
 * @returns {object|null} 模型；未知组合返回 null
 */
export function buildTemplate(appId, templateId) {
    const builders = BUILDERS[appId];
    const build = builders && builders[templateId];
    return build ? build() : null;
}
