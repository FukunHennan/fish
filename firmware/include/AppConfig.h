/*
 * ============================================
 *     机器鱼 · 固件参数默认值
 * ============================================
 *
 * 手动配置统一修改 config/firmware.json。
 * 本文件只保留未经过 PlatformIO 配置注入时的编译默认值。
 */


/* Wi-Fi 和控制器配置通过 Fish-Setup-XXXXXX 热点写入 NVS。 */
#define FIRMWARE_VERSION "2.0.0"

/* Allow short Wi-Fi stalls without falsely declaring the controller lost. */
#ifndef CONTROLLER_HEARTBEAT_TIMEOUT_MS
#define CONTROLLER_HEARTBEAT_TIMEOUT_MS 10000
#endif

/* If Wi-Fi is connected but the controller is not registered, keep announcing
 * the fish on the LAN. The controller replies with its current WebSocket port,
 * so users do not have to type a controller IP during normal setup. */
#ifndef CONTROLLER_DISCOVERY_ANNOUNCE_INTERVAL_MS
#define CONTROLLER_DISCOVERY_ANNOUNCE_INTERVAL_MS 1000
#endif
#ifndef CONTROLLER_DISCOVERY_SCAN_INTERVAL_MS
#define CONTROLLER_DISCOVERY_SCAN_INTERVAL_MS 220
#endif
#ifndef CONTROLLER_DISCOVERY_SCAN_TIMEOUT_MS
#define CONTROLLER_DISCOVERY_SCAN_TIMEOUT_MS 260
#endif
#ifndef CONTROLLER_DISCOVERY_NEAR_SCAN_RADIUS
#define CONTROLLER_DISCOVERY_NEAR_SCAN_RADIUS 96
#endif
#ifndef CONTROLLER_REGISTRATION_RECOVERY_MS
#define CONTROLLER_REGISTRATION_RECOVERY_MS 180000
#endif
#ifndef CONTROLLER_PROVISIONING_WINDOW_MS
#define CONTROLLER_PROVISIONING_WINDOW_MS 300000
#endif
#ifndef CONTROLLER_ENDPOINT_REGISTRATION_TIMEOUT_MS
#define CONTROLLER_ENDPOINT_REGISTRATION_TIMEOUT_MS 15000
#endif

/* Single-color on-board LED. It is a normal GPIO LED, not an RGB/WS2812. */
#ifndef STATUS_LED_PIN
#define STATUS_LED_PIN 8
#endif
#ifndef STATUS_LED_ACTIVE_LOW
#define STATUS_LED_ACTIVE_LOW false
#endif

/* On-board BOOT button: active-low GPIO9 on XIAO ESP32-C3. */
#ifndef BOOT_BUTTON_PIN
#define BOOT_BUTTON_PIN 9
#endif
#ifndef BOOT_LONG_PRESS_MS
#define BOOT_LONG_PRESS_MS 3000
#endif

/* Super Mini mounted on the original XIAO PCB footprint:
 * servo: original XIAO D8 -> Super Mini GPIO2
 * battery divider: original XIAO A0 -> Super Mini GPIO4 (ADC1)
 */
#ifndef BATTERY_SENSE_PIN
#define BATTERY_SENSE_PIN 4
#endif
#ifndef BATTERY_DIVIDER_RATIO
#define BATTERY_DIVIDER_RATIO 3.0f
#endif
#ifndef BATTERY_EMPTY_VOLTAGE
#define BATTERY_EMPTY_VOLTAGE 7.0f
#endif
#ifndef BATTERY_FULL_VOLTAGE
#define BATTERY_FULL_VOLTAGE 7.4f
#endif
#ifndef BATTERY_SAMPLE_INTERVAL_MS
#define BATTERY_SAMPLE_INTERVAL_MS 10000
#endif

/* ========================================== */
/*             1. 引脚定义                     */
/* ========================================== */
/*  除非更换了接线，否则不用改这一部分          */

#ifndef SERVO_PIN
#define SERVO_PIN   2       // 原 XIAO D8 焊盘 / Super Mini GPIO2
#endif


/* ========================================== */
/*             2. 游泳参数(默认值)             */
/* ========================================== */
/*  这两个是最重要的参数！直接影响鱼怎么游     */
/*  在网页上可以实时调节这两个值               */

#ifndef SWIM_SPEED
#define SWIM_SPEED      2.5     // 摆尾快慢  建议 1.0 ~ 4.0  (越大越快)
#endif
#ifndef SWIM_POWER
#define SWIM_POWER      28.0    // 摆尾幅度  建议 10  ~ 40   (越大摆得越猛)
#endif
#ifndef TURN_AMOUNT
#define TURN_AMOUNT     45.0    // 默认左右转中心偏置：左 -45°，右 +45°
#endif
