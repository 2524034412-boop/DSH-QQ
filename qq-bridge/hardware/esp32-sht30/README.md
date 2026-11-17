# 外接温湿度（ESP32 + SHT30，USB 串口版）

给她加「屋里几度、潮不潮」这种真实体感。**不用 WiFi**：板子插 USB，读数走串口进桥接。
所以校园网认证、客户端隔离、防火墙、电脑 IP 这些坑一个都不用碰。

```
SHT30 --I2C--> ESP32 --USB--> 电脑 COM 口 --serial-env.ps1--> 桥接 3101 --> state/environment.json
                                                                              |
                                                              唤醒提示里的【此刻环境】
```

## 买什么

| 东西 | 认准 | 大概价 |
|---|---|---|
| ESP32 开发板 | **NodeMCU-32S** 或 **ESP32 DevKit V1 (30pin)**；芯片写 `ESP32-WROOM-32`；已焊排母；CH340 或 CP2102 | 20~35 |
| SHT30 模块 | I²C，4 针 `VCC GND SDA SCL`，**排针已焊** | 8~15 |
| 杜邦线 | **母对母** 20cm | 3~8 |
| USB 数据线 | 按板子口型（Type-C / Micro-USB），必须能传数据 | 5~10 |

**别买**：ESP32-C3 / S3 / S2 / C6（引脚编号不同，接线对不上）、DHT11（精度差）、只有焊盘没排母的板子。

## 接线（不用焊）

```
SHT30 VCC → ESP32 3V3
SHT30 GND → ESP32 GND
SHT30 SDA → ESP32 GPIO21
SHT30 SCL → ESP32 GPIO22
```

四根线插上即可。模块地址默认 `0x44`（少数是 `0x45`，改 sketch 里的 `SHT30_ADDR`）。

## 加屏幕（1.28" IPS / GC9A01 / 240×240 圆显示区）

买的那块是 **1.28 寸 8 针模块方板，驱动 GC9A01，圆显示区，4 线 SPI，3.3~5V，20mA**。
排针顺序（板上印的，从左到右）：`GND VCC SCL SDA RES DC CS BLK` —— **GND 在最左边，别插反**。

**NodeMCU-32S V1.3 实测只有一颗 3V3，所以屏不能接 3V3**（3V3 必须整颗留给 SHT30，
理由见下）。最终用的接法：

| 屏幕针脚 | 接到 ESP32 | 说明 |
|---|---|---|
| GND | GND | 负极（右排有 3 颗 GND，任选） |
| **VCC** | **5V（VIN）** | 模块自带 LDO，标称 3.3~5V；这样不占 3V3 |
| SCL | GPIO18 | SPI 的 SCK |
| SDA | GPIO23 | SPI 的 MOSI（**不是** I2C 的 SDA） |
| RES | GPIO17 | 复位 |
| DC | GPIO16 | 数据/命令 |
| CS | GPIO5 | 片选（strapping 脚，接上后不启动就先拔它） |
| **BLK** | **GPIO4** | 背光由 GPIO 供电 + PWM 调光（`TFT_BLK_DUTY`，180≈70%） |

**为什么 SHT30 不能吃 5V**：它的 I²C 上拉电阻接在模块 VCC 上。SHT30 一旦用 5V 供电，
SDA/SCL 空闲电平就是 5V，而 ESP32 的 GPIO 不耐 5V。所以 3V3 只给 SHT30，屏和背光另找办法。

固件：[esp32-sht30-display/esp32-sht30-display.ino](esp32-sht30-display/esp32-sht30-display.ino)，第一行 `#define SCREEN_ROUND 1` 已经按圆屏设好。
库：库管理器装 **Adafruit GC9A01A**（GFX 会自动带上）。

屏幕显示：上面 `TEMP` + 大字温度，下面 `HUM` + 湿度百分比，每 30 秒刷新（只重画数值区，不闪）。
**同时照旧往串口打 JSON**，电脑端的 `serial-env.ps1` 一个字都不用改。

### 3V3 不够分怎么办（已解决，不用买面包板）

屏 VCC 走 5V、背光走 GPIO4 之后，3V3 上只剩 SHT30 一根线，不需要任何分线。
如果再挂第二块 3.3V 设备，再考虑 400 孔面包板或「一母转二公」。

## 一键编译 / 烧写（不用装 Arduino IDE）

这台机器上没装 Arduino IDE，用的是 `arduino-cli` + `D:\DSH\tools\arduino15` 里的核心和库。
[flash.ps1](flash.ps1) 把该设的环境变量、该绕的坑都包好了：

