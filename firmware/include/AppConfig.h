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
#define FIRMWARE_VERSION "1.2.8"

/* Allow short Wi-Fi stalls without falsely declaring the controller lost. */
#define CONTROLLER_HEARTBEAT_TIMEOUT_MS 8000

/* Four WS2812 status LEDs connected to XIAO ESP32-C3 D3 / GPIO5. */
#define STATUS_LED_PIN   D3
#define STATUS_LED_COUNT 4
#define STATUS_LED_BRIGHTNESS 32

/* On-board BOOT button: active-low GPIO9 on XIAO ESP32-C3. */
#define BOOT_BUTTON_PIN 9
#define BOOT_LONG_PRESS_MS 3000

/* Battery voltage divider connected to XIAO ESP32-C3 D0 / GPIO2 (ADC). */
#define BATTERY_SENSE_PIN D0
#define BATTERY_DIVIDER_RATIO 3.0f
#define BATTERY_EMPTY_VOLTAGE 6.0f
#define BATTERY_FULL_VOLTAGE 8.39f
#define BATTERY_SAMPLE_INTERVAL_MS 10000

/* Default XIAO I2C pins are D4/SDA (GPIO6) and D5/SCL (GPIO7). */
#define AMBIENT_LIGHT_SAMPLE_INTERVAL_MS 5000
#define AMBIENT_LIGHT_RESCAN_INTERVAL_MS 60000


/* ========================================== */
/*             1. 引脚定义                     */
/* ========================================== */
/*  除非更换了接线，否则不用改这一部分          */

#if defined(CONFIG_IDF_TARGET_ESP32S3) || defined(ESP32S3)
    #define SERVO_PIN   7       // 舵机(尾巴)信号线连接的引脚
#else
    #define SERVO_PIN   8
#endif


/* ========================================== */
/*             2. 游泳参数(默认值)             */
/* ========================================== */
/*  这两个是最重要的参数！直接影响鱼怎么游     */
/*  在网页上可以实时调节这两个值               */

#define SWIM_SPEED      2.5     // 摆尾快慢  建议 1.0 ~ 4.0  (越大越快)
#define SWIM_POWER      28.0    // 摆尾幅度  建议 10  ~ 40   (越大摆得越猛)
#define TURN_AMOUNT     15.0    // 转弯角度  建议 10  ~ 25   (越大转弯越急)
