#include <Arduino.h>
#include <unity.h>
#include "DeviceIdentity.h"

void test_hmac_matches_go_vector() {
    const uint8_t key[32] = {
        0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
        16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31
    };
    char output[65] = {};
    TEST_ASSERT_TRUE(computeIdentityProofForMac(
        key, "fish-discovery-v1", "00112233445566778899aabbccddeeff", "ac276e7c3718", output));
    TEST_ASSERT_EQUAL_STRING("7a230c9e3d58592fccba3c17d292d01d5c68840754e4c508d748d60abebe22ab", output);
}

void setup() {
    delay(1000);
    UNITY_BEGIN();
    RUN_TEST(test_hmac_matches_go_vector);
    UNITY_END();
}
void loop() {}
