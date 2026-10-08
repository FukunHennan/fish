# 机器鱼中央控制项目

这是一个由电脑统一管理机器鱼、视觉识别、设备通信和学生赛事的项目。

文档按程序、硬件、概述和开发日志分类：

- [文档导航](docs/README.md)

当前 Windows 配置的 Cloudflare 公网入口：[https://fish.chenfukun.space](https://fish.chenfukun.space)。在线状态需在运行机器和公网实际验证；首次配置参见[公网访问配置](docs/程序/公网访问配置.md)。

## 系统结构

```text
电脑浏览器 GUI（8081）
        │
        ▼
Go 中央控制器（8081）
   ├── ESP32 机器鱼
   └── Python 视觉服务（127.0.0.1:8091）
```

浏览器不直接连接 ESP32，也不直接连接 Python。Go 是设备、视觉、权限和网络访问的统一入口。

## 快速开始

Linux / macOS：

```bash
bash scripts/start.sh
```

Windows：

```bat
scripts\setup.bat --local --cpu
scripts\start.bat
```

新 Windows 电脑先安装带 npm 的 Node.js，并确保系统有 `winget` 和网络连接。`setup.bat` 会安装 Go、Python 3.12 和电脑端依赖并构建；示例中的 `--local --cpu` 会修改 `config/tunnel.json` 和 `config/program.json`，关闭公网隧道并使用 CPU，适合先验证本机运行。有隧道凭据和可用 GPU 后，可重新配置这两个文件。完整选项见[环境与构建](docs/程序/环境与构建.md)。启动脚本负责构建并启动 Go 控制器。控制器在当前窗口前台运行；关闭该窗口即可结束控制器及其附属服务。

打开唯一正式电脑端界面：

```text
http://127.0.0.1:8081/competition.html
```

开发时可单独运行 Vite 预览赛事端；正式前端只有这一套赛事界面，由 Go 的 `8081` 端口提供。

`GET http://127.0.0.1:8081/api/logs?limit=100` 返回当前启动会话的结构化日志尾部；日志文件保存在 `controller/diagnostics/runs/`。接口要求管理员身份，当前配置将 `FISH_AUTH_DISABLED` 设为 `true`，免登录访问会获得匿名管理员身份（包括公网）；已设置的进程环境变量会覆盖 JSON。公网链接只能分享给可信人员，必要时先关闭隧道。

## 文档入口

- [文档导航](docs/README.md)
- [程序：启动、停止和配置](docs/程序/README.md)
- [Cloudflare 公网访问配置](docs/程序/公网访问配置.md)
- [硬件：ESP32 与相机](docs/硬件/README.md)
- [概述：架构和目录规范](docs/概述/README.md)
- [开发日志](docs/开发日志/README.md)

## 目录说明

```text
firmware/    ESP32 固件
controller/  Go 控制器和赛事前端（React 源码仅作历史实验保留）
vision/      Python、YOLO、OpenCV 和视频服务
protocol/    ESP32 与 Go 的当前 v2 通信协议
config/      三个手动配置入口：firmware.json、program.json、tunnel.json
scripts/     唯一启动入口、上传和诊断脚本
docs/        技术文档和展示文件
```

## 固件

默认目标为 Seeed XIAO ESP32-C3，串口速率为 `115200`。当前固件标准版本为 `2.0.0`，只支持 v2 设备协议、Wi-Fi 配网、设备发现、HMAC 认证、WebSocket、心跳、运动控制、电池遥测和 OTA。GPIO8 单色板载 LED 用于状态提示；硬件没有 RGB、光感或 I2C 传感器。

编译：

```bash
cd firmware
pio run
```

USB 烧录需要连接设备后执行 PlatformIO Upload。仅修改电脑端 GUI、Go 或 Python 时，不需要重新烧录 ESP32。

## 配置提醒

- 日常配置统一修改 `config/firmware.json`、`config/program.json`、`config/tunnel.json`，字段和启动行为见[配置入口](config/README.md)。固件和控制器共用 `firmware.json` 中的 `deploymentKey`。
- 项目当前启用 Cloudflare Tunnel 并关闭内建登录：知道域名的人均可操作管理员功能。风险与配置步骤见[公网访问配置](docs/程序/公网访问配置.md)。
- Windows 开发机通过 `scripts\start.bat` 构建并启动本地控制器；脚本会注册 `FishStack` 登录启动任务，统一守护控制器和 Cloudflare Tunnel。
- OTA 只能由管理员发起。
- 设备断线、控制器心跳超时、视觉异常和 OTA 开始时都应停止运动。
