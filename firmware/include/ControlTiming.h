#pragma once
#include <stdint.h>

inline bool hasElapsed(uint32_t now, uint32_t since, uint32_t interval) {
    int32_t delta = static_cast<int32_t>(now - since);
    return delta >= 0 && static_cast<uint32_t>(delta) >= interval;
}
