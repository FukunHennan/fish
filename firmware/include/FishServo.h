#pragma once
#include <Arduino.h>

class FishServo {
public:
    void attach(int pin);
    void detach();
    void write(int angle);
    bool attached() const { return attached_; }
private:
    int pin_ = -1;
    int channel_ = 1;
    bool attached_ = false;
};

