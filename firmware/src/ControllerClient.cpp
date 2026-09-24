#include "ControllerClient.h"

#include "AppConfig.h"
#include "AuthProtocol.h"
#include "ControlTiming.h"
#include "DeviceIdentity.h"

#include <Preferences.h>
#include <Update.h>
#include <WiFi.h>
#include <esp_system.h>

namespace {
constexpr uint32_t kHeartbeatIntervalMs = 1000;
constexpr uint32_t kStateResyncIntervalMs = 30000;
constexpr uint32_t kLinkSampleIntervalMs = 5000;
constexpr uint32_t kLinkResyncIntervalMs = 30000;
constexpr uint32_t kOtaIdleTimeoutMs = 5000;
constexpr uint32_t kOtaTotalTimeoutMs = 120000;
constexpr size_t kOtaChunkSize = 2048;

const char* motionModeName(MotionMode mode) {
    switch (mode) {
        case MotionMode::Stopped: return "stopped";
        case MotionMode::Idle: return "idle";
        case MotionMode::Forward: return "forward";
        case MotionMode::Left: return "left";
        case MotionMode::Right: return "right";
    }
    return "stopped";
}
}

ControllerClient::ControllerClient(MotionController& motion, CommandProcessor& commands,
                                   BatteryMonitor& battery,
                                   StatusLight& statusLight, ConfigStore& configStore)
    : motion_(motion), commands_(commands), battery_(battery),
      statusLight_(statusLight), configStore_(configStore) {}

bool ControllerClient::otaActive() const {
    return otaPhase_ == OtaPhase::Downloading || otaPhase_ == OtaPhase::Rebooting;
}

bool ControllerClient::otaFailed() const { return otaPhase_ == OtaPhase::Failed; }

void ControllerClient::begin(const DeviceConfig& config) {
    config_ = config;
    motion_.setNeutralCenter(config_.servoCenter);
    char boot[9];
    snprintf(boot, sizeof(boot), "%08lx", static_cast<unsigned long>(esp_random()));
    bootId_ = boot;
    socket_.onEvent([this](WStype_t type, uint8_t* payload, size_t length) {
        onEvent(type, payload, length);
    });
    socket_.setReconnectInterval(700);
    endpointReady_ = false;
    started_ = false;
    registered_ = false;

    Preferences cache;
    if (cache.begin("fish-endpoint", true)) {
        String host = cache.getString("ip", "");
        uint16_t port = cache.getUShort("port", 8081);
        cache.end();
        IPAddress ip;
        if (ip.fromString(host) && port) setEndpoint(ip, port);
    }
}

void ControllerClient::clearEndpoint() {
    endpointReady_ = false;
    started_ = false;
    registered_ = false;
}

void ControllerClient::setEndpoint(const IPAddress& host, uint16_t port) {
    if (endpointReady_ && controllerIP_ == host && config_.controllerPort == port) return;
    if (started_) socket_.disconnect();
    controllerIP_ = host;
    config_.controllerPort = port;
    endpointReady_ = true;
    started_ = false;
    registered_ = false;
    endpointAttemptAt_ = millis();
}

void ControllerClient::sendDocument(JsonDocument& document) {
    String output;
    serializeJson(document, output);
    socket_.sendTXT(output);
}

String ControllerClient::currentIdentitySignature() const {
    String signature = WiFi.localIP().toString() + "|" + FIRMWARE_VERSION + "|" +
                       String(config_.servoCenter, 2) + "|servo:2|battery:4|divider:2|";
    return signature;
}

static void appendHardwareInventory(JsonDocument& document) {
    document["servoPin"] = SERVO_PIN;
    document["batterySensePin"] = BATTERY_SENSE_PIN;
    document["batteryDividerRatio"] = BATTERY_DIVIDER_RATIO;
    document["batteryEmptyVoltage"] = BATTERY_EMPTY_VOLTAGE;
    document["batteryFullVoltage"] = BATTERY_FULL_VOLTAGE;
    JsonArray sensors = document["sensors"].to<JsonArray>();
    sensors.add("battery_adc");
}

