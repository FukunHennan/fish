# 机器鱼 WebSocket 数据包协议 v2

> 状态：控制端兼容层和固件实现已完成；固件版本 `1.4.0`。
> 当前仍需在真实机器鱼上烧写并完成在线、控制、OTA 与断线恢复验证。

## 1. 重构目标

旧固件每秒发送一个约 25 个字段的完整状态包。电池、光感、IP、固件版本、
RGB 状态和运动状态即使没有变化也会重复序列化与传输。

v2 将数据按职责和变化周期拆开：

| 数据域 | 发送策略 | 是否周期发送 |
|---|---|---|
| 注册身份 | 建立连接时一次，身份变化时补发 | 否 |
| 活性心跳 | 固定 1Hz | 是 |
| 运动状态 | 变化立即发送，30 秒完整兜底 | 低频兜底 |
| RGB 状态 | 变化立即发送，30 秒完整兜底 | 低频兜底 |
| 电池 | 每次真实 ADC 采样完成后发送 | 10 秒 |
| 光感 | 每次真实传感器采样完成后发送 | 5 秒 |
| Wi-Fi 链路 | 2dBm 量化，变化或 30 秒兜底 | 最快 5 秒 |
| OTA | 进度整数变化时发送 | OTA 期间 |
| 命令回执 | 每条命令一次 | 否 |

## 2. 协议原则

1. WebSocket 是可靠、有序的 TCP 流，因此 v2 不增加用于“计算网络丢包率”的
   `seq`。网络 RTT 继续使用 WebSocket ping/pong 测量。
2. 连接已经和认证后的 `deviceId` 一一绑定。完成注册后，上行包不再重复
   `deviceId`、IP、固件版本和能力列表。
3. 设备 `millis()` 只用于相对时间。绝对时间由服务器收到各类数据时分别打戳。
4. 电池与光感不合并复读。哪个传感器完成了新采样，就只发送哪个数据域。
5. `command.result` 只表示接受或拒绝，不再复制完整状态。
6. 运动状态使用字符串 `mode`；控制端在兼容期同时接受 v1 整数和 v2 字符串。
7. v1/v2 固件可以同时连接同一个控制器。

## 3. 包格式

### 3.1 注册 `register`

注册包是唯一必须携带设备 ID 和认证证明的包。

```json
{
  "type": "register",
  "protocolVersion": 2,
  "deviceId": "AC:27:6E:7C:37:18",
  "proof": "...",
  "bootId": "8f2a31c0",
  "name": "机器鱼 1 号",
  "firmwareVersion": "1.4.0",
  "ip": "192.168.137.117",
  "servoCenter": 87.5,
  "capabilities": ["motion", "ota", "battery", "status-rgb", "ambient-light"],
  "i2cAddresses": [35, 74]
}
```

`bootId` 每次设备启动随机生成，用于区分设备重启和普通 WebSocket 重连。
身份字段变化时可发送不含认证字段的 `identity` 包：

```json
{
  "type": "identity",
  "ip": "192.168.137.117",
  "firmwareVersion": "1.4.0",
  "servoCenter": 87.5,
  "i2cAddresses": [35, 74]
}
```

### 3.2 心跳 `heartbeat`

```json
{
  "type": "heartbeat",
  "uptimeMs": 86234000,
  "lastControlMs": 86233120
}
```

固定 1Hz。它只证明设备主循环、WebSocket 和控制处理仍然活跃。

### 3.3 运动状态 `motion.state`

```json
{
  "type": "motion.state",
  "mode": "forward",
  "frequency": 2.5,
  "amplitude": 28.0,
  "bias": 0.0,
  "controlSource": "manual",
  "stopReason": ""
}
```

合法 `mode`：`stopped`、`idle`、`forward`、`left`、`right`。

合法 `controlSource`：

| 值 | 含义 |
|---|---|
| 空字符串 | 无活动控制源或设备已停止 |
| `manual` | 键盘或网页人工控制 |
| `vision-bot` | 视觉闭环控制 |
| `vision-timeout` | 视觉指令超时后的安全停止 |
| `lease` | 控制租约结束后的安全停止 |

本字段表示最后一次指令来源，不用于判断控制源是否仍存活。

### 3.4 RGB 状态 `rgb.state`

```json
{
  "type": "rgb.state",
  "rgbMode": "AUTO",
  "rgbOrder": "GRB",
  "rgbRed": 0,
  "rgbGreen": 255,
  "rgbBlue": 0,
  "rgbBrightness": 32
}
```

### 3.5 电池遥测 `telemetry.battery`

```json
{
  "type": "telemetry.battery",
  "batteryVoltage": 7.62,
  "batteryPercent": 71
}
```

只在 ADC 完成一轮新采样后发送。`batterySampleAgeMs` 已删除；服务器保存
`batteryAtMs`，表示收到这次真实新采样的绝对时间。

### 3.6 光感遥测 `telemetry.light`

```json
{
  "type": "telemetry.light",
  "lightSensorOnline": true,
  "illuminanceLux": 340.5
}
```

