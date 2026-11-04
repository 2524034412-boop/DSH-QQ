# 发版与打补丁

这个插件能「检查更新 → 一键打补丁」。这一页写清楚**发布方要怎么做**，用户那一侧才有东西可装。

## 一句话规则

```
tag：   qq-bridge-v<版本>          ← 前缀必须有，仓库里还有别的插件（比如星图开机）
资产：  dsh-qq-bridge-<版本>.zip   ← 必须挂这个，根目录就是插件根
说明：  release 正文               ← 会原样显示在设置页里
```

## 为什么要有前缀

同一个仓库可以放好几个插件。现在 `your-name/DSH-QQ` 里就有星图开机（tag `v1.8.0`）。
更新器只认两种东西：**资产名** `dsh-qq-bridge-*.zip`，和 **tag 前缀** `qq-bridge-v`。
所以星图开机的 release 再多，也不会被当成这个插件的新版。

## 发一个补丁的步骤

1. 改代码，然后**三个地方的版本号一起改**（`打补丁包.ps1` 会检查，不一致直接报错）：

   ```
   package.json          "version": "0.3.1"
   lib/index.js          const PLUGIN_VERSION = '0.3.1'
   lib/client.js         const PLUGIN_VERSION = '0.3.1'
   ```

2. 跑一遍自测：

   ```
   node test/host.mjs
   node test/clean.mjs
   node test/config.mjs
   node test/firstrun.mjs
   node test/update.mjs
   ```

3. 打补丁包：

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\DSH\发布\qq-bridge安装器\打补丁包.ps1"
   ```

   产出 `D:\DSH\发布\dsh-qq-bridge-<版本>.zip`（只有几十 KB，不含桥接本体）。

4. GitHub → Releases → 新建：

   - Tag：`qq-bridge-v0.3.1`
   - 标题随便，比如 `qq bridge 0.3.1`
   - 正文：**写人话**，这几行会直接显示在用户的设置页上（比如「修了：重启 DSH 后桥接偶尔不来」）
   - 附件：把第 3 步的 zip 拖进去

5. 用户侧：设置 → QQ 桥接 → **检查更新** → 看到新版和说明 → **一键更新** → 重启 DSH。

## 装的时候发生了什么

```
下载 zip → 解压到临时目录 → 校验（名字必须是 dsh-qq-bridge、版本要和 release 对上）
   → 备份当前插件到 %USERPROFILE%\.dsh\plugins\.backup\dsh-qq-bridge-<旧版本>-<时间>\
   → 覆盖 package.json / cordis.patch.yml / README.md / lib / docs
   → 提示重启
```

- **只覆盖上面这几个**，不删别的、不动 `node_modules`。
- **不碰桥接本体**（`D:\DSH\qq-bridge`）和她的数据（记忆、人格卡、黑话、表情）——
  那种大更新仍然走安装包。
- 解压带越界路径检查（防 zip-slip），包大于 30 MB 直接拒绝。

## 回滚

更新前的整份插件在：

```
%USERPROFILE%\.dsh\plugins\.backup\dsh-qq-bridge-<旧版本>-<时间>\
```

拷回去、重启 DSH 就是旧版。也可以直接装旧版本的补丁包（更新器允许「从大版本降到小版本」吗？
不允许——它只认「latest > current」；要降级就手动拷备份）。

## 自测怎么测的

`test/update.mjs` 不碰真 GitHub：它现场起一个假的 API、用 `tar` 打一个 9.9.9 的假插件包，
然后真走一遍 下载 → 解压 → 校验 → 备份 → 覆盖，还测了「别的插件的包会被拒绝」和「没有发布包时说清楚」。

## 第一次用：先告诉它去哪个仓库找

这个项目还没开源，或者你想自己拿一份，所以**默认没有更新源**，插件不会去敲任何仓库。

新建仓库之后，在设置页「检查更新」里填一次就行（写成 `用户名/仓库名`），
它存在 `%USERPROFILE%\.dsh\dsh-qq-bridge-update.json`：

```json
{ "repo": "yourname/qq-bridge" }
```

也可以走环境变量（优先级最高）：

```powershell
$env:DSH_QQ_BRIDGE_REPO = 'yourname/qq-bridge'
```

**别和别的插件共用一个仓库入口**：星图开机用的是它自己的仓库（tag 形如 `v1.8.0`）。
虽然更新器只认 `qq-bridge-v*` 和 `dsh-qq-bridge-*.zip`、不会认错，但独立仓库更省心。

自建的 API 镜像可以用 `DSH_QQ_BRIDGE_UPDATE_API` 指过去（路径要兼容 GitHub 的
`/repos/:owner/:repo/releases`）。

私有仓库或者撞到 GitHub 限流（匿名每小时 60 次）时，给一个 token：

```powershell
$env:DSH_QQ_BRIDGE_GITHUB_TOKEN = 'ghp_xxxx'   # 或 GITHUB_TOKEN
```

不给也能用，只是私有仓库查不到、限流时提示「过一会儿再试」。
