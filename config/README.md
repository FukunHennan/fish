# Pro1 配置入口

日常部署只编辑本目录的三个 JSON 文件；改完后重新启动程序，固件参数改完还需重新编译并烧录 ESP32。

| 文件                               | 修改内容                                            | 读取方式                                                                            |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| [`firmware.json`](firmware.json) | 设备部署密钥、出厂 Wi-Fi、引脚、电池采样、游泳默认值、固件超时              | PlatformIO 构建脚本注入固件；Go 控制器读取同一密钥                                                |
| [`program.json`](program.json)   | 登录、开发模式、相机编号和 USB 采集模式、YOLO、目标丢失处理、WebRTC       | Go 启动时读取；独立启动视觉服务时 Python 也读取。已设置的进程环境变量优先                                      |
| [`tunnel.json`](tunnel.json)     | 是否启动 Cloudflare Tunnel、隧道 ID、凭据文件路径、公网域名和本地服务地址 | Windows `scripts/start.bat` 读取；启用时生成 `controller/.runtime/cloudflared-live.yml` |

`tunnel.json` 当前为 `enabled: true`；Windows 启动需要 `controller/.runtime/cloudflared.exe`、有效的隧道 UUID 和该隧道的 JSON 凭据。`scripts/start.bat` 会生成运行时 YAML 并启动隧道。首次授权、创建隧道、DNS 路由、安全初始化、验证与排障步骤见[公网访问配置](../docs/程序/公网访问配置.md)。凭据由 `cloudflared tunnel create` 在本机用户目录生成，不要放入仓库。

`program.json` 的 `environment` 键直接使用现有 `FISH_*` 环境变量名，便于核对代码。当前 `FISH_AUTH_DISABLED=true`，关闭内建登录；公网请求同样获得匿名管理员权限。若要恢复登录设为 `false` 并重启。进程环境变量优先于 JSON，不能仅凭文件内容判断实际认证状态。`FISH_CAPTURE_WIDTH=640`、`FISH_CAPTURE_HEIGHT=480`、`FISH_CAPTURE_FOURCC=YUY2` 是当前 USB 2.0 相机已采用的默认采集模式。

`firmware/include/AppConfig.h` 和 `vision/config.py` 仍保留编译默认值、类型及读取逻辑，不再作为日常修改入口。`firmware/platformio.ini`、`go.mod`、`package.json`、`requirements.txt` 等是构建依赖清单。视觉标定产生的 `vision/assets/*.local.json`、Go 用户数据、诊断日志、模型和录像是运行数据或资源，不计入这三个手动配置文件。

目标 GitHub 仓库是公开仓库；`firmware.json` 中的部署密钥和 Wi-Fi 值上传后可被公开读取。启动与停止见[程序文档](../docs/程序/README.md)。
