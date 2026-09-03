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
BatteryMonitor battery(BATTERY_SENSE_PIN,BATTERY_DIVIDER_RATIO,BATTERY_EMPTY_VOLTAGE,BATTERY_FULL_VOLTAGE,BATTERY_SAMPLE_INTERVAL_MS);
AmbientLightMonitor ambientLight(AMBIENT_LIGHT_SAMPLE_INTERVAL_MS);
StatusLight statusLight(STATUS_LED_PIN,STATUS_LED_COUNT,STATUS_LED_BRIGHTNESS);
ControllerClient controller(motion,commands,battery,ambientLight,statusLight,configStore);
DiscoveryResponder discovery(motion,controller);
BootButton bootButton(BOOT_BUTTON_PIN,BOOT_LONG_PRESS_MS);
bool provisioningResetPending=false;
uint32_t bootReleasedAt=0;

void requestProvisioningReset(const char* reason){
    if(provisioningResetPending)return;
    if(reason&&reason[0])Serial.println(reason);
    motion.safeStop();configStore.clear();provisioningResetPending=true;
}

void serviceProvisioningReset(uint32_t now){
    motion.safeStop();statusLight.setMode(StatusLightMode::Provisioning);statusLight.update(now);
    if(digitalRead(BOOT_BUTTON_PIN)==LOW){bootReleasedAt=0;return;}
    if(bootReleasedAt==0){bootReleasedAt=now;return;}
    if(now-bootReleasedAt>=100)ESP.restart();
}

void setup(){
    Serial.begin(115200);delay(100);
    statusLight.begin();bootButton.begin();battery.begin();ambientLight.begin();
    configStore.load(deviceConfig);
    motion.setNeutralCenter(deviceConfig.servoCenter);
    motion.begin();
    network.begin(deviceConfig);controller.begin(deviceConfig);discovery.begin(deviceConfig);
}

void loop(){
    uint32_t now=millis();
    if(provisioningResetPending){serviceProvisioningReset(now);return;}
    battery.update(now);ambientLight.update(now);network.update(now);discovery.update();controller.update(now,network.connected());motion.update(now);
    StatusLightMode lightMode;
    if(network.provisioning()) lightMode=StatusLightMode::Provisioning;
    else if(!network.connected()) lightMode=StatusLightMode::WifiConnecting;
    else if(controller.otaActive()) lightMode=StatusLightMode::Ota;
    else if(controller.otaFailed()) lightMode=StatusLightMode::Error;
    else if(motion.snapshot().mode!=MotionMode::Stopped) lightMode=StatusLightMode::ManualMotion;
    else if(controller.registered()) lightMode=StatusLightMode::Ready;
    else lightMode=StatusLightMode::Discovering;
    statusLight.setMode(lightMode);statusLight.update(now);
    if(bootButton.update(now)){requestProvisioningReset("BOOT 长按：配置已清除；松开按键后重启进入配网模式");return;}
    if(Serial.available()){
        String c=Serial.readStringUntil('\n');c.trim();
        if(c.equalsIgnoreCase("CLEAR_CONFIG"))requestProvisioningReset("配置已清除，正在重启进入配网模式");
        else Serial.println(commands.process(c));
    }
}
