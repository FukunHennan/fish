# 固件测试环境

固件测试分为主机逻辑测试和设备运行库测试，避免把测试环境错误误报成编译器不稳定。

## 主机逻辑测试

```powershell
pio test -e native
```

该环境只运行不依赖 Arduino、Wi-Fi 或 ESP32 SDK 的测试。Windows 会自动查找常见的 WinLibs 安装路径；如果 MinGW 安装在其他位置，可设置：

```powershell
$env:FISH_MINGW_BIN = "D:\path\to\mingw64\bin"
```

## Arduino 依赖测试

认证协议、设备身份、发现协议和 Arduino 时序测试使用 ESP32 Arduino 框架。没有本地 `config/deployment.json` 时，编译检查只使用仓库中的示例密钥：

```powershell
pio test -e embedded_test --without-uploading --without-testing
```

上面的命令只做编译检查，不需要接开发板。接入开发板后，去掉两个选项执行实际测试；正式设备测试前仍应配置本机部署密钥。

```powershell
pio test -e embedded_test
```

正式固件编译：

```powershell
pio run -e seeed_xiao_esp32c3
```
