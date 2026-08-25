#include <Arduino.h>
#include <ArduinoJson.h>
#include <unity.h>
#include "DiscoveryProtocol.h"

void test_accepts_valid_discovery_request() {
    JsonDocument document;
    deserializeJson(document, R"({"type":"discovery.request","protocolVersion":1,"requestId":"aabbccdd","nonce":"00112233445566778899aabbccddeeff"})");
    String requestId, nonce;
    TEST_ASSERT_TRUE(readDiscoveryRequest(document, requestId, nonce));
    TEST_ASSERT_EQUAL_STRING("aabbccdd", requestId.c_str());
    TEST_ASSERT_EQUAL_STRING("00112233445566778899aabbccddeeff", nonce.c_str());
}

void test_rejects_invalid_discovery_request() {
    JsonDocument document;
    deserializeJson(document, R"({"type":"other","protocolVersion":1,"requestId":"x","nonce":"abc"})");
    String requestId, nonce;
    TEST_ASSERT_FALSE(readDiscoveryRequest(document, requestId, nonce));
}

void test_accepts_controller_offer_for_expected_device_and_nonce() {
    JsonDocument document;
    deserializeJson(document, R"({"type":"controller.offer","protocolVersion":2,"nonce":"0011223344556677","deviceId":"AA:BB:CC:DD:EE:FF","controllerPort":8081,"proof":"proof-value"})");
    uint16_t port = 0;
    String proof;
    TEST_ASSERT_TRUE(readControllerOffer(document, "AA:BB:CC:DD:EE:FF", "0011223344556677", port, proof));
    TEST_ASSERT_EQUAL_UINT16(8081, port);
    TEST_ASSERT_EQUAL_STRING("proof-value", proof.c_str());
}

void test_rejects_controller_offer_for_another_device() {
    JsonDocument document;
    deserializeJson(document, R"({"type":"controller.offer","protocolVersion":2,"nonce":"0011223344556677","deviceId":"11:22:33:44:55:66","controllerPort":8081,"proof":"proof-value"})");
    uint16_t port = 0;
    String proof;
    TEST_ASSERT_FALSE(readControllerOffer(document, "AA:BB:CC:DD:EE:FF", "0011223344556677", port, proof));
}

void setup() { delay(1000); UNITY_BEGIN(); RUN_TEST(test_accepts_valid_discovery_request); RUN_TEST(test_rejects_invalid_discovery_request); RUN_TEST(test_accepts_controller_offer_for_expected_device_and_nonce); RUN_TEST(test_rejects_controller_offer_for_another_device); UNITY_END(); }
void loop() {}
