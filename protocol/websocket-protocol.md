# 机器鱼 WebSocket 协议（版本 1）

更新时间：2026-09-04

## 阅读范围

这是 **Go 控制器与 ESP32 设备之间** 的协议，不是浏览器直接连接设备的协议。
浏览器请求先到 Go，Go 完成登录、控制权、目标绑定和参数整理后，才通过本协议向设备发送消息。

设备连接局域网中央控制器的 `/ws/device`，所有消息均为 UTF-8 JSON。

## 注册

连接建立后，控制器首先发送一次性挑战：

```json
{"type":"auth.challenge","protocolVersion":1,"nonce":"32位十六进制随机数"}
```

设备使用部署密钥计算动态证明：

```text
proof = HMAC-SHA256(
  deploymentKey,
  "fish-websocket-v1" + "\n" + nonce + "\n" + 标准化MAC
)
```

然后注册：

```json
{"type":"register","protocolVersion":1,"deviceId":"A4:CF:12:34:56:78","proof":"64位十六进制HMAC","name":"机器鱼1号","firmwareVersion":"1.3.0","ip":"192.168.1.31","capabilities":["motion","ota"]}
```

控制器返回 `{"type":"register.result","success":true}`。nonce 只用于当前连接，不能重放；注册失败或版本不支持时关闭连接，设备在注册成功前不得执行命令。部署密钥不得出现在浏览器、日志或 WebSocket 消息中。

## 心跳和状态

控制器约每秒发送 `{"type":"heartbeat"}`。设备约每秒发送：

```json
{"type":"heartbeat","mode":2,"frequency":2.5,"amplitude":28.0,"bias":0.0,"rssi":-52}
```

模式编号：`0=停止`、`1=待机摆尾`、`2=前进`、`3=左转`、`4=右转`。设备连续 3 秒没有收到有效控制器心跳时必须归中停止并断开连接。

## 运动命令

```json
{"type":"command","requestId":"请求唯一编号","deviceId":"A4:CF:12:34:56:78","command":"motion.set","payload":{"deviceId":"A4:CF:12:34:56:78","controlSource":"用户或 vision-bot","mode":"forward","frequency":2.5,"amplitude":28.0,"bias":0.0}}
```

`mode` 可取 `forward`、`left`、`right`、`stop`、`idle`。控制器将按照每台设备的标定范围整理参数；线协议频率范围为 `0.3–5.0`，幅度范围为 `0–90`。

`bias` 是相对于固件已保存中位的角度偏移。控制器对运动命令联合限制偏移和振幅，保证 `中位 + bias ± amplitude` 位于设备标定范围；旧标定未提供上下限时使用 `0°–180°`。这要求控制器标定中位与固件中位一致。视觉向前标定的预设运动也经过同一检查。固件仍直接执行最终参数，本项尚未完成实机验证。

设备直接应用运动参数并返回：

```json
{"type":"command.result","requestId":"请求唯一编号","success":true,"message":"OK"}
```

请求 ID 必须原样返回。运动参数由控制器负责整理，设备不再因为频率、幅度、偏置或舵机角度超出预设范围而拒绝命令。连接断开时设备立即停止；重连后必须重新注册。

## 视觉控制

视觉识别、路径计算和 PID 全部在服务器端完成。服务器把最终的 `frequency`、`amplitude` 和 `bias` 作为普通 `motion.set` 下发，开发板不接收视频、视觉误差或 PID 参数。

视频本身不通过设备 WebSocket 传输。Python 优先生成 WebRTC 视频，无法完成公网 ICE 连接时回退到 MJPEG；浏览器只能通过 Go 的视觉接口访问。画布坐标和工具事件通过独立 HTTP 接口发送，不能从视频帧推断控制状态。

视觉控制必须同时满足：

1. 视觉会话有效。
2. 识别目标已经选择。
3. 识别目标已经绑定物理 `deviceId`。
4. 当前视觉会话持有该设备控制权。
5. 目标仍然出现在当前画面中。

