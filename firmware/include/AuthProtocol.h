#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

bool readAuthChallenge(JsonDocument& document, String& nonce);
