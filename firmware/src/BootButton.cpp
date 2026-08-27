#include "BootButton.h"
#include "ControlTiming.h"

BootButton::BootButton(uint8_t pin, uint32_t longPressMs)
    : pin_(pin), longPressMs_(longPressMs) {}

void BootButton::begin() {
    pinMode(pin_, INPUT_PULLUP);
    rawPressed_ = digitalRead(pin_) == LOW;
    stablePressed_ = rawPressed_;
    pressedAt_ = millis();
}

bool BootButton::update(uint32_t nowMs) {
    const bool pressed = digitalRead(pin_) == LOW;
    if (pressed != rawPressed_) {
        rawPressed_ = pressed;
        rawChangedAt_ = nowMs;
    }

    if (rawPressed_ != stablePressed_ && hasElapsed(nowMs, rawChangedAt_, kDebounceMs)) {
        stablePressed_ = rawPressed_;
        triggered_ = false;
        if (stablePressed_) pressedAt_ = nowMs;
    }

    if (!stablePressed_ || triggered_ || !hasElapsed(nowMs, pressedAt_, longPressMs_)) return false;
    triggered_ = true;
    return true;
}
