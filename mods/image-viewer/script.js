/**
 * 图片浏览器应用脚本
 * 支持缩放、旋转、幻灯片播放、缩略图导航
 */

(function() {
    'use strict';

    // 获取DOM元素
    const viewerWindow = document.querySelector('.image-viewer');
    const btnOpen = viewerWindow.querySelector('.btn-open');
    const btnZoomIn = viewerWindow.querySelector('.btn-zoom-in');
    const btnZoomOut = viewerWindow.querySelector('.btn-zoom-out');
    const zoomLevel = viewerWindow.querySelector('.zoom-level');
    const btnRotateLeft = viewerWindow.querySelector('.btn-rotate-left');
    const btnRotateRight = viewerWindow.querySelector('.btn-rotate-right');
    const btnSlideshow = viewerWindow.querySelector('.btn-slideshow');
    const btnFullscreen = viewerWindow.querySelector('.btn-fullscreen');
    const displayImage = viewerWindow.querySelector('.display-image');
    const placeholder = viewerWindow.querySelector('.placeholder');
    const thumbnailBar = viewerWindow.querySelector('.thumbnail-bar');
    const thumbnails = viewerWindow.querySelector('.thumbnails');
    const fileName = viewerWindow.querySelector('.file-name');
    const imageInfo = viewerWindow.querySelector('.image-info');

    // 状态
    let currentZoom = 100;
    let currentRotation = 0;
    let currentImageIndex = 0;
    let imageList = [];
    let slideshowInterval = null;
    let isSlideshow = false;

    /**
     * 更新缩放显示
     */
    function updateZoomDisplay() {
        zoomLevel.textContent = currentZoom + '%';
        applyTransform();
    }

    /**
     * 应用变换
     */
    function applyTransform() {
        displayImage.style.transform = `scale(${currentZoom / 100}) rotate(${currentRotation}deg)`;
    }

    /**
     * 放大
     */
    function zoomIn() {
        if (currentZoom < 500) {
            currentZoom = Math.min(500, currentZoom + 25);
            updateZoomDisplay();
        }
    }

    /**
     * 缩小
     */
    function zoomOut() {
        if (currentZoom > 25) {
            currentZoom = Math.max(25, currentZoom - 25);
            updateZoomDisplay();
        }
    }

    /**
     * 向左旋转
     */
    function rotateLeft() {
        currentRotation = (currentRotation - 90 + 360) % 360;
        applyTransform();
    }

    /**
     * 向右旋转
     */
    function rotateRight() {
        currentRotation = (currentRotation + 90) % 360;
        applyTransform();
    }

    /**
     * 加载图片
     */
    function loadImage(url, name) {
        displayImage.src = url;
        displayImage.style.display = 'block';
        placeholder.style.display = 'none';
        fileName.textContent = name || '未命名';
        
        displayImage.onload = () => {
            imageInfo.textContent = `${displayImage.naturalWidth} × ${displayImage.naturalHeight}`;
        };
        
        // 重置变换
        currentZoom = 100;
        currentRotation = 0;
        updateZoomDisplay();
    }

    /**
     * 打开图片
     */
    async function openImage() {
        try {
            if (window.WebStartOS?.vfs) {
                const file = await window.WebStartOS.vfs.showOpenFilePicker({
                    types: [{
                        description: '图片文件',
                        accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'] }
                    }]
                });
                
                if (file) {
                    const blob = await file.getFile();
                    const url = URL.createObjectURL(blob);
                    loadImage(url, file.name);
                }
            } else {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const url = URL.createObjectURL(file);
                        loadImage(url, file.name);
                    }
                };
                input.click();
            }
        } catch (err) {
            console.error('打开图片失败:', err);
            alert('打开图片失败：' + err.message);
        }
    }

    /**
     * 开始/停止幻灯片
     */
    function toggleSlideshow() {
        isSlideshow ? stopSlideshow() : startSlideshow();
    }

    /**
     * 开始幻灯片
     */
    function startSlideshow() {
        if (imageList.length <= 1) {
            alert('至少需要两张图片才能播放幻灯片');
            return;
        }
        
        isSlideshow = true;
        viewerWindow.classList.add('slideshow-mode');
        btnSlideshow.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <rect x="4" y="3" width="3" height="10"/>
                <rect x="9" y="3" width="3" height="10"/>
            </svg>
        `;
        
        slideshowInterval = setInterval(() => {
            // 窗口已关闭（脱离 DOM）或无图片时自动停止，避免定时器泄漏持续操作已移除的节点
            if (!viewerWindow.isConnected || !imageList.length) { stopSlideshow(); return; }
            currentImageIndex = (currentImageIndex + 1) % imageList.length;
            showCurrentImage();
        }, 3000);
    }

    /**
     * 停止幻灯片
     */
    function stopSlideshow() {
        isSlideshow = false;
        viewerWindow.classList.remove('slideshow-mode');
        btnSlideshow.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 3l8 5-8 5V3z"/>
            </svg>
        `;
        
        if (slideshowInterval) {
            clearInterval(slideshowInterval);
            slideshowInterval = null;
        }
    }

    /**
     * 全屏切换
     */
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            viewerWindow.requestFullscreen().catch(err => {
                console.error('全屏失败:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }

    /**
     * 更新缩略图选择
     */
    function updateThumbnailSelection() {
        const thumbElements = thumbnails.querySelectorAll('.thumb');
        thumbElements.forEach((thumb, index) => {
            thumb.classList.toggle('active', index === currentImageIndex);
        });
    }

    // 显示当前索引图片并同步缩略图选中态（供幻灯片/方向键复用）
    function showCurrentImage() {
        const it = imageList[currentImageIndex];
        if (!it) return; // 防御：索引越界或列表为空时避免 it.url 空指针
        loadImage(it.url, it.name);
        updateThumbnailSelection();
    }

    // 事件绑定
    btnOpen.addEventListener('click', openImage);
    btnZoomIn.addEventListener('click', zoomIn);
    btnZoomOut.addEventListener('click', zoomOut);
    btnRotateLeft.addEventListener('click', rotateLeft);
    btnRotateRight.addEventListener('click', rotateRight);
    btnSlideshow.addEventListener('click', toggleSlideshow);
    btnFullscreen.addEventListener('click', toggleFullscreen);

    // 键盘快捷键
    const onImageViewerKeydown = (e) => {
        if (!viewerWindow.closest('.window.active')) return;
        
        switch (e.key) {
            case '+':
            case '=':
                zoomIn();
                break;
            case '-':
                zoomOut();
                break;
            case 'ArrowLeft':
            case 'ArrowRight':
                if (imageList.length > 0) {
                    currentImageIndex = (currentImageIndex + (e.key === 'ArrowRight' ? 1 : -1) + imageList.length) % imageList.length;
                    showCurrentImage();
                }
                break;
            case ' ':
                e.preventDefault();
                toggleSlideshow();
                break;
            case 'Escape':
                if (isSlideshow) {
                    stopSlideshow();
                }
                break;
        }
    };
    document.addEventListener('keydown', onImageViewerKeydown);

    // 鼠标滚轮缩放
    const viewerContainer = viewerWindow.querySelector('.viewer-container');
    if (viewerContainer) viewerContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.deltaY < 0 ? zoomIn() : zoomOut();
    });

    // 初始化
    updateZoomDisplay();

    // 资源释放：图片浏览器窗口关闭时停止幻灯片定时器并移除全局键盘监听
    const onImageViewerUnload = (e) => {
        if (e.detail.id !== 'image-viewer') return;
        window.removeEventListener('plugin-unload', onImageViewerUnload);
        if (isSlideshow) stopSlideshow();
        document.removeEventListener('keydown', onImageViewerKeydown);
    };
    window.addEventListener('plugin-unload', onImageViewerUnload);
})();
