#include <Arduino.h>
#include "AppConfig.h"
#include "ConfigStore.h"
#include "NetworkManager.h"
#include "MotionController.h"
#include "CommandProcessor.h"
#include "ControllerClient.h"
#include "DiscoveryResponder.h"

ConfigStore configStore;
DeviceConfig deviceConfig;
NetworkManager network(configStore);
MotionController motion(SERVO_PIN,SWIM_SPEED,SWIM_POWER,TURN_AMOUNT);
CommandProcessor commands(motion);
VisualController visual;
ControllerClient controller(motion,commands,visual);
DiscoveryResponder discovery(motion,controller);

void setup(){
    Serial.begin(115200);delay(100);Serial.println("\n机器鱼中央控制固件 v1.1.0");
    motion.begin();configStore.load(deviceConfig);network.begin(deviceConfig);controller.begin(deviceConfig);discovery.begin(deviceConfig);
    Serial.println("串口命令: FWD LEFT RIGHT STOP IDLE FREQ:x AMP:x CLEAR_CONFIG");
}

void loop(){
    uint32_t now=millis();network.update(now);discovery.update();controller.update(now,network.connected());motion.update(now);
    if(Serial.available()){
        String c=Serial.readStringUntil('\n');c.trim();
        if(c.equalsIgnoreCase("CLEAR_CONFIG")){motion.safeStop();configStore.clear();Serial.println("配置已清除，正在重启");delay(200);ESP.restart();}
        else Serial.println(commands.process(c));
    }
}
