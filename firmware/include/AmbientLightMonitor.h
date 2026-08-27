#pragma once
#include <Arduino.h>

struct AmbientLightReading {
    bool online;
    float lux;
    uint32_t sampledAtMs;
    uint8_t addresses[8];
    uint8_t addressCount;
};

class AmbientLightMonitor {
public:
    explicit AmbientLightMonitor(uint32_t sampleIntervalMs);
    void begin();
    void update(uint32_t nowMs);
    AmbientLightReading reading() const { return reading_; }
private:
    bool readBLux(float& lux);
    bool readBH1750(float& lux);
    void scanBus();
    uint32_t sampleIntervalMs_;
    uint32_t lastScanMs_ = 0;
    AmbientLightReading reading_{false, 0.0f, 0, {0}, 0};
    bool bh1750Started_ = false;
};
