#include <unity.h>
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include "NetworkPolicy.h"

void test_unconfigured_device_provisions_immediately() {
    NetworkPolicy policy;
    policy.begin(false, 0);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning, (int)policy.next(0));
}

void test_configured_device_falls_back_after_sixty_seconds() {
    NetworkPolicy policy;
    policy.begin(true, 0);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::Connect, (int)policy.next(0));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)policy.next(59999));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning, (int)policy.next(60000));
}

void test_connected_state_disables_fallback() {
    NetworkPolicy policy;
    policy.begin(true, 0);
    policy.next(0);
    policy.setConnected(true, 1000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)policy.next(70000));
}

void runTests() {
    UNITY_BEGIN();
    RUN_TEST(test_unconfigured_device_provisions_immediately);
    RUN_TEST(test_configured_device_falls_back_after_sixty_seconds);
    RUN_TEST(test_connected_state_disables_fallback);
    UNITY_END();
}

#ifdef ARDUINO
void setup() { delay(2000); runTests(); }
void loop() {}
#else
int main(int, char**) { runTests(); return 0; }
#endif
