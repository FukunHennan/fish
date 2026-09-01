#pragma once
#include <Arduino.h>
#include <WebServer.h>
#include <DNSServer.h>
#include "ConfigStore.h"
#include "NetworkPolicy.h"

class NetworkManager {
public:
    explicit NetworkManager(ConfigStore& store);
    void begin(DeviceConfig& config);
    void update(uint32_t nowMs);
    bool connected() const;
    bool provisioning() const;
private:
    void connect();
    void startProvisioning();
    void registerRoutes();
    void printConnectionInfo();
    ConfigStore& store_;
    DeviceConfig* config_ = nullptr;
    NetworkPolicy policy_;
    WebServer server_{80};
    DNSServer dnsServer_;
    bool portalStarted_ = false;
    bool lastConnected_ = false;
    uint32_t lastReconnect_ = 0;
};
