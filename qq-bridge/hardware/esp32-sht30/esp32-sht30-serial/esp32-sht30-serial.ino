// ESP32 + SHT30 —— USB 串口版（不用 WiFi）
//
// 接线（SHT30 模块）：
//   VCC → 3V3    GND → GND    SDA → GPIO21    SCL → GPIO22
//   地址默认 0x44（有的模块是 0x45，改下面 SHT30_ADDR）
//
// 需要库：Adafruit SHT31（库管理器搜 "Adafruit SHT31"，会一起装 BusIO）
//
// 烧完之后板子每 30 秒往串口打一行 JSON，电脑上的 serial-env.ps1 读走它。
// 不需要 WiFi、不需要密码、不需要 IP —— 插上就能用。

#include <Wire.h>
#include <Adafruit_SHT31.h>

// I2C 引脚可以被编译参数覆盖（GPIO21 若真烧了，就换 25/26 或 32/33）：
//   --build-property "build.extra_flags=-DI2C_SDA_PIN=25 -DI2C_SCL_PIN=26"
#ifndef I2C_SDA_PIN
#define I2C_SDA_PIN 21
#endif
#ifndef I2C_SCL_PIN
#define I2C_SCL_PIN 22
#endif

const uint8_t SHT30_ADDR = 0x44;
const uint32_t REPORT_INTERVAL_MS = 30000;   // 30 秒一条
const char* FW = "esp32-sht30-serial-v1";

Adafruit_SHT31 sht31 = Adafruit_SHT31();
uint32_t lastReport = 0;
bool sensorOk = false;

void setup() {
  Serial.begin(115200);
  delay(800);                 // 等 USB 串口稳定，别让第一行掉进虚空
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  sensorOk = sht31.begin(SHT30_ADDR);
  if (sensorOk) {
    Serial.printf("{\"hello\":\"%s\",\"sensor\":\"sht30\",\"addr\":%d}\n", FW, SHT30_ADDR);
  } else {
    // 找不到传感器也把话说清楚：电脑端日志里能直接看到原因
    Serial.printf("{\"hello\":\"%s\",\"sensor\":\"missing\",\"addr\":%d}\n", FW, SHT30_ADDR);
  }
}

void loop() {
  if (millis() - lastReport < REPORT_INTERVAL_MS) {
    delay(100);
    return;
  }
  lastReport = millis();

  if (!sensorOk) {
    // 每轮都重试一次：线松了或插错了，接好就能自己恢复，不用重新烧
    sensorOk = sht31.begin(SHT30_ADDR);
    if (!sensorOk) {
      Serial.println("{\"error\":\"sht30-not-found\"}");
      return;
    }
  }

  float t = sht31.readTemperature();
  float h = sht31.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("{\"error\":\"read-failed\"}");
    return;
  }
  // 只打数字，房间名由电脑端补（避免板子上的中文编码问题）
  Serial.printf("{\"tempC\":%.1f,\"humidity\":%.1f}\n", t, h);
}