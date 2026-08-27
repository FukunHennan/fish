#pragma once

#include <Arduino.h>

class BootButton {
public:
    BootButton(uint8_t pin, uint32_t longPressMs);
    void begin();
    bool update(uint32_t nowMs);

private:
    static constexpr uint32_t kDebounceMs = 30;

    uint8_t pin_;
    uint32_t longPressMs_;
    uint32_t rawChangedAt_ = 0;
    uint32_t pressedAt_ = 0;
    bool rawPressed_ = false;
    bool stablePressed_ = false;
    bool triggered_ = false;
};
