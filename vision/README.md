# Python 视觉服务

## 1. 作用

Python 视觉服务负责摄像头、YOLO、目标跟踪、标定、路径和视频。

```text
摄像头 → Python → 识别/跟踪/控制计算 → Go → ESP32
```

Python 不直接访问机器鱼 IP，也不直接判断网页用户权限。设备命令必须经过 Go 控制器。

## 2. 启动方式

通常由 Go 控制器自动启动：

```text
Go Controller → vision/server.py
```

Python 服务监听：

```text
127.0.0.1:8091
```

浏览器访问视觉接口和视频时，使用 Go 的代理，不直接访问 `8091`。

如果需要单独调试：

```bash
cd vision
python server.py
```

项目会优先使用 `vision/.venv` 中的 Python。也可以设置：

```bash
export FISH_PYTHON=/path/to/python
```

Windows：

```bat
set FISH_PYTHON=D:\path\to\python.exe
```

## 3. 主要模块

| 文件 | 作用 |
|---|---|
| `server.py` | 无窗口服务入口 |
| `service.py` | 视觉会话、状态和动作接口 |
| `perception.py` | YOLO、鱼尾跟踪和目标数据 |
| `tracking_application.py` | 视觉处理主循环 |
| `navigation.py` | 路径、航向和控制量 |
| `web_api.py` | 摄像头、会话、状态和视频接口 |
| `webrtc.py` | WebRTC 视频服务 |
| `camera_stream.py` | 摄像头采集和重启 |
| `assets/best.pt` | YOLO 模型 |

## 4. 视觉流程

```text
选择摄像头
  → 启动预览
  → 选择 YOLO 模型
  → 识别机器鱼
  → 选择正确目标
  → 绑定物理设备
  → 绘制或加载路径
  → 启动视觉控制
```

识别目标编号是视觉身份，`deviceId` 是 ESP32 物理身份。两者必须明确绑定，不能因为识别到某个目标就自动控制一台设备。

## 5. 视频

当前策略：

1. Python 生成处理后视频。
2. Go 负责反向代理。
3. 浏览器优先使用 WebRTC。
4. WebRTC 不可用时使用 MJPEG 回退。

当前常用采集参数：

```text
640 × 480
目标 30 FPS
MJPEG 质量 50
```

公网通过 FRP 时，视频带宽和延迟可能比局域网更高。遇到卡顿，先在本机直接访问 GUI，关闭录像和画面增强，再比较处理 FPS、YOLO FPS 和浏览器显示效果。

## 6. 视觉控制安全边界

以下情况必须停止视觉运动：

- 目标没有出现。
- 目标编号已经失效。
- 物理设备没有绑定。
- 控制权不属于当前视觉会话。
- 视觉会话超时。
- 摄像头失帧。
- Python 服务退出。
- 用户停止视觉。

当前正常停止流程由 Go 代理请求到 Python，Python 发出停止命令并释放会话和视频资源；Go 并未在代理所有关闭请求之前独立执行停止。

为处理 Python 崩溃、卡住或停止产生运动命令，Go 为每台设备的视觉运动设置独立的 3 秒有效期。新的视觉运动命令续期，Go/设备心跳不续期；到期后 Go 将零振幅、零偏置的停止命令加入设备发送队列，并丢弃尚未写出的过期视觉命令。该机制不依赖网页登录开关，也不等待 60 秒控制权租约到期。

向前标定使用 `durationMs` 指定有效期，默认 3200 ms，允许 1–5000 ms。正常停止和手动接管会废止旧会话。`motion` 和 `calibrate-forward` 必须匹配当前由 `start` 建立的会话；超时后不能靠重发旧运动命令恢复，必须重新启动控制。Python 收到运动请求的 `409` 拒绝后会关闭本地发送状态并清理待发队列。上述保护已通过自动化测试，物理停机时延和舵机边界尚需实机验收。

## 7. 常用接口

浏览器通过 Go 代理使用以下能力：

```text
/api/vision/cameras
/api/vision/sessions
/api/vision/sessions/current
/api/vision/sessions/{id}/processing
/api/vision/sessions/{id}/camera
/api/vision/sessions/{id}/target
/api/vision/sessions/{id}/actions
/api/vision/sessions/{id}/stream.mjpg
```

停止会话使用 `DELETE /api/vision/sessions/{id}`；停止处理使用
`DELETE /api/vision/sessions/{id}/processing`。Python 本机服务使用同类内部接口，
外部用户不应直接依赖 Python 端口。

## 8. 数据和模型

- YOLO 模型放在 `vision/assets/`。
- 运行输出放在 `output/vision/`。
- 录像、截图和 CSV 不应提交到仓库。
- 模型文件可由 GUI 选择，但模型加载和推理仍在 Python 执行。

## 9. 测试

在项目根目录运行 Python 测试：

```bash
cd vision
python -m unittest discover -s tests
```

测试重点包括：

- 摄像头和视觉会话启停。
- 目标识别和跟踪。
- 坐标转换。
- 视觉动作接口。
- 视频和 WebRTC。
- 目标丢失后的安全停止。
