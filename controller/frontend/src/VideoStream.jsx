import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { visionWebRTCConfigUrl, visionWebRTCOfferUrl } from "./visionSession.js";

const transportCache = new Map();
const KEEP_ALIVE_MS = 30000;
const CONNECT_TIMEOUT_MS = 12000;

function waitForIceGatheringComplete(peerConnection, signal) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      peerConnection.removeEventListener("icegatheringstatechange", check);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const check = () => {
      if (peerConnection.iceGatheringState === "complete") finish(resolve);
    };
    const abort = () => finish(reject, new DOMException("请求已取消", "AbortError"));
    const timer = window.setTimeout(() => finish(resolve), 3000);
    peerConnection.addEventListener("icegatheringstatechange", check);
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}

function closeTransport(sessionId, entry) {
  if (entry.closeTimer) window.clearTimeout(entry.closeTimer);
  entry.closeTimer = null;
  if (entry.connectTimer) window.clearTimeout(entry.connectTimer);
  entry.connectTimer = null;
  window.clearTimeout(entry.disconnectTimer);
  entry.abortController?.abort();
  entry.abortController = null;
  if (entry.peer) entry.peer.close();
  if (transportCache.get(sessionId) === entry) transportCache.delete(sessionId);
}

function notifyTransportError(entry, error) {
  for (const consumer of entry.consumers) {
    consumer.callbacksRef.current.onTransportError(error);
    consumer.callbacksRef.current.onError(error);
  }
}

function attachTransport(entry, consumer) {
  if (!entry.stream || !consumer.mediaRef.current) return;
  consumer.mediaRef.current.srcObject = entry.stream;
  consumer.mediaRef.current.play().catch(() => {});
  consumer.callbacksRef.current.onReady();
}

const VideoStream = forwardRef(function VideoStream({
  sessionId,
  workspacePrefix = "",
  clientId = "",
  quality = "hd",
  retry = 0,
  alt = "视觉视频",
  className = "video-stream",
  onReady = () => {},
  onError = () => {},
  onTransportError = () => {},
}, ref) {
  const cacheKey = `${workspacePrefix}:${sessionId}:${quality}`;
  const mediaRef = useRef(null);
  const peerRef = useRef(null);
  const callbacksRef = useRef({ onReady, onError, onTransportError });

  callbacksRef.current = { onReady, onError, onTransportError };
  useImperativeHandle(ref, () => mediaRef.current);

  function handleMediaError() {
    const current = transportCache.get(cacheKey);
    if (current) {
      closeTransport(cacheKey, current);
      callbacksRef.current.onTransportError(new Error("视频媒体解码失败，正在重连"));
    }
    callbacksRef.current.onError(new Error("视频媒体解码失败，正在重连"));
  }

  useEffect(() => {
    const consumer = { mediaRef, callbacksRef };
    let entry = transportCache.get(cacheKey);

    // A retry must retire the previous peer even when it is stuck in
    // "connecting" or still reports "connected" after media has stalled.
    if (retry > 0 && entry) {
      closeTransport(cacheKey, entry);
      entry = null;
    }
    if (!entry) {
      entry = {
        peer: null,
        stream: null,
        promise: null,
        closeTimer: null,
        connectTimer: null,
        abortController: null,
        consumers: new Set(),
      };
      transportCache.set(cacheKey, entry);
    }
    if (entry.closeTimer) {
      window.clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    entry.consumers.add(consumer);

    async function connect() {
      if (!sessionId) {
        return;
      }
      if (typeof window.RTCPeerConnection !== "function") {
        const error = new Error("当前浏览器不支持 WebRTC，未切换到其他视频流");
        notifyTransportError(entry, error);
        return;
      }

      try {
        if (entry.stream && entry.peer && entry.peer.connectionState !== "closed") {
          peerRef.current = entry.peer;
          attachTransport(entry, consumer);
          return;
        }
        if (!entry.promise) {
          const controller = new AbortController();
          entry.abortController = controller;
          entry.promise = (async () => {
            const configResponse = await fetch(visionWebRTCConfigUrl(), {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!configResponse.ok) throw new Error("WebRTC 配置不可用");
            const config = await configResponse.json();
            if (config.available === false) throw new Error("WebRTC 服务未启用");

            const peer = new window.RTCPeerConnection({
              iceServers: Array.isArray(config.iceServers) ? config.iceServers : [],
            });
            entry.peer = peer;
            entry.connectTimer = window.setTimeout(() => {
              if (peer.connectionState !== "connected") {
                notifyTransportError(entry, new Error("视频连接建立超时，正在重连"));
                closeTransport(cacheKey, entry);
              }
            }, CONNECT_TIMEOUT_MS);
            peer.addTransceiver("video", { direction: "recvonly" });
            peer.ontrack = (event) => {
              entry.stream = event.streams?.[0] || new MediaStream([event.track]);
              for (const track of entry.stream.getTracks()) {
                track.onended = () => {
                  if (transportCache.get(cacheKey) !== entry) return;
                  notifyTransportError(entry, new Error("视频轨道已结束，正在重连"));
                  closeTransport(cacheKey, entry);
                };
              }
              for (const currentConsumer of entry.consumers) {
                attachTransport(entry, currentConsumer);
              }
            };
            peer.onconnectionstatechange = () => {
              if (peer.connectionState === "connected") {
                window.clearTimeout(entry.connectTimer);
                entry.connectTimer = null;
              }
              window.clearTimeout(entry.disconnectTimer);
              const fail = () => {
                notifyTransportError(entry, new Error("视频网络连接中断，正在重连"));
                closeTransport(cacheKey, entry);
              };
              if (peer.connectionState === "failed") fail();
              else if (peer.connectionState === "disconnected") {
                entry.disconnectTimer = window.setTimeout(() => {
                  if (peer.connectionState === "disconnected") fail();
                }, 5000);
              }
            };

            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            await waitForIceGatheringComplete(peer, controller.signal);
            const response = await fetch(visionWebRTCOfferUrl().replace("/webrtc/offer", `${workspacePrefix}/webrtc/offer`), {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(workspacePrefix ? { "X-Fish-Client": clientId } : {}) },
              body: JSON.stringify({
                sessionId,
                quality,
                type: peer.localDescription.type,
                sdp: peer.localDescription.sdp,
              }),
              signal: controller.signal,
            });
            const answer = await response.json().catch(() => ({}));
            if (!response.ok || !answer.sdp || !answer.type) {
              throw new Error(answer.error?.message || "WebRTC 信令失败");
            }
            await peer.setRemoteDescription(answer);
          })();
        }
        await entry.promise;
        peerRef.current = entry.peer;
        attachTransport(entry, consumer);
      } catch (error) {
        window.clearTimeout(entry.connectTimer);
        entry.connectTimer = null;
        entry.abortController = null;
        if (entry.peer) entry.peer.close();
        if (transportCache.get(cacheKey) === entry) transportCache.delete(cacheKey);
        notifyTransportError(entry, error);
      }
    }

    connect();
    return () => {
      entry.consumers.delete(consumer);
      peerRef.current = null;
      if (entry.consumers.size === 0 && transportCache.get(cacheKey) === entry) {
        entry.closeTimer = window.setTimeout(() => {
          closeTransport(cacheKey, entry);
        }, KEEP_ALIVE_MS);
      }
    };
  }, [sessionId, quality, retry, workspacePrefix, clientId]);

  return (
    <video
      ref={mediaRef}
      className={className}
      autoPlay
      playsInline
      muted
      onLoadedMetadata={onReady}
      onError={handleMediaError}
      aria-label={alt}
    />
  );
});

export default VideoStream;
