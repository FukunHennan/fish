# 开发日志

这里记录**本地修改与验证、云端提交、当前进度、重大错误的原因和处理**。Git 提交历史是云端更新的最终记录；本页只提炼影响系统行为的变化。

## 更新记录

| 日期 | 本地变化与验证 | 云端记录 |
| --- | --- | --- |
| 2026-10-08 | Pro1 本地快照覆盖云端；删除两份 `.gitignore`，确认远端文件树与本地一致 | [提交 `1680308`](https://github.com/FukunHennan/fish/commit/1680308cbad0184911b55313383843f0110e75a3) |
| 2026-10-08 | 手动配置收敛为 `firmware.json`、`program.json`、`tunnel.json`；JSON、Python 读取与隧道脚本检查通过 | [提交 `8051961`](https://github.com/FukunHennan/fish/commit/80519619d4b6b7b33ef6e80f685d62e71bc7ae87) |
| 2026-10-08 | 文档重排为程序、硬件、概述、开发日志四类，并加入按变更范围检查的脚本与 GitHub Actions；构建验证受本机工具缺失限制 | [提交 `bbfb102`](https://github.com/FukunHennan/fish/commit/bbfb1029a13c97c5244c444a3718202034291597) |
| 2026-10-09 | 增加 Windows 公网访问配置说明；本机 `tunnel.json` 已启用并填入隧道 ID 与凭据路径。安装 Go 和视觉 Python 依赖，前端构建、Go 构建及 `go test ./...` 通过；文档链接和检查脚本测试通过。公网连通性与视觉服务就绪仍未确认 | [Pro1 提交历史](https://github.com/FukunHennan/fish/commits/main/) |

## 当前进度

- 已完成：Pro1 三个手动配置入口、相机手册、四类文档导航及代码结构说明。
- 待现场核对：相机实际协商帧率与重复帧、ESP32 固件重新编译烧录、Cloudflare Tunnel 凭据与公网连通性。
- 本机已安装 Go 与 `vision/.venv` 的 Python 依赖，前端和 Go 可构建；仍需验证视觉服务启动及相机画面。PlatformIO Core 尚未安装，ESP32 固件构建未验证。

## 重大问题、原因与处理

| 问题 | 已知原因 | 处理和剩余验证 |
| --- | --- | --- |
| 相机请求 `960×720` 得到 `960×540` | 当前设备/驱动协商返回 16:9，破坏程序依赖的 4:3 画面比例 | 默认改用 `640×480 YUY2`；不同电脑仍需实测返回尺寸和帧率，见[相机手册](../硬件/相机手册.md) |
| 文档与代码的登录模式描述冲突 | Go 在 `FISH_AUTH_DISABLED` 未设置或为 `true` 时关闭内建登录，旧说明未清楚描述公网情形 | [系统运行手册](../程序/系统运行手册.md)按代码写明行为；`program.json` 显式列出当前值 |
| Windows 隧道配置缺失导致启动脚本失败 | 旧脚本无条件要求 `.runtime/cloudflared-live.yml` 和可执行文件 | 新 `tunnel.json` 默认关闭；启用时生成 YAML 并检查凭据文件。公网效果仍待实测 |
| 首次在本机启动时视觉后台未在 20 秒内就绪 | 控制器等待视觉服务健康检查超时；当时未取得能确定根因的 Python 错误日志 | 已建立 Python 3.12 虚拟环境并安装依赖；需再次启动并确认健康接口与相机画面，不能把依赖安装成功视为服务启动成功 |
| Windows 登录任务注册失败 | `Register-ScheduledTask` 返回 `0x80004005`，当前证据不足以确认具体权限或系统原因 | 手动启动不依赖登录任务；自动启动需单独排查并验证 |

## 自动检查规则

- **每次推送：** GitHub Actions 根据 Git 差异只检查受影响的“程序／硬件／概述”文档；源码或配置变更还要求更新本日志。失败的工作流会标记推送的文档检查未通过。在 Git 检出目录运行 `scripts/install-doc-hooks.ps1` 后，本地 `pre-push` 钩子还会在发送前阻止未通过的推送。
- **长期未更新：** 每周运行一次检查。若相关代码晚于分类文档变化，且该类文档超过 45 天未更新，报告为落后；若代码没有变化，仅因时间经过不会判定落后。检查同时验证本地 Markdown 链接。
- 本地可运行 `python scripts/check_docs.py --mode push --base <基线提交> --head HEAD`；定期检查使用 `python scripts/check_docs.py --mode stale --days 45`。

GitHub Actions 在推送后检查；若要在平台层禁止失败检查的提交进入 `main`，还需为仓库配置要求该检查通过的分支保护规则。当前本地快照没有 `.git`，因此不能在这里安装钩子。
