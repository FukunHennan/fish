# 程序：启动、停止和可调配置

## 电脑环境要求

| 用途 | 必需条件 | 核对依据 |
| --- | --- | --- |
| 控制器 | Go **1.23 或更高的兼容版本** | `controller/go.mod` 声明 `go 1.23.0` |
| 正式前端构建 | Node.js **20.19+ 或 22.12+**、npm | 锁定的 Vite 8.2.2 和 React 插件在 `package-lock.json` 中声明该 Node 范围 |
| 视觉服务 | Python、pip，并成功安装 `vision/requirements.txt` | 依赖包含 OpenCV、NumPy、Flask、Ultralytics 和 aiortc；具体 Python 版本以依赖安装结果核对 |
| 相机 | 可用的 USB 2.0 UVC 端口、相机驱动和 Pro1 相机 | 当前默认请求 `640×480 YUY2`；需要确认设备实际返回模式 |
| 默认 YOLO 推理 | 可用的 GPU 设备编号 `0`（CUDA 或代码支持的 XPU） | 当前 `FISH_YOLO_DEVICE=0` 不自动退回 CPU；无可用 GPU 时可显式改为 `cpu`，性能需实测 |
| 固件构建和串口烧录 | PlatformIO Core 6.2.x、ESP32-C3 串口连接 | `environment-build.ps1` 的检查及 `firmware/platformio.ini` 的目标板 |
| Windows 首次安装 | 带 npm 的 Node.js、Windows PowerShell、`winget`、网络连接 | `scripts/setup.bat` 可安装 Go、Python 3.12 和电脑端依赖；系统安装程序可能请求管理员确认 |
| Windows 一键启动 | Windows PowerShell、Go、Node/npm、Python | `scripts/start.bat` 会构建并尝试安装 `FishStack` 登录任务 |
| 内网穿透（可选） | `cloudflared.exe`、Cloudflare 隧道凭据和网络连接 | 仅在 `config/tunnel.json` 的 `enabled=true` 时需要 |

本机运行需确保 `8081/TCP`、视觉服务 `8091/TCP` 可用；ESP32 发现还使用 `30303/UDP`。Linux/macOS 使用 `bash scripts/start.sh`，不使用 Windows 登录任务。具体安装与版本核对命令见[环境与构建](环境与构建.md)。

## 启动

先修改[三个配置文件](../../config/README.md)。Windows 新电脑先运行 `scripts\setup.bat --local --cpu` 安装电脑端依赖并关闭隧道、改用 CPU；这两个选项会改动对应 JSON，若已配好公网和 GPU 则运行不带选项的 `scripts\setup.bat`。随后从项目根目录运行 `scripts\start.bat`：脚本构建前端和 Go、启动控制器与视觉服务；仅当 `config/tunnel.json` 的 `enabled` 为 `true` 时启动 Cloudflare Tunnel。Linux/macOS 运行 `bash scripts/start.sh`，该脚本不启动 Tunnel。浏览器打开 `http://127.0.0.1:8081/competition.html`。

Windows 登录启动任务名为 `FishStack`，由启动脚本尝试安装；注册失败时需以管理员权限单独运行安装脚本，手动启动不受影响。首次公网配置按[公网访问配置](公网访问配置.md)操作；需要 Go、npm 和 Python 环境。编译和烧录步骤见[环境与构建](环境与构建.md)，完整运行行为见[系统运行手册](系统运行手册.md)。

## 停止

- 手动启动：在运行窗口按 `Ctrl+C` 或关闭窗口。Windows 脚本会停止它启动的 Tunnel；Go 关闭时会停止由它启动的视觉子进程。
- 不希望 Windows 下次登录自动启动：在 PowerShell 执行 `Disable-ScheduledTask -TaskName FishStack`。再次需要时运行 `Enable-ScheduledTask -TaskName FishStack`。
- Linux/macOS 前台运行：在终端按 `Ctrl+C`。若使用另外部署的 systemd 用户服务，应通过该服务自身的 `systemctl --user stop` 命令停止。

## 配置和范围

以下是日常修改入口。**“代码约束”与“已验证值”不同：** 没有代码边界检查的项目不能把建议范围当作程序自动保证的范围。

| 配置文件 | 字段 | 当前值或代码约束 | 调整后 |
| --- | --- | --- | --- |
| `config/program.json` | `FISH_AUTH_DISABLED` | 当前 `true` 关闭认证并赋予匿名管理员权限；`false` 启用登录 | 重启 Go |
| 同上 | `FISH_CAMERA_INDEX` | 当前 `1`；应是实际相机枚举编号，代码未限制上界 | 重启视觉服务并核对画面 |
| 同上 | `FISH_CAPTURE_WIDTH` / `HEIGHT` | 当前实测使用 `640×480`；代码按整数读取，未验证任意尺寸 | 重启视觉服务，核对设备返回尺寸与帧率 |
| 同上 | `FISH_CAPTURE_FOURCC` | 四字符格式；长度不为 4 时退回 `YUY2` | 重启视觉服务 |
| 同上 | `FISH_YOLO_IMGSZ` / `DEVICE` | 当前 `1920` / `0`；整数设备号要求对应 GPU，`cpu` 需显式设置 | 重启视觉服务 |
| 同上 | `FISH_TARGET_LOSS_*` | 当前宽限 `3.0s`、预测 `1.0s`、最大位移 `0.20m`；代码未统一限制范围 | 重启视觉服务，重新验证循迹 |
| 同上 | `FISH_WEBRTC_*` | STUN 有默认值；TURN 地址、账号、凭据当前为空 | 重启视觉服务，测试远程视频 |
| `config/tunnel.json` | `enabled` | 布尔值；当前 `true` | 修改隧道 ID、凭据路径、域名与本地服务后重启 Windows 脚本 |
| `config/firmware.json` | `deploymentKey` | 必须是 32 字节十六进制；Go 与固件必须一致 | 重新编译烧录固件并重启 Go |
| 同上 | `settings` | 引脚、采样、超时及游泳默认值；`SWIM_SPEED` 注释建议 1.0–4.0，`SWIM_POWER` 建议 10–40 | 重新编译烧录固件，实机核对 |

`program.json` 的值是进程环境变量的默认值；已设置的同名环境变量优先。视觉标定文件由程序生成，账号、比赛和运动标定在用户配置目录中保存，均不要求手工修改。完整字段见[配置说明](../../config/README.md)。
