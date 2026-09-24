#include "StatusLight.h"

namespace {
bool pulse(uint32_t elapsed, uint32_t period, uint32_t onMs) {
    return elapsed % period < onMs;
}
}

StatusLight::StatusLight(uint8_t pin, bool activeLow)
    : pin_(pin), activeLow_(activeLow) {}

void StatusLight::begin() {
    pinMode(pin_, OUTPUT);
    write(false);
}

void StatusLight::setMode(StatusLightMode mode) {
    if (mode_ == mode) return;
    mode_ = mode;
    modeStartedAt_ = millis();
    write(false);
}

void StatusLight::write(bool on) {
    if (on == outputOn_) return;
    outputOn_ = on;
    digitalWrite(pin_, on == activeLow_ ? LOW : HIGH);
}

void StatusLight::update(uint32_t nowMs) {
    const uint32_t elapsed = nowMs - modeStartedAt_;
    bool on = false;
    switch (mode_) {
        case StatusLightMode::Provisioning:
            on = pulse(elapsed, 1000, 500);
            break;
        case StatusLightMode::WifiConnecting:
            on = elapsed % 1000 < 120 || (elapsed % 1000 >= 240 && elapsed % 1000 < 360);
            break;
        case StatusLightMode::Discovering:
            on = pulse(elapsed, 300, 100);
            break;
        case StatusLightMode::Ready:
            on = true;
            break;
        case StatusLightMode::ManualMotion:
            on = elapsed % 1000 >= 80;
            break;
        case StatusLightMode::Ota:
            on = pulse(elapsed, 160, 80);
            break;
        case StatusLightMode::Error:
            on = elapsed % 1360 < 120 ||
                 (elapsed % 1360 >= 240 && elapsed % 1360 < 360) ||
                 (elapsed % 1360 >= 480 && elapsed % 1360 < 600);
            break;
    }
    write(on);
}
