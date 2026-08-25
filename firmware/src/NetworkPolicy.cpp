#include "NetworkPolicy.h"

void NetworkPolicy::begin(bool configured, uint32_t nowMs) {
    configured_ = configured; connected_ = false; attempted_ = false; provisioning_ = false; startedAt_ = nowMs;
}
NetworkAction NetworkPolicy::next(uint32_t nowMs) {
    if (provisioning_ || connected_) return NetworkAction::None;
    if (!configured_) { provisioning_ = true; return NetworkAction::StartProvisioning; }
    if (!attempted_) { attempted_ = true; return NetworkAction::Connect; }
    if (nowMs - startedAt_ >= 60000) { provisioning_ = true; return NetworkAction::StartProvisioning; }
    return NetworkAction::None;
}
void NetworkPolicy::setConnected(bool connected, uint32_t nowMs) {
    if (connected_ && !connected) { attempted_ = false; startedAt_ = nowMs; }
    connected_ = connected;
}