void ControllerClient::sendRegistration(const String& nonce) {
    JsonDocument document;
    char mac[18];
    char proof[65];
    formatDeviceMac(mac);
    if (!computeIdentityProof("fish-websocket-v2", nonce.c_str(), proof)) return;
    document["type"] = "register";
    document["protocolVersion"] = 2;
    document["deviceId"] = mac;
    document["proof"] = proof;
    document["bootId"] = bootId_;
    document["name"] = config_.displayName;
    document["firmwareVersion"] = FIRMWARE_VERSION;
    document["ip"] = WiFi.localIP().toString();
    document["servoCenter"] = config_.servoCenter;
    appendHardwareInventory(document);
    JsonArray capabilities = document["capabilities"].to<JsonArray>();
    capabilities.add("motion");
    capabilities.add("ota");
    capabilities.add("battery");
    lastIdentitySignature_ = currentIdentitySignature();
    sendDocument(document);
}

void ControllerClient::sendIdentity() {
    JsonDocument document;
    document["type"] = "identity";
    document["ip"] = WiFi.localIP().toString();
    document["firmwareVersion"] = FIRMWARE_VERSION;
    document["servoCenter"] = config_.servoCenter;
    appendHardwareInventory(document);
    lastIdentitySignature_ = currentIdentitySignature();
    sendDocument(document);
}

void ControllerClient::sendHeartbeat() {
    JsonDocument document;
    document["type"] = "heartbeat";
    document["uptimeMs"] = millis();
    document["lastControlMs"] = lastControlMs_;
    sendDocument(document);
}

void ControllerClient::sendMotionState(bool force) {
    MotionSnapshot state = motion_.snapshot();
    String signature = String(motionModeName(state.mode)) + "|" + String(state.frequency, 3) +
                       "|" + String(state.amplitude, 3) + "|" + String(state.bias, 3) +
                       "|" + controlSource_ + "|" + stopReason_;
    uint32_t now = millis();
    if (!force && signature == lastMotionSignature_ &&
        !hasElapsed(now, lastMotionStateReport_, kStateResyncIntervalMs)) return;
    JsonDocument document;
    document["type"] = "motion.state";
    document["mode"] = motionModeName(state.mode);
    document["frequency"] = state.frequency;
    document["amplitude"] = state.amplitude;
    document["bias"] = state.bias;
    document["controlSource"] = controlSource_;
    document["stopReason"] = stopReason_;
    lastMotionSignature_ = signature;
    lastMotionStateReport_ = now;
    sendDocument(document);
}

void ControllerClient::sendBatteryTelemetry(bool force) {
    BatteryReading battery = battery_.reading();
    if (!battery.valid) return;
    if (!force && battery.sampledAtMs == lastBatterySampleMs_) return;
    JsonDocument document;
    document["type"] = "telemetry.battery";
    document["batteryVoltage"] = roundf(battery.voltage * 100.0f) / 100.0f;
    document["batteryPercent"] = battery.percent;
    lastBatterySampleMs_ = battery.sampledAtMs;
    sendDocument(document);
}

void ControllerClient::sendLinkTelemetry(bool force) {
    uint32_t now = millis();
    int quantized = (WiFi.RSSI() / 2) * 2;
    if (!force && linkReported_ && quantized == lastQuantizedRSSI_ &&
        !hasElapsed(now, lastLinkReportMs_, kLinkResyncIntervalMs)) return;
    JsonDocument document;
    document["type"] = "telemetry.link";
    document["rssi"] = quantized;
    lastQuantizedRSSI_ = quantized;
    lastLinkReportMs_ = now;
    linkReported_ = true;
    sendDocument(document);
}

