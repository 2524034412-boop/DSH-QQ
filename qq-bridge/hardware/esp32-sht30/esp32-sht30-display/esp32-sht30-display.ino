/*
 * 鲸鱼池 · 环境传感器固件（最终版）
 * ------------------------------------------------------------
 * 硬件
 *   ESP32-WROOM-32（NodeMCU-32S / DevKit V1，30 pin）
 *   SHT30           I2C   VCC→3V3  GND→GND  SDA→GPIO21  SCL→GPIO22
 *   GC9A01 1.28" 圆屏 SPI  VCC→3V3  GND→GND  SCL→GPIO18
 *                          SDA→GPIO23  RES→GPIO17  DC→GPIO16  CS→GPIO5  BLK→3V3
 *
 * 行为
 *   每 30 秒读一次温湿度，往 USB 串口打一行 JSON：
 *     {"tempC":23.4,"humidity":58.2,"fw":"sht30-display","uptime":123}
 *   桥接的 3101 端口认的就是这几个字段（tempC / humidity）。
 *
 * 设计上的几条硬规矩
 *   1) 读失败绝不输出脏数据：宁可不发，也不发 NaN 或上一次的值冒充现在。
 *   2) 屏幕只是装饰。屏没接好、初始化失败，串口照常工作。
 *   3) 串口断了不算事：只是打印失败，不影响读传感器。
 *   4) 第三行 JSON 一出来就是完整的一行，方便桥接按行解析。
 */

#include <Wire.h>
#include <Adafruit_SHT31.h>

// 想关掉屏幕就把它改成 0（编译时就不需要屏幕库）
#define HAS_DISPLAY 1

#if HAS_DISPLAY
  #include <Adafruit_GFX.h>
  #include <Adafruit_GC9A01A.h>
  #include "girl240.h"   // 背景 + 三块数字擦除贴片
#include "cjk24.h"    // 20x20 中文点阵：温 度 湿 有 人 没
#include "numfont.h"   // 数码字体点阵（Bahnschrift）    // 20x20 中文点阵：温 度 湿 有 人 没   // 240x240 RGB565 背景（生成见 D:\DSH\tmp\make-girl240.py）
  #include <SPI.h>
#endif

// ── 引脚 ────────────────────────────────────────────────────────────────
// I2C 引脚可以被编译参数覆盖，换线不用改文件：
//   arduino-cli compile --fqbn esp32:esp32:esp32 \
//     --build-property "build.extra_flags=-DI2C_SDA_PIN=25 -DI2C_SCL_PIN=26" <sketch>
// （GPIO21 如果被烧了，就用 25/26 或 32/33。i2c-probe 能先扫出哪组认得到 0x44。）
#ifndef I2C_SDA_PIN
#define I2C_SDA_PIN 21
#endif
#ifndef I2C_SCL_PIN
#define I2C_SCL_PIN 22
#endif
#define I2C_SDA   I2C_SDA_PIN
#define I2C_SCL   I2C_SCL_PIN
#define SHT30_ADDR 0x44

#if HAS_DISPLAY
  #define TFT_CS   5
  #define TFT_DC   16
  #define TFT_RST  17
  #define TFT_SCLK 18
  #define TFT_MOSI 23
  // 背光：这块板子只有一个 3V3，而 3V3 必须留给 SHT31 —— I2C 的上拉电阻是接到
  // 模块 VCC 的，SHT31 一旦吃 5V，SDA/SCL 空闲电平就会被拉到 5V，ESP32 的 GPIO
  // 不耐 5V。所以背光不接 3V3，改由 GPIO 供电（顺便还能 PWM 调亮度）。
  // 背光 LED 一般 8~15mA，GPIO 输出 12mA 以内是安全的；调 70% 占空比更保险。
  // 不想改接线就把 BLK_ON_GPIO 设 0，那就要把 BLK 接 3V3（得自己分线）。
  #define BLK_ON_GPIO  1
  #define TFT_BLK      4
  #define TFT_BLK_DUTY 180   // 0~255；180≈70%
