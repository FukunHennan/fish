# 安全局域网发现与可控制设备注册实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 使用共享部署密钥、动态 HMAC 挑战、UDP 周期发现和成熟 WebSocket 库，使网页只显示当前已认证且可控制的机器鱼。

**架构：** Go 每 5 秒在全部有效 IPv4 接口发送带随机 nonce 的 UDP 广播，ESP32 使用 `HMAC-SHA256(部署密钥, 域分隔符 + nonce + 标准化MAC)` 回复身份与状态。实时控制使用 `gorilla/websocket`，注册同样采用服务端挑战；WebSocket 断开即从网页列表删除。

**技术栈：** Go 1.27 标准库、`github.com/gorilla/websocket`、React 19、Vite 8、Arduino ESP32、mbedTLS、PlatformIO。

**设计文档：** `docs/superpowers/specs/2026-08-24-lan-fish-control-system-design.md`

## 全局约束

- 只使用系统 Go `C:\Program Files\Go\bin\go.exe`，不使用 `.tools` 便携版。
- 部署密钥为 32 字节随机值，以 64 位小写十六进制保存，禁止写入日志和网页响应。
- UDP 发现周期为 5 秒；nonce 有效期为 10 秒且只能验证一次。
- 网页只显示 HMAC 验证成功且 WebSocket 当前在线的机器鱼。
- WebSocket 断开后立即删除设备记录，不显示普通设备或离线设备。
- 所有生产变更遵循测试先行；固件构建和真机联调作为最终验证。
- 当前目录不是 Git 仓库，各任务的提交步骤改为记录验证结果；初始化 Git 后再补提交。

---

### 任务 1：共享部署密钥配置

**文件：**
- 新建：`config/deployment.example.json`
- 新建：`controller/internal/config/config.go`
- 新建：`controller/internal/config/config_test.go`
- 新建：`scripts/generate-deployment-config.ps1`
- 新建：`firmware/scripts/inject_deployment_key.py`
- 修改：`firmware/platformio.ini`
- 修改：`.gitignore`

**接口：**
- 产出：`config.Load(path string) (Config, error)`，其中 `Config.DeploymentKey []byte` 恰好为 32 字节。
- 产出：PlatformIO 宏 `FISH_DEPLOYMENT_KEY_HEX`，内容来自 `config/deployment.json`。

- [ ] **步骤 1：编写失败测试**

```go
func TestLoadDeploymentKey(t *testing.T) {
    path := writeConfig(t, `{"deploymentKey":"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"}`)
    cfg, err := Load(path)
    if err != nil || len(cfg.DeploymentKey) != 32 { t.Fatalf("配置读取失败: %v", err) }
}

func TestRejectsInvalidDeploymentKey(t *testing.T) {
    path := writeConfig(t, `{"deploymentKey":"abcd"}`)
    if _, err := Load(path); err == nil { t.Fatal("短密钥必须被拒绝") }
}
```

- [ ] **步骤 2：验证测试因配置模块不存在而失败**

运行：`& 'C:\Program Files\Go\bin\go.exe' test ./internal/config -count=1`

预期：FAIL，提示 `Load` 或 `Config` 未定义。

- [ ] **步骤 3：实现配置加载与生成脚本**

`Config` 只暴露解码后的密钥：

```go
type Config struct { DeploymentKey []byte }

func Load(path string) (Config, error) {
    raw, err := os.ReadFile(path)
    if err != nil { return Config{}, err }
    var file struct { DeploymentKey string `json:"deploymentKey"` }
    if err := json.Unmarshal(raw, &file); err != nil { return Config{}, err }
    key, err := hex.DecodeString(file.DeploymentKey)
    if err != nil || len(key) != 32 { return Config{}, errors.New("deploymentKey 必须是 32 字节十六进制") }
    return Config{DeploymentKey: key}, nil
}
```

PowerShell 脚本使用 `RandomNumberGenerator.Fill` 创建 32 字节密钥并写入 `config/deployment.json`；Python 预构建脚本读取同一文件、验证 64 位十六进制并调用 `env.Append(CPPDEFINES=[("FISH_DEPLOYMENT_KEY_HEX", '\"'+key+'\"')])`。

- [ ] **步骤 4：验证配置与固件注入**

运行：

```powershell
& 'C:\Program Files\Go\bin\go.exe' test ./internal/config -count=1
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -d firmware -e seeed_xiao_esp32c3
```

预期：Go 测试 PASS，固件构建 SUCCESS，输出不包含部署密钥。

### 任务 2：跨端 HMAC 身份算法

**文件：**
- 新建：`controller/internal/identity/proof.go`
- 新建：`controller/internal/identity/proof_test.go`
- 修改：`firmware/include/DeviceIdentity.h`
- 修改：`firmware/src/DeviceIdentity.cpp`
- 新建：`firmware/test/test_device_identity/test_main.cpp`

