#include <map>
#include <string>
#include <unity.h>
#include "ConfigPersistence.h"

struct TestConfig {
    std::string ssid, password, controllerHost, displayName;
    unsigned short controllerPort = 8081;
    float servoCenter = 90.0f;
};

class FakePreferences {
public:
    size_t putString(const char* key, const std::string& value) { strings[key] = value; return value.size(); }
    size_t putUShort(const char* key, unsigned short value) { numbers[key] = value; return sizeof(value); }
    size_t putFloat(const char* key, float value) { floats[key] = value; return sizeof(value); }
    std::string getString(const char* key) { return strings[key]; }
    unsigned short getUShort(const char* key, unsigned short fallback) { return numbers.count(key) ? numbers[key] : fallback; }
    float getFloat(const char* key, float fallback) { return floats.count(key) ? floats[key] : fallback; }
private:
    std::map<std::string,std::string> strings;
    std::map<std::string,unsigned short> numbers;
    std::map<std::string,float> floats;
};

void test_empty_optional_values_are_saved_when_readback_matches() {
    FakePreferences preferences;
    TestConfig config{"Open-WiFi", "", "", "机器鱼", 8081, 103.5f};
    TEST_ASSERT_TRUE(writeAndVerifyDeviceConfig(preferences, config));
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_empty_optional_values_are_saved_when_readback_matches);
    return UNITY_END();
}
