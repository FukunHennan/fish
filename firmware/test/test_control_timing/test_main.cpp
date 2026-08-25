#include <Arduino.h>
#include <unity.h>
#include "ControlTiming.h"

void test_future_timestamp_in_same_loop_is_not_elapsed() {
    TEST_ASSERT_FALSE(hasElapsed(1000, 1001, 2000));
}

void test_elapsed_handles_millis_wraparound() {
    TEST_ASSERT_TRUE(hasElapsed(5, 0xFFFFFFFAu, 10));
}

void setup() { delay(1000); UNITY_BEGIN(); RUN_TEST(test_future_timestamp_in_same_loop_is_not_elapsed); RUN_TEST(test_elapsed_handles_millis_wraparound); UNITY_END(); }
void loop() {}
