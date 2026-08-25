#include <unity.h>
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include "MotionState.h"

void test_direction_preserves_tuning() {
    MotionState state(2.5f, 28.0f, 15.0f);
    TEST_ASSERT_TRUE(state.setTuning(3.2f, 31.0f));
    state.setMode(MotionMode::Left);
    MotionSnapshot value = state.snapshot();
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 3.2f, value.frequency);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 31.0f, value.amplitude);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 15.0f, value.bias);
}

void test_stop_centers_tail_without_erasing_tuning() {
    MotionState state(2.5f, 28.0f, 15.0f);
    state.setTuning(3.0f, 30.0f);
    state.safeStop();
    TEST_ASSERT_EQUAL_INT((int)MotionMode::Stopped, (int)state.snapshot().mode);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 90.0f, state.angleAt(1.2f));
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 3.0f, state.snapshot().frequency);
}

void test_tuning_rejects_invalid_ranges() {
    MotionState state(2.5f, 28.0f, 15.0f);
    TEST_ASSERT_FALSE(state.setTuning(0.2f, 20.0f));
    TEST_ASSERT_FALSE(state.setTuning(2.0f, 51.0f));
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 2.5f, state.snapshot().frequency);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 28.0f, state.snapshot().amplitude);
}

void runTests() {
    UNITY_BEGIN();
    RUN_TEST(test_direction_preserves_tuning);
    RUN_TEST(test_stop_centers_tail_without_erasing_tuning);
    RUN_TEST(test_tuning_rejects_invalid_ranges);
    UNITY_END();
}

#ifdef ARDUINO
void setup() { delay(2000); runTests(); }
void loop() {}
#else
int main(int, char**) { runTests(); return 0; }
#endif
