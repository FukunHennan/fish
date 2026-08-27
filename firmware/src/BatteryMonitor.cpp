#include "BatteryMonitor.h"

BatteryMonitor::BatteryMonitor(uint8_t pin, float dividerRatio, float emptyVoltage, float fullVoltage, uint32_t sampleIntervalMs)
    : pin_(pin), dividerRatio_(dividerRatio), emptyVoltage_(emptyVoltage), fullVoltage_(fullVoltage), sampleIntervalMs_(sampleIntervalMs) {}

void BatteryMonitor::begin() {
    pinMode(pin_, INPUT);
    analogReadResolution(12);
    analogSetPinAttenuation(pin_, ADC_11db);
    readyAtMs_ = millis() + 500;
}

void BatteryMonitor::update(uint32_t nowMs) {
    if (!reading_.valid && (int32_t)(nowMs - readyAtMs_) < 0) return;
    if (reading_.valid && nowMs - reading_.sampledAtMs < sampleIntervalMs_) return;
    constexpr uint8_t sampleCount = 32;
    uint32_t totalMillivolts = 0;
    for (uint8_t i = 0; i < sampleCount; ++i) {
        totalMillivolts += analogReadMilliVolts(pin_);
        delayMicroseconds(150);
    }
    const float pinVoltage = (float)totalMillivolts / (1000.0f * sampleCount);
    const float batteryVoltage = pinVoltage * dividerRatio_;
    const float span = fullVoltage_ - emptyVoltage_;
    float percent = span > 0.0f ? (batteryVoltage - emptyVoltage_) * 100.0f / span : 0.0f;
    if (percent < 0.0f) percent = 0.0f;
    if (percent > 100.0f) percent = 100.0f;
    reading_ = {batteryVoltage, (uint8_t)(percent + 0.5f), true, nowMs};
}
