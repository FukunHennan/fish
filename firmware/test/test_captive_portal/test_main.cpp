#include <unity.h>
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include "CaptivePortalRoutes.h"

void test_recognizes_operating_system_probe_paths() {
    TEST_ASSERT_TRUE(isCaptiveProbePath("/generate_204"));
    TEST_ASSERT_TRUE(isCaptiveProbePath("/hotspot-detect.html"));
    TEST_ASSERT_TRUE(isCaptiveProbePath("/library/test/success.html"));
    TEST_ASSERT_TRUE(isCaptiveProbePath("/connecttest.txt"));
    TEST_ASSERT_TRUE(isCaptiveProbePath("/ncsi.txt"));
}

void test_does_not_treat_configuration_post_as_probe() {
    TEST_ASSERT_FALSE(isCaptiveProbePath("/configure"));
}

void runTests() {
    UNITY_BEGIN();
    RUN_TEST(test_recognizes_operating_system_probe_paths);
    RUN_TEST(test_does_not_treat_configuration_post_as_probe);
    UNITY_END();
}

#ifdef ARDUINO
void setup() { delay(2000); runTests(); }
void loop() {}
#else
int main(int, char**) { runTests(); return 0; }
#endif
