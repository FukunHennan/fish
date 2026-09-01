#include <unity.h>
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include "VisualController.h"

void test_positive_error_turns_left_with_negative_servo_bias() {
    VisualController controller;
    TEST_ASSERT_TRUE(controller.start("session-1", 0));
    VisualInput input{1, 2.0f, 0.0f, 1.0f, 0.2f, 0.0f, false};
    VisualOutput output;
    TEST_ASSERT_TRUE(controller.update("session-1", input, 100, output));
    TEST_ASSERT_TRUE(output.bias < 0.0f);
    TEST_ASSERT_TRUE(-output.bias <= controller.parameters().maxBias);
}

void test_rejects_old_sequence_and_wrong_session() {
    VisualController controller;
    controller.start("session-1", 0);
    VisualOutput output;
    TEST_ASSERT_TRUE(controller.update("session-1", {2,0.1f,0,1,0,0,false}, 100, output));
    TEST_ASSERT_FALSE(controller.update("session-1", {2,0.1f,0,1,0,0,false}, 120, output));
    TEST_ASSERT_FALSE(controller.update("other", {3,0.1f,0,1,0,0,false}, 140, output));
}

void test_brake_requests_safe_stop() {
    VisualController controller;
    controller.start("session-1", 0);
    VisualOutput output;
    TEST_ASSERT_TRUE(controller.update("session-1", {1,0,0,0.05f,0.3f,0,true}, 100, output));
    TEST_ASSERT_TRUE(output.stop);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, output.amplitude);
}

void test_session_times_out() {
    VisualController controller;
    controller.start("session-1", 0);
    TEST_ASSERT_FALSE(controller.timedOut(499));
    TEST_ASSERT_TRUE(controller.timedOut(500));
}

void runTests(){UNITY_BEGIN();RUN_TEST(test_positive_error_turns_left_with_negative_servo_bias);RUN_TEST(test_rejects_old_sequence_and_wrong_session);RUN_TEST(test_brake_requests_safe_stop);RUN_TEST(test_session_times_out);UNITY_END();}
#ifdef ARDUINO
void setup(){delay(2000);runTests();} void loop(){}
#else
int main(int,char**){runTests();return 0;}
#endif