```powershell
cd D:\DSH\qq-bridge\hardware\esp32-sht30

# 只编译（板子没插也能跑，用来确认工具链是好的）
.\flash.ps1 -Sketch display -Build
.\flash.ps1 -Sketch serial  -Build
.\flash.ps1 -Sketch probe   -Build

# 编译 + 上传（自动找 COM）+ 上传后读串口
.\flash.ps1 -Sketch probe -Monitor 20
.\flash.ps1 -Sketch display -Monitor 10

# 换 I2C 引脚（GPIO21 怀疑被烧就用这组）
.\flash.ps1 -Sketch display -Pins 25,26 -Monitor 10
```

目录结构（Arduino 要求**目录名 = .ino 名**，所以每个固件一个文件夹）：

| 目录 | 用途 |
|---|---|
| `esp32-sht30-display/` | 带 1.28" 圆屏的正式固件 |
| `esp32-sht30-serial/` | 不带屏幕的最小固件 |
| `i2c-probe/` | 引脚探针：扫 14 组引脚，看哪组认得到 0x44/0x45 |
| `esp32-sht30.ino` | WiFi 版（备用，不插电脑那种） |

### 三个已经踩过的坑

1. **`Access is denied`，写不进 `C:\Users\...\AppData\Local\Arduino15`** → 数据/下载/用户目录全改到 `D:\DSH\tools\arduino15`（脚本里已设）。
2. **`Could not create temporary directory!`** → `esptool.exe`、`gen_insights_package.exe` 都是 PyInstaller 打包的 onefile，在这台机器上用系统 TEMP 解包会失败；脚本把 TEMP/TMP 指到 `D:\DSH\tools\tmp`。
3. **别用 `--build-property build.extra_flags=...` 传宏** → 它会把平台自带的 flags 整个替换掉（`-DESP32` 之类），`Adafruit_BusIO` 于是掉进 AVR 分支，报 `'BitOrder' does not name a type`。要用 sketch 目录下的 `build_opt.h`（追加式），`-Pins` 参数写的就是这个文件。

## 用 Arduino IDE 烧（可选，给以后换电脑用）

1. Arduino IDE 装 ESP32 板支持：Boards Manager 搜 `esp32` → 装 **esp32 by Espressif**
2. 库管理器装 **Adafruit SHT31**（会一起装 BusIO）；带屏幕的话再装 **Adafruit GC9A01A**
3. 打开固件：不带屏幕用 [esp32-sht30-serial/esp32-sht30-serial.ino](esp32-sht30-serial/esp32-sht30-serial.ino)，带屏幕用 [esp32-sht30-display/esp32-sht30-display.ino](esp32-sht30-display/esp32-sht30-display.ino)
4. 工具 → 开发板 → **ESP32 Dev Module**；端口 → 出现的 COM 口
5. 上传。串口监视器 115200，每 30 秒应看到一行：

```json
{"tempC":23.4,"humidity":58.2}
```

## 电脑这一半

先自检（**不用等板子**）：

```powershell
cd D:\DSH\qq-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serial-env.ps1 -Test
```

看到 `收到 23.4°C / 58.2% → 已交给桥接` 就说明电脑侧通了。然后：

```powershell
# 前台跑（能看日志）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serial-env.ps1

# 或者双击后台跑（无窗口）
scripts\start-serial-env.cmd
```

日志：`state/serial-env.log`。