**接口：**
- 产出：`identity.NormalizeMAC(string) (string, error)`。
- 产出：`identity.Proof(key []byte, domain, nonce, mac string) (string, error)`。
- 产出：`identity.Verify(key []byte, domain, nonce, mac, proof string) bool`。
- 固件产出：`bool computeIdentityProof(const char* domain, const char* nonce, char output[65])`。

- [ ] **步骤 1：用固定测试向量编写 Go 失败测试**

固定输入为 32 字节 `00..1f` 密钥、域 `fish-discovery-v1`、nonce `00112233445566778899aabbccddeeff`、MAC `AC:27:6E:7C:37:18`。断言标准化 MAC 为 `ac276e7c3718`，proof 等于测试中手工预先计算的 64 位十六进制常量，并断言错误 nonce 验证失败。

- [ ] **步骤 2：运行测试确认缺少身份模块**

运行：`& 'C:\Program Files\Go\bin\go.exe' test ./internal/identity -count=1`

预期：FAIL，提示包或函数不存在。

- [ ] **步骤 3：使用 Go 标准密码库实现**

消息格式固定为 UTF-8：`domain + "\n" + nonce + "\n" + normalizedMAC`。使用 `hmac.New(sha256.New, key)` 计算，使用 `hmac.Equal` 验证，禁止普通字符串比较。

- [ ] **步骤 4：实现 mbedTLS 同算法并运行相同向量**

固件使用 `mbedtls_md_hmac` 和 `MBEDTLS_MD_SHA256`，输出小写十六进制。嵌入式 Unity 测试断言与 Go 固定向量完全相同。

- [ ] **步骤 5：验证跨端结果**

运行 Go 身份测试和 PlatformIO `test_device_identity` 构建；真机测试在任务 6 执行。

### 任务 3：使用 gorilla/websocket 实现动态注册

**文件：**
- 删除：`controller/internal/web/socket.go`
- 修改：`controller/go.mod`
- 修改：`controller/internal/web/server.go`
- 修改：`controller/internal/web/server_test.go`
- 修改：`controller/internal/hub/hub.go`
- 修改：`controller/internal/hub/hub_test.go`

**接口：**
- WebSocket 首帧（服务端）：`{"type":"auth.challenge","protocolVersion":1,"nonce":"<32 hex>"}`。
- 注册帧（设备）：`{"type":"register","protocolVersion":1,"deviceId":"AC:...","proof":"<64 hex>",...}`。
- 成功帧：`{"type":"register.result","success":true}`。

- [ ] **步骤 1：编写失败的 WebSocket 集成测试**

使用 `httptest.NewServer` 和 `websocket.DefaultDialer.Dial` 连接 `/ws/device`，读取 challenge，计算动态 proof 后发送注册帧，断言收到成功结果并且 Hub 中出现一台在线设备；错误 proof 必须收到失败结果并断开。

- [ ] **步骤 2：运行测试确认旧协议失败**

运行：`& 'C:\Program Files\Go\bin\go.exe' test ./internal/web -run DynamicChallenge -count=1`

预期：FAIL，因为旧服务端等待设备先发固定 token 注册。

- [ ] **步骤 3：替换自写 WebSocket**

使用 `websocket.Upgrader`、`ReadJSON`、`WriteJSON` 和单写入锁。challenge 使用 `crypto/rand` 生成 16 字节随机数。服务端从任务 1 的配置获得密钥，调用任务 2 的 `identity.Verify`。

- [ ] **步骤 4：断线立即删除设备**

将 `Hub.Remove` 改为删除 map 条目而非设置 `Online=false`。测试连接关闭后 `List()` 长度立即变为 0，并保留“断线后重新注册不 panic”的回归测试。

- [ ] **步骤 5：运行完整 Go 测试与静态检查**

```powershell
& 'C:\Program Files\Go\bin\go.exe' test ./... -count=1
& 'C:\Program Files\Go\bin\go.exe' vet ./...
```

预期：全部 PASS，`controller/internal/web/socket.go` 不再参与构建。

### 任务 4：ESP32 WebSocket 动态挑战客户端

**文件：**
- 修改：`firmware/include/ControllerClient.h`
- 修改：`firmware/src/ControllerClient.cpp`
- 修改：`firmware/include/DeviceConfig.h`
- 修改：`firmware/src/ConfigStore.cpp`
- 修改：`firmware/src/NetworkManager.cpp`

**接口：**
- 消费任务 2 的 `computeIdentityProof("fish-websocket-v1", nonce, output)`。
- 不再读取、保存或展示人工 token。

- [ ] **步骤 1：添加协议状态机测试**

把挑战处理提取为可测试函数：输入非 `auth.challenge`、错误协议版本、空 nonce 时不生成注册消息；合法 challenge 生成包含 MAC、proof、名称、IP、固件和能力的注册 JSON。

