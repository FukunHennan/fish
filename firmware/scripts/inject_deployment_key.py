Import("env")

import json
import os
import re

project_dir = env.subst("$PROJECT_DIR")
config_path = os.path.abspath(os.path.join(project_dir, "..", "config", "deployment.json"))

if not os.path.isfile(config_path):
    if env.get("PIOENV") == "embedded_test":
        config_path = os.path.abspath(
            os.path.join(project_dir, "..", "config", "deployment.example.json")
        )
    else:
        raise RuntimeError("缺少 config/deployment.json，请运行 scripts/generate-deployment-config.ps1")

with open(config_path, "r", encoding="utf-8-sig") as handle:
    deployment_key = json.load(handle).get("deploymentKey", "")

if not re.fullmatch(r"[0-9a-fA-F]{64}", deployment_key):
    raise RuntimeError("deploymentKey 必须是 32 字节十六进制")

env.Append(CPPDEFINES=[("FISH_DEPLOYMENT_KEY_HEX", deployment_key.lower())])
