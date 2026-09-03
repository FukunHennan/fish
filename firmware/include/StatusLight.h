#pragma once

#include <Adafruit_NeoPixel.h>
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
    StatusLight(uint8_t pin, uint16_t count, uint8_t brightness);
    void begin();
    void setMode(StatusLightMode mode);
    void setManualColor(uint8_t red, uint8_t green, uint8_t blue, uint8_t brightness);
    bool setColorOrder(const String& order);
    void clearManual(uint8_t brightness);
    bool manual() const { return manual_; }
    uint8_t red() const { return red_; }
    uint8_t green() const { return green_; }
    uint8_t blue() const { return blue_; }
    uint8_t brightness() const { return brightness_; }
    const String& colorOrder() const { return colorOrder_; }
    void update(uint32_t nowMs);

private:
    void showSolid(uint8_t red, uint8_t green, uint8_t blue, bool enabled);
    void showChase(uint8_t red, uint8_t green, uint8_t blue);

    Adafruit_NeoPixel pixels_;
    StatusLightMode mode_ = StatusLightMode::Provisioning;
    uint32_t lastUpdateMs_ = 0;
    uint16_t chaseIndex_ = 0;
    bool blinkOn_ = false;
    bool manual_ = false;
    uint8_t red_ = 0, green_ = 0, blue_ = 0, brightness_ = 0;
    String colorOrder_ = "GRB";
};