void ControllerClient::sendOtaProgress() {
    JsonDocument document;
    document["type"] = "ota.progress";
    document["otaState"] = otaState_;
    document["otaProgress"] = otaProgress_;
    if (otaTotal_ > 0) {
        document["written"] = otaWritten_;
        document["total"] = otaTotal_;
    }
    if (otaErrorCode_.length()) document["code"] = otaErrorCode_;
    if (otaErrorMessage_.length()) document["message"] = otaErrorMessage_;
    sendDocument(document);
}

void ControllerClient::sendResult(const String& requestId, bool success,
                                  const char* code, const String& message) {
	if (!requestId.length()) return;
    JsonDocument document;
    document["type"] = "command.result";
    document["requestId"] = requestId;
    document["success"] = success;
    document["code"] = code;
    document["message"] = message;
    sendDocument(document);
}

void ControllerClient::cleanupOtaTransport(bool abortUpdate) {
    if (otaShaReady_) {
        mbedtls_sha256_free(&otaSha_);
        otaShaReady_ = false;
    }
    if (abortUpdate && otaUpdateStarted_) Update.abort();
    otaUpdateStarted_ = false;
    otaHttp_.end();
    otaStream_ = nullptr;
}

void ControllerClient::otaFail(const char* code, const String& message) {
    cleanupOtaTransport(true);
    otaPhase_ = OtaPhase::Failed;
    otaState_ = "FAILED";
    otaErrorCode_ = code;
    otaErrorMessage_ = message;
    sendOtaProgress();
}

void ControllerClient::otaBegin(const String& requestId, const String& expectedHash,
                                size_t expectedSize) {
    motion_.safeStop();
    motionDeadlineAt_ = 0;
    controlSource_ = "";
    stopReason_ = "OTA_REQUEST";
    sendMotionState();
    otaState_ = "DOWNLOADING";
    otaProgress_ = 0;
    otaWritten_ = 0;
    otaTotal_ = 0;
    otaErrorCode_ = "";
    otaErrorMessage_ = "";
    otaExpectedHash_ = expectedHash;
	otaPhase_ = OtaPhase::Downloading;
	sendResult(requestId, true, "OTA_STARTED", "固件升级已开始");
	sendOtaProgress();

    otaHttp_.setConnectTimeout(5000);
    otaHttp_.setTimeout(5000);
    String url = "http://" + controllerIP_.toString() + ":" +
                 String(config_.controllerPort) + "/api/firmware/current.bin";
    if (!otaHttp_.begin(url) || otaHttp_.GET() != HTTP_CODE_OK) {
        otaFail("OTA_DOWNLOAD_FAILED", "无法下载固件");
        return;
    }
    int total = otaHttp_.getSize();
    if (total <= 0 || (expectedSize > 0 && static_cast<size_t>(total) != expectedSize)) {
        otaFail("OTA_SIZE_MISMATCH", "固件大小不匹配");
        return;
    }
    if (!Update.begin(static_cast<size_t>(total))) {
        otaFail("OTA_NO_SPACE", "OTA 分区空间不足");
        return;
    }
    otaUpdateStarted_ = true;
    mbedtls_sha256_init(&otaSha_);
    mbedtls_sha256_starts_ret(&otaSha_, 0);
    otaShaReady_ = true;
    otaStream_ = otaHttp_.getStreamPtr();
    otaTotal_ = static_cast<size_t>(total);
    otaStartedAt_ = otaLastDataAt_ = millis();
}

