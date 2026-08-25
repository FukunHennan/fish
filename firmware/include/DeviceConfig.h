#pragma once
#include <Arduino.h>

struct DeviceConfig {
    String ssid, password, controllerHost, displayName;
    uint16_t controllerPort = 8081;
    bool valid() const {
        return ssid.length() > 0 && ssid.length() <= 32 && password.length() <= 64;
    }
};
