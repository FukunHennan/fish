#include "NetworkPolicy.h"

#include "AppConfig.h"

void NetworkPolicy::begin(bool configured, uint32_t nowMs, uint32_t recoveryMs, uint32_t provisioningWindowMs) {
    configured_ = configured;
    connected_ = false;
    attempted_ = false;
    provisioning_ = false;
    registered_ = false;
    recoveryMs_ = recoveryMs;
    provisioningWindowMs_ = provisioningWindowMs;
    lastRegisteredAt_ = nowMs;
    provisioningStartedAt_ = 0;
    provisioningRequested_ = false;
    provisioningHasDeadline_ = false;
}

NetworkAction NetworkPolicy::next(uint32_t nowMs) {
    if (provisioning_) {
        if (provisioningHasDeadline_ && nowMs - provisioningStartedAt_ >= provisioningWindowMs_) {
            provisioning_ = false;
            provisioningRequested_ = false;
            configured_ = true;
            lastRegisteredAt_ = nowMs;
            attempted_ = false;
            return NetworkAction::Connect;
        }
        return NetworkAction::None;
    }
    if (!configured_) {
        provisioning_ = true;
        provisioningRequested_ = true;
        provisioningHasDeadline_ = false;
        return NetworkAction::StartProvisioning;
    }
    if (!registered_ && !provisioningRequested_ && nowMs - lastRegisteredAt_ >= recoveryMs_) {
        provisioning_ = true;
        provisioningRequested_ = true;
        provisioningStartedAt_ = nowMs;
        provisioningHasDeadline_ = true;
        return NetworkAction::StartProvisioning;
    }
    if (connected_) return NetworkAction::None;
    if (!attempted_) { attempted_ = true; return NetworkAction::Connect; }
    return NetworkAction::None;
}

void NetworkPolicy::setConnected(bool connected, uint32_t nowMs) {
    if (connected_ && !connected) {
        attempted_ = false;
        lastRegisteredAt_ = nowMs;
        provisioningRequested_ = false;
    }
    connected_ = connected;
}

void NetworkPolicy::setRegistered(bool registered, uint32_t nowMs) {
    if (registered || registered_) {
        lastRegisteredAt_ = nowMs;
        provisioningRequested_ = false;
    }
    registered_ = registered;
}

void NetworkPolicy::provisioningFinished(uint32_t nowMs) {
    provisioning_ = false;
    provisioningRequested_ = false;
    provisioningHasDeadline_ = false;
    configured_ = true;
    lastRegisteredAt_ = nowMs;
    attempted_ = false;
}
