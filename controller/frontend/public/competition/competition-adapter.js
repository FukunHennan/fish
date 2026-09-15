/*
 * 赛事端后端适配层
 * ------------------------------------------------------------------
 * 原界面是纯静态设计稿（无任何后端调用）。本文件在不改动界面的前提下
 * 注入真实能力：
 *   1. 战队登录   -> POST /api/auth/login
 *   2. 设备发现   -> GET  /api/devices
 *   3. 设备绑定   -> POST /api/leases          (B1/B2 各绑定一台真实设备)
 *   4. 运动控制   -> POST /api/command/realtime (含松键停止)
 *   5. 状态订阅   -> SSE  /api/events
 *   6. 设备信息   -> 用真实数据替换界面里的演示文案
 * 全部通过事件委托实现，因此界面重建 DOM 后依然生效。
 */
(function () {
  "use strict";

  var CLIENT_ID = "competition-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now();
  var PLAYERS = ["b1", "b2"];
  var MOTION_ACTIONS = { forward: 1, left: 1, right: 1, stop: 1, idle: 1 };
  var DEFAULT_PARAMS = { frequency: 2.5, amplitude: 28 };

  var state = {
    user: null,
    devices: [],
    bound: {},       // player -> deviceId
    sequence: {},    // deviceId -> sequence
    ready: false,
  };

  // ---------------------------------------------------------------- 工具
  function api(path, options) {
    options = options || {};
    return fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: options.method || "GET",
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
        if (!response.ok) {
          var message = (data && data.message) || (typeof data === "string" && data) || ("HTTP " + response.status);
          throw new Error(message);
        }
        return data;
      });
    });
  }

  function deviceList(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.devices)) return payload.devices;
    return [];
  }

  function deviceName(device) {
    if (!device) return "";
    return device.name || device.deviceId || device.id || "";
  }

  // ---------------------------------------------------------------- 状态角标
  var badge = null;
  function setBadge(text, tone) {
    if (!badge || !document.body) return;
    badge.textContent = text;
    badge.dataset.tone = tone || "info";
  }

  function ensureBadge() {
    if (badge || !document.body) return;
    badge = document.createElement("div");
    badge.id = "fishBackendBadge";
    badge.style.cssText = [
      "position:fixed", "left:14px", "bottom:14px", "z-index:2147483000",
      "padding:7px 12px", "border-radius:999px", "font-size:12px", "line-height:1.3",
      "font-family:system-ui,'Microsoft YaHei',sans-serif",
      "background:rgba(3,18,41,.86)", "color:#bfe9ff",
      "border:1px solid rgba(120,200,255,.35)", "backdrop-filter:blur(6px)",
      "pointer-events:none", "max-width:70vw", "white-space:nowrap",
      "overflow:hidden", "text-overflow:ellipsis",
    ].join(";");
    document.body.appendChild(badge);
    setBadge("后端连接中…", "info");
  }

  // ---------------------------------------------------------------- 认证
  function loginCard() { return document.getElementById("teamLoginCard"); }
  function confirmCard() { return document.getElementById("teamConfirmCard"); }

  function showLoginError(message) {
    var card = loginCard();
    if (!card) return;
    var box = card.querySelector(".teamAuthError");
    if (!box) {
      box = document.createElement("p");
      box.className = "teamAuthError";
      box.style.cssText = "margin:10px 0 0;color:#ffb0b0;font-size:12px;";
      card.appendChild(box);
    }
    box.textContent = message;
  }

  function readCredentials() {
    var account = document.getElementById("teamAccountInput");
    var password = document.querySelector("#teamLoginCard input[type=password]");
    return {
      email: account ? String(account.value).trim() : "",
      password: password ? String(password.value) : "",
    };
  }

  function checkSession() {
    return api("/api/auth/me")
      .then(function (data) {
        if (data && data.authenticated) {
          state.user = data.user;
          return true;
        }
        return false;
      })
      .catch(function () { return false; });
  }

  function doLogin(event) {
    var credentials = readCredentials();
    if (!credentials.email || !credentials.password) {
      showLoginError("请输入战队账号与密码");
      return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
    setBadge("正在登录…", "info");
    api("/api/auth/login", { method: "POST", body: credentials })
      .then(function (result) {
        state.user = result.user;
        setBadge("已登录：" + (state.user.email || "") + "（等待绑定设备）", "ok");
        if (loginCard()) loginCard().hidden = true;
        if (confirmCard()) confirmCard().hidden = false;
        ensureVideoSurface();
        observeRenders();
        return refreshDevices();
      })
      .catch(function (error) {
        setBadge("登录失败：" + error.message, "error");
        showLoginError("登录失败：" + error.message);
      });
  }

  // ---------------------------------------------------------------- 设备
  function refreshDevices() {
    return api("/api/devices")
      .then(function (payload) {
        state.devices = deviceList(payload).filter(function (device) { return device.online; });
        state.ready = true;
        return bindPlayers();
      })
      .catch(function (error) {
        setBadge("设备列表读取失败：" + error.message, "error");
      });
  }

  function acquire(deviceId) {
    return api("/api/leases", {
      method: "POST",
      body: { deviceId: deviceId, clientId: CLIENT_ID },
    });
  }

  function release(deviceId) {
    return api("/api/leases", {
      method: "DELETE",
      body: { deviceId: deviceId, clientId: CLIENT_ID },
    }).catch(function () { /* 释放失败不阻塞界面 */ });
  }

  function bindPlayers() {
    if (!state.devices.length) {
      setBadge("未发现在线机器鱼，请检查设备电源与网络", "warn");
      return Promise.resolve();
    }
    // B1 -> 第一台在线设备，B2 -> 第二台；不足时退化为同一台
    var targets = {
      b1: state.devices[0].deviceId,
      b2: (state.devices[1] || state.devices[0]).deviceId,
    };
    return Promise.all(PLAYERS.map(function (player) {
      var deviceId = targets[player];
      if (!deviceId) return null;
      if (state.bound[player] === deviceId) return null;
      return acquire(deviceId)
        .then(function () {
          state.bound[player] = deviceId;
          state.sequence[deviceId] = 0;
        })
        .catch(function (error) {
          setBadge(player.toUpperCase() + " 绑定失败：" + error.message, "error");
        });
    })).then(function () {
      var pairs = PLAYERS
        .filter(function (player) { return state.bound[player]; })
        .map(function (player) { return player.toUpperCase() + " → " + state.bound[player]; });
      setBadge(pairs.length ? "已绑定 " + pairs.join("　") : "未绑定设备", pairs.length ? "ok" : "warn");
      paintDeviceInfo();
    });
  }

  // ---------------------------------------------------------------- 运动
  function currentDevice(player) {
    return state.bound[player] || null;
  }

  function sendMotion(player, action) {
    var deviceId = currentDevice(player);
    if (!deviceId) {
      setBadge(player.toUpperCase() + " 尚未绑定设备", "warn");
      return;
    }
    if (!MOTION_ACTIONS[action]) return;
    var stop = action === "stop";
    var sequence = (state.sequence[deviceId] || 0) + 1;
    state.sequence[deviceId] = sequence;
    var body = {
      deviceId: deviceId,
      clientId: CLIENT_ID,
      mode: action,
      sequence: sequence,
      frequency: stop ? 0.3 : DEFAULT_PARAMS.frequency,
    };
    if (stop) {
      body.amplitude = 0;
      body.bias = 0;
    } else {
      body.amplitude = DEFAULT_PARAMS.amplitude;
    }
    api("/api/command/realtime", { method: "POST", body: body })
      .then(function () { setBadge(player.toUpperCase() + " " + action + " → " + deviceId, "ok"); })
      .catch(function (error) { setBadge(player.toUpperCase() + " 命令被拒绝：" + error.message, "error"); });
  }

  function stopAll(reason) {
    PLAYERS.forEach(function (player) {
      if (state.bound[player]) sendMotion(player, "stop");
    });
    if (reason) setBadge(reason, "warn");
  }

  // ---------------------------------------------------------------- 界面回填
  function paintDeviceInfo() {
    if (!document.body) return;
    var labels = { b1: state.bound.b1, b2: state.bound.b2 };
    PLAYERS.forEach(function (player) {
      var deviceId = labels[player];
      if (!deviceId) return;
      var device = state.devices.filter(function (item) { return item.deviceId === deviceId; })[0];
      var text = deviceName(device) || deviceId;
      // 替换卡片中的演示设备名（如 Fish-B1-03）
      var nodes = document.querySelectorAll(".matchPlayerCard, .deviceTestCard");
      Array.prototype.forEach.call(nodes, function (card) {
        var marks = card.querySelectorAll("small,span,b,p");
        Array.prototype.forEach.call(marks, function (node) {
          if (/^Fish-B[12]-\d+$/.test(node.textContent.trim())) node.textContent = text;
        });
      });
    });
  }

  // ---------------------------------------------------------------- 视频
  // 把后端 WebRTC 画面接到界面的“实时赛场”区域。共享视觉会话提供赛场
  // 画面，因此使用 root 会话；连接建立后只重新挂载 video 元素，
  // 页面切换不会重建媒体连接。
  var video = { peer: null, stream: null, sessionId: null, timer: null, connecting: false };

  function videoSurface() {
    // 选手端是 poolStage，裁判端的 .videoStage 自带 video 样式
    return document.querySelector(".poolStage.matchPool")
      || document.querySelector(".poolStage")
      || document.querySelector(".videoStage");
  }

  function waitForIce(peer) {
    return new Promise(function (resolve) {
      if (peer.iceGatheringState === "complete") return resolve();
      var settled = false;
      function finish() { if (settled) return; settled = true; resolve(); }
      peer.addEventListener("icegatheringstatechange", function () {
        if (peer.iceGatheringState === "complete") finish();
      });
      setTimeout(finish, 1500);
    });
  }

  function scheduleVideoReconnect(reason, delay) {
    if (video.timer) return;
    video.timer = setTimeout(function () {
      video.timer = null;
      if (video.peer) { try { video.peer.close(); } catch (e) { /* 忽略 */ } }
      video.peer = null;
      video.stream = null;
      connectVideo();
    }, delay || 3000);
    if (reason) setBadge("视频重连中：" + reason, "warn");
  }

  function connectVideo() {
    if (video.connecting || video.peer) return;
    video.connecting = true;
    api("/api/vision/sessions/current")
      .then(function (payload) {
        var session = payload && (payload.data || payload);
        if (!session || !session.sessionId) throw new Error("视觉会话尚未建立");
        video.sessionId = session.sessionId;
        return api("/api/vision/webrtc/config");
      })
      .then(function (config) {
        if (config && config.available === false) throw new Error("WebRTC 服务未启用");
        var peer = new window.RTCPeerConnection({
          iceServers: (config && Array.isArray(config.iceServers)) ? config.iceServers : [],
        });
        video.peer = peer;
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.ontrack = function (event) {
          video.stream = (event.streams && event.streams[0]) || new window.MediaStream([event.track]);
          mountVideoSurface();
        };
        peer.onconnectionstatechange = function () {
          if (peer.connectionState === "failed") scheduleVideoReconnect("连接失败");
          else if (peer.connectionState === "disconnected") {
            setTimeout(function () {
              if (peer.connectionState === "disconnected") scheduleVideoReconnect("连接中断");
            }, 4000);
          } else if (peer.connectionState === "connected") {
            setBadge("赛场画面已接入", "ok");
          }
        };
        return peer.createOffer()
          .then(function (offer) { return peer.setLocalDescription(offer); })
          .then(function () { return waitForIce(peer); })
          .then(function () {
            return api("/api/vision/webrtc/offer", {
              method: "POST",
              body: {
                sessionId: video.sessionId,
                quality: "smooth",
                type: peer.localDescription.type,
                sdp: peer.localDescription.sdp,
              },
            });
          })
          .then(function (answer) {
            if (!answer || !answer.sdp) throw new Error("视频信令失败");
            return peer.setRemoteDescription(answer);
          });
      })
      .catch(function (error) {
        // 没有摄像头/未启动视觉时属于正常等待状态，放慢重试避免刷屏
        var waiting = /会话尚未建立/.test(error.message);
        setBadge(waiting ? "等待视觉会话（请先在控制台启动摄像头）" : "视频接入失败：" + error.message,
                 waiting ? "info" : "error");
        scheduleVideoReconnect(waiting ? null : error.message, waiting ? 10000 : 3000);
      })
      .then(function () { video.connecting = false; });
  }

  function mountVideoSurface() {
    var stage = videoSurface();
    if (!stage) return;
    var element = stage.querySelector("video[data-fish-video]");
    if (!element) {
      element = document.createElement("video");
      element.setAttribute("data-fish-video", "1");
      element.autoplay = true;
      element.muted = true;
      element.setAttribute("playsinline", "");
      if (!stage.classList.contains("videoStage")) {
        // 选手端的水池是装饰层，视频作为底层铺满
        element.style.cssText = [
          "position:absolute", "inset:0", "width:100%", "height:100%",
          "object-fit:contain", "z-index:0", "background:transparent",
          "pointer-events:none",
        ].join(";");
      }
      // 裁判端 .videoStage video 已由页面样式定义，无需内联样式
      stage.insertBefore(element, stage.firstChild);
    }
    if (video.stream && element.srcObject !== video.stream) {
      element.srcObject = video.stream;
      var played = element.play();
      if (played && played.catch) played.catch(function () { /* 自动播放被拦截时忽略 */ });
    }
  }

  function ensureVideoSurface() {
    if (!state.user) return;       // 未登录不请求视觉接口
    mountVideoSurface();
    if (!video.peer) connectVideo();
  }

  function observeRenders() {
    if (typeof window.MutationObserver !== "function" || !document.body) return;
    var pending = null;
    var observer = new window.MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () {
        pending = null;
        ensureVideoSurface();
        paintDeviceInfo();
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- SSE
  function subscribe() {
    if (typeof window.EventSource !== "function") return;
    var source = new window.EventSource("/api/events");
    source.addEventListener("devices", function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { return; }
      state.devices = deviceList(payload).filter(function (device) { return device.online; });
      paintDeviceInfo();
      // 设备掉线立即停止对应玩家
      PLAYERS.forEach(function (player) {
        var deviceId = state.bound[player];
        if (!deviceId) return;
        var online = state.devices.some(function (device) { return device.deviceId === deviceId; });
        if (!online) {
          delete state.bound[player];
          setBadge(player.toUpperCase() + " 设备已离线，控制已停止", "warn");
        }
      });
    });
    source.addEventListener("error", function () { /* 浏览器会自动重连 */ });
  }

  // ---------------------------------------------------------------- 事件接入
  var KEY_TO_PLAYER = {
    w: "b1", a: "b1", d: "b1", s: "b1", " ": "b1",
    arrowup: "b2", arrowdown: "b2", arrowleft: "b2", arrowright: "b2", enter: "b2",
  };

  function install() {
    ensureBadge();

    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      if (target.closest("#teamLoginNext")) { doLogin(event); return; }

      if (target.closest("#teamEnterTerminal")) {
        // 放行界面切换，同时把真实设备绑定到两名队员
        setBadge("正在绑定设备…", "info");
        refreshDevices();
        return;
      }

      var control = target.closest("[data-control-player][data-control-action]");
      if (control) {
        sendMotion(
          control.getAttribute("data-control-player"),
          control.getAttribute("data-control-action")
        );
        return;
      }
    }, true);

    // 松键停止：原型会在 keyup 时更新界面，这里补上真实停止命令
    document.addEventListener("keyup", function (event) {
      var player = KEY_TO_PLAYER[String(event.key).toLowerCase()];
      if (player && state.bound[player]) sendMotion(player, "stop");
    }, true);

    window.addEventListener("pagehide", function () {
      PLAYERS.forEach(function (player) {
        if (state.bound[player]) release(state.bound[player]);
      });
    });

    checkSession().then(function (authenticated) {
      if (authenticated) {
        // 已有会话：直接进入终端，跳过设计稿的登录层
        var layer = document.getElementById("teamAuthLayer");
        if (layer) layer.hidden = true;
        if (location.hash !== "#control") location.hash = "control";
        setBadge("已登录：" + (state.user.email || "当前账号"), "ok");
        refreshDevices();
        ensureVideoSurface();
        observeRenders();
      } else {
        setBadge("请先登录战队账号", "info");
      }
      subscribe();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
