#pragma once
#include "DeviceConfig.h"

class ConfigStore {
public:
    bool load(DeviceConfig& config);
    bool save(const DeviceConfig& config);
    void clear();
};

