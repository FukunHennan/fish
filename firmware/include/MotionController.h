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
    void setTransitionMs(uint32_t transitionMs);
    void centerAtBias(float bias);
    void safeStop();
    MotionSnapshot snapshot() const;
private:
    void engageServo();
    void writeTarget(float angle);
    void syncTransitionTarget();
    int pin_;
    FishServo servo_;
    MotionState state_;
    MotionTransition transition_;
    uint32_t lastUpdate_ = 0;
    uint32_t releaseServoAt_ = 0;
    float phase_ = 0.0f;
    float outputAngle_ = 90.0f;
    int lastWrittenAngle_ = -1;
    uint32_t transitionMs_ = 600;
    static constexpr uint32_t kStopHoldMs = 350;
};
