#include <Arduino.h>
#include <esp_ota_ops.h>
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

ConfigStore configStore;
DeviceConfig deviceConfig;
NetworkManager network(configStore);
MotionController motion(SERVO_PIN,SWIM_SPEED,SWIM_POWER,TURN_AMOUNT);
CommandProcessor commands(motion);
BatteryMonitor battery(BATTERY_SENSE_PIN,BATTERY_DIVIDER_RATIO,BATTERY_EMPTY_VOLTAGE,BATTERY_FULL_VOLTAGE,BATTERY_SAMPLE_INTERVAL_MS);
StatusLight statusLight(STATUS_LED_PIN, STATUS_LED_ACTIVE_LOW);
ControllerClient controller(motion,commands,battery,statusLight,configStore);
DiscoveryResponder discovery(motion,controller);
BootButton bootButton(BOOT_BUTTON_PIN,BOOT_LONG_PRESS_MS);
bool provisioningResetPending=false;
uint32_t bootReleasedAt=0;
bool wasProvisioning=false;

extern "C" bool verifyRollbackLater(){return true;}

void confirmRunningOtaImage(){
    const esp_partition_t* running=esp_ota_get_running_partition();
    if(!running){Serial.println("OTA: running partition unavailable");return;}
    esp_ota_img_states_t state=ESP_OTA_IMG_UNDEFINED;
    esp_err_t error=esp_ota_get_state_partition(running,&state);
    if(error==ESP_OK&&state==ESP_OTA_IMG_PENDING_VERIFY){
        error=esp_ota_mark_app_valid_cancel_rollback();
        Serial.printf("OTA: startup confirmation %s\n",esp_err_to_name(error));
    }
}

void requestProvisioningReset(const char* reason){
    if(provisioningResetPending)return;
    if(reason&&reason[0])Serial.println(reason);
    motion.safeStop();configStore.clear();provisioningResetPending=true;
}

void serviceProvisioningReset(uint32_t now){
    if(motion.snapshot().mode!=MotionMode::Stopped)motion.safeStop();
    statusLight.setMode(StatusLightMode::Provisioning);statusLight.update(now);
    if(digitalRead(BOOT_BUTTON_PIN)==LOW){bootReleasedAt=0;return;}
    if(bootReleasedAt==0){bootReleasedAt=now;return;}
    if(now-bootReleasedAt>=100)ESP.restart();
}

void setup(){
    Serial.begin(115200);delay(100);
    statusLight.begin();bootButton.begin();battery.begin();
    configStore.load(deviceConfig);
    motion.setNeutralCenter(deviceConfig.servoCenter);
    motion.begin();
    network.begin(deviceConfig);controller.begin(deviceConfig);discovery.begin(deviceConfig);
    confirmRunningOtaImage();
}

void loop(){
    uint32_t now=millis();
    if(provisioningResetPending){serviceProvisioningReset(now);return;}
    battery.update(now);network.update(now,controller.registered());
    if(wasProvisioning && !network.provisioning()){
        controller.begin(deviceConfig);
        discovery.begin(deviceConfig);
    }
    wasProvisioning=network.provisioning();
    if(network.provisioning()){
        if(motion.snapshot().mode!=MotionMode::Stopped)motion.safeStop();
        controller.update(now,false);
    }
    else {
        discovery.update();
        controller.update(now,network.connected());
        if (!network.connected() || !controller.registered()) motion.safeStop();
    }
    motion.update(now);
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
