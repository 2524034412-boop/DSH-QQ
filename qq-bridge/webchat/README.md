# 网页群聊（P0）

一个能在 iPhone / 电脑浏览器里打开的小群，她和朋友都能在里面说话。
邀请码才能进。**不碰 QQ 那条线，不碰 `state/`。**

## 启动

```powershell
# 只本机能开（默认）
node webchat/server.mjs

# 同一 WiFi 下手机也能开（试水用，别在公共 WiFi 上这么跑）
$env:WC_HOST='0.0.0.0'; node webchat/server.mjs
```

打开：`http://127.0.0.1:3300`

## 邀请码

```powershell
node webchat/invite.mjs new --note 朋友 --max 1 --hours 24   # 发一个
node webchat/invite.mjs list                                  # 看所有
node webchat/invite.mjs revoke ABC123                         # 收回（立即生效）
```

## 她怎么回话

- 被 @、被叫小鲸鱼/鲸鱼/D老师 等等 → 必答
- 其他 → 35% 概率插一句，15 秒内不会连着说
- 回话前会先推一个「正在输入…」

## 已知边界（P0 就这些）

| 有 | 没有 |
|---|---|
| 文字群聊、多人在场、实时同步 | 图片、表情包、语音 |
| 邀请码、吊销、按人限流 | 她的 QQ 记忆（网页这边是独立会话） |
| 「正在输入…」 | 她主动找话题、读书、B站、好感度 |

**要紧**：网页群现在用的是**独立的会话**，跟她 QQ 上那份记忆不是一套。
P1 才把它接到 `state/` 上。

## 技术备忘（踩过的坑）

1. **preset 不能用 `qq-chat`**：那套带 qq_* 工具，新会话里会卡在工具审批，`turn` 永远不结束。
   现在用 `minimal`（可用 `WC_PRESET` 改）。
2. **这一版 DSH 的首个回合没有 `turn/start`**，只有 `step/start`。
   所以不能用 `createTurnCollector()`，要自己按 turn 号累加 `assistant/message` 的文本，`turn/end` 结算。
3. 邀请码必须**每次请求重读磁盘**，否则新码要重启才认、收回的码停不下来。
4. 日志写文件（`webchat/data/server.log`），因为 stdout 重定向会缓冲，看不到实时。

## 文件

```
webchat/
  server.mjs        服务：静态页 + 邀请码 + SSE + 调她回话
  invite.mjs        邀请码管理
  probe-presets.mjs 只读探针：列 DSH 的 preset
  public/index.html 群聊页面
  data/             邀请码、成员、日志（不进 git）
```