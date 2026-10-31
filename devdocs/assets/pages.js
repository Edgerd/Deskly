/**
 * pages.js — 文档站页面注册表（单一事实来源）
 *
 * 扩展方式：新增一个 HTML 页面后，在这里加一条 { id, title, href }，
 * 侧边栏、顶栏、上/下页导航、面包屑会自动带上它。id 与 <body data-page="id"> 对应。
 * href 一律相对站点根（devdocs/），docs.js 会按页面所在目录补前缀。
 */
window.DOCPAGES = [
  { section: "入门", items: [
    { id: "index",        title: "总览与架构",    href: "index.html" },
    { id: "quickstart",   title: "五分钟写第一个插件", href: "guides/quickstart.html" },
    { id: "architecture", title: "架构总览",      href: "guides/architecture.html" },
  ]},
  { section: "插件开发", items: [
    { id: "plugin-format", title: "插件包格式",     href: "guides/plugin-format.html" },
    { id: "cold-load",     title: "冷加载机制",     href: "guides/cold-load.html" },
    { id: "app-store",     title: "应用商店与分发", href: "guides/app-store.html" },
  ]},
  { section: "API 参考", items: [
    { id: "deskly",   title: "window.Deskly（能力入口）", href: "api/deskly.html" },
    { id: "settings", title: "设置中枢 __settings",       href: "api/settings.html" },
    { id: "log",      title: "日志 __log",                href: "api/log.html" },
    { id: "i18n",     title: "多语言 i18n",               href: "api/i18n.html" },
    { id: "osfs",     title: "文件存储 OSFS",             href: "api/osfs.html" },
    { id: "events",   title: "事件与全局接口",            href: "api/events.html" },
    { id: "surface",  title: "表面：模糊与可读文字",      href: "api/surface.html" },
    { id: "trash",    title: "废纸篓闭环 trash.js",       href: "api/trash.html" },
    { id: "menubar",  title: "菜单栏状态项",              href: "api/menubar.html" },
  ]},
  { section: "规范与工具", items: [
    { id: "redlines",  title: "红线清单",     href: "reference/redlines.html" },
    { id: "z-layers",  title: "z-index 层级表", href: "reference/z-layers.html" },
    { id: "dev-tools", title: "开发自检工具", href: "reference/dev-tools.html" },
    { id: "changelog", title: "版本与更新",   href: "reference/changelog.html" },
  ]},
];
