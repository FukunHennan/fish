#pragma once
#include <Arduino.h>
#include "FishServo.h"
#include "MotionState.h"

class MotionController {
public:
    MotionController(int pin, float frequency, float amplitude, float turnAmount);
    void begin();
    void update(uint32_t nowMs);
    void setMode(MotionMode mode);
    bool setTuning(float frequency, float amplitude);
    bool setBias(float bias);
    bool centerAtBias(float bias);
    bool applyVisual(float frequency, float amplitude, float bias);
    void safeStop();
    MotionSnapshot snapshot() const;
private:
    int pin_;
    FishServo servo_;
    MotionState state_;
    uint32_t lastUpdate_ = 0;
    float phase_ = 0.0f;
};
