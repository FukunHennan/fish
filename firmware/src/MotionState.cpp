#include "MotionState.h"
#include <math.h>

namespace {
constexpr float kTransitionEpsilon = 0.001f;
}

void MotionTransition::reset(float amplitude, float bias) {
    amplitude_ = targetAmplitude_ = amplitude;
    bias_ = targetBias_ = bias;
    amplitudeRate_ = biasRate_ = 0.0f;
    durationMs_ = 0;
}

void MotionTransition::setTarget(float amplitude, float bias, uint32_t durationMs) {
    if (fabsf(targetAmplitude_ - amplitude) < kTransitionEpsilon &&
        fabsf(targetBias_ - bias) < kTransitionEpsilon && durationMs_ == durationMs) {
        return;
    }
    targetAmplitude_ = amplitude;
    targetBias_ = bias;
    durationMs_ = durationMs;
    const float seconds = durationMs > 0 ? durationMs / 1000.0f : 0.0f;
    if (seconds <= 0.0f) {
        reset(amplitude, bias);
        return;
    }
    amplitudeRate_ = fabsf(targetAmplitude_ - amplitude_) / seconds;
    biasRate_ = fabsf(targetBias_ - bias_) / seconds;
}

float MotionTransition::moveToward(float current, float target, float maximumDelta) {
    if (maximumDelta <= 0.0f || fabsf(target - current) <= maximumDelta) return target;
    return current + (target > current ? maximumDelta : -maximumDelta);
}

void MotionTransition::update(float dtSeconds) {
    if (dtSeconds <= 0.0f) return;
    amplitude_ = moveToward(amplitude_, targetAmplitude_, amplitudeRate_ * dtSeconds);
    bias_ = moveToward(bias_, targetBias_, biasRate_ * dtSeconds);
}

bool MotionTransition::settled() const {
    return fabsf(targetAmplitude_ - amplitude_) < kTransitionEpsilon &&
           fabsf(targetBias_ - bias_) < kTransitionEpsilon;
}

MotionState::MotionState(float frequency, float amplitude, float turnAmount)
    : value_{MotionMode::Stopped, frequency, amplitude, 0.0f} {
    (void)turnAmount;
}

void MotionState::setTuning(float frequency, float amplitude) {
    value_.frequency = frequency;
    value_.amplitude = amplitude;
}

void MotionState::setNeutralCenter(float center) { neutralCenter_ = center; }

bool MotionState::setMode(MotionMode mode) {
    const bool wasStationary = value_.mode == MotionMode::Stopped || value_.mode == MotionMode::Idle;
    const bool willMove = mode != MotionMode::Stopped && mode != MotionMode::Idle;
    value_.mode = mode;
    return wasStationary && willMove;
}

void MotionState::setBias(float bias) { value_.bias=bias; }

void MotionState::safeStop() {
    value_.mode = MotionMode::Stopped;
    value_.bias = 0.0f;
}
MotionSnapshot MotionState::snapshot() const { return value_; }

float MotionState::angleAt(float phase) const {
    if (value_.mode == MotionMode::Stopped || value_.mode == MotionMode::Idle) {
        return neutralCenter_ + value_.bias;
    }
    return neutralCenter_ + value_.bias + value_.amplitude * sinf(phase);
}

float MotionState::angleAt(float phase, float amplitude, float bias) const {
    return neutralCenter_ + bias + amplitude * sinf(phase);
}