void ControllerClient::otaStep(uint32_t nowMs) {
    if (otaPhase_ != OtaPhase::Downloading) return;
    if (hasElapsed(nowMs, otaLastDataAt_, kOtaIdleTimeoutMs) ||
        hasElapsed(nowMs, otaStartedAt_, kOtaTotalTimeoutMs)) {
        otaFail("OTA_DOWNLOAD_TIMEOUT", "固件下载超时，请检查网络后重试");
        return;
    }
    if (!otaStream_) {
        otaFail("OTA_DOWNLOAD_FAILED", "固件下载连接不可用");
        return;
    }
    size_t available = otaStream_->available();
    if (available > 0 && otaWritten_ < otaTotal_) {
        uint8_t buffer[kOtaChunkSize];
        size_t wanted = min(available, min(sizeof(buffer), otaTotal_ - otaWritten_));
        int count = otaStream_->read(buffer, wanted);
        if (count <= 0) {
            otaFail("OTA_DOWNLOAD_FAILED", "固件读取失败");
            return;
        }
        mbedtls_sha256_update_ret(&otaSha_, buffer, count);
        if (Update.write(buffer, count) != static_cast<size_t>(count)) {
            otaFail("OTA_INSTALL_FAILED", "固件写入失败");
            return;
        }
        otaWritten_ += static_cast<size_t>(count);
        otaLastDataAt_ = nowMs;
        uint8_t progress = static_cast<uint8_t>(min(static_cast<size_t>(99),
            (otaWritten_ * 100) / otaTotal_));
        if (progress != otaProgress_) {
            otaProgress_ = progress;
            sendOtaProgress();
        }
    }
    if (otaWritten_ < otaTotal_) return;

    unsigned char digest[32];
    mbedtls_sha256_finish_ret(&otaSha_, digest);
    mbedtls_sha256_free(&otaSha_);
    otaShaReady_ = false;
    char actual[65];
    for (size_t i = 0; i < 32; ++i) snprintf(actual + i * 2, 3, "%02x", digest[i]);
    actual[64] = '\0';
    otaHttp_.end();
    otaStream_ = nullptr;
    if (!otaExpectedHash_.equalsIgnoreCase(actual)) {
        otaFail("OTA_HASH_MISMATCH", "固件校验失败");
        return;
    }
    if (!Update.end(true)) {
        String error = Update.errorString();
        otaUpdateStarted_ = false;
        otaFail("OTA_INSTALL_FAILED", error);
        return;
    }
    otaUpdateStarted_ = false;
    otaProgress_ = 100;
    otaState_ = "REBOOTING";
    otaPhase_ = OtaPhase::Rebooting;
    otaRebootAt_ = nowMs;
    sendOtaProgress();
}

void ControllerClient::otaCancel() {
    cleanupOtaTransport(true);
    otaPhase_ = OtaPhase::Idle;
    otaState_ = "IDLE";
    otaProgress_ = 0;
    otaWritten_ = 0;
    otaTotal_ = 0;
    otaErrorCode_ = "";
    otaErrorMessage_ = "";
    sendOtaProgress();
}

