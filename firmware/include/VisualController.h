#pragma once
#include <stdint.h>
#include <string>

struct VisualPidParameters {
    float crossKp = 8.0f;
    float crossKi = 0.4f;
    float crossKd = 1.2f;
    float headingKp = 0.12f;
    float curveFeedForward = 5.0f;
    float maxBias = 25.0f;
    float cruiseFrequency = 2.5f;
    float cruiseAmplitude = 28.0f;
    float slowDistance = 0.50f;
    float stopDistance = 0.10f;
    uint32_t timeoutMs = 500;
};

struct VisualInput {
    uint32_t sequence;
    float crossTrackError;
    float headingErrorDeg;
    float distanceToTarget;
    float speed;
    float curvature;
    bool brake;
};

struct VisualOutput { float frequency, amplitude, bias; bool stop; };

class VisualController {
public:
    bool start(const char* sessionId, uint32_t nowMs);
    void stop();
    bool update(const char* sessionId, const VisualInput& input, uint32_t nowMs, VisualOutput& output);
    bool timedOut(uint32_t nowMs) const;
    bool active() const { return active_; }
    const char* sessionId() const { return sessionId_.c_str(); }
    uint32_t lastSequence() const { return lastSequence_; }
    const VisualPidParameters& parameters() const { return parameters_; }
    bool setParameters(const VisualPidParameters& value);
private:
    VisualPidParameters parameters_;
    std::string sessionId_;
    bool active_ = false;
    bool receivedUpdate_ = false;
    uint32_t lastSequence_ = 0, lastUpdateMs_ = 0;
    float integral_ = 0.0f, previousError_ = 0.0f;
};

