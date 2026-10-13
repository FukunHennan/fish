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

  async function jsonResponse(path, options) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    return body;
  }

  function waitForIce(peer) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        peer.removeEventListener('icegatheringstatechange', check);
        reject(new Error('TURN 候选收集超时'));
      }, 12000);
      function check() {
        if (peer.iceGatheringState !== 'complete') return;
        clearTimeout(timeout);
        peer.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      peer.addEventListener('icegatheringstatechange', check);
    });
  }

  async function connect(url, handlers) {
    const fileName = fileNameFromUrl(url);
    const config = await jsonResponse('/api/vision/webrtc/replay/config');
    if (!config.available || !config.iceServers.length) throw new Error('Cloudflare TURN 不可用');
    const peer = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: 'relay' });
    let stopped = false;
    const session = {
      close() {
        if (stopped) return;
        stopped = true;
        peer.close();
      },
    };
    peer.addEventListener('connectionstatechange', () => {
      if (!stopped && peer.connectionState === 'failed') handlers.onError(new Error('TURN 回放连接失败'));
    });
    try {
      const channel = peer.createDataChannel('recording-download', { ordered: true });
      channel.binaryType = 'arraybuffer';
      handlers.onChannel(channel, session);
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);
      if (stopped) return session;
      const answer = await jsonResponse('/api/vision/webrtc/replay/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, mode: 'download', type: peer.localDescription.type, sdp: peer.localDescription.sdp }),
      });
      if (!stopped) await peer.setRemoteDescription(answer);
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
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

  async function download(url, onStatus) {
    let connection = null;
    try {
      const result = new Promise((resolve, reject) => {
        let fileInfo = null;
        let received = 0;
        let lastPercent = -1;
        let unacknowledged = 0;
        const chunks = [];
        connect(url, {
          onError: reject,
          onChannel(channel) {
            channel.addEventListener('open', () => channel.send('download'));
            channel.addEventListener('close', () => reject(new Error('TURN 下载连接已中断')));
            channel.addEventListener('message', (event) => {
              if (typeof event.data === 'string') {
                const message = JSON.parse(event.data);
                if (message.error) { reject(new Error(message.error)); return; }
                if (message.done) {
                  if (!fileInfo || received !== fileInfo.size) { reject(new Error('录像下载不完整')); return; }
                  const blobUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
                  const link = document.createElement('a');
                  link.href = blobUrl;
                  link.download = fileInfo.name;
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                  resolve();
                } else {
                  fileInfo = message;
                  onStatus(`正在通过 TURN 下载 ${fileInfo.name}…`);
                }
              } else if (fileInfo) {
                chunks.push(event.data);
                received += event.data.byteLength;
                if (received > fileInfo.size) reject(new Error('录像下载大小异常'));
                else {
                  unacknowledged += 1;
                  if (unacknowledged === 4) {
                    channel.send('ack');
                    unacknowledged = 0;
                  }
                  const percent = Math.round(received / fileInfo.size * 100);
                  if (percent !== lastPercent) {
                    lastPercent = percent;
                    onStatus(`TURN 下载 ${percent}%`);
                  }
                }
              }
            });
          },
        }).then((session) => { connection = session; }).catch(reject);
      });
      onStatus('正在连接 TURN 下载…');
      await result;
      onStatus('录像下载完成');
    } finally {
      if (connection) connection.close();
    }
  }

  window.FishReplayTransport = { play, download };
})();
