**English** | [简体中文](README.zh-CN.md)

# Deskly

[![Stars](https://img.shields.io/github/stars/Edgerd/Deskly?style=flat\&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZlcnNpb249IjEiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHBhdGggZD0iTTggLjI1YS43NS43NSAwIDAgMSAuNjczLjQxOGwxLjg4MiAzLjgxNSA0LjIxLjYxMmEuNzUuNzUgMCAwIDEgLjQxNiAxLjI3OWwtMy4wNDYgMi45Ny43MTkgNC4xOTJhLjc1MS43NTEgMCAwIDEtMS4wODguNzkxTDggMTIuMzQ3bC0zLjc2NiAxLjk4YS43NS43NSAwIDAgMS0xLjA4OC0uNzlsLjcyLTQuMTk0TC44MTggNi4zNzRhLjc1Ljc1IDAgMCAxIC40MTYtMS4yOGw0LjIxLS42MTFMNy4zMjcuNjY4QS43NS43NSAwIDAgMSA4IC4yNVoiIGZpbGw9IiNlYWM1NGYiLz48L3N2Zz4=\&logoSize=auto\&label=Stars\&labelColor=444444\&color=eac54f)](https://github.com/Edgerd/Deskly)
[![Issues](https://img.shields.io/github/issues/Edgerd/Deskly?style=flat\&label=Issues\&labelColor=444444\&color=1F883D)](https://github.com/Edgerd/Deskly/issues)
[![BiliBili](https://img.shields.io/badge/BiliBili-Dynamic-00A4DB?style=flat\&labelColor=444444\&logoSize=auto)](https://space.bilibili.com/3537111380658360/dynamic)
[![Afdian](https://img.shields.io/badge/Sponsor-Afdian-946ce6?style=flat\&labelColor=444444\&logoSize=auto)](https://ifdian.net/a/edgerd)

> A Chromium extension that turns the browser's new tab page into a macOS Sequoia-style desktop.
> Dock, menu bar, window manager, Finder, Calculator, System Settings, App Store, Spotlight — all running as "plugins" inside one host document.

***

## About

### The project

- Everything except the kernel is an **almost purely vibe-coded project**.

- **Human testing and human review**: most features are tested case by case and fixed by hand, backed by a large amount of scripted machine validation; the code is also reviewed section by section.

- **Mainly written with these models**: DeepSeek-V4.1-Flash, DeepSeek-V4-Flash, Qwen-3.7-Flash.

- **Plugins are still early-stage**: odd bugs are likely — testing and issues are very welcome.

### Versioning

This project is a **vibe-coded rebuild** of a personal project. Early development was messy and **only versioned locally**. The full code base was put into Git only after the rebuild. Therefore:

- `v0.3.0` is the **first official release** of this repository and the starting point of its version history;

- Internal builds before it (0.2.93 and earlier) exist only in documents and local backups, with no commit history;

- Every release since then is published on [Releases](https://github.com/Edgerd/Deskly/releases) with a short summary and changelog.

## Screenshot

![Deskly desktop: Finder, About This Mac and Calculator running together on a macOS-style desktop](docs/images/deskly-showcase.png)

Finder, About This Mac and Calculator windows; the menu bar, Dock, desktop icons and wallpaper are all implemented as plugins.

## Installation

1. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge) and enable **Developer mode**.
2. Click **Load unpacked** and select the **root of this repository** (the level containing `manifest.json`). You can also drag the project folder or a `.crx` file onto the page.
3. Open a new tab — that is the Deskly desktop.

> The extension needs the `bookmarks` permission (for the Finder favorites) and host permissions for Bing / image hosts (wallpapers and search).

## Project structure

```
index.html              New tab entry
manifest.json           MV3 manifest
sw.js                   Background service worker
Logo.png                Extension icon
assets/                 Styles, icons, fonts, images, sounds, locales, third-party libraries
src/javascripts/        Plugin kernel
mods/                   Built-in plugins
dev/                    Dev docs and self-check scripts
docs/                   Design references, code reviews, changelog and knowledge base
```

## License

Released under the [GNU General Public License v3.0](LICENSE) (GPL-3.0): free to use, modify and distribute, but derivative works must also be open-sourced under GPL-3.0 with source code provided. Copyright (c) 2026 Edgerd.
