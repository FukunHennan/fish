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
    void update(uint32_t nowMs, bool registered);
    bool connected() const;
    bool provisioning() const;
private:
    void connect();
    void startProvisioning();
    void registerRoutes();
    String scanNetworksJson();
    void printConnectionInfo();
    void printWifiStatus(int status, const char* context);
    ConfigStore& store_;
    DeviceConfig* config_ = nullptr;
    bool hasSavedWifi_ = false;
    uint32_t wifiAttemptStartedAt_ = 0;
    NetworkPolicy policy_;
    WebServer server_{80};
    DNSServer dnsServer_;
    bool uploadOk_ = false;
    bool uploadFailed_ = false;
    bool uploadAuthorized_ = false;
    bool portalStarted_ = false;
    bool lastConnected_ = false;
    bool wifiConnectInProgress_ = false;
    uint8_t wifiReconnectAttempt_ = 0;
    int lastWifiStatus_ = -1;
    uint32_t lastWifiStatusLog_ = 0;
    uint32_t lastReconnect_ = 0;
    String scannedNetworksJson_ = "{\"networks\":[]}";
};