#endif

// ── 参数 ────────────────────────────────────────────────────────────────
static const uint32_t REPORT_INTERVAL_MS = 30000;  // 30 秒一行
static const uint8_t  MAX_FAIL_BEFORE_WARN = 3;    // 连续失败几次开始喊

Adafruit_SHT31 sht30 = Adafruit_SHT31();
#if HAS_DISPLAY
  Adafruit_GC9A01A tft(TFT_CS, TFT_DC, TFT_RST);
  bool displayOk = false;
#endif

uint32_t lastReport = 0;
uint8_t  failStreak = 0;
int8_t   lastPresenceShown = -1;   // -1 还没画过
bool     sensorOk = false;

// 屏幕配色（夜色 + 淡青，跟群里的深色调统一）
#define C_BG    0x10A2
#define C_MAIN  0xE7FF
#define C_DIM   0x8C7F
#define C_WARN  0xFBE0

static const uint16_t C_TEMP = ((255 & 0xF8) << 8) | ((236 & 0xFC) << 3) | (214 >> 3);
static const uint16_t C_HUM  = ((196 & 0xF8) << 8) | ((226 & 0xFC) << 3) | (255 >> 3);
static const uint16_t C_LBL  = ((150 & 0xF8) << 8) | ((165 & 0xFC) << 3) | (200 >> 3);
static const uint16_t C_SHADOW = ((4 & 0xF8) << 8) | ((6 & 0xFC) << 3) | (14 >> 3);
static const uint16_t C_RING = ((96 & 0xF8) << 8) | ((110 & 0xFC) << 3) | (150 >> 3);
static const uint16_t C_OK   = ((90 & 0xF8) << 8) | ((220 & 0xFC) << 3) | (140 >> 3);
static const uint16_t C_NO   = ((240 & 0xF8) << 8) | ((90 & 0xFC) << 3) | (90 >> 3);
// 中文点阵：索引 0温 1度 2湿 3有 4人 5没
static void drawGlyphs(const uint8_t *idx, uint8_t n, int16_t x, int16_t y, uint16_t color) {
  tft.startWrite();
  for (uint8_t k = 0; k < n; k++) {
    int16_t gx = x + k * CJK_W;
    for (int16_t row = 0; row < CJK_H; row++) {
      uint32_t bits = CJK24[idx[k]][row];
      for (int16_t col = 0; col < CJK_W; col++) {
        if (bits & (1UL << (CJK_W - 1 - col))) tft.writePixel(gx + col, y + row, color);
      }
    }
  }
  tft.endWrite();
}

// 数码字体：字符表 "0123456789.-%"，每格 NUMF_W 宽；offset 用来画 1px 阴影
static void drawNumRun(const char *s, int16_t x, int16_t y, uint16_t color, int8_t dx, int8_t dy) {
  tft.startWrite();
  int16_t cx = x + dx;
  for (const char *p = s; *p; ++p) {
    const char *hit = strchr(NUMF_CHARS, *p);
    if (hit) {
      uint8_t gi = (uint8_t)(hit - NUMF_CHARS);
      for (int16_t row = 0; row < NUMF_H; row++) {
        uint32_t bits = NUMF[gi][row];
        for (int16_t col = 0; col < NUMF_W; col++) {
          if (bits & (1UL << (NUMF_W - 1 - col))) tft.writePixel(cx + col, y + dy + row, color);
        }
      }
    }
    cx += NUMF_W;
  }
  tft.endWrite();
}

// 细字体 + 1px 阴影：照片上既清楚又不糊
static void drawNumText(const char *s, int16_t x, int16_t y, uint16_t color) {
  drawNumRun(s, x, y, C_SHADOW, 1, 1);
  drawNumRun(s, x, y, color, 0, 0);
}

