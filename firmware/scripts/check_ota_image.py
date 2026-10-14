Import("env")

import hashlib
import struct
import json
from pathlib import Path


def check_ota_image(source, target, env):
    image_path = Path(env.subst("$BUILD_DIR")) / "firmware.bin"
    image = image_path.read_bytes()
    if len(image) < 24 or image[0] != 0xE9:
        raise RuntimeError("OTA 文件不是 ESP 应用镜像")
    if len(image) > min(0x180000, env.BoardConfig().get("upload.maximum_size")):
        raise RuntimeError("OTA 镜像超过 Pro1/Pro2 应用分区大小")
    if struct.unpack_from("<H", image, 12)[0] != 5:
        raise RuntimeError("OTA 镜像芯片不是 ESP32-C3")
    offset = 24
    checksum = 0xEF
    for _ in range(image[1]):
        if offset + 8 > len(image):
            raise RuntimeError("OTA 镜像段头不完整")
        segment_size = struct.unpack_from("<I", image, offset + 4)[0]
        offset += 8
        if offset + segment_size > len(image):
            raise RuntimeError("OTA 镜像段数据不完整")
        for value in image[offset:offset + segment_size]:
            checksum ^= value
        offset += segment_size
    checksum_offset = (offset // 16) * 16 + 15
    if checksum_offset >= len(image) or image[checksum_offset] != checksum:
        raise RuntimeError("OTA 镜像校验和错误")
    if image[23] != 1:
        raise RuntimeError("OTA 镜像缺少 SHA-256 摘要")
    digest_offset = checksum_offset + 1
    if image[digest_offset:digest_offset + 32] != hashlib.sha256(image[:digest_offset]).digest():
        raise RuntimeError("OTA 镜像 SHA-256 摘要错误")
    print("OTA compatibility: ESP32-C3 app image, checksum and SHA-256 OK; upload firmware.bin only")
    marker = b"FISH_FW_VERSION="
    offset = image.find(marker)
    version = image[offset + len(marker):].split(b"\0", 1)[0].decode("ascii") if offset >= 0 else ""
    build_id = image[176:208].hex()
    if not version or build_id == "00" * 32:
        raise RuntimeError("OTA 镜像缺少版本或构建指纹")
    metadata = {"firmwareVersion": version, "firmwareBuildId": build_id, "sha256": hashlib.sha256(image).hexdigest(), "size": len(image)}
    image_path.with_suffix(".manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print("OTA version: " + version + "; build: " + build_id)


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", check_ota_image)