void ControllerClient::handleCommand(JsonDocument& document) {
    const bool ackRequired = document["ackRequired"] | true;
    String requestId = document["requestId"] | "";
    String command = document["command"] | "";
    if (!requestId.length() && ackRequired) {
        return;
    }
    if (otaActive() && command != "emergency.stop" && command != "ota.cancel") {
        sendResult(requestId, false, "OTA_BUSY", "固件升级期间仅允许急停或取消升级");
        return;
    }
    if (command == "emergency.stop") {
        motion_.safeStop();
        motionDeadlineAt_ = 0;
        controlSource_ = "";
        stopReason_ = "EMERGENCY_STOP";
        lastControlMs_ = millis();
        sendMotionState();
        sendResult(requestId, true, "OK", "紧急停止已执行");
        return;
    }
    if (command == "motion.set") {
        JsonObject payload = document["payload"].as<JsonObject>();
        MotionSnapshot current = motion_.snapshot();
        float frequency = payload["frequency"] | current.frequency;
        float amplitude = payload["amplitude"] | current.amplitude;
        bool hasBias = !payload["bias"].isNull();
        float bias = payload["bias"] | current.bias;
        uint32_t deadmanMs = payload["deadmanMs"] | 0U;
        uint32_t transitionMs = payload["transitionMs"] | 600U;
        if (deadmanMs > 0 && (deadmanMs < 150 || deadmanMs > 2000)) {
            sendResult(requestId, false, "INVALID_DEADMAN", "运动续帧时限无效");
            return;
        }
        if (transitionMs < 100 || transitionMs > 1500) {
            sendResult(requestId, false, "INVALID_TRANSITION", "运动过渡时间无效");
            return;
        }
        String mode = payload["mode"] | "stop";
        mode.toUpperCase();
        controlSource_ = payload["controlSource"] | "manual";
        if (mode == "STOP") controlSource_ = "";
        if (mode == "CENTER") {
            motion_.centerAtBias(bias);
            motionDeadlineAt_ = 0;
            config_.servoCenter = 90.0f + bias;
            lastControlMs_ = millis();
            stopReason_ = "CALIBRATION_CENTER";
            if (!configStore_.save(config_)) {
                sendMotionState();
                sendIdentity();
                sendResult(requestId, false, "CONFIG_SAVE_FAILED", "舵机中位已应用，但保存失败");
                return;
            }
            sendMotionState();
            sendIdentity();
            sendResult(requestId, true, "OK", "Servo centered");
            return;
        }
        if (mode == "STOP") {
            motion_.safeStop();
            motionDeadlineAt_ = 0;
            lastControlMs_ = millis();
            stopReason_ = "MANUAL_STOP";
            sendMotionState();
            sendResult(requestId, true, "OK", "停止已执行");
            return;
        }
        motion_.setTransitionMs(transitionMs);
        motion_.setTuning(frequency, amplitude);
        String result = commands_.process(mode == "FORWARD" ? "FWD" : mode);
        if (result == "OK") {
            motion_.setBias(hasBias ? bias : 0.0f);
            motionDeadlineAt_ = deadmanMs > 0 ? millis() + deadmanMs : 0;
        }
        lastControlMs_ = millis();
        stopReason_ = "";
        sendMotionState();
        sendResult(requestId, result == "OK", result == "OK" ? "OK" : "UNKNOWN_COMMAND", result);
        return;
    }
    if (command == "rgb.set") {
        sendResult(requestId, false, "UNSUPPORTED_HARDWARE", "设备未安装 RGB 灯");
        return;
    }
    if (command == "ota.start") {
        String hash = document["payload"]["sha256"] | "";
        size_t size = document["payload"]["size"] | 0U;
        if (hash.length() != 64 || size == 0) {
            sendResult(requestId, false, "INVALID_FIRMWARE", "固件信息无效");
            return;
        }
        String requestedName = document["payload"]["name"] | "";
        requestedName.trim();
        if (requestedName.length() > 0 && requestedName != config_.displayName) {
            config_.displayName = requestedName;
            if (!configStore_.save(config_)) {
                sendResult(requestId, false, "CONFIG_SAVE_FAILED", "设备名称保存失败");
                return;
            }
        }
        otaBegin(requestId, hash, size);
        return;
    }
    if (command == "ota.cancel") {
        otaCancel();
        sendResult(requestId, true, "OK", "固件升级已取消");
        return;
    }
    sendResult(requestId, false, "UNKNOWN_COMMAND", "未知命令");
}