static const uint8_t GLYPH_WEN[2] = { 0, 1 };   // 温度
static const uint8_t GLYPH_SHI[2] = { 2, 1 };   // 湿度
static const uint8_t GLYPH_YOU[2] = { 3, 4 };   // 有人
static const uint8_t GLYPH_MEI[2] = { 5, 4 };   // 没人


void drawBackdrop() {
#if HAS_DISPLAY
  if (!displayOk) return;
  tft.drawRGBBitmap(0, 0, GIRL240, 240, 240);
  tft.drawCircle(120, 120, 117, C_RING);
#endif
}

// 温度 + 湿度两行（每 30 秒刷一次）
void drawReadings(float tc, float hc, bool ok) {
#if HAS_DISPLAY
  if (!displayOk) return;
  char buf[12];

  tft.drawRGBBitmap(ZONE_TEMP_X, ZONE_TEMP_Y, ZONE_TEMP, ZONE_TEMP_W, ZONE_TEMP_H);
  drawGlyphs(GLYPH_WEN, 2, TEMP_LBL_X, ROW1_Y, C_LBL);
  if (ok) snprintf(buf, sizeof(buf), "%.1f", tc); else snprintf(buf, sizeof(buf), "--.-");
  drawNumText(buf, TEMP_VAL_X, ROW1_Y + 2, ok ? C_TEMP : C_WARN);

  tft.drawRGBBitmap(ZONE_HUM_X, ZONE_HUM_Y, ZONE_HUM, ZONE_HUM_W, ZONE_HUM_H);
  drawGlyphs(GLYPH_SHI, 2, HUM_LBL_X, ROW2_Y, C_LBL);
  if (ok) snprintf(buf, sizeof(buf), "%.0f%%", hc); else snprintf(buf, sizeof(buf), "--%%");
  drawNumText(buf, HUM_VAL_X, ROW2_Y + 2, ok ? C_HUM : C_WARN);
#endif
}

// 人体感应行：有动态 → 绿点「有人」；没动态 → 红点「没人」
void drawPresence(bool present) {
#if HAS_DISPLAY
  if (!displayOk) return;
  tft.drawRGBBitmap(ZONE_PIR_X, ZONE_PIR_Y, ZONE_PIR, ZONE_PIR_W, ZONE_PIR_H);
  uint16_t color = present ? C_OK : C_NO;
  tft.fillCircle(PIR_DOT_X, PIR_DOT_Y, PIR_DOT_R, color);
  drawGlyphs(present ? GLYPH_YOU : GLYPH_MEI, 2, PIR_TEXT_X, ROW3_Y, color);
#endif
}
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("{\"boot\":\"sht30-display\",\"fw\":\"1.0\"}");
  pirInit();   // 先给人感上电（HC-SR501 要 30~60 秒才稳）

  Wire.begin(I2C_SDA, I2C_SCL);
  sensorOk = sht30.begin(SHT30_ADDR);
  if (!sensorOk) {
    Serial.println("{\"error\":\"sht30-not-found\",\"addr\":68}");
  }

#if HAS_DISPLAY
  // 背光先点亮（PWM，省电流）
  #if BLK_ON_GPIO
    pinMode(TFT_BLK, OUTPUT);
    analogWrite(TFT_BLK, TFT_BLK_DUTY);
  #endif
  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  tft.begin();
  tft.setRotation(0);
  displayOk = true;
  drawBackdrop();
  drawReadings(0, 0, false);
  drawPresence(false);
  lastPresenceShown = 0;
#endif

  // 第一行立刻给，别让桥接等 30 秒
  lastReport = millis() - REPORT_INTERVAL_MS;
}

