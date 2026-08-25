#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

bool readDiscoveryRequest(JsonDocument& document, String& requestId, String& nonce);
bool readControllerOffer(JsonDocument& document, const String& expectedDeviceId, const String& expectedNonce, uint16_t& controllerPort, String& proof);
