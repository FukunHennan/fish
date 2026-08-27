#include <Arduino.h>
#include "AppConfig.h"
#include "ConfigStore.h"
#include "NetworkManager.h"
#include "MotionController.h"
#include "CommandProcessor.h"
#include "ControllerClient.h"
#include "DiscoveryResponder.h"
#include "StatusLight.h"
#include "BootButton.h"
#include "BatteryMonitor.h"
#include "AmbientLightMonitor.h"

ConfigStore configStore;
DeviceConfig deviceConfig;
NetworkManager network(configStore);
MotionController motion(SERVO_PIN,SWIM_SPEED,SWIM_POWER,TURN_AMOUNT);
CommandProcessor commands(motion);
VisualController visual;
BatteryMonitor battery(BATTERY_SENSE_PIN,BATTERY_DIVIDER_RATIO,BATTERY_EMPTY_VOLTAGE,BATTERY_FULL_VOLTAGE,BATTERY_SAMPLE_INTERVAL_MS);
AmbientLightMonitor ambientLight(AMBIENT_LIGHT_SAMPLE_INTERVAL_MS);
StatusLight statusLight(STATUS_LED_PIN,STATUS_LED_COUNT,STATUS_LED_BRIGHTNESS);
ControllerClient controller(motion,commands,visual,battery,ambientLight,statusLight);
DiscoveryResponder discovery(motion,controller);
BootButton bootButton(BOOT_BUTTON_PIN,BOOT_LONG_PRESS_MS);
bool provisioningResetPending=false;
uint32_t bootReleasedAt=0;

void requestProvisioningReset(const char* reason){
    if(provisioningResetPending)return;
    motion.safeStop();configStore.clear();provisioningResetPending=true;Serial.println(reason);
}

void serviceProvisioningReset(uint32_t now){
    motion.safeStop();statusLight.setMode(StatusLightMode::Provisioning);statusLight.update(now);
    if(digitalRead(BOOT_BUTTON_PIN)==LOW){bootReleasedAt=0;return;}
    if(bootReleasedAt==0){bootReleasedAt=now;return;}
    if(now-bootReleasedAt>=100)ESP.restart();
}

void setup(){
    Serial.begin(115200);delay(100);Serial.printf("\n机器鱼中央控制固件 v%s\n",FIRMWARE_VERSION);
    statusLight.begin();bootButton.begin();battery.begin();ambientLight.begin();motion.begin();configStore.load(deviceConfig);network.begin(deviceConfig);controller.begin(deviceConfig);discovery.begin(deviceConfig);
    Serial.println("串口命令: FWD LEFT RIGHT STOP IDLE FREQ:x AMP:x CLEAR_CONFIG");
}

void loop(){
    uint32_t now=millis();
    if(provisioningResetPending){serviceProvisioningReset(now);return;}
    battery.update(now);ambientLight.update(now);network.update(now);discovery.update();controller.update(now,network.connected());motion.update(now);
    StatusLightMode lightMode=!network.connected()?StatusLightMode::Provisioning:(controller.registered()?StatusLightMode::Ready:StatusLightMode::Registering);
    statusLight.setMode(lightMode);statusLight.update(now);
    if(bootButton.update(now)){requestProvisioningReset("BOOT 长按：配置已清除；松开按键后重启进入配网模式");return;}
    if(Serial.available()){
        String c=Serial.readStringUntil('\n');c.trim();
        if(c.equalsIgnoreCase("CLEAR_CONFIG"))requestProvisioningReset("配置已清除，正在重启进入配网模式");
        else Serial.println(commands.process(c));
    }
}
