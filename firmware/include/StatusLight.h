#pragma once

#include <Arduino.h>

enum class StatusLightMode {
    Provisioning,
    WifiConnecting,
    Discovering,
    Ready,
    ManualMotion,
    Ota,
    Error,
};

class StatusLight {
public:
    StatusLight(uint8_t pin, bool activeLow);
    void begin();
    void setMode(StatusLightMode mode);
    void update(uint32_t nowMs);

private:
    void write(bool on);

    uint8_t pin_;
    bool activeLow_;
    StatusLightMode mode_ = StatusLightMode::Provisioning;
    uint32_t modeStartedAt_ = 0;
    bool outputOn_ = false;
};
