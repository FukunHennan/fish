Import("env")

import json
import os
import re

project_dir = env.subst("$PROJECT_DIR")
config_path = os.path.abspath(os.path.join(project_dir, "..", "config", "firmware.json"))

with open(config_path, "r", encoding="utf-8-sig") as handle:
    config = json.load(handle)

deployment_key = config.get("deploymentKey", "")

if not re.fullmatch(r"[0-9a-fA-F]{64}", deployment_key):
    raise RuntimeError("deploymentKey 必须是 32 字节十六进制")

wifi = config.get("factoryWifi", {})
if not isinstance(wifi, dict):
    raise RuntimeError("factoryWifi 必须是对象")
ssid = wifi.get("ssid", "")
password = wifi.get("password", "")
if not isinstance(ssid, str) or not isinstance(password, str):
    raise RuntimeError("factoryWifi.ssid/password 必须是字符串")

settings = config.get("settings", {})
if not isinstance(settings, dict):
    raise RuntimeError("settings 必须是对象")
allowed = {
    "CONTROLLER_HEARTBEAT_TIMEOUT_MS", "CONTROLLER_DISCOVERY_ANNOUNCE_INTERVAL_MS",
    "CONTROLLER_DISCOVERY_SCAN_INTERVAL_MS", "CONTROLLER_DISCOVERY_SCAN_TIMEOUT_MS",
    "CONTROLLER_DISCOVERY_NEAR_SCAN_RADIUS", "CONTROLLER_REGISTRATION_RECOVERY_MS",
    "CONTROLLER_PROVISIONING_WINDOW_MS", "CONTROLLER_ENDPOINT_REGISTRATION_TIMEOUT_MS",
    "STATUS_LED_PIN", "STATUS_LED_ACTIVE_LOW", "BOOT_BUTTON_PIN", "BOOT_LONG_PRESS_MS",
    "BATTERY_SENSE_PIN", "BATTERY_DIVIDER_RATIO", "BATTERY_EMPTY_VOLTAGE",
    "BATTERY_FULL_VOLTAGE", "BATTERY_SAMPLE_INTERVAL_MS", "SERVO_PIN",
    "SWIM_SPEED", "SWIM_POWER", "TURN_AMOUNT",
}
if set(settings) != allowed:
    raise RuntimeError("settings 字段必须与 AppConfig.h 中的固件参数完全一致")

defines = [
    ("FISH_DEPLOYMENT_KEY_HEX", deployment_key.lower()),
    ("FISH_FACTORY_WIFI_SSID", json.dumps(ssid, ensure_ascii=True)),
    ("FISH_FACTORY_WIFI_PASSWORD", json.dumps(password, ensure_ascii=True)),
]
for name, value in settings.items():
    if isinstance(value, bool):
        encoded = "true" if value else "false"
    elif isinstance(value, (int, float)):
        encoded = str(value)
    else:
        raise RuntimeError("settings.%s 必须是数字或布尔值" % name)
    defines.append((name, encoded))

env.Append(CPPDEFINES=defines)
