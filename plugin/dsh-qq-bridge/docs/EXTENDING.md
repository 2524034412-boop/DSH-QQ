# 拓展接口

这个插件对外只开两个口子，别的插件（或本机脚本）靠它们接进来，不用改这里的代码。

| 口子 | 给谁用 | 怎么接 |
| --- | --- | --- |
| **卡片扩展槽** | 有浏览器那一半的 DSH 插件 | `ctx.slots.inject('settings.qq-bridge.card', …)` |
| **HTTP 接口** | 任何进程 / 任何语言 | `GET http://127.0.0.1:<DSH 端口>/dsh-qq-bridge/…` |

两条都是**只增不改**的：以后加东西往清单里加，不会让别人的代码半夜失效。

---

## 一、往「QQ 桥接」页里加一张卡片

设置 → QQ 桥接 这一页是**整个系列共用的入口**。要给刷B站、星图或者你自己的东西
加一块面板，别各开一个设置分区，直接往这页的末尾加卡片。

> 注意：0.3.1 起页面分了五个标签（总览 / 连接 / 灵魂 / 记忆 / 系统），
> 扩展卡片会在**「系统」**标签的最下面出现。

### 槽位

```
settings.qq-bridge.card      kind: list, scope: root
```

- 由本插件声明（注册 `settings.section` 时放在 `children` 里），你只管往里注册。
- `order` 约定：核心卡片占 `10–90`，扩展**从 100 起，按 10 递增**。
- 槽位空了不会画空框，页面跟没装你的插件时一模一样。
- 传给你的 props：`{ base, version }`（`base` 是接口前缀，`version` 是本插件版本）。

### 最小例子：一个完整的扩展插件

四个文件，放进 `%USERPROFILE%\.dsh\plugins\dsh-qq-hello\`，然后让 profile 认得它（下面三步），重启 DSH。

`package.json`

```json
{
  "name": "dsh-qq-hello",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
  }
}
```

`cordis.patch.yml`

```yaml
- insert:
    - id: qq-hello
      name: dsh-qq-hello
```

### 三步挂上去

1. 目录放好（上面四个文件）。

2. 两处登记，都在 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

   ```json
   "dependencies": {
     "dsh-qq-hello": "link:C:/Users/<你>/.dsh/plugins/dsh-qq-hello"
   },
   "dsh": { "profile": { "bundles": [ … , "dsh-qq-hello" ] } }
   ```

   路径用正斜杠，`<你>` 换成你的用户名。`bundles` 里少加一项，插件就是「装着不动」。

3. 在 profile 里建链接（`pnpm install` 做的就是这一步，不想跑 pnpm 就手建 junction）：

   ```cmd
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-qq-hello" "%USERPROFILE%\.dsh\plugins\dsh-qq-hello"
   ```

   DSH 自带的 pnpm 在
   `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，
   用同目录的 node 跑它也行。

弄完重启 DSH，设置 → QQ 桥接 → **系统** 标签的最下面就会出现你那张卡。

`lib/index.js`（宿主那一半，这里什么都不做，但文件必须存在）

```js
export function apply() {}
```

`lib/client.js`（浏览器那一半，卡片本身）

```js
window.__ModuleLoader__.load({
  id: 'dsh-qq-hello',            // 必须等于包名
  factory(require) {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    function HelloCard(props) {
      const [state, setState] = React.useState({ loading: true, text: '' })
      React.useEffect(() => {
        let alive = true
        // 同源请求，不用 token：宿主自己读 state/console-token。
        fetch(props.base + '/status', { cache: 'no-store' })
          .then((r) => r.json())
          .then((data) => { if (alive) setState({ loading: false, text: data.ok ? data.nextStep : String(data.error) }) })
          .catch((error) => { if (alive) setState({ loading: false, text: String(error && error.message) }) })
        return () => { alive = false }
      }, [props.base])

      return h('div', { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '来自 dsh-qq-hello'),
        h('p', { className: 'qbg-note' }, state.loading ? '读取中…' : state.text)
      )
    }

    function apply(ctx) {
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          const dispose = ctx.slots.inject('settings.qq-bridge.card', () =>
            ctx.slots.register({ name: 'settings.qq-bridge.card', id: 'qq-hello', order: 100 }, HelloCard)
          )
          if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => dispose, 'qq-hello: card')
          }
          return
        }
      } catch (error) {
        console.warn('[dsh-qq-hello] 卡片没挂上', error)
      }
    }

    exports.name = 'qq-hello'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
```

