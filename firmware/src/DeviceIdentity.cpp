#include "DeviceIdentity.h"
#include <WiFi.h>
#include <mbedtls/md.h>
#include <ctype.h>
#include <string.h>

#ifndef FISH_DEPLOYMENT_KEY_HEX
#error "FISH_DEPLOYMENT_KEY_HEX is required"
#endif
#define FISH_STRINGIFY_INNER(value) #value
#define FISH_STRINGIFY(value) FISH_STRINGIFY_INNER(value)

void formatDeviceMac(char out[18]) { uint8_t m[6]; WiFi.macAddress(m); snprintf(out,18,"%02X:%02X:%02X:%02X:%02X:%02X",m[0],m[1],m[2],m[3],m[4],m[5]); }
String provisioningApName() { char m[18]; formatDeviceMac(m); String s(m); s.replace(":",""); return "Fish-Setup-" + s.substring(6); }

static int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    c = (char)tolower((unsigned char)c);
    return c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}

static bool decodeDeploymentKey(uint8_t key[32]) {
    const char* encoded = FISH_STRINGIFY(FISH_DEPLOYMENT_KEY_HEX);
    if (strlen(encoded) != 64) return false;
    for (size_t i = 0; i < 32; ++i) {
        int high = hexValue(encoded[i * 2]);
        int low = hexValue(encoded[i * 2 + 1]);
        if (high < 0 || low < 0) return false;
        key[i] = (uint8_t)((high << 4) | low);
    }
    return true;
}

bool computeIdentityProofForMac(const uint8_t key[32], const char* domain, const char* nonce,
                                const char* normalizedMac, char output[65]) {
    if (!key || !domain || !nonce || !normalizedMac || !output || !domain[0] || !nonce[0] || strlen(normalizedMac) != 12) return false;
    String message = String(domain) + "\n" + nonce + "\n" + normalizedMac;
    unsigned char digest[32];
    const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!info || mbedtls_md_hmac(info, key, 32,
        reinterpret_cast<const unsigned char*>(message.c_str()), message.length(), digest) != 0) return false;
    for (size_t i = 0; i < 32; ++i) snprintf(output + i * 2, 3, "%02x", digest[i]);
    output[64] = '\0';
    return true;
}

bool computeIdentityProof(const char* domain, const char* nonce, char output[65]) {
    uint8_t key[32];
    if (!decodeDeploymentKey(key)) return false;
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char normalized[13];
    snprintf(normalized, sizeof(normalized), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return computeIdentityProofForMac(key, domain, nonce, normalized, output);
}
