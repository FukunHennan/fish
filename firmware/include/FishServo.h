#pragma once
#include <Arduino.h>

class FishServo {
public:
    void attach(int pin);
    void write(int angle);
private:
    int pin_ = -1;
    int channel_ = 1;
};

