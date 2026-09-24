# 机器鱼中央控制项目

这是一个由电脑统一管理机器鱼、视觉识别、设备通信和学生赛事的项目。

项目架构、账号、启动部署、设备控制、视觉、赛事、协议、OTA、测试和维护说明已收口到一份文档：

- [机器鱼项目统一手册](docs/机器鱼项目统一手册.md)

公网入口：[https://fish.chenfukun.space](https://fish.chenfukun.space)

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
scripts\start.bat
```

启动脚本负责构建并启动 Go 控制器。控制器在当前窗口前台运行；关闭该窗口即可结束控制器及其附属服务，不再维护单独的停止脚本。

打开唯一正式电脑端界面：

```text
http://127.0.0.1:8081/competition.html
```

开发时可用 Vite 运行赛事端热更新，但正式前端只有这一套赛事界面，生产入口仍是 `8081`。

管理员可通过 `GET http://127.0.0.1:8081/api/logs?limit=100` 查看当前启动会话的结构化日志尾部；日志文件保存在 `controller/diagnostics/runs/`，公网环境必须使用管理员会话访问。

## 文档入口

- [机器鱼项目统一手册](docs/机器鱼项目统一手册.md)

## 目录说明

```text
firmware/    ESP32 固件
controller/  Go 控制器和赛事前端（React 源码仅作历史实验保留）
vision/      Python、YOLO、OpenCV 和视频服务
protocol/    ESP32 与 Go 的当前 v2 通信协议
config/      本机配置，不提交密钥和密码
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

- `config/deployment.json` 是本机设备部署配置，当前按项目约定纳入版本管理。
- 当前平台面向内部研发和受控环境，暂不以公网或商用部署为目标，也不把相关安全性作为当前开发重点。
- Windows 开发机通过 `scripts\start.bat` 构建并启动本地控制器；脚本会注册 `FishStack` 登录启动任务，统一守护控制器和 Cloudflare Tunnel。
- OTA 只能由管理员发起。
- 设备断线、控制器心跳超时、视觉异常和 OTA 开始时都应停止运动。
