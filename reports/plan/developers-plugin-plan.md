# Developers — plugin manager and generator

Short working note for the `developers` built-in plugin. Scope: create, manage and share lightweight plugins from inside Deskly.

## 1. What a created plugin is

A created plugin is a **real installed plugin**, not a private record rendered by this app:

- the source of truth for editing/exporting is stored in this plugin's own AppData (`/AppData/developers/library.json`);
- the runnable copy is installed through the existing installer (`store-api.installZip`), so it lands in the registry, appears in Launchpad, gets a normal plugin window, and is removed through the normal uninstall path;
- packages are built in memory (manifest + `index.html` + `style.css` + `script.js` + `icon.webp`) and zipped with the same JSZip build the App Store uses.

Why both copies: the registry stores file blobs but exposes no API for reading them back, so the editor needs its own source record. The library is authoritative for editing and export; the registry is authoritative for running. A reconciliation pass marks records whose installed copy disappeared instead of silently reinstalling them on boot (that would pop dialogs at startup).

Storage: `Deskly.fs` (plugin-scoped OSFS sandbox, IndexedDB-backed by default, filesystem-backed when a folder is mounted). It survives tab reload and browser restart. Paths are relative to `/AppData/developers`; `library.json` plus `library.bak.json` for one-generation rollback.

## 2. Plugin kinds

| kind | stored as | launch behaviour |
| --- | --- | --- |
| `shortcut` | library only | opens the URL in a new host-browser tab (`window.open`), no Deskly window |
| `window` | installed plugin | opens a standard Deskly window (traffic lights, titlebar, radius, shadow, drag/resize) with the site in an iframe |
| `page` | installed plugin | opens a standard Deskly window whose content is user HTML/CSS/JS |

`shortcut` is intentionally not installed: registering it would put an app in Launchpad that can only flash a window and call `window.open`. It still exports/imports with the same package format.

A `page` plugin runs as a normal plugin (script is served from the plugin directory, so it can use `import` and Deskly APIs). This is the only way to give authored code real script capability under MV3's `script-src 'self'`; an inline `<script>` injected into an iframe is blocked by CSP.

## 3. Window properties → system API

All window geometry/behaviour is declared on the generated window root with `data-window` (the same channel the kernel documents; no second state store):

| UI control | `data-window` key | notes |
| --- | --- | --- |
| initial size | `width:… height:…` | clamped in the form (320–2400 × 240–1600) |
| minimum size | `minWidth:… minHeight:…` | kept ≤ initial size |
| resizable | `resizable:true/false` | system resize handles disabled when false |
| draggable | `draggable:true/false` | system drag zone disabled when false |
| titlebar | `titlebar:hidden` when off | system hides `[data-titlebar]` and falls back to the top traffic-light strip |
| centered | `centered` | always on |
| accent colour | none | **not supported by the window API** (`window-style:self` is documented as not implemented). Colour is a CSS custom property (`--devp-accent`) on the generated shell's titlebar. No kernel change was made; this is recorded as a known gap. |

`shortcut` records keep the window block for later conversion but do not use it.

## 4. Share package

Single JSON file, extension `.devplugin.json`, MIME `application/json`:

```json
{
  "format": "deskly.developer-plugin",
  "formatVersion": 1,
  "exportedAt": "2026-11-08T00:00:00.000Z",
  "plugin": { "id": "...", "name": "...", "kind": "window", "url": "...", "window": {}, "page": {}, "icon": { "data": "data:image/webp;base64,...", "letter": "G", "color": "#2078DA" }, "description": "..." }
}
```

Import accepts this file, the same JSON pasted as text, or a `devp1:` + base64 one-line code (for chat/AI hand-off). Validation runs before anything is written: unknown formats rejected, URLs limited to http/https, size caps (HTML/CSS/JS 256 KB each, icon 256 KB), ids re-generated when invalid or colliding.

## 5. AI / MCP integration

A browser extension cannot host a local MCP server. The working integration is spec-first:

- a versioned schema (`deskly.developer-plugin-spec/1`) is embedded in the UI and copyable;
- external AI output is pasted as JSON or imported as a file, validated by the same code path as manual creation, then installed;
- the same spec is what export/import uses, so an AI-produced package can be moved between machines.

Schema (abridged):

```json
{
  "schema": "deskly.developer-plugin-spec/1",
  "id": "dev-demo",
  "name": "Demo",
  "kind": "shortcut | window | page",
  "url": "https://example.com",
  "description": "one line",
  "window": { "width": 1024, "height": 680, "minWidth": 480, "minHeight": 360, "resizable": true, "draggable": true, "titlebar": true, "accent": "#2078DA" },
  "page": { "html": "...", "css": "...", "js": "..." },
  "icon": { "letter": "D", "color": "#2078DA", "data": "data:image/webp;base64,..." }
}
```

Specs with non-empty `page.js` show an explicit "contains script" confirmation before install.

## 6. Permissions and boundaries

This plugin declares `files:read`, `files:write`, `apps:launch`. Created plugins declare `permissions: []` — they are windows/pages, not kernel consumers unless the author edits that field into their own spec (not offered by the UI).

Metadata capture (`站点标题/图标`) needs the site's HTML. Host permissions are currently limited to three hosts, so `manifest.json` gains `optional_host_permissions: ["*://*/*"]`; the permission is requested per origin from the user's click and only for that origin. Denial or network failure falls back to the hostname and a generated monogram icon; title and icon remain editable.

## 7. Gate updates

- `BUILTIN_IDS` gains `developers` (14 built-ins). No hard-coded count exists in docs; count claims are checked by `dev/static-check.mjs`.
- Icon: 768×768 WebP at `mods/developers/Developers.webp` (ASCII name per the runtime asset rule).

## 8. Out of scope

- No live preview of authored JavaScript (CSP). The editor previews HTML/CSS only; the installed plugin runs the script.
- No local MCP server. Spec paste/import is the supported path.
- No kernel change for window colour; documented as a gap above.
