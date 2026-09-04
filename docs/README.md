# 技术文档

这份目录按使用场景整理。先看总览，再按需要进入协议、部署或视觉文档。

## 先看这里

| 文档 | 用途 |
|---|---|
| [系统架构与开发方案](项目架构与开发方案.md) | 了解模块边界、数据流和开发阶段 |
| [部署与公网访问](部署与公网访问.md) | 启动电脑端服务、检查公网和 FRP |
| [项目统一参数](项目统一参数.md) | 查看端口、心跳、视频和控制参数 |
| [维护计划](维护计划.md) | 了解后续整理顺序和修改规则 |

## 按模块查看

- [ESP32 固件](../firmware/platformio.ini)
- [Go 控制器](../controller/cmd/fish-controller/main.go)
- [React GUI](../controller/frontend/)
- [Python 视觉服务](../vision/README.md)
- [WebSocket 通信协议](../protocol/websocket-protocol.md)
- [诊断日志](../controller/diagnostics/README.md)
- [2026-09-04 控制可靠性维护记录](2026-09-04维护记录.md)

## 对外展示

- [简易项目介绍 HTML](project-overview.html)

## 当前入口

- GUI：`http://127.0.0.1:8098/`
- Go 控制器：`http://127.0.0.1:8081/`
- Python 视觉服务：仅监听 `127.0.0.1:8091`
- ESP32 设备连接：Go 的 `/ws/device`

## 术语约定

- **GUI**：电脑浏览器中的 React 控制界面。
- **Controller**：Go 中央控制器，负责对外 API、设备连接、权限和视觉代理。
- **Vision**：Python 视觉服务，负责摄像头、YOLO、跟踪、路径和视频。
- **Device**：运行 `firmware/` 固件的 ESP32 机器鱼。
- **控制权**：一台设备在同一时间只允许一个用户或视觉会话发送运动命令。
- **真实状态**：以 ESP32 的 heartbeat、state 和 command.result 为准，不以网页请求是否返回为准。

## 当前文档与历史设计

本目录的架构、部署和统一参数说明当前实现及其验证边界。`superpowers/specs/` 和 `superpowers/plans/` 保存历史设计与开发计划，其中的超时数值、角色或待办不能直接当作当前实现；发生冲突时以当前模块代码和本目录说明为准，安全要求的差距应列入维护计划。
