#pragma once
#include <stdint.h>

enum class MotionMode { Stopped, Idle, Forward, Left, Right };

struct MotionSnapshot {
    MotionMode mode;
    float frequency;
    float amplitude;
    float bias;
};

class MotionTransition {
public:
    void reset(float amplitude, float bias);
    void setTarget(float amplitude, float bias, uint32_t durationMs);
    void update(float dtSeconds);
    float amplitude() const { return amplitude_; }
    float bias() const { return bias_; }
    bool settled() const;
private:
    static float moveToward(float current, float target, float maximumDelta);
    float amplitude_ = 0.0f;
    float bias_ = 0.0f;
    float targetAmplitude_ = 0.0f;
    float targetBias_ = 0.0f;
    float amplitudeRate_ = 0.0f;
    float biasRate_ = 0.0f;
    uint32_t durationMs_ = 0;
};

class MotionState {
public:
    MotionState(float frequency, float amplitude, float turnAmount);
    void setTuning(float frequency, float amplitude);
    void setNeutralCenter(float center);
    // Returns true only when a new motion starts from a stationary state.
    // Repeated keepalive frames and direction changes must keep the waveform
    // phase continuous.
    bool setMode(MotionMode mode);
    void setBias(float bias);
    void safeStop();
    MotionSnapshot snapshot() const;
    float angleAt(float phase) const;
    float angleAt(float phase, float amplitude, float bias) const;
private:
    MotionSnapshot value_;
    float neutralCenter_ = 90.0f;
};
