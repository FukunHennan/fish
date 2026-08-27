#include "AmbientLightMonitor.h"
#include "AppConfig.h"
#include <Wire.h>

namespace {
constexpr uint8_t kBLuxAddress = 0x4A;
constexpr uint8_t kBH1750Address = 0x23;
}

AmbientLightMonitor::AmbientLightMonitor(uint32_t sampleIntervalMs) : sampleIntervalMs_(sampleIntervalMs) {}

void AmbientLightMonitor::begin() {
    Wire.begin(SDA, SCL);
    Wire.setClock(100000);
}

void AmbientLightMonitor::scanBus() {
    reading_.addressCount = 0;
    for (uint8_t address = 1; address < 127; ++address) {
        Wire.beginTransmission(address);
        if (Wire.endTransmission() == 0 && reading_.addressCount < sizeof(reading_.addresses)) {
            reading_.addresses[reading_.addressCount++] = address;
        }
    }
    lastScanMs_ = millis();
}

bool AmbientLightMonitor::readBLux(float& lux) {
    Wire.beginTransmission(kBLuxAddress);
    Wire.write(0x00);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(kBLuxAddress, (uint8_t)4) != 4) return false;
    uint32_t raw = 0;
    raw |= (uint32_t)Wire.read();
    raw |= (uint32_t)Wire.read() << 8;
    raw |= (uint32_t)Wire.read() << 16;
    raw |= (uint32_t)Wire.read() << 24;
    lux = (float)raw * 1.4f / 1000.0f;
    return isfinite(lux) && lux >= 0.0f && lux <= 200000.0f;
}

bool AmbientLightMonitor::readBH1750(float& lux) {
    if (!bh1750Started_) {
        Wire.beginTransmission(kBH1750Address);
        Wire.write(0x01); // Power on.
        if (Wire.endTransmission() != 0) return false;
        Wire.beginTransmission(kBH1750Address);
        Wire.write(0x10); // Continuous high-resolution mode, 1 lx resolution.
        if (Wire.endTransmission() != 0) return false;
        bh1750Started_ = true;
        delay(180);
    }
    if (Wire.requestFrom(kBH1750Address, (uint8_t)2) != 2) return false;
    const uint16_t raw = ((uint16_t)Wire.read() << 8) | Wire.read();
    lux = (float)raw / 1.2f;
    return isfinite(lux) && lux >= 0.0f && lux <= 65535.0f;
}

void AmbientLightMonitor::update(uint32_t nowMs) {
    if (reading_.sampledAtMs != 0 && nowMs - reading_.sampledAtMs < sampleIntervalMs_) return;
    if (reading_.addressCount == 0 && (lastScanMs_ == 0 || nowMs - lastScanMs_ >= AMBIENT_LIGHT_RESCAN_INTERVAL_MS)) scanBus();
    float lux = 0.0f;
    reading_.online = readBH1750(lux) || readBLux(lux);
    if (reading_.online) reading_.lux = lux;
    else if (nowMs - lastScanMs_ >= AMBIENT_LIGHT_RESCAN_INTERVAL_MS) scanBus();
    reading_.sampledAtMs = nowMs;
}
