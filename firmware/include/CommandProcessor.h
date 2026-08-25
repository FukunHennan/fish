#pragma once
#include <Arduino.h>
#include "MotionController.h"

class CommandProcessor {
public:
    explicit CommandProcessor(MotionController& motion):motion_(motion){}
    String process(String command);
private:
    MotionController& motion_;
};

