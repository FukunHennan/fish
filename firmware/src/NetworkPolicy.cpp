#include "NetworkPolicy.h"

void NetworkPolicy::begin(bool configured, uint32_t nowMs) {
    configured_ = configured; connected_ = false; attempted_ = false; provisioning_ = false; startedAt_ = nowMs; lastRegisteredAt_ = nowMs; registered_ = false;
}
NetworkAction NetworkPolicy::next(uint32_t nowMs) {
    if (provisioning_) return NetworkAction::None;
    if (!configured_) { provisioning_ = true; return NetworkAction::StartProvisioning; }
    if (!registered_ && nowMs - lastRegisteredAt_ >= 180000) { provisioning_ = true; return NetworkAction::StartProvisioning; }
    if (connected_) return NetworkAction::None;
    if (!attempted_) { attempted_ = true; return NetworkAction::Connect; }
    return NetworkAction::None;
}
void NetworkPolicy::setConnected(bool connected, uint32_t nowMs) {
    if (connected_ && !connected) { attempted_ = false; startedAt_ = nowMs; }
    connected_ = connected;
}

void NetworkPolicy::setRegistered(bool registered, uint32_t nowMs) {
    if (registered || registered_) lastRegisteredAt_ = nowMs;
    registered_ = registered;
}
