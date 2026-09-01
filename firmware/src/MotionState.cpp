#include "MotionState.h"
#include <math.h>

MotionState::MotionState(float frequency, float amplitude, float turnAmount)
    : value_{MotionMode::Stopped, frequency, amplitude, 0.0f}, turnAmount_(turnAmount) {}

bool MotionState::setTuning(float frequency, float amplitude) {
    if (frequency < 0.3f || frequency > 5.0f || amplitude < 0.0f || amplitude > 50.0f) return false;
    value_.frequency = frequency;
    value_.amplitude = amplitude;
    return true;
}

void MotionState::setMode(MotionMode mode) {
    value_.mode = mode;
    if (!customBias_) value_.bias = mode == MotionMode::Left ? -turnAmount_ : mode == MotionMode::Right ? turnAmount_ : 0.0f;
    customBias_ = false;
}

bool MotionState::setBias(float bias) { if (bias < -45.0f || bias > 45.0f) return false; value_.bias=bias; customBias_=true; return true; }

void MotionState::safeStop() { customBias_ = false; setMode(MotionMode::Stopped); }
MotionSnapshot MotionState::snapshot() const { return value_; }

float MotionState::angleAt(float phase) const {
    if (value_.mode == MotionMode::Stopped) return 90.0f;
    float amplitude = value_.mode == MotionMode::Idle ? 6.0f : value_.amplitude;
    float angle = 90.0f + value_.bias + amplitude * sinf(phase);
    return angle < 0.0f ? 0.0f : angle > 180.0f ? 180.0f : angle;
}