void ControllerClient::onEvent(WStype_t type, uint8_t* payload, size_t length) {
    if (type == WStype_CONNECTED) {
        registered_ = false;
        return;
    }
    if (type == WStype_DISCONNECTED) {
        registered_ = false;
        motion_.safeStop();
        motionDeadlineAt_ = 0;
        controlSource_ = "";
        stopReason_ = "CONTROLLER_DISCONNECTED";
        return;
    }
    if (type == WStype_PONG) {
        // The controller sends a WebSocket ping every second. Transport-level
        // pong proves the connection is alive even when application messages
        // are briefly queued behind a burst of motion frames.
        lastHeartbeat_ = millis();
        return;
    }
    if (type != WStype_TEXT) return;
    JsonDocument document;
    if (deserializeJson(document, payload, length)) return;
    String messageType = document["type"] | "";
    String nonce;
    if (readAuthChallenge(document, nonce)) {
        sendRegistration(nonce);
        return;
    }
    if (messageType == "register.result" && static_cast<bool>(document["success"] | false)) {
        registered_ = true;
        lastHeartbeat_ = millis();
        endpointAttemptAt_ = lastHeartbeat_;
        Preferences cache;
        if (cache.begin("fish-endpoint", false)) {
            String host = controllerIP_.toString();
            if (cache.getString("ip", "") != host ||
                cache.getUShort("port", 0) != config_.controllerPort) {
                cache.putString("ip", host);
                cache.putUShort("port", config_.controllerPort);
            }
            cache.end();
        }
        sendMotionState(true);
        sendBatteryTelemetry(true);
        sendLinkTelemetry(true);
        if (otaState_ != "IDLE") sendOtaProgress();
        Serial.printf("[Controller] registered at %lu ms: %s:%u\n",
                      static_cast<unsigned long>(millis()),
                      controllerIP_.toString().c_str(), config_.controllerPort);
        return;
    }
    if (!registered_) return;
    if (messageType == "heartbeat") {
        lastHeartbeat_ = millis();
        return;
    }
    if (messageType == "command") handleCommand(document);
}

void ControllerClient::update(uint32_t nowMs, bool online) {
    if (!online) {
        if (started_) socket_.disconnect();
        started_ = false;
        registered_ = false;
        endpointAttemptAt_ = nowMs;
        if (motion_.snapshot().mode != MotionMode::Stopped) motion_.safeStop();
        motionDeadlineAt_ = 0;
        return;
    }
    if (!endpointReady_) return;
    if (!registered_ && !otaActive() &&
        hasElapsed(nowMs, endpointAttemptAt_, CONTROLLER_ENDPOINT_REGISTRATION_TIMEOUT_MS)) {
        socket_.disconnect();
        clearEndpoint();
        return;
    }
    if (!started_) {
        socket_.begin(controllerIP_.toString().c_str(), config_.controllerPort, "/ws/device");
        started_ = true;
    }
    socket_.loop();
    if (otaPhase_ == OtaPhase::Downloading) otaStep(nowMs);
    if (otaPhase_ == OtaPhase::Rebooting && hasElapsed(nowMs, otaRebootAt_, 300)) ESP.restart();
    if (registered_ && hasElapsed(nowMs, lastHeartbeat_, CONTROLLER_HEARTBEAT_TIMEOUT_MS)) {
        registered_ = false;
        motion_.safeStop();
        motionDeadlineAt_ = 0;
        controlSource_ = "";
        stopReason_ = "CONTROLLER_TIMEOUT";
        socket_.disconnect();
        return;
    }
    if (!registered_) return;
    if (motionDeadlineAt_ != 0 && (int32_t)(nowMs - motionDeadlineAt_) >= 0) {
        motionDeadlineAt_ = 0;
        MotionMode mode = motion_.snapshot().mode;
        if (mode != MotionMode::Stopped && mode != MotionMode::Idle) {
            motion_.safeStop();
            controlSource_ = "";
            stopReason_ = "COMMAND_TIMEOUT";
            sendMotionState();
        }
    }
    if (hasElapsed(nowMs, lastHeartbeatReport_, kHeartbeatIntervalMs)) {
        lastHeartbeatReport_ = nowMs;
        sendHeartbeat();
    }
    if (hasElapsed(nowMs, lastMotionStateReport_, kStateResyncIntervalMs)) sendMotionState();
    if (!otaActive()) {
        sendBatteryTelemetry();
        if (hasElapsed(nowMs, lastLinkCheckMs_, kLinkSampleIntervalMs)) {
            lastLinkCheckMs_ = nowMs;
            sendLinkTelemetry();
        }
        String identity = currentIdentitySignature();
        if (identity != lastIdentitySignature_) sendIdentity();
    }
}
