#include "FishServo.h"

void FishServo::attach(int pin) {
    if (attached_ && pin_ == pin) return;
    pin_ = pin;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(pin_, 50, 14);
#else
    ledcSetup(channel_, 50, 14);
    ledcAttachPin(pin_, channel_);
#endif
    attached_ = true;
}

void FishServo::detach() {
    if (!attached_ || pin_ < 0) return;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcDetach(pin_);
#else
    ledcDetachPin(pin_);
#endif
    attached_ = false;
}

void FishServo::write(int angle) {
    if (!attached_) return;
    int duty = map(angle, 0, 180, 410, 2048);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(pin_, duty);
#else
    ledcWrite(channel_, duty);
#endif
}
