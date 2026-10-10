$ErrorActionPreference = "Stop"

try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri "http://127.0.0.1:8081/__dev/restart-controller" -TimeoutSec 3
    if ($response.StatusCode -ne 202) { exit 1 }
    exit 0
}
catch {
    exit 1
}
