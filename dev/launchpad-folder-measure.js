/**
 * 启动台「文件夹磁贴 vs 应用图标」真机测量。
 *
 * 用途：启动台打开时，把本文件内容粘进浏览器控制台（或临时作为 <script> 加载）。
 * 测三组数：
 * 1. 排版矩形：应用图标 <img> 与文件夹磁贴 .folder-tile 的 getBoundingClientRect；
 * 2. 未变换尺寸：offsetWidth/offsetHeight（排除 hover 的 scale(1.07)）；
 * 3. 可见画面：磁贴涂装方块（按 --lp-folder-artwork 内缩）对图标 PNG 的不透明包围盒
 *    （用 canvas 读 alpha，等于肉眼看到的图标大小）。
 *
 * 为什么单独测第 3 组：真机曾量到「磁贴 85 / 图标画面 70」，差的 15% 是图标 PNG 自带的
 * 透明外边距（15 枚实测 84.0%–84.8%），不是排版尺寸错。修后两组都应吻合。
 *
 * 为什么不进 CI：Node 没有布局引擎，仓库内又禁用 Chrome 自动化；
 * dev/app-rules-check.mjs 只断言盒模型契约，真实矩形必须真机跑本脚本。
 */
(() => {
    const TOLERANCE = 0.5;          // 排版矩形（浏览器坐标）
    const ART_TOLERANCE = 1.5;      // 可见画面（alpha 包围盒阈值 + 抗锯齿）

    const grid = document.querySelector(".launchpad .page-grid");
    const appCell = grid && grid.querySelector('.container[data-kind="app"]');
    const folderCell = grid && grid.querySelector('.container[data-kind="folder"]');

    if (!grid || !appCell || !folderCell) {
        console.warn("[folder-metrics] 当前页没有同时出现应用与文件夹，请翻到含文件夹的一页后重试");
        return null;
    }

    const rectOf = (el) => (el ? el.getBoundingClientRect() : null);
    const appImg = appCell.querySelector(":scope > img");
    const tile = folderCell.querySelector(":scope > .folder-tile");
    const appLabel = appCell.querySelector(":scope > p");
    const folderLabel = folderCell.querySelector(":scope > p");

    const hovered = appCell.matches(":hover") || folderCell.matches(":hover");

    const appIcon = rectOf(appImg);
    const tileRect = rectOf(tile);

    // 第 1 组：排版矩形（若受 hover 缩放影响，两边同时缩放，差值仍应为 0）
    const rows = [
        ["width", appIcon.width, tileRect.width],
        ["height", appIcon.height, tileRect.height],
        ["left", appIcon.left, tileRect.left],
        ["top", appIcon.top, tileRect.top],
        ["label.top", appLabel.top, folderLabel.top],
    ].map(([field, a, b]) => ({
        field,
        app: a,
        folder: b,
        delta: Math.abs(a - b),
        pass: Math.abs(a - b) <= TOLERANCE,
    }));

    // 第 2 组：未变换尺寸（offsetWidth 不含 transform），用来排除 hover 态
    const layoutRows = [
        ["offsetWidth", appImg.offsetWidth, tile.offsetWidth],
        ["offsetHeight", appImg.offsetHeight, tile.offsetHeight],
    ].map(([field, a, b]) => ({
        field,
        app: a,
        folder: b,
        delta: Math.abs(a - b),
        pass: Math.abs(a - b) <= TOLERANCE,
    }));

    // 第 3 组：可见画面。磁贴涂装方块 = 排版盒 − 2 × (1 − artwork) / 2。
    const tileCs = getComputedStyle(tile);
    const iconPx = parseFloat(tileCs.getPropertyValue("--lp-icon")) || tile.offsetWidth;
    const ratio = parseFloat(tileCs.getPropertyValue("--lp-folder-artwork")) || 0.844;
    const painted = tile.offsetWidth * ratio;

    const alphaBBox = (img) => {
        try {
            if (!img.complete || !img.naturalWidth) return null;
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
            for (let y = 0; y < canvas.height; y += 1) {
                for (let x = 0; x < canvas.width; x += 1) {
                    if (data[(y * canvas.width + x) * 4 + 3] > 8) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 0) return null;
            return {
                width: (maxX - minX + 1) / canvas.width,
                height: (maxY - minY + 1) / canvas.height,
            };
        } catch (err) {
            console.warn("[folder-metrics] 读取图标 alpha 失败（可能是跨域资源）：", err.message);
            return null;
        }
    };

    const art = alphaBBox(appImg);
    const artWidth = art ? art.width * appImg.offsetWidth : NaN;
    const artHeight = art ? art.height * appImg.offsetHeight : NaN;
    const artRows = art ? [
        ["painted.width", painted, artWidth],
        ["painted.height", painted, artHeight],
    ].map(([field, a, b]) => ({
        field,
        tile: a,
        iconArtwork: b,
        delta: Math.abs(a - b),
        pass: Math.abs(a - b) <= ART_TOLERANCE,
    })) : [];

    const metrics = {
        appName: appCell.dataset.name,
        folderName: folderCell.dataset.name,
        tolerance: TOLERANCE,
        artTolerance: ART_TOLERANCE,
        hovered,
        iconBox: { width: appIcon.width, height: appIcon.height, left: appIcon.left, top: appIcon.top },
        tileBox: { width: tileRect.width, height: tileRect.height, left: tileRect.left, top: tileRect.top },
        layout: layoutRows,
        labelTop: { app: appLabel.top, folder: folderLabel.top },
        artworkRatio: { declared: ratio, measured: art },
        painted: { size: painted, iconPx },
        rectRows: rows,
        artRows,
        pass: rows.every((r) => r.pass) && layoutRows.every((r) => r.pass)
            && (!artRows.length || artRows.every((r) => r.pass)),
    };

    console.log(`[folder-metrics] 图标排版盒 ${appImg.offsetWidth}px，磁贴排版盒 ${tile.offsetWidth}px`);
    console.log(`[folder-metrics] 磁贴可见涂装 ${painted.toFixed(1)}px；图标不透明画面 ${Number.isNaN(artWidth) ? "未读到" : artWidth.toFixed(1)}px`);
    if (hovered) console.warn("[folder-metrics] 指针正悬停在格子上：坐标含 scale(1.07)，offset 尺寸不受影响；复测请把指针移开");
    console.table(rows);
    if (layoutRows.length) console.table(layoutRows);
    if (artRows.length) console.table(artRows);
    console.log(metrics.pass
        ? `[folder-metrics] PASS：排版矩形差 ≤ ${TOLERANCE}px，可见画面差 ≤ ${ART_TOLERANCE}px`
        : "[folder-metrics] FAIL：存在超过容差的字段（见上表）");

    window.__lpFolderMetrics = metrics;
    return metrics;
})();
