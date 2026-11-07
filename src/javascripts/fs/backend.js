/**
 * fs/backend.js — 统一 Backend 接口：虚拟 / 挂载 / 只读 三种后端同一形状。
 *
 * 存储引擎仍由 osfs.js 独家持有（它不 import 本层，无环）；本层定义的是
 * 「一次文件操作面对什么能力集」的契约：
 *
 *   interface Backend {
 *     kind: 'virtual' | 'disk';       // 当前数据来源
 *     readOnly: boolean;              // true 时一切写操作抛 FSError(EREADONLY)
 *     atomic: boolean;                // 写是否走「暂存 + 提交/回滚」
 *     list/read/write/mkdir/remove/stat/exists/move/copy：见 fs/index.js 的实现
 *   }
 *
 * 只读后端不是另一套存储：它是同一后端包一层写拦截——挂载来的外部目录
 * （如照片的外部图片夹）需要只读视图时，包这个而不需要新引擎。
 */

import { CODES, FSError } from "./errors.js";

/** 写操作名清单：只读包装统一拦这几条。 */
const MUTATORS = ["write", "mkdir", "remove", "move", "rename", "copy"];

/**
 * 把任意实现包成只读后端：读路径原样透传，写路径抛 FSError(EREADONLY)。
 * @param {object} impl 实现 Backend 方法集的对象
 * @param {string} [reason] 给人看的原因（如「外部图片夹为只读挂载」）
 */
function asReadOnly(impl, reason) {
    const wrapped = Object.create(null);
    for (const key of Object.keys(impl)) {
        if (typeof impl[key] !== "function") continue;
        wrapped[key] = MUTATORS.includes(key)
            ? () => { throw new FSError(CODES.EREADONLY, reason || "只读后端不接受写操作"); }
            : impl[key].bind(impl);
    }
    return Object.freeze(wrapped);
}

export { MUTATORS, asReadOnly };