// ── 人体感应（HC-SR501，热释电） ──────────────────────────────────────────
// 只有 3 个脚：VCC / OUT / GND。OUT 是 3.3V 电平，直接进 GPIO 安全。
// 供电注意：HC-SR501 标称 4.5~20V，但板子上 5V 那一颗已经被屏幕占用了。
//   方案 A（零成本，先试）：VCC 接一个空闲 GPIO（P14），固件把它拉高供电。
//     BISS0001 最低 3V，多数能跑，只是触发距离会缩水。
//   方案 B（最稳）：接 5V，但要面包板或「一母转二公」分线。
// OUT 接 P13；跳线帽选 H（可重复触发），拧 Tx 到最小（约 3 秒）更好用。
#define PIR_ENABLED 1
#define PIR_PIN     13   // OUT 接这里
#define PIR_PWR_PIN 26   // VCC 由这个 GPIO 供电。选 26 是为了离 OUT(13) 远一点，
                         // 免得三根线的接头挤在一起插不进去。接 5V 时把这行设 -1
static const uint32_t PIR_WARMUP_MS = 60000;   // HC-SR501 上电要 30~60 秒稳定，期间别信它

uint32_t lastMotionMs = 0;
bool     motionSeen  = false;

static void pirInit() {
#if PIR_ENABLED
  // 用内部下拉：线没接好/模块没供电时读到 LOW（"没人动"），而不是浮空乱跳的 HIGH。
  // 模块有电时它自己把线驱动到高/低，一个 45k 下拉压不住，不影响灵敏度。
  pinMode(PIR_PIN, INPUT_PULLDOWN);
#if PIR_PWR_PIN >= 0
  pinMode(PIR_PWR_PIN, OUTPUT);
  digitalWrite(PIR_PWR_PIN, HIGH);
#endif
#endif
}

// 每圈都调：PIR 的输出是"持续高电平"，只在 30 秒上报时才读会漏掉一闪而过的人影
static void pirPoll() {
#if PIR_ENABLED
  if (millis() < PIR_WARMUP_MS) return;
  if (digitalRead(PIR_PIN) == HIGH) {
    if (!motionSeen || millis() - lastMotionMs > 2000) {
      lastMotionMs = millis();
      motionSeen = true;
    }
  }
#endif
}

void loop() {
  pirPoll();
  // 有人/没人这一行每圈都看，状态一变立刻重画（不用等 30 秒）
#if HAS_DISPLAY
  if (displayOk) {
    bool present = motionSeen && (millis() - lastMotionMs) < 20000;   // 和 JSON 对齐，挥手后亮 20 秒
    int8_t now = present ? 1 : 0;
    if (now != lastPresenceShown) {
      drawPresence(present);
      lastPresenceShown = now;
    }
  }
#endif
  if (millis() - lastReport < REPORT_INTERVAL_MS) return;
  lastReport = millis();

  float t = sht30.readTemperature();
  float h = sht30.readHumidity();

  bool ok = !isnan(t) && !isnan(h) && t > -40 && t < 85 && h >= 0 && h <= 100;

  if (!ok) {
    failStreak++;
    // 连续失败才喊一声，偶发抖动不打扰
    if (failStreak >= MAX_FAIL_BEFORE_WARN) {
      Serial.println("SENSOR!");
      Serial.println("{\"error\":\"read-failed\"}");
      drawReadings(0, 0, false);
      // 重新初始化一次，应对热插拔/总线卡死
      sensorOk = sht30.begin(SHT30_ADDR);
    }
    return;
  }

  failStreak = 0;

  // 一行完整 JSON，桥接按行解析
  // motion=1 表示"刚刚还在动"（3 秒内）；motionAgo=多少秒前动过，-1 表示上电至今没感知到人
  char line[160];
  long motionAgo = motionSeen ? (long)((millis() - lastMotionMs) / 1000) : -1;
  // 20 秒窗口：PIR 自身只保持 3 秒，太短了，肉眼和面板都抓不住。
  int  motionNow = (motionSeen && (millis() - lastMotionMs) < 20000) ? 1 : 0;
  snprintf(line, sizeof(line),
           "{\"tempC\":%.1f,\"humidity\":%.1f,\"fw\":\"sht30-display\",\"uptime\":%lu,\"motion\":%d,\"motionAgo\":%ld}",
           t, h, (unsigned long)(millis() / 1000), motionNow, motionAgo);
  Serial.println(line);

  drawReadings(t, h, true);
}