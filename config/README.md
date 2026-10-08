# Pro1 配置总览

按用途只看四组。文件保留在使用它的组件目录中，因为启动脚本、Go、固件构建和视觉代码按这些路径读取；本页是统一索引。

| 组别 | 主要文件 | 管什么 | 当前状态 |
| --- | --- | --- | --- |
| 部署与访问 | `config/deployment.json`、`config/deployment.example.json`；Windows 隧道配置 `controller/.runtime/cloudflared-live.yml` | Go 与固件共用的设备密钥、Cloudflare Tunnel 入口 | 两份密钥文件存在，且当前值相同；隧道配置缺失 |
| 固件与设备 | `firmware/include/FactoryWifi.local.h`、`FactoryWifi.local.example.h`、`FactoryWifi.h`、`AppConfig.h`、`DeviceConfig.h` | 出厂 Wi-Fi、硬件引脚、固件默认值及设备配置结构 | 文件均存在；设备运行时写入的 Wi-Fi 等数据保存在设备 NVS 中 |
| 相机与视觉 | `vision/config.py`、`vision/assets/heading_profile.local.json`、`turn_calibration.local.json`、`marker_profile.local.json` | USB 相机采集模式、模型和视频参数，以及场地标定 | 前三个文件存在；尾部标记标定文件缺失，可选 |
| 构建与依赖 | `firmware/platformio.ini`、`controller/go.mod`、`go.sum`、`controller/frontend/vite.config.js`、`package.json`、`package-lock.json`、`vision/requirements.txt` | 固件、Go、前端和 Python 的构建及依赖 | 文件均存在 |

`vision/assets/best.pt` 是模型数据，不是配置。`vision/Ultralytics/settings.json` 是第三方工具设置，不是 Pro1 的运行参数入口。项目已移除 `.gitignore`，Git 不再按项目规则排除文件。

## 一台新机器需要填写什么

1. 在 `config/deployment.json` 中设置该部署使用的 32 字节十六进制 `deploymentKey`，并用同一份配置构建固件和启动 Go 控制器。当前实际文件与示例文件的密钥相同；如果示例文件会公开，应先换成独立的部署密钥。
2. 如果使用 Windows `scripts/start.bat`，准备 `controller/.runtime/cloudflared.exe` 和 `cloudflared-live.yml`。当前两个文件都不存在；移除忽略规则也不会自动生成它们。Linux/macOS 的 `scripts/start.sh` 不要求它们。
3. 按设备和场地核对 `vision/config.py` 的相机编号、640×480 YUY2 默认采集模式和视觉参数。标定文件不能直接沿用另一台设备或另一处场地的数据。
4. 根据实际访问方式设置认证与 WebRTC 环境变量。`FISH_AUTH_DISABLED=false` 才启用内建登录校验；TURN 参数仅在需要中继时填写。

## 环境变量与运行数据

- Go：`FISH_CONFIG`、`FISH_AUTH_USERS`、`FISH_AUTH_DISABLED`、`FISH_TRUST_CF_ACCESS`、`FISH_INVITE_CODE`、`FISH_COMPETITION_STATE`、`FISH_MOTION_CALIBRATIONS`、`FISH_DIAGNOSTIC_DIR`、`FISH_FIRMWARE_BIN`、`FISH_DEVELOPMENT_MODE`、`FISH_HOT_RELOAD`、`FISH_FRONTEND_DIR`、`FISH_PYTHON`、`FISH_VISION_WATCHDOG_FAILURES`。
- 视觉：`FISH_CAMERA_INDEX`、`FISH_CAPTURE_WIDTH`、`FISH_CAPTURE_HEIGHT`、`FISH_CAPTURE_FOURCC`、`FISH_YOLO_IMGSZ`、`FISH_YOLO_DEVICE`、`FISH_TARGET_LOSS_GRACE_S`、`FISH_TARGET_LOSS_PREDICTION_S`、`FISH_TARGET_LOSS_MAX_PREDICTION_M`、`FISH_WEBRTC_STUN_URL`、`FISH_WEBRTC_TURN_URL`、`FISH_WEBRTC_TURN_USERNAME`、`FISH_WEBRTC_TURN_CREDENTIAL`。Go 会在未设置时生成视觉服务使用的 `FISH_VISION_INTERNAL_TOKEN`。
- 其他：`ROBOFISH_UI_FONT`、`ROBOFISH_UI_FONT_BOLD` 用于视觉界面字体；`FISH_MINGW_BIN` 用于固件原生测试。

项目没有统一的 `.env` 文件；上述变量由对应组件直接读取。Go 的 `users.json`、`competition.json`、`motion-calibrations.json` 默认位于操作系统用户配置目录的 `fish-controller/` 下，属于运行数据。诊断日志与录像位于 `controller/diagnostics/runs/` 和 `output/`，也不是配置。

## Git 范围

按当前项目约定，Pro1 不再使用 `.gitignore`，现存文件全部纳入上传范围。`deployment.json`、`FactoryWifi.local.h` 和本地标定包含部署或设备专属内容；目标仓库目前为公开仓库，上传后这些内容可被公开读取。当前本地工作区没有 `.git` 元数据；远程仓库为 `FukunHennan/fish`。

系统启动与权限关系见[统一手册](../docs/机器鱼项目统一手册.md)。
