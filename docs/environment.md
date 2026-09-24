# Fish 项目环境与构建/烧录说明

本文档记录当前项目的实际软硬件环境、编译链、运行端口和 ESP32-C3 串口烧录流程。

## 1. 系统组成

| 组件 | 目录 | 作用 | 地址/端口 |
| --- | --- | --- | --- |
| Go 控制器 | `controller/` | 设备注册、控制、租约、OTA、SSE | `0.0.0.0:8081` |
| React 前端 | `controller/frontend/` | 唯一正式操作界面 | 由 `8081` 提供 |
| Python 视觉 | `vision/` | 摄像头、识别、WebRTC 信令 | `127.0.0.1:8091` |
| ESP32-C3 固件 | `firmware/` | Wi-Fi、设备 WebSocket、运动、电池、配网、OTA | 连接控制器 `8081` |
| 局域网发现 | 固件/控制器 | UDP 发现控制器 | `30303/UDP` |
| Cloudflare Tunnel | `controller/.runtime/` | 公网转发到 Go 控制器 | 由隧道配置决定 |

控制命令使用浏览器到控制器的 `/ws/control`，再由控制器通过 `/ws/device` 下发到 ESP32；设备状态通过 `/api/events` SSE 推送。视频走视觉服务的 WebRTC 链路。

## 2. Windows 开发工具

项目根目录：`C:\Users\LENOVO\Desktop\fish`。

- Python：视觉服务依赖由 `vision/requirements.txt` 管理。
- Node.js/npm：前端依赖由 `controller/frontend/package-lock.json` 管理。
- Go：`controller/go.mod` 要求 Go `1.23`。
- PlatformIO：统一使用 `%USERPROFILE%\\.platformio\\penv\\Scripts\\pio.exe`，当前 Core 6.2.x。
- Git：只用于版本管理；构建和烧录不会自动提交或推送。

检查环境：

```powershell
python --version
node --version
npm --version
go version
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" --version
```

不要混用 Python 3.14 下的旧 `python -m platformio` 和标准 `pio.exe`。两套 Core 会切换不同 `tool-scons` 版本并清理 `.pio/build`，导致依赖文件消失。`environment-build.ps1` 已固定使用标准 `pio.exe`。

## 3. 软件编译

一键构建：

```powershell
.\environment-build.ps1
```

按需跳过阶段：`-SkipPython`、`-SkipFrontend`、`-SkipFirmware`、`-SkipController`。

前端：

```powershell
cd controller/frontend
npm ci
npm run build
```

Go 控制器：

```powershell
cd controller
go mod download
go build -o .runtime/fish-controller.exe ./cmd/fish-controller
```

ESP32 固件：

```powershell
cd firmware
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e seeed_xiao_esp32c3
```

固件产物位于 `firmware/.pio/build/seeed_xiao_esp32c3/`：`firmware.bin`、`bootloader.bin`、`partitions.bin`、`firmware.elf`。当前固件版本为 `2.0.0`，定义在 `firmware/include/AppConfig.h`。

## 4. 硬件连接

目标板为 Seeed XIAO ESP32-C3 / 按 XIAO 焊盘对齐的 ESP32-C3 Super Mini：

| 功能 | GPIO | 说明 |
| --- | ---: | --- |
| 舵机信号 | `GPIO2` | 原 XIAO `D8`，一个舵机 |
| 电池采样 | `GPIO4` / ADC1 | 原 XIAO `A0`，分压中点 |
| 板载状态 LED | `GPIO8` | 单色、高电平点亮；不是 RGB |
| BOOT 按键 | `GPIO9` | 低电平有效，长按 3 秒 |

电池参数：分压比 `3.0`、空电参考 `7.0 V`、满电参考 `7.4 V`、采样周期 10 秒。硬件不支持 RGB、光感和 I2C 传感器。设备唯一标识始终是 MAC，昵称仅用于前端显示。

## 5. 串口烧录

查询端口：

```powershell
Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name,Description
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" device list
```

编译并烧录（将 `COM19` 替换为实际端口）：

```powershell
cd firmware
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e seeed_xiao_esp32c3 -t upload --upload-port COM19
```

PlatformIO 会写入 bootloader、分区表和应用镜像，并逐段校验。成功标志是 `Hash of data verified.` 和 `SUCCESS`。烧录后设备会自动复位；烧录时关闭串口监视器和其他 PlatformIO 进程。

OTA 接口只接受与当前源码一致的应用 `firmware.bin`，不能上传 `bootloader.bin`、`partitions.bin` 或旧镜像。

## 6. 运行检查

```powershell
scripts\start.bat
Invoke-WebRequest http://127.0.0.1:8081/healthz
Invoke-WebRequest http://127.0.0.1:8091/health
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8081,8091 }
```

设备在线必须同时满足 Wi-Fi 已连接、v2 HMAC 注册成功、设备 WebSocket 已建立并持续回报心跳。仅检测到 COM 端口或 UDP 发现包不代表设备已经可控。

## 7. 故障排查

### `.pio/build` 文件消失

比较两套工具链：

```powershell
python -m platformio --version
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" --version
```

如果来源不同，停止使用旧命令，只使用标准 `pio.exe`，再执行一次完整构建。

### 找不到串口或无法烧录

检查 USB 数据线、设备管理器中的 COM 号，以及是否被 Arduino IDE/串口监视器占用。ESP32-C3 USB-Serial/JTAG 常见 VID/PID 为 `303A:1001`。必要时使用 GPIO9 BOOT 按键进入下载模式。

### 烧录成功但服务器离线

继续检查设备 Wi-Fi、控制器 `8081`、v2 版本和日志事件 `device_connected` / `device_register_rejected`。串口烧录成功只代表 Flash 校验通过，不代表网络注册成功。

## 8. 变更纪律

- 当前协议为 v2-only。
- 设备命令唯一键为 MAC，昵称不参与路由。
- 修改 GPIO、版本号、网络策略或协议后必须重新编译并重新烧录。
- 构建、烧录不执行 Git commit/push。
