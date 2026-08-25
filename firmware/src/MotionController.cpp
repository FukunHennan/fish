#include "MotionController.h"
#include <math.h>

MotionController::MotionController(int pin, float frequency, float amplitude, float turnAmount)
    : pin_(pin), state_(frequency, amplitude, turnAmount) {}

void MotionController::begin() { servo_.attach(pin_); servo_.write(90); lastUpdate_ = millis(); }
void MotionController::setMode(MotionMode mode) { state_.setMode(mode); if (mode == MotionMode::Stopped) servo_.write(90); }
bool MotionController::setTuning(float f, float a) { return state_.setTuning(f, a); }
bool MotionController::setBias(float bias) { return state_.setBias(bias); }
bool MotionController::applyVisual(float f,float a,float bias){if(!state_.setTuning(f,a)||!state_.setBias(bias))return false;state_.setMode(MotionMode::Forward);return true;}
void MotionController::safeStop() { state_.safeStop(); servo_.write(90); }
MotionSnapshot MotionController::snapshot() const { return state_.snapshot(); }

void MotionController::update(uint32_t nowMs) {
    if (nowMs - lastUpdate_ < 20) return;
    float dt = (nowMs - lastUpdate_) / 1000.0f;
    lastUpdate_ = nowMs;
    MotionSnapshot s = state_.snapshot();
    if (s.mode == MotionMode::Stopped) return;
    float frequency = s.mode == MotionMode::Idle ? 0.6f : s.frequency;
    phase_ = fmodf(phase_ + frequency * 2.0f * PI * dt, 2.0f * PI);
    servo_.write((int)state_.angleAt(phase_));
}
