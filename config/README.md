# Pro1 配置入口

部署参数集中在三个手动配置文件；另有 `device-motion.json` 自动记录每台设备的运动参数。修改部署参数后重新启动程序，固件参数改完还需重新编译并烧录 ESP32。运动参数通过界面调整后立即保存，下一次控制命令就会读取新值。

Windows 新电脑若只有 Node.js/npm，可从项目根目录运行 `scripts\setup.bat --local --cpu` 安装电脑端依赖并先用本地、CPU 模式启动；这会分别修改 `tunnel.json` 和 `program.json`。已有有效隧道凭据和 GPU 时，可不加这两个选项。完整说明见[环境与构建](../docs/程序/环境与构建.md)。

| 文件                               | 修改内容                                            | 读取方式                                                                            |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| [`firmware.json`](firmware.json) | 设备部署密钥、出厂 Wi-Fi、引脚、电池采样、游泳默认值、固件超时              | PlatformIO 构建脚本注入固件；Go 控制器读取同一密钥                                                |
| [`program.json`](program.json)   | 登录、开发模式、相机编号和 USB 采集模式、旋转角度、曝光值、YOLO、目标丢失处理、WebRTC | Go 启动时读取；独立启动视觉服务时 Python 也读取。已设置的进程环境变量优先 |
| [`tunnel.json`](tunnel.json)     | 是否启动 Cloudflare Tunnel、隧道 ID、凭据文件路径、公网域名和本地服务地址 | Windows `scripts/start.bat` 读取；启用时生成 `controller/.runtime/cloudflared-live.yml` |
| [`device-motion.json`](device-motion.json) | 按 MAC 记录舵机边界、直行中位、转弯范围、过渡时间，以及选手端和管理端的频率与幅度 | 控制器在设备首次接入时建立默认档案；重连继承旧档案；界面调整后写回同一文件 |

`device-motion.json` 的顶层键是设备 MAC（大写冒号格式）。设备更换控制板、MAC 变化后会视为新设备；若需要沿用旧参数，应核对机械安装后手工迁移对应条目。`playerControl` 是选手端频率和幅度百分比，`manualControl` 是管理端手动控制的对应参数。舵机角度由 `servoMin`、`servoMax`、`straightCenter` 等字段决定；不要只通过降低幅度来补偿装反的舵机。首次升级时若旧用户目录存在 `motion-calibrations.json`，启动器会在新文件仍为空时迁移旧档案。

`tunnel.json` 当前为 `enabled: true`；Windows 启动需要 `controller/.runtime/cloudflared.exe`、有效的隧道 UUID 和该隧道的 JSON 凭据。`scripts/start.bat` 会生成运行时 YAML 并启动隧道。首次授权、创建隧道、DNS 路由、安全初始化、验证与排障步骤见[公网访问配置](../docs/程序/公网访问配置.md)。凭据由 `cloudflared tunnel create` 在本机用户目录生成，不要放入仓库。

`program.json` 的 `environment` 键直接使用现有 `FISH_*` 环境变量名，便于核对代码。当前 `FISH_AUTH_DISABLED=false`，本地和公网都要求登录；`FISH_AUTH_USERS` 指向 Pro1 同级的 `Pro1-runtime/users.json`，相对路径以 Pro1 根目录为基准。账号 `1`、`2` 登录后分别进入蓝队和红队选手端，账号 `3` 进入裁判端。同账号的新登录会撤销旧会话。进程环境变量优先于 JSON，不能仅凭文件内容判断实际认证状态。`FISH_CAPTURE_WIDTH=640`、`FISH_CAPTURE_HEIGHT=480`、`FISH_CAPTURE_FOURCC=YUY2` 是当前 USB 2.0 相机已采用的默认采集模式。

`camera.rotationAngle`（-180°～180°）和 `camera.exposure`（相机驱动的曝光值）也在同一文件中。裁判端应用旋转或成功调整曝光时会分别更新对应字段，并保留另一个字段；视觉服务每次打开或重连相机时从这里恢复两项设置。手工修改后重新打开相机预览生效；驱动不接受曝光值时仍以实际回读结果为准。

跨网 WebRTC 可使用 Cloudflare Realtime TURN。长期 Key 保存在项目外的 `../Pro1-runtime/cloudflare-turn-key.json`，由 `scripts/runtime/set-turn-key.ps1 -KeyId <Key ID>` 交互录入，不属于三个可提交的手动配置文件，也不能上传 Git。视觉服务自动从 Cloudflare 获取 24 小时有效的临时 ICE 凭据，提前刷新；浏览器连接在到期前自动重建。未放置 Key 文件时仍采用 `program.json` 内的 STUN 和旧静态 TURN 设置。完整开通步骤见[公网访问配置](../docs/程序/公网访问配置.md)。

`firmware/include/AppConfig.h` 和 `vision/config.py` 仍保留编译默认值、类型及读取逻辑，不再作为日常修改入口。`firmware/platformio.ini`、`go.mod`、`package.json`、`requirements.txt` 等是构建依赖清单。视觉标定产生的 `vision/assets/*.local.json`、Go 用户数据、诊断日志、模型和录像是运行数据或资源，不计入三个手动部署配置文件。

目标 GitHub 仓库是公开仓库；`firmware.json` 中的部署密钥和 Wi-Fi 值上传后可被公开读取。启动与停止见[程序文档](../docs/程序/README.md)。
