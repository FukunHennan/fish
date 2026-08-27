#pragma once
#include <Arduino.h>

struct BatteryReading {
    float voltage;
    uint8_t percent;
    bool valid;
    uint32_t sampledAtMs;
};

class BatteryMonitor {
public:
    BatteryMonitor(uint8_t pin, float dividerRatio, float emptyVoltage, float fullVoltage, uint32_t sampleIntervalMs);
    void begin();
    void update(uint32_t nowMs);
    BatteryReading reading() const { return reading_; }
private:
    uint8_t pin_;
    float dividerRatio_;
    float emptyVoltage_;
    float fullVoltage_;
    uint32_t sampleIntervalMs_;
    uint32_t readyAtMs_ = 0;
    BatteryReading reading_{0.0f, 0, false, 0};
};
