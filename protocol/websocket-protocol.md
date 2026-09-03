# 机器鱼 WebSocket 协议（版本 1）

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

控制器至少每秒发送 `{"type":"heartbeat"}`。设备至少每秒发送：

```json
{"type":"heartbeat","mode":2,"frequency":2.5,"amplitude":28.0,"bias":0.0,"rssi":-52}
```

模式编号：`0=停止`、`1=待机摆尾`、`2=前进`、`3=左转`、`4=右转`。设备连续 2 秒没有收到有效控制器心跳时必须归中停止。

## 运动命令

```json
{"type":"command","requestId":"请求唯一编号","deviceId":"A4:CF:12:34:56:78","command":"motion.set","payload":{"deviceId":"A4:CF:12:34:56:78","controlSource":"用户或 vision-bot","mode":"forward","frequency":2.5,"amplitude":28.0,"bias":0.0}}
```

`mode` 可取 `forward`、`left`、`right`、`stop`、`idle`。频率范围 `0.3–5.0`，幅度范围 `0–50`。

设备直接应用运动参数并返回：

```json
{"type":"command.result","requestId":"请求唯一编号","success":true,"message":"OK"}
```

请求 ID 必须原样返回。运动参数由控制器负责整理，设备不再因为频率、幅度、偏置或舵机角度超出预设范围而拒绝命令。连接断开时设备立即停止；重连后必须重新注册。

## 视觉控制

视觉识别、路径计算和 PID 全部在服务器端完成。服务器把最终的 `frequency`、`amplitude` 和 `bias` 作为普通 `motion.set` 下发，开发板不接收视频、视觉误差或 PID 参数。

视频本身不通过设备 WebSocket 传输。Python 优先生成 WebRTC 视频，无法完成公网 ICE 连接时回退到 MJPEG；浏览器只能通过 Go 的视觉接口访问。画布坐标和工具事件通过独立 HTTP 接口发送，不能从视频帧推断控制状态。
