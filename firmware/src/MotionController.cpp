#include "MotionController.h"
#include <math.h>

MotionController::MotionController(int pin, float frequency, float amplitude, float turnAmount)
    : pin_(pin), state_(frequency, amplitude, turnAmount) {}

void MotionController::begin() {
    servo_.attach(pin_);
    outputAngle_ = state_.angleAt(0.0f);
    servo_.write((int)outputAngle_);
    lastUpdate_ = millis();
}
void MotionController::setNeutralCenter(float center) { state_.setNeutralCenter(center); }
void MotionController::setMode(MotionMode mode) { state_.setMode(mode); }
void MotionController::setTuning(float f, float a) { state_.setTuning(f, a); }
void MotionController::setBias(float bias) { state_.setBias(bias); }
void MotionController::centerAtBias(float bias) {
    state_.setNeutralCenter(90.0f + bias);
    state_.safeStop();
    state_.setBias(0.0f);
}
void MotionController::safeStop() { state_.safeStop(); }
MotionSnapshot MotionController::snapshot() const { return state_.snapshot(); }

void MotionController::update(uint32_t nowMs) {
    if (nowMs - lastUpdate_ < 20) return;
    float dt = (nowMs - lastUpdate_) / 1000.0f;
    lastUpdate_ = nowMs;
    MotionSnapshot s = state_.snapshot();
    if (s.mode != MotionMode::Stopped) {
        phase_ = fmodf(phase_ + s.frequency * 2.0f * PI * dt, 2.0f * PI);
    }
    float target = state_.angleAt(phase_);
    float delta = target - outputAngle_;
    const float maxStep = 8.0f;
    if (delta > maxStep) delta = maxStep;
    if (delta < -maxStep) delta = -maxStep;
    outputAngle_ += delta;
    servo_.write((int)outputAngle_);
}
