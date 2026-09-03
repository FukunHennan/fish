#pragma once
#include <Arduino.h>

struct DeviceConfig {
    String ssid, password, controllerHost, displayName;
    uint16_t controllerPort = 8081;
    float servoCenter = 90.0f;
    bool valid() const {
        return ssid.length() > 0 && ssid.length() <= 32 && password.length() <= 64 &&
               servoCenter >= 0.0f && servoCenter <= 180.0f;
    }
};
