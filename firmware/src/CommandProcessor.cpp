#include "CommandProcessor.h"

String CommandProcessor::process(String c){
    c.trim();c.toUpperCase();
    if(c=="FWD")motion_.setMode(MotionMode::Forward);
    else if(c=="LEFT")motion_.setMode(MotionMode::Left);
    else if(c=="RIGHT")motion_.setMode(MotionMode::Right);
    else if(c=="STOP")motion_.safeStop();
    else if(c=="IDLE")motion_.setMode(MotionMode::Idle);
    else if(c.startsWith("FREQ:")){float f=c.substring(5).toFloat();auto s=motion_.snapshot();motion_.setTuning(f,s.amplitude);}
    else if(c.startsWith("AMP:")){float a=c.substring(4).toFloat();auto s=motion_.snapshot();motion_.setTuning(s.frequency,a);}
    else return "未知命令";
    return "OK";
}
