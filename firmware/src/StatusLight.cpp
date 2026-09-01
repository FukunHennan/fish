#include "StatusLight.h"
#include "AppConfig.h"

namespace {
constexpr uint32_t kBlinkIntervalMs = 500;
constexpr uint32_t kConnectBlinkIntervalMs = 700;
constexpr uint32_t kDiscoveryIntervalMs = 180;
constexpr uint32_t kVisionIntervalMs = 130;
constexpr uint32_t kOtaIntervalMs = 90;
constexpr uint32_t kErrorBlinkIntervalMs = 140;
uint8_t scaleChannel(uint8_t value, uint8_t brightness) {
    return (uint8_t)(((uint16_t)value * brightness + 127U) / 255U);
}
}

StatusLight::StatusLight(uint8_t pin, uint16_t count, uint8_t brightness)
    : pixels_(count, pin, NEO_GRB + NEO_KHZ800) {
    brightness_ = brightness;
    // Keep the library at full scale. Dynamic setBrightness() rescales its
    // existing byte buffer and repeated changes cause channel-ratio drift.
    pixels_.setBrightness(255);
}

bool StatusLight::setColorOrder(const String& requested) {
    String order=requested;order.toUpperCase();neoPixelType type;
    if(order=="RGB")type=NEO_RGB;else if(order=="RBG")type=NEO_RBG;else if(order=="GRB")type=NEO_GRB;
    else if(order=="GBR")type=NEO_GBR;else if(order=="BRG")type=NEO_BRG;else if(order=="BGR")type=NEO_BGR;else return false;
    colorOrder_=order;pixels_.updateType(type+NEO_KHZ800);
    if(manual_)showSolid(red_,green_,blue_,true);else lastUpdateMs_=0;
    return true;
}

void StatusLight::begin() {
    pixels_.begin();
    pixels_.clear();
    pixels_.show();
}

void StatusLight::setMode(StatusLightMode mode) {
    if (mode_ == mode) return;
    mode_ = mode;
    lastUpdateMs_ = 0;
    blinkOn_ = false;
    chaseIndex_ = 0;
    pixels_.clear();
    pixels_.show();
}

void StatusLight::setManualColor(uint8_t red, uint8_t green, uint8_t blue, uint8_t brightness) {
    manual_ = true; red_ = red; green_ = green; blue_ = blue; brightness_ = brightness;
    showSolid(red_, green_, blue_, true);
}

void StatusLight::clearManual(uint8_t brightness) {
    manual_ = false;
    brightness_ = brightness;
    lastUpdateMs_ = 0;
}

void StatusLight::showSolid(uint8_t red, uint8_t green, uint8_t blue, bool enabled) {
    const uint32_t color = enabled ? pixels_.Color(scaleChannel(red, brightness_), scaleChannel(green, brightness_), scaleChannel(blue, brightness_)) : 0;
    for (uint16_t i = 0; i < pixels_.numPixels(); ++i) pixels_.setPixelColor(i, color);
    pixels_.show();
}

void StatusLight::showChase(uint8_t red, uint8_t green, uint8_t blue) {
    pixels_.clear();
    if (pixels_.numPixels() > 0) {
        pixels_.setPixelColor(
            chaseIndex_ % pixels_.numPixels(),
            pixels_.Color(
                scaleChannel(red, brightness_),
                scaleChannel(green, brightness_),
                scaleChannel(blue, brightness_)
            )
        );
        chaseIndex_ = (chaseIndex_ + 1) % pixels_.numPixels();
    }
    pixels_.show();
}

void StatusLight::update(uint32_t nowMs) {
    if (manual_) return;
    uint32_t interval = kBlinkIntervalMs;
    if (mode_ == StatusLightMode::WifiConnecting) interval = kConnectBlinkIntervalMs;
    else if (mode_ == StatusLightMode::Discovering) interval = kDiscoveryIntervalMs;
    else if (mode_ == StatusLightMode::VisionControl) interval = kVisionIntervalMs;
    else if (mode_ == StatusLightMode::Ota) interval = kOtaIntervalMs;
    else if (mode_ == StatusLightMode::Error) interval = kErrorBlinkIntervalMs;
    if (lastUpdateMs_ != 0 && nowMs - lastUpdateMs_ < interval) return;
    lastUpdateMs_ = nowMs;

    switch (mode_) {
        case StatusLightMode::Provisioning:
            blinkOn_ = !blinkOn_;
            showSolid(255, 0, 0, blinkOn_);
            break;
        case StatusLightMode::WifiConnecting:
            blinkOn_ = !blinkOn_;
            showSolid(0, 80, 255, blinkOn_);
            break;
        case StatusLightMode::Discovering:
            showChase(255, 120, 0);
            break;
        case StatusLightMode::Ready:
            showSolid(0, 220, 40, true);
            break;
        case StatusLightMode::ManualMotion:
            showSolid(0, 90, 255, true);
            break;
        case StatusLightMode::VisionControl:
            showChase(0, 220, 220);
            break;
        case StatusLightMode::Ota:
            showChase(180, 0, 255);
            break;
        case StatusLightMode::Error:
            blinkOn_ = !blinkOn_;
            showSolid(255, 0, 0, blinkOn_);
            break;
    }
}
