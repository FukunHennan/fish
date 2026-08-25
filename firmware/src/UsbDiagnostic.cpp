#ifdef USB_DIAGNOSTIC
#include <Arduino.h>
#ifdef USB_DIAGNOSTIC_SERVO
#include "AppConfig.h"
#include "FishServo.h"

static FishServo diagnosticServo;
#endif
#ifdef USB_DIAGNOSTIC_CONFIG
#include "ConfigStore.h"

static ConfigStore diagnosticConfigStore;
static DeviceConfig diagnosticConfig;
#endif
#ifdef USB_DIAGNOSTIC_NETWORK
#include "NetworkManager.h"

static NetworkManager diagnosticNetwork(diagnosticConfigStore);
#endif
#ifdef USB_DIAGNOSTIC_CONTROLLER
#include "CommandProcessor.h"
#include "ControllerClient.h"

static MotionController diagnosticMotion(SERVO_PIN, SWIM_SPEED, SWIM_POWER, TURN_AMOUNT);
static CommandProcessor diagnosticCommands(diagnosticMotion);
static VisualController diagnosticVisual;
static ControllerClient diagnosticController(diagnosticMotion, diagnosticCommands, diagnosticVisual);
#endif

static uint32_t lastReport = 0;
static uint32_t counter = 0;

void setup() {
    Serial.begin(115200);
    delay(500);
#if defined(USB_DIAGNOSTIC_SERVO) && !defined(USB_DIAGNOSTIC_CONTROLLER)
    diagnosticServo.attach(SERVO_PIN);
    diagnosticServo.write(90);
#endif
#ifdef USB_DIAGNOSTIC_CONFIG
    diagnosticConfigStore.load(diagnosticConfig);
#endif
#ifdef USB_DIAGNOSTIC_NETWORK
    diagnosticNetwork.begin(diagnosticConfig);
#endif
#ifdef USB_DIAGNOSTIC_CONTROLLER
    diagnosticMotion.begin();
    diagnosticController.begin(diagnosticConfig);
#endif
    Serial.println("USB_DIAGNOSTIC_READY");
}

void loop() {
    uint32_t now = millis();
#ifdef USB_DIAGNOSTIC_NETWORK
    diagnosticNetwork.update(now);
#endif
#ifdef USB_DIAGNOSTIC_CONTROLLER
    diagnosticController.update(now, diagnosticNetwork.connected());
    diagnosticMotion.update(now);
#endif
    if (now - lastReport >= 1000) {
        lastReport = now;
        Serial.printf("USB_ALIVE %lu\n", (unsigned long)++counter);
    }
}
#endif
