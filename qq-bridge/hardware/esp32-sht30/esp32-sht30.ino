// ESP32 + SHT30 → 本机桥接传感器端口
//
// 接线（SHT30 模块）：
//   VCC → 3V3    GND → GND    SDA → GPIO21    SCL → GPIO22
//   地址默认 0x44（有的模块是 0x45，改下面 SHT30_ADDR）
//
// 需要库：Adafruit SHT31（库管理器搜 "Adafruit SHT31"），会一起装 BusIO。
//
// 烧之前只改这 4 个常量：WIFI_SSID / WIFI_PASS / SERVER_URL / SENSOR_TOKEN。

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>

// ── 要改的 ────────────────────────────────────────────────
const char* WIFI_SSID    = "你家WiFi名";
const char* WIFI_PASS    = "你家WiFi密码";
// 电脑的局域网 IP（不是 127.0.0.1）：ipconfig 里看 IPv4 地址
const char* SERVER_URL   = "http://192.168.1.10:3101/report";
// state/environment-token 文件里的内容，原样粘进来
const char* SENSOR_TOKEN = "把令牌粘到这里";
const char* PLACE        = "书房";   // 传感器在哪个房间；不写就留空串
// ──────────────────────────────────────────────────────────

const uint8_t SHT30_ADDR = 0x44;
const uint32_t REPORT_INTERVAL_MS = 30000;   // 30 秒一条
const uint32_t WIFI_RETRY_MS = 10000;

Adafruit_SHT31 sht31 = Adafruit_SHT31();
uint32_t lastReport = 0;
uint32_t lastWifiTry = 0;

bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (millis() - lastWifiTry < WIFI_RETRY_MS) return false;
  lastWifiTry = millis();
  Serial.println("[wifi] 重连中…");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  return false;
}

void sendReading(float t, float h) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.setConnectTimeout(4000);
  http.setTimeout(6000);
  if (!http.begin(SERVER_URL)) {
    Serial.println("[http] begin 失败");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-sensor-token", SENSOR_TOKEN);

  char body[160];
  snprintf(body, sizeof(body),
           "{\"tempC\":%.1f,\"humidity\":%.1f,\"place\":\"%s\",\"rssi\":%d,\"fw\":\"esp32-sht30\"}",
           t, h, PLACE, WiFi.RSSI());

  int code = http.POST((uint8_t*)body, strlen(body));
  if (code > 0) {
    Serial.printf("[http] %d %s\n", code, http.getString().c_str());
  } else {
    Serial.printf("[http] 失败：%s\n", http.errorToString(code).c_str());
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Wire.begin(21, 22);
  if (!sht31.begin(SHT30_ADDR)) {
    Serial.println("[sht30] 没找到传感器：检查接线和地址（0x44 / 0x45）");
  }
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // 关省电，HTTP 更稳
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] 连接中");
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] 已连接 %s，本机 IP %s\n", WIFI_SSID, WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[wifi] 首次连接失败，后面会自己重试");
  }
}

void loop() {
  ensureWifi();
  if (millis() - lastReport >= REPORT_INTERVAL_MS) {
    lastReport = millis();
    float t = sht31.readTemperature();
    float h = sht31.readHumidity();
    if (isnan(t) || isnan(h)) {
      Serial.println("[sht30] 读数无效，跳过这一轮");
    } else {
      Serial.printf("[sht30] %.1f°C / %.1f%%\n", t, h);
      sendReading(t, h);
    }
  }
  delay(200);
}