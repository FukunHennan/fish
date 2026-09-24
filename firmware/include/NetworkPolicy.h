#pragma once
#include <stdint.h>

enum class NetworkAction { None, Connect, StartProvisioning };

class NetworkPolicy {
public:
    void begin(bool configured, uint32_t nowMs,
               uint32_t recoveryMs = 180000, uint32_t provisioningWindowMs = 300000);
    NetworkAction next(uint32_t nowMs);
    void setRegistered(bool registered, uint32_t nowMs);
    void setConnected(bool connected, uint32_t nowMs);
    void provisioningFinished(uint32_t nowMs);
private:
    bool configured_ = false;
    bool connected_ = false;
    bool attempted_ = false;
    bool provisioning_ = false;
    bool registered_ = false;
    uint32_t lastRegisteredAt_ = 0;
    uint32_t recoveryMs_ = 180000;
    uint32_t provisioningWindowMs_ = 300000;
    uint32_t provisioningStartedAt_ = 0;
    bool provisioningRequested_ = false;
    bool provisioningHasDeadline_ = false;
};

