/*
 * 赛事端后端适配层
 * ------------------------------------------------------------------
 * 原界面是纯静态设计稿（无任何后端调用）。本文件在不改动界面的前提下
 * 注入真实能力：
 *   1. 战队登录   -> POST /api/auth/login
 *   2. 设备发现   -> GET  /api/devices
 *   3. 设备绑定   -> POST /api/leases          (B1/B2 各绑定一台真实设备)
 *   4. 运动控制   -> WebSocket /ws/control (含松键停止)
 *   5. 状态订阅   -> SSE  /api/events
 *   6. 设备信息   -> 用真实数据替换界面里的演示文案
 * 全部通过事件委托实现，因此界面重建 DOM 后依然生效。
 */
(function () {
  "use strict";

  var CLIENT_ID = "";
  try {
    CLIENT_ID = window.sessionStorage.getItem("fish-webrtc-client-id") || "";
    if (!CLIENT_ID) {
      CLIENT_ID = "competition-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now();
      window.sessionStorage.setItem("fish-webrtc-client-id", CLIENT_ID);
    }
  } catch (e) {
    CLIENT_ID = "competition-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now();
  }
  var PLAYERS = ["b1", "b2"];
  var playerSeatIndexes = { b1: 1, b2: 2 };
  try {
    var savedPlayerSeats = JSON.parse(window.sessionStorage.getItem("fish-player-seat-indexes") || "{}");
    var savedB1Seat = Number(savedPlayerSeats.b1);
    var savedB2Seat = Number(savedPlayerSeats.b2);
    if (
      (savedB1Seat === 1 || savedB1Seat === 2) &&
      (savedB2Seat === 1 || savedB2Seat === 2) &&
      savedB1Seat !== savedB2Seat
    ) {
      playerSeatIndexes.b1 = savedB1Seat;
      playerSeatIndexes.b2 = savedB2Seat;
    }
  } catch (_) {}
  var MOTION_ACTIONS = { forward: 1, left: 1, right: 1, stop: 1, idle: 1 };
  var motionTuning = {
    b1: { frequency: 2.5, amplitudePercent: 60 },
    b2: { frequency: 2.5, amplitudePercent: 60 },
  };
  try {
    var savedMotionTuning = JSON.parse(window.localStorage.getItem("fish-player-motion-settings") || "{}");
    PLAYERS.forEach(function (player) {
      var saved = savedMotionTuning[player] || {};
      var frequency = Number(saved.frequency);
      var amplitudePercent = Number(saved.amplitudePercent);
      if (Number.isFinite(frequency)) motionTuning[player].frequency = Math.max(0.3, Math.min(5, frequency));
      if (Number.isFinite(amplitudePercent)) motionTuning[player].amplitudePercent = Math.max(0, Math.min(100, amplitudePercent));
    });
  } catch (_) {}
  var activeMotion = {};
  // Public-network control must not create an unbounded fetch backlog. Keep
  // one request in flight per fish and replace queued frames with the latest
  // key state instead.
  var motionTransport = {
    b1: { active: false, pending: null },
    b2: { active: false, pending: null },
  };
  var controlSocket = null;
  var controlSocketPromise = null;
  var controlSocketRetryAt = 0;
  var controlSocketLastMessageAt = 0;
  var controlSocketLastSendAt = 0;

  function controlSocketUrl() {
    var scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    return scheme + "//" + window.location.host + "/ws/control";
  }

  function ensureControlSocket() {
    if (typeof WebSocket === "undefined") return Promise.reject(new Error("WebSocket unavailable"));
    if (controlSocket && controlSocket.readyState === WebSocket.OPEN) {
      // The server sends WebSocket pings and closes dead connections. Do not
      // tear down a healthy socket merely because the controls were idle.
      return Promise.resolve(controlSocket);
    }
    if (controlSocketPromise) return controlSocketPromise;
    if (Date.now() < controlSocketRetryAt) return Promise.reject(new Error("control socket backoff"));
    controlSocketPromise = new Promise(function (resolve, reject) {
      var socket;
      try { socket = new WebSocket(controlSocketUrl()); } catch (error) { reject(error); return; }
      var settled = false;
      socket.onopen = function () {
        settled = true;
        controlSocket = socket;
        controlSocketLastMessageAt = Date.now();
        resolve(socket);
      };
      socket.onmessage = function (event) {
        controlSocketLastMessageAt = Date.now();
        var frame;
        try { frame = JSON.parse(event.data); } catch (_) { return; }
        var result = frame && frame.result;
        if (!frame || frame.status !== 409 || !result || !frame.deviceId) return;
        PLAYERS.forEach(function (player) {
          if (sameDeviceId(currentDevice(player), frame.deviceId)) recoverPlayerLease(player, new Error(result.message || "控制权已失效"));
        });
      };
      socket.onerror = function () {
        controlSocketRetryAt = Date.now() + 1000;
        if (!settled) reject(new Error("control socket unavailable"));
      };
      socket.onclose = function () {
        if (controlSocket === socket) controlSocket = null;
        controlSocketPromise = null;
        controlSocketRetryAt = Date.now() + 500;
        if (!settled) reject(new Error("control socket closed"));
      };
    }).finally(function () { controlSocketPromise = null; });
    return controlSocketPromise;
  }

  function sendRealtimeFrame(body) {
    return ensureControlSocket().then(function (socket) {
      controlSocketLastSendAt = Date.now();
      socket.send(JSON.stringify(body));
      return true;
    });
  }
  var activePointers = {};
  var heldInputs = { b1: {}, b2: {} };
  var inputOrder = 0;

  var state = {
    user: null,
    authenticated: false,
    devices: [],
    competitionDevices: [],
    match: null,
    bound: {},       // player -> deviceId
    sequence: {},    // deviceId -> sequence
    ready: false,
  };

  var lastDeviceBadge = "后端连接中…";
  var lastDeviceTone = "info";
  var lastReadinessAvailability = {};
  var lastPlayerReadiness = {};
  var lastObservedFieldLocked = null;
  var logoutPending = false;
  var activeTeamSide = null;
  try {
    var savedTeamSide = window.sessionStorage.getItem("fish-active-team-side");
    if (savedTeamSide === "blue" || savedTeamSide === "red") activeTeamSide = savedTeamSide;
  } catch (_) {}
  var renderRefreshTimer = null;
  var renderNavigationBound = false;
  var playerLeaseTimer = null;
  var playerLeaseRefreshPending = false;
  var playerLeaseRefreshQueued = false;
  var playerLeaseRecoveryPending = {};

  // ---------------------------------------------------------------- 工具
  function api(path, options) {
    options = options || {};
    return fetch(path, {
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, options.headers || {}),
      method: options.method || "GET",
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
        if (!response.ok) {
          var message = (data && data.message) || (typeof data === "string" && data) || ("HTTP " + response.status);
          var error = new Error(message);
          error.status = response.status;
          error.data = data;
          throw error;
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

  // MAC is the only command identity. Keep the original spelling for API
  // requests, but compare IDs case-insensitively across persisted assignments
  // and freshly registered devices.
  function deviceIdOf(value) {
    if (value == null) return "";
    if (typeof value === "object") value = value.deviceId || value.id || "";
    return String(value).trim();
  }

  function sameDeviceId(left, right) {
    var a = deviceIdOf(left);
    var b = deviceIdOf(right);
    return !!a && !!b && a.toUpperCase() === b.toUpperCase();
  }

  function findDevice(deviceId) {
    var target = deviceIdOf(deviceId);
    if (!target) return null;
    return (state.devices || []).filter(function (device) { return sameDeviceId(device, target); })[0] || null;
  }

  function liveDeviceId(deviceId) {
    var device = findDevice(deviceId);
    return device ? deviceIdOf(device) : deviceIdOf(deviceId);
  }

  function deviceName(device) {
    if (!device) return "";
    var deviceId = String(device.deviceId || device.id || "").trim();
    var aliases = {};
    try { aliases = JSON.parse(window.localStorage.getItem("fish-controller-device-aliases-v1") || "{}"); } catch (e) { aliases = {}; }
    if (deviceId && !aliases[deviceId]) {
      var aliasKey = Object.keys(aliases).filter(function (key) { return sameDeviceId(key, deviceId); })[0];
      if (aliasKey) deviceId = aliasKey;
    }
    return (deviceId && aliases[deviceId]) || device.name || deviceId;
  }

  function shortAccount(email) {
    return String(email || "").split("@")[0] || "";
  }

  function currentTeamSide() {
    var text = ((state.user && (state.user.name + " " + state.user.email)) || "").toLowerCase();
    if (text.indexOf("红队") >= 0 || text.indexOf("team-red") >= 0) return "red";

    // A browser may retain an old team selection while the server has moved
    // the live assignment. Resolve the account/roster first, then only honor
    // the saved selection when it is not contradicted by online assignments.
    if (state.match && state.user) {
      var email = String(state.user.email || "").toLowerCase();
      var name = String(state.user.name || "").trim();
      for (var sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        var side = sideIndex === 0 ? "blue" : "red";
        var players = state.match[side] && state.match[side].players || [];
        if (players.some(function (player) {
          return (email && String(player.email || "").toLowerCase() === email) ||
            (name && String(player.name || "").trim() === name);
        })) return side;
      }
      var onlineAssigned = { blue: 0, red: 0 };
      ["blue", "red"].forEach(function (side) {
        var players = state.match[side] && state.match[side].players || [];
        players.forEach(function (player) {
          if (!player.deviceId) return;
          if (state.devices.some(function (device) {
            return sameDeviceId(device, player.deviceId) && device.online;
          })) onlineAssigned[side] += 1;
        });
      });
      if (activeTeamSide === "blue" || activeTeamSide === "red") {
        var otherSide = activeTeamSide === "blue" ? "red" : "blue";
        if (onlineAssigned[activeTeamSide] === 0 && onlineAssigned[otherSide] > 0) return otherSide;
        return activeTeamSide;
      }
      if (onlineAssigned.red > 0 && onlineAssigned.blue === 0) return "red";
      if (onlineAssigned.blue > 0 && onlineAssigned.red === 0) return "blue";
    }
    if (activeTeamSide === "blue" || activeTeamSide === "red") return activeTeamSide;
    return "blue";
  }

  function slotForPlayer(player) {
    var prefix = currentTeamSide() === "red" ? "R" : "B";
    var seatIndex = playerSeatIndexes[player] === 2 ? 2 : 1;
    return prefix + seatIndex;
  }

  function savePlayerSeats() {
    try {
      window.sessionStorage.setItem("fish-player-seat-indexes", JSON.stringify(playerSeatIndexes));
    } catch (_) {}
  }

  function paintSeatSelector(select, localPlayer) {
    if (!select || PLAYERS.indexOf(localPlayer) < 0) return;
    var prefix = currentTeamSide() === "red" ? "R" : "B";
    var optionSignature = prefix + "1," + prefix + "2";
    if (select.dataset.options !== optionSignature) {
      select.replaceChildren();
      [1, 2].forEach(function (seatIndex) {
        var option = document.createElement("option");
        option.value = String(seatIndex);
        option.textContent = prefix + seatIndex;
        select.appendChild(option);
      });
      select.dataset.options = optionSignature;
    }
    select.value = String(playerSeatIndexes[localPlayer] === 2 ? 2 : 1);
    select.disabled = false;
    select.title = "选择当前控制位对应的" + (prefix === "R" ? "红队" : "蓝队") + "席位";
  }

  function selectPlayerSeat(localPlayer, rawSeatIndex) {
    if (PLAYERS.indexOf(localPlayer) < 0) return;
    var seatIndex = Number(rawSeatIndex);
    if (seatIndex !== 1 && seatIndex !== 2) return;
    var previousSeatIndex = playerSeatIndexes[localPlayer];
    if (previousSeatIndex === seatIndex) return;
    var otherPlayer = localPlayer === "b1" ? "b2" : "b1";
    stopAll();
    playerSeatIndexes[localPlayer] = seatIndex;
    if (playerSeatIndexes[otherPlayer] === seatIndex) {
      playerSeatIndexes[otherPlayer] = previousSeatIndex;
    }
    savePlayerSeats();
    lastReadinessAvailability = {};
    lastPlayerReadiness = {};
    paintDeviceInfo();
    paintAccountInfo();
    syncPlayerReadiness(state.match);
    var selectedSlot = slotForPlayer(localPlayer);
    setBadge("正在切换到 " + selectedSlot + " 并重新绑定真实设备…", "info");
    applyBindings({}).then(function () {
      return refreshDevices();
    }).then(function () {
      syncPlayerReadiness(state.match);
    });
  }

  function playerForSlot(match, slot) {
    if (!match || !slot) return null;
    var side = /^R/i.test(slot) ? "red" : "blue";
    var team = match[side];
    var players = (team && team.players) || [];
    for (var index = 0; index < players.length; index += 1) {
      if (String(players[index].slot).toUpperCase() === String(slot).toUpperCase()) return players[index];
    }
    return null;
  }

  function playerDisplayName(slot) {
    var player = playerForSlot(state.match, slot);
    if (player && player.name) return player.name;
    if (state.user && state.user.name) return state.user.name;
    return slot;
  }

  function currentTeamLabel() {
    if (!state.user) return "未登录";
    if (state.user.role === "Admin") return "裁判";
    return currentTeamSide() === "red" ? "红队" : "蓝队";
  }

  function paintCurrentTeamIdentity() {
    if (!state.match) return;
    var team = state.match[currentTeamSide()];
    var label = team && team.name ? team.name : (currentTeamSide() === "red" ? "红队" : "蓝队");
    document.querySelectorAll("[data-live-current-team]").forEach(function (node) {
      if (node.textContent !== label) node.textContent = label;
    });
  }

  function currentTeamData() {
    if (!state.match) return null;
    return currentTeamSide() === "red" ? state.match.red : state.match.blue;
  }

  function paintTeamMembers() {
    if (!document.body) return;
    var teamData = currentTeamData();
    var players = teamData && Array.isArray(teamData.players) ? teamData.players : [];
    document.querySelectorAll("[data-team-member-count]").forEach(function (node) {
      node.textContent = teamData ? players.length + " 名成员" : "等待读取";
    });
    document.querySelectorAll("[data-team-members]").forEach(function (list) {
      var signature = players.map(function (player) {
        return [player.slot, player.name, player.email, player.signedIn ? "1" : "0"].join("|");
      }).join(";");
      if (list.dataset.signature === signature && list.childElementCount) return;
      list.dataset.signature = signature;
      list.replaceChildren();
      if (!players.length) {
        var empty = document.createElement("article");
        empty.className = "teamMember";
        var emptySlot = document.createElement("span");
        emptySlot.className = "teamMemberSlot";
        emptySlot.textContent = "--";
        var emptyText = document.createElement("div");
        var emptyTitle = document.createElement("strong");
        emptyTitle.textContent = "暂无成员信息";
        var emptyHint = document.createElement("small");
        emptyHint.textContent = "等待服务器返回战队名单";
        emptyText.appendChild(emptyTitle);
        emptyText.appendChild(emptyHint);
        empty.appendChild(emptySlot);
        empty.appendChild(emptyText);
        list.appendChild(empty);
        return;
      }
      players.forEach(function (player) {
        var card = document.createElement("article");
        card.className = "teamMember";
        var slot = document.createElement("span");
        slot.className = "teamMemberSlot";
        slot.textContent = player.slot || "--";
        var identity = document.createElement("div");
        var name = document.createElement("strong");
        name.textContent = player.name || "未命名成员";
        var account = document.createElement("small");
        account.textContent = player.email || "未设置成员账号";
        identity.appendChild(name);
        identity.appendChild(account);
        var status = document.createElement("em");
        status.textContent = player.signedIn ? "已签到" : "未签到";
        if (!player.signedIn) status.className = "offline";
        card.appendChild(slot);
        card.appendChild(identity);
        card.appendChild(status);
        list.appendChild(card);
      });
    });
  }

  function paintAccountInfo() {
    if (!state.user || !document.body) return;
    var account = shortAccount(state.user.email) || state.user.name || "当前账号";
    var team = currentTeamLabel();
    document.querySelectorAll("[data-current-account]").forEach(function (node) {
      node.textContent = state.user.email || state.user.name || account;
      node.title = node.textContent;
    });
    paintTeamMembers();
    var onlineDeviceIds = {};
    state.devices.forEach(function (device) {
      if (device && device.online && device.deviceId) onlineDeviceIds[device.deviceId] = true;
    });
    var assignedCount = PLAYERS.filter(function (player) { return !!state.bound[player]; }).length;
    var onlineAssignedCount = PLAYERS.filter(function (player) {
      return !!onlineDeviceIds[state.bound[player]];
    }).length;
    document.querySelectorAll("[data-team-device-status]").forEach(function (node) {
      if (!state.ready) {
        node.textContent = "正在读取实时心跳";
      } else if (!assignedCount) {
        node.textContent = "尚未分配机器鱼";
      } else {
        node.textContent = onlineAssignedCount + " / " + assignedCount + " 台已分配设备在线";
      }
      node.title = node.textContent;
    });
    var summary = document.querySelector(".teamConfirmSummary");
    if (summary) {
      setTextIfFound(summary, "strong", team + "账号");
      setTextIfFound(summary, "span", account);
    }
    var confirms = document.querySelectorAll(".playerConfirm");
    Array.prototype.forEach.call(confirms, function (card, index) {
      var local = index === 1 ? "b2" : "b1";
      var slot = slotForPlayer(local);
      setTextIfFound(card, "b", playerDisplayName(slot));
      setTextIfFound(card, "small", slot + " · " + (state.bound[local] || "等待裁判分配机器鱼"));
      setTextIfFound(card, ".playerReady", state.bound[local] ? "● 已绑定真实机器鱼" : "● 等待分配");
    });
    var hint = document.querySelector(".teamConfirmCard .teamAuthHint");
    if (hint) {
      var count = PLAYERS.filter(function (player) { return state.bound[player]; }).length;
      hint.textContent = count + " / 2 台机器鱼已由裁判分配";
    }
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
    lastDeviceBadge = text;
    lastDeviceTone = tone || "info";
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

  var visionBadge = null;
  function setVisionStatus(text, tone) {
    if (!document.body) return;
    if (!visionBadge) {
      visionBadge = document.createElement("div");
      visionBadge.id = "fishVisionBadge";
      visionBadge.style.cssText = [
        "position:fixed", "left:14px", "bottom:48px", "z-index:2147483000",
        "padding:6px 10px", "border-radius:999px", "font-size:11px", "line-height:1.3",
        "font-family:system-ui,'Microsoft YaHei',sans-serif",
        "background:rgba(3,18,41,.78)", "color:#bfe9ff",
        "border:1px solid rgba(120,200,255,.26)", "backdrop-filter:blur(6px)",
        "pointer-events:none", "max-width:70vw", "white-space:nowrap",
        "overflow:hidden", "text-overflow:ellipsis",
      ].join(";");
      document.body.appendChild(visionBadge);
    }
    visionBadge.textContent = text;
    visionBadge.dataset.tone = tone || "info";
    paintVisionStatusText(text);
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
    if (email && email.indexOf("@") < 0) email += "@fish.local";
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
          state.authenticated = true;
          return true;
        }
        state.authenticated = false;
        return false;
      })
      .catch(function () { state.authenticated = false; return false; });
  }

  function doLogin(event) {
    event.stopImmediatePropagation();
    event.preventDefault();
    if (logoutPending) logoutGeneration++;
    var credentials = readCredentials();
    if (!credentials.email || !credentials.password) {
      showLoginError("请输入战队账号与密码");
      return;
    }
    setBadge("正在登录…", "info");
    api("/api/auth/login", { method: "POST", body: credentials })
      .then(function (result) {
        state.user = result.user;
        state.authenticated = true;
        setBadge("已登录：" + (state.user.email || "") + "（等待绑定设备）", "ok");
        if (loginCard()) loginCard().hidden = true;
        if (confirmCard()) confirmCard().hidden = false;
        paintAccountInfo();
        startPlayerMatchTelemetry();
        startPlayerLeaseMaintenance();
        startRefereeDeviceTelemetry();
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
        state.devices = deviceList(payload);
        state.ready = true;
		if (isRefereePage()) {
			paintDeviceInfo();
			return null;
		}
        return bindPlayers();
      })
      .catch(function (error) {
        setBadge("设备列表读取失败：" + error.message, "error");
      });
  }

  function acquire(deviceId, slot) {
    return api("/api/leases", {
      method: "POST",
		body: { deviceId: deviceId, clientId: CLIENT_ID, mode: "player", slot: slot },
    });
  }

  function release(deviceId) {
    return api("/api/leases", {
      method: "DELETE",
      body: { deviceId: deviceId, clientId: CLIENT_ID },
    }).catch(function () { /* 释放失败不阻塞界面 */ });
  }

  function renew(deviceId) {
    return api("/api/leases", {
      method: "PATCH",
      body: { deviceId: deviceId, clientId: CLIENT_ID },
    });
  }

  function rememberLease(deviceId, payload) {
    if (!payload || !payload.lease) return;
    var device = findDevice(deviceId);
    if (device) device.lease = payload.lease;
  }

  function ensurePlayerLease(player, deviceId) {
    var device = findDevice(deviceId);
    var lease = device && device.lease;
    var ours = lease && lease.clientId === CLIENT_ID && lease.motionExpired !== true;
    var claim = ours
      ? renew(deviceId).catch(function (error) {
        if (error.status === 409) return acquire(deviceId, slotForPlayer(player));
        throw error;
      })
      : acquire(deviceId, slotForPlayer(player));
    return claim.then(function (payload) {
      rememberLease(deviceId, payload);
      state.bound[player] = deviceId;
      if (!Object.prototype.hasOwnProperty.call(state.sequence, deviceId)) state.sequence[deviceId] = 0;
      return payload;
    });
  }

  function bindPlayers() {
    var onlineDevices = state.devices.filter(function (device) { return device.online; });
    // 优先使用裁判在签到环节分配的机器鱼归属
    return api("/api/competition/match")
      .then(function (payload) { return (payload && payload.match) || null; })
      .catch(function () { return null; })
      .then(function (match) {
        state.match = match;
        paintCurrentTeamIdentity();
        var assigned = {};
        if (match) {
          ["blue", "red"].forEach(function (side) {
            var team = match[side];
            if (!team || !team.players) return;
            team.players.forEach(function (player) {
              if (player.deviceId) assigned[String(player.slot).toUpperCase()] = liveDeviceId(player.deviceId);
            });
          });
        }
		if (!match || match.fieldLocked !== true) {
			setBadge("等待裁判锁定场地；选手控制权尚未开放", "info");
			return applyBindings({});
		}
		if (!onlineDevices.length) {
		  setBadge("当前没有在线机器鱼", "warn");
		  return applyBindings({});
		}
		// When a fresh public browser has no team selection, make the only
		// team with an online assigned fish the active team before calculating
		// seat targets. This removes the race between match and device loading.
		var selectedSide = currentTeamSide();
		if (state.match && (!state.user || state.user.role === "Admin")) {
		  var onlineBySide = { blue: 0, red: 0 };
		  ["blue", "red"].forEach(function (side) {
		    var players = state.match[side] && state.match[side].players || [];
		    players.forEach(function (player) {
		      if (player.deviceId && onlineDevices.some(function (device) {
		        return sameDeviceId(device, player.deviceId);
		      })) onlineBySide[side] += 1;
		    });
		  });
		  if (onlineBySide.red > 0 && onlineBySide.blue === 0) selectedSide = activeTeamSide = "red";
		  if (onlineBySide.blue > 0 && onlineBySide.red === 0) selectedSide = activeTeamSide = "blue";
		  paintCurrentTeamIdentity();
		}
        var targets = {
          b1: assigned[(selectedSide === "red" ? "R" : "B") + "1"],
          b2: assigned[(selectedSide === "red" ? "R" : "B") + "2"],
        };
        PLAYERS.forEach(function (player) {
          var deviceId = targets[player];
          if (!deviceId) return;
          var device = findDevice(deviceId);
          if (!device || !device.online) targets[player] = "";
        });
        if (!targets.b1 && !targets.b2) {
          setBadge("本队暂无可手动操控的在线机器鱼", "warn");
        } else {
          var missing = [];
          if (assigned[(selectedSide === "red" ? "R" : "B") + "1"] && !targets.b1) missing.push((selectedSide === "red" ? "R" : "B") + "1");
          if (assigned[(selectedSide === "red" ? "R" : "B") + "2"] && !targets.b2) missing.push((selectedSide === "red" ? "R" : "B") + "2");
          if (missing.length) setBadge(missing.join("/") + " 已分配但当前离线", "warn");
        }
        return applyBindings(targets);
      });
  }

  function applyBindings(targets) {
    return Promise.all(PLAYERS.map(function (player) {
      var deviceId = liveDeviceId(targets[player]);
      var previous = state.bound[player];
      if (!deviceId) {
        if (previous) {
          delete state.bound[player];
          return release(previous);
        }
        return null;
      }
          if (previous && !sameDeviceId(previous, deviceId)) delete state.bound[player];
          var ready = previous && !sameDeviceId(previous, deviceId) ? release(previous) : Promise.resolve();
      return ready.then(function () {
		return ensurePlayerLease(player, deviceId);
        })
        .catch(function (error) {
          if (sameDeviceId(state.bound[player], deviceId)) delete state.bound[player];
          setBadge(slotForPlayer(player) + " 绑定失败：" + error.message, "error");
        });
    })).then(function () {
      var pairs = PLAYERS
        .filter(function (player) { return state.bound[player]; })
        .map(function (player) { return slotForPlayer(player) + " → " + state.bound[player]; });
      var onlineCount = state.devices.filter(function (device) { return device.online; }).length;
      var emptyText = onlineCount ? "未绑定设备" : "当前没有在线机器鱼";
      setBadge(pairs.length ? "已绑定 " + pairs.join("　") : emptyText, pairs.length ? "ok" : "warn");
      paintDeviceInfo();
      paintAccountInfo();
      paintCurrentTeamIdentity();
      return syncRuntimeVisionBindings(true).catch(function (error) {
        setBadge("机器鱼已绑定，YOLO 角色等待重新同步：" + error.message, "warn");
        return { applied: 0, deferred: true, failed: true };
      });
    });
  }

  // ---------------------------------------------------------------- 运动
  function currentDevice(player) {
    return liveDeviceId(state.bound[player] || "") || null;
  }

  function schedulePlayerLeaseRefresh(delay) {
    if (isRefereePage() || !state.authenticated || playerLeaseRefreshQueued) return;
    playerLeaseRefreshQueued = true;
    window.setTimeout(function () {
      playerLeaseRefreshQueued = false;
      maintainPlayerLeases();
    }, delay == null ? 250 : delay);
  }

  function maintainPlayerLeases() {
    if (isRefereePage() || !state.authenticated || playerLeaseRefreshPending || document.hidden) return Promise.resolve();
    playerLeaseRefreshPending = true;
    return refreshDevices().finally(function () {
      playerLeaseRefreshPending = false;
    });
  }

  function startPlayerLeaseMaintenance() {
    if (isRefereePage() || playerLeaseTimer) return;
    playerLeaseTimer = window.setInterval(maintainPlayerLeases, 15000);
  }

  function recoverPlayerLease(player, error) {
    if (playerLeaseRecoveryPending[player]) return;
    playerLeaseRecoveryPending[player] = true;
    heldInputs[player] = {};
    endMotion(player);
    delete state.bound[player];
    setBadge(slotForPlayer(player) + " 控制连接已中断，正在自动恢复：" + error.message, "warn");
    window.setTimeout(function () {
      maintainPlayerLeases().finally(function () { delete playerLeaseRecoveryPending[player]; });
    }, 300);
  }

  function sendMotion(player, action) {
    if (!MOTION_ACTIONS[action]) return false;
    var stop = action === "stop";
    var page = String(window.location.hash || "").replace(/^#/, "");
    var deviceId = currentDevice(player);
    if (!deviceId) {
      setBadge(slotForPlayer(player) + " 尚未绑定设备", "warn");
      return false;
    }
    var sequence = (state.sequence[deviceId] || 0) + 1;
    state.sequence[deviceId] = sequence;
    var tuning = motionTuning[player] || motionTuning.b1;
    var body = {
      deviceId: deviceId,
      clientId: CLIENT_ID,
      context: page === "control" ? "match" : "test",
      mode: action,
      sequence: sequence,
      frequency: stop ? 0.3 : tuning.frequency,
      // Match the firmware's maximum command deadman window. The serialized
      // transport below prevents public-network request buildup.
      deadmanMs: stop ? 0 : 2000,
    };
    if (stop) {
      body.amplitude = 0;
      body.bias = 0;
    } else {
      body.amplitudePercent = tuning.amplitudePercent;
    }
    var transport = motionTransport[player] || (motionTransport[player] = { active: false, pending: null });
    transport.pending = { deviceId: deviceId, body: body };
    if (transport.active) return true;
    var flush = function () {
      var next = transport.pending;
      if (!next) return;
      transport.pending = null;
      transport.active = true;
      sendRealtimeFrame(next.body)
        .catch(function (error) {
          if (error.status === 409) {
            if (sameDeviceId(currentDevice(player), next.deviceId)) recoverPlayerLease(player, error);
            return;
          }
          // Keep the selected device, but report the actual transport. Any
          // next frame may reconnect the same WebSocket; no other protocol is
          // silently substituted.
          if (activeMotion[player] && activeMotion[player].action === action) {
            setBadge(slotForPlayer(player) + " WebSocket 控制连接异常，正在重连", "warn");
          }
        })
        .finally(function () {
          transport.active = false;
          // A stop queued during an in-flight motion frame must always flush,
          // even after the local activeMotion entry has been cleared.
          var pendingStop = transport.pending && transport.pending.body && transport.pending.body.mode === "stop";
          if (transport.pending && (pendingStop || (activeMotion[player] && activeMotion[player].action === action))) flush();
        });
    };
    flush();
    return true;
  }

  function syncPlayerReadiness(match) {
    if (!match || isRefereePage()) return;
    PLAYERS.forEach(function (localPlayer) {
      var slot = slotForPlayer(localPlayer);
      var player = playerForSlot(match, slot);
      var ready = !!(player && player.ready);
      var deviceId = String((player && (player.readyDeviceId || player.deviceId)) || "");
      var signature = (ready ? "1" : "0") + ":" + deviceId;
      if (lastPlayerReadiness[localPlayer] === signature) return;
      lastPlayerReadiness[localPlayer] = signature;
      document.dispatchEvent(new CustomEvent("fish-player-readiness", {
        detail: {
          player: localPlayer,
          slot: slot,
          ready: ready,
          deviceId: ready ? deviceId : "",
          readyAt: (player && player.readyAt) || "",
        },
      }));
    });
  }

  window.fishCompetitionSetReady = function (localPlayer, ready) {
    if (PLAYERS.indexOf(localPlayer) < 0) return Promise.reject(new Error("选手席位无效"));
    var slot = slotForPlayer(localPlayer);
    var assigned = playerForSlot(state.match, slot);
    var deviceId = String((assigned && assigned.deviceId) || state.bound[localPlayer] || "");
    return api("/api/competition/match/ready", {
      method: "POST",
      body: {
        side: /^R/i.test(slot) ? "red" : "blue",
        slot: slot,
        deviceId: deviceId,
        ready: !!ready,
      },
    }).then(function (payload) {
      state.match = payload && payload.match ? payload.match : state.match;
      syncPlayerReadiness(state.match);
      if (payload) paintPlayerMatch(payload);
      setBadge(slot + (ready ? " 已提交准备完成" : " 已取消准备"), ready ? "ok" : "info");
      return payload;
    }).catch(function (error) {
      setBadge(slot + " 准备状态提交失败：" + error.message, "error");
      throw error;
    });
  };

  function cancelPendingStop(entry) {
    if (entry && entry.repeatTimer) {
      window.clearInterval(entry.repeatTimer);
      entry.repeatTimer = null;
    }
  }

  function beginMotion(player, action, token) {
    var previous = activeMotion[player];
    cancelPendingStop(previous);
    var entry = activeMotion[player] = {
      action: action,
      token: token,
      repeatTimer: null,
    };
    if (action === "stop") {
      return sendMotion(player, "stop");
    }
    setBadge(slotForPlayer(player) + " " + action + " 控制中", "ok");
    if (!sendMotion(player, action)) {
      delete activeMotion[player];
      return false;
    }
    entry.repeatTimer = window.setInterval(function () {
      if (activeMotion[player] !== entry) return;
      sendMotion(player, action);
    }, 100);
    return true;
  }

  function endMotion(player) {
    var entry = activeMotion[player];
    if (!entry) return;
    cancelPendingStop(entry);
    // Stop immediately on key-up/blur/route changes instead of waiting for
    // the device deadman window to expire.
    if (entry.action !== "stop") sendMotion(player, "stop");
    delete activeMotion[player];
  }

  function desiredInput(player) {
    var inputs = Object.keys(heldInputs[player] || {}).map(function (token) {
      return heldInputs[player][token];
    });
    if (!inputs.length) return null;
    inputs.sort(function (a, b) {
      function priority(action) {
        if (action === "stop") return 3;
        if (action === "left" || action === "right") return 2;
        return 1;
      }
      return priority(b.action) - priority(a.action) || b.order - a.order;
    });
    return inputs[0];
  }

  function reconcileInputs(player) {
    var desired = desiredInput(player);
    var current = activeMotion[player];
    if (desired && current && desired.token === current.token && desired.action === current.action) return;
    if (!desired) {
      endMotion(player);
      return;
    }
    beginMotion(player, desired.action, desired.token);
  }

  function pressInput(player, action, token) {
    if (!heldInputs[player]) heldInputs[player] = {};
    heldInputs[player][token] = { player: player, action: action, token: token, order: ++inputOrder };
    reconcileInputs(player);
  }

  function releaseInput(player, token) {
    if (heldInputs[player]) delete heldInputs[player][token];
    reconcileInputs(player);
  }

  function stopAll(reason) {
    PLAYERS.forEach(function (player) {
      heldInputs[player] = {};
      endMotion(player);
    });
    if (reason) setBadge(reason, "warn");
  }

  // ---------------------------------------------------------------- 界面回填
  function deviceStatusLabel(device) {
    if (!device) return "未分配";
    return device.online ? "在线" : "离线";
  }

  function deviceBatteryLabel(device) {
    if (!device || device.batteryPercent == null || !Number.isFinite(Number(device.batteryPercent))) return "未上报";
    return Math.max(0, Math.min(100, Math.round(Number(device.batteryPercent)))) + "%";
  }

  function deviceLatencyLabel(device) {
    if (!device) return "未测得";
    var rtt = Number(device.heartbeatRttMs);
    if (!Number.isFinite(rtt) || rtt <= 0) return "测量中";
    return (rtt < 10 ? rtt.toFixed(1) : Math.round(rtt)) + " ms";
  }

  function assignedSlotForDevice(deviceId) {
    if (!state.match || !deviceId) return "";
    var slot = "";
    ["blue", "red"].some(function (side) {
      var players = (state.match[side] && state.match[side].players) || [];
      return players.some(function (player) {
        if (!sameDeviceId(player.deviceId, deviceId)) return false;
        slot = String(player.slot || "").toUpperCase();
        return true;
      });
    });
    return slot;
  }

  function deviceControllerLabel(device) {
    if (!device) return "未知";
    var lease = device.lease || {};
    var owner = lease.ownerName || shortAccount(lease.ownerEmail) || shortAccount(device.controlSource);
    if (lease.ownerId === "vision-bot" || owner === "vision-bot") return "视觉自动控制";
    return owner || "无人控制";
  }

  function appendOverviewMetric(parent, label, value, className) {
    var metric = document.createElement("div");
    metric.className = "onlineDeviceMetric" + (className ? " " + className : "");
    var name = document.createElement("span");
    name.textContent = label;
    var reading = document.createElement("b");
    reading.textContent = value;
    reading.title = value;
    metric.appendChild(name);
    metric.appendChild(reading);
    parent.appendChild(metric);
  }

  function paintRefereeDeviceOverview() {
    var list = document.getElementById("deviceOverviewList");
    var count = document.getElementById("onlineDeviceCount");
    if (!list || !count) return;
    var devices = state.devices.filter(function (device) { return !!device.online; });
    devices.sort(function (a, b) {
      var slotA = assignedSlotForDevice(a.deviceId) || "ZZ";
      var slotB = assignedSlotForDevice(b.deviceId) || "ZZ";
      return slotA.localeCompare(slotB) || deviceName(a).localeCompare(deviceName(b));
    });
    count.textContent = devices.length + " 台";
    list.replaceChildren();
    if (!devices.length) {
      var empty = document.createElement("div");
      empty.className = "deviceOverviewEmpty";
      var emptyTitle = document.createElement("b");
      emptyTitle.textContent = "暂无在线设备";
      var emptyHint = document.createElement("span");
      emptyHint.textContent = "设备上线后将显示电量、WebSocket 往返延迟和控制者";
      empty.appendChild(emptyTitle);
      empty.appendChild(emptyHint);
      list.appendChild(empty);
      return;
    }
    devices.forEach(function (device) {
      var card = document.createElement("article");
      card.className = "onlineDeviceCard";
      var identity = document.createElement("div");
      identity.className = "onlineDeviceIdentity";
      var dot = document.createElement("i");
      dot.setAttribute("aria-label", "在线");
      var text = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = deviceName(device) || "未命名设备";
      title.title = title.textContent;
      var detail = document.createElement("small");
      detail.textContent = device.deviceId || device.ip || "设备标识未知";
      detail.title = detail.textContent;
      text.appendChild(title);
      text.appendChild(detail);
      var slot = assignedSlotForDevice(device.deviceId);
      var badge = document.createElement("b");
      badge.className = "deviceSlotBadge" + (/^R/.test(slot) ? " red" : "");
      badge.textContent = slot || "未分配";
      identity.appendChild(dot);
      identity.appendChild(text);
      identity.appendChild(badge);
      card.appendChild(identity);

      var metrics = document.createElement("div");
      metrics.className = "onlineDeviceMetrics";
      var battery = Number(device.batteryPercent);
      var heartbeatRTT = Number(device.heartbeatRttMs);
      appendOverviewMetric(metrics, "电量", deviceBatteryLabel(device), Number.isFinite(battery) && battery >= 20 ? "good" : "warn");
      appendOverviewMetric(metrics, "往返延迟", deviceLatencyLabel(device), Number.isFinite(heartbeatRTT) && heartbeatRTT > 0 && heartbeatRTT < 80 ? "good" : "warn");
      appendOverviewMetric(metrics, "控制者", deviceControllerLabel(device), "controller");
      card.appendChild(metrics);
      list.appendChild(card);
    });
  }

  function assignedDeviceIdForSlot(slot) {
    var player = playerForSlot(state.match, slot);
    return player && player.deviceId ? player.deviceId : "";
  }

  function playerVisionTrackId(localPlayer) {
    var player = playerForSlot(state.match, slotForPlayer(localPlayer));
    if (!player || player.visionTrackId == null) return null;
    var trackId = Number(player.visionTrackId);
    return Number.isInteger(trackId) && trackId >= 0 ? trackId : null;
  }

  function detectedVisionTracks() {
    var yolo = (video.metrics && video.metrics.yolo) || {};
    var detections = Array.isArray(yolo.detections) ? yolo.detections : [];
    var seen = {};
    return detections.map(function (detection) {
      var trackId = Number(detection && detection.trackId);
      if (!Number.isInteger(trackId) || trackId < 0 || seen[trackId]) return null;
      seen[trackId] = true;
      return {
        trackId: trackId,
        color: String((detection && detection.color) || "").trim().toUpperCase(),
      };
    }).filter(Boolean).sort(function (a, b) { return a.trackId - b.trackId; });
  }

  function paintVisionRoleSelector(metric, localPlayer) {
    var select = metric.querySelector("[data-player-vision]");
    if (!select) {
      select = document.createElement("select");
      select.className = "playerVisionRole";
      select.setAttribute("data-player-vision", localPlayer);
      select.setAttribute("aria-label", slotForPlayer(localPlayer) + " 的 YOLO 识别角色");
      var previousValue = metric.querySelector("b");
      if (previousValue) previousValue.replaceWith(select);
      else metric.appendChild(select);
    }
    var assignedTrackId = playerVisionTrackId(localPlayer);
    var tracks = detectedVisionTracks();
    var detectedAssigned = assignedTrackId !== null && tracks.some(function (track) {
      return track.trackId === assignedTrackId;
    });
    var signature = String(assignedTrackId) + "|" + tracks.map(function (track) {
      return track.trackId + ":" + track.color;
    }).join(",");
    if (select.dataset.options !== signature) {
      select.replaceChildren();
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = tracks.length ? "选择 YOLO ID" : "未识别到目标";
      select.appendChild(empty);
      tracks.forEach(function (track) {
        var option = document.createElement("option");
        option.value = String(track.trackId);
        option.textContent = "#" + track.trackId + (track.color ? " · " + track.color : "");
        select.appendChild(option);
      });
      if (assignedTrackId !== null && !detectedAssigned) {
        var missing = document.createElement("option");
        missing.value = String(assignedTrackId);
        missing.textContent = "#" + assignedTrackId + " · 暂未识别";
        select.appendChild(missing);
      }
      select.dataset.options = signature;
    }
    select.value = assignedTrackId === null ? "" : String(assignedTrackId);
    select.disabled = !tracks.length && assignedTrackId === null;
    select.title = !video.processing
      ? "请先由裁判开启 YOLO 识别"
      : tracks.length ? "选择这名选手对应的真实 YOLO Track ID" : "当前帧暂未识别到目标";
    metric.classList.remove("good", "warn");
    if (detectedAssigned) metric.classList.add("good");
    else if (assignedTrackId !== null) metric.classList.add("warn");
  }

  function workspaceVisionTarget(deviceId, trackId) {
    return api(
      "/api/vision/workspaces/" + encodeURIComponent(deviceId) + "/sessions/workspace/target",
      {
        method: "POST",
        headers: { "X-Fish-Client": CLIENT_ID },
        body: { targetDeviceId: deviceId, targetTrackId: trackId },
      }
    );
  }

  function syncRuntimeVisionBindings(silent) {
    if (!video || !video.processing || !video.sessionId) {
      return Promise.resolve({ applied: 0, deferred: true });
    }
    var bindings = PLAYERS.map(function (localPlayer) {
      var deviceId = state.bound[localPlayer];
      if (!deviceId) return null;
      return {
        deviceId: deviceId,
        trackId: playerVisionTrackId(localPlayer),
      };
    }).filter(Boolean);
    if (!bindings.length) return Promise.resolve({ applied: 0, deferred: true });
    return Promise.all(bindings.map(function (binding) {
      return workspaceVisionTarget(binding.deviceId, null);
    })).then(function () {
      return Promise.all(bindings.filter(function (binding) {
        return binding.trackId !== null;
      }).map(function (binding) {
        return workspaceVisionTarget(binding.deviceId, binding.trackId);
      }));
    }).then(function (results) {
      if (!silent) setBadge("YOLO 角色已同步到 " + results.length + " 台在线机器鱼", "ok");
      return { applied: results.length, deferred: false };
    });
  }

  function selectPlayerVisionTrack(localPlayer, rawTrackId) {
    if (PLAYERS.indexOf(localPlayer) < 0) return;
    var unbind = rawTrackId === "";
    var trackId = unbind ? null : Number(rawTrackId);
    if (!unbind && (!Number.isInteger(trackId) || trackId < 0)) return;
    if (!unbind && !detectedVisionTracks().some(function (track) { return track.trackId === trackId; })) {
      setBadge("YOLO #" + trackId + " 已不在当前真实识别结果中", "warn");
      paintDeviceInfo();
      return;
    }
    var slot = slotForPlayer(localPlayer);
    setBadge(unbind ? ("正在解除 " + slot + " 的 YOLO 角色…") : ("正在绑定 " + slot + " → YOLO #" + trackId + "…"), "info");
    api("/api/competition/match/" + (unbind ? "vision-unbind" : "vision-bind"), {
      method: "POST",
      body: {
        side: /^R/i.test(slot) ? "red" : "blue",
        slot: slot,
        targetTrackId: trackId,
      },
    }).then(function (payload) {
      state.match = payload && payload.match ? payload.match : state.match;
      if (payload) paintPlayerMatch(payload);
      paintDeviceInfo();
      return syncRuntimeVisionBindings(false).catch(function (error) {
        setBadge(slot + " 的 YOLO 角色已保存；在线设备同步失败：" + error.message, "warn");
        return { applied: 0, deferred: true, failed: true };
      });
    }).then(function (result) {
      if (result && result.failed) return;
      if (result && result.deferred) {
        setBadge(slot + (unbind ? " 已解除 YOLO 角色" : " 已绑定 YOLO #" + trackId) + "；设备在线后自动同步", "ok");
      } else if (unbind) {
        setBadge(slot + " 已解除 YOLO 角色", "ok");
      }
    }).catch(function (error) {
      setBadge(slot + " 的 YOLO 角色保存失败：" + error.message, "error");
      paintDeviceInfo();
    });
  }

  function setTextIfFound(root, selector, value) {
    var node = root.querySelector(selector);
    if (node && value != null) node.textContent = String(value);
  }

  function publishPlayerDeviceAvailability(localPlayer) {
    var slot = slotForPlayer(localPlayer);
    var assignedDeviceId = assignedDeviceIdForSlot(slot);
    var deviceId = assignedDeviceId || state.bound[localPlayer] || "";
    var device = findDevice(deviceId);
    var heartbeatAt = Number(device && device.heartbeatAtMs);
    var healthy = !!(
      assignedDeviceId &&
      (state.bound[localPlayer] === deviceId || sameDeviceId(state.bound[localPlayer], deviceId)) &&
      device &&
      device.online &&
      Number.isFinite(heartbeatAt) &&
      heartbeatAt > 0
    );
    var availabilityKey = deviceId + ":" + (healthy ? "1" : "0");
    if (lastReadinessAvailability[localPlayer] === availabilityKey) return;
    lastReadinessAvailability[localPlayer] = availabilityKey;
    document.dispatchEvent(new CustomEvent("fish-device-availability", {
      detail: { player: localPlayer, deviceId: deviceId, healthy: healthy },
    }));
  }

  function paintPlayerCard(card, localPlayer) {
    var slot = slotForPlayer(localPlayer);
    var assignedDeviceId = assignedDeviceIdForSlot(slot);
    var deviceId = assignedDeviceId || state.bound[localPlayer];
    var device = findDevice(deviceId);
    var hasAssignment = !!assignedDeviceId;
    var heartbeatAt = Number(device && device.heartbeatAtMs);
    var healthy = !!(hasAssignment && device && device.online && Number.isFinite(heartbeatAt) && heartbeatAt > 0);
    var statusText = hasAssignment ? (healthy ? "在线" : "设备离线") : "未分配";
    var unavailableMetricText = hasAssignment ? "设备离线" : "未分配";
    var deviceText = hasAssignment ? (device ? deviceName(device) : assignedDeviceId) : "裁判未分配机器鱼";
    var seatSelect = card.querySelector("[data-player-seat]");
    if (seatSelect) paintSeatSelector(seatSelect, localPlayer);
    else setTextIfFound(card, ".playerSeat", slot);
    setTextIfFound(card, ".preflightSeat", slot);
    setTextIfFound(card, ".matchPlayerHead h2", playerDisplayName(slot));
    if (card.classList.contains("preflightDeviceCard")) setTextIfFound(card, "h3", playerDisplayName(slot));
    setTextIfFound(card, "header p", deviceText);
    setTextIfFound(card, ".playerOnline", statusText);
    setTextIfFound(card, ".preflightState", hasAssignment ? statusText : "等待裁判分配");
    card.querySelectorAll(".deviceMetric, .preflightMetrics span").forEach(function (metric) {
      var label = metric.querySelector("small");
      if (!label) return;
      var text = label.textContent.trim();
      if (text === "视觉" && metric.classList.contains("deviceMetric")) {
        paintVisionRoleSelector(metric, localPlayer);
        return;
      }
      var value = metric.querySelector("b");
      if (!value) return;
      if (text === "连接") value.textContent = statusText;
      if (text === "定位") {
        var visionText = video.statusText || "未启用";
        value.textContent = visionText || "未启用";
      }
      if (text === "电量") value.textContent = healthy ? deviceBatteryLabel(device) : unavailableMetricText;
      if (text === "延迟") value.textContent = healthy ? deviceLatencyLabel(device) : unavailableMetricText;
      value.title = value.textContent;
      if (metric.classList.contains("deviceMetric")) {
        metric.classList.remove("good", "warn");
        var reading = value.textContent;
        if (
          (text === "电量" && /%$/.test(reading) && Number.parseInt(reading, 10) >= 20) ||
          (text === "延迟" && /ms$/.test(reading)) ||
          (text === "定位" && /已接入|已连接|播放中|就绪/.test(reading))
        ) metric.classList.add("good");
        else if (/未|离线|失败|错误|重连|HTTP/.test(reading)) metric.classList.add("warn");
      }
    });
    card.querySelectorAll(".playerControl header b").forEach(function (node) { node.textContent = slot; });
    var readyButton = card.querySelector("[data-player-ready]");
    if (readyButton) {
      readyButton.disabled = !healthy;
      if (readyButton.dataset.ready !== "true") {
        var readyText = readyButton.querySelector("span");
        if (readyText) readyText.textContent = healthy ? "准备完成" : "设备未就绪";
      }
    }
    publishPlayerDeviceAvailability(localPlayer);
  }

  function paintDeviceInfo() {
    if (!document.body) return;
    document.querySelectorAll(".matchPlayerCard.playerA, .preflightDeviceCard.playerA").forEach(function (card) {
      paintPlayerCard(card, "b1");
    });
    document.querySelectorAll(".matchPlayerCard.playerB, .preflightDeviceCard.playerB").forEach(function (card) {
      paintPlayerCard(card, "b2");
    });
    PLAYERS.forEach(publishPlayerDeviceAvailability);
    var deviceSummary = document.querySelector("[data-live-summary-devices]");
    if (deviceSummary) {
      var assigned = PLAYERS.map(function (player) { return state.bound[player]; }).filter(Boolean);
      var onlineCount = assigned.filter(function (deviceId) {
        return state.devices.some(function (device) {
          return sameDeviceId(device, deviceId) && !!device.online;
        });
      }).length;
      deviceSummary.textContent = onlineCount + " / " + PLAYERS.length + " 在线";
    }
    paintRefereeDeviceOverview();
    if (isRefereePage() && (referee.match || state.match)) {
      paintRefereeRoster(referee.match || state.match);
    }
  }

  function paintVisionStatusText(text) {
    if (!document.body) return;
    document.querySelectorAll(".liveBadge").forEach(function (node) {
      node.textContent = text;
    });
    document.querySelectorAll(".arenaHead span").forEach(function (node) {
      if (/视觉|FIELD/i.test(node.textContent)) node.textContent = text;
    });
    document.querySelectorAll(".footer span:first-child").forEach(function (node) {
      if (/视觉|网络|延迟/i.test(node.textContent)) node.textContent = "设备在线状态与视觉状态独立";
    });
    var summary = document.querySelector("[data-live-summary-vision]");
    if (summary) summary.textContent = text || "视觉未启用";
  }

  // ---------------------------------------------------------------- 视频
  // 把后端 WebRTC 画面接到界面的“实时赛场”区域。共享视觉会话提供赛场
  // 画面，因此使用 root 会话；连接建立后只重新挂载 video 元素，
  // 页面切换不会重建媒体连接。
  var video = {
    peer: null, stream: null, sessionId: null, timer: null, connecting: false,
    connectionStartedAt: 0, connectedAt: 0, lastFrameAt: 0,
    connectionGeneration: 0,
    frameWatchTimer: null, frameCallbackId: null, frameElement: null,
    events: null,
    statusText: "视觉未启用", source: "server", cameras: [], cameraIndex: "",
    cameraLoading: false, controls: null,
    processing: false, sessionRefreshing: false, lastSessionRefresh: 0, metrics: {},
    overlays: { detections: false, plannedPath: false, trajectory: false },
    // Once the referee touches the slider, keep its thumb on the requested
    // value. Camera telemetry is asynchronous and may briefly contain an old
    // value; it must only update the separate "actual value" readout.
    exposureDesired: null,
    cropRegion: { x: 0, y: 0, width: 1, height: 1 }, cropDraft: null,
    cropDragging: false, cropDirty: false, cropLoaded: false, cropResizeObserver: null,
    rotationAngle: 0, rotationDraft: null, rotationLoaded: false,
    trackingEntryOpen: false, trackingDrawEnabled: false, trackingDraftPoints: [],
    trackingPath: [], trackingMode: "single_fish", trackingDeviceId: "", trackingTrackId: null,
    playerOverlayResizeObserver: null, playerOverlayStage: null,
  };
  var fieldDimensionsDirty = false;

  function videoSurface() {
    if (isRefereePage()) {
      return document.querySelector(".page:not(.hidden) #refereeLiveStage")
        || document.querySelector(".page:not(.hidden) #refereeMatchStage")
        || document.getElementById("refereeLiveStage")
        || document.getElementById("refereeMatchStage");
    }
    // 选手端是 poolStage；裁判端由上面的实时场地区域承载画面。
    return document.querySelector(".poolStage.matchPool")
      || document.querySelector(".poolStage");
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
      // Invalidate every callback belonging to the old offer before starting
      // another one. This prevents a slow, cancelled offer from installing a
      // stale peer after the replacement connection has already started.
      closeVideoPeer();
      connectVideo();
    }, delay || 3000);
    if (reason) {
      video.statusText = "视觉重连中：" + reason;
      setVisionStatus(video.statusText, "warn");
    }
  }

  function connectVideo() {
    if (video.connecting || video.peer) return;
    var generation = video.connectionGeneration;
    function current() { return generation === video.connectionGeneration; }
    function staleConnection() {
      var error = new Error("stale_video_connection");
      error.stale = true;
      return error;
    }
    video.connecting = true;
    api("/api/vision/sessions/current")
      .then(function (payload) {
        if (!current()) throw staleConnection();
        var session = payload && (payload.data || payload);
        if (!session || !session.sessionId) throw new Error("视觉会话尚未建立");
        applyVisionSession(session);
        return api("/api/vision/webrtc/config");
      })
      .then(function (config) {
        if (!current()) throw staleConnection();
        if (config && config.available === false) throw new Error("WebRTC 服务未启用");
        var peer = new window.RTCPeerConnection({
          iceServers: (config && Array.isArray(config.iceServers)) ? config.iceServers : [],
        });
        if (!current()) {
          try { peer.close(); } catch (_) {}
          throw staleConnection();
        }
        video.peer = peer;
        video.connectionStartedAt = Date.now();
        video.connectedAt = 0;
        video.lastFrameAt = 0;
        var transceiver = peer.addTransceiver("video", { direction: "recvonly" });
        try {
          if ("playoutDelayHint" in transceiver.receiver) transceiver.receiver.playoutDelayHint = 0;
          if ("jitterBufferTarget" in transceiver.receiver) transceiver.receiver.jitterBufferTarget = 0;
        } catch (e) { /* 接收端不支持延迟提示时继续使用默认缓冲 */ }
        peer.ontrack = function (event) {
          if (!current() || video.peer !== peer) return;
          video.stream = (event.streams && event.streams[0]) || new window.MediaStream([event.track]);
          event.track.onended = function () {
            if (video.peer === peer) scheduleVideoReconnect("视频轨道已结束", 100);
          };
          mountVideoSurface();
        };
        peer.onconnectionstatechange = function () {
          if (!current() || video.peer !== peer) return;
          if (peer.connectionState === "failed") scheduleVideoReconnect("连接失败");
          else if (peer.connectionState === "disconnected") {
            setTimeout(function () {
              if (peer.connectionState === "disconnected") scheduleVideoReconnect("连接中断");
            }, 4000);
          } else if (peer.connectionState === "connected") {
            video.connectedAt = Date.now();
            video.statusText = "视觉画面已接入";
            setVisionStatus(video.statusText, "ok");
            if (lastDeviceBadge) setBadge(lastDeviceBadge, lastDeviceTone);
          }
        };
        return peer.createOffer()
          .then(function (offer) { return peer.setLocalDescription(offer); })
          .then(function () { return waitForIce(peer); })
          .then(function () {
            if (!current() || video.peer !== peer) throw staleConnection();
            return api("/api/vision/webrtc/offer", {
              method: "POST",
              body: {
                sessionId: video.sessionId,
                quality: "full",
                view: isRefereePage() ? "full" : "cropped",
                type: peer.localDescription.type,
                sdp: peer.localDescription.sdp,
              },
            });
          })
          .then(function (answer) {
            if (!current() || video.peer !== peer) throw staleConnection();
            if (!answer || !answer.sdp) throw new Error("视频信令失败");
            return peer.setRemoteDescription(answer);
          });
      })
      .catch(function (error) {
        if (error && error.stale) return;
        // 没有摄像头/未启动视觉时属于正常等待状态，放慢重试避免刷屏
        var waiting = /会话尚未建立/.test(error.message);
        video.statusText = waiting ? "视觉未启动（手动操控可用）" : "视觉接入失败：" + error.message;
        setVisionStatus(video.statusText, waiting ? "info" : "error");
        if (lastDeviceBadge) setBadge(lastDeviceBadge, lastDeviceTone);
        scheduleVideoReconnect(waiting ? null : error.message, waiting ? 10000 : 3000);
      })
      .then(function () {
        if (current()) video.connecting = false;
      });
  }

  function markVideoFrame() {
    video.lastFrameAt = Date.now();
  }

  function watchVideoFrames(element) {
    if (!element) return;
    if (video.frameElement !== element) {
      if (
        video.frameElement && video.frameCallbackId != null &&
        typeof video.frameElement.cancelVideoFrameCallback === "function"
      ) {
        try { video.frameElement.cancelVideoFrameCallback(video.frameCallbackId); } catch (_) {}
      }
      video.frameElement = element;
      video.frameCallbackId = null;
      ["loadeddata", "playing", "timeupdate"].forEach(function (name) {
        element.addEventListener(name, markVideoFrame);
      });
      ["error", "stalled", "emptied"].forEach(function (name) {
        element.addEventListener(name, function () {
          if (video.peer) scheduleVideoReconnect("视频媒体流中断", 300);
        });
      });
      if (typeof element.requestVideoFrameCallback === "function") {
        var onFrame = function () {
          if (video.frameElement !== element) return;
          markVideoFrame();
          video.frameCallbackId = element.requestVideoFrameCallback(onFrame);
        };
        video.frameCallbackId = element.requestVideoFrameCallback(onFrame);
      }
    }
    if (!video.frameWatchTimer) {
      video.frameWatchTimer = window.setInterval(function () {
        if (document.hidden || !video.peer || video.timer) return;
        var now = Date.now();
        var baseline = video.lastFrameAt || video.connectedAt || video.connectionStartedAt;
        var timeout = video.peer.connectionState === "connected" ? 5000 : 12000;
        if (baseline && now - baseline > timeout) {
          scheduleVideoReconnect(video.lastFrameAt ? "画面超过 5 秒未更新" : "视频首帧超时", 100);
        }
      }, 1000);
    }
  }

  function mountVideoSurface() {
    var stage = videoSurface();
    if (!stage) return;
    ensureVideoControls(stage);
    var backdrop = stage.querySelector("video[data-fish-video-backdrop]");
    if (!isRefereePage() && stage.classList.contains("matchPool") && !backdrop) {
      backdrop = document.createElement("video");
      backdrop.setAttribute("data-fish-video-backdrop", "1");
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.autoplay = true;
      backdrop.muted = true;
      backdrop.setAttribute("playsinline", "");
      backdrop.style.cssText = [
        "position:absolute", "inset:-6%", "width:112%", "height:112%",
        "object-fit:cover", "z-index:0", "filter:blur(18px) brightness(.34) saturate(1.18)",
        "transform:scale(1.04)", "pointer-events:none",
      ].join(";");
      stage.insertBefore(backdrop, stage.firstChild);
    }
    var element = stage.querySelector("video[data-fish-video]");
    if (!element) {
      element = document.createElement("video");
      element.setAttribute("data-fish-video", "1");
      element.autoplay = true;
      element.muted = true;
      element.setAttribute("playsinline", "");
      element.addEventListener("loadedmetadata", renderCropEditor);
      element.addEventListener("resize", renderCropEditor);
      element.addEventListener("loadedmetadata", renderPlayerDetectionOverlay);
      element.addEventListener("resize", renderPlayerDetectionOverlay);
      if (!stage.classList.contains("videoStage")) {
        // 选手端的水池是装饰层，视频作为底层铺满
        element.style.cssText = [
          "position:absolute", "inset:0", "width:100%", "height:100%",
          "object-fit:contain", "z-index:1", "background:transparent",
          "pointer-events:none",
        ].join(";");
      }
      // 裁判端 .videoStage video 已由页面样式定义，无需内联样式
      stage.insertBefore(element, stage.firstChild);
    }
    if (!isRefereePage() && stage.classList.contains("matchPool")) {
      var detectionCanvas = stage.querySelector("canvas[data-player-detection-overlay]");
      if (!detectionCanvas) {
        detectionCanvas = document.createElement("canvas");
        detectionCanvas.setAttribute("data-player-detection-overlay", "1");
        detectionCanvas.setAttribute("aria-hidden", "true");
        detectionCanvas.style.cssText = [
          "position:absolute", "inset:0", "width:100%", "height:100%",
          "z-index:3", "pointer-events:none",
        ].join(";");
        stage.appendChild(detectionCanvas);
      }
      if (video.playerOverlayStage !== stage) {
        if (video.playerOverlayResizeObserver) video.playerOverlayResizeObserver.disconnect();
        video.playerOverlayStage = stage;
        if (typeof window.ResizeObserver === "function") {
          video.playerOverlayResizeObserver = new window.ResizeObserver(renderPlayerDetectionOverlay);
          video.playerOverlayResizeObserver.observe(stage);
        }
      }
    }
    if (video.stream && element.srcObject !== video.stream) {
      element.srcObject = video.stream;
      var played = element.play();
      if (played && played.catch) played.catch(function () { /* 自动播放被拦截时忽略 */ });
    }
    watchVideoFrames(element);
    if (backdrop && video.stream && backdrop.srcObject !== video.stream) {
      backdrop.srcObject = video.stream;
      var backdropPlayed = backdrop.play();
      if (backdropPlayed && backdropPlayed.catch) backdropPlayed.catch(function () {});
    }
    element.hidden = false;
    renderCropEditor();
    renderPlayerDetectionOverlay();
  }

  function cameraText(camera, index) {
    var name = camera && (camera.model || camera.name) || "服务器摄像头 " + (index + 1);
    return name;
  }

  function finiteNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatNumber(value) {
    var number = finiteNumber(value);
    if (number === null) return "—";
    return Math.abs(number - Math.round(number)) < 0.01
      ? String(Math.round(number)) : number.toFixed(1);
  }

  function normalizeCropRegion(value) {
    if (!value || typeof value !== "object") return null;
    var x = finiteNumber(value.x);
    var y = finiteNumber(value.y);
    var width = finiteNumber(value.width);
    var height = finiteNumber(value.height);
    if (x === null || y === null || width === null || height === null) return null;
    if (x < 0 || y < 0 || width < 0.05 || height < 0.05 || x + width > 1.000001 || y + height > 1.000001) return null;
    return { x: x, y: y, width: width, height: height };
  }

  function cropSourceSize() {
    var stage = document.getElementById("refereeLiveStage");
    var element = stage && stage.querySelector("video[data-fish-video]");
    var frame = (video.metrics && (video.metrics.cameraFrame || video.metrics.frame)) || {};
    return {
      width: element && element.videoWidth || finiteNumber(frame.width) || 4,
      height: element && element.videoHeight || finiteNumber(frame.height) || 3,
    };
  }

  function cropLabel(region) {
    var source = cropSourceSize();
    var width = Math.round(region.width * source.width);
    var height = Math.round(region.height * source.height);
    return width + " × " + height + " · " + Math.round(region.width * 100) + "% × " + Math.round(region.height * 100) + "%";
  }

  function renderCropEditor() {
    if (!isRefereePage()) return;
    var stage = document.getElementById("refereeLiveStage");
    var editor = document.getElementById("cropEditor");
    var selection = document.getElementById("cropSelection");
    var label = document.getElementById("cropValue");
    if (!stage || !editor || !selection) return;
    var source = cropSourceSize();
    var stageWidth = stage.clientWidth;
    var stageHeight = stage.clientHeight;
    if (!stageWidth || !stageHeight || !source.width || !source.height) return;
    var scale = Math.min(stageWidth / source.width, stageHeight / source.height);
    var displayWidth = source.width * scale;
    var displayHeight = source.height * scale;
    editor.style.left = (stageWidth - displayWidth) / 2 + "px";
    editor.style.top = (stageHeight - displayHeight) / 2 + "px";
    editor.style.width = displayWidth + "px";
    editor.style.height = displayHeight + "px";
    var region = video.cropDraft || video.cropRegion;
    selection.style.left = region.x * 100 + "%";
    selection.style.top = region.y * 100 + "%";
    selection.style.width = region.width * 100 + "%";
    selection.style.height = region.height * 100 + "%";
    if (label) label.textContent = cropLabel(region) + (video.cropDirty ? " · 未应用" : "");
    var disabled = !video.sessionId || video.processing;
    ["applyCropBtn", "resetCropBtn"].forEach(function (id) {
      var button = document.getElementById(id);
      if (button) button.disabled = disabled || (id === "applyCropBtn" && !video.cropDirty);
    });
    renderFieldRuler();
    drawVisionOverlay();
  }

  function fieldDimensionValues() {
    var widthInput = document.getElementById("fieldWidthCm");
    var heightInput = document.getElementById("fieldHeightCm");
    var widthCm = finiteNumber(widthInput && widthInput.value);
    var heightCm = finiteNumber(heightInput && heightInput.value);
    return {
      widthCm: widthCm !== null && widthCm >= 1 && widthCm <= 100000 ? widthCm : null,
      heightCm: heightCm !== null && heightCm >= 1 && heightCm <= 100000 ? heightCm : null,
    };
  }

  function rulerStep(total, pixelLength) {
    var targetTicks = Math.max(4, Math.min(12, Math.floor(pixelLength / 65)));
    var raw = total / targetTicks;
    var magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    var normalized = raw / magnitude;
    var nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return nice * magnitude;
  }

  function rulerLabel(value) {
    return Math.abs(value - Math.round(value)) < 0.01
      ? String(Math.round(value)) : value.toFixed(1);
  }

  function renderFieldRuler() {
    var canvas = document.getElementById("fieldRulerCanvas");
    var selection = document.getElementById("cropSelection");
    if (!canvas || !selection) return;
    var width = selection.clientWidth;
    var height = selection.clientHeight;
    if (!width || !height) return;
    var pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    var canvasWidth = Math.round(width * pixelRatio);
    var canvasHeight = Math.round(height * pixelRatio);
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }
    var context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    var dimensions = fieldDimensionValues();
    if (dimensions.widthCm === null || dimensions.heightCm === null) return;

    var left = 18;
    var right = Math.max(left + 20, width - 10);
    var top = 34;
    var bottom = Math.max(top + 20, height - 18);
    var colour = "rgba(104, 255, 226, .92)";
    context.save();
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineWidth = 1;
    context.font = "700 9px system-ui, 'Microsoft YaHei', sans-serif";
    context.shadowColor = "rgba(0, 10, 20, .95)";
    context.shadowBlur = 4;
    context.beginPath();
    context.moveTo(left, bottom);
    context.lineTo(right, bottom);
    context.moveTo(left, bottom);
    context.lineTo(left, top);
    context.stroke();

    function drawHorizontalTicks() {
      var major = rulerStep(dimensions.widthCm, right - left);
      var minor = major / 5;
      for (var value = 0; value <= dimensions.widthCm + minor * 0.25; value += minor) {
        var x = left + Math.min(1, value / dimensions.widthCm) * (right - left);
        var isMajor = Math.abs(value / major - Math.round(value / major)) < 0.02;
        context.beginPath();
        context.moveTo(x, bottom);
        context.lineTo(x, bottom - (isMajor ? 8 : 4));
        context.stroke();
        if (isMajor && x < right - 4) context.fillText(rulerLabel(Math.min(value, dimensions.widthCm)), x + 2, bottom - 10);
      }
      context.textAlign = "right";
      context.fillText("X " + rulerLabel(dimensions.widthCm) + " cm", right, bottom - 10);
      context.textAlign = "left";
    }

    function drawVerticalTicks() {
      var major = rulerStep(dimensions.heightCm, bottom - top);
      var minor = major / 5;
      for (var value = 0; value <= dimensions.heightCm + minor * 0.25; value += minor) {
        var y = bottom - Math.min(1, value / dimensions.heightCm) * (bottom - top);
        var isMajor = Math.abs(value / major - Math.round(value / major)) < 0.02;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(left + (isMajor ? 8 : 4), y);
        context.stroke();
        if (isMajor && y > top + 8) context.fillText(rulerLabel(Math.min(value, dimensions.heightCm)), left + 10, y - 2);
      }
      context.fillText("Y " + rulerLabel(dimensions.heightCm) + " cm", left + 10, top + 9);
    }

    drawHorizontalTicks();
    drawVerticalTicks();
    context.restore();
  }

  function paintFieldDimensions(match) {
    var widthInput = document.getElementById("fieldWidthCm");
    var heightInput = document.getElementById("fieldHeightCm");
    var status = document.getElementById("fieldDimensionStatus");
    if (!widthInput || !heightInput) return;
    if (!fieldDimensionsDirty && document.activeElement !== widthInput) widthInput.value = finiteNumber(match && match.fieldWidthCm) || "";
    if (!fieldDimensionsDirty && document.activeElement !== heightInput) heightInput.value = finiteNumber(match && match.fieldHeightCm) || "";
    var dimensions = fieldDimensionValues();
    if (status) status.textContent = fieldDimensionsDirty
      ? "尺寸已修改 · 点击保存"
      : dimensions.widthCm !== null && dimensions.heightCm !== null
        ? "已保存 · 标尺按实际厘米显示" : "填写后在有效区显示标尺";
    renderFieldRuler();
  }

  function saveFieldDimensions() {
    var dimensions = fieldDimensionValues();
    var button = document.getElementById("saveFieldDimensions");
    var status = document.getElementById("fieldDimensionStatus");
    if (dimensions.widthCm === null || dimensions.heightCm === null) {
      if (status) status.textContent = "请输入有效的宽度和高度";
      setBadge("场地宽度和高度必须大于 0 cm", "warn");
      return Promise.resolve(null);
    }
    if (button) button.disabled = true;
    if (status) status.textContent = "正在保存…";
    return api("/api/competition/match/field", { method: "POST", body: {
      fieldWidthCm: dimensions.widthCm,
      fieldHeightCm: dimensions.heightCm,
    }}).then(function (payload) {
      fieldDimensionsDirty = false;
      referee.match = payload.match || referee.match;
      state.match = referee.match;
      paintFieldDimensions(referee.match);
      setBadge("场地尺寸已保存，厘米标尺已更新", "ok");
      return payload;
    }).catch(function (error) {
      if (status) status.textContent = "保存失败：" + error.message;
      setBadge("场地尺寸保存失败：" + error.message, "error");
      return null;
    }).finally(function () { if (button) button.disabled = false; });
  }

  function drawVisionOverlay() {
    var canvas = document.getElementById("visionOverlayCanvas");
    var stage = document.getElementById("refereeLiveStage");
    if (!canvas || !stage) return;
    var width = stage.clientWidth;
    var height = stage.clientHeight;
    if (!width || !height) return;
    var pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    var canvasWidth = Math.round(width * pixelRatio);
    var canvasHeight = Math.round(height * pixelRatio);
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }
    var context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!video.sessionId) return;

    var metrics = video.metrics || {};
    var frame = metrics.frame || {};
    var source = metrics.cameraFrame || frame;
    var sourceWidth = finiteNumber(source.width);
    var sourceHeight = finiteNumber(source.height);
    var frameWidth = finiteNumber(frame.width);
    var frameHeight = finiteNumber(frame.height);
    if (!sourceWidth || !sourceHeight || !frameWidth || !frameHeight) return;
    var crop = normalizeCropRegion(metrics.crop) || { x: 0, y: 0, width: 1, height: 1 };
    var scale = Math.min(width / sourceWidth, height / sourceHeight);
    var offsetX = (width - sourceWidth * scale) / 2;
    var offsetY = (height - sourceHeight * scale) / 2;
    var cropWidth = sourceWidth * crop.width;
    var cropHeight = sourceHeight * crop.height;

    function mapPoint(point) {
      if (!Array.isArray(point) || point.length < 2) return null;
      var x = finiteNumber(point[0]);
      var y = finiteNumber(point[1]);
      if (x === null || y === null) return null;
      return [
        offsetX + (sourceWidth * crop.x + x * cropWidth / frameWidth) * scale,
        offsetY + (sourceHeight * crop.y + y * cropHeight / frameHeight) * scale,
      ];
    }

    function drawPolyline(points, colour, widthPx, dashed) {
      if (!Array.isArray(points) || points.length < 2) return;
      var mapped = points.map(mapPoint).filter(Boolean);
      if (mapped.length < 2) return;
      context.save();
      context.beginPath();
      context.moveTo(mapped[0][0], mapped[0][1]);
      mapped.slice(1).forEach(function (point) { context.lineTo(point[0], point[1]); });
      context.strokeStyle = colour;
      context.lineWidth = widthPx;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.shadowColor = colour;
      context.shadowBlur = 7;
      if (dashed) context.setLineDash([9, 6]);
      context.stroke();
      context.restore();
    }

    var geometry = metrics.overlayGeometry || {};
    if (video.overlays.plannedPath) drawPolyline(geometry.plannedPath, "#d75cff", 3, true);
    if (video.overlays.trajectory) drawPolyline(geometry.trajectory, "#ffe45c", 2.5, false);
    if (!video.overlays.detections) return;
    var detections = metrics.yolo && Array.isArray(metrics.yolo.detections)
      ? metrics.yolo.detections : [];
    detections.forEach(function (detection) {
      var box = detection && detection.bbox;
      if (!Array.isArray(box) || box.length < 4) return;
      var start = mapPoint([box[0], box[1]]);
      var end = mapPoint([box[2], box[3]]);
      if (!start || !end) return;
      var colour = /^#[0-9a-f]{6}$/i.test(String(detection.colorHex || ""))
        ? detection.colorHex : "#48edff";
      context.save();
      context.strokeStyle = colour;
      context.lineWidth = 2;
      context.shadowColor = colour;
      context.shadowBlur = 8;
      context.strokeRect(start[0], start[1], Math.max(1, end[0] - start[0]), Math.max(1, end[1] - start[1]));
      context.shadowBlur = 0;
      var confidence = finiteNumber(detection.confidence);
      var label = "#" + (detection.trackId == null ? "-" : detection.trackId) +
        (confidence === null ? "" : "  " + Math.round(confidence * 100) + "%");
      context.font = "700 11px system-ui, 'Microsoft YaHei', sans-serif";
      var labelWidth = context.measureText(label).width + 10;
      var labelY = Math.max(2, start[1] - 19);
      context.fillStyle = "rgba(2, 18, 33, .88)";
      context.fillRect(start[0], labelY, labelWidth, 18);
      context.fillStyle = colour;
      context.fillText(label, start[0] + 5, labelY + 13);
      context.restore();
    });
  }

  function trackingGeometry() {
    var stage = document.getElementById("refereeLiveStage");
    if (!stage) return null;
    var metrics = video.metrics || {};
    var frame = metrics.frame || {};
    var source = metrics.cameraFrame || frame;
    var sourceWidth = finiteNumber(source.width);
    var sourceHeight = finiteNumber(source.height);
    var frameWidth = finiteNumber(frame.width);
    var frameHeight = finiteNumber(frame.height);
    var width = stage.clientWidth;
    var height = stage.clientHeight;
    if (!sourceWidth || !sourceHeight || !frameWidth || !frameHeight || !width || !height) return null;
    var crop = normalizeCropRegion(metrics.crop) || { x: 0, y: 0, width: 1, height: 1 };
    var scale = Math.min(width / sourceWidth, height / sourceHeight);
    return {
      stage: stage,
      width: width,
      height: height,
      sourceWidth: sourceWidth,
      sourceHeight: sourceHeight,
      frameWidth: frameWidth,
      frameHeight: frameHeight,
      crop: crop,
      scale: scale,
      offsetX: (width - sourceWidth * scale) / 2,
      offsetY: (height - sourceHeight * scale) / 2,
    };
  }

  function trackingFramePoint(clientX, clientY) {
    var geometry = trackingGeometry();
    if (!geometry) return null;
    var rect = geometry.stage.getBoundingClientRect();
    var sourceX = (clientX - rect.left - geometry.offsetX) / geometry.scale;
    var sourceY = (clientY - rect.top - geometry.offsetY) / geometry.scale;
    var cropWidth = geometry.sourceWidth * geometry.crop.width;
    var cropHeight = geometry.sourceHeight * geometry.crop.height;
    if (cropWidth <= 0 || cropHeight <= 0) return null;
    return [
      Math.max(0, Math.min(geometry.frameWidth, (sourceX - geometry.sourceWidth * geometry.crop.x) * geometry.frameWidth / cropWidth)),
      Math.max(0, Math.min(geometry.frameHeight, (sourceY - geometry.sourceHeight * geometry.crop.y) * geometry.frameHeight / cropHeight)),
    ];
  }

  function trackingCanvasPoint(point, geometry) {
    if (!Array.isArray(point) || point.length < 2) return null;
    var x = finiteNumber(point[0]);
    var y = finiteNumber(point[1]);
    if (x === null || y === null) return null;
    var crop = geometry.crop;
    return [
      geometry.offsetX + (geometry.sourceWidth * crop.x + x * geometry.sourceWidth * crop.width / geometry.frameWidth) * geometry.scale,
      geometry.offsetY + (geometry.sourceHeight * crop.y + y * geometry.sourceHeight * crop.height / geometry.frameHeight) * geometry.scale,
    ];
  }

  function drawTrackingCanvas() {
    var canvas = document.getElementById("trackingPathCanvas");
    var geometry = trackingGeometry();
    if (!canvas || !geometry) return;
    var pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(geometry.width * pixelRatio);
    canvas.height = Math.round(geometry.height * pixelRatio);
    var context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, geometry.width, geometry.height);
    var points = video.trackingDraftPoints;
    if (!Array.isArray(points) || points.length < 2) return;
    var mapped = points.map(function (point) { return trackingCanvasPoint(point, geometry); }).filter(Boolean);
    if (mapped.length < 2) return;
    context.save();
    context.beginPath();
    context.moveTo(mapped[0][0], mapped[0][1]);
    mapped.slice(1).forEach(function (point) { context.lineTo(point[0], point[1]); });
    context.strokeStyle = "#58e4ff";
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.setLineDash([]);
    context.shadowColor = context.strokeStyle;
    context.shadowBlur = 8;
    context.stroke();
    context.restore();
  }

  function trackingPlayers() {
    var players = [];
    ["blue", "red"].forEach(function (side) {
      var team = state.match && state.match[side];
      (team && team.players || []).forEach(function (player) {
        if (!player || !player.deviceId) return;
        players.push({
          slot: String(player.slot || "").toUpperCase(),
          name: player.name || player.slot || player.deviceId,
          deviceId: String(player.deviceId),
          online: !!(state.devices || []).some(function (device) {
            return sameDeviceId(device, player.deviceId) && device.online !== false;
          }),
        });
      });
    });
    return players;
  }

  function setTrackingStatus(message, tone) {
    var node = document.getElementById("trackingStatus");
    if (!node) return;
    node.textContent = message;
    node.className = "trackingStatus" + (tone ? " " + tone : "");
    node.dataset.userMessage = "1";
  }

  function trackingIsActive() {
    return video.metrics && video.metrics.workflow && video.metrics.workflow.trackingActive === true;
  }

  function waitForTrackingStart(attempt) {
    attempt = Number(attempt) || 0;
    if (trackingIsActive()) {
      setTrackingStatus("循迹已启动，正在控制真实设备", "good");
      renderTrackingControls();
      return;
    }
    var workflow = trackingWorkflow();
    if (attempt >= 8) {
      var reason = workflow.status || (Array.isArray(workflow.blockers) && workflow.blockers[0]) || "视觉控制未进入运行状态";
      setTrackingStatus("循迹未启动：" + reason, "error");
      renderTrackingControls();
      return;
    }
    window.setTimeout(function () { waitForTrackingStart(attempt + 1); }, 250);
  }

  function trackingWorkflow() {
    return (video.metrics && video.metrics.workflow) || {};
  }

  function renderTrackingControls() {
    var panel = document.getElementById("trackingPanel");
    if (!panel) return;
    panel.hidden = !video.trackingEntryOpen;
    var entry = document.getElementById("trackingEntryBtn");
    if (entry) {
      entry.textContent = video.trackingEntryOpen ? "收起循迹控制" : "打开循迹控制";
      entry.setAttribute("aria-expanded", video.trackingEntryOpen ? "true" : "false");
    }
    var drawCanvas = document.getElementById("trackingPathCanvas");
    if (drawCanvas) drawCanvas.classList.toggle("active", video.trackingDrawEnabled);
    var mode = document.getElementById("trackingModeSelect");
    var device = document.getElementById("trackingDeviceSelect");
    var track = document.getElementById("trackingTrackSelect");
    var trackField = document.getElementById("trackingTrackField");
    if (mode) {
      mode.value = video.trackingMode === "yolo" ? "yolo" : "single_fish";
      mode.disabled = !video.sessionId || trackingIsActive();
    }
    if (device) {
      var players = trackingPlayers();
      var signature = players.map(function (item) { return [item.slot, item.deviceId, item.online ? "1" : "0"].join(":"); }).join("|");
      if (device.dataset.options !== signature) {
        device.replaceChildren();
        var empty = document.createElement("option");
        empty.value = "";
        empty.textContent = players.length ? "请选择已分配设备" : "暂无已分配设备";
        device.appendChild(empty);
        players.forEach(function (item) {
          var option = document.createElement("option");
          option.value = item.deviceId;
          option.textContent = item.slot + " · " + item.name + (item.online ? " · 在线" : " · 离线");
          option.disabled = !item.online;
          device.appendChild(option);
        });
        device.dataset.options = signature;
      }
      device.value = video.trackingDeviceId || "";
      device.disabled = !video.sessionId || trackingIsActive();
    }
    if (track) {
      var detections = video.metrics.yolo && Array.isArray(video.metrics.yolo.detections) ? video.metrics.yolo.detections : [];
      var trackSignature = detections.map(function (item) { return item.trackId + ":" + item.color; }).join("|");
      if (track.dataset.options !== trackSignature) {
        track.replaceChildren();
        var trackEmpty = document.createElement("option");
        trackEmpty.value = "";
        trackEmpty.textContent = detections.length ? "请选择识别目标" : "当前未识别到目标";
        track.appendChild(trackEmpty);
        detections.forEach(function (item) {
          var option = document.createElement("option");
          option.value = String(item.trackId);
          option.textContent = "#" + item.trackId + (item.color ? " · " + item.color : "");
          track.appendChild(option);
        });
        track.dataset.options = trackSignature;
      }
      track.value = video.trackingTrackId == null ? "" : String(video.trackingTrackId);
      track.disabled = !video.sessionId || video.trackingMode !== "yolo" || trackingIsActive();
    }
    if (trackField) trackField.hidden = video.trackingMode !== "yolo";
    var draw = document.getElementById("trackingDrawBtn");
    var clear = document.getElementById("trackingClearBtn");
    var calibrate = document.getElementById("trackingCalibrateBtn");
    var start = document.getElementById("trackingStartBtn");
    var stop = document.getElementById("trackingStopBtn");
    var workflow = trackingWorkflow();
    if (calibrate) {
      calibrate.disabled = !video.sessionId || !video.processing || !video.trackingDeviceId || trackingIsActive() || workflow.headingCalibrating === true;
      calibrate.textContent = workflow.headingCalibrating ? "正在采集方向…" : workflow.headingCalibrated ? "重新校准方向" : "可选：校准方向";
    }
    if (draw) {
      draw.textContent = video.trackingDrawEnabled ? "完成绘制" : "绘制循迹线";
      draw.classList.toggle("active", video.trackingDrawEnabled);
      draw.disabled = !video.sessionId || !video.processing || trackingIsActive();
    }
    if (clear) clear.disabled = !video.sessionId || !video.processing || trackingIsActive();
    if (start) start.disabled = !video.sessionId || !video.processing || !video.trackingPath.length || !video.trackingDeviceId || (video.trackingMode === "yolo" && video.trackingTrackId == null) || workflow.canStart !== true || trackingIsActive();
    if (stop) stop.disabled = !video.sessionId || !trackingIsActive();
    if (video.trackingEntryOpen && video.sessionId && video.processing && !trackingIsActive() && Array.isArray(workflow.blockers) && workflow.blockers.length) {
      var statusNode = document.getElementById("trackingStatus");
      if (statusNode && !statusNode.dataset.userMessage) {
        statusNode.textContent = "启动条件：" + workflow.blockers[0];
        statusNode.className = "trackingStatus warn";
      }
    } else if (video.trackingEntryOpen && video.sessionId && video.processing && !trackingIsActive() && workflow.autoDirectionCorrection === true) {
      var directionStatus = document.getElementById("trackingStatus");
      if (directionStatus && !directionStatus.dataset.userMessage) {
        directionStatus.textContent = "无需预先确认方向；启动后按实际位移自动修正";
        directionStatus.className = "trackingStatus info";
      }
    }
    drawTrackingCanvas();
  }

  function setTrackingTarget(deviceId, trackId) {
    if (!video.sessionId) return Promise.reject(new Error("请先启动真实视频"));
    video.trackingDeviceId = deviceId || "";
    video.trackingTrackId = trackId == null || trackId === "" ? null : Number(trackId);
    return api("/api/vision/sessions/" + encodeURIComponent(video.sessionId) + "/target", {
      method: "POST",
      body: { targetDeviceId: video.trackingDeviceId || null, targetTrackId: video.trackingTrackId },
    }).then(function (payload) {
      applyVisionSession(sessionData(payload));
      setTrackingStatus("已绑定目标设备与视觉目标", "good");
    });
  }

  function sendTrackingAction(type, extra) {
    if (!video.sessionId) return Promise.reject(new Error("请先启动真实视频"));
    return api("/api/vision/sessions/" + encodeURIComponent(video.sessionId) + "/actions", {
      method: "POST",
      body: Object.assign({ type: type }, extra || {}),
    }).then(function (payload) {
      applyVisionSession(sessionData(payload));
    });
  }

  function clearTrackingPath() {
    if (!video.sessionId || !video.processing) return Promise.resolve();
    return sendTrackingAction("path.clear").then(function () {
      video.trackingPath = [];
      video.trackingDraftPoints = [];
      video.overlays.plannedPath = false;
      renderVideoControls();
      setTrackingStatus("循迹线已清除", "good");
    }).catch(function (error) { setTrackingStatus("清除路径失败：" + error.message, "error"); });
  }

  function beginTrackingDraw(event) {
    if (!video.trackingDrawEnabled || !video.sessionId || !video.processing || event.target.closest(".cropEditor")) return;
    var point = trackingFramePoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    video.trackingDraftPoints = [point];
    drawTrackingCanvas();
  }

  function moveTrackingDraw(event) {
    if (!video.trackingDrawEnabled || !video.trackingDraftPoints.length) return;
    var point = trackingFramePoint(event.clientX, event.clientY);
    if (!point) return;
    var last = video.trackingDraftPoints[video.trackingDraftPoints.length - 1];
    if ((point[0] - last[0]) ** 2 + (point[1] - last[1]) ** 2 < 16) return;
    video.trackingDraftPoints.push(point);
    drawTrackingCanvas();
  }

  function finishTrackingDraw(event) {
    if (!video.trackingDraftPoints.length) return;
    var point = trackingFramePoint(event.clientX, event.clientY);
    if (point) video.trackingDraftPoints.push(point);
    var points = video.trackingDraftPoints.slice();
    video.trackingDraftPoints = [];
    if (points.length < 2) {
      setTrackingStatus("至少绘制两个路径点", "warn");
      drawTrackingCanvas();
      return;
    }
    api("/api/vision/sessions/" + encodeURIComponent(video.sessionId) + "/actions", {
      method: "POST",
      body: { type: "path.draw", points: points },
    }).then(function (payload) {
      video.trackingPath = points;
      video.overlays.plannedPath = true;
      applyVisionSession(sessionData(payload));
      setVisionOverlay("plannedPath", true);
      video.trackingDrawEnabled = false;
      renderVideoControls();
      setTrackingStatus("循迹线已保存，可以启动循迹", "good");
    }).catch(function (error) {
      drawTrackingCanvas();
      setTrackingStatus("保存循迹线失败：" + error.message, "error");
    });
  }

  function bindTrackingControls() {
    var stage = document.getElementById("refereeLiveStage");
    if (stage && !stage.dataset.trackingBound) {
      stage.dataset.trackingBound = "1";
      stage.addEventListener("pointerdown", beginTrackingDraw);
      stage.addEventListener("pointermove", moveTrackingDraw);
      stage.addEventListener("pointerup", finishTrackingDraw);
      stage.addEventListener("pointercancel", finishTrackingDraw);
    }
    var entry = document.getElementById("trackingEntryBtn");
    if (entry && !entry.dataset.bound) entry.addEventListener("click", function () {
      video.trackingEntryOpen = !video.trackingEntryOpen;
      renderTrackingControls();
    });
    var mode = document.getElementById("trackingModeSelect");
    if (mode && !mode.dataset.bound) mode.addEventListener("change", function (event) {
      video.trackingMode = event.target.value === "yolo" ? "yolo" : "single_fish";
      sendTrackingAction("tracking.mode", { mode: video.trackingMode }).catch(function (error) { setTrackingStatus("切换循迹模式失败：" + error.message, "error"); });
      renderTrackingControls();
    });
    var device = document.getElementById("trackingDeviceSelect");
    if (device && !device.dataset.bound) device.addEventListener("change", function (event) {
      setTrackingTarget(event.target.value, video.trackingMode === "yolo" ? video.trackingTrackId : null)
        .catch(function (error) { setTrackingStatus("绑定设备失败：" + error.message, "error"); });
    });
    var track = document.getElementById("trackingTrackSelect");
    if (track && !track.dataset.bound) track.addEventListener("change", function (event) {
      setTrackingTarget(video.trackingDeviceId, event.target.value === "" ? null : Number(event.target.value))
        .catch(function (error) { setTrackingStatus("绑定识别目标失败：" + error.message, "error"); });
    });
    var draw = document.getElementById("trackingDrawBtn");
    if (draw && !draw.dataset.bound) draw.addEventListener("click", function () {
      if (!video.sessionId || !video.processing) return setTrackingStatus("请先启动真实视频和 YOLO 识别", "warn");
      video.trackingDrawEnabled = !video.trackingDrawEnabled;
      renderTrackingControls();
      setTrackingStatus(video.trackingDrawEnabled ? "请在完整视频上按住鼠标拖出循迹线" : "绘制已结束", "info");
    });
    var clear = document.getElementById("trackingClearBtn");
    if (clear && !clear.dataset.bound) clear.addEventListener("click", clearTrackingPath);
    var start = document.getElementById("trackingStartBtn");
    if (start && !start.dataset.bound) start.addEventListener("click", function () {
      setTrackingStatus("正在启动真实设备控制…", "info");
      sendTrackingAction("tracking.start").then(function () { waitForTrackingStart(0); }).catch(function (error) { setTrackingStatus("启动循迹失败：" + error.message, "error"); });
    });
    var stop = document.getElementById("trackingStopBtn");
    if (stop && !stop.dataset.bound) stop.addEventListener("click", function () {
      sendTrackingAction("tracking.stop").then(function () { setTrackingStatus("循迹已停止，设备保持静止", "good"); renderTrackingControls(); }).catch(function (error) { setTrackingStatus("停止循迹失败：" + error.message, "error"); });
    });
    var calibrate = document.getElementById("trackingCalibrateBtn");
    if (calibrate && !calibrate.dataset.bound) calibrate.addEventListener("click", function () {
      sendTrackingAction("heading.calibrate").then(function () {
        setTrackingStatus("正在让设备直行约 3.4 秒以确认前进方向，请保持设备和画面稳定", "warn");
        renderTrackingControls();
      }).catch(function (error) { setTrackingStatus("方向确认失败：" + error.message, "error"); });
    });
    [entry, mode, device, track, draw, clear, calibrate, start, stop].forEach(function (node) { if (node) node.dataset.bound = "1"; });
  }

  // The player receives the same high-frame-rate, unpainted WebRTC stream as
  // the referee. Draw only live YOLO boxes in the browser so inference speed
  // cannot throttle capture/encoding and referee-only path overlays never leak
  // into the player view.
  function renderPlayerDetectionOverlay() {
    if (isRefereePage()) return;
    var stage = videoSurface();
    if (!stage || !stage.classList.contains("matchPool")) return;
    var element = stage.querySelector("video[data-fish-video]");
    var canvas = stage.querySelector("canvas[data-player-detection-overlay]");
    if (!element || !canvas) return;

    var width = stage.clientWidth;
    var height = stage.clientHeight;
    if (!width || !height) return;
    var pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    var canvasWidth = Math.round(width * pixelRatio);
    var canvasHeight = Math.round(height * pixelRatio);
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }
    var context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!video.sessionId || element.hidden) return;

    var metrics = video.metrics || {};
    var frame = metrics.frame || {};
    var sourceWidth = finiteNumber(element.videoWidth) || finiteNumber(frame.width);
    var sourceHeight = finiteNumber(element.videoHeight) || finiteNumber(frame.height);
    var coordinateWidth = finiteNumber(frame.width) || sourceWidth;
    var coordinateHeight = finiteNumber(frame.height) || sourceHeight;
    if (!sourceWidth || !sourceHeight || !coordinateWidth || !coordinateHeight) return;

    // The player video uses object-fit:contain. These offsets keep boxes on the
    // actual pixels instead of stretching them across any letterbox area.
    var scale = Math.min(width / sourceWidth, height / sourceHeight);
    var displayWidth = sourceWidth * scale;
    var displayHeight = sourceHeight * scale;
    var offsetX = (width - displayWidth) / 2;
    var offsetY = (height - displayHeight) / 2;
    var scaleX = displayWidth / coordinateWidth;
    var scaleY = displayHeight / coordinateHeight;
    var detections = metrics.yolo && Array.isArray(metrics.yolo.detections)
      ? metrics.yolo.detections : [];

    detections.forEach(function (detection) {
      var box = detection && detection.bbox;
      if (!Array.isArray(box) || box.length < 4) return;
      var x1 = finiteNumber(box[0]);
      var y1 = finiteNumber(box[1]);
      var x2 = finiteNumber(box[2]);
      var y2 = finiteNumber(box[3]);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return;
      x1 = offsetX + Math.max(0, Math.min(coordinateWidth, x1)) * scaleX;
      y1 = offsetY + Math.max(0, Math.min(coordinateHeight, y1)) * scaleY;
      x2 = offsetX + Math.max(0, Math.min(coordinateWidth, x2)) * scaleX;
      y2 = offsetY + Math.max(0, Math.min(coordinateHeight, y2)) * scaleY;
      var boxWidth = Math.max(1, x2 - x1);
      var boxHeight = Math.max(1, y2 - y1);
      var colour = /^#[0-9a-f]{6}$/i.test(String(detection.colorHex || ""))
        ? detection.colorHex : "#48edff";
      var confidence = finiteNumber(detection.confidence);
      var label = "#" + (detection.trackId == null ? "-" : detection.trackId) +
        (confidence === null ? "" : "  " + Math.round(confidence * 100) + "%");

      context.save();
      context.strokeStyle = colour;
      context.lineWidth = 2;
      context.shadowColor = colour;
      context.shadowBlur = 8;
      context.strokeRect(x1, y1, boxWidth, boxHeight);
      context.shadowBlur = 0;
      context.font = "700 11px system-ui, 'Microsoft YaHei', sans-serif";
      var labelWidth = context.measureText(label).width + 10;
      var labelY = Math.max(offsetY + 2, y1 - 19);
      context.fillStyle = "rgba(2, 18, 33, .88)";
      context.fillRect(x1, labelY, labelWidth, 18);
      context.fillStyle = colour;
      context.fillText(label, x1 + 5, labelY + 13);
      context.restore();
    });
  }

  function setCropDraft(region) {
    var normalized = normalizeCropRegion(region);
    if (!normalized) return;
    video.cropDraft = normalized;
    video.cropDirty = true;
    renderCropEditor();
  }

  function normalizeRotation(value) {
    var angle = finiteNumber(value && typeof value === "object" ? value.angle : value);
    return angle !== null && angle >= -180 && angle <= 180 ? angle : null;
  }

  function renderRotationControls() {
    var range = document.getElementById("rotationRange");
    var number = document.getElementById("rotationNumber");
    var value = document.getElementById("rotationValue");
    var cost = document.getElementById("rotationCost");
    var apply = document.getElementById("applyRotationBtn");
    var reset = document.getElementById("resetRotationBtn");
    if (!range || !number || !value) return;
    var desired = video.rotationDraft === null ? video.rotationAngle : video.rotationDraft;
    range.value = String(desired);
    number.value = String(desired);
    value.textContent = formatNumber(desired) + "°" + (video.rotationDraft === null ? "" : " · 未应用");
    var disabled = !video.sessionId || video.processing;
    if (apply) apply.disabled = disabled || video.rotationDraft === null;
    if (reset) reset.disabled = disabled || desired === 0;
    if (cost) {
      var rotationMs = finiteNumber(video.metrics && video.metrics.rotationMs);
      cost.textContent = rotationMs === null ? "等待测量" : rotationMs.toFixed(1) + " ms / 帧";
    }
  }

  function setRotationDraft(rawAngle) {
    var angle = normalizeRotation(rawAngle);
    if (angle === null) return;
    video.rotationDraft = angle;
    renderRotationControls();
  }

  function loadVideoRotation() {
    if (video.rotationLoaded || !isRefereePage()) return Promise.resolve(video.rotationAngle);
    video.rotationLoaded = true;
    return api("/api/vision/rotation").then(function (value) {
      var angle = normalizeRotation(value);
      if (angle !== null) video.rotationAngle = angle;
      video.rotationDraft = null;
      renderRotationControls();
      return video.rotationAngle;
    }).catch(function (error) {
      video.rotationLoaded = false;
      setVisionStatus("画面旋转读取失败：" + error.message, "error");
      return video.rotationAngle;
    });
  }

  function applyVideoRotation(rawAngle) {
    if (!video.sessionId || video.processing) {
      setVisionStatus(video.processing ? "请先停止视觉识别，再调整画面旋转" : "请先启动真实视频", "warn");
      return Promise.resolve();
    }
    var angle = normalizeRotation(rawAngle);
    if (angle === null) return Promise.resolve();
    setVisionStatus("正在应用画面旋转…", "info");
    return api("/api/vision/rotation", { method: "PUT", body: { angle: angle } }).then(function (saved) {
      video.rotationAngle = normalizeRotation(saved);
      if (video.rotationAngle === null) video.rotationAngle = angle;
      video.rotationDraft = null;
      closeVideoPeer();
      return refreshVisionSession(true);
    }).then(function () {
      renderRotationControls();
      if (video.sessionId) connectVideo();
      setVisionStatus("画面旋转已应用，裁剪与识别坐标已同步", "ok");
    }).catch(function (error) {
      setVisionStatus("画面旋转失败：" + error.message, "error");
      renderRotationControls();
    });
  }

  function beginCropDrag(event) {
    var handle = event.target && event.target.closest && event.target.closest("[data-corner]");
    var editor = document.getElementById("cropEditor");
    if (!handle || !editor || video.processing) return;
    event.preventDefault();
    var corner = handle.getAttribute("data-corner");
    var start = video.cropDraft || video.cropRegion;
    var anchor = {
      x: corner.indexOf("w") >= 0 ? start.x + start.width : start.x,
      y: corner.indexOf("n") >= 0 ? start.y + start.height : start.y,
    };
    video.cropDragging = true;
    function move(moveEvent) {
      var rect = editor.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var px = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
      var py = Math.max(0, Math.min(1, (moveEvent.clientY - rect.top) / rect.height));
      var west = corner.indexOf("w") >= 0;
      var north = corner.indexOf("n") >= 0;
      var x = west ? Math.min(anchor.x - 0.05, px) : anchor.x;
      var y = north ? Math.min(anchor.y - 0.05, py) : anchor.y;
      var right = west ? anchor.x : Math.max(anchor.x + 0.05, px);
      var bottom = north ? anchor.y : Math.max(anchor.y + 0.05, py);
      setCropDraft({
        x: x,
        y: y,
        width: right - x,
        height: bottom - y,
      });
    }
    function finish() {
      video.cropDragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  }

  function loadCropRegion() {
    if (video.cropLoaded || !isRefereePage()) return Promise.resolve(video.cropRegion);
    video.cropLoaded = true;
    return api("/api/vision/crop").then(function (region) {
      var normalized = normalizeCropRegion(region);
      if (normalized) video.cropRegion = normalized;
      video.cropDraft = null;
      video.cropDirty = false;
      renderCropEditor();
      return video.cropRegion;
    }).catch(function (error) {
      video.cropLoaded = false;
      setVisionStatus("有效区读取失败：" + error.message, "error");
      return video.cropRegion;
    });
  }

  function applyVideoCrop(region) {
    if (!video.sessionId || video.processing) {
      setVisionStatus(video.processing ? "请先停止视觉识别，再调整有效区" : "请先启动真实视频", "warn");
      return Promise.resolve();
    }
    var normalized = normalizeCropRegion(region);
    if (!normalized) return Promise.resolve();
    setVisionStatus("正在应用选手有效区…", "info");
    return api("/api/vision/crop", { method: "PUT", body: normalized }).then(function (saved) {
      video.cropRegion = normalizeCropRegion(saved) || normalized;
      video.cropDraft = null;
      video.cropDirty = false;
      closeVideoPeer();
      return refreshVisionSession(true);
    }).then(function () {
      renderCropEditor();
      if (video.sessionId) connectVideo();
      setVisionStatus("有效区已应用：裁判看全画面，选手仅看框内画面", "ok");
    }).catch(function (error) {
      setVisionStatus("有效区应用失败：" + error.message, "error");
      renderCropEditor();
    });
  }

  function bindCropEditor() {
    var editor = document.getElementById("cropEditor");
    if (!editor || editor.dataset.bound) return;
    editor.dataset.bound = "1";
    editor.addEventListener("pointerdown", beginCropDrag);
    var apply = document.getElementById("applyCropBtn");
    var reset = document.getElementById("resetCropBtn");
    if (apply) apply.addEventListener("click", function () { applyVideoCrop(video.cropDraft || video.cropRegion); });
    if (reset) reset.addEventListener("click", function () { setCropDraft({ x: 0, y: 0, width: 1, height: 1 }); });
    var rotationRange = document.getElementById("rotationRange");
    var rotationNumber = document.getElementById("rotationNumber");
    var applyRotation = document.getElementById("applyRotationBtn");
    var resetRotation = document.getElementById("resetRotationBtn");
    if (rotationRange) rotationRange.addEventListener("input", function (event) { setRotationDraft(event.target.value); });
    if (rotationNumber) rotationNumber.addEventListener("input", function (event) { setRotationDraft(event.target.value); });
    if (applyRotation) applyRotation.addEventListener("click", function () { applyVideoRotation(video.rotationDraft === null ? video.rotationAngle : video.rotationDraft); });
    if (resetRotation) resetRotation.addEventListener("click", function () { setRotationDraft(0); });
    var slot = document.querySelector(".arenaSlot");
    if (slot && typeof ResizeObserver === "function") {
      video.cropResizeObserver = new ResizeObserver(function () {
        renderCropEditor();
        drawVisionOverlay();
      });
      video.cropResizeObserver.observe(slot);
    }
    loadCropRegion();
    loadVideoRotation();
    renderCropEditor();
  }

  function renderCameraTelemetry() {
    var metrics = video.metrics || {};
    var frame = metrics.cameraFrame || metrics.frame || {};
    var resolution = document.querySelector("[data-camera-resolution]");
    var fps = document.querySelector("[data-camera-fps]");
    var coordinateStatus = document.getElementById("coordinateStatus");
    var targetStatus = document.getElementById("targetStatus");
    if (resolution) {
      resolution.textContent = frame.width && frame.height
        ? frame.width + " × " + frame.height : "等待相机画面";
    }
    if (fps) {
      var cameraFps = finiteNumber(metrics.cameraFps);
      fps.textContent = cameraFps === null ? "等待相机画面" : cameraFps.toFixed(1) + " FPS";
    }
    var workflow = metrics.workflow || {};
    if (coordinateStatus) coordinateStatus.textContent = workflow.poolCalibrated ? "有效区坐标已建立" : "开启识别后建立";
    if (targetStatus) {
      var detectionCount = finiteNumber(metrics.yolo && metrics.yolo.detectionCount);
      targetStatus.textContent = detectionCount && detectionCount > 0
        ? Math.round(detectionCount) + " 个目标" : "当前未识别";
    }

    var exposure = metrics.exposure || {};
    var range = document.getElementById("exposureRange");
    var setpoint = document.getElementById("exposureSetpoint");
    var value = document.getElementById("exposureValue");
    if (!range || !value) return;
    var actual = finiteNumber(exposure.actualValue);
    var minimum = finiteNumber(exposure.minimum);
    var maximum = finiteNumber(exposure.maximum);
    var step = finiteNumber(exposure.step);
    if (minimum !== null && maximum !== null && maximum > minimum) {
      range.min = String(minimum);
      range.max = String(maximum);
      range.step = String(step && step > 0 ? step : 1);
    }
    if (video.exposureDesired === null && actual !== null) range.value = String(actual);
    if (setpoint) {
      var desired = video.exposureDesired === null ? finiteNumber(range.value) : video.exposureDesired;
      setpoint.textContent = desired === null ? "—" : formatNumber(desired);
    }
    range.disabled = !video.sessionId || exposure.supported === false;
    value.textContent = exposure.supported === false
      ? "当前相机不支持" : actual === null ? "等待相机回报" : formatNumber(actual);
    var reportedCrop = normalizeCropRegion(metrics.crop);
    if (reportedCrop && !video.cropDirty && !video.cropDragging) video.cropRegion = reportedCrop;
    var reportedRotation = normalizeRotation(metrics.rotationAngle);
    if (reportedRotation !== null && video.rotationDraft === null) video.rotationAngle = reportedRotation;
    renderCropEditor();
    renderRotationControls();
  }

  function applyCameraExposure(rawValue) {
    var value = finiteNumber(rawValue);
    if (!video.sessionId || value === null) return;
    video.exposureDesired = value;
    var actionId = "referee-exposure-" + Date.now();
    setVisionStatus("正在设置相机曝光…", "info");
    api("/api/vision/sessions/" + encodeURIComponent(video.sessionId) + "/actions", {
      method: "POST",
      body: {
        type: "camera.exposure",
        mode: "absolute",
        value: value,
        actionId: actionId,
      },
    }).then(function () {
      setTimeout(function () { refreshVisionSession(true); }, 350);
      setVisionStatus("曝光设置已发送，等待相机确认", "ok");
    }).catch(function (error) {
      // Only return control to telemetry when the requested value failed.
      if (video.exposureDesired === value) video.exposureDesired = null;
      renderCameraTelemetry();
      setVisionStatus("曝光设置失败：" + error.message, "error");
      refreshVisionSession(true);
    });
  }

  function renderVideoControls() {
    if (!video.controls) return;
    var source = video.controls.querySelector("[data-video-source]");
    var camera = video.controls.querySelector("[data-video-camera]");
    var action = video.controls.querySelector("[data-video-action]");
    var processingAction = video.controls.querySelector("[data-vision-processing-action]");
    var processingStatus = video.controls.querySelector("[data-vision-processing-status]");
    var list = video.cameras;
    if (source) {
      source.value = "server";
      source.disabled = true;
    }
    if (camera) {
      camera.innerHTML = list.length
        ? list.map(function (item, index) {
          var value = String(item.index);
          var selected = value === String(video.cameraIndex);
          return '<option value="' + escapeHtml(value || "") + '"' + (selected ? " selected" : "") + ">" + escapeHtml(cameraText(item, index)) + "</option>";
        }).join("")
        : '<option value="">暂无可用摄像头</option>';
      camera.disabled = !list.length;
    }
    if (action) {
      action.textContent = video.sessionId ? "停止服务器视频" : "启动真实视频";
      action.disabled = !video.sessionId && !video.cameraIndex;
    }
    if (processingAction) {
      processingAction.classList.toggle("active", video.processing);
      processingAction.setAttribute("aria-pressed", video.processing ? "true" : "false");
      processingAction.disabled = !video.sessionId;
      var processingToggleText = processingAction.querySelector("em");
      if (processingToggleText) processingToggleText.textContent = video.processing ? "开启" : "关闭";
    }
    if (processingStatus) {
      var yolo = (video.metrics && video.metrics.yolo) || {};
      var device = yolo.device || (yolo.loading ? "GPU" : "");
      processingStatus.textContent = video.processing
        ? (device ? device + " · " : "") + (yolo.ready ? "识别运行中" : "正在加载")
        : "未启动";
    }
    video.controls.querySelectorAll("[data-vision-overlay]").forEach(function (button) {
      var name = button.getAttribute("data-vision-overlay");
      var enabled = !!video.overlays[name];
      button.classList.toggle("active", enabled);
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      button.disabled = !video.sessionId;
      var stateText = button.querySelector("em");
      if (stateText) stateText.textContent = enabled ? "开启" : "关闭";
    });
    renderCameraTelemetry();
    drawVisionOverlay();
    renderTrackingControls();
  }

  function ensureVideoControls(stage) {
    if (video.controls && video.controls.isConnected) return;
    if (!isRefereePage()) return;
    var configured = document.querySelector("[data-referee-video-controls]");
    if (configured) {
      video.controls = configured;
      if (!configured.dataset.videoBound) {
        configured.dataset.videoBound = "1";
        configured.querySelector("[data-video-camera]").addEventListener("change", function (event) {
          switchServerCamera(event.target.value);
        });
        configured.querySelector("[data-video-action]").addEventListener("click", function () {
          if (video.sessionId) stopServerVideo(); else startServerVideo();
        });
        configured.querySelector("[data-vision-processing-action]").addEventListener("click", toggleVisionProcessing);
        configured.querySelectorAll("[data-vision-overlay]").forEach(function (button) {
          button.addEventListener("click", function () {
            var name = button.getAttribute("data-vision-overlay");
            setVisionOverlay(name, !video.overlays[name]);
          });
        });
        var exposureRange = document.getElementById("exposureRange");
        var exposureSetpoint = document.getElementById("exposureSetpoint");
        if (exposureRange) {
          exposureRange.addEventListener("input", function (event) {
            video.exposureDesired = finiteNumber(event.target.value);
            if (exposureSetpoint) exposureSetpoint.textContent = formatNumber(event.target.value);
          });
          exposureRange.addEventListener("change", function (event) {
            applyCameraExposure(event.target.value);
          });
        }
      }
      bindCropEditor();
      bindTrackingControls();
      renderVideoControls();
      return;
    }
    var controls = document.createElement("div");
    controls.className = "fishVideoControls";
    controls.style.cssText = "position:absolute;left:10px;right:10px;top:10px;z-index:8;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 8px;border:1px solid rgba(80,205,255,.26);border-radius:8px;background:rgba(2,18,34,.84);backdrop-filter:blur(7px);font:11px system-ui,'Microsoft YaHei',sans-serif";
    controls.innerHTML =
      '<span style="color:#a8d8ec;font-weight:800">裁判视觉配置</span>' +
      '<label style="display:flex;align-items:center;gap:4px;color:#a8d8ec">服务器摄像头<select data-video-camera style="max-width:220px;padding:4px 6px;border-radius:5px;background:#071c31;color:#eaffff;border:1px solid rgba(80,205,255,.3)"></select></label>' +
      '<button type="button" data-video-action style="padding:5px 8px;border:1px solid rgba(65,230,162,.35);border-radius:5px;background:#0a6149;color:#eaffff;font-weight:800"></button>';
    stage.appendChild(controls);
    video.controls = controls;
    controls.querySelector("[data-video-camera]").addEventListener("change", function (event) {
      switchServerCamera(event.target.value);
    });
    controls.querySelector("[data-video-action]").addEventListener("click", function () {
      if (video.sessionId) stopServerVideo(); else startServerVideo();
    });
    renderVideoControls();
  }

  function closeVideoPeer() {
    video.connectionGeneration += 1;
    if (video.timer) {
      clearTimeout(video.timer);
      video.timer = null;
    }
    if (video.peer) {
      try { video.peer.close(); } catch (e) { /* 忽略关闭异常 */ }
    }
    if (video.stream && video.stream.getTracks) {
      video.stream.getTracks().forEach(function (track) { try { track.stop(); } catch (_) {} });
    }
    video.peer = null;
    video.stream = null;
    video.connecting = false;
    video.connectionStartedAt = 0;
    video.connectedAt = 0;
    video.lastFrameAt = 0;
    var stage = videoSurface();
    var element = stage && stage.querySelector("video[data-fish-video]");
    if (element) {
      element.srcObject = null;
      element.hidden = true;
    }
  }

  function sessionData(payload) {
    return payload && (payload.data || payload) || {};
  }

  function applyVisionSession(session) {
    video.sessionId = session.sessionId || null;
    video.processing = session.state === "processing" || session.state === "tracking";
    video.metrics = session.metrics || {};
    video.trackingMode = session.trackingMode || video.trackingMode || "single_fish";
    video.trackingDeviceId = session.targetDeviceId || video.trackingDeviceId || "";
    video.trackingTrackId = session.targetTrackId == null ? null : Number(session.targetTrackId);
    var sessionPath = video.metrics.overlayGeometry && video.metrics.overlayGeometry.plannedPath;
    if (Array.isArray(sessionPath) && sessionPath.length >= 2) video.trackingPath = sessionPath.slice();
    else if (video.metrics.overlayGeometry && Array.isArray(sessionPath)) video.trackingPath = [];
    var reportedOverlays = video.metrics.overlays || {};
    if (typeof reportedOverlays.paths === "boolean") {
      reportedOverlays.plannedPath = reportedOverlays.paths;
      reportedOverlays.trajectory = reportedOverlays.paths;
    }
    ["detections", "plannedPath", "trajectory"].forEach(function (name) {
      if (typeof reportedOverlays[name] === "boolean") video.overlays[name] = reportedOverlays[name];
    });
    if (session.cameraIndex != null) video.cameraIndex = String(session.cameraIndex);
    renderVideoControls();
    renderPlayerDetectionOverlay();
  }

  function startVisionEvents() {
    if (video.events || typeof window.EventSource !== "function") return;
    var source = new window.EventSource("/api/vision/events");
    video.events = source;
    source.addEventListener("session", function (event) {
      try {
        applyVisionSession(sessionData(JSON.parse(event.data)));
      } catch (_) {}
    });
    source.onerror = function () {
      if (source.readyState === window.EventSource.CLOSED && video.events === source) video.events = null;
    };
  }

  function refreshVisionSession(force) {
    var now = Date.now();
    if (video.sessionRefreshing || (!force && now - video.lastSessionRefresh < 2000)) return Promise.resolve(null);
    video.sessionRefreshing = true;
    video.lastSessionRefresh = now;
    return api("/api/vision/sessions/current").then(function (payload) {
      applyVisionSession(sessionData(payload));
      return sessionData(payload);
    }).catch(function () {}).finally(function () {
      video.sessionRefreshing = false;
    });
  }

  function toggleVisionProcessing() {
    if (!video.sessionId) {
      setVisionStatus("请先启动真实视频", "warn");
      return;
    }
    var path = "/api/vision/sessions/" + encodeURIComponent(video.sessionId) + "/processing";
    return api(path, { method: video.processing ? "DELETE" : "POST" }).then(function (payload) {
      applyVisionSession(sessionData(payload));
      setVisionStatus(video.processing ? "YOLO 视觉识别已启动" : "视觉识别已停止，视频预览保持开启", "ok");
    }).catch(function (error) {
      setVisionStatus("视觉识别切换失败：" + error.message, "error");
    });
  }

  function setVisionOverlay(name, enabled) {
    if (["detections", "plannedPath", "trajectory"].indexOf(name) < 0) return Promise.resolve();
    if (!video.sessionId) {
      setVisionStatus("请先启动真实视频", "warn");
      return Promise.resolve();
    }
    var previous = !!video.overlays[name];
    video.overlays[name] = !!enabled;
    renderVideoControls();
    var overlays = {};
    overlays[name] = !!enabled;
    return api("/api/vision/sessions/" + encodeURIComponent(video.sessionId) + "/actions", {
      method: "POST",
      body: { type: "overlay.set", overlays: overlays },
    }).then(function () {
      setVisionStatus((enabled ? "已开启" : "已关闭") + ({
        detections: "识别框",
        plannedPath: "规划路径",
        trajectory: "运动轨迹",
      })[name], "ok");
    }).catch(function (error) {
      video.overlays[name] = previous;
      renderVideoControls();
      setVisionStatus("画面叠加切换失败：" + error.message, "error");
    });
  }

  function loadServerCameras() {
    return api("/api/vision/cameras").then(function (payload) {
      var list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.cameras) ? payload.cameras : []);
      video.cameras = list;
      if (!video.cameraIndex || !list.some(function (camera) { return String(camera.index) === String(video.cameraIndex); })) {
        video.cameraIndex = list[0] && list[0].index != null ? String(list[0].index) : "";
      }
      renderVideoControls();
      return list;
    }).catch(function (error) {
      video.cameras = [];
      renderVideoControls();
      setVisionStatus("服务器摄像头读取失败：" + error.message, "error");
      return [];
    });
  }

  function startServerVideo() {
    if (!video.cameraIndex) {
      setVisionStatus("请先选择服务器摄像头", "warn");
      return;
    }
    video.exposureDesired = null;
    setVisionStatus("正在启动真实摄像头视频…", "info");
    return api("/api/vision/sessions", {
      method: "POST",
      body: { cameraId: "camera-" + video.cameraIndex, cameraIndex: Number(video.cameraIndex), trackingMode: "single_fish" },
    }).then(function (payload) {
      var session = sessionData(payload);
      applyVisionSession(session);
      video.source = "server";
      closeVideoPeer();
      renderVideoControls();
      setVisionStatus(video.sessionId ? "真实视频已启动，正在连接…" : "服务器视频未启动", video.sessionId ? "info" : "warn");
      if (video.sessionId) connectVideo();
      return session;
    }).catch(function (error) {
      setVisionStatus("真实视频启动失败：" + error.message, "error");
    });
  }

  function stopServerVideo() {
    var sessionId = video.sessionId;
    if (!sessionId) {
      setVisionStatus("服务器视频未启动", "info");
      return Promise.resolve();
    }
    return api("/api/vision/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" })
      .then(function () {
        video.sessionId = null;
        video.processing = false;
        video.exposureDesired = null;
        closeVideoPeer();
        renderVideoControls();
        setVisionStatus("服务器视频已停止；手动操控仍可用", "info");
      }).catch(function (error) {
        setVisionStatus("停止服务器视频失败：" + error.message, "error");
      });
  }

  function switchServerCamera(index) {
    video.cameraIndex = String(index || "");
    video.exposureDesired = null;
    renderVideoControls();
    if (!video.sessionId || !video.cameraIndex) return;
    return api("/api/vision/sessions/" + encodeURIComponent(video.sessionId) + "/camera", {
      method: "POST",
      body: { cameraId: "camera-" + video.cameraIndex, cameraIndex: Number(video.cameraIndex) },
    }).then(function () {
      closeVideoPeer();
      setVisionStatus("服务器摄像头已切换，视频保持开启", "ok");
      connectVideo();
    }).catch(function (error) {
      setVisionStatus("切换服务器摄像头失败：" + error.message, "error");
    });
  }

  function ensureVideoSurface() {
    if (!state.user) return;       // 未登录不请求视觉接口
    setVisionStatus(video.statusText || "视觉未启用", "info");
    mountVideoSurface();
    startVisionEvents();
    refreshVisionSession();
    if (isRefereePage() && !video.cameras.length && !video.cameraLoading) {
      video.cameraLoading = true;
      loadServerCameras().finally(function () { video.cameraLoading = false; });
    }
    if (video.source === "server" && !video.peer) connectVideo();
  }

  function observeRenders() {
    if (typeof window.MutationObserver !== "function" || !document.body || renderRefreshTimer) return;
    if (!renderNavigationBound) {
      renderNavigationBound = true;
      window.addEventListener("hashchange", function () {
        window.setTimeout(function () {
          ensureVideoSurface();
          paintDeviceInfo();
          paintAccountInfo();
          ensureRefereeIntegration();
        }, 0);
      });
    }
    renderRefreshTimer = window.setInterval(function () {
      ensureVideoSurface();
      // player_interface.html owns the static page renderer and may recreate
      // the control cards. Re-apply server-owned team/seat/device state after
      // that render so its B1/B2 demo defaults cannot overwrite live R1/R2
      // assignments from the controller.
      if (state.ready && !isRefereePage()) {
        paintDeviceInfo();
        paintAccountInfo();
        paintCurrentTeamIdentity();
      }
    }, 1000);
  }

  // ---------------------------------------------------------------- 裁判端
  // 裁判端设计稿的现有比赛按钮直接绑定真实后端，不再注入重复控制条。
  var referee = { match: null, elapsedMs: 0, running: false, bar: null, poll: null, clickBound: false };
  var logoutGeneration = 0;

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

  function refereeAction(action, body, propagateError) {
    return api("/api/competition/match/" + action, { method: "POST", body: body || {} })
      .then(function () { return refreshReferee(); })
      .catch(function (error) {
        setBadge("裁判操作失败：" + error.message, "error");
        if (propagateError) throw error;
        return null;
      });
  }

  window.fishCompetitionSetFieldLocked = function (locked) {
    return api("/api/competition/match/field-lock", {
      method: "POST",
      body: { fieldLocked: !!locked },
    }).then(function (payload) {
      referee.match = payload.match || referee.match;
      state.match = referee.match;
      paintReferee();
      setBadge(locked ? "场地已锁定，控制权已开放给已分配选手" : "场地已解锁，选手控制权已收回", "ok");
      return payload;
    }).catch(function (error) {
      setBadge("场地锁定操作失败：" + error.message, "error");
      throw error;
    });
  };

  function showLoggedOutScreen() {
    var layer = document.getElementById("teamAuthLayer");
    var login = loginCard();
    var confirm = confirmCard();
    var account = document.getElementById("teamAccountInput");
    var password = document.querySelector("#teamLoginCard input[type=password]");
    var error = login && login.querySelector(".teamAuthError");
    if (account) account.value = "";
    if (password) password.value = "";
    if (error) error.remove();
    if (login) login.hidden = false;
    if (confirm) confirm.hidden = true;
    if (layer) layer.hidden = false;
  }

  function resetTeamSessionState() {
    activeTeamSide = null;
    state.user = null;
    state.authenticated = false;
    state.devices = [];
    state.match = null;
    state.bound = {};
    state.sequence = {};
    state.ready = false;
    playerSeatIndexes = { b1: 1, b2: 2 };
    lastReadinessAvailability = {};
    lastPlayerReadiness = {};
    closeVideoPeer();
    if (video.events) {
      video.events.close();
      video.events = null;
    }
    if (playerMatchTimer) {
      window.clearInterval(playerMatchTimer);
      playerMatchTimer = null;
    }
    if (playerLeaseTimer) {
      window.clearInterval(playerLeaseTimer);
      playerLeaseTimer = null;
    }
    try {
      window.sessionStorage.removeItem("fishTeamTerminal");
      window.sessionStorage.removeItem("fish-player-seat-indexes");
      window.sessionStorage.removeItem("fish-active-team-side");
    } catch (_) {}
    showLoggedOutScreen();
  }

  function ensureTeamSwitcherModal() {
    var modal = document.getElementById("teamSwitcherModal");
    if (modal) return modal;
    var style = document.createElement("style");
    style.id = "teamSwitcherStyle";
    style.textContent = "#teamSwitcherModal{position:fixed;inset:0;z-index:2147482990;display:none;place-items:center;padding:20px;background:rgba(1,10,22,.72);backdrop-filter:blur(8px)}#teamSwitcherModal.show{display:grid}#teamSwitcherModal .teamSwitchCard{width:min(440px,calc(100vw - 32px));padding:22px;border:1px solid rgba(67,210,255,.35);border-radius:14px;background:linear-gradient(145deg,#082744,#061526);box-shadow:0 20px 60px rgba(0,0,0,.45);color:#e9faff}#teamSwitcherModal h3{margin:0 0 7px;font-size:18px}#teamSwitcherModal p{margin:0 0 16px;color:#91bfd4;font-size:12px;line-height:1.5}#teamSwitcherModal .teamSwitchOptions{display:grid;gap:9px}#teamSwitcherModal button{width:100%;padding:12px 14px;border:1px solid rgba(65,208,255,.35);border-radius:9px;background:#0a3557;color:#f2fcff;text-align:left;font-size:13px;font-weight:800;cursor:pointer}#teamSwitcherModal button:hover{border-color:#42ddff;background:#0d4b72}#teamSwitcherModal button[disabled]{opacity:.55;cursor:default}#teamSwitcherModal button small{display:block;margin-top:4px;color:#8db9cc;font-size:11px;font-weight:500}#teamSwitcherModal .teamSwitchCancel{margin-top:14px;border-color:rgba(145,183,199,.25);background:transparent;text-align:center;font-size:12px}";
    document.head.appendChild(style);
    modal = document.createElement("div");
    modal.id = "teamSwitcherModal";
    modal.innerHTML = '<div class="teamSwitchCard" role="dialog" aria-modal="true" aria-labelledby="teamSwitcherTitle"><h3 id="teamSwitcherTitle">切换战队</h3><p>开发阶段可直接切换当前赛事战队，无需重新输入账号密码。</p><div class="teamSwitchOptions" data-team-switch-options></div><button type="button" class="teamSwitchCancel" data-team-switch-cancel>取消</button></div>';
    modal.addEventListener("click", function (event) {
      var target = event.target;
      if (target === modal || (target.closest && target.closest("[data-team-switch-cancel]"))) {
        modal.classList.remove("show");
        return;
      }
      var button = target.closest && target.closest("[data-team-switch-side]");
      if (button && !button.disabled) switchActiveTeam(button.getAttribute("data-team-switch-side"), modal);
    });
    document.body.appendChild(modal);
    return modal;
  }

  function renderTeamSwitcher(modal) {
    var options = modal.querySelector("[data-team-switch-options]");
    if (!options) return;
    var match = state.match || {};
    options.replaceChildren();
    ["blue", "red"].forEach(function (side) {
      var team = match[side] || {};
      var name = team.name || (side === "red" ? "红队" : "蓝队");
      var players = Array.isArray(team.players) ? team.players : [];
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-team-switch-side", side);
      button.disabled = currentTeamSide() === side;
      button.textContent = (button.disabled ? "当前战队 · " : "切换到 · ") + name;
      var hint = document.createElement("small");
      hint.textContent = players.length ? players.map(function (player) { return player.name || player.slot; }).join(" / ") : "暂无队员数据";
      button.appendChild(hint);
      options.appendChild(button);
    });
  }

  function switchActiveTeam(side, modal) {
    if ((side !== "blue" && side !== "red") || side === currentTeamSide()) {
      if (modal) modal.classList.remove("show");
      return;
    }
    var previous = PLAYERS.map(function (player) { return state.bound[player]; }).filter(Boolean);
    stopAll();
    if (modal) modal.classList.remove("show");
    setBadge("正在切换到" + (side === "red" ? "红队" : "蓝队") + "…", "info");
    Promise.all(previous.map(release)).then(function () {
      activeTeamSide = side;
      try { window.sessionStorage.setItem("fish-active-team-side", side); } catch (_) {}
      state.bound = {};
      state.sequence = {};
      paintAccountInfo();
      return refreshPlayerMatch().then(function () { return refreshDevices(); });
    }).then(function () {
      setBadge("已切换到" + (side === "red" ? "红队" : "蓝队"), "ok");
    }).catch(function (error) {
      setBadge("切换战队失败：" + error.message, "error");
    });
  }

  function openTeamSwitcher(event) {
    if (event) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    var otherSide = currentTeamSide() === "red" ? "blue" : "red";
    if (state.match && state.match[otherSide]) {
      switchActiveTeam(otherSide, null);
      return;
    }
    var modal = ensureTeamSwitcherModal();
    renderTeamSwitcher(modal);
    modal.classList.add("show");
  }

  function logoutTeamAccount(event) {
    if (event) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    if (logoutPending) return;
    logoutPending = true;
    var switchGeneration = ++logoutGeneration;
    var button = event && event.target && event.target.closest && event.target.closest("[data-team-logout]");
    if (button) {
      button.disabled = true;
      button.textContent = "正在切换战队…";
    }
    stopAll();
    setBadge("正在释放设备并退出当前战队账号…", "info");
    var releaseTasks = PLAYERS.map(function (player) {
      var deviceId = state.bound[player];
      if (!deviceId) return Promise.resolve();
      delete state.bound[player];
      return release(deviceId);
    });
    // 先切换界面，设备释放与会话退出在后台完成，避免用户被网络请求阻塞。
    resetTeamSessionState();
    setBadge("可立即登录其他战队账号", "ok");
    Promise.all(releaseTasks)
      .then(function () {
        // 用户已开始登录新战队时，不再用旧会话的 logout 覆盖新会话。
        if (switchGeneration !== logoutGeneration) return null;
        return api("/api/auth/logout", { method: "POST" });
      })
      .then(function () {
        if (switchGeneration === logoutGeneration) setBadge("已退出当前战队，可登录其他战队账号", "ok");
      })
      .catch(function (error) {
        setBadge("退出失败：" + error.message, "error");
        showLoginError("退出失败：" + error.message);
      })
      .finally(function () {
        logoutPending = false;
        if (button && button.isConnected) {
          button.disabled = false;
          button.textContent = "切换战队账号";
        }
      });
  }

  function setMatchNameEditor(open) {
    var trigger = document.getElementById("currentMatchEdit");
    var editor = document.getElementById("matchNameEditor");
    var input = document.getElementById("matchNameInput");
    if (!trigger || !editor || !input) return;
    trigger.hidden = !!open;
    editor.hidden = !open;
    if (open) {
      input.value = (referee.match && referee.match.matchNo) || "";
      window.setTimeout(function () { input.focus(); input.select(); }, 0);
    }
  }

  function saveMatchName() {
    var input = document.getElementById("matchNameInput");
    var saveButton = document.getElementById("matchNameSave");
    var matchName = input ? String(input.value || "").trim() : "";
    if (!matchName) {
      setBadge("赛事名称不能为空", "warn");
      if (input) input.focus();
      return Promise.resolve(null);
    }
    if (referee.match && ["running", "paused"].indexOf(referee.match.state) >= 0) {
      setBadge("比赛进行或暂停期间不能修改赛事名称", "warn");
      return Promise.resolve(null);
    }
    if (saveButton) saveButton.disabled = true;
    return api("/api/competition/match", { method: "PUT", body: { matchNo: matchName } })
      .then(function () {
        setMatchNameEditor(false);
        setBadge("赛事名称已保存：" + matchName, "ok");
        return refreshReferee();
      })
      .catch(function (error) {
        setBadge("赛事名称保存失败：" + error.message, "error");
        return null;
      })
      .finally(function () { if (saveButton) saveButton.disabled = false; });
  }

  function refreshReferee() {
    if (!isRefereePage()) return Promise.resolve();
    return Promise.all([api("/api/competition/match"), api("/api/competition/records")])
      .then(function (results) {
        var payload = results[0];
        referee.match = payload.match;
        state.match = payload.match;
        referee.elapsedMs = payload.elapsedMs || 0;
        referee.remainingMs = payload.remainingMs != null ? payload.remainingMs : Math.max(0, (payload.match && payload.match.durationMs || 180000) - referee.elapsedMs);
        referee.running = !!payload.running;
        paintReferee();
        if (typeof window.applyCompetitionRecords === "function") {
          window.applyCompetitionRecords((results[1] && results[1].records) || []);
        }
      })
      .catch(function () { clearRefereePrototypeData("请登录裁判账号"); });
  }

  function paintReferee() {
    if (!referee.match) return;
    var match = referee.match;
    var clock = referee.bar && referee.bar.querySelector("#fishRefClock");
    var score = referee.bar && referee.bar.querySelector("#fishRefScore");
    var info = referee.bar && referee.bar.querySelector("#fishRefInfo");
    var toggle = referee.bar && referee.bar.querySelector("#fishRefToggle");
    var remainingMs = referee.remainingMs != null ? referee.remainingMs : Math.max(0, (match.durationMs || 180000) - referee.elapsedMs);
    if (clock) clock.textContent = fmtClock(remainingMs);
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
    syncText("clock", fmtClock(remainingMs));
    syncText("clockState", referee.running ? "剩余时间" : stateText(match.state));
    syncText("currentMatchSummary", [match.matchNo, match.group, match.venue].filter(Boolean).join(" · ") || "比赛信息未填写");
    var matchNameButton = document.getElementById("currentMatchEdit");
    if (matchNameButton) {
      matchNameButton.disabled = ["running", "paused"].indexOf(match.state) >= 0;
      matchNameButton.title = matchNameButton.disabled ? "比赛进行或暂停期间不能修改赛事名称" : "编辑赛事名称";
    }
    var durationButton = document.getElementById("clockDurationEdit");
    if (durationButton) {
      durationButton.disabled = ["running", "paused"].indexOf(match.state) >= 0;
      durationButton.title = durationButton.disabled ? "比赛进行或暂停期间不能修改时长" : "设置比赛倒计时";
      durationButton.textContent = fmtClock(match.durationMs || 180000);
    }
    syncText("currentBlueTeam", match.blue && match.blue.name ? match.blue.name : "蓝队");
    syncText("currentRedTeam", match.red && match.red.name ? match.red.name : "红队");
    syncText("globalState", stateText(match.state));
    if (typeof window.applyCompetitionFieldLock === "function") {
      window.applyCompetitionFieldLock(match.fieldLocked === true);
    }
    paintFieldDimensions(match);
    var allPlayers = ((match.blue && match.blue.players) || []).concat((match.red && match.red.players) || []);
    var signedCount = allPlayers.filter(function (player) { return !!player.signedIn; }).length;
    var assignedIds = allPlayers.map(function (player) { return player.deviceId; }).filter(Boolean);
    var onlineAssigned = assignedIds.filter(function (deviceId) {
      return state.devices.some(function (device) { return sameDeviceId(device, deviceId) && !!device.online; });
    }).length;
    syncText("matchSignupHealth", signedCount + " / " + allPlayers.length);
    syncText("matchDeviceHealth", onlineAssigned + " / " + assignedIds.length + " 在线");
    syncText("matchFieldHealth", match.fieldLocked === true ? "已锁定" : "待确认");
    syncText("matchSyncHealth", "已同步");
    paintRefereeRoster(match);
  }

  function syncText(id, value) {
    var node = document.getElementById(id);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function ensureRefereeBar() {
    if (!document.body || !isRefereePage()) return;
    var stale = document.getElementById("fishRefereeBar");
    if (stale) stale.remove();
    referee.bar = null;
    if (!referee.poll) referee.poll = setInterval(refreshReferee, 2000);
  }

  var playerMatchTimer = null;

  function paintPlayerMatch(payload) {
    if (isRefereePage() || !payload) return;
    var wasLocked = lastObservedFieldLocked;
    state.match = payload.match || null;
    var isLocked = !!(state.match && state.match.fieldLocked === true);
    lastObservedFieldLocked = isLocked;
    if (document.body) document.body.dataset.fishMatchState = state.match ? (state.match.state || "") : "";
    if (!state.match) return;
    if (wasLocked !== null && wasLocked !== isLocked) {
      if (isLocked) {
        setBadge("场地已锁定，正在取得已分配机器鱼的选手控制权…", "info");
        refreshDevices();
      } else {
        stopAll("场地已解锁，选手控制权已释放");
        applyBindings({});
      }
    }
    var match = payload.match;
    syncPlayerReadiness(match);
    function setAll(selector, value) {
      document.querySelectorAll(selector).forEach(function (node) { node.textContent = String(value); });
    }
    var blueName = match.blue && match.blue.name ? match.blue.name : "蓝队";
    var redName = match.red && match.red.name ? match.red.name : "红队";
    var currentName = currentTeamSide() === "red" ? redName : blueName;
    setAll("[data-live-match-title]", match.matchNo || "当前比赛");
    setAll("[data-live-match-meta]", [match.group, match.venue].filter(Boolean).join(" · ") || "比赛信息未填写");
    setAll("[data-live-blue-team]", blueName);
    setAll("[data-live-red-team]", redName);
    setAll("[data-live-current-team]", currentName);
    setAll("[data-live-blue-score]", Number(match.blue && match.blue.score) || 0);
    setAll("[data-live-red-score]", Number(match.red && match.red.score) || 0);
    setAll("[data-live-match-clock]", fmtClock(payload.elapsedMs || 0));
    setAll("[data-live-match-state]", stateText(match.state));
    setAll("[data-live-summary-state]", stateText(match.state));
  }

  function refreshPlayerMatch() {
    if (isRefereePage()) return Promise.resolve();
    var wantsRecords = String(window.location.hash || "") === "#records";
    return Promise.all([
      api("/api/competition/match"),
      wantsRecords ? api("/api/competition/records") : Promise.resolve(null),
    ]).then(function (results) {
      var payload = results[0];
      paintPlayerMatch(payload);
      if (results[1] && typeof window.applyPlayerCompetitionRecords === "function") {
        window.applyPlayerCompetitionRecords(results[1].records || []);
      }
      return payload;
    }).catch(function () {
      var matchState = document.querySelector("[data-live-match-state]");
      if (matchState) matchState.textContent = "比赛数据读取失败";
      return null;
    });
  }

  function startPlayerMatchTelemetry() {
    if (isRefereePage() || playerMatchTimer) return;
    refreshPlayerMatch();
    playerMatchTimer = window.setInterval(refreshPlayerMatch, 2000);
    window.addEventListener("hashchange", refreshPlayerMatch);
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
      return !!device.online;
    }).sort(function (left, right) {
      return String(left.deviceId || left.id || "").localeCompare(String(right.deviceId || right.id || ""), undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function deviceAssignmentLabel(device) {
    if (!device || !device.assignedTo) return "未分配";
    return "当前 " + device.assignedTo;
  }

  function currentDeviceForSlot(devices, slot) {
    var list = devices || [];
    for (var index = 0; index < list.length; index += 1) {
      if (assignedToSlot(list[index], slot)) return list[index];
    }
    return null;
  }

  function rosterDeviceForPlayer(devices, player, slot) {
    var list = devices || [];
    var current = currentDeviceForSlot(list, slot);
    if (current) return current;
    var deviceId = player && player.deviceId ? String(player.deviceId) : "";
    if (!deviceId) return null;
    for (var index = 0; index < list.length; index += 1) {
      if (sameDeviceId(list[index], deviceId)) return list[index];
    }
    return null;
  }

  function paintSignupDeviceSummary(statuses) {
    var summary = document.getElementById("signupDeviceSummary");
    if (!summary) return;
    summary.innerHTML = '<span class="online">在线 ' + statuses.online + '</span>' +
      '<span class="unassigned">未分配 ' + statuses.unassigned + '</span>';
  }

  function deviceLabel(device) {
    return deviceName(device) || "未命名机器鱼";
  }

  function loadCompetitionDevices() {
    return api("/api/competition/devices").then(function (payload) {
      return (payload && payload.devices) || [];
    });
  }

  function refereeDevices() {
    var assignments = state.competitionDevices || [];
    var merged = (state.devices || []).map(function (device) {
      var assignment = assignments.find(function (item) { return sameDeviceId(item, device); });
      return assignment ? Object.assign({}, device, assignment, { online: !!device.online }) : device;
    });
    assignments.forEach(function (assignment) {
      if (!merged.some(function (device) { return sameDeviceId(device, assignment); })) merged.push(assignment);
    });
    return merged;
  }

  function fmtSignedAt(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function paintRefereeRoster(match, devices) {
    if (!match) return;
    var rosterDevices = devices || refereeDevices();
    var blueTitle = document.querySelector(".teamCard.blue .teamHead h2");
    var redTitle = document.querySelector(".teamCard.red .teamHead h2");
    if (blueTitle) blueTitle.textContent = "蓝队 · " + (match.blue && match.blue.name ? match.blue.name : "蓝队");
    if (redTitle) redTitle.textContent = "红队 · " + (match.red && match.red.name ? match.red.name : "红队");
    var blueSelectTitle = document.querySelector(".selectGroup.blue h3");
    var redSelectTitle = document.querySelector(".selectGroup.red h3");
    if (blueSelectTitle) blueSelectTitle.textContent = "蓝队 · " + (match.blue && match.blue.name ? match.blue.name : "蓝队");
    if (redSelectTitle) redSelectTitle.textContent = "红队 · " + (match.red && match.red.name ? match.red.name : "红队");
    var deviceStatuses = { online: 0, offline: 0, unassigned: 0 };
    document.querySelectorAll(".player").forEach(function (card) {
      var title = card.querySelector(".playerTop b");
      var slot = title ? normalizeSlot(String(title.textContent).split("·")[0]) : "";
      var player = playerForSlot(match, slot);
      if (!slot || !player) return;
      var assignedDeviceId = player.deviceId ? String(player.deviceId) : "";
      var device = rosterDeviceForPlayer(rosterDevices, player, slot);
      var deviceStatus = device ? (device.online ? "online" : "offline") : (assignedDeviceId ? "offline" : "unassigned");
      deviceStatuses[deviceStatus] += 1;
      title.textContent = slot + " · " + (player.name || slot);
      card.classList.add("done");
      card.classList.remove("device-online", "device-offline", "device-unassigned");
      card.classList.add("device-" + deviceStatus);
      var deviceState = card.querySelector("[data-device-state]");
      if (deviceState) {
        deviceState.className = "deviceState " + deviceStatus;
        deviceState.textContent = deviceStatus === "online" ? "设备状态：在线" : deviceStatus === "offline" ? "设备状态：离线" : "设备状态：未分配";
      }
      card.querySelectorAll(".meta").forEach(function (meta, index) {
        var label = meta.querySelector("span");
        var value = meta.querySelector("strong");
        if (!label || !value) return;
        if (index === 0) { label.textContent = "昵称"; value.textContent = device ? deviceLabel(device) : "未分配"; }
        if (index === 1) { label.textContent = "MAC"; value.textContent = device ? (device.deviceId || device.id || "—") : "—"; }
        if (index === 2) { label.textContent = "电量"; value.textContent = device ? deviceBatteryLabel(device) : "—"; }
      });
    });
    var onlineDevices = rosterDevices.filter(function (item) { return !!item.online; });
    paintSignupDeviceSummary({
      online: onlineDevices.length,
      unassigned: onlineDevices.filter(function (item) { return !item.assignedTo; }).length,
    });
    document.querySelectorAll("[data-device-slot]").forEach(function (row) {
      var slot = normalizeSlot(row.getAttribute("data-device-slot"));
      var player = playerForSlot(match, slot);
      if (!player) return;
      var device = findDevice(player.deviceId);
      setTextIfFound(row, ".devicePerson b", player.name || slot);
      setTextIfFound(row, ".devicePerson small", player.deviceId ? (deviceName(device) || player.deviceId) : "未分配机器鱼");
    });
    document.querySelectorAll(".selectPlayer[data-slot]").forEach(function (button) {
      var slot = button.getAttribute("data-slot");
      var player = playerForSlot(match, slot);
      if (!player) return;
      setTextIfFound(button, "b", slot + " · " + (player.name || slot));
      var small = button.querySelector("small");
      if (small) small.textContent = (shortAccount(player.email) || player.name || slot) + " · " + (player.deviceId || "未分配机器鱼");
      var action = button.querySelector("span");
      if (action) action.textContent = "调整 →";
      button.disabled = false;
    });
    var players = ((match.blue && match.blue.players) || []).concat((match.red && match.red.players) || []);
    var readyCount = players.length;
    var signupNext = document.getElementById("signupNext");
    if (signupNext) {
      signupNext.disabled = false;
      signupNext.textContent = "进入场地调整";
    }
    var actionTitle = document.querySelector(".signup .actionCopy h3");
    if (actionTitle) actionTitle.textContent = readyCount + " 名选手";
    var slotNode = document.getElementById("confirmSlot");
    if (slotNode) {
      var current = playerForSlot(match, slotNode.textContent);
      if (current) {
        syncText("confirmName", current.name || current.slot);
        syncText("confirmTeam", (/^R/i.test(current.slot) ? (match.red && match.red.name) : (match.blue && match.blue.name)) || "");
        syncText("confirmId", shortAccount(current.email) || current.name || current.slot);
        syncText("confirmAccount", "默认已登录");
      }
    }
  }

  function clearRefereePrototypeData(reason) {
    if (!isRefereePage()) return;
    syncText("currentMatchSummary", "未读取到真实比赛");
    syncText("currentBlueTeam", "蓝队");
    syncText("currentRedTeam", "红队");
    syncText("globalState", "服务器数据不可用");
    syncText("blueScore", "0");
    syncText("redScore", "0");
    syncText("blueQuick", "0");
    syncText("redQuick", "0");
    syncText("clock", "00:00");
    syncText("clockState", "等待服务器");
    syncText("matchSignupHealth", "等待上报");
    syncText("matchDeviceHealth", "等待上报");
    syncText("matchSyncHealth", "读取失败");
    var blueTitle = document.querySelector(".teamCard.blue .teamHead h2");
    var redTitle = document.querySelector(".teamCard.red .teamHead h2");
    if (blueTitle) blueTitle.textContent = "蓝队 · 未读取真实账号";
    if (redTitle) redTitle.textContent = "红队 · 未读取真实账号";
    document.querySelectorAll(".player").forEach(function (card) {
      var title = card.querySelector(".playerTop b");
      var slot = title ? normalizeSlot(String(title.textContent).split("·")[0]) : "";
      if (!slot) return;
      title.textContent = slot + " · 未读取账号";
      card.classList.add("done");
      card.querySelectorAll(".meta").forEach(function (meta) {
        var label = meta.querySelector("span");
        var value = meta.querySelector("strong");
        if (!label || !value) return;
        if (label.textContent.trim() === "编号") value.textContent = "未登录";
        if (label.textContent.trim() === "机器鱼") value.textContent = "未读取";
        if (label.textContent.trim() === "席位") value.textContent = slot;
      });
    });
    document.querySelectorAll(".selectPlayer[data-slot]").forEach(function (button) {
      var slot = button.getAttribute("data-slot");
      setTextIfFound(button, "b", slot + " · 未读取账号");
      setTextIfFound(button, "small", "请先登录裁判账号");
    });
  }

  function paintSignupFish(devices) {
    paintRefereeRoster(referee.match || state.match, devices);
    document.querySelectorAll(".player").forEach(function (card) {
      var title = card.querySelector(".playerTop b");
      var slot = title ? normalizeSlot(String(title.textContent).split("·")[0]) : "";
      if (!slot) return;
      var current = currentDeviceForSlot(devices, slot);
      card.querySelectorAll(".meta").forEach(function (meta) {
        var label = meta.querySelector("span");
        var value = meta.querySelector("strong");
        if (label && value && label.textContent.trim() === "机器鱼") {
          value.textContent = current ? (deviceLabel(current) + " · " + deviceStatusLabel(current)) : "未分配";
        }
      });
    });
  }

  function paintSelectFish(devices) {
    document.querySelectorAll(".selectPlayer[data-slot]").forEach(function (button) {
      var slot = button.getAttribute("data-slot");
      var current = currentDeviceForSlot(devices, slot);
      var available = devicesForSlot(devices, slot);
      var summary = current ? ("已分配：" + deviceLabel(current) + "（" + deviceStatusLabel(current) + "）")
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
      field.textContent = current ? (deviceLabel(current) + " · " + deviceStatusLabel(current)) : "未分配";
    }
  }

  function refreshFishAssignments() {
    if (!isRefereePage()) return Promise.resolve();
    if (!state.authenticated) {
      clearRefereePrototypeData("请登录裁判账号");
      return Promise.resolve();
    }
    return loadCompetitionDevices()
      .then(function (devices) {
        state.competitionDevices = devices;
        paintSignupFish(devices);
        paintSelectFish(devices);
        var slotNode = document.getElementById("confirmSlot");
        if (slotNode) paintConfirmFish(devices, slotNode.textContent);
      })
      .catch(function () { clearRefereePrototypeData("真实机器鱼状态读取失败"); });
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
        var label = deviceLabel(device) + (mine ? "（本席位）" : "（" + deviceAssignmentLabel(device) + "，将自动换绑）");
        options.push('<option value="' + escapeHtml(id) + '"' + (mine ? " selected" : "") + ">" + escapeHtml(label) + "</option>");
      });
      select.innerHTML = options.join("");
      if (currentDevice) select.value = currentDevice.deviceId || currentDevice.id || "";
      if (hint) {
        var onlineCount = list.filter(function (device) { return device.online; }).length;
        hint.textContent = onlineCount ? ("在线可分配 " + onlineCount + " 条；选中已分配鱼会自动换绑")
          : (currentDevice ? "当前分配设备离线，归属仍保留" : "无在线机器鱼");
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

    if (target.closest("#openSignup")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openDeviceManager();
      return true;
    }

    if (target.closest("#currentMatchEdit")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!target.closest("#currentMatchEdit").disabled) setMatchNameEditor(true);
      return true;
    }
    if (target.closest("#clockDurationEdit")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      var currentDuration = Number(referee.match && referee.match.durationMs) || 180000;
      var value = window.prompt("输入比赛倒计时（分:秒，范围 00:10 至 60:00）", fmtClock(currentDuration));
      if (value == null) return true;
      var parts = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
      var seconds = parts ? Number(parts[1]) * 60 + Number(parts[2]) : 0;
      if (!parts || Number(parts[2]) > 59 || seconds < 10 || seconds > 3600) {
        setBadge("时长格式无效，请使用 分:秒（00:10 至 60:00）", "warn");
        return true;
      }
      api("/api/competition/match", { method: "PUT", body: { durationMs: seconds * 1000 } })
        .then(function () { setBadge("比赛倒计时已设置为 " + fmtClock(seconds * 1000), "ok"); return refreshReferee(); })
        .catch(function (error) { setBadge("倒计时设置失败：" + error.message, "error"); });
      return true;
    }
    if (target.closest("#matchNameCancel")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setMatchNameEditor(false);
      return true;
    }
    if (target.closest("#matchNameSave")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      saveMatchName();
      return true;
    }

    var scoreButton = target.closest("[data-score]");
    if (scoreButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      var delta = Number(scoreButton.getAttribute("data-score"));
      var side = scoreButton.getAttribute("data-team");
      if (side && delta) refereeAction("score", { side: side, delta: delta });
      return true;
    }
    if (target.closest("#startBtn")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      refereeAction("clock", { action: "start" });
      return true;
    }
    if (target.closest("#pauseBtn")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      // 设计稿的按钮是“暂停/继续”切换
      refereeAction("clock", { action: referee.running ? "pause" : "start" });
      return true;
    }
    if (target.closest("#endBtn")) {
      event.preventDefault();
      event.stopImmediatePropagation();
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
      event.preventDefault();
      event.stopImmediatePropagation();
      var slotNode = document.getElementById("confirmSlot");
      var slot = slotNode ? String(slotNode.textContent).trim() : "";
      if (slot) {
        var side = /^B/i.test(slot) ? "blue" : "red";
        var select = document.getElementById("fishAssignSelect");
        var deviceId = select ? select.value : "";
        var confirmButton = target.closest("#confirmBtn");
        if (confirmButton) confirmButton.disabled = true;
        var chain = Promise.resolve();
        if (deviceId) {
          // 先建立归属，再记录签到
          chain = chain.then(function () {
            return refereeAction("assign", { side: side, slot: slot, deviceId: deviceId }, true);
          });
        } else {
          // 选择“暂不分配”即解除该席位的机器鱼归属
          chain = chain.then(function () {
            return refereeAction("unassign", { side: side, slot: slot }, true);
          });
        }
        chain.then(function () {
          return refereeAction("signin", { side: side, slot: slot, signedIn: true }, true);
        }).then(function () {
          var modal = document.getElementById("modal");
          if (modal) modal.classList.remove("show");
          setBadge(slot + " 的选手与机器鱼分配已保存", "ok");
          return refreshFishAssignments();
        }).catch(function () {
          // 保持弹窗打开，让裁判修正选择；错误已由 refereeAction 展示。
        }).finally(function () {
          if (confirmButton) confirmButton.disabled = false;
        });
      }
      return true;
    }
    return false;
  }

  function handleRefereeClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest("#saveFieldDimensions")) {
      event.preventDefault();
      saveFieldDimensions();
      return;
    }
    if (handleRefereePrototypeClick(event)) return;
    var button = target.closest("[data-ref]");
    if (!button) return;
    var action = button.getAttribute("data-ref");
    if (action === "blue+1") refereeAction("score", { side: "blue", delta: 1 });
    else if (action === "red+1") refereeAction("score", { side: "red", delta: 1 });
    else if (action === "toggle") refereeAction("clock", { action: referee.running ? "pause" : "start" });
    else if (action === "finish") refereeAction("finish");
  }

  // Heartbeat-only telemetry deliberately does not trigger the shared SSE
  // stream, so the referee overview reads a lightweight snapshot periodically.
  var refereeDeviceTelemetryTimer = null;

  function startRefereeDeviceTelemetry() {
    if (!isRefereePage() || refereeDeviceTelemetryTimer) return;
    refereeDeviceTelemetryTimer = window.setInterval(function () {
      if (document.hidden) return;
      api("/api/devices").then(function (payload) {
        state.devices = deviceList(payload);
        paintDeviceInfo();
      }).catch(function () { /* 保留上一帧状态，等待下一次刷新 */ });
    }, 2000);
  }

  function saveDeviceAlias(deviceId, name) {
    var normalizedId = String(deviceId || "").trim();
    var normalizedName = String(name || "").trim();
    if (!normalizedId) return;
    var aliases = {};
    try { aliases = JSON.parse(window.localStorage.getItem("fish-controller-device-aliases-v1") || "{}"); } catch (e) { aliases = {}; }
    if (normalizedName && normalizedName.toUpperCase() !== normalizedId.toUpperCase()) aliases[normalizedId] = normalizedName;
    else delete aliases[normalizedId];
    window.localStorage.setItem("fish-controller-device-aliases-v1", JSON.stringify(aliases));
  }

  function ensureDeviceManagerModal() {
    var modal = document.getElementById("deviceManagerModal");
    if (modal) return modal;
    var style = document.createElement("style");
    style.id = "deviceManagerStyles";
    style.textContent = "#deviceManagerModal{position:fixed;inset:0;z-index:10000;display:none;place-items:center;padding:18px;background:rgba(2,10,18,.78)}#deviceManagerModal.show{display:grid}#deviceManagerModal .deviceManagerCard{width:min(900px,96vw);max-height:min(680px,90vh);overflow:auto;background:#071a2d;color:#e5f7ff;border:1px solid rgba(91,205,246,.35);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.45)}#deviceManagerModal .deviceManagerHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(132,194,218,.18)}#deviceManagerModal h2{margin:0;font-size:16px}#deviceManagerModal .deviceManagerSub{margin:4px 0 0;color:#8eb0c1;font-size:11px}#deviceManagerModal .deviceManagerClose{border:0;background:transparent;color:#b8d7e5;font-size:24px;cursor:pointer}#deviceManagerModal .deviceManagerBody{padding:12px 18px}#deviceManagerModal .deviceManagerSummary{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;color:#9bc0d0;font-size:11px}#deviceManagerModal .deviceManagerSummary b{color:#9effcf}#deviceManagerModal .deviceRow{display:grid;grid-template-columns:26px minmax(130px,1.2fr) minmax(130px,1fr) 78px minmax(125px,150px) minmax(210px,1.4fr);align-items:center;gap:10px;padding:10px 0;border-top:1px solid rgba(132,194,218,.12)}#deviceManagerModal .deviceRow:first-child{border-top:0}#deviceManagerModal .deviceIdentity{min-width:0}#deviceManagerModal .deviceIdentity strong,#deviceManagerModal .deviceIdentity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#deviceManagerModal .deviceIdentity strong{font-size:12px}#deviceManagerModal .deviceIdentity small{margin-top:3px;color:#8eafbf;font-size:10px}#deviceManagerModal .deviceMac{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#9ac1d1;word-break:break-all}#deviceManagerModal .deviceBattery{font-size:11px;color:#d4ebf2;white-space:nowrap}#deviceManagerModal select,#deviceManagerModal input{width:100%;min-width:0;box-sizing:border-box;border:1px solid rgba(117,195,226,.28);border-radius:6px;padding:7px 8px;background:#0a243b;color:#e5f7ff;font-size:11px}#deviceManagerModal .deviceNameEdit{display:flex;min-width:0;gap:6px}#deviceManagerModal .deviceNameEdit button{flex:0 0 auto;white-space:nowrap;border:1px solid rgba(117,195,226,.35);border-radius:6px;background:#0b3550;color:#c9efff;padding:6px 9px;cursor:pointer}#deviceManagerModal .deviceManagerFoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid rgba(132,194,218,.18)}#deviceManagerModal .deviceManagerFoot button{border:1px solid rgba(117,195,226,.35);border-radius:7px;padding:8px 13px;background:#0b3550;color:#d7f5ff;cursor:pointer}#deviceManagerModal .deviceManagerFoot .primary{background:#1389bf;border-color:#54d9ff;color:#fff}@media(max-width:840px){#deviceManagerModal .deviceRow{grid-template-columns:26px minmax(130px,1fr) minmax(125px,1fr) 78px minmax(125px,150px);gap:8px}#deviceManagerModal .deviceNameEdit{grid-column:2 / -1}}@media(max-width:650px){#deviceManagerModal .deviceRow{grid-template-columns:26px 1fr 110px;gap:7px}#deviceManagerModal .deviceMac,#deviceManagerModal .deviceBattery{grid-column:2}#deviceManagerModal .deviceNameEdit{grid-column:2 / -1}#deviceManagerModal .deviceRow select{grid-column:3}}";
    document.head.appendChild(style);
    modal = document.createElement("div");
    modal.id = "deviceManagerModal";
    modal.innerHTML = '<section class="deviceManagerCard" role="dialog" aria-modal="true" aria-labelledby="deviceManagerTitle"><header class="deviceManagerHead"><div><h2 id="deviceManagerTitle">设备管理</h2><p class="deviceManagerSub">在线机器鱼按 MAC 排列；MAC 是设备唯一标识，昵称只用于显示。</p></div><button class="deviceManagerClose" type="button" data-device-manager-close aria-label="关闭">×</button></header><div class="deviceManagerBody"><div class="deviceManagerSummary" data-device-manager-summary>正在读取在线设备…</div><div data-device-manager-list></div></div><footer class="deviceManagerFoot"><button type="button" data-device-manager-close>取消</button><button type="button" class="primary" data-device-manager-save>保存分配</button></footer></section>';
    document.body.appendChild(modal);
    modal.addEventListener("click", function (event) {
      if (event.target === modal || event.target.closest("[data-device-manager-close]")) modal.classList.remove("show");
      if (event.target.closest("[data-device-manager-save]")) saveDeviceManager(modal);
      var rename = event.target.closest("[data-device-rename]");
      if (rename) {
        var row = rename.closest(".deviceRow");
        var input = row && row.querySelector("[data-device-name]");
        var id = row && row.getAttribute("data-device-id");
        if (input && id) { saveDeviceAlias(id, input.value); input.value = deviceLabel({ deviceId: id, name: input.value }); setBadge("设备昵称已保存（" + id + "）", "ok"); }
      }
    });
    return modal;
  }

  function renderDeviceManager(modal, devices) {
    var online = (devices || []).filter(function (device) { return !!device.online; }).sort(function (left, right) {
      return String(left.deviceId || left.id || "").localeCompare(String(right.deviceId || right.id || ""), undefined, { numeric: true, sensitivity: "base" });
    });
    var summary = modal.querySelector("[data-device-manager-summary]");
    var list = modal.querySelector("[data-device-manager-list]");
    var assignedCount = online.filter(function (device) { return !!device.assignedTo; }).length;
    if (summary) summary.innerHTML = "在线 <b>" + online.length + "</b>　未分配 <b>" + (online.length - assignedCount) + "</b>";
    if (!list) return;
    if (!online.length) { list.innerHTML = '<p style="padding:22px 0;color:#8eafbf;font-size:12px">当前没有在线机器鱼。</p>'; return; }
    var slots = [{ value: "", label: "未指定操控者" }, { value: "B1", label: "B1 · 蓝队" }, { value: "B2", label: "B2 · 蓝队" }, { value: "R1", label: "R1 · 红队" }, { value: "R2", label: "R2 · 红队" }];
    list.innerHTML = online.map(function (device) {
      var id = String(device.deviceId || device.id || "");
      var assigned = String(device.assignedTo || "").split("/").pop().toUpperCase();
      var options = slots.map(function (slot) { return '<option value="' + escapeHtml(slot.value) + '"' + (slot.value === assigned ? " selected" : "") + ">" + escapeHtml(slot.label) + "</option>"; }).join("");
      return '<div class="deviceRow" data-device-id="' + escapeHtml(id) + '" data-original-slot="' + escapeHtml(assigned) + '"><input type="checkbox" data-device-check ' + (assigned ? "checked" : "") + ' aria-label="选择 ' + escapeHtml(id) + '"><div class="deviceIdentity"><strong>' + escapeHtml(deviceLabel(device)) + '</strong><small>' + (assigned ? "当前操控者：" + escapeHtml(assigned) : "未分配操控者") + '</small></div><div class="deviceMac">' + escapeHtml(id) + '</div><div class="deviceBattery">电量 ' + escapeHtml(deviceBatteryLabel(device)) + '</div><select data-device-slot aria-label="指定操控者">' + options + '</select><div class="deviceNameEdit"><input data-device-name maxlength="24" value="' + escapeHtml(deviceLabel(device)) + '" aria-label="设备昵称"><button type="button" data-device-rename>保存昵称</button></div></div>';
    }).join("");
  }

  function openDeviceManager() {
    var modal = ensureDeviceManagerModal();
    modal.classList.add("show");
    var list = modal.querySelector("[data-device-manager-list]");
    if (list) list.innerHTML = '<p style="padding:22px 0;color:#8eafbf;font-size:12px">正在读取在线设备…</p>';
    loadCompetitionDevices().then(function (devices) { renderDeviceManager(modal, devices); }).catch(function (error) { if (list) list.innerHTML = '<p style="padding:22px 0;color:#ffb477;font-size:12px">读取失败：' + escapeHtml(error.message) + '</p>'; });
  }

  function saveDeviceManager(modal) {
    var rows = Array.prototype.slice.call(modal.querySelectorAll(".deviceRow"));
    var desiredSlots = {};
    rows.forEach(function (row) {
      var checked = row.querySelector("[data-device-check]") && row.querySelector("[data-device-check]").checked;
      var slot = row.querySelector("[data-device-slot]") ? row.querySelector("[data-device-slot]").value : "";
      if (checked && slot) desiredSlots[slot] = true;
    });
    var requests = [];
    rows.forEach(function (row) {
        var deviceId = liveDeviceId(row.getAttribute("data-device-id"));
      var checked = row.querySelector("[data-device-check]") && row.querySelector("[data-device-check]").checked;
      var slot = row.querySelector("[data-device-slot]") ? row.querySelector("[data-device-slot]").value : "";
      var original = row.getAttribute("data-original-slot") || "";
      if (checked && slot) {
        requests.push({ kind: "assign", side: /^R/i.test(slot) ? "red" : "blue", slot: slot, deviceId: deviceId });
      } else if (original && !desiredSlots[original]) {
        requests.push({ kind: "unassign", side: /^R/i.test(original) ? "red" : "blue", slot: original });
      }
    });
    var button = modal.querySelector("[data-device-manager-save]");
    if (button) button.disabled = true;
    requests.reduce(function (chain, request) {
      return chain.then(function () { return api("/api/competition/match/" + request.kind, { method: "POST", body: request.kind === "assign" ? { side: request.side, slot: request.slot, deviceId: request.deviceId } : { side: request.side, slot: request.slot } }); });
    }, Promise.resolve()).then(function () { modal.classList.remove("show"); setBadge("设备分配已保存", "ok"); return refreshReferee(); }).catch(function (error) { setBadge("设备分配失败：" + error.message, "error"); }).finally(function () { if (button) button.disabled = false; });
  }

  // ---------------------------------------------------------------- SSE
  function subscribe() {
    if (typeof window.EventSource !== "function") return;
    var source = new window.EventSource("/api/events");
    source.addEventListener("devices", function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { return; }
      state.devices = deviceList(payload);
      paintDeviceInfo();
      paintAccountInfo();
      paintCurrentTeamIdentity();
      // 设备掉线立即停止对应玩家
      PLAYERS.forEach(function (player) {
        var deviceId = state.bound[player];
        if (!deviceId) return;
        var online = state.devices.some(function (device) { return sameDeviceId(device, deviceId) && device.online; });
        if (!online) {
          heldInputs[player] = {};
          endMotion(player);
          delete state.bound[player];
          setBadge(slotForPlayer(player) + " 设备已离线，手动控制已停止", "warn");
        }
      });
      if (state.match && state.match.fieldLocked === true && PLAYERS.some(function (player) { return !state.bound[player]; })) {
        schedulePlayerLeaseRefresh(300);
      }
    });
    source.addEventListener("error", function () { /* 浏览器会自动重连 */ });
  }

  // ---------------------------------------------------------------- 事件接入

  function install() {
    ensureBadge();

    document.addEventListener("change", function (event) {
      var target = event.target;
      if (!target || !target.matches) return;
      if (target.matches("[data-player-seat]")) {
        selectPlayerSeat(target.getAttribute("data-player-seat"), target.value);
        return;
      }
      if (target.matches("[data-player-vision]")) {
        selectPlayerVisionTrack(target.getAttribute("data-player-vision"), target.value);
        return;
      }
      if (target.matches("#fieldWidthCm, #fieldHeightCm")) {
        fieldDimensionsDirty = true;
        renderFieldRuler();
        var fieldStatus = document.getElementById("fieldDimensionStatus");
        if (fieldStatus) fieldStatus.textContent = "尺寸已修改 · 点击保存";
      }
    }, true);

    document.addEventListener("input", function (event) {
      var target = event.target;
      if (!target || !target.matches || !target.matches("#fieldWidthCm, #fieldHeightCm")) return;
      fieldDimensionsDirty = true;
      renderFieldRuler();
      var fieldStatus = document.getElementById("fieldDimensionStatus");
      if (fieldStatus) fieldStatus.textContent = "尺寸已修改 · 点击保存";
    }, true);

    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      if (target.closest("#teamLoginNext")) { doLogin(event); return; }

      if (target.closest("[data-team-logout]")) { openTeamSwitcher(event); return; }

      if (target.closest("#teamEnterTerminal")) {
        if (!state.authenticated) {
          event.stopImmediatePropagation();
          event.preventDefault();
          setBadge("尚未通过真实账号认证", "warn");
          showLoginError("请先使用真实战队账号登录");
          return;
        }
        // 放行界面切换，同时把真实设备绑定到两名队员
        setBadge("正在绑定设备…", "info");
        refreshDevices();
        return;
      }

    }, true);

    document.addEventListener("keydown", function (event) {
      var target = event.target;
      if (!target || target.id !== "matchNameInput") return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        saveMatchName();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMatchNameEditor(false);
      }
    }, true);

    document.addEventListener("pointerdown", function (event) {
      if (event.button != null && event.button !== 0) return;
      var target = event.target;
      var control = target && target.closest && target.closest("[data-control-player][data-control-action]");
      if (!control) return;
      event.preventDefault();
      var player = control.getAttribute("data-control-player");
      var action = control.getAttribute("data-control-action");
      var token = "pointer:" + event.pointerId;
      activePointers[event.pointerId] = { player: player, token: token, control: control };
      if (control.setPointerCapture) {
        try { control.setPointerCapture(event.pointerId); } catch (_) {}
      }
      pressInput(player, action, token);
      control.classList.add("pressed");
    }, true);

    function finishPointer(event) {
      var active = activePointers[event.pointerId];
      if (!active) return;
      delete activePointers[event.pointerId];
      active.control.classList.remove("pressed");
      releaseInput(active.player, active.token);
    }
    document.addEventListener("pointerup", finishPointer, true);
    document.addEventListener("pointercancel", finishPointer, true);

    document.addEventListener("fish-control-key", function (event) {
      var detail = event && event.detail;
      if (
        !detail ||
        PLAYERS.indexOf(detail.player) < 0 ||
        !MOTION_ACTIONS[detail.action]
      ) return;

      if (detail.phase === "start") {
        var keyToken = "key:" + detail.key;
        pressInput(detail.player, detail.action, keyToken);
      } else if (detail.phase === "end") {
        releaseInput(detail.player, "key:" + detail.key);
      }
    }, true);

    document.addEventListener("fish-control-tuning", function (event) {
      var detail = event && event.detail;
      if (!detail || PLAYERS.indexOf(detail.player) < 0) return;
      var frequency = Number(detail.frequency);
      var amplitudePercent = Number(detail.amplitudePercent);
      if (!Number.isFinite(frequency) || !Number.isFinite(amplitudePercent)) return;
      motionTuning[detail.player] = {
        frequency: Math.max(0.3, Math.min(5, frequency)),
        amplitudePercent: Math.max(0, Math.min(100, amplitudePercent)),
      };
    }, true);

    window.addEventListener("blur", function () {
      activePointers = {};
      stopAll("窗口失去焦点，已停止续发运动指令");
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        schedulePlayerLeaseRefresh(50);
        video.connectedAt = Date.now();
      }
    });

    window.addEventListener("pagehide", function () {
      if (controlSocket) {
        try { controlSocket.close(); } catch (_) {}
        controlSocket = null;
      }
      if (refereeDeviceTelemetryTimer) {
        window.clearInterval(refereeDeviceTelemetryTimer);
        refereeDeviceTelemetryTimer = null;
      }
      closeVideoPeer();
      if (video.events) {
        video.events.close();
        video.events = null;
      }
      if (playerMatchTimer) {
        window.clearInterval(playerMatchTimer);
        playerMatchTimer = null;
      }
      if (playerLeaseTimer) {
        window.clearInterval(playerLeaseTimer);
        playerLeaseTimer = null;
      }
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
        paintAccountInfo();
        startPlayerMatchTelemetry();
        startPlayerLeaseMaintenance();
        refreshDevices();
        startRefereeDeviceTelemetry();
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
