/**
 * docs.js — 文档站布局引擎（顶栏 / 侧栏 / 本页目录 / 上下页导航 / 侧栏过滤）。
 * 页面约定：<body data-page="<id>" data-base="../">，data-base 是「本页到站点根」的相对前缀，
 * 用它修正 pages.js 里的站点根相对链接。新增页面 = 新建 html（带 data-page/data-base）+ assets/pages.js 加一条。
 */
(function () {
  "use strict";
  var body = document.body;
  var pageId = body.getAttribute("data-page") || "index";
  var base = body.getAttribute("data-base") || "";
  var pages = (window.DOCPAGES || []).flatMap(function (s) {
    return s.items.map(function (it) { return { section: s.section, id: it.id, title: it.title, href: base + it.href, hint: it.hint || "" }; });
  });
  var all = pages.slice();
  var cur = pages.find(function (p) { return p.id === pageId; });
  var idx = all.indexOf(cur);

  function esc(s) {
    var d = document.createElement("i"); d.textContent = s; return d.innerHTML;
  }

  /* ---- 顶栏 ---- */
  var top = document.createElement("header");
  top.className = "docs-topbar";
  var secNav = "";
  var seen = {};
  (window.DOCPAGES || []).forEach(function (s) {
    if (seen[s.section]) return; seen[s.section] = 1;
    var first = all.find(function (p) { return p.section === s.section; });
    secNav += '<a href="' + first.href + '">' + esc(s.section) + "</a>";
  });
  top.innerHTML =
    '<span class="brand">Deskly<small>开发者文档</small></span>' +
    '<span class="crumbs">' + (cur ? esc(cur.section) + " / <b>" + esc(cur.title) + "</b>" : "") + "</span>" +
    '<nav class="topnav">' + secNav + "</nav>";
  body.insertBefore(top, body.firstChild);

  /* ---- 侧栏 ---- */
  var sb = document.createElement("aside");
  sb.className = "docs-sidebar";
  var html = '<input type="search" name="docs-filter" placeholder="过滤本页目录…" aria-label="过滤">';
  (window.DOCPAGES || []).forEach(function (s) {
    html += "<h4>" + esc(s.section) + "</h4><ul>";
    s.items.forEach(function (it) {
      var link = base + it.href;
      html += '<li data-t="' + esc((it.title + " " + (it.hint || "")).toLowerCase()) + '">' +
        '<a class="side-link' + (it.id === pageId ? " active" : "") + '" href="' + link + '">' + esc(it.title) +
        (it.hint ? '<span class="item-hint">' + esc(it.hint) + "</span>" : "") +
        "</a></li>";
    });
    html += "</ul>";
  });
  sb.innerHTML = html;
  body.insertBefore(sb, body.firstChild.nextSibling ? body.firstChild.nextSibling.nextSibling : body.firstChild);
  // 保证顺序：top, sb, main, ...
  var main = body.querySelector(".docs-main");
  body.insertBefore(sb, main);

  var filter = sb.querySelector("input");
  filter.addEventListener("input", function () {
    var q = filter.value.trim().toLowerCase();
    sb.querySelectorAll("li[data-t]").forEach(function (li) {
      li.style.display = !q || li.getAttribute("data-t").indexOf(q) !== -1 ? "" : "none";
      var hint = li.querySelector(".item-hint");
      if (hint) hint.style.display = q && hint.style.display !== "none" ? "block" : "";
    });
  });

  /* ---- 正文容器 ---- */
  var m = document.querySelector("main") || document.createElement("div");
  if (!m.classList.contains("docs-main")) { m.className = "docs-main"; }

  /* ---- 本页目录（h2/h3） ---- */
  var toc = document.createElement("nav");
  toc.className = "docs-toc";
  var tocHtml = "";
  m.querySelectorAll("h2, h3").forEach(function (h) {
    if (!h.id) h.id = "s-" + Array.from(h.textContent).map(function (c) { return c.charCodeAt(0); }).join("-");
    tocHtml += '<a class="' + (h.tagName === "H3" ? "sub" : "") + '" href="#' + h.id + '">' + esc(h.textContent) + "</a>";
  });
  if (tocHtml) {
    toc.innerHTML = "<h5>本页</h5>" + tocHtml;
    body.appendChild(toc);
  }

  /* ---- 上 / 下页 ---- */
  var prev = all[idx - 1], next = all[idx + 1];
  if (prev || next) {
    var pg = document.createElement("nav");
    pg.className = "docs-pager";
    pg.innerHTML =
      (prev ? '<a class="prev" href="' + prev.href + '"><small>上一节</small>' + esc(prev.title) + "</a>" : '<span style="flex:1"></span>') +
      (next ? '<a class="next" href="' + next.href + '"><small>下一节</small>' + esc(next.title) + "</a>" : '<span style="flex:1"></span>');
    m.appendChild(pg);
  }

  /* ---- 页脚：来源提示 ---- */
  var foot = document.createElement("p");
  foot.style.cssText = "margin-top:40px;color:var(--text-2);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px;";
  foot.textContent = "内容基线：Deskly " + (body.getAttribute("data-version") || "0.2.95") + " · 源码事实以仓库 dev/devdoc 与各文件注释为准 · 本文档为独立静态站，不进插件包";
  m.appendChild(foot);
})();
