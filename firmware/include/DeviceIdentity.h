#pragma once
#include <Arduino.h>
void formatDeviceMac(char out[18]);
String provisioningApName();
bool computeIdentityProofForMac(const uint8_t key[32], const char* domain, const char* nonce,
                                const char* normalizedMac, char output[65]);
bool computeIdentityProof(const char* domain, const char* nonce, char output[65]);
