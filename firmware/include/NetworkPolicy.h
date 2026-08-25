#pragma once
#include <stdint.h>

enum class NetworkAction { None, Connect, StartProvisioning };

class NetworkPolicy {
public:
    void begin(bool configured, uint32_t nowMs);
    NetworkAction next(uint32_t nowMs);
    void setConnected(bool connected, uint32_t nowMs);
private:
    bool configured_ = false;
    bool connected_ = false;
    bool attempted_ = false;
    bool provisioning_ = false;
    uint32_t startedAt_ = 0;
};