### 写卡片的几条硬规矩

1. **别抛异常**。卡片渲染时抛，本插件只把那一块显示成「扩展卡片渲染失败」，
   不会崩整页 —— 但你的卡片就白做了。同理，你的 `apply` 里凡是注册，
   都要 `try/catch` 兜住。
2. **样式用这里现成的**：`.qbg-card` `.qbg-title` `.qbg-note` `.qbg-grid` `.qbg-row`
   `.qbg-btn` `.qbg-input` `.qbg-chip` `.qbg-ok` `.qbg-bad`。别再往 `<head>` 里灌一套全局样式。
3. **副作用要清**。定时器、监听、fetch 的 `alive` 标记，都在 `useEffect` 的返回值里收掉。
4. **别改核心卡片的 DOM**，也别抢 `settings.qq-bridge.card` 以外的槽位。
5. **卸载要能干净退出**。`inject` 返回的 disposer 交给 `ctx.effect`，别自己收着。

---

## 二、HTTP 接口

同源、返回 JSON。成功一律 `{ ok: true, … }`，失败统一 `{ ok: false, error: "说明" }`。

**清单就长在服务器上**：`GET /dsh-qq-bridge/api` 返回这一版所有路由、方法和扩展槽，
永远和真实注册表一致（本插件的自测会检查它）。先拉清单再写代码，别照抄文档。

```
GET /dsh-qq-bridge/api
```

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/status` | GET | 总状态：桥接目录、在线、四个灯、下一步建议 |
| `/setup` | GET | 新手引导检查项（含 `optional` 可选项） |
| `/config` | GET / POST | 白名单、管理员 QQ、静默；POST 先备份再原子写入 |
| `/roles` | GET | 角色列表与当前角色 |
| `/role` | POST | 切换角色 `{ role }` |
| `/role/edit` | GET / POST | 读写角色正文 `{ name, content }` |
| `/settings` | GET / POST | 开关与数值 `{ flags, numbers, strings, enums }` |
| `/action` | POST | `{ action: "restart" \| "connect" \| "test-send" }` |
| `/logs` | GET | 日志尾部 `?n=行数` |
| `/slang` | GET / POST | 黑话库查询 / 增删 |
| `/stickers` | GET | 收藏表情 |
| `/prompt` | GET / POST | 提示词文件读写 |
| `/digest` | GET | 刷B站日报（最新一份 Markdown） |
| `/social` | GET | 事件、印象、好感度 |
| `/memory` | GET | 记忆星图地址（带控制台令牌，可直接给 iframe / 新窗口；页面本身 `frame-ancestors *`） |
| `/update` | GET / POST | 检查更新；`POST {action:"apply"}` 下载并装上最新补丁包 |
| `/api` | GET | 这份清单 |

### 本机脚本示例

```powershell
# 状态
Invoke-RestMethod http://127.0.0.1:59479/dsh-qq-bridge/status | Select-Object listening, nextStep

# 重启桥接
Invoke-RestMethod http://127.0.0.1:59479/dsh-qq-bridge/action -Method Post \
  -ContentType 'application/json' -Body '{"action":"restart"}'
```

### 安全

- **写操作要求同源**：浏览器发来的 POST 带 `Origin`，只要不是本机（`127.0.0.1` / `localhost`）
  就 403。本机脚本不带 `Origin`，放行。
- 插件自己读 `qq-bridge/state/console-token`，**不需要**你把 token 交出来。
- 写 `config.json` 之前先落在 `config.json.bak-settings-<时间>`，写的时候是临时文件 + rename。

---

## 三、兼容承诺

- 路由和槽位**只增不改**；真要换结构，加新路径（`/v2/…` 之类），旧的继续在。
- 契约版本放在 `/api` 的 `schemaVersion`（现在是 `1`）。它变了才需要你改代码。
- 卡片槽的 props 只增不减。
