#pragma once
#include <stdint.h>

// Retain bounded, expiring challenges so a delayed reply survives a newer
// announcement. The caller must still verify the HMAC for the matched nonce.
template <typename Text> class DiscoveryNonceWindow {
public:
    void remember(const Text& nonce, uint32_t now) {
        entries_[next_] = nonce; times_[next_] = now; valid_[next_] = true;
        next_ = (next_ + 1) % 16;
    }
    bool contains(const Text& nonce, uint32_t now) const {
        for (uint8_t i = 0; i < 16; ++i)
            if (valid_[i] && now - times_[i] <= 10000 && entries_[i] == nonce) return true;
        return false;
    }
private:
    Text entries_[16];
    uint32_t times_[16] = {};
    bool valid_[16] = {};
    uint8_t next_ = 0;
};
