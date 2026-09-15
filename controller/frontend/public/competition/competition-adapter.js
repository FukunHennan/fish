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

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
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
    var email = account ? String(account.value).trim() : "";
    if (email && email.indexOf("@") < 0) email += "@example.com";
    return {
      email: email,
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
        ensureRefereeIntegration();
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
    // 优先使用裁判在签到环节分配的机器鱼归属
    return api("/api/competition/match")
      .then(function (payload) { return (payload && payload.match) || null; })
      .catch(function () { return null; })
      .then(function (match) {
        var assigned = {};
        if (match) {
          ["blue", "red"].forEach(function (side) {
            var team = match[side];
            if (!team || !team.players) return;
            team.players.forEach(function (player) {
              if (player.deviceId) assigned[String(player.slot).toUpperCase()] = player.deviceId;
            });
          });
        }
        var byOrder = {
          b1: state.devices[0].deviceId,
          b2: (state.devices[1] || state.devices[0]).deviceId,
        };
        var targets = {
          b1: assigned.B1 || byOrder.b1,
          b2: assigned.B2 || byOrder.b2,
        };
        if (!assigned.B1 && !assigned.B2) {
          setBadge("裁判尚未分配机器鱼，暂按在线顺序绑定", "warn");
        } else {
          var missing = [];
          if (assigned.B1 && !state.devices.some(function (d) { return d.deviceId === assigned.B1; })) missing.push("B1");
          if (assigned.B2 && !state.devices.some(function (d) { return d.deviceId === assigned.B2; })) missing.push("B2");
          if (missing.length) setBadge(missing.join("/") + " 分配的机器鱼当前不在线", "warn");
        }
        return applyBindings(targets);
      });
  }

  function applyBindings(targets) {
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
        ensureRefereeIntegration();
        refreshFishAssignments();
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- 裁判端
  // 裁判端设计稿的按钮是内联 onclick 的演示逻辑，无法直接反向绑定。
  // 这里注入一个真实比赛控制条，直接驱动后端裁判流程接口。
  var referee = { match: null, elapsedMs: 0, running: false, bar: null, poll: null, clickBound: false };

  function isRefereePage() {
    return !!document.getElementById("clock") || !!document.querySelector(".videoStage");
  }

  function fmtClock(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var minutes = Math.floor(total / 60), seconds = total % 60;
    return (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  }

  function stateText(state) {
    return ({
      waiting: "等待开始", signup: "签到中", ready: "可以开始",
      running: "进行中", paused: "已暂停", finished: "已结束",
    })[state] || state || "未知";
  }

  function refereeAction(action, body) {
    return api("/api/competition/match/" + action, { method: "POST", body: body || {} })
      .then(function () { return refreshReferee(); })
      .catch(function (error) { setBadge("裁判操作失败：" + error.message, "error"); });
  }

  function refreshReferee() {
    if (!isRefereePage()) return Promise.resolve();
    return api("/api/competition/match")
      .then(function (payload) {
        referee.match = payload.match;
        referee.elapsedMs = payload.elapsedMs || 0;
        referee.running = !!payload.running;
        paintReferee();
      })
      .catch(function () { /* 未登录等场景静默 */ });
  }

  function paintReferee() {
    if (!referee.bar || !referee.match) return;
    var match = referee.match;
    var clock = referee.bar.querySelector("#fishRefClock");
    var score = referee.bar.querySelector("#fishRefScore");
    var info = referee.bar.querySelector("#fishRefInfo");
    var toggle = referee.bar.querySelector("#fishRefToggle");
    if (clock) clock.textContent = fmtClock(referee.elapsedMs);
    if (score) score.textContent = match.blue.score + " : " + match.red.score;
    if (info) {
      info.textContent = (match.matchNo || "未建赛") + " · " + stateText(match.state)
        + " · " + (match.blue.name || "蓝队") + " vs " + (match.red.name || "红队");
    }
    if (toggle) toggle.textContent = referee.running ? "暂停" : "开始";
    // 同步设计稿界面上的比分与计时，避免与真实状态不一致
    syncText("blueScore", match.blue.score);
    syncText("redScore", match.red.score);
    syncText("blueQuick", match.blue.score);
    syncText("redQuick", match.red.score);
    syncText("clock", fmtClock(referee.elapsedMs));
    syncText("clockState", referee.running ? "进行中" : stateText(match.state));
  }

  function syncText(id, value) {
    var node = document.getElementById(id);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function ensureRefereeBar() {
    if (referee.bar || !document.body || !isRefereePage()) return;
    var bar = document.createElement("div");
    bar.id = "fishRefereeBar";
    bar.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:2147483000",
      "display:flex", "align-items:center", "gap:8px", "padding:8px 10px",
      "border-radius:12px", "font-size:12px", "color:#dff2ff",
      "font-family:system-ui,'Microsoft YaHei',sans-serif",
      "background:rgba(3,18,41,.92)", "border:1px solid rgba(120,200,255,.35)",
      "backdrop-filter:blur(8px)", "box-shadow:0 8px 24px rgba(0,0,0,.35)",
    ].join(";");
    bar.innerHTML =
      '<span id="fishRefInfo" style="opacity:.85;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
      '<b id="fishRefClock" style="font-variant-numeric:tabular-nums;font-size:15px">00:00</b>' +
      '<b id="fishRefScore" style="font-variant-numeric:tabular-nums;font-size:15px">0 : 0</b>' +
      '<button type="button" data-ref="blue+1" style="' + REF_BTN + '">蓝 +1</button>' +
      '<button type="button" data-ref="red+1" style="' + REF_BTN + '">红 +1</button>' +
      '<button type="button" id="fishRefToggle" data-ref="toggle" style="' + REF_BTN + '">开始</button>' +
      '<button type="button" data-ref="finish" style="' + REF_BTN + '">结束</button>';
    document.body.appendChild(bar);
    referee.bar = bar;
    refreshReferee();
    if (!referee.poll) referee.poll = setInterval(refreshReferee, 2000);
  }

  function ensureRefereeIntegration() {
    if (!isRefereePage()) return;
    ensureRefereeBar();
    if (!referee.clickBound) {
      document.addEventListener("click", handleRefereeClick, true);
      referee.clickBound = true;
    }
    refreshReferee();
    refreshFishAssignments();
  }

  var REF_BTN = [
    "border:1px solid rgba(120,200,255,.4)", "background:rgba(20,60,110,.7)",
    "color:#dff2ff", "border-radius:8px", "padding:5px 9px", "font-size:12px", "cursor:pointer",
  ].join(";");

  // ---------------------------------------------------------------- 签到鱼绑定
  // 裁判签到时为每个席位分配机器鱼，形成比赛期间的归属关系。
  function normalizeSlot(slot) {
    return String(slot || "").trim().toUpperCase();
  }

  function assignedToSlot(device, slot) {
    var normalized = normalizeSlot(slot);
    if (!device || !normalized) return false;
    if (normalizeSlot(device.slot) === normalized) return true;
    var assignedTo = normalizeSlot(device.assignedTo);
    return assignedTo === normalized || assignedTo.slice(-1 * normalized.length) === normalized;
  }

  function devicesForSlot(devices, slot) {
    return (devices || []).filter(function (device) {
      if (!device.online) return false;
      return !device.assignedTo || assignedToSlot(device, slot);
    });
  }

  function currentDeviceForSlot(devices, slot) {
    var list = devices || [];
    for (var index = 0; index < list.length; index += 1) {
      if (assignedToSlot(list[index], slot)) return list[index];
    }
    return null;
  }

  function deviceLabel(device) {
    return deviceName(device) || "未命名机器鱼";
  }

  function loadCompetitionDevices() {
    return api("/api/competition/devices").then(function (payload) {
      return (payload && payload.devices) || [];
    });
  }

  function paintSignupFish(devices) {
    document.querySelectorAll(".player").forEach(function (card) {
      var title = card.querySelector(".playerTop b");
      var slot = title ? normalizeSlot(String(title.textContent).split("·")[0]) : "";
      if (!slot) return;
      var current = currentDeviceForSlot(devices, slot);
      card.querySelectorAll(".meta").forEach(function (meta) {
        var label = meta.querySelector("span");
        var value = meta.querySelector("strong");
        if (label && value && label.textContent.trim() === "机器鱼") {
          value.textContent = current ? deviceLabel(current) : "未分配";
        }
      });
    });
  }

  function paintSelectFish(devices) {
    document.querySelectorAll(".selectPlayer[data-slot]").forEach(function (button) {
      var slot = button.getAttribute("data-slot");
      var current = currentDeviceForSlot(devices, slot);
      var available = devicesForSlot(devices, slot);
      var summary = current ? ("已分配：" + deviceLabel(current))
        : (available.length ? ("可分配：" + available.length + " 条") : "暂无可分配机器鱼");
      var preview = button.querySelector(".fishAssignPreview");
      if (!preview) {
        preview = document.createElement("small");
        preview.className = "fishAssignPreview";
        preview.style.cssText = "margin-top:2px;color:#7ee6c5;font-size:8px";
        var text = button.querySelector("div");
        if (text) text.appendChild(preview);
      }
      if (preview) preview.textContent = summary;
    });
  }

  function paintConfirmFish(devices, slot) {
    var current = currentDeviceForSlot(devices, slot);
    var field = document.getElementById("confirmFish");
    if (field && normalizeSlot(document.getElementById("confirmSlot") ? document.getElementById("confirmSlot").textContent : "") === normalizeSlot(slot)) {
      field.textContent = current ? deviceLabel(current) : "未分配";
    }
  }

  function refreshFishAssignments() {
    if (!isRefereePage()) return Promise.resolve();
    return loadCompetitionDevices()
      .then(function (devices) {
        paintSignupFish(devices);
        paintSelectFish(devices);
        var slotNode = document.getElementById("confirmSlot");
        if (slotNode) paintConfirmFish(devices, slotNode.textContent);
      })
      .catch(function () { /* 签到鱼列表失败不影响主界面 */ });
  }

  function injectFishSelect(slot) {
    var step = document.getElementById("confirmStep");
    if (!step || !slot) return;
    var row = step.querySelector("#fishAssignRow");
    if (!row) {
      row = document.createElement("div");
      row.id = "fishAssignRow";
      row.style.cssText = "margin-top:10px;display:flex;align-items:center;gap:8px";
      row.innerHTML =
        '<label style="font-size:12px;opacity:.85;white-space:nowrap">机器鱼</label>' +
        '<select id="fishAssignSelect" style="flex:1;min-width:0;padding:6px 8px;border-radius:6px;' +
        'background:#0b1b2e;color:#dff2ff;border:1px solid rgba(120,200,255,.35);font-size:12px"></select>' +
        '<span id="fishAssignHint" style="font-size:11px;opacity:.7;white-space:nowrap"></span>';
      step.appendChild(row);
    }
    var select = row.querySelector("#fishAssignSelect");
    var hint = row.querySelector("#fishAssignHint");
    select.setAttribute("data-slot", slot);
    if (hint) hint.textContent = "读取中…";
    return loadCompetitionDevices().then(function (list) {
      var available = devicesForSlot(list, slot);
      var currentDevice = currentDeviceForSlot(list, slot);
      var options = ['<option value="">（暂不分配）</option>'];
      available.forEach(function (device) {
        var mine = assignedToSlot(device, slot);
        var id = device.deviceId || device.id || "";
        var label = deviceLabel(device) + (mine ? "（本席位）" : "");
        options.push('<option value="' + escapeHtml(id) + '"' + (mine ? " selected" : "") + ">" + escapeHtml(label) + "</option>");
      });
      select.innerHTML = options.join("");
      if (currentDevice) select.value = currentDevice.deviceId || currentDevice.id || "";
      if (hint) {
        var onlineCount = list.filter(function (device) { return device.online; }).length;
        hint.textContent = available.length ? ("可分配 " + available.length + " 条")
          : (onlineCount ? "在线机器鱼均已分配" : "无在线机器鱼");
      }
      paintSignupFish(list);
      paintSelectFish(list);
      paintConfirmFish(list, slot);
      return currentDevice;
    }).catch(function () {
      if (hint) hint.textContent = "读取机器鱼失败";
    });
  }

  // 把裁判端设计稿自带的按钮接到后端（原逻辑保留，仅追加真实请求）
  function handleRefereePrototypeClick(event) {
    var target = event.target;
    if (!target || !target.closest) return false;

    var scoreButton = target.closest("[data-score]");
    if (scoreButton) {
      var delta = Number(scoreButton.getAttribute("data-score"));
      var side = scoreButton.getAttribute("data-team");
      if (side && delta) refereeAction("score", { side: side, delta: delta });
      return true;
    }
    if (target.closest("#startBtn")) {
      refereeAction("clock", { action: "start" });
      return true;
    }
    if (target.closest("#pauseBtn")) {
      // 设计稿的按钮是“暂停/继续”切换
      refereeAction("clock", { action: referee.running ? "pause" : "start" });
      return true;
    }
    if (target.closest("#endBtn")) {
      refereeAction("finish");
      return true;
    }
    var selectPlayer = target.closest(".selectPlayer");
    if (selectPlayer && selectPlayer.getAttribute("data-slot")) {
      var pickedSlot = selectPlayer.getAttribute("data-slot");
      setTimeout(function () { injectFishSelect(pickedSlot); }, 60);
      return false;   // 保留原型自身的签到弹窗流程
    }
    if (target.closest("#confirmBtn")) {
      var slotNode = document.getElementById("confirmSlot");
      var slot = slotNode ? String(slotNode.textContent).trim() : "";
      if (slot) {
        var side = /^B/i.test(slot) ? "blue" : "red";
        var select = document.getElementById("fishAssignSelect");
        var deviceId = select ? select.value : "";
        var chain = Promise.resolve();
        if (deviceId) {
          // 先建立归属，再记录签到
          chain = chain.then(function () {
            return refereeAction("assign", { side: side, slot: slot, deviceId: deviceId });
          });
        } else {
          // 选择“暂不分配”即解除该席位的机器鱼归属
          chain = chain.then(function () {
            return refereeAction("unassign", { side: side, slot: slot });
          });
        }
        chain.then(function () {
          return refereeAction("signin", { side: side, slot: slot, signedIn: true });
        });
      }
      return true;
    }
    return false;
  }

  function handleRefereeClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (handleRefereePrototypeClick(event)) return;
    var button = target.closest("[data-ref]");
    if (!button) return;
    var action = button.getAttribute("data-ref");
    if (action === "blue+1") refereeAction("score", { side: "blue", delta: 1 });
    else if (action === "red+1") refereeAction("score", { side: "red", delta: 1 });
    else if (action === "toggle") refereeAction("clock", { action: referee.running ? "pause" : "start" });
    else if (action === "finish") refereeAction("finish");
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

    observeRenders();
    ensureRefereeIntegration();

    checkSession().then(function (authenticated) {
      if (authenticated) {
        // 已有会话：直接进入终端，跳过设计稿的登录层
        var layer = document.getElementById("teamAuthLayer");
        if (layer) layer.hidden = true;
        if (!isRefereePage() && location.hash !== "#control") location.hash = "control";
        setBadge("已登录：" + (state.user.email || "当前账号"), "ok");
        refreshDevices();
        ensureVideoSurface();
        ensureRefereeIntegration();
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
