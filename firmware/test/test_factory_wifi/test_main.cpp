#include <string>
#include <unity.h>
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include "FactoryWifi.h"

struct TestConfig {
    std::string ssid;
    std::string password;
};

void test_empty_wifi_does_not_ship_network_credentials() {
    TestConfig config;
    applyFactoryWifiDefaults(config);
    TEST_ASSERT_EQUAL_STRING("", config.ssid.c_str());
    TEST_ASSERT_EQUAL_STRING("", config.password.c_str());
}

void test_saved_wifi_overrides_factory_credentials() {
    TestConfig config{"Lab-WiFi", "saved-password"};
    applyFactoryWifiDefaults(config);
    TEST_ASSERT_EQUAL_STRING("Lab-WiFi", config.ssid.c_str());
    TEST_ASSERT_EQUAL_STRING("saved-password", config.password.c_str());
}

void runTests() {
    UNITY_BEGIN();
    RUN_TEST(test_empty_wifi_does_not_ship_network_credentials);
    RUN_TEST(test_saved_wifi_overrides_factory_credentials);
    UNITY_END();
}

#ifdef ARDUINO
void setup() { delay(2000); runTests(); }
void loop() {}
#else
int main(int, char**) { runTests(); return 0; }
#endif
