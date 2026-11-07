/**
 * messages.js — App Store 的四语文案表。
 *
 * 为什么单独成文件而不是写在 script.js 里：
 * 1. script.js 一被 import 就会初始化窗口，Node 里跑不起来；
 * 2. 「四语齐全」需要能被 dev/changelog-check.mjs 直接读取校验，
 *    把文案留在可求值的纯数据模块里，校验脚本才能比较四种语言的键位。
 */

export const STORE_MESSAGES = {
    "zh-CN": {
        as: {
            tabs: { today: "Today", apps: "应用", plugins: "插件", whatsNew: "新功能" },
            sidebar: { search: "搜索应用", categories: "类别", all: "全部", history: "安装记录" },
            toolbar: { back: "返回", install: "安装 ZIP…" },
            today: {
                cover: "编辑推荐",
                weeklyApps: "本周热门应用",
                weeklyPlugins: "本周热门插件",
                view: "查看",
                noPlugins: "还没有安装第三方插件",
                empty: "这里还没有应用",
            },
            list: { noMatch: "没有匹配的应用", gone: "这个应用已经不在了" },
            detail: {
                installed: "已安装", open: "打开", enable: "启用", disable: "禁用",
                verify: "校验资源", uninstall: "卸载",
                summary: "简介", shots: "界面截图", included: "包含的应用",
                whatsNew: "新功能",
                rating: "评分及评论", ratingNone: "暂无评分",
                ratingNote: "本机商店没有评分数据来源，这里不显示编造的分数。",
                privacy: "App 隐私",
                privacyTrack: "用于追踪你的数据", privacyTrackNone: "没有声明用于追踪的数据。",
                privacyLinked: "与你关联的数据", privacyLinkedNone: "不需要访问任何数据。",
                privacyNote: "以上内容来自插件清单声明的能力，与安装时的授权记录一致。",
                metaCategory: "类别", metaDeveloper: "开发者", metaVersion: "版本", metaSize: "大小", metaSource: "来源",
                builtin: "系统内置", fromZip: "本地安装",
            },
            log: { loading: "正在读取…", failed: "更新日志暂时无法读取" },
            count: { apps: "个应用", entries: "条记录" },
        },
    },
    en: {
        as: {
            tabs: { today: "Today", apps: "Apps", plugins: "Plug-ins", whatsNew: "What's New" },
            sidebar: { search: "Search apps", categories: "Categories", all: "All", history: "Install History" },
            toolbar: { back: "Back", install: "Install ZIP…" },
            today: {
                cover: "Editors' Choice",
                weeklyApps: "Popular Apps",
                weeklyPlugins: "Popular Plug-ins",
                view: "View",
                noPlugins: "No third-party plug-ins installed yet",
                empty: "Nothing here yet",
            },
            list: { noMatch: "No matching apps", gone: "This app is no longer available" },
            detail: {
                installed: "Installed", open: "Open", enable: "Enable", disable: "Disable",
                verify: "Verify Files", uninstall: "Uninstall",
                summary: "Description", shots: "Screenshots", included: "Included Apps",
                whatsNew: "What's New",
                rating: "Ratings & Reviews", ratingNone: "No ratings yet",
                ratingNote: "This store has no rating source, so no score is shown here.",
                privacy: "App Privacy",
                privacyTrack: "Data Used to Track You", privacyTrackNone: "No tracking data is declared.",
                privacyLinked: "Data Linked to You", privacyLinkedNone: "It does not need access to any data.",
                privacyNote: "These details come from the capabilities declared in the plug-in manifest and match the permissions you approved at install time.",
                metaCategory: "Category", metaDeveloper: "Developer", metaVersion: "Version", metaSize: "Size", metaSource: "Source",
                builtin: "Built in", fromZip: "Installed locally",
            },
            log: { loading: "Loading…", failed: "Release notes are unavailable right now" },
            count: { apps: "apps", entries: "records" },
        },
    },
    "ja-JP": {
        as: {
            tabs: { today: "Today", apps: "App", plugins: "プラグイン", whatsNew: "新機能" },
            sidebar: { search: "Appを検索", categories: "カテゴリ", all: "すべて", history: "インストール履歴" },
            toolbar: { back: "戻る", install: "ZIPをインストール…" },
            today: {
                cover: "編集部のおすすめ",
                weeklyApps: "人気のApp",
                weeklyPlugins: "人気のプラグイン",
                view: "表示",
                noPlugins: "サードパーティ製プラグインはまだありません",
                empty: "まだ何もありません",
            },
            list: { noMatch: "一致するAppがありません", gone: "このAppはもうありません" },
            detail: {
                installed: "インストール済み", open: "開く", enable: "有効にする", disable: "無効にする",
                verify: "ファイルを検証", uninstall: "アンインストール",
                summary: "概要", shots: "スクリーンショット", included: "含まれるApp",
                whatsNew: "新機能",
                rating: "評価とレビュー", ratingNone: "評価はまだありません",
                ratingNote: "このストアには評価データがないため、架空の点数は表示しません。",
                privacy: "Appのプライバシー",
                privacyTrack: "トラッキングに使われるデータ", privacyTrackNone: "トラッキング用のデータは宣言されていません。",
                privacyLinked: "あなたに関連付けられるデータ", privacyLinkedNone: "どのデータにもアクセスする必要はありません。",
                privacyNote: "この内容はプラグインのマニフェストが宣言した機能によるもので、インストール時に承認した権限と一致します。",
                metaCategory: "カテゴリ", metaDeveloper: "開発者", metaVersion: "バージョン", metaSize: "サイズ", metaSource: "入手元",
                builtin: "標準搭載", fromZip: "ローカルからインストール",
            },
            log: { loading: "読み込み中…", failed: "更新履歴を読み込めませんでした" },
            count: { apps: "個のApp", entries: "件の記録" },
        },
    },
    cat: {
        as: {
            tabs: { today: "Today喵", apps: "应用喵", plugins: "插件喵", whatsNew: "新功能喵" },
            sidebar: { search: "找应用喵~", categories: "类别喵", all: "全部喵", history: "装过的记录喵" },
            toolbar: { back: "回去喵", install: "装个 ZIP 包喵…" },
            today: {
                cover: "编辑推荐喵",
                weeklyApps: "最近大家都用的应用喵",
                weeklyPlugins: "最近大家都用的插件喵",
                view: "看看喵",
                noPlugins: "还没有装过外面的插件喵~",
                empty: "这里空空的喵~",
            },
            list: { noMatch: "没找到对上的应用喵~", gone: "这个应用不见了喵~" },
            detail: {
                installed: "装好啦喵", open: "打开喵", enable: "开起来喵", disable: "关掉喵",
                verify: "检查文件喵", uninstall: "卸掉喵",
                summary: "简介喵", shots: "界面长这样喵", included: "里面包含的应用喵",
                whatsNew: "新功能喵",
                rating: "评分和评论喵", ratingNone: "还没有评分喵",
                ratingNote: "这个商店没有评分来源，所以不会随便编一个分数喵~",
                privacy: "应用隐私喵",
                privacyTrack: "拿来追踪你的数据喵", privacyTrackNone: "没有声明要拿来追踪的数据喵~",
                privacyLinked: "和你关联的数据喵", privacyLinkedNone: "不需要碰任何数据喵~",
                privacyNote: "上面这些来自插件清单里声明的能力，和装的时候批准的权限一样喵~",
                metaCategory: "类别喵", metaDeveloper: "开发者喵", metaVersion: "版本喵", metaSize: "大小喵", metaSource: "从哪来喵",
                builtin: "系统自带喵", fromZip: "本地装上的喵",
            },
            log: { loading: "正在读喵…", failed: "更新日志读不出来喵~" },
            count: { apps: "个应用喵", entries: "条记录喵" },
        },
    },
};
