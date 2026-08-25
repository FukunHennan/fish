#include "DiscoveryProtocol.h"

bool readDiscoveryRequest(JsonDocument& document, String& requestId, String& nonce) {
    String type = document["type"] | "";
    int version = document["protocolVersion"] | 0;
    String id = document["requestId"] | "";
    String value = document["nonce"] | "";
    if (type != "discovery.request" || version != 1 || id.length() < 4 || id.length() > 64 || value.length() < 16 || value.length() > 128) return false;
    requestId = id;
    nonce = value;
    return true;
}

bool readControllerOffer(JsonDocument& document, const String& expectedDeviceId, const String& expectedNonce, uint16_t& controllerPort, String& proof) {
    String type = document["type"] | "";
    int version = document["protocolVersion"] | 0;
    String nonce = document["nonce"] | "";
    String deviceId = document["deviceId"] | "";
    unsigned long port = document["controllerPort"] | 0UL;
    String receivedProof = document["proof"] | "";
    if (type != "controller.offer" || version != 2 || nonce != expectedNonce || deviceId != expectedDeviceId || port == 0 || port > 65535 || receivedProof.length() != 64) return false;
    controllerPort = (uint16_t)port;
    proof = receivedProof;
    return true;
}
