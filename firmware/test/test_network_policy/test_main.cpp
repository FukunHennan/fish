#include <unity.h>
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include "NetworkPolicy.h"
#include "DiscoveryNonceWindow.h"
#include <string>

void test_unconfigured_device_provisions_immediately() {
    NetworkPolicy policy;
    policy.begin(false, 0);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning, (int)policy.next(0));
}

void test_configured_device_falls_back_after_three_minutes() {
    NetworkPolicy policy;
    policy.begin(true, 0);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::Connect, (int)policy.next(0));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)policy.next(179999));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning, (int)policy.next(180000));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)policy.next(479999));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::Connect, (int)policy.next(480000));
}

void test_connected_state_disables_fallback() {
    NetworkPolicy policy;
    policy.begin(true, 0);
    policy.next(0);
    policy.setConnected(true, 1000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)policy.next(70000));
}

void test_wifi_without_server_enters_recovery() {
    NetworkPolicy p;p.begin(true,0);p.next(0);p.setConnected(true,1000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None,(int)p.next(179999));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning,(int)p.next(180000));
}
void test_registration_and_later_disconnect_restart_deadline() {
    NetworkPolicy p;p.begin(true,0);p.next(0);p.setConnected(true,1000);p.setRegistered(true,2000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None,(int)p.next(300000));
    p.setRegistered(false,300001);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None,(int)p.next(480000));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning,(int)p.next(480001));
}

void test_registration_failure_keeps_retrying_after_setup_window() {
    NetworkPolicy p;
    p.begin(true, 0, 180000, 60000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::Connect, (int)p.next(0));
    p.setConnected(true, 1000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning, (int)p.next(180000));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)p.next(239999));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::Connect, (int)p.next(240000));
    p.setConnected(false, 250000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::Connect, (int)p.next(250001));
}

void test_saved_configuration_can_retry_after_provisioning() {
    NetworkPolicy p;
    p.begin(false, 0, 180000, 60000);
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::StartProvisioning, (int)p.next(0));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)p.next(60000));
    TEST_ASSERT_EQUAL_INT((int)NetworkAction::None, (int)p.next(3600000));
}

void test_delayed_discovery_reply_and_expiry() {
    DiscoveryNonceWindow<std::string> window;
    window.remember("first",100);window.remember("second",1100);
    TEST_ASSERT_TRUE(window.contains("first",1200));
    TEST_ASSERT_TRUE(window.contains("second",1200));
    TEST_ASSERT_FALSE(window.contains("unknown",1200));
    TEST_ASSERT_FALSE(window.contains("first",10101));
    TEST_ASSERT_TRUE(window.contains("second",10101));
}
void test_discovery_nonce_wraparound_and_eviction() {
    DiscoveryNonceWindow<std::string> window;
    window.remember("before-wrap",UINT32_MAX-100);
    TEST_ASSERT_TRUE(window.contains("before-wrap",100));
    TEST_ASSERT_FALSE(window.contains("before-wrap",10000));
    for(int i=0;i<16;i++)window.remember(std::to_string(i),200);
    TEST_ASSERT_FALSE(window.contains("before-wrap",201));
    TEST_ASSERT_TRUE(window.contains("15",201));
}

void runTests() {
    UNITY_BEGIN();
    RUN_TEST(test_unconfigured_device_provisions_immediately);
    RUN_TEST(test_configured_device_falls_back_after_three_minutes);
    RUN_TEST(test_connected_state_disables_fallback);
    RUN_TEST(test_wifi_without_server_enters_recovery);
    RUN_TEST(test_registration_and_later_disconnect_restart_deadline);
    RUN_TEST(test_registration_failure_keeps_retrying_after_setup_window);
    RUN_TEST(test_saved_configuration_can_retry_after_provisioning);
    RUN_TEST(test_delayed_discovery_reply_and_expiry);
    RUN_TEST(test_discovery_nonce_wraparound_and_eviction);
    UNITY_END();
}

#ifdef ARDUINO
void setup() { delay(2000); runTests(); }
void loop() {}
#else
int main(int, char**) { runTests(); return 0; }
#endif
