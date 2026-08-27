#pragma once
#include <Arduino.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "CommandProcessor.h"
#include "DeviceConfig.h"
#include "VisualController.h"
#include "BatteryMonitor.h"
#include "AmbientLightMonitor.h"
#include "StatusLight.h"

class ControllerClient {
public:
    ControllerClient(MotionController& motion, CommandProcessor& commands, VisualController& visual, BatteryMonitor& battery, AmbientLightMonitor& ambientLight, StatusLight& statusLight);
    void begin(const DeviceConfig& config);
    void setEndpoint(const IPAddress& host, uint16_t port);
    bool endpointReady() const { return endpointReady_; }
    bool registered() const { return registered_; }
    void update(uint32_t nowMs, bool networkConnected);
private:
    void onEvent(WStype_t type, uint8_t* payload, size_t length);
    void sendRegistration(const String& nonce);
    void sendState(const char* type="state");
    void sendResult(const String& requestId, bool success, const char* code, const String& message);
    void handleCommand(JsonDocument& document);
    void runOta(const String& requestId, const String& sha256, size_t expectedSize);
    WebSocketsClient socket_;
    MotionController& motion_;
    CommandProcessor& commands_;
    VisualController& visual_;
    BatteryMonitor& battery_;
    AmbientLightMonitor& ambientLight_;
    StatusLight& statusLight_;
    DeviceConfig config_;
    bool started_=false,registered_=false;
    bool endpointReady_=false;
    IPAddress controllerIP_;
    uint32_t lastHeartbeat_=0,lastReport_=0;
    uint32_t lastControlMs_=0;
    uint32_t calibrationStopAtMs_=0;
    String stopReason_="BOOT";
    String otaState_="IDLE";
};
