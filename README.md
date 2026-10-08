# 机器鱼中央控制项目

这是一个由电脑统一管理机器鱼、视觉识别、设备通信和学生赛事的项目。

项目架构、账号、启动部署、设备控制、视觉、赛事、协议、OTA、测试和维护说明已收口到一份文档：

- [机器鱼项目统一手册](docs/机器鱼项目统一手册.md)

文档记录的 Cloudflare 公网入口：[https://fish.chenfukun.space](https://fish.chenfukun.space)。仓库无法确认当前隧道和域名是否在线。

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

开发时可单独运行 Vite 预览赛事端；正式前端只有这一套赛事界面，由 Go 的 `8081` 端口提供。

`GET http://127.0.0.1:8081/api/logs?limit=100` 返回当前启动会话的结构化日志尾部；日志文件保存在 `controller/diagnostics/runs/`。接口要求管理员身份，但当前代码在 `FISH_AUTH_DISABLED` 未设置、为空或为 `true` 时会给请求分配匿名管理员身份。要启用内建登录校验，建议显式设为 `false`。

## 文档入口

- [文档导航](docs/README.md)
- [机器鱼项目统一手册](docs/机器鱼项目统一手册.md)
- [全局快门 USB 相机手册](docs/相机手册.md)

## 目录说明

```text
firmware/    ESP32 固件
controller/  Go 控制器和赛事前端（React 源码仅作历史实验保留）
vision/      Python、YOLO、OpenCV 和视频服务
protocol/    ESP32 与 Go 的当前 v2 通信协议
config/      本机部署配置与模板；deployment.json 含设备认证密钥
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

- `config/deployment.json` 是本机设备部署配置，包含 `deploymentKey`；固件构建脚本和 Go 控制器都会读取该值。仓库快照不能证明该文件当前是否纳入版本管理，分享或提交前应核对其内容与项目约定。
- 项目保留 Cloudflare Tunnel 公网入口及启动配置。当前代码默认关闭登录校验；如果隧道对外开放，请先核对认证配置和实际访问边界。
- Windows 开发机通过 `scripts\start.bat` 构建并启动本地控制器；脚本会注册 `FishStack` 登录启动任务，统一守护控制器和 Cloudflare Tunnel。
- OTA 只能由管理员发起。
- 设备断线、控制器心跳超时、视觉异常和 OTA 开始时都应停止运动。
