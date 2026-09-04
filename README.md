# 机器鱼中央控制项目

这是一个由电脑统一管理机器鱼、视觉识别和设备通信的项目。

## 系统结构

```text
电脑浏览器 GUI（8098）
        │
        ▼
Go 中央控制器（8081）
   ├── ESP32 机器鱼
   └── Python 视觉服务（127.0.0.1:8091）
```

浏览器不直接连接 ESP32，也不直接连接 Python。Go 是设备、视觉、权限和公网访问的统一入口。

## 快速开始

Linux / macOS：

```bash
bash scripts/start.sh
```

Windows：

```bat
scripts\start.bat
```

启动脚本负责构建并启动 Go 控制器。要使用当前指定的 `8098` GUI，再单独运行：

```bash
cd controller/frontend/gui-redesign-demo
npx --yes vite --host 127.0.0.1 --port 8098
```

打开电脑端 GUI：

```text
http://127.0.0.1:8098/
```

停止服务：

```bash
bash scripts/stop.sh
```

## 文档入口

- [技术文档索引](docs/README.md)
- [系统架构](docs/项目架构与开发方案.md)
- [部署与公网访问](docs/部署与公网访问.md)
- [通信协议](protocol/websocket-protocol.md)
- [Python 视觉服务](vision/README.md)
- [项目统一参数](docs/项目统一参数.md)
- [维护计划](docs/维护计划.md)
- [简易项目介绍页](docs/project-overview.html)

## 目录说明

```text
firmware/    ESP32 固件
controller/  Go 控制器和 React GUI
vision/      Python、YOLO、OpenCV 和视频服务
protocol/    ESP32 与 Go 的通信协议
config/      本机配置，不提交密钥和密码
scripts/     启动、停止和上传脚本
docs/        技术文档和展示文件
```

## 固件

默认目标为 Seeed XIAO ESP32-C3，串口速率为 `115200`。固件支持 Wi-Fi 配网、设备发现、HMAC 认证、WebSocket、心跳、运动控制、RGB 和 OTA。

编译：

```bash
cd firmware
pio run
```

USB 烧录需要连接设备后执行 PlatformIO Upload。仅修改电脑端 GUI、Go 或 Python 时，不需要重新烧录 ESP32。

## 配置提醒

- `config/deployment.json` 和 `config/frpc.toml` 只放本机，不要提交真实密钥。
- 公网访问需要先完成 FRP 配置、域名解析、HTTPS 和登录权限。
- OTA 只能由管理员发起。
- 设备断线、控制器心跳超时、视觉异常和 OTA 开始时都应停止运动。
