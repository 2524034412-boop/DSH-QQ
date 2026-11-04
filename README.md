# qq-bridge 安装包

给 DSH（DeepSeek Harness）装一个 QQ 机器人：QQ ↔ SnowLuma ↔ qq-bridge ↔ DSH。
装完之后，所有开关和配置都在 **DSH → 设置 → QQ 桥接** 里，不需要记网址，也没有令牌。

## 装之前需要

1. **DSH** 已装好（默认 `D:\DSH`，别的位置装也行，安装时告诉它）
2. **SnowLuma**（QQ 网关）：这里是第三方软件，要你自己装，装完用手机 QQ 扫码登录
3. Windows 10/11

## 怎么装

1. 把压缩包解压到任意位置（别直接点压缩包里的文件）
2. 双击 **安装.cmd**
3. 等它跑完，看到「安装完成」就行

安装器会做：复制桥接 → 装依赖 → 注册 DSH 预设与 MCP → 装设置页插件。
**已有的记忆和聊天数据不会被覆盖**（`state\` 目录不碰）。

**默认不加开机自启**：桥接离开 DSH 就没用，而 DSH 一启动插件会自己把桥接拉起来
（最多十几秒）。想让它在开机时就跑，加参数再跑一次：

```
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Autostart
```

## 装完怎么用

1. 打开 DSH → **设置 → QQ 桥接**
2. 按最上面的「新手引导」一步步走：

```
● 桥接程序          自动
● 配置文件          点「从示例创建配置」
● SnowLuma          打开它，手机 QQ 扫码
● OneBot 连接       在 SnowLuma 里点一次注入
● 桥接在线          点「重启桥接」
● 管理员 QQ         填你自己的号
● 白名单            加一个群或一个私聊
```

3. 点「发一条测试消息」——QQ 收到就通了

## 常见问题

**设置里没有「QQ 桥接」**
重启一次 DSH。还没有就说明插件没装上，重跑一次安装器。

**「桥接没在跑」**
点「重启桥接」，等 15 秒。

**「白名单是空的」**
她不会回任何人。至少加一个群号或私聊 QQ 号。

**声音**
默认不出声。语音要单独配 TTS，没配就只发文字。

## 卸载

1. 退出 DSH
2. 删掉 `%USERPROFILE%\qq-bridge`
3. 删掉 `%USERPROFILE%\.dsh\plugins\dsh-qq-bridge`
4. 打开 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，把 `dsh-qq-bridge` 那两处删掉
5. 重启 DSH

## 说明

qq-bridge 基于开源项目（MIT）。本包附带的代码有本地修改。
人格卡是示例，可以自己改；改之前会自动备份。
