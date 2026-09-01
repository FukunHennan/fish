#pragma once
#include <Arduino.h>
#include <WiFiUdp.h>
#include "DeviceConfig.h"
#include "MotionController.h"
#include "ControllerClient.h"

class DiscoveryResponder {
public:
    DiscoveryResponder(MotionController& motion, ControllerClient& controller): motion_(motion), controller_(controller) {}
    void begin(const DeviceConfig& config);
    void update();
private:
    void sendAnnouncement(uint32_t nowMs);
    void writePacket(const IPAddress& target, const String& payload);
    void probeController(uint32_t nowMs);
    bool probeControllerAt(const IPAddress& target);
    WiFiUDP udp_;
    MotionController& motion_;
    ControllerClient& controller_;
    DeviceConfig config_;
    bool started_ = false;
    uint32_t lastAnnouncement_ = 0;
    uint32_t lastProbe_ = 0;
    uint32_t probeOffset_ = 1;
    uint16_t nearProbeStep_ = 0;
    String nonce_;
};
