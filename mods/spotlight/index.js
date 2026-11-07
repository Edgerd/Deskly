/**
 * index.js — 聚焦搜索的惰性索引：按类型懒建、增量更新、失效可触发
 *
 * 规则（与任务约束一一对应）：
 * - **不开机全量构建**：每个索引第一次被查询命中时才 build()；
 * - **增量更新**：build 结果按 key 缓存（Map），再次查询直接读缓存行做匹配，
 *   不再回头扫数据源（文件目录读一次就缓存，输入每个键不重复扫盘）；
 * - **失效可触发**：插件注册/注销、设置变更、语言切换、文件变更事件、TTL 到期
 *   都会让对应索引作废，下次查询重建 —— 由 shell 订阅事件后调 invalidate()。
 *
 * 每类索引都是独立实例：一类 build 抛错只影响自己（engine 的错误隔离兜底渲染）。
 */

/**
 * 建一个惰性索引。
 * @param {object} def 索引定义
 * @param {string} def.name 名字（日志与状态表用）
 * @param {() => (Array<object>|Promise<Array<object>>)} def.build 构建函数（返回行数组）
 * @param {number} [def.ttl=0] 缓存毫秒数；0 = 只靠事件失效
 * @returns {{get: () => Promise<Array<object>>, invalidate: () => void, isBuilt: () => boolean, name: string}}
 */
export function createIndex(def) {
    let rows = null;          // 缓存行；null = 未构建或已失效
    let building = null;      // 构建中的共享 Promise（并发查询只建一次）
    let builtAt = 0;          // 上次构建完成时间（TTL 判定）
    const ttl = Number.isFinite(def.ttl) && def.ttl > 0 ? def.ttl : 0;

    async function get() {
        if (rows && ttl && Date.now() - builtAt > ttl) rows = null; // TTL 到期按失效处理
        if (rows) return rows;
        if (building) return building;
        building = Promise.resolve()
            .then(() => def.build())
            .then((built) => {
                rows = Array.isArray(built) ? built : [];
                builtAt = Date.now();
                building = null;
                return rows;
            })
            .catch((err) => {
                building = null;
                // 构建失败不缓存空结果：下次查询重试，错误由 engine 记进 failures
                throw err;
            });
        return building;
    }

    function invalidate() {
        rows = null;
        builtAt = 0;
    }

    return { get, invalidate, isBuilt: () => rows !== null, name: def.name };
}