- [ ] **步骤 2：运行嵌入式测试构建并确认旧实现失败**

运行 PlatformIO 指定测试且 `--without-uploading`，预期缺少挑战处理接口。

- [ ] **步骤 3：实现挑战处理并移除 token 配置**

`WStype_CONNECTED` 只重置认证状态，不立即发送注册。收到 `auth.challenge` 后计算动态 proof 并发送注册；收到成功结果后才允许命令和状态上报。配网页删除设备令牌输入，`DeviceConfig::valid()` 不再要求 token。

- [ ] **步骤 4：验证固件构建**

运行正式固件构建，预期 RAM/Flash 不超出当前分区且构建 SUCCESS。

### 任务 5：UDP 周期发现与状态回复

**文件：**
- 新建：`controller/internal/discovery/protocol.go`
- 新建：`controller/internal/discovery/service.go`
- 新建：`controller/internal/discovery/service_test.go`
- 新建：`firmware/include/DiscoveryResponder.h`
- 新建：`firmware/src/DiscoveryResponder.cpp`
- 修改：`firmware/src/main.cpp`
- 修改：`controller/cmd/fish-controller/main.go`

**接口：**
- UDP 端口：`30303`。
- 请求：`type=discovery.request`、`protocolVersion=1`、`requestId`、`nonce`。
- 回复：`type=discovery.response`、原 requestId/nonce、MAC、proof、IP、名称、固件、RSSI、uptimeMs、mode、frequency、amplitude、bias、stopReason。

- [ ] **步骤 1：编写协议解析和 HMAC 验证失败测试**

测试合法回复被接受；错误 requestId、未知 nonce、超过 10 秒、重复回复和错误 proof 均被拒绝。使用本机 UDP socket 完成一次请求—回复集成测试，不 mock 网络协议。

- [ ] **步骤 2：实现 Go 发现服务**

每轮用 `net.Interfaces()` 找到 `FlagUp|FlagBroadcast` 且非 loopback 的 IPv4 网络，为每个接口计算广播地址并发送请求。nonce 保存到带过期时间的并发 map；每 5 秒一轮，每个 nonce 最多接受一次同 MAC 回复。

- [ ] **步骤 3：实现 ESP32 UDP 回复器**

使用 Arduino `WiFiUDP` 监听 30303。只处理协议版本 1 和 `discovery.request`；调用任务 2 HMAC 接口，将状态 JSON 单播回数据包来源 IP/端口。单包限制 1400 字节。

- [ ] **步骤 4：接入主循环**

Go `main` 启动 discovery 服务并在退出时关闭；ESP32 `setup` 初始化 responder，`loop` 每轮非阻塞处理一个数据包。UDP 发现结果只写诊断状态，不直接进入网页 Hub；只有任务 3 WebSocket 注册会创建网页设备记录。

- [ ] **步骤 5：运行 Go、固件测试和构建**

运行 `go test ./... -count=1`、`go vet ./...` 和 PlatformIO 正式构建，全部必须通过。

### 任务 6：网页与真实设备端到端验收

**文件：**
- 修改：`controller/frontend/src/main.jsx`
- 修改：`controller/frontend/src/styles.css`
- 修改：`docs/superpowers/plans/2026-08-24-development-to-dashboard.md`

**接口：**
- `/api/devices` 只返回当前 WebSocket 在线设备。
- `/api/command` 保持 motion.set 请求，离线设备返回 `sent=false`。

- [ ] **步骤 1：构建前端并嵌入 Go**

```powershell
Set-Location controller/frontend
npm run build
Set-Location ..
& 'C:\Program Files\Go\bin\go.exe' build -o fish-controller.exe ./cmd/fish-controller
```

- [ ] **步骤 2：烧录正式固件并物理复位**

使用 PlatformIO 上传到 COM9。上传成功后按一次 XIAO ESP32-C3 的 RESET，使其退出下载状态。

- [ ] **步骤 3：验证发现和注册**

启动控制器，确认日志出现 UDP proof 验证成功和 WebSocket 注册成功；访问 `/api/devices`，必须只包含 MAC `AC:27:6E:7C:37:18` 且状态字段非零。

- [ ] **步骤 4：执行安全控制验收**

网页依次发送停止、待机、前进、左转、右转、停止；每步确认 ESP32 状态回传。运动测试需要用户确保机器鱼处于安全测试环境。

- [ ] **步骤 5：执行断线验收**

断开设备电源或 Wi-Fi，WebSocket 关闭后 `/api/devices` 必须立即返回空数组；恢复设备后自动重新挑战、认证并重新出现。

- [ ] **步骤 6：更新阶段计划证据**

勾选第二阶段中已经实机验证的设备信息、简单运动控制和断线移除项，记录 Go 测试、前端构建、固件构建、设备 MAC/IP 和验证时间。

