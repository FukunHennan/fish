#include <Arduino.h>
#include <ArduinoJson.h>
#include <unity.h>
#include "AuthProtocol.h"

void test_accepts_valid_auth_challenge() {
    JsonDocument document;
    deserializeJson(document, R"({"type":"auth.challenge","protocolVersion":1,"nonce":"00112233445566778899aabbccddeeff"})");
    String nonce;
    TEST_ASSERT_TRUE(readAuthChallenge(document, nonce));
    TEST_ASSERT_EQUAL_STRING("00112233445566778899aabbccddeeff", nonce.c_str());
}

void test_rejects_wrong_version_and_empty_nonce() {
    JsonDocument wrongVersion;
    deserializeJson(wrongVersion, R"({"type":"auth.challenge","protocolVersion":2,"nonce":"abc"})");
    String nonce;
    TEST_ASSERT_FALSE(readAuthChallenge(wrongVersion, nonce));
    JsonDocument emptyNonce;
    deserializeJson(emptyNonce, R"({"type":"auth.challenge","protocolVersion":1,"nonce":""})");
    TEST_ASSERT_FALSE(readAuthChallenge(emptyNonce, nonce));
}

void setup() {
    delay(1000);
    UNITY_BEGIN();
    RUN_TEST(test_accepts_valid_auth_challenge);
    RUN_TEST(test_rejects_wrong_version_and_empty_nonce);
    UNITY_END();
}
void loop() {}
