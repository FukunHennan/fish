#pragma once

enum class MotionMode { Stopped, Idle, Forward, Left, Right };

struct MotionSnapshot {
    MotionMode mode;
    float frequency;
    float amplitude;
    float bias;
};

class MotionState {
public:
    MotionState(float frequency, float amplitude, float turnAmount);
    bool setTuning(float frequency, float amplitude);
    void setMode(MotionMode mode);
    bool setBias(float bias);
    void safeStop();
    MotionSnapshot snapshot() const;
    float angleAt(float phase) const;
private:
    MotionSnapshot value_;
    float turnAmount_;
    bool customBias_ = false;
};
