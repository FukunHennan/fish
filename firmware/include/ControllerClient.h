#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <mbedtls/sha256.h>

#include "BatteryMonitor.h"
#include "CommandProcessor.h"
#include "ConfigStore.h"
#include "DeviceConfig.h"
#include "StatusLight.h"

class ControllerClient {
public:
    ControllerClient(MotionController& motion, CommandProcessor& commands,
                     BatteryMonitor& battery,
                     StatusLight& statusLight, ConfigStore& configStore);
    void begin(const DeviceConfig& config);
    void setEndpoint(const IPAddress& host, uint16_t port);
    void clearEndpoint();
    bool endpointReady() const { return endpointReady_; }
    bool registered() const { return registered_; }
    bool otaActive() const;
    bool otaFailed() const;
    void update(uint32_t nowMs, bool networkConnected);

private:
    enum class OtaPhase : uint8_t { Idle, Downloading, Rebooting, Failed };

    void onEvent(WStype_t type, uint8_t* payload, size_t length);
    void handleCommand(JsonDocument& document);
    void sendRegistration(const String& nonce);
    void sendIdentity();
    void sendHeartbeat();
    void sendMotionState(bool force = false);
    void sendRGBState(bool force = false);
    void sendBatteryTelemetry(bool force = false);
    void sendLinkTelemetry(bool force = false);
    void sendOtaProgress();
    void sendResult(const String& requestId, bool success, const char* code, const String& message);
    void sendDocument(JsonDocument& document);
    void otaBegin(const String& requestId, const String& sha256, size_t expectedSize);
    void otaStep(uint32_t nowMs);
    void otaFail(const char* code, const String& message);
    void otaCancel();
    void cleanupOtaTransport(bool abortUpdate);
    String currentIdentitySignature() const;

    WebSocketsClient socket_;
    MotionController& motion_;
    CommandProcessor& commands_;
    BatteryMonitor& battery_;
    StatusLight& statusLight_;
    ConfigStore& configStore_;
    DeviceConfig config_;
    bool started_ = false;
    bool registered_ = false;
    bool endpointReady_ = false;
    IPAddress controllerIP_;
    uint32_t endpointAttemptAt_ = 0;
    uint32_t lastHeartbeat_ = 0;
    uint32_t lastHeartbeatReport_ = 0;
    uint32_t lastMotionStateReport_ = 0;
    uint32_t lastRGBStateReport_ = 0;
    uint32_t lastBatterySampleMs_ = 0;
    uint32_t lastLinkCheckMs_ = 0;
    uint32_t lastLinkReportMs_ = 0;
    uint32_t lastControlMs_ = 0;
    uint32_t motionDeadlineAt_ = 0;
    int lastQuantizedRSSI_ = 0;
    bool linkReported_ = false;
    String bootId_;
    String lastMotionSignature_;
    String lastRGBSignature_;
    String lastIdentitySignature_;
    String stopReason_ = "BOOT";
    String controlSource_;

    OtaPhase otaPhase_ = OtaPhase::Idle;
    HTTPClient otaHttp_;
    WiFiClient* otaStream_ = nullptr;
    mbedtls_sha256_context otaSha_;
    bool otaShaReady_ = false;
    bool otaUpdateStarted_ = false;
    size_t otaTotal_ = 0;
    size_t otaWritten_ = 0;
    uint32_t otaStartedAt_ = 0;
    uint32_t otaLastDataAt_ = 0;
    uint32_t otaRebootAt_ = 0;
    String otaExpectedHash_;
    String otaErrorCode_;
    String otaErrorMessage_;
    String otaState_ = "IDLE";
    uint8_t otaProgress_ = 0;
};
