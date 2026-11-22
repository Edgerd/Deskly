/**
 * file-type-icons.js — 按扩展名生成 macOS 风格的文件类型图标。
 *
 * 访达 / 桌面 / 聚焦 / 快速查看 / 显示简介共用同一个解析入口：纸张 + 折角 + 类型色条，
 * 色条里直接写类型标签（PDF / XLS / { } …），因此不再需要额外的扩展名角标。
 *
 * 产物是 data:image/svg+xml URL，可以直接塞进任何 <img src>，和现有位图图标走同一条渲染路径；
 * 同一个「颜色 + 标签」只生成一次（模块级缓存），列表里上千个文件也只会算十几次。
 */

const TYPES = {
    pdf: { color: "#ff3b30", label: "PDF" },
    doc: { color: "#007aff", label: "DOC" },
    docx: { color: "#007aff", label: "DOC" },
    xls: { color: "#34c759", label: "XLS" },
    xlsx: { color: "#34c759", label: "XLS" },
    ppt: { color: "#ff9500", label: "PPT" },
    pptx: { color: "#ff9500", label: "PPT" },
    txt: { color: "#8e8e93", label: "TXT" },
    md: { color: "#5856d6", label: "MD" },
    png: { color: "#af52de", label: "PNG" },
    jpg: { color: "#af52de", label: "JPG" },
    jpeg: { color: "#af52de", label: "JPG" },
    gif: { color: "#af52de", label: "GIF" },
    webp: { color: "#af52de", label: "WEBP" },
    bmp: { color: "#af52de", label: "BMP" },
    svg: { color: "#ff2d55", label: "SVG" },
    mp3: { color: "#ff2d55", label: "MP3" },
    wav: { color: "#ff2d55", label: "WAV" },
    mp4: { color: "#ff3b30", label: "MP4" },
    mov: { color: "#ff3b30", label: "MOV" },
    zip: { color: "#ffcc00", label: "ZIP" },
    rar: { color: "#ffcc00", label: "RAR" },
    dmg: { color: "#8e8e93", label: "DMG" },
    app: { color: "#007aff", label: "APP" },
    sketch: { color: "#ff9500", label: "SK" },
    fig: { color: "#ff2d55", label: "FIG" },
    psd: { color: "#007aff", label: "PSD" },
    ai: { color: "#ff9500", label: "AI" },
    code: { color: "#5856d6", label: "{}" },
    json: { color: "#5856d6", label: "{}" },
    html: { color: "#ff9500", label: "<>" },
    css: { color: "#007aff", label: "#" },
    js: { color: "#ffcc00", label: "JS" },
    ts: { color: "#007aff", label: "TS" },
    py: { color: "#34c759", label: "PY" },
    unknown: { color: "#8e8e93", label: "?" },
};

const CODE_EXTS = new Set([
    "js", "mjs", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h",
    "swift", "kt", "php", "sh", "zsh", "yml", "yaml", "toml", "xml",
]);

const cache = new Map();

function extOf(name) {
    const clean = String(name || "").trim().toLowerCase();
    const dot = clean.lastIndexOf(".");
    if (dot <= 0 || dot === clean.length - 1) return "";
    return clean.slice(dot + 1);
}

function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

/**
 * 扩展名 → { color, label }。未知扩展名直接拿扩展名当前四个字符当标签，
 * 这样「未知.xyz」和「未知.abc」在列表里仍能一眼区分。
 */
function typeOf(name) {
    const ext = extOf(name);
    if (!ext) return { ext, ...TYPES.unknown };
    if (TYPES[ext]) return { ext, ...TYPES[ext] };
    if (CODE_EXTS.has(ext)) return { ext, ...TYPES.code };
    return { ext, color: TYPES.unknown.color, label: ext.slice(0, 4).toUpperCase() };
}

function makeSvg(color, label) {
    const safeLabel = escapeXml(String(label).slice(0, 4));
    const fontSize = safeLabel.length >= 4 ? 12 : safeLabel.length === 3 ? 14 : 16;
    return `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" role="img">
  <defs>
    <filter id="shadow" x="-30%" y="-20%" width="160%" height="160%">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000" flood-opacity="0.16"/>
    </filter>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f2f2f5"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dcdce2"/>
    </linearGradient>
  </defs>
  <g filter="url(#shadow)">
    <path d="M30 16H82L104 38V106C104 111 100 115 95 115H30C25 115 21 111 21 106V25C21 20 25 16 30 16Z"
          fill="url(#paper)" stroke="rgba(0,0,0,.08)" stroke-width="1"/>
    <path d="M82 16L104 38H86C83.8 38 82 36.2 82 34V16Z"
          fill="url(#fold)" stroke="rgba(0,0,0,.06)" stroke-width="1"/>
    <rect x="21" y="86" width="83" height="18" fill="${color}" opacity="0.92"/>
    <text x="62.5" y="99.5" text-anchor="middle"
          font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
          font-size="${fontSize}" font-weight="700" fill="#ffffff"
          letter-spacing=".5">${safeLabel}</text>
    <rect x="34" y="48" width="42" height="4" rx="2" fill="${color}" opacity=".22"/>
    <rect x="34" y="58" width="52" height="4" rx="2" fill="${color}" opacity=".14"/>
    <rect x="34" y="68" width="34" height="4" rx="2" fill="${color}" opacity=".10"/>
  </g>
</svg>`;
}

/**
 * 文件名 → 可直接给 <img src> 的类型图标 URL。
 * @param {string} name 文件名（带不带路径都行，只看最后一个扩展名）
 * @returns {string} data:image/svg+xml URL
 */
export function fileIconFor(name) {
    const { color, label } = typeOf(name);
    const key = `${color}|${label}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(makeSvg(color, label))}`;
    cache.set(key, url);
    return url;
}
