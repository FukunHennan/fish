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
{"type":"register","protocolVersion":1,"deviceId":"A4:CF:12:34:56:78","proof":"64位十六进制HMAC","name":"机器鱼1号","firmwareVersion":"1.1.0","ip":"192.168.1.31","capabilities":["motion","vision","ota"]}
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
{"type":"command","requestId":"请求唯一编号","command":"motion.set","payload":{"mode":"forward","frequency":2.5,"amplitude":28.0,"bias":0.0}}
```

`mode` 可取 `forward`、`left`、`right`、`stop`、`idle`。频率范围 `0.3–5.0`，幅度范围 `0–50`。

设备返回：

```json
{"type":"command.result","requestId":"请求唯一编号","success":true,"message":"OK"}
```

请求 ID 必须原样返回。无效参数返回失败，不能修改原有运动状态。连接断开时设备立即停止；重连后必须重新注册。

## 视觉会话

视觉控制使用 `vision.start`、`vision.update` 和 `vision.stop`。同一时刻只允许一个视觉会话；`vision.update` 带递增序号，设备拒绝旧会话或倒退序号。相机失帧、目标丢失、视觉进程退出、网页停止或视觉超时都必须触发安全停止。

视频本身不通过设备 WebSocket 传输。Python 生成 MJPEG，浏览器只能通过 Go 的 `/api/vision/stream.mjpg` 访问；画布坐标和工具事件通过独立 HTTP 接口发送，不能从视频帧推断控制状态。
