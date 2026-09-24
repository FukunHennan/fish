# Fish Control Protocol v2

这是当前唯一有效的 ESP32 与 Go 控制器协议说明。控制器只接受
`protocolVersion: 2` 的设备注册、发现和状态消息；v1 设备不再兼容。

## 传输

- 设备到控制器：TCP 上的 WebSocket `/ws/device`
- 浏览器到控制器：TCP 上的 WebSocket `/ws/control`
- 局域网发现：UDP `30303`，消息仍使用 JSON，但协议版本为 2
- 控制器正式 HTTP/API 端口：TCP `8081`

## 注册

控制器先发送 `auth.challenge`，设备必须回复 `register`，两者的
`protocolVersion` 都是 `2`。设备唯一身份是 MAC `deviceId`；昵称只用于显示。
注册成功前控制器不会下发运动命令。

## 设备能力

当前硬件只声明：`motion`、`battery`、`ota`。

当前硬件有一个 GPIO8 单色板载状态灯，但它只由固件状态机控制，不属于远程设备
能力。硬件没有 RGB 灯、光感传感器或 I2C 传感器，因此不发送对应能力字段，
也不接受相关控制命令。

## 配网与服务器恢复

- 没有 NVS Wi-Fi 时，先尝试固件内置默认 Wi-Fi；失败后进入 AP 配网。
- 已有 NVS Wi-Fi 时，只尝试已保存 Wi-Fi；连接 Wi-Fi 后连续 3 分钟无法完成
  控制器注册，就进入 AP 配网。
- AP 启动后保持，不自动退出重试，直到用户提交新的 Wi-Fi 配置。

## 版本

当前固件标准版本：`2.0.0`。
旧版 `docs/packet-redesign.md` 已删除，不再作为协议依据。
