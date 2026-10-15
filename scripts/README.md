# 脚本目录

`start.bat` 启动前选择 `1` 局域网或 `2` 公网。自动化可使用 `start.bat lan` 或 `start.bat public` 跳过菜单。局域网模式不启动 Cloudflare Tunnel，视频使用 WebRTC host 候选直连，不访问 STUN/TURN。公网模式通过 Cloudflare Tunnel 提供网页和信令，WebRTC 使用 `all`：优先局域网/公网直连，失败后由 TURN relay 兜底。页面诊断会显示实际候选对和 TURN 协议。录像播放和下载使用当前页面来源的 HTTPS/HTTP Range 接口；从局域网网址打开时走局域网，从公网网址打开时走 Cloudflare Tunnel，浏览器不会从 HTTPS 页面自动切换到 HTTP 内网地址。模式选择不写回隧道配置。切换到局域网启动会停止本项目原有隧道进程。

根目录只保留日常入口：`setup.bat` / `setup.ps1` 安装依赖，手动运行 `start.bat` / `start.sh` 启动服务，`upload.bat` 先归档已结束的诊断日志，再提交并推送。启动脚本不创建开机或登录计划任务。录像与下载的依赖不进入 Git。

| 子目录 | 内容 |
| --- | --- |
| `bootstrap/` | Node 安装程序；从根目录运行 `scripts/setup.bat` 或 `scripts/setup.ps1` |
| `runtime/` | Windows 手动启动辅助：接管旧进程、生成隧道配置、监督和重启控制器 |
| `docs/` | 文档同步检查、测试和 Git 钩子安装 |
| `diagnostics/` | 现场视觉循迹诊断脚本、诊断日志压缩归档与校验 |
| `presentations/` | 历史演示稿生成脚本；其中部分仍使用旧机器的输出路径，运行前需检查 |

入口脚本与辅助脚本的相对路径已按此结构更新。运行中的服务不需要因目录整理而重启；下次启动使用根目录入口。

回放布局与播放验证：运行 `vision/.venv/Scripts/python.exe scripts/diagnostics/replay_probe.py --width 774 --height 586`。脚本读取本地历史记录，在独立浏览器中测试裁判回放界面和录像解码，并检查播放、下载和进度条是否被布局裁剪。认证适配器被隔离，媒体请求转到本机视频服务，因此这项测试不代表公网登录或下载链路验证，也不会启动或结束比赛。

TURN 对比测试：从项目根目录使用 `vision/.venv/Scripts/python.exe scripts/diagnostics/video_probe.py --policy relay --turn-transport udp --buffer-ms 30 --seconds 30`，再将 `udp` 改为 `tcp` 单独测试。摄像头需已启动；报告保存在 `controller/diagnostics/runs`。结果只代表运行脚本的电脑所在网络，测试仍使用 TURN，不切换直连。网页最近 50 次重连原因保存在当前浏览器的 `localStorage` 键 `fish.video.reconnects` 中，诊断栏显示最近原因。
