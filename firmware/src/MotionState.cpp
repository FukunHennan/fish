#include "MotionState.h"
#include <math.h>

MotionState::MotionState(float frequency, float amplitude, float turnAmount)
    : value_{MotionMode::Stopped, frequency, amplitude, 0.0f} {
    (void)turnAmount;
}

void MotionState::setTuning(float frequency, float amplitude) {
    value_.frequency = frequency;
    value_.amplitude = amplitude;
}

void MotionState::setNeutralCenter(float center) { neutralCenter_ = center; }

void MotionState::setMode(MotionMode mode) {
    value_.mode = mode;
}

void MotionState::setBias(float bias) { value_.bias=bias; }

void MotionState::safeStop() {
    value_.mode = MotionMode::Stopped;
    value_.bias = 0.0f;
}
MotionSnapshot MotionState::snapshot() const { return value_; }

float MotionState::angleAt(float phase) const {
    if (value_.mode == MotionMode::Stopped) return neutralCenter_ + value_.bias;
    return neutralCenter_ + value_.bias + value_.amplitude * sinf(phase);
}
