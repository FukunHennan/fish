param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSsid,

    [string]$FirmwarePath = (Join-Path $PSScriptRoot '..\firmware\.pio\build\seeed_xiao_esp32c3\firmware.bin')
)

$ErrorActionPreference = 'Stop'

$ssidMatch = [regex]::Match((netsh wlan show interfaces | Out-String), '(?m)^\s*SSID\s*:\s*(.+?)\s*$')
if (-not $ssidMatch.Success -or $ssidMatch.Groups[1].Value -ne $ExpectedSsid -or
    -not $ExpectedSsid.StartsWith('FishBotTT-')) {
    throw "请先连接目标旧设备的 FishBotTT 热点；当前 Wi-Fi 不是 $ExpectedSsid"
}

$firmware = (Resolve-Path -LiteralPath $FirmwarePath).Path
$file = Get-Item -LiteralPath $firmware
if ($file.Extension -ne '.bin' -or $file.Length -lt 24 -or $file.Length -gt 0x140000) {
    throw '请选择不超过旧设备 OTA 分区大小（0x140000）的 ESP32-C3 .bin 应用固件'
}
$stream = [System.IO.File]::OpenRead($firmware)
try {
    $header = New-Object byte[] 24
    if ($stream.Read($header, 0, $header.Length) -ne $header.Length -or
        $header[0] -ne 0xE9 -or [BitConverter]::ToUInt16($header, 12) -ne 5) {
        throw '文件不是有效的 ESP32-C3 应用镜像'
    }
} finally {
    $stream.Dispose()
}

Add-Type -AssemblyName System.Net.Http
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.UseProxy = $false
$client = New-Object System.Net.Http.HttpClient -ArgumentList $handler
try {
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $client.DefaultRequestHeaders.ExpectContinue = $false
    $preflightTimeout = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(15))
    try {
        $pageResponse = $client.GetAsync('http://192.168.4.1/ota', $preflightTimeout.Token).GetAwaiter().GetResult()
    } finally {
        $preflightTimeout.Dispose()
    }
    $page = $pageResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $pageResponse.IsSuccessStatusCode -or $page -notmatch 'FishBot Firmware Update') {
        throw '目标设备没有响应旧版 FishBot OTA 页面；已停止上传'
    }

    $sha256 = (Get-FileHash -LiteralPath $firmware -Algorithm SHA256).Hash
    Write-Host "目标热点：$ExpectedSsid"
    Write-Host "固件：$firmware ($($file.Length) 字节)"
    Write-Host "SHA256：$sha256"
    if ((Read-Host '确认向该设备写入此固件，请输入 YES') -cne 'YES') {
        Write-Host '已取消'
        return
    }

    $securePassword = Read-Host '旧固件 OTA 密码' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }

    $content = New-Object System.Net.Http.MultipartFormDataContent
    $stream = [System.IO.File]::OpenRead($firmware)
    try {
        $fileContent = New-Object System.Net.Http.StreamContent -ArgumentList $stream
        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
        $content.Add($fileContent, 'update', 'firmware.bin')
        $uri = 'http://192.168.4.1/update?pwd=' + [Uri]::EscapeDataString($password)
        Write-Host '开始上传，弱 Wi-Fi 环境下可能需要数分钟，请勿断电或切换热点。'
        $response = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode -or $body -notmatch 'OK\. Rebooting') {
            throw "旧设备拒绝升级：HTTP $([int]$response.StatusCode) $body"
        }
        Write-Host '旧设备报告写入成功并准备重启；这不代表新固件已成功启动。'
        Write-Host '约 30 秒后查找 Fish-Setup-* 热点并配网；如仍是 FishBotTT-*，请采集串口启动日志。'
    } finally {
        $content.Dispose()
        $stream.Dispose()
        $password = $null
    }
} finally {
    $client.Dispose()
    $handler.Dispose()
}
