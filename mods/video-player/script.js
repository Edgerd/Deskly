/**
 * 视频播放器应用脚本
 * 支持播放控制、进度调节、音量控制、全屏播放
 */

(function() {
    'use strict';

    // 获取DOM元素
    const playerWindow = document.querySelector('.video-player');
    const video = playerWindow.querySelector('.video-element');
    const placeholder = playerWindow.querySelector('.video-placeholder');
    const btnPlay = playerWindow.querySelector('.btn-play');
    const btnStop = playerWindow.querySelector('.btn-stop');
    const btnFullscreen = playerWindow.querySelector('.btn-fullscreen');
    const btnRewind = playerWindow.querySelector('.btn-rewind');
    const btnForward = playerWindow.querySelector('.btn-forward');
    const btnMute = playerWindow.querySelector('.btn-mute');
    const btnOpen = playerWindow.querySelector('.btn-open');
    const progressBar = playerWindow.querySelector('.progress-bar');
    const progressPlayed = playerWindow.querySelector('.progress-played');
    const progressBuffer = playerWindow.querySelector('.progress-buffer');
    const timeCurrent = playerWindow.querySelector('.time-current');
    const timeDuration = playerWindow.querySelector('.time-duration');
    const volumeSlider = playerWindow.querySelector('.volume-slider');

    // 状态
    let isPlaying = false;
    let isMuted = false;

    // 播放/暂停图标（复用，避免重复 innerHTML）
    const PLAY_ICON = `<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor"><path d="M5 3l10 6-10 6V3z"/></svg>`;
    const PAUSE_ICON = `<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor"><rect x="4" y="3" width="3" height="12"/><rect x="11" y="3" width="3" height="12"/></svg>`;
    // 静音/有声图标
    const MUTE_ICON_ON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 5h2l4-4v14l-4-4H2V5z"/><path d="M12 4l4 8M16 4l-4 8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;
    const MUTE_ICON_OFF = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 5h2l4-4v14l-4-4H2V5z"/><path d="M12 4c1.5 1.5 1.5 6.5 0 8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;

    /**
     * 格式化时间
     */
    function formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * 更新进度条
     */
    function updateProgress() {
        if (video.duration) {
            const percent = (video.currentTime / video.duration) * 100;
            progressPlayed.style.width = percent + '%';
            timeCurrent.textContent = formatTime(video.currentTime);
        }
    }

    /**
     * 更新缓冲进度
     */
    function updateBuffer() {
        if (video.buffered.length > 0) {
            const bufferEnd = video.buffered.end(video.buffered.length - 1);
            const percent = (bufferEnd / video.duration) * 100;
            progressBuffer.style.width = percent + '%';
        }
    }

    /**
     * 播放/暂停切换
     */
    function togglePlay() {
        if (!video.src) return;
        if (video.paused) { video.play(); isPlaying = true; btnPlay.innerHTML = PAUSE_ICON; }
        else { video.pause(); isPlaying = false; btnPlay.innerHTML = PLAY_ICON; }
    }


    /**
     * 停止播放
     */
    function stop() {
        video.pause();
        video.currentTime = 0;
        isPlaying = false;
        btnPlay.innerHTML = PLAY_ICON;
    }

    /**
     * 切换静音
     */
    function toggleMute() {
        isMuted = !isMuted;
        video.muted = isMuted;
        btnMute.innerHTML = isMuted ? MUTE_ICON_ON : MUTE_ICON_OFF;
    }

    /**
     * 全屏切换
     */
    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            playerWindow.requestFullscreen().catch(err => {
                console.error('全屏失败:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }

    /**
     * 打开视频
     */
    async function openVideo() {
        try {
            if (window.WebStartOS?.vfs) {
                const file = await window.WebStartOS.vfs.showOpenFilePicker({
                    types: [{
                        description: '视频文件',
                        accept: { 'video/*': ['.mp4', '.webm', '.ogg', '.mov'] }
                    }]
                });
                
                if (file) {
                    const blob = await file.getFile();
                    const url = URL.createObjectURL(blob);
                    video.src = url;
                    video.load();
                    placeholder.style.display = 'none';
                }
            } else {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'video/*';
                input.onchange = (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const url = URL.createObjectURL(file);
                        video.src = url;
                        video.load();
                        placeholder.style.display = 'none';
                    }
                };
                input.click();
            }
        } catch (err) {
            console.error('打开视频失败:', err);
            alert('打开视频失败：' + err.message);
        }
    }

    // 事件绑定
    btnPlay.addEventListener('click', togglePlay);
    btnStop.addEventListener('click', stop);
    btnFullscreen.addEventListener('click', toggleFullscreen);
    btnMute.addEventListener('click', toggleMute);
    btnOpen.addEventListener('click', openVideo);

    btnRewind.addEventListener('click', () => {
        video.currentTime = Math.max(0, video.currentTime - 10);
    });

    btnForward.addEventListener('click', () => {
        video.currentTime = Math.min(video.duration, video.currentTime + 10);
    });

    // 进度条点击
    progressBar.addEventListener('click', (e) => {
        const rect = progressBar.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        video.currentTime = percent * video.duration;
    });

    // 音量调节
    volumeSlider.addEventListener('input', (e) => {
        video.volume = e.target.value / 100;
    });

    // 视频事件
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('progress', updateBuffer);
    video.addEventListener('loadedmetadata', () => {
        timeDuration.textContent = formatTime(video.duration);
    });
    video.addEventListener('ended', () => {
        isPlaying = false;
        btnPlay.innerHTML = PLAY_ICON;
    });

    // 键盘快捷键
    const onVideoKeydown = (e) => {
        if (!playerWindow.closest('.window.active')) return;
        
        switch (e.key) {
            case ' ':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                video.currentTime = Math.max(0, video.currentTime - 5);
                break;
            case 'ArrowRight':
                video.currentTime = Math.min(video.duration, video.currentTime + 5);
                break;
            case 'ArrowUp':
            case 'ArrowDown':
                e.preventDefault();
                video.volume = e.key === 'ArrowUp' ? Math.min(1, video.volume + 0.1) : Math.max(0, video.volume - 0.1);
                volumeSlider.value = video.volume * 100;
                break;
            case 'f':
                toggleFullscreen();
                break;
            case 'm':
                toggleMute();
                break;
        }
    };
    document.addEventListener('keydown', onVideoKeydown);

    // 双击全屏
    video.addEventListener('dblclick', toggleFullscreen);

    // 资源释放：视频播放器窗口关闭时移除全局键盘监听
    const onVideoUnload = (e) => {
        if (e.detail.id !== 'video-player') return;
        window.removeEventListener('plugin-unload', onVideoUnload);
        document.removeEventListener('keydown', onVideoKeydown);
    };
    window.addEventListener('plugin-unload', onVideoUnload);
})();
