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
    void setTuning(float frequency, float amplitude);
    void setNeutralCenter(float center);
    void setMode(MotionMode mode);
    void setBias(float bias);
    void safeStop();
    MotionSnapshot snapshot() const;
    float angleAt(float phase) const;
private:
    MotionSnapshot value_;
    float neutralCenter_ = 90.0f;
};
