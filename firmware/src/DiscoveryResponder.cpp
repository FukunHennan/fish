#include "DiscoveryResponder.h"
#include "DiscoveryProtocol.h"
#include "DeviceIdentity.h"
#include "AppConfig.h"
#include <ArduinoJson.h>
#include <WiFi.h>

static constexpr uint16_t DISCOVERY_PORT = 30303;

static String makeNonce() {
    char value[17];
    snprintf(value, sizeof(value), "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
    return String(value);
}

static IPAddress subnetBroadcast() {
    IPAddress ip=WiFi.localIP(), mask=WiFi.subnetMask(), result;
    for(int i=0;i<4;i++) result[i]=ip[i]|(uint8_t)~mask[i];
    return result;
}

void DiscoveryResponder::begin(const DeviceConfig& config) {
    config_ = config;
}

void DiscoveryResponder::update() {
    if (WiFi.status() != WL_CONNECTED) return;
    if (!started_) { started_ = udp_.begin(DISCOVERY_PORT); if (!started_) return; }
    uint32_t now=millis();
    if (!controller_.endpointReady() && (nonce_.length()==0 || now-lastAnnouncement_>=3000)) {
        nonce_=makeNonce();lastAnnouncement_=now;char proof[65],mac[18];formatDeviceMac(mac);
        if(computeIdentityProof("fish-device-announce-v2",nonce_.c_str(),proof)){
            JsonDocument announce;announce["type"]="device.announce";announce["protocolVersion"]=2;announce["nonce"]=nonce_;announce["deviceId"]=mac;announce["proof"]=proof;announce["name"]=config_.displayName;announce["firmwareVersion"]=FIRMWARE_VERSION;
            String output;serializeJson(announce,output);udp_.beginPacket(subnetBroadcast(),DISCOVERY_PORT);udp_.write((const uint8_t*)output.c_str(),output.length());udp_.endPacket();
        }
    }
    int packetSize = udp_.parsePacket();
    if (packetSize <= 0) return;
    if (packetSize > 1400) { while (udp_.available()) udp_.read(); return; }
    char buffer[1401];
    int length = udp_.read(reinterpret_cast<uint8_t*>(buffer), sizeof(buffer)-1);
    if (length <= 0) return;
    buffer[length] = '\0';
    JsonDocument request;
    if (deserializeJson(request, buffer, length)) return;
    char ownMac[18];formatDeviceMac(ownMac);uint16_t offeredPort=0;String offeredProof;
    if(readControllerOffer(request,String(ownMac),nonce_,offeredPort,offeredProof)){
        char expected[65];if(computeIdentityProof("fish-controller-offer-v2",nonce_.c_str(),expected)&&offeredProof.equalsIgnoreCase(expected))controller_.setEndpoint(udp_.remoteIP(),offeredPort);
        return;
    }
    String requestId, nonce;
    if (!readDiscoveryRequest(request, requestId, nonce)) return;
    char proof[65], mac[18];
    if (!computeIdentityProof("fish-discovery-v1", nonce.c_str(), proof)) return;
    formatDeviceMac(mac);
    MotionSnapshot state = motion_.snapshot();
    JsonDocument response;
    response["type"] = "discovery.response";
    response["protocolVersion"] = 1;
    response["requestId"] = requestId;
    response["nonce"] = nonce;
    response["deviceId"] = mac;
    response["proof"] = proof;
    response["ip"] = WiFi.localIP().toString();
    response["name"] = config_.displayName;
    response["firmwareVersion"] = FIRMWARE_VERSION;
    response["rssi"] = WiFi.RSSI();
    response["uptimeMs"] = millis();
    response["mode"] = (int)state.mode;
    response["frequency"] = state.frequency;
    response["amplitude"] = state.amplitude;
    response["bias"] = state.bias;
    response["stopReason"] = "";
    String output;
    serializeJson(response, output);
    udp_.beginPacket(udp_.remoteIP(), udp_.remotePort());
    udp_.write(reinterpret_cast<const uint8_t*>(output.c_str()), output.length());
    udp_.endPacket();
}
