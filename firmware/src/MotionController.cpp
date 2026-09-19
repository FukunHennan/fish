#include "MotionController.h"
#include <math.h>

MotionController::MotionController(int pin, float frequency, float amplitude, float turnAmount)
    : pin_(pin), state_(frequency, amplitude, turnAmount) {}

void MotionController::begin() {
    engageServo();
    transition_.reset(0.0f, 0.0f);
    outputAngle_ = state_.angleAt(0.0f);
    writeTarget(outputAngle_);
    lastUpdate_ = millis();
    releaseServoAt_ = lastUpdate_ + kStopHoldMs;
}
void MotionController::setNeutralCenter(float center) { state_.setNeutralCenter(center); }
void MotionController::setMode(MotionMode mode) {
    if (mode == MotionMode::Stopped) {
        safeStop();
        return;
    }
    if (state_.setMode(mode)) {
        phase_ = 0.0f;
    }
    syncTransitionTarget();
    engageServo();
}
void MotionController::setTuning(float f, float a) {
    state_.setTuning(f, a);
    syncTransitionTarget();
}
void MotionController::setBias(float bias) {
    state_.setBias(bias);
    syncTransitionTarget();
}
void MotionController::setTransitionMs(uint32_t transitionMs) {
    if (transitionMs < 100) transitionMs = 100;
    if (transitionMs > 1500) transitionMs = 1500;
    transitionMs_ = transitionMs;
    syncTransitionTarget();
}
void MotionController::centerAtBias(float bias) {
    state_.setNeutralCenter(90.0f + bias);
    state_.setBias(0.0f);
    safeStop();
}
void MotionController::safeStop() {
    state_.safeStop();
    transition_.reset(0.0f, 0.0f);
    engageServo();
    writeTarget(state_.angleAt(0.0f));
    releaseServoAt_ = millis() + kStopHoldMs;
}
MotionSnapshot MotionController::snapshot() const { return state_.snapshot(); }

void MotionController::syncTransitionTarget() {
    MotionSnapshot s = state_.snapshot();
    const bool moving = s.mode != MotionMode::Stopped && s.mode != MotionMode::Idle;
    transition_.setTarget(moving ? s.amplitude : 0.0f, s.bias, transitionMs_);
}

void MotionController::engageServo() {
    if (servo_.attached()) return;
    servo_.attach(pin_);
    lastWrittenAngle_ = -1;
}

void MotionController::writeTarget(float angle) {
    int target = (int)lroundf(angle);
    if (target == lastWrittenAngle_) return;
    servo_.write(target);
    lastWrittenAngle_ = target;
    outputAngle_ = angle;
}

void MotionController::update(uint32_t nowMs) {
    if (nowMs - lastUpdate_ < 20) return;
    float dt = (nowMs - lastUpdate_) / 1000.0f;
    lastUpdate_ = nowMs;
    transition_.update(dt);
    MotionSnapshot s = state_.snapshot();
    const bool stationary = s.mode == MotionMode::Stopped || s.mode == MotionMode::Idle;
    if (stationary && transition_.settled()) {
        if (!servo_.attached()) return;
        writeTarget(state_.angleAt(0.0f));
        if ((int32_t)(nowMs - releaseServoAt_) >= 0) {
            servo_.detach();
            lastWrittenAngle_ = -1;
        }
        return;
    }
    engageServo();
    phase_ = fmodf(phase_ + s.frequency * 2.0f * PI * dt, 2.0f * PI);
    // Ramp only the envelope and steering center during a requested mode
    // transition. Once settled, the sine wave follows the exact requested
    // frequency and amplitude without the old per-frame angle clamp.
    writeTarget(state_.angleAt(phase_, transition_.amplitude(), transition_.bias()));
}
