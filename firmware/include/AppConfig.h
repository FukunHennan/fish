/*
 * ============================================
 *     机器鱼 · 参数设置文件
 * ============================================
 *
 * 同学们好！
 * 这个文件里的数字都可以修改！
 * 修改后点"上传"按钮，就能看到变化了！
 *
 * 提示: 每个参数后面都写了建议范围，
 *       超出范围可能会让鱼行为异常哦～
 */


/* Wi-Fi 和控制器配置通过 Fish-Setup-XXXXXX 热点写入 NVS。 */
#define FIRMWARE_VERSION "2.0.0"

/* Allow short Wi-Fi stalls without falsely declaring the controller lost. */
#define CONTROLLER_HEARTBEAT_TIMEOUT_MS 10000

/* If Wi-Fi is connected but the controller is not registered, keep announcing
 * the fish on the LAN. The controller replies with its current WebSocket port,
 * so users do not have to type a controller IP during normal setup. */
#define CONTROLLER_DISCOVERY_ANNOUNCE_INTERVAL_MS 1000
#define CONTROLLER_DISCOVERY_SCAN_INTERVAL_MS 220
#define CONTROLLER_DISCOVERY_SCAN_TIMEOUT_MS 260
#define CONTROLLER_DISCOVERY_NEAR_SCAN_RADIUS 96
#define CONTROLLER_REGISTRATION_RECOVERY_MS 180000
#define CONTROLLER_PROVISIONING_WINDOW_MS 300000
#define CONTROLLER_ENDPOINT_REGISTRATION_TIMEOUT_MS 15000

/* Single-color on-board LED. It is a normal GPIO LED, not an RGB/WS2812. */
#define STATUS_LED_PIN 8
#define STATUS_LED_ACTIVE_LOW false

/* On-board BOOT button: active-low GPIO9 on XIAO ESP32-C3. */
#define BOOT_BUTTON_PIN 9
#define BOOT_LONG_PRESS_MS 3000

/* Super Mini mounted on the original XIAO PCB footprint:
 * servo: original XIAO D8 -> Super Mini GPIO2
 * battery divider: original XIAO A0 -> Super Mini GPIO4 (ADC1)
 */
#define BATTERY_SENSE_PIN 4
#define BATTERY_DIVIDER_RATIO 3.0f
#define BATTERY_EMPTY_VOLTAGE 7.0f
#define BATTERY_FULL_VOLTAGE 7.4f
#define BATTERY_SAMPLE_INTERVAL_MS 10000

/* ========================================== */
/*             1. 引脚定义                     */
/* ========================================== */
/*  除非更换了接线，否则不用改这一部分          */

#define SERVO_PIN   2       // 原 XIAO D8 焊盘 / Super Mini GPIO2


/* ========================================== */
/*             2. 游泳参数(默认值)             */
/* ========================================== */
/*  这两个是最重要的参数！直接影响鱼怎么游     */
/*  在网页上可以实时调节这两个值               */

#define SWIM_SPEED      2.5     // 摆尾快慢  建议 1.0 ~ 4.0  (越大越快)
#define SWIM_POWER      28.0    // 摆尾幅度  建议 10  ~ 40   (越大摆得越猛)
#define TURN_AMOUNT     45.0    // 默认左右转中心偏置：左 -45°，右 +45°
