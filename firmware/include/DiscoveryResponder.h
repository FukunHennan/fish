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
    WiFiUDP udp_;
    MotionController& motion_;
    ControllerClient& controller_;
    DeviceConfig config_;
    bool started_ = false;
    uint32_t lastAnnouncement_ = 0;
    String nonce_;
};