任一条件失效，Go 或 Python 必须触发停止。

Go 的内部视觉 HTTP 控制要求先发送 `operation=start`，随后 `motion` / `calibrate-forward` / `stop` 使用同一 `sessionId`。到期或其他控制取代视觉后，旧会话请求被拒绝，须重新启动。设备线协议仍使用普通 `motion.set`，无需为此次控制器修复重新烧录固件。

## 控制器出站顺序

同一设备的所有出站消息必须经过同一个控制器发送队列。普通手动命令、键盘实时命令、视觉命令、租约释放停止和紧急停止不能分别直接写入 WebSocket。

实时命令可以在尚未写入设备前合并，只保留最新一条；已经开始写入的命令不能被取消。停止命令必须排在此前已接受的命令之后，不能让旧的转弯命令在停止之后再次发送。

浏览器实时 HTTP 命令的 `clientId` 标识当前页面，`sequence` 为该页面的递增计数。接管后新持有者可从较小序号开始，前持有者的运动请求被拒绝。停止不因序号较小而被拒绝；非当前持有者的停止也不会改变当前持有者的序号门槛。租约释放、过期和接管时，尚未写出的旧运动命令会被取消。

设备状态只允许由设备的 `heartbeat`、`state` 和 `command.result` 上报更新。控制器收到 HTTP 请求或把实时命令放入队列，不代表设备已经执行。

## ACK 语义

普通命令和视觉命令的 HTTP 响应使用以下字段：

```json
{
  "requestId": "唯一编号",
  "sent": true,
  "acknowledged": true,
  "success": true,
  "applied": {
    "mode": 2,
    "frequency": 2.5,
    "amplitude": 28.0,
    "bias": 0.0
  }
}
```

- `sent`：控制器已将消息写入设备 WebSocket。
- `acknowledged`：设备已返回同一 `requestId` 的 `command.result`。
- `success`：设备已经成功执行。
- `applied`：设备返回的实际运动状态，GUI 应优先使用设备后续 heartbeat 再次确认。

键盘实时接口只保证：

```json
{"sent":true,"queued":true,"acknowledged":false}
```

它用于低延迟意图发送，不代表设备已经执行完成。GUI 不应把 `queued` 当成设备实际状态。

## 设备离线

设备注册后必须至少每秒发送一次 `heartbeat`。控制器连续 3 秒没有收到设备消息时关闭连接、移除设备并通知 GUI。设备连续 3 秒没有收到控制器 heartbeat 时归中停止并重新连接。

## 浏览器到设备的简化路径

```text
浏览器 GUI
  → Go HTTP/WebSocket API
  → 控制权、权限和设备在线检查
  → 单设备发送队列
  → ESP32 /ws/device
  → command.result + heartbeat
  → Go 状态汇总
  → GUI
```

Go 的 HTTP 返回 `sent` 或 `queued` 只说明控制器接收或排队情况。GUI 不能把它当作设备已经完成执行，必须等待设备回报。

## 其他设备命令

设备 WebSocket 还支持：

```json
{"type":"command","requestId":"...","command":"emergency.stop","payload":{"operator":"..."}}
```

```json
{
  "type":"command",
  "requestId":"...",
  "command":"rgb.set",
  "payload":{
    "mode":"AUTO或SOLID",
    "order":"GRB",
    "red":0,
    "green":255,
    "blue":80,
    "brightness":32
  }
}
```

```json
{
  "type":"command",
  "requestId":"...",
  "command":"ota.start",
  "payload":{
    "sha256":"64位十六进制SHA-256",
    "size":123456,
    "name":"机器鱼1号"
  }
}
```

OTA 只能由管理员通过 Go 控制器发起，设备执行前必须停止运动。固件下载、校验和安装失败都必须返回 `success:false` 以及稳定的 `code`。
