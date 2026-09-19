#include <unity.h>
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include "MotionState.h"

void test_direction_preserves_tuning() {
    MotionState state(2.5f, 28.0f, 45.0f);
    state.setTuning(3.2f, 31.0f);
    state.setMode(MotionMode::Left);
    MotionSnapshot value = state.snapshot();
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 3.2f, value.frequency);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 31.0f, value.amplitude);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, value.bias);

    state.setMode(MotionMode::Right);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, state.snapshot().bias);
}

void test_custom_turn_bias_overrides_default_left_and_right_bias() {
    MotionState state(2.5f, 28.0f, 45.0f);

    state.setMode(MotionMode::Left);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, state.snapshot().bias);
    state.setBias(32.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 32.0f, state.snapshot().bias);

    state.setMode(MotionMode::Right);
    state.setBias(-27.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, -27.0f, state.snapshot().bias);
}

void test_stop_centers_tail_without_erasing_tuning() {
    MotionState state(2.5f, 28.0f, 45.0f);
    state.setTuning(3.0f, 30.0f);
    state.safeStop();
    TEST_ASSERT_EQUAL_INT((int)MotionMode::Stopped, (int)state.snapshot().mode);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 90.0f, state.angleAt(1.2f));
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 3.0f, state.snapshot().frequency);
}

void test_calibrated_neutral_center_is_used_after_stop_and_motion() {
    MotionState state(2.5f, 28.0f, 45.0f);
    state.setNeutralCenter(100.0f);
    state.safeStop();
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 100.0f, state.angleAt(1.2f));
    state.setMode(MotionMode::Forward);
    state.setBias(0.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 100.0f, state.angleAt(0.0f));
}

void test_idle_holds_neutral_instead_of_swimming() {
    MotionState state(2.5f, 28.0f, 45.0f);
    state.setNeutralCenter(96.0f);
    state.setMode(MotionMode::Idle);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 96.0f, state.angleAt(0.0f));
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 96.0f, state.angleAt(1.5707963f));
}

void test_tuning_accepts_controller_parameters() {
    MotionState state(2.5f, 28.0f, 45.0f);
    state.setTuning(0.2f, 51.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.2f, state.snapshot().frequency);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 51.0f, state.snapshot().amplitude);
    state.setBias(80.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 80.0f, state.snapshot().bias);
}

void test_angle_is_not_clamped_by_motion_state() {
    MotionState state(2.5f, 100.0f, 45.0f);
    state.setMode(MotionMode::Forward);
    state.setBias(90.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 280.0f, state.angleAt(1.5707963f));
}

void test_only_stationary_to_motion_transition_requests_phase_reset() {
    MotionState state(2.5f, 28.0f, 45.0f);

    TEST_ASSERT_TRUE(state.setMode(MotionMode::Forward));
    TEST_ASSERT_FALSE(state.setMode(MotionMode::Forward));
    TEST_ASSERT_FALSE(state.setMode(MotionMode::Left));
    TEST_ASSERT_FALSE(state.setMode(MotionMode::Right));

    TEST_ASSERT_FALSE(state.setMode(MotionMode::Idle));
    TEST_ASSERT_TRUE(state.setMode(MotionMode::Forward));
    state.safeStop();
    TEST_ASSERT_TRUE(state.setMode(MotionMode::Left));
}

void test_motion_transition_ramps_amplitude_and_bias_over_requested_duration() {
    MotionTransition transition;
    transition.reset(0.0f, 0.0f);
    transition.setTarget(30.0f, -40.0f, 600);
    transition.update(0.3f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 15.0f, transition.amplitude());
    TEST_ASSERT_FLOAT_WITHIN(0.01f, -20.0f, transition.bias());
    TEST_ASSERT_FALSE(transition.settled());
    transition.update(0.3f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 30.0f, transition.amplitude());
    TEST_ASSERT_FLOAT_WITHIN(0.01f, -40.0f, transition.bias());
    TEST_ASSERT_TRUE(transition.settled());
}

void test_repeated_keepalive_does_not_restart_motion_transition() {
    MotionTransition transition;
    transition.reset(0.0f, 0.0f);
    transition.setTarget(30.0f, 20.0f, 600);
    transition.update(0.2f);
    transition.setTarget(30.0f, 20.0f, 600);
    transition.update(0.4f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 30.0f, transition.amplitude());
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 20.0f, transition.bias());
    TEST_ASSERT_TRUE(transition.settled());
}

void runTests() {
    UNITY_BEGIN();
    RUN_TEST(test_direction_preserves_tuning);
    RUN_TEST(test_custom_turn_bias_overrides_default_left_and_right_bias);
    RUN_TEST(test_stop_centers_tail_without_erasing_tuning);
    RUN_TEST(test_calibrated_neutral_center_is_used_after_stop_and_motion);
    RUN_TEST(test_idle_holds_neutral_instead_of_swimming);
    RUN_TEST(test_tuning_accepts_controller_parameters);
    RUN_TEST(test_angle_is_not_clamped_by_motion_state);
    RUN_TEST(test_only_stationary_to_motion_transition_requests_phase_reset);
    RUN_TEST(test_motion_transition_ramps_amplitude_and_bias_over_requested_duration);
    RUN_TEST(test_repeated_keepalive_does_not_restart_motion_transition);
    UNITY_END();
}

#ifdef ARDUINO
void setup() { delay(2000); runTests(); }
void loop() {}
#else
int main(int, char**) { runTests(); return 0; }
#endif
