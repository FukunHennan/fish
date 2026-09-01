#include "DiscoveryResponder.h"
#include "DiscoveryProtocol.h"
#include "DeviceIdentity.h"
#include "AppConfig.h"
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiClient.h>

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

static uint32_t ipToInteger(const IPAddress& ip) {
    return ((uint32_t)ip[0] << 24) | ((uint32_t)ip[1] << 16) | ((uint32_t)ip[2] << 8) | (uint32_t)ip[3];
}

static IPAddress integerToIp(uint32_t value) {
    return IPAddress((value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

void DiscoveryResponder::begin(const DeviceConfig& config) {
    config_ = config;
}

void DiscoveryResponder::writePacket(const IPAddress& target, const String& payload) {
    udp_.beginPacket(target, DISCOVERY_PORT);
    udp_.write((const uint8_t*)payload.c_str(), payload.length());
    int result = udp_.endPacket();
}

void DiscoveryResponder::sendAnnouncement(uint32_t nowMs) {
    nonce_=makeNonce();
    lastAnnouncement_=nowMs;
    char proof[65],mac[18];
    formatDeviceMac(mac);
    if(!computeIdentityProof("fish-device-announce-v2",nonce_.c_str(),proof))return;
    JsonDocument announce;
    announce["type"]="device.announce";
    announce["protocolVersion"]=2;
    announce["nonce"]=nonce_;
    announce["deviceId"]=mac;
    announce["proof"]=proof;
    announce["name"]=config_.displayName;
    announce["firmwareVersion"]=FIRMWARE_VERSION;
    String output;
    serializeJson(announce,output);

    IPAddress directed = subnetBroadcast();
    writePacket(directed, output);
    IPAddress limited(255,255,255,255);
    if (limited != directed) writePacket(limited, output);
}

bool DiscoveryResponder::probeControllerAt(const IPAddress& target) {
    WiFiClient client;
    client.setTimeout(CONTROLLER_DISCOVERY_SCAN_TIMEOUT_MS);
    if(!client.connect(target, config_.controllerPort, CONTROLLER_DISCOVERY_SCAN_TIMEOUT_MS))return false;
    client.print(String("GET /healthz HTTP/1.1\r\nHost: ") + target.toString() + "\r\nConnection: close\r\n\r\n");
    String response;
    uint32_t started=millis();
    while(millis()-started<CONTROLLER_DISCOVERY_SCAN_TIMEOUT_MS){
        while(client.available()){
            char c=(char)client.read();
            if(response.length()<180)response+=c;
            if(response.indexOf("200 OK")>=0&&response.indexOf("\"status\":\"ok\"")>=0){
                client.stop();
                return true;
            }
        }
        if(!client.connected())break;
        delay(1);
    }
    client.stop();
    return response.indexOf("200 OK")>=0&&response.indexOf("\"status\":\"ok\"")>=0;
}

void DiscoveryResponder::probeController(uint32_t nowMs) {
    if(nowMs-lastProbe_<CONTROLLER_DISCOVERY_SCAN_INTERVAL_MS)return;
    lastProbe_=nowMs;

    uint32_t ip=ipToInteger(WiFi.localIP());
    uint32_t mask=ipToInteger(WiFi.subnetMask());
    uint32_t base=ip&mask;
    uint32_t broadcast=base|(~mask);
    if(broadcast<=base+1)return;
    uint32_t hosts=broadcast-base-1;
    if(hosts>2048)hosts=2048;

    const uint32_t ownIp=ip;
    const uint32_t gatewayIp=ipToInteger(WiFi.gatewayIP());
    for(uint8_t attempt=0;attempt<2;attempt++){
        uint32_t candidateValue=0;
        while(candidateValue==0){
            if(nearProbeStep_<CONTROLLER_DISCOVERY_NEAR_SCAN_RADIUS*2){
                uint32_t distance=(nearProbeStep_/2)+1;
                bool negative=(nearProbeStep_%2)==1;
                nearProbeStep_++;
                if(negative){
                    if(ownIp<=base+distance)continue;
                    candidateValue=ownIp-distance;
                }else{
                    if(ownIp+distance>=broadcast)continue;
                    candidateValue=ownIp+distance;
                }
            }else{
                uint32_t offset=(probeOffset_%hosts)+1;
                probeOffset_++;
                candidateValue=base+offset;
            }
            if(candidateValue==ownIp||candidateValue==gatewayIp)candidateValue=0;
        }
        IPAddress candidate=integerToIp(candidateValue);
        if(probeControllerAt(candidate)){
            controller_.setEndpoint(candidate,config_.controllerPort);
            return;
        }
    }
}

void DiscoveryResponder::update() {
    if (WiFi.status() != WL_CONNECTED) return;
    if (!started_) {
        started_ = udp_.begin(DISCOVERY_PORT);
        if (!started_) return;
    }
    uint32_t now=millis();
    if (!controller_.registered() && (nonce_.length()==0 || now-lastAnnouncement_>=CONTROLLER_DISCOVERY_ANNOUNCE_INTERVAL_MS)) {
        sendAnnouncement(now);
    }
    if (!controller_.registered() && !controller_.endpointReady()) {
        probeController(now);
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
        char expected[65];if(computeIdentityProof("fish-controller-offer-v2",nonce_.c_str(),expected)&&offeredProof.equalsIgnoreCase(expected)){
            controller_.setEndpoint(udp_.remoteIP(),offeredPort);
        }
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
