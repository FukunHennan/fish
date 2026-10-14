(function () {
  'use strict';

  function fileNameFromUrl(url) {
    const prefix = '/api/vision/recordings/files/';
    if (typeof url !== 'string' || !url.startsWith(prefix)) throw new Error('录像地址无效');
    const fileName = decodeURIComponent(url.slice(prefix.length));
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || !fileName.toLowerCase().endsWith('.mp4')) {
      throw new Error('录像文件名无效');
    }
    return fileName;
  }

  function play(url, video, onStatus, startMs = 0) {
    let session = null;
    let cancelled = false;
    const controller = {
      close() {
        cancelled = true;
        if (session) session.close();
        video.pause();
        video.srcObject = null;
      },
    };
    video.muted = true;
    video.playsInline = true;
    // Playback uses the HTTP endpoint so the browser can buffer MP4 ranges.
    video.srcObject = null;
    video.src = url;
    video.currentTime = startMs / 1000;
    video.preload = 'auto';
    onStatus('正在加载录像…');
    video.play().then(() => { if (!cancelled) onStatus('正在播放录像'); })
      .catch(() => { if (!cancelled) onStatus('点击画面开始播放'); });
    return controller;
  }

  async function download(url, onStatus = () => {}) {
    const fileName = fileNameFromUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    let blobUrl = null;
    let link = null;
    try {
      onStatus('正在下载录像，请稍候…');
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || (response.status === 401 ? '登录已失效，请重新登录后下载' : '录像下载失败（HTTP ' + response.status + '）'));
      }
      if (!(response.headers.get('Content-Type') || '').toLowerCase().startsWith('video/mp4')) {
        throw new Error('服务器未返回录像文件，请重新登录或检查录像服务');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('录像文件为空');
      blobUrl = URL.createObjectURL(blob);
      link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      onStatus('录像已接收，已交给浏览器保存');
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('录像下载超时，请检查网络后重试');
      throw error;
    } finally {
      clearTimeout(timeout);
      if (link) link.remove();
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
  }

  window.FishReplayTransport = { play, download };
})();
