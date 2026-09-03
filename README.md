# 机器鱼中央控制项目

ESP32-C3 机器鱼固件正在升级为局域网中央控制架构。当前固件位于 `firmware/`。

## 启动

Windows 直接运行：

```bat
scripts\start.bat
```

Linux / macOS 直接运行：

```bash
bash scripts/start.sh
```

如果你要公网访问，再额外放一个 `config/frpc.toml`，启动脚本检测到它后会自动拉起 `frpc`。模板可从 `config/frpc.example.toml` 复制后修改。

打开：

```text
http://localhost:8081
```

关闭：

```bat
scripts\stop.bat
```

Linux / macOS：

```bash
bash scripts/stop.sh
```

提交代码：

```bat
scripts\upload.bat
```

`start.bat` 会自动补齐 `config/deployment.json`，再安装前端依赖、构建前端、编译控制器并启动服务。Go Controller 会自动选择 Python 解释器并启动 `vision/server.py`。Python 选择优先级为：`FISH_PYTHON` → `vision/.venv` → 仓库 `.venv` → PATH 中的 `python/python3` → Windows `py -3`。

如果存在 `config/frpc.toml`，启动脚本会顺手启动 `frpc`，把同一个控制台暴露到公网；没有这个文件就只启动本地服务。

如果你有自己的 Python 环境，可在启动前设置：

```bat
set FISH_PYTHON=D:\path\to\python.exe
scripts\start.bat
```

Linux / macOS：

```bash
export FISH_PYTHON=/path/to/python
bash scripts/start.sh
```

## 默认目标

- Board: `seeed_xiao_esp32c3` (XIAO ESP32-C3)
- Framework: Arduino
- Serial monitor: 115200
- 舵机引脚：GPIO 8（`firmware/include/AppConfig.h`）
- OTA-capable partition table: `default.csv` (含 ota_0/ota_1 分区)

## 本地配置与敏感信息

仓库提供默认配置；首次启动时，`scripts/start.bat` 会确保 `config/deployment.json` 可用。`config/deployment.json` 已被 Git 忽略，不会通过 `upload.bat` 提交。

公网转发配置是可选的，`config/frpc.toml` 也已被 Git 忽略。

如需出厂配网热点，复制 `firmware/include/FactoryWifi.local.example.h` 为 `firmware/include/FactoryWifi.local.h`，填写仅用于本地设备的 SSID 和密码。`FactoryWifi.local.h` 已被 Git 忽略。

不要提交 Wi-Fi 密码、部署密钥、设备标定结果、普通运行日志或编译产物。需要远程分析一次运行时，可将指定诊断日志复制到专门的可提交目录后再上传。

未提供本地出厂 Wi-Fi 配置时，固件不会携带默认网络凭据；设备应通过正常的配网流程配置网络。

## 固件烧录

1. USB 连接 XIAO ESP32-C3。
2. 点击 PlatformIO `Build`。
3. 点击 `Upload`。
4. 打开 `Serial Monitor`。

首次启动或 60 秒无法连接路由器时，连接 `Fish-Setup-XXXXXX` 热点，然后访问 `http://192.168.4.1` 配置路由器和中央控制器。

构建命令：`cd firmware && pio run`。

## 当前开发状态

当前固件已实现运动模块、STA 主动联网、NVS 配置、临时配网热点、MAC 身份、设备主动广播发现、WebSocket 注册、心跳、失联停止和局域网 OTA。首次配网只填写 Wi-Fi 名称与密码；电脑 IP 无需配置。

ESP32 联网后每 3 秒向所在子网广播带 HMAC 证明的 `device.announce`。控制器验证后单播 `controller.offer`，设备从 UDP 回复源地址取得当前电脑 IP，再建立 WebSocket。网页设备卡片可触发内置固件 OTA；设备下载后校验大小及 SHA-256，通过后才切换启动分区并重启。

编译后的固件位于：

`firmware/.pio/build/seeed_xiao_esp32c3/firmware.bin`

注意：XIAO ESP32-C3 的 GPIO8 是板载红色 LED，如果舵机接线冲突，可以在 `AppConfig.h` 中修改 `SERVO_PIN`。
注意：`default_ota.csv` 在部分 PlatformIO 版本中不存在，已改用内置的 `default.csv`（同样支持 OTA）。

## 网页控制台

网页控制台采用“选择集驱动控制”设计，不再为每条机器鱼重复展示完整控制卡片：

- 单选一条机器鱼时，右侧控制面板直接控制该设备。
- 多选多条机器鱼时，同一套控制面板会批量向所选在线设备发送命令。
- “统一参数”模式会把同一组频率、幅度和偏置应用到所选设备。
- “保留独立参数”模式只同步前进、左转、右转、IDLE、STOP 等动作，不覆盖每条鱼当前的频率、幅度和偏置。
- 支持全选在线设备、预留 A/B 分组入口，以及“停止所选”和独立于当前选择集的 `ALL STOP`。
- OTA 可直接对当前选择集发起，后端仍沿用现有单设备 `/api/ota` 接口，前端负责按设备创建任务。

当前批量控制沿用现有 `/api/command` 单设备接口，由网页并行向每个所选 `deviceId` 发送命令，因此无需改变现有 ESP32 WebSocket 协议即可支持单鱼与多鱼统一控制。后续如果需要严格同时起动，可在 Go 控制器增加原子批量命令与统一执行时间戳。

## 视频与视觉功能

中央控制器启动后，网页中的“启动视觉”会打开所选摄像头、视觉处理线程和视频服务。浏览器优先通过 WebRTC 接收 `640×480 / 30 FPS` 画面，信令由 Go 代理；WebRTC 无法建立时自动回退到 MJPEG。“停止视觉”会先发送安全停止，再依次停止循迹和视觉线程、关闭视频连接、释放摄像头及录像文件。停止后，标定、划线、截图、录像和循迹按钮全部禁用，页面也会移除视频连接。

划线、标定等画布操作只在本次视觉运行会话内有效。停止视觉时，尚未处理的画布事件会被丢弃，不会在下次启动后继续执行。已保存的标定模型或输出文件不因此删除。

再次点击当前高亮的“场地标定”“鱼尾标定”“鱼头方向”或“绘制轨迹”即可关闭该画布工具；选择类工具会同步通知 Python 退出对应模式，避免网页高亮状态与后台状态不一致。

如果画面卡顿，先按以下顺序排查：

1. 关闭其他正在观看视频流的浏览器标签页。
2. 停止录像和画面增强，观察卡顿是否消失。
3. 在局域网内测试，暂时绕过 FRP。
4. 观察网页显示的处理 FPS、摄像头实际 FPS 和目标识别状态。
5. 必要时降低 `vision/config.py` 中的 `MJPEG_STREAM_WIDTH`、`MJPEG_STREAM_HEIGHT`、`MJPEG_MAX_FPS` 或 JPEG 质量。

当前采集与浏览器视频参数为 `640×480 / 30 FPS`。MJPEG 仍使用 JPEG 质量 50 作为兼容回退；公网 WebRTC 需要配置 STUN/TURN，并实测带宽与端到端延迟，不能只以本机画面流畅度作为结论。
