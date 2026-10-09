# 脚本目录

根目录只保留日常入口：`setup.bat` / `setup.ps1` 安装依赖，`start.bat` / `start.sh` 启动服务，`upload.bat` 先归档已结束的诊断日志，再提交并推送。录像与下载的依赖不进入 Git。

| 子目录 | 内容 |
| --- | --- |
| `bootstrap/` | Node 安装程序；从根目录运行 `scripts/setup.bat` 或 `scripts/setup.ps1` |
| `runtime/` | Windows 启动辅助：接管旧进程、生成隧道配置、监督控制器、登录任务 |
| `docs/` | 文档同步检查、测试和 Git 钩子安装 |
| `diagnostics/` | 现场视觉循迹诊断脚本、诊断日志压缩归档与校验 |
| `presentations/` | 历史演示稿生成脚本；其中部分仍使用旧机器的输出路径，运行前需检查 |

入口脚本与辅助脚本的相对路径已按此结构更新。运行中的服务不需要因目录整理而重启；下次启动使用根目录入口。
