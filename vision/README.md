# RoboFish 视觉代码交接说明

## 一、主要功能

- **机器鱼识别与跟踪**：YOLO 负责全局检测和重新捕获，OpenCV HSV 负责逐帧跟踪橙色鱼尾。
- **场地标定**：支持 ArUco 四角点自动标定，也支持手动点击水池四角，建立像素坐标到米制坐标的转换。
- **运动状态估计**：计算机器鱼位置、速度和运动方向，并进行相机延迟补偿。
- **路径循迹**：支持鼠标绘制轨迹，计算路径曲率、航向误差和离轨误差，生成控制量。
- **机器鱼通信**：通过 HTTP 向机器鱼发送视觉 PID 数据和 STOP 指令。
- **安全保护**：相机失帧、目标丢失、路径失效、到达终点、清除路径、退出或异常时停止推进。
- **显示与记录**：提供本地 HUD、平板 TCP 遥测、MJPEG 视频流、录像、CSV 数据和截图。

## 二、使用方法

### 1. 运行环境

当前使用的 Python 解释器：

```text
D:\python\venvs\yolo\ultralytics\8.4.118\Scripts\python.exe
```

主要版本：Python 3.13.14、OpenCV 5.0.0、Ultralytics 8.4.118、PyTorch 2.11.0+cu128，CUDA 可用。

### 2. 启动程序

```powershell
cd "C:\Users\rlyoulo\Desktop\codeFish(1)\codeFish"
& "D:\python\venvs\yolo\ultralytics\8.4.118\Scripts\python.exe" .\VISION\main.py
```

也可以在 VS Code 中选择：

```text
VISION: YOLO GPU（外置 USB 摄像头）
```

当前相机索引为 `1`。如果无法打开相机，需要修改 `VISION/main.py` 中的 `camera_index`。

### 3. 操作顺序

```text
启动程序
→ 确认相机和YOLO正常
→ 完成场地标定
→ 标定橙色鱼尾
→ 点击鱼头方向
→ 从机器鱼附近绘制轨迹
→ 点击启动
```

常用操作：

| 操作 | 功能 |
|---|---|
| `Enter` | 启动循迹 |
| `Space` | 停止 |
| `Q` | 退出 |
| 鼠标左键拖动 | 绘制轨迹 |
| 鼠标右键 | 清除轨迹 |
| 工具栏 | 标定、录像、截图、曝光和画面增强 |

机器鱼默认地址为 `192.168.4.1:80`，电脑端 MJPEG 地址为 `http://<电脑IP>:8090/video.mjpg`，平板 TCP 端口为 `9998`。


## 三、目录说明

```text
VISION/
├─ main.py             主入口、生命周期和功能调度
├─ config.py           相机、模型、网络和物理尺寸配置
├─ perception.py       YOLO、鱼尾跟踪、ArUco和坐标转换
├─ navigation.py       速度、航向、路径引导和转圈标定
├─ control.py          控制状态机和机器鱼HTTP通信
├─ interface.py        相机、平板TCP、MJPEG和录像
├─ ui.py               输入、工具栏、HUD和遥测
├─ requirements.txt    Python运行依赖
└─ assets/
   ├─ best.pt          YOLO模型
   └─ marker_profile.local.json
                       鱼尾颜色配置

tests/vision/           视觉离线测试
docs/VISION_ARCHITECTURE.md
                        视觉架构说明
output/vision/          运行生成的录像、CSV和截图
```

只有 `main.py` 负责组合各功能模块，其他模块之间不直接互相依赖。

## 四、后续优化方向

1. **重新完成整机验证**：测试真实 USB 相机、机器鱼、平板和 MJPEG 的联合运行，以及所有 STOP 场景。
2. **持续检查场地标定**：控制过程中低频复核 ArUco，防止相机移动后继续使用旧坐标矩阵。
3. **提高启动安全性**：启动时要求当前帧直接识别到鱼尾，不允许仅依靠短时预测位置启动。
4. **重新测量系统延迟**：记录相机、推理、HTTP 和执行时间，替换目前固定的 `0.30 s` 补偿值。
5. **降低鱼尾摆动误差**：评估鱼身刚体参考点、鱼头识别或其他更稳定的跟踪位置。
6. **完善集成测试**：增加假相机和假通信测试，覆盖主循环、相机失帧、目标丢失和关闭流程。
7. **继续整理代码**：统一运行状态，删除或接入未使用的 Windows 鼠标轮询和刚体跟踪代码。
8. **标定控制参数**：实测左右转圈半径、终点制动距离和相机索引，并保存对应配置。