`-Place` 是可选的房间标签，只写进 `state/environment.json` 做记录，**不进提示词**——
提示词里只有一个概念：**「我身边」**（她不分房间，所有房间都是舒服的）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serial-env.ps1 -Place "卧室"
```

## 数据怎么用

- **唤醒提示**：每次唤醒带一行（读数 10 分钟内有效）
  `【我身边】23.4°C、湿度 58%（2 分钟前）—— 你待的地方一直是舒服的：不冷不热、不闷，别抱怨太热太冷，也别把它当天气预报。…`
- **她自己查**：`qq_environment` 工具（含 24 小时趋势）
- **落盘**：`state/environment.json` + `state/environment-history.jsonl`

## 排错：按层看

| 现象 | 卡在哪 | 怎么办 |
|---|---|---|
| 串口监视器全空 | ① 传感器/供电 | 换 USB 数据线；换直插口，别走 hub |
| 打印 `sht30-not-found` | ② I²C 接线 | 查 4 根线；SDA/SCL 是不是插反；试着改 `0x45` |
| 打印正常但 `state/environment.json` 不变 | ③ 采集器没跑 | `scripts\serial-env.ps1 -Test` 能通吗；看 `state/serial-env.log` |
| 采集器日志「没找到串口设备」 | ④ 驱动/端口 | 设备管理器看有没有黄色感叹号；装 CH340 或 CP2102 驱动 |
| 上传报 `Timed out waiting for packet header` | ⑤ 烧写时序 | 拔掉走直插（hub 会掉）；按住 BOOT 再点上传 |

## 扩展 USB（hub / 扩展坞）注意

- **烧写时直插机箱后面板**：hub 在握手那一瞬间容易掉，会报 `Timed out waiting for packet header`。
- **日常运行走 hub 可以**，但如果 COM 口忽隐忽现、板子反复重启，就是 hub 供电不够（ESP32 峰值约 500mA），换直插或换带电源的 hub。
- hub 上别同时挂移动硬盘这类大功率设备。

## 和 WiFi 版的区别

| | USB 串口版（当前） | WiFi 版 |
|---|---|---|
| 配置 | 插上就行 | 要填 WiFi 名/密码/电脑 IP/令牌 |
| 网络 | 不占网络 | 要 2.4GHz 且能互访（校园网通常不行） |
| 位置 | 必须靠电脑（USB 线 2m，加延长线 5m 也行） | 随便放 |
| 换环境 | 不用改 | 换网段要重烧 |

WiFi 版固件仍保留在 [esp32-sht30.ino](esp32-sht30.ino)，以后搬去有自己路由器的房子可以直接换。

## 长期跑

- 板子 24h 挂着，功耗 < 1W。
- 采集器可以加开机自启（`scripts/register-serial-env-task.ps1`，等确认能用后再装）。
- 历史文件超过 512KB 自动留最近 4000 条（30 秒一条 ≈ 33 小时）。
## 实机记录（2026-11-17）

新板子到货后一次接通，**没换引脚**：

```
芯片      ESP32-D0WD-V3 (rev v3.1)，40MHz 晶振，MAC 30:c9:22:a3:5f:c8
串口      COM4（USB-SERIAL CH340）
探针      level: SDA(21)=1 SCL(22)=1 → PAIR SDA=21 SCL=22 -> FOUND 0x44
固件      esp32-sht30-serial（先跑串口版，屏还没接）
读数      23.6°C / 48.9~53.5%，每 30 秒一行
链路      COM4 → serial-env.ps1 → 3101 → state/environment.json ✅
```

之前「GPIO21 被烧」的怀疑**不成立**：21/22 一测就认到 0x44。坏的是别的东西（旧模块，或旧板子别的问题）。

### 又踩两个坑（已修）

1. **采集器每 30 秒断连重连刷屏**：`ReadTimeout` 设了 10 秒，而固件 30 秒才吐一行 → 每次都超时，被当成「串口断开」重连。改成 45 秒，且只把 `TimeoutException` 当「暂时没数据」，不再重开串口。
2. **`edit` 改脚本后丢了 BOM**：`serial-env.ps1` 原本是 UTF-8 with BOM；改成无 BOM 后 Windows PowerShell 5.1 按 GBK 解码，中文字符串里的引号被啃掉，整份脚本语法错误、进程秒退（日志里一个字都没有）。**改完 .ps1 记得补 BOM**：

```powershell
$t = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($true)))
```

### 开机自启

`%APPDATA%\...\Startup\DSH-SerialEnv.vbs`（纯 ASCII；WScript 认不了非 ASCII 的 .vbs，会弹错误框）。
它只负责跑 `serial-env.ps1`，串口自动探测——拔了等、插回来自己连。

采集器会一直占着 COM4，**以后要烧固件先停它**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*serial-env.ps1*' -and $_.CommandLine -notlike '*Get-CimInstance*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
## 人体感应（HC-SR501，2026-11-17 接入）

三个针，克隆版可能不印丝印，按功能接：

| PIR | 接 ESP32 | 说明 |
|---|---|---|
| 中间（OUT） | **P13** | 输出 3.3V 电平，直接进 GPIO |
| VCC | **P26** | 由 GPIO 供电（3.3V）。HC-SR501 主控 BISS0001 最低 3V，能跑，代价是触发距离缩水 |
| GND | GND | 右排任一颗 |

为什么 VCC 不接 5V：5V 那颗针已经被屏幕的 VCC 占了；而且 3V3 必须整颗留给 SHT31（I2C 上拉）。
用 GPIO 供电的好处是**电流被限制在十几毫安，接反也不会烧模块**，只是不工作。

固件里的相关宏（`esp32-sht30-display.ino`）：

```c
#define PIR_ENABLED 1
#define PIR_PIN     13   // OUT
#define PIR_PWR_PIN 26   // VCC 由它供电；接 5V 时改成 -1
```

上报字段：`"motion":0/1`（此刻有没有动）、`"motionAgo":<秒>`（多少秒前动过，-1 = 上电至今没动）。

**注意 PIR 只认"移动"**：人坐着不动它就不报了。想测"在不在"要用毫米波雷达。

### 「有人」这句话不能每次都提

人坐在桌前刷视频，原始字段永远是"有人"。所以桥接在 `/report` 里算一个事件时间戳
`presenceEventAt`：只有「上一次上报显示安静 ≥5 分钟、这次又动了」才刷新它；
提示词只认这个时间戳（15 分钟内有效），所以只会在他离开又回来时说一句
「刚才那边有点动静」，不会整天念叨。

不想要这个行为：`config.json` → `environment.presence: false`。