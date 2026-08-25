#include "AuthProtocol.h"

bool readAuthChallenge(JsonDocument& document, String& nonce) {
    String type = document["type"] | "";
    int version = document["protocolVersion"] | 0;
    String value = document["nonce"] | "";
    if (type != "auth.challenge" || version != 1 || value.length() < 16 || value.length() > 128) return false;
    nonce = value;
    return true;
}
