#include "FishServo.h"

void FishServo::attach(int pin) {
    pin_ = pin;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(pin_, 50, 14);
#else
    ledcSetup(channel_, 50, 14);
    ledcAttachPin(pin_, channel_);
#endif
}

void FishServo::write(int angle) {
    int duty = map(constrain(angle, 0, 180), 0, 180, 410, 2048);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(pin_, duty);
#else
    ledcWrite(channel_, duty);
#endif
}

