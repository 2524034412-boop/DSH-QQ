/*
 * I2C 探针：
 *  1) 读 SDA/SCL 的空闲电平（有上拉应该都是高电平）
 *  2) 把常见的几组引脚（含 SDA/SCL 对调）挨个试，看哪组能认到 0x44/0x45
 */
#include <Wire.h>

static const int PAIRS[][2] = {
  {21, 22}, {22, 21},   // 标准 / 接反
  {18, 19}, {19, 18},   // 另一组常用
  {16, 17}, {17, 16},
  {25, 26}, {26, 25},
  {32, 33}, {33, 32},
  {13, 14}, {14, 13},
  {4, 5},   {5, 4}
};
static const int NPAIRS = sizeof(PAIRS) / sizeof(PAIRS[0]);

void setup() {
  Serial.begin(115200);
  delay(600);
  Serial.println();
  Serial.println("== I2C PROBE ==");

  // 空闲电平：拉上拉读一次
  pinMode(21, INPUT_PULLUP); pinMode(22, INPUT_PULLUP);
  delay(10);
  Serial.printf("level: SDA(21)=%d  SCL(22)=%d   (1=高，正常；0=被拉低或短路)\n",
                digitalRead(21), digitalRead(22));

  for (int i = 0; i < NPAIRS; i++) {
    int sda = PAIRS[i][0], scl = PAIRS[i][1];
    Wire.end();
    Wire.begin(sda, scl);
    Wire.setClock(100000);
    delay(5);
    bool hit44 = false, hit45 = false, any = false;
    uint8_t anyAddr = 0;
    for (uint8_t a = 1; a < 127; a++) {
      if (a == sda || a == scl) continue;
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) {
        any = true; anyAddr = a;
        if (a == 0x44) hit44 = true;
        if (a == 0x45) hit45 = true;
      }
    }
    if (any) {
      Serial.printf("PAIR SDA=%d SCL=%d  -> FOUND 0x%02X%s%s\n", sda, scl, anyAddr,
                    hit44 ? "  (SHT30 0x44)" : "", hit45 ? "  (SHT30 0x45)" : "");
    } else {
      Serial.printf("PAIR SDA=%d SCL=%d  -> none\n", sda, scl);
    }
  }
  Serial.println("== probe done, repeating levels ==");
}

void loop() {
  pinMode(21, INPUT_PULLUP); pinMode(22, INPUT_PULLUP);
  delay(5);
  Serial.printf("level: SDA(21)=%d SCL(22)=%d\n", digitalRead(21), digitalRead(22));
  delay(3000);
}