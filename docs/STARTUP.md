# 机器鱼项目统一启动说明

## 目标

项目现在统一为两步：

- 第一次准备环境：`./scripts/setup.ps1`
- 日常启动：`./scripts/start.ps1`

不再要求手动记住 Python 3.14、前端构建目录或从哪个子目录运行 Go。

## 首次安装

在 PowerShell 中进入仓库根目录：

```powershell
cd <你的 fish 仓库目录>
.\scripts\setup.ps1
```

脚本会：

1. 检查 Go（要求 1.23 或更高）。
2. 检查 Node.js / npm。
3. 创建 `config/deployment.json`（不存在时）。
4. 如果设置了 `FISH_PYTHON`，保留并使用该 Python 环境。
5. 否则创建 `vision/.venv` 并安装 `vision/requirements.txt`。
6. 安装并构建 React 前端到 `controller/internal/web/dist`。
7. 下载 Go module 并运行 `go test ./...`。

如果你已经有验证过 CUDA / YOLO 的 Python 环境，可以先设置：

```powershell
$env:FISH_PYTHON = 'D:\path\to\python.exe'
.\scripts\setup.ps1
```

## 日常启动

```powershell
.\scripts\start.ps1
```

脚本会：

1. 检查 `config/deployment.json`。
2. 优先使用 `FISH_PYTHON`；否则使用 `vision/.venv`；仍没有时由 Go 尝试 PATH / Windows Python Launcher。
3. 重新构建前端，避免 React 源码与 Go 内嵌页面不一致。
4. 从 `controller` 目录运行 `go run ./cmd/fish-controller`。
5. Go 自动启动 Python Vision 服务。

浏览器访问：

```text
http://localhost:8081
```

如果你确认前端没有修改，可以：

```powershell
.\scripts\start.ps1 -SkipFrontendBuild
```

## Python 选择优先级

Go 视觉进程启动器按以下顺序查找：

1. `FISH_PYTHON`
2. `vision/.venv`
3. 仓库根目录 `.venv`
4. PATH 中的 `python`
5. PATH 中的 `python3`
6. Windows `py -3`

不再写死 `py -3.14`。

## 配置文件

部署配置固定为：

```text
config/deployment.json
```

也可以通过环境变量覆盖：

```powershell
$env:FISH_CONFIG = 'D:\custom\deployment.json'
```

`deployment.json` 包含本地部署密钥，不提交 Git。

## 前端

React 源码：

```text
controller/frontend/src
```

构建输出：

```text
controller/internal/web/dist
```

单独构建：

```powershell
.\scripts\build-frontend.ps1
```

## 诊断日志

每次 Go Controller 启动会生成：

```text
controller/diagnostics/runs/<session>/
```

其中包含：

- `runtime.json`
- `controller.jsonl`
- `controller.txt`
- `python-vision.txt`

`runs/` 默认不提交 Git。需要分析一次真实运行时，把目标 session 复制到一个你愿意提交的位置，例如：

```text
controller/diagnostics/uploaded/<session>/
```

然后提交到 GitHub即可。

## 推荐测试流程

```text
setup.ps1（首次）
    ↓
start.ps1
    ↓
浏览器打开 localhost:8081
    ↓
启动视觉 / 关闭视觉 / 再启动
    ↓
结束程序
    ↓
上传本次 diagnostics session
```