传感器离线时不发送无意义的旧 lux：

```json
{"type":"telemetry.light","lightSensorOnline":false}
```

### 3.7 链路遥测 `telemetry.link`

```json
{"type":"telemetry.link","rssi":-58}
```

RSSI 先按 2dBm 量化；最快每 5 秒检查一次。数值未变化时只做 30 秒兜底。
延迟不从本包推算，仍以服务器 WebSocket ping/pong RTT 为准。

### 3.8 OTA 进度 `ota.progress`

```json
{
  "type": "ota.progress",
  "otaState": "DOWNLOADING",
  "otaProgress": 37,
  "written": 778240,
  "total": 2103296
}
```

失败时增加：

```json
{
  "type": "ota.progress",
  "otaState": "FAILED",
  "otaProgress": 37,
  "code": "OTA_DOWNLOAD_TIMEOUT",
  "message": "固件下载超时，请检查网络后重试"
}
```

OTA 下载已经改为非阻塞分步读取。每轮主循环最多处理 2048 字节，随后立即返回
执行 WebSocket `loop()`，避免原固件在升级期间停止 pong 并被服务器判定离线。
OTA 期间只接受 `emergency.stop` 和 `ota.cancel`，其他运动或灯光命令返回
`OTA_BUSY`。

### 3.9 命令回执 `command.result`

```json
{
  "type": "command.result",
  "requestId": "realtime-1234567890",
  "success": true,
  "code": "OK",
  "message": "accepted"
}
```

固件不再发送 `deviceId`、`controlSource` 和 `applied`。控制器 HTTP API 会用已完成
参数校验的下行 payload 补出 `applied`，因此现有网页 API 契约保持不变。

键盘实时控制走“最新状态覆盖”队列，HTTP 接口本身不等待设备 ACK。此类下行包带
`"ackRequired": false`，固件不会再为每一个高频键盘帧返回无调用方消费的回执；
运动状态确实变化时仍会发送 `motion.state`。普通配置、视觉和 OTA 命令继续要求回执。

## 4. 服务器状态模型

服务器收到包时分别维护：

- `heartbeatAtMs`
- `motionStateAtMs`
- `rgbStateAtMs`
- `batteryAtMs`
- `lightAtMs`
- `linkAtMs`
- `identityAtMs`
- `otaAtMs`

这些时间均来自服务器时钟。不同数据域不会再因为其他包到达而被错误刷新。

## 5. v1 兼容策略

| 项目 | v1 | v2 | 控制器行为 |
|---|---|---|---|
| 注册版本 | 1 | 2 | 同时接受 |
| 状态包 | `state`/全量 `heartbeat` | 分类型 | 同时合并 |
| `mode` | 整数 | 字符串 | 双读并归一化为内部整数 |
| 电池年龄 | 设备提供 | 已删除 | v1 字段忽略，使用服务器时间 |
| 回执 `applied` | 设备提供 | 设备不提供 | HTTP 层统一保证存在 |

不要在所有在役设备升级完成前删除 v1 解析。

## 6. 包体与稳态开销

代表性紧凑 JSON 实测：

| 包 | 旧版 | v2 |
|---|---:|---:|
| 每秒心跳 | 约 507 B | 65 B |
| 运动状态 | 包含在每秒全量包中 | 约 121 B，仅变化或 30 秒兜底 |
| 电池 | 每秒复读 | 约 70 B/10 秒 |
| 光感 | 每秒复读 | 约 74 B/5 秒 |
| 链路 | 每秒复读 | 约 36 B/5 秒或变化时 |

不计 WebSocket 帧头，典型稳态上行从约 `507 B/s` 降至约 `100 B/s`，减少约
80%。更重要的是每个字段的新鲜度和含义变得明确。

## 7. 上线顺序

1. 先发布支持 v1/v2 的控制器。
2. 用 USB 烧写首批 `1.4.0` 固件，验证 OTA 非阻塞升级能力。
3. 验证通过后再通过 OTA 升级其他机器鱼。
4. 观察至少一个完整比赛周期，确认没有 v1 设备后再考虑清理兼容代码。

## 8. 验证清单

- [x] Go 控制端 v1/v2 解析单元测试
- [x] v2 注册、身份字段和字符串 mode 测试
- [x] 纯回执仍保持 HTTP `applied` 契约
- [x] 前端单元测试与生产构建
- [x] ESP32-C3 固件完整编译
- [x] 固件原生单元测试
- [ ] 真机 v2 注册和分包抓包
- [ ] 按键控制与松键停止
- [ ] 断网后安全停止与自动重连
- [ ] 慢速 OTA 全程在线
- [ ] OTA 取消、哈希失败和下载超时

## 9. 主要实现位置

- `firmware/src/ControllerClient.cpp`
- `firmware/include/ControllerClient.h`
- `controller/internal/hub/hub.go`
- `controller/internal/web/server.go`
- `controller/frontend/src/deviceState.js`
