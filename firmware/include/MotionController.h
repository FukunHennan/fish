#pragma once
#include <Arduino.h>
#include "FishServo.h"
#include "MotionState.h"

class MotionController {
public:
    MotionController(int pin, float frequency, float amplitude, float turnAmount);
    void begin();
    void update(uint32_t nowMs);
    void setNeutralCenter(float center);
    void setMode(MotionMode mode);
    void setTuning(float frequency, float amplitude);
    void setBias(float bias);
    void centerAtBias(float bias);
    void safeStop();
    MotionSnapshot snapshot() const;
private:
    int pin_;
    FishServo servo_;
    MotionState state_;
    uint32_t lastUpdate_ = 0;
    float phase_ = 0.0f;
    float outputAngle_ = 90.0f;
};
