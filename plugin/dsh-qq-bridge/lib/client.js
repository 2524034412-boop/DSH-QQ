window.__ModuleLoader__.load({
  // 浏览器工件的 id 必须等于**包名**，不是条目 id。
  id: 'dsh-qq-bridge',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    const BASE = '/dsh-qq-bridge'
    const STATUS_MS = 10000
    const PLUGIN_VERSION = '0.5.1'
    // SnowLuma 是第三方项目，不随包分发：给一份我们写的安装说明。
    const SNOWLUMA_GUIDE = 'https://github.com/2524034412-boop/DSH-QQ/blob/main/docs/SNOWLUMA.md'

    /*
     * 卡片扩展槽。
     *
     * 这一页是「QQ 桥接」的唯一入口，以后加东西（刷B站的日报卡、别的玩具）
     * 都往这同一张页面里加，别再各开一个设置分区。约定：
     *   - 声明在这里，注册 settings.section 时原样放进 children；
     *   - 别人的客户端里 ctx.slots.inject('settings.qq-bridge.card', ...) 再 register；
     *   - order：核心卡片 10–90，扩展从 100 起，按 10 递增。
     * 槽位空了就什么都不画，不留空框。
     */
    const CARD_SLOT = 'settings.qq-bridge.card'
    // 用计算键写，免得槽名改一处漏一处。
    const CHILD_SLOTS = {}
    CHILD_SLOTS[CARD_SLOT] = { kind: 'list', scope: 'root' }

    /* ---------- 样式（只注入一次） ---------- */

    const STYLE_ID = 'qbg-style'
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      // 「灵犀」皮肤：跟随 DSH 主题变量（亮/暗自动），只用 transform/opacity 过渡，
      // 没有常驻动画、没有 WebGL；动画只在进页、切页、悬停时跑一次。
      style.textContent = [
        '.qbg-page{--q-acc:var(--dsw-alias-brand-primary,#4d6bfe);--q-fg:var(--dsw-alias-label-primary,currentColor);--q-fg2:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));',
        '  --q-line:var(--dsw-alias-border-l2,rgba(127,127,127,.2));--q-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));',
        '  --q-ok:#2fbf87;--q-bad:#ef5b67;--q-warn:#e2a23b;--q-ease:cubic-bezier(.22,1,.36,1);--q-ease2:cubic-bezier(.65,0,.35,1);',
        '  --q-serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif;',
        '  --q-surf:color-mix(in srgb,var(--q-fg) 2.5%,transparent);',
        '  display:flex;flex-direction:column;gap:14px;font-feature-settings:"tnum"}',
        '.qbg-ext{display:flex;flex-direction:column;gap:14px}',
        /* hero */
        '.qbg-hero{position:relative;overflow:hidden;display:flex;align-items:center;gap:18px;padding:22px 24px;border-radius:18px;border:1px solid var(--q-line);',
        '  background:radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--q-acc) 16%,transparent),transparent 55%),radial-gradient(90% 120% at 100% 100%,color-mix(in srgb,#b06bff 12%,transparent),transparent 60%),var(--q-surf);',
        '  animation:qbg-rise .7s var(--q-ease) both}',
        '.qbg-hero::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,transparent 30%,color-mix(in srgb,#fff 14%,transparent) 50%,transparent 70%);transform:translateX(-120%);animation:qbg-sheen 1.6s .25s var(--q-ease2) both}',
        '.qbg-mark{position:relative;flex:none;width:52px;height:52px}',
        '.qbg-mark i{position:absolute;top:50%;width:30px;height:30px;margin-top:-15px;border-radius:50%;border:1.5px solid var(--q-acc);transition:transform .6s var(--q-ease)}',
        '.qbg-mark i:first-child{left:2px;background:color-mix(in srgb,var(--q-acc) 14%,transparent)}',
        '.qbg-mark i:last-child{right:2px;border-color:#b06bff;background:color-mix(in srgb,#b06bff 10%,transparent)}',
        '.qbg-hero:hover .qbg-mark i:first-child{transform:translateX(4px)}.qbg-hero:hover .qbg-mark i:last-child{transform:translateX(-4px)}',
        '.qbg-hero-text{flex:1;min-width:0}',
        '.qbg-eyebrow{font-size:10px;letter-spacing:.32em;color:var(--q-fg2);text-transform:uppercase}',
        '.qbg-name{margin:2px 0 4px;font-family:var(--q-serif);font-weight:600;font-size:30px;letter-spacing:.18em;line-height:1.15;',
        '  color:var(--q-fg)}',
        '.qbg-tag{margin:0;font-size:12px;color:var(--q-fg2);letter-spacing:.04em}',
        '.qbg-pill{flex:none;display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;font-size:12px;border:1px solid var(--q-line);background:color-mix(in srgb,var(--q-fg) 4%,transparent);transition:border-color .4s,color .4s}',
        '.qbg-pill-dot{width:7px;height:7px;border-radius:50%;background:var(--q-fg2)}',
        '.qbg-pill.is-ok{color:var(--q-ok);border-color:color-mix(in srgb,var(--q-ok) 40%,transparent)}.qbg-pill.is-ok .qbg-pill-dot{background:var(--q-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--q-ok) 22%,transparent)}',
        '.qbg-pill.is-warn{color:var(--q-warn);border-color:color-mix(in srgb,var(--q-warn) 40%,transparent)}.qbg-pill.is-warn .qbg-pill-dot{background:var(--q-warn)}',
        '.qbg-pill.is-bad{color:var(--q-bad);border-color:color-mix(in srgb,var(--q-bad) 40%,transparent)}.qbg-pill.is-bad .qbg-pill-dot{background:var(--q-bad)}',
        /* tabs */
        '.qbg-tabs{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:repeat(var(--n,4),1fr);padding:4px;border-radius:12px;border:1px solid var(--q-line);',
        '  background:var(--q-surf);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:qbg-rise .7s .06s var(--q-ease) both}',
        '.qbg-tabs::before{content:"";position:absolute;top:4px;bottom:4px;left:4px;width:calc((100% - 8px) / var(--n,4));border-radius:9px;',
        '  background:color-mix(in srgb,var(--q-acc) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--q-acc) 30%,transparent);transform:translateX(calc(var(--i,0) * 100%));transition:transform .5s var(--q-ease)}',
        '.qbg-tab{position:relative;appearance:none;border:0;background:none;color:var(--q-fg2);font:inherit;font-size:13px;padding:8px 0;border-radius:9px;cursor:pointer;transition:color .3s}',
        '.qbg-tab:hover{color:var(--q-fg)}.qbg-tab[aria-selected=true]{color:var(--q-fg);font-weight:600}',
        '.qbg-tab small{display:block;font-size:10px;font-weight:400;opacity:.6;letter-spacing:.08em;margin-top:1px}',
        '.qbg-tab:focus-visible{outline:2px solid var(--q-acc);outline-offset:-2px}',
        '.qbg-sec{display:none;flex-direction:column;gap:14px}.qbg-sec.is-on{display:flex}',
        '.qbg-sec.is-on>*{animation:qbg-rise .55s var(--q-ease) both}',
        '.qbg-sec.is-on>:nth-child(2){animation-delay:.05s}.qbg-sec.is-on>:nth-child(3){animation-delay:.1s}.qbg-sec.is-on>:nth-child(4){animation-delay:.15s}.qbg-sec.is-on>:nth-child(n+5){animation-delay:.2s}',
        /* cards */
        '.qbg-frame{width:100%;height:460px;border:1px solid var(--q-line);border-radius:14px;background:#05060a;margin-top:10px;animation:qbg-fade .5s var(--q-ease) both}',
        '.qbg-card{position:relative;border:1px solid var(--q-line);border-radius:16px;padding:16px 18px;background:var(--q-surf);transition:border-color .35s var(--q-ease),box-shadow .35s var(--q-ease),transform .35s var(--q-ease)}',
        '.qbg-card:hover{border-color:color-mix(in srgb,var(--q-acc) 28%,var(--q-line));box-shadow:0 10px 30px -18px color-mix(in srgb,var(--q-acc) 45%,transparent)}',
        '.qbg-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;letter-spacing:.04em;margin:0 0 12px;color:var(--q-fg)}',
        '.qbg-title::before{content:"";width:3px;height:13px;border-radius:2px;background:linear-gradient(var(--q-acc),#b06bff)}',
        '.qbg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:4px 18px}',
        '.qbg-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px}',
        '.qbg-ok{background:var(--q-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--q-ok) 18%,transparent)}.qbg-bad{background:var(--q-bad)}.qbg-warn{background:var(--q-warn)}.qbg-idle{background:var(--q-fg2);opacity:.6}',
        '.qbg-kv{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;line-height:1.7;padding:5px 0;border-bottom:1px dashed color-mix(in srgb,var(--q-line) 70%,transparent)}',
        '.qbg-kv:last-child{border-bottom:0}',
        '.qbg-kv span:first-child{color:var(--q-fg2)}',
        '.qbg-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
        /* controls */
        '.qbg-btn{appearance:none;border:1px solid var(--q-line);background:transparent;color:var(--q-fg);border-radius:10px;padding:6px 14px;font:inherit;font-size:12.5px;cursor:pointer;',
        '  transition:background .25s,border-color .25s,transform .2s var(--q-ease),box-shadow .25s}',
        '.qbg-btn:hover{background:var(--q-hover);border-color:color-mix(in srgb,var(--q-acc) 35%,var(--q-line))}',
        '.qbg-btn:active{transform:scale(.96)}',
        '.qbg-btn:focus-visible,.qbg-input:focus-visible,.qbg-x:focus-visible{outline:2px solid var(--q-acc);outline-offset:2px}',
        '.qbg-btn[disabled]{opacity:.42;cursor:default;transform:none}',
        '.qbg-primary{border-color:transparent;color:#fff;background:linear-gradient(120deg,var(--q-acc),color-mix(in srgb,var(--q-acc) 55%,#b06bff));box-shadow:0 6px 18px -10px var(--q-acc)}',
        '.qbg-primary:hover{background:linear-gradient(120deg,var(--q-acc),color-mix(in srgb,var(--q-acc) 40%,#b06bff));border-color:transparent;box-shadow:0 8px 22px -10px var(--q-acc);transform:translateY(-1px)}',
        '.qbg-input{background:color-mix(in srgb,var(--q-fg) 3%,transparent);border:1px solid var(--q-line);color:var(--q-fg);border-radius:10px;padding:6px 11px;font:inherit;font-size:12.5px;min-width:120px;transition:border-color .25s,box-shadow .25s}',
        '.qbg-input:focus{outline:none;border-color:var(--q-acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--q-acc) 18%,transparent)}',
        '.qbg-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--q-line);border-radius:999px;padding:4px 12px;font-size:12px;margin:0 6px 6px 0;background:color-mix(in srgb,var(--q-fg) 2%,transparent);transition:border-color .3s,background .3s,color .3s}',
        '.qbg-chip:has(input:checked){border-color:color-mix(in srgb,var(--q-acc) 45%,transparent);background:color-mix(in srgb,var(--q-acc) 9%,transparent)}',
        /* 开关：把原生 checkbox 画成小拨杆，点击区域和键盘操作都不变 */
        '.qbg-chip input[type=checkbox]{appearance:none;-webkit-appearance:none;margin:0;flex:none;width:26px;height:15px;border-radius:999px;background:color-mix(in srgb,var(--q-fg) 18%,transparent);position:relative;cursor:pointer;transition:background .3s var(--q-ease)}',
        '.qbg-chip input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .35s var(--q-ease)}',
        '.qbg-chip input[type=checkbox]:checked{background:var(--q-acc)}.qbg-chip input[type=checkbox]:checked::after{transform:translateX(11px)}',
        '.qbg-chip input[type=checkbox]:disabled{opacity:.5}',
        '.qbg-x{cursor:pointer;opacity:.5;border:none;background:none;color:inherit;font-size:14px;line-height:1;padding:0 2px;border-radius:50%;transition:opacity .2s,color .2s,transform .2s var(--q-ease)}',
        '.qbg-x:hover{opacity:1;color:var(--q-bad);transform:rotate(90deg)}',
        '.qbg-note{font-size:11.5px;line-height:1.65;color:var(--q-fg2);margin:8px 0 0}',
        '.qbg-warnline{font-size:12px;color:var(--q-warn)}',
        '.qbg-err{font-size:12px;color:var(--q-bad);margin:6px 0 0;animation:qbg-fade .35s var(--q-ease) both}',
        '.qbg-page pre{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--q-fg) 4%,transparent);transition:max-height .5s var(--q-ease)}',
        '.qbg-page textarea:focus{outline:none;border-color:var(--q-acc)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--q-acc) 16%,transparent)}',
        '.qbg-page ::-webkit-scrollbar{width:6px;height:6px}.qbg-page ::-webkit-scrollbar-thumb{border-radius:3px;background:color-mix(in srgb,var(--q-fg) 18%,transparent)}',
        '@keyframes qbg-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
        '.qbg-stickers{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:8px}',
        '.qbg-sticker{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;border:1px solid var(--q-line);border-radius:10px;background:var(--q-surf)}',
        '.qbg-sticker img{width:64px;height:64px;object-fit:contain;border-radius:6px}',
        '.qbg-sticker figcaption{font-size:10px;opacity:.72;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.qbg-backup{display:flex;gap:8px;align-items:center;font-size:11px;line-height:1.7}',
        '@keyframes qbg-fade{from{opacity:0}to{opacity:1}}',        '@keyframes qbg-sheen{to{transform:translateX(120%)}}',
        '@media (max-width:560px){.qbg-hero{flex-wrap:wrap;padding:18px}.qbg-name{font-size:24px}.qbg-tab small{display:none}}',
        '@media (prefers-reduced-motion:reduce){.qbg-page *,.qbg-page *::before,.qbg-page *::after,.qbg-hero,.qbg-tabs{animation:none!important;transition:none!important}}'
      ].join('\n')
      document.head.appendChild(style)
    }

    /* ---------- 数据 ---------- */

    function useJson(url, deps) {
      // url 传 null = 「这份数据由父组件给」，自己不去请求（省重复轮询）。
      const skip = typeof url !== 'string' || url === ''
      const [state, setState] = React.useState(skip ? { loading: false, data: null, error: '' } : { loading: true, data: null, error: '' })
      const reload = React.useCallback(() => {
        if (skip) return () => {}
        let alive = true
        fetch(url, { cache: 'no-store' })
          .then(async (response) => ({ ok: response.ok, status: response.status, data: await response.json().catch(() => null) }))
          .then((payload) => {
            if (!alive) return
            if (payload.ok && payload.data && payload.data.ok !== false) {
              setState({ loading: false, data: payload.data, error: '' })
            } else {
              setState({ loading: false, data: null, error: (payload.data && payload.data.error) || '读取失败 ' + payload.status })
            }
          })
          .catch((error) => {
            if (!alive) return
            setState({ loading: false, data: null, error: String(error && error.message ? error.message : error) })
          })
        return () => {
          alive = false
        }
      }, deps === undefined ? [] : deps)
      React.useEffect(reload, [reload])
      return [state, reload]
    }

    function post(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body)
      }).then(async (response) => ({ ok: response.ok, status: response.status, data: await response.json().catch(() => null) }))
    }

    /**
     * 让整页重新看一眼状态（不改任何数据）。
     * 新手引导里点完「从示例创建配置」「重启桥接」后，第一屏该立刻展开，
     * 而不是等 10 秒轮询——用户会以为按钮没生效。
     */
    function pingPage() {
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof Event === 'function') {
          window.dispatchEvent(new Event('qbg-recheck'))
        }
      } catch (error) {
        /* 事件发不出去不影响主流程 */
      }
    }

    function Dot(props) {
      const tone = props.tone === true ? 'qbg-ok' : props.tone === 'warn' ? 'qbg-warn' : props.tone === 'idle' ? 'qbg-idle' : 'qbg-bad'
      return h('span', { className: 'qbg-dot ' + tone })
    }

    function GuideCard() {
      const [state, reload] = useJson(BASE + '/setup')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      if (state.data === null) {
        return state.error === '' ? null : h('div', { className: 'qbg-card' }, h('p', { className: 'qbg-title' }, '新手引导'), h('p', { className: 'qbg-err' }, state.error))
      }
      const steps = state.data.steps || []
      const ready = state.data.ready === true
      const restart = () => {
        setBusy(true)
        post(BASE + '/action', { action: 'restart' }).finally(() => { setBusy(false); reload(); pingPage() })
      }
      return h(
        'div',
        { className: 'qbg-card' },
        h('div', { className: 'qbg-row', style: { justifyContent: 'space-between', marginBottom: '6px' } },
          h('p', { className: 'qbg-title', style: { margin: 0 } }, ready ? '✓ 全部就绪' : '新手引导：还差几步'),
          h('button', { className: 'qbg-btn', onClick: () => { reload(); pingPage() } }, '重新检测')
        ),
        steps.map((step) =>
          h('div', { className: 'qbg-kv', key: step.id, style: step.optional ? { opacity: 0.72 } : undefined },
            h('span', null, h(Dot, { tone: step.unknown === true ? 'idle' : step.ok }), step.label),
            h('span', { style: { fontSize: '11px', maxWidth: '60%', textAlign: 'right' } }, step.ok ? '好了' : step.hint)
          )),
        ready
          ? null
          : h('div', { className: 'qbg-row', style: { marginTop: '10px' } },
              steps.some((step) => step.id === 'snowluma' && step.ok !== true)
                ? h('button', { className: 'qbg-btn qbg-primary', onClick: () => window.open(SNOWLUMA_GUIDE, '_blank', 'noopener') }, '怎么装 SnowLuma')
                : null,
              h('button', { className: 'qbg-btn', onClick: () => window.open('http://127.0.0.1:5099', '_blank', 'noopener') }, '打开 SnowLuma'),
              h('button', { className: 'qbg-btn', disabled: busy, onClick: restart }, busy ? '重启中…' : '重启桥接'),
              steps.some((step) => step.id === 'config' && step.ok === false)
                ? h('button', {
                    className: 'qbg-btn',
                    disabled: busy,
                    onClick: () => {
                      setBusy(true)
                      post(BASE + '/action', { action: 'init-config' })
                        .then((result) => {
                          setMsg(result.ok && result.data && result.data.created !== false ? '已生成 config.json' : '失败：' + ((result.data && result.data.error) || result.status))
                        })
                        .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
                        .finally(() => { setBusy(false); reload(); pingPage() })
                    }
                  }, '从示例创建配置')
                : null
            ),
        msg !== '' ? h('p', { className: 'qbg-note' }, msg) : null
      )
    }

    function StatusCard(props) {
      // 页面已经有一份 /status：优先用传下来的，别每个组件各轮询一遍。
      const external = props && props.status ? props.status : null
      const [state, reload] = useJson(external === null ? BASE + '/status' : null)
      React.useEffect(() => {
        if (external !== null) return undefined
        const timer = setInterval(reload, STATUS_MS)
        return () => clearInterval(timer)
      }, [external, reload])
      const view = external !== null ? external : state
      const data = view.data
      const diag = data && data.diag ? data.diag : null
      // 端口通 ≠ 我们的桥接在跑：别人占着 3100 也会通，所以必须同时看到程序文件。
      const exists = Boolean(data && data.exists)
      const listening = Boolean(data && data.listening)
      const bridgeOk = exists && listening
      const row = (label, ok, extra) =>
        h('div', { className: 'qbg-kv', key: label }, h('span', null, label), h('span', null, h(Dot, { tone: ok }), extra || (ok ? '正常' : '未连接')))
      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '运行状态'),
        view.error !== '' ? h('p', { className: 'qbg-err' }, view.error) : null,
        h('div', { className: 'qbg-grid' },
          h('div', null,
            row('桥接', bridgeOk, !exists ? (listening ? '这个端口被别的程序占着' : '桥接程序没找到') : null),
            row('DSH 连接', Boolean(diag && diag.dsh)),
            row('SnowLuma', Boolean(diag && diag.snowluma))
          ),
          h('div', null,
            row('OneBot', Boolean(diag && diag.onebot)),
            row('QQ 进程', Boolean(diag && diag.qq)),
            h('div', { className: 'qbg-kv' }, h('span', null, '提示'), h('span', null, (diag && diag.note) || (!exists ? '先放好桥接程序' : bridgeOk ? '—' : '桥接没在跑')))
          )
        ),
        h('p', { className: 'qbg-note' }, data && data.bridgeRoot ? data.bridgeRoot : ''),
        data && data.nextStep ? h('p', { className: 'qbg-note', style: { marginTop: '4px', opacity: 1 } }, '→ ' + data.nextStep) : null
      )
    }

    function Actions(props) {
      const external = props && props.status ? props.status : null
      const [state] = useJson(external === null ? BASE + '/status' : null)
      const view = external !== null ? external : state
      const hidden = Boolean(view.data && view.data.hideConsolePages === true)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [text, setText] = React.useState('')
      const [audio, setAudio] = React.useState('')

      const run = (action, label, extra) => {
        setBusy(action)
        setMsg('')
        post(BASE + '/action', Object.assign({ action }, extra))
          .then((result) => {
            const ok = result.ok && result.data && result.data.ok !== false
            setMsg(ok ? (action === 'restart' ? '已开始重启，大约 10~15 秒。' : label + '成功。') : '失败：' + ((result.data && result.data.error) || result.status))
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      const preview = () => {
        setBusy('preview')
        setMsg('')
        fetch(BASE + '/voice/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim() || '你好呀，我是小助手。' })
        })
          .then(async (response) => {
            if (!response.ok) {
              const detail = await response.json().catch(() => null)
              throw new Error((detail && detail.error) || 'HTTP ' + response.status)
            }
            const blob = await response.blob()
            if (audio !== '') URL.revokeObjectURL(audio)
            const url = URL.createObjectURL(blob)
            setAudio(url)
            try {
              await new Audio(url).play()
            } catch (error) {
              /* 浏览器不让自动播就留着播放条 */
            }
            setMsg('合成好了，下面可以直接播。')
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      const diagnose = () => {
        setBusy('diag')
        setMsg('')
        fetch(BASE + '/diagnose', { cache: 'no-store' })
          .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => null) }))
          .then((payload) => {
            const body = payload.ok && payload.data && typeof payload.data.text === 'string' ? payload.data.text : ''
            if (body === '') throw new Error('诊断接口没给内容')
            if (navigator.clipboard && navigator.clipboard.writeText) {
              return navigator.clipboard.writeText(body).then(() => {
                setMsg('诊断信息已复制到剪贴板，直接粘给人看就行。')
              })
            }
            throw new Error('这个环境不让写剪贴板，去「系统」页的日志卡里手动复制')
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '操作'),
        h('div', { className: 'qbg-row' },
          h('input', {
            className: 'qbg-input',
            style: { flex: '1 1 220px' },
            placeholder: '测试消息内容（留空就发默认那句）',
            value: text,
            onChange: (event) => setText(event.target.value)
          }),
          h('button', { className: 'qbg-btn qbg-primary', disabled: busy !== '', onClick: () => run('test', '测试发送', { text }) }, busy === 'test' ? '发送中…' : '发文字'),
          h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: preview }, busy === 'preview' ? '合成中…' : '试听语音')
        ),
        h('div', { className: 'qbg-row', style: { marginTop: '8px' } },
          h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: () => run('restart', '重启') }, busy === 'restart' ? '重启中…' : '重启桥接'),
          h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: () => run('connect', '一键对接') }, busy === 'connect' ? '对接中…' : '一键对接'),
          h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: () => run('open-dashboard', '打开可视化面板') }, busy === 'open-dashboard' ? '打开中…' : '打开可视化面板'),
          h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: diagnose }, busy === 'diag' ? '整理中…' : '复制诊断信息'),
          hidden ? null : h('button', {
                className: 'qbg-btn',
                onClick: () => {
                  try {
                    window.open('http://127.0.0.1:3100/panel', '_blank', 'noopener')
                  } catch (error) {
                    setMsg('打不开面板：' + String(error && error.message ? error.message : error))
                  }
                }
              }, '打开旧面板')
        ),
        audio !== '' ? h('audio', { src: audio, controls: true, style: { width: '100%', marginTop: '8px' } }) : null,
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null
      )
    }

    function AccessCard() {
      const [state, reload] = useJson(BASE + '/config')
      const [config, setConfig] = React.useState(null)
      const [group, setGroup] = React.useState('')
      const [single, setSingle] = React.useState('')
      const [owner, setOwner] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [bulk, setBulk] = React.useState('')
      const [bulkKind, setBulkKind] = React.useState('groups')

      React.useEffect(() => {
        if (state.data === null) return
        setConfig(state.data.config)
        setOwner(state.data.config.ownerQQ || '')
      }, [state.data])

      if (config === null) {
        if (state.error === '') return null
        return h(
          'div',
          { className: 'qbg-card' },
          h('p', { className: 'qbg-title' }, '谁能跟她说话'),
          h('p', { className: 'qbg-err' }, state.error),
          h('p', { className: 'qbg-note' }, '还没有 config.json 可改：先在上面「新手引导」点「从示例创建配置」，再回来填管理员 QQ 和白名单，最后重启桥接。')
        )
      }

      const save = (next) => {
        setBusy(true)
        setMsg('')
        post(BASE + '/config', next)
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setConfig(result.data.config)
              setMsg('已保存。重启桥接后生效。')
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(false))
      }

      const chip = (value, onRemove) =>
        h('span', { className: 'qbg-chip', key: value }, value, h('button', { className: 'qbg-x', title: '删除', onClick: onRemove }, '×'))

      const addTo = (key, raw) => {
        const value = String(raw || '').trim()
        if (!/^\d{4,20}$/.test(value)) {
          setMsg('要填纯数字的 QQ 号 / 群号。')
          return
        }
        const list = config.allow[key].slice()
        if (list.includes(value)) {
          setMsg('已经在里面了。')
          return
        }
        list.push(value)
        save({ ...config, allow: { ...config.allow, [key]: list } })
      }

      const addBulk = () => {
        const numbers = String(bulk).match(/\d{4,20}/g) || []
        if (numbers.length === 0) {
          setMsg('没在这些文字里找到群号 / QQ 号。')
          return
        }
        const list = config.allow[bulkKind].slice()
        let added = 0
        for (const value of numbers) {
          if (!list.includes(value)) {
            list.push(value)
            added += 1
          }
        }
        if (added === 0) {
          setMsg('这些都已经在里面了。')
          return
        }
        save({ ...config, allow: { ...config.allow, [bulkKind]: list } })
        setBulk('')
        setMsg('加了 ' + added + ' 个，重启桥接后生效。')
      }

      const exportConfig = () => {
        try {
          const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'qq-bridge-config-' + new Date().toISOString().slice(0, 10) + '.json'
          link.click()
          URL.revokeObjectURL(url)
          setMsg('已导出（只有管理员和白名单这部分）。')
        } catch (error) {
          setMsg('失败：' + String(error && error.message ? error.message : error))
        }
      }

      const importConfig = (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        if (!window.confirm('用「' + file.name + '」里的管理员和白名单覆盖现在这份？')) return
        const reader = new FileReader()
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result))
            const next = { ...config }
            if (parsed.ownerQQ !== undefined) next.ownerQQ = String(parsed.ownerQQ ?? '').trim()
            if (parsed.allow !== null && typeof parsed.allow === 'object') {
              next.allow = {
                groups: Array.isArray(parsed.allow.groups) ? parsed.allow.groups.map(String) : config.allow.groups,
                private: Array.isArray(parsed.allow.private) ? parsed.allow.private.map(String) : config.allow.private
              }
            }
            if (typeof parsed.allowAllWhenEmpty === 'boolean') next.allowAllWhenEmpty = parsed.allowAllWhenEmpty
            save(next)
            setOwner(String(next.ownerQQ ?? '') || '')
            setMsg('已导入管理员和白名单，重启桥接后生效。')
          } catch (error) {
            setMsg('失败：文件不是合法的 JSON')
          }
        }
        reader.readAsText(file)
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '谁能跟她说话'),
        h('div', { className: 'qbg-row', style: { marginBottom: '10px' } },
          h('span', { style: { fontSize: '12px', minWidth: '52px' } }, '管理员'),
          h('input', { className: 'qbg-input', value: owner, onChange: (event) => setOwner(event.target.value), placeholder: 'QQ 号' }),
          h('button', { className: 'qbg-btn', disabled: busy, onClick: () => save({ ...config, ownerQQ: owner.trim() }) }, '保存')
        ),
        h('div', { style: { marginBottom: '4px', fontSize: '12px' } }, '群'),
        h('div', null, config.allow.groups.map((value) => chip(value, () => save({ ...config, allow: { ...config.allow, groups: config.allow.groups.filter((item) => item !== value) } })))),
        h('div', { className: 'qbg-row', style: { marginBottom: '10px' } },
          h('input', { className: 'qbg-input', value: group, onChange: (event) => setGroup(event.target.value), placeholder: '群号' }),
          h('button', { className: 'qbg-btn', disabled: busy, onClick: () => { addTo('groups', group); setGroup('') } }, '添加群')
        ),
        h('div', { style: { marginBottom: '4px', fontSize: '12px' } }, '私聊'),
        h('div', null, config.allow.private.map((value) => chip(value, () => save({ ...config, allow: { ...config.allow, private: config.allow.private.filter((item) => item !== value) } })))),
        h('div', { className: 'qbg-row' },
          h('input', { className: 'qbg-input', value: single, onChange: (event) => setSingle(event.target.value), placeholder: 'QQ 号' }),
          h('button', { className: 'qbg-btn', disabled: busy, onClick: () => { addTo('private', single); setSingle('') } }, '添加私聊')
        ),
        h('div', { className: 'qbg-row', style: { marginTop: '10px' } },
          h('select', { className: 'qbg-input', value: bulkKind, onChange: (event) => setBulkKind(event.target.value) },
            h('option', { value: 'groups' }, '加进群'),
            h('option', { value: 'private' }, '加进私聊')
          ),
          h('textarea', {
            className: 'qbg-input',
            style: { flex: '1 1 220px', minHeight: '54px', resize: 'vertical' },
            placeholder: '把一串号码粘进来，空格/逗号/换行都行',
            value: bulk,
            onChange: (event) => setBulk(event.target.value)
          }),
          h('button', { className: 'qbg-btn', disabled: busy, onClick: addBulk }, '批量加入')
        ),
        h('div', { className: 'qbg-row', style: { marginTop: '8px' } },
          h('button', { className: 'qbg-btn', onClick: exportConfig }, '导出配置'),
          h('label', { className: 'qbg-btn', style: { cursor: 'pointer', margin: 0 } },
            '导入配置',
            h('input', { type: 'file', accept: 'application/json', style: { display: 'none' }, onChange: importConfig })
          )
        ),
        msg !== '' ? h('p', { className: msg.startsWith('失败') || msg.indexOf('纯数字') >= 0 ? 'qbg-err' : 'qbg-note' }, msg) : null,
        h('p', { className: 'qbg-note' }, '白名单为空且「谁都能说」关着的时候，她不会回任何消息。')
      )
    }

    function ModeAndFlagsCard() {
      const [state, reload] = useJson(BASE + '/settings')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      if (state.data === null) {
        return state.error === ''
          ? null
          : h('div', { className: 'qbg-card' },
              h('p', { className: 'qbg-title' }, '运行设置'),
              h('p', { className: 'qbg-err' }, state.error),
              h('p', { className: 'qbg-note' }, '如果提示找不到 config.json：先去上面的「新手引导」点「从示例创建配置」。'))
      }

      const data = state.data
      const meta = data.meta || {}
      const groupsFlags = meta.flags || {}
      const groupsNumbers = meta.numbers || {}
      const groupsStrings = meta.strings || {}
      const groupsEnums = meta.enums || {}
      const save = (patch) => {
        setBusy(true)
        setMsg('')
        post(BASE + '/settings', patch)
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              const list = (result.data.changed || []).length > 0 ? '：' + result.data.changed.join('、') : ''
              // 有的开关后端会顺手把桥接重启掉（比如「全速模式」），这时别说「重启后生效」，
              // 否则用户会以为还得自己再去点一次「重启桥接」。
              const tail = result.data.restarted === true
                ? '。桥接正在重启，约 10~15 秒后生效。'
                : result.data.restartRequired
                  ? '。重启桥接后生效。'
                  : '。'
              setMsg('已保存' + list + tail)
              reload()
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(false))
      }

      const groups = {}
      for (const key of Object.keys(groupsFlags)) {
        const item = groupsFlags[key]
        if (groups[item.group] === undefined) groups[item.group] = []
        groups[item.group].push({ key, ...item })
      }

      const modeButton = (value, label) =>
        h('button', {
          className: 'qbg-btn' + (data.mode === value ? ' qbg-primary' : ''),
          disabled: busy,
          onClick: () => data.mode === value ? null : save({ mode: value })
        }, label)

      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '运行设置'),
        h('div', { className: 'qbg-row', style: { marginBottom: '10px' } },
          h('span', { style: { fontSize: '12px', minWidth: '52px' } }, '模式'),
          modeButton('reserved2', '二代（工具）'),
          modeButton('reserved', '一代（空格分条）')
        ),
        Object.keys(groups).map((group) =>
          h('div', { key: group, style: { marginBottom: '8px' } },
            h('div', { style: { fontSize: '11px', marginBottom: '4px', color: 'var(--dsh-muted, #8b93a1)' } }, group),
            h('div', { className: 'qbg-row' }, groups[group].map((item) =>
              h('label', { key: item.key, className: 'qbg-chip', style: { cursor: 'pointer' }, title: item.hint },
                h('input', {
                  type: 'checkbox',
                  checked: data.flags[item.key] === true,
                  disabled: busy,
                  onChange: (event) => save({ flags: { [item.key]: event.target.checked } })
                }),
                item.label
              )
            ))
          )
        ),
        h(NumberRow, { meta: groupsNumbers, values: data.numbers || {}, disabled: busy, onSave: save }),
        h(StringRow, { meta: groupsStrings, values: data.strings || {}, disabled: busy, onSave: save }),
        h(EnumRow, { meta: groupsEnums, values: data.enums || {}, disabled: busy, onSave: save }),
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null
      )
    }

    function NumberRow(props) {
      const keys = Object.keys(props.meta || {})
      const [draft, setDraft] = React.useState({})
      if (keys.length === 0) return null
      return h('div', { style: { marginTop: '10px' } },
        keys.map((key) => {
          const meta = props.meta[key]
          const value = draft[key] !== undefined ? draft[key] : (props.values[key] === null ? '' : String(props.values[key]))
          return h('div', { className: 'qbg-row', key, style: { marginBottom: '6px' } },
            h('span', { style: { fontSize: '12px', minWidth: '96px' } }, meta.label),
            h('input', {
              className: 'qbg-input',
              type: 'number',
              min: meta.min,
              max: meta.max,
              step: meta.step,
              value,
              disabled: props.disabled,
              onChange: (event) => setDraft({ ...draft, [key]: event.target.value })
            }),
            h('span', { style: { fontSize: '11px' } }, meta.unit),
            h('button', {
              className: 'qbg-btn',
              disabled: props.disabled || value === '',
              onClick: () => {
                props.onSave({ numbers: { [key]: value } })
                setDraft({ ...draft, [key]: undefined })
              }
            }, '保存')
          )
        })
      )
    }

    function LogsCard() {
      const [query, setQuery] = React.useState('')
      const [applied, setApplied] = React.useState('')
      const [auto, setAuto] = React.useState(false)
      const url = BASE + '/logs?n=200' + (applied === '' ? '' : '&q=' + encodeURIComponent(applied))
      const [state, reload] = useJson(url, [applied])
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState('')

      // 自动刷新：5 秒一次，只在勾上时跑。
      React.useEffect(() => {
        if (!auto) return undefined
        const timer = setInterval(reload, 5000)
        return () => clearInterval(timer)
      }, [auto, reload])

      const lines = state.data && Array.isArray(state.data.lines) ? state.data.lines : []
      const copy = () => {
        const text = lines.join('\n')
        if (text === '') return
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
            .then(() => setMsg('已复制 ' + lines.length + ' 行'))
            .catch(() => setMsg('复制失败：浏览器不让写剪贴板'))
        } else {
          setMsg('这个环境没有剪贴板接口')
        }
      }
      const openFolder = () => {
        setBusy('open')
        setMsg('')
        post(BASE + '/action', { action: 'open-logs' })
          .then((result) => {
            const ok = result.ok && result.data && result.data.ok !== false
            setMsg(ok ? '已打开日志文件夹' : '失败：' + ((result.data && result.data.error) || result.status))
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('div', { className: 'qbg-row', style: { justifyContent: 'space-between', marginBottom: '8px' } },
          h('p', { className: 'qbg-title', style: { margin: 0 } }, '最近日志' + (lines.length > 0 ? '（' + lines.length + ' 行）' : '')),
          h('div', { className: 'qbg-row' },
            h('label', { className: 'qbg-note', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', margin: 0 } },
              h('input', { type: 'checkbox', checked: auto, onChange: (event) => setAuto(event.target.checked) }), '自动刷新'),
            h('button', { className: 'qbg-btn', onClick: reload }, '刷新'),
            h('button', { className: 'qbg-btn', onClick: copy, disabled: lines.length === 0 }, '复制'),
            h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: openFolder }, busy === 'open' ? '打开中…' : '打开文件夹')
          )
        ),
        h('div', { className: 'qbg-row', style: { marginBottom: '8px' } },
          h('input', {
            className: 'qbg-input',
            style: { flex: '1 1 240px' },
            placeholder: '只显示包含这个词的行（回车生效）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') setApplied(query.trim()) }
          }),
          h('button', { className: 'qbg-btn', onClick: () => setApplied(query.trim()) }, '过滤'),
          applied !== '' ? h('button', { className: 'qbg-btn', onClick: () => { setQuery(''); setApplied('') } }, '清除') : null
        ),
        state.data === null
          ? h('p', { className: 'qbg-err' }, state.error === '' ? '读取中…' : state.error)
          : h('pre', {
              style: {
                margin: 0,
                maxHeight: '260px',
                overflow: 'auto',
                fontSize: '11px',
                lineHeight: '1.6',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                opacity: 0.85
              }
            }, lines.join('\n') || (applied === '' ? '（空）' : '（没有匹配的行）')),
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null,
        state.data && state.data.note ? h('p', { className: 'qbg-note' }, state.data.note) : null,
        state.data && state.data.path ? h('p', { className: 'qbg-note' }, state.data.path) : null
      )
    }


    function StringRow(props) {
      const keys = Object.keys(props.meta || {})
      const [draft, setDraft] = React.useState({})
      if (keys.length === 0) return null
      return h('div', { style: { marginTop: '8px' } },
        keys.map((key) => {
          const meta = props.meta[key]
          const value = draft[key] !== undefined ? draft[key] : (props.values[key] || '')
          return h('div', { className: 'qbg-row', key, style: { marginBottom: '6px' } },
            h('span', { style: { fontSize: '12px', minWidth: '96px' } }, meta.label),
            h('input', {
              className: 'qbg-input',
              style: { flex: '1 1 200px' },
              maxLength: meta.max,
              placeholder: meta.placeholder,
              value,
              disabled: props.disabled,
              onChange: (event) => setDraft({ ...draft, [key]: event.target.value })
            }),
            h('button', {
              className: 'qbg-btn',
              disabled: props.disabled,
              onClick: () => {
                props.onSave({ strings: { [key]: value } })
                setDraft({ ...draft, [key]: undefined })
              }
            }, '保存')
          )
        })
      )
    }

    function EnumRow(props) {
      const keys = Object.keys(props.meta || {})
      if (keys.length === 0) return null
      return h('div', { style: { marginTop: '8px' } },
        keys.map((key) => {
          const meta = props.meta[key]
          const value = props.values[key] || (meta.options[0] && meta.options[0].value) || ''
          return h('div', { className: 'qbg-row', key, style: { marginBottom: '6px' } },
            h('span', { style: { fontSize: '12px', minWidth: '96px' } }, meta.group + ' · ' + meta.label),
            h('select', {
              className: 'qbg-input',
              value,
              disabled: props.disabled,
              onChange: (event) => props.onSave({ enums: { [key]: event.target.value } })
            }, meta.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
          )
        })
      )
    }

    function SlangCard() {
      const [query, setQuery] = React.useState('')
      const [state, reload] = useJson(BASE + '/slang')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState('')

      if (state.data === null) {
        return state.error === '' ? null : h('div', { className: 'qbg-card' }, h('p', { className: 'qbg-title' }, '黑话词库'), h('p', { className: 'qbg-err' }, state.error))
      }

      const all = state.data.items || []
      const needle = query.trim().toLowerCase()
      const shown = needle === '' ? all : all.filter((item) => (item.content + item.meaning).toLowerCase().includes(needle))

      const remove = (item) => {
        if (!window.confirm('删掉「' + item.content + '」？删了就没了。')) return
        setBusy(item.id)
        setMsg('')
        post(BASE + '/slang', { ids: [item.id] })
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setMsg('删掉了「' + item.content + '」。')
              reload()
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || (result.data && result.data.result && result.data.result.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('div', { className: 'qbg-row', style: { justifyContent: 'space-between', marginBottom: '8px' } },
          h('p', { className: 'qbg-title', style: { margin: 0 } }, '黑话词库（' + state.data.total + '）'),
          h('input', { className: 'qbg-input', placeholder: '搜词或释义', value: query, onChange: (event) => setQuery(event.target.value) })
        ),
        shown.length === 0
          ? h('p', { className: 'qbg-note' }, '没有匹配的词条。')
          : h('div', { style: { maxHeight: '260px', overflow: 'auto' } }, shown.slice(0, 60).map((item) =>
              h('div', { className: 'qbg-kv', key: item.id, style: { alignItems: 'flex-start' } },
                h('span', { style: { maxWidth: '58%', textAlign: 'left' } },
                  h('b', { style: { fontWeight: 600 } }, item.content),
                  h('span', { style: { opacity: 0.6, marginLeft: '6px', fontSize: '11px' } }, item.status === 'candidate' ? '待确认' : '')
                ),
                h('span', { style: { flex: '1 1 auto', textAlign: 'left', opacity: 0.75, fontSize: '11px' } }, item.meaning),
                h('button', {
                  className: 'qbg-x',
                  title: '删除',
                  disabled: busy !== '',
                  onClick: () => remove(item)
                }, busy === item.id ? '…' : '×')
              )
            )),
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null,
        h('p', { className: 'qbg-note' }, '删除走桥接自己的接口，落盘即生效，不用重启。')
      )
    }

    function StickerCard() {
      const [state, reload] = useJson(BASE + '/stickers')
      const [picked, setPicked] = React.useState(null)
      const [note, setNote] = React.useState('')
      const [tags, setTags] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      if (state.data === null) {
        return state.error === '' ? null : h('div', { className: 'qbg-card' }, h('p', { className: 'qbg-title' }, '收藏的表情'), h('p', { className: 'qbg-err' }, state.error))
      }
      const items = state.data.items || []
      const withImage = items.filter((item) => typeof item.url === 'string' && item.url !== '')
      const noted = items.filter((item) => String(item.note || '').trim() !== '').length

      const pick = (item) => {
        setPicked(item)
        setNote(item.note || '')
        setTags((item.tags || []).join(','))
        setMsg('')
      }

      const save = () => {
        if (picked === null) return
        setBusy(true)
        setMsg('')
        post(BASE + '/stickers', {
          stickerId: picked.id,
          note: note.trim(),
          tags: tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        })
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setMsg('已保存，她下次醒来就按这个认')
              setPicked(Object.assign({}, picked, { note: note.trim() }))
              reload()
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('div', { className: 'qbg-row', style: { justifyContent: 'space-between', marginBottom: '8px' } },
          h('p', { className: 'qbg-title', style: { margin: 0 } }, '收藏的表情（' + state.data.total + ' · 已备注 ' + noted + '）'),
          h('button', { className: 'qbg-btn', onClick: reload }, '刷新')
        ),
        withImage.length > 0
          ? h('div', { className: 'qbg-stickers' }, withImage.map((item) =>
              h('figure', {
                className: 'qbg-sticker',
                key: item.id,
                title: (item.note || item.desc || item.id) + '\n（点一下写备注）',
                onClick: () => pick(item),
                style: picked !== null && picked.id === item.id ? { outline: '2px solid var(--q-accent, #6ea8fe)' } : null
              },
                h('img', {
                  src: item.url,
                  alt: item.note || item.desc || '表情',
                  loading: 'lazy',
                  referrerPolicy: 'no-referrer',
                  onError: (event) => { event.currentTarget.style.display = 'none' }
                }),
                h('figcaption', null, (item.note || '').trim() === '' ? (item.desc === '' ? '（没备注）' : item.desc) : item.note)
              )
            ))
          : h('p', { className: 'qbg-note' }, items.length === 0 ? '还没有收藏的表情。' : '这些表情没有图片地址，只能看备注。'),
        picked !== null
          ? h('div', { style: { marginTop: '10px', borderTop: '1px solid var(--q-line)', paddingTop: '10px' } },
              h('p', { className: 'qbg-note', style: { margin: '0 0 6px' } },
                '正在改：' + (picked.id || '') + (picked.desc ? '（官方备注：' + picked.desc + '）' : '')),
              h('textarea', {
                value: note,
                onChange: (event) => setNote(event.target.value),
                maxLength: 200,
                rows: 3,
                placeholder: '画面 + 图上的字 + 什么时候用。例：猫举拳砸陨石，配字「毁灭吧」；自暴自弃、发疯时用',
                style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', font: 'inherit', padding: '6px', borderRadius: '8px' }
              }),
              h('input', {
                value: tags,
                onChange: (event) => setTags(event.target.value),
                placeholder: '标签，逗号分隔（发疯,无语,撒娇）',
                style: { width: '100%', boxSizing: 'border-box', marginTop: '6px', font: 'inherit', padding: '6px', borderRadius: '8px' }
              }),
              h('div', { className: 'qbg-row', style: { marginTop: '8px' } },
                h('button', { className: 'qbg-btn qbg-primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
                h('button', { className: 'qbg-btn', onClick: () => { setPicked(null); setMsg('') } }, '关闭')
              ),
              msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null
            )
          : null,
        h('p', { className: 'qbg-note' },
          '点一张图，下面就能写她该在什么时候用它。没备注的她看不懂、就不敢发——写一句，她下次醒来就能用。文字存在本地，不上传。')
      )
    }


    function RowList(props) {
      const items = props.items || []
      if (items.length === 0) return h('p', { className: 'qbg-note' }, '（空）')
      return h('div', null, items.slice(0, 8).map((entry, index) =>
        h('div', { className: 'qbg-kv', key: index },
          h('span', { style: { maxWidth: '42%', textAlign: 'left', opacity: 0.8 } }, entry.left),
          h('span', { style: { flex: '1 1 auto', textAlign: 'left', fontSize: '11px' } }, entry.right)
        )
      ))
    }

    function pickText(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (Array.isArray(value)) return value.map(pickText).filter((item) => item !== '').join('、')
      if (typeof value === 'object') {
        for (const key of ['what', 'text', 'content', 'note', 'summary', 'title']) {
          if (typeof value[key] === 'string' && value[key] !== '') return value[key]
        }
        return JSON.stringify(value).slice(0, 80)
      }
      return ''
    }

    function toRows(value, fallbackLabel) {
      if (Array.isArray(value)) {
        return value.slice(0, 8).map((entry) => ({
          left: typeof entry === 'object' && entry !== null ? String(entry.who ?? entry.name ?? entry.qq ?? fallbackLabel) : fallbackLabel,
          right: pickText(entry).slice(0, 90)
        }))
      }
      if (value !== null && typeof value === 'object') {
        return Object.keys(value).slice(0, 8).map((key) => ({
          left: key,
          right: pickText(value[key]).slice(0, 90)
        }))
      }
      return []
    }

    function PromptCard() {
      const [state, reload] = useJson(BASE + '/prompt')
      const [open, setOpen] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      if (state.data === null) {
        return state.error === '' ? null : h('div', { className: 'qbg-card' }, h('p', { className: 'qbg-title' }, '仿真提示词'), h('p', { className: 'qbg-err' }, state.error))
      }

      const data = state.data
      const act = (body) => {
        setBusy(true)
        setMsg('')
        post(BASE + '/prompt', body)
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setMsg(body.action === 'restore' ? '已恢复 ' + result.data.restored + '。重启桥接后生效。' : '已备份：' + result.data.backup)
              reload()
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(false))
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('div', { className: 'qbg-row', style: { justifyContent: 'space-between', marginBottom: '8px' } },
          h('p', { className: 'qbg-title', style: { margin: 0 } }, '仿真提示词（只看不改）'),
          h('button', { className: 'qbg-btn', disabled: busy, onClick: () => act({ action: 'backup' }) }, '备份当前')
        ),
        h('p', { className: 'qbg-note' }, data.file + ' · ' + data.bytes + ' B'),
        h('pre', {
          style: {
            margin: '6px 0 0',
            maxHeight: open ? '360px' : '90px',
            overflow: 'auto',
            fontSize: '11px',
            lineHeight: '1.6',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            opacity: 0.8
          }
        }, open ? data.content : data.content.slice(0, 600) + '\n…'),
        h('button', { className: 'qbg-btn', style: { marginTop: '6px' }, onClick: () => setOpen(!open) }, open ? '收起' : '展开全部'),
        (data.backups || []).length > 0
          ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: { fontSize: '11px', opacity: 0.7, marginBottom: '4px' } }, '备份（点一下恢复）'),
              (data.backups || []).slice(0, 6).map((item) =>
                h('div', { className: 'qbg-row', key: item.name, style: { marginBottom: '4px' } },
                  h('span', { style: { fontSize: '11px', flex: '1 1 auto' } }, item.name.replace('agent.cordis.yml.bak-', '')),
                  h('button', {
                    className: 'qbg-btn',
                    disabled: busy,
                    onClick: () => {
                      if (window.confirm('用这个备份覆盖当前的仿真提示词？\n' + item.name)) act({ action: 'restore', name: item.name })
                    }
                  }, '恢复')
                ))
            )
          : null,
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null
      )
    }

    function DigestCard() {
      const [state] = useJson(BASE + '/digest')
      const [open, setOpen] = React.useState(false)
      if (state.data === null) return null
      const data = state.data
      if (data.content === '') {
        return h(
          'div',
          { className: 'qbg-card' },
          h('p', { className: 'qbg-title' }, '今天刷到的 B站'),
          h('p', { className: 'qbg-note' }, data.plugin === true ? '今天还没有摘要：刷B站还没跑这一轮。' : '还没装刷B站插件（dsh-bili-scroll）：装了才会有日报。'),
          h('p', { className: 'qbg-note' }, '这份日报是刷B站写的，不是桥接的数据。' + (data.dir ? '（' + data.dir + '）' : ''))
        )
      }
      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '今天刷到的 B站 · ' + data.file),
        h('pre', {
          style: {
            margin: 0,
            maxHeight: open ? '360px' : '110px',
            overflow: 'auto',
            fontSize: '11px',
            lineHeight: '1.6',
            whiteSpace: 'pre-wrap',
            opacity: 0.82
          }
        }, open ? data.content : data.content.slice(0, 500) + '\n…'),
        h('button', { className: 'qbg-btn', style: { marginTop: '6px' }, onClick: () => setOpen(!open) }, open ? '收起' : '展开全部'),
        h('p', { className: 'qbg-note' }, '刷B站插件写的日报，不是桥接的数据。' + (data.dir ? '（' + data.dir + '）' : ''))
      )
    }

    function SocialCard() {
      const [state] = useJson(BASE + '/social')
      if (state.data === null) return null
      const data = state.data
      const events = toRows(data.events, '事件')
      const impressions = toRows(data.impressions, '印象')
      const affinity = toRows(data.affinity, '好感')
      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '她的本子（只读）'),
        h('div', { style: { fontSize: '11px', opacity: 0.7, margin: '6px 0 2px' } }, '事件备忘录'),
        h(RowList, { items: events }),
        h('div', { style: { fontSize: '11px', opacity: 0.7, margin: '10px 0 2px' } }, '对每个人的印象'),
        h(RowList, { items: impressions }),
        h('div', { style: { fontSize: '11px', opacity: 0.7, margin: '10px 0 2px' } }, '好感'),
        h(RowList, { items: affinity }),
        h('p', { className: 'qbg-note' }, '这些是桥接独有的数据，DSH 里没有对应页面。')
      )
    }


    /**
     * 记忆星图。
     *
     * 原来只有一个「打开星图」按钮，而且 window.open 的地址没带令牌 —— 点开是 401，
     * 等于坏的。现在地址由宿主给出（宿主读得到 state/console-token），三种看法：
     *   在页面里看（iframe，点了才挂，收起就卸掉，不白烧显卡）
     *   全屏看（桥接自己拉 Edge 应用窗口）
     *   新窗口（普通标签页）
     */
    function MemoryCard(props) {
      // 切走分页时把 iframe 卸掉，星图不在后台白烧显卡。
      const visible = !props || props.active !== false
      const [state] = useJson(BASE + '/memory')
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const data = state.data
      const url = data && typeof data.url === 'string' ? data.url : ''
      const problem = state.error !== '' ? state.error : (data && data.error) || ''

      const full = () => {
        setBusy('full')
        setMsg('')
        post(BASE + '/action', { action: 'open-memory' })
          .then((result) => {
            const ok = result.ok && result.data && result.data.ok !== false
            setMsg(ok ? '已经在全屏窗口打开了（没出来就看看任务栏）。' : '失败：' + ((result.data && result.data.error) || result.status))
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '记忆星图'),
        state.loading ? h('p', { className: 'qbg-note' }, '读取中…') : null,
        problem !== '' ? h('p', { className: 'qbg-err' }, problem) : null,
        url !== ''
          ? h('div', { className: 'qbg-row' },
              h('button', {
                className: 'qbg-btn qbg-primary',
                onClick: () => { setMsg(''); setOpen(!open) }
              }, open ? '收起' : '在页面里看'),
              h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: full }, busy === 'full' ? '打开中…' : '全屏看'),
              h('button', {
                className: 'qbg-btn',
                onClick: () => {
                  try {
                    window.open(url, '_blank', 'noopener')
                  } catch (error) {
                    setMsg('打不开：' + String(error && error.message ? error.message : error))
                  }
                }
              }, '新窗口'))
          : null,
        open && visible && url !== '' ? h('iframe', {
          className: 'qbg-frame',
          src: url,
          title: '记忆星图',
          referrerPolicy: 'no-referrer'
        }) : null,
        open && url !== '' ? h('p', { className: 'qbg-note' }, '这里地方小，星点会挤；想看全的就点「全屏看」。') : null,
        url !== '' && !open ? h('p', { className: 'qbg-note' }, '星图是桥接自己做的那张：跨会话长期记忆，每个点是一条。') : null,
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null
      )
    }

    // 她的家：3D 房间面板。只做「开独立窗口」一件事 —— 3D 场景塞进这里的小 iframe
    // 会又卡又看不清，而且它的相机/滚轮交互和设置页的滚动会打架。
    function SpaceCard() {
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')

      const openWindow = () => {
        setBusy('open')
        setMsg('')
        post(BASE + '/action', { action: 'open-space' })
          .then((result) => {
            const ok = result.ok && result.data && result.data.ok !== false
            setMsg(ok ? '已经在独立窗口打开了（没出来就看看任务栏，或按 Ctrl+Alt+H）。' : '失败：' + ((result.data && result.data.error) || result.status))
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '她的家'),
        h('p', { className: 'qbg-note' }, '3D 房间：她现在待在哪儿、手边有什么。独立窗口打开，全屏、没有地址栏。'),
        h('div', { className: 'qbg-row' },
          h('button', {
            className: 'qbg-btn qbg-primary',
            disabled: busy !== '',
            onClick: openWindow
          }, busy === 'open' ? '打开中…' : '打开她的家')
        ),
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null
      )
    }

    function RoleCard() {
      const [state, reload] = useJson(BASE + '/roles')
      const [picked, setPicked] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [loading, setLoading] = React.useState(false)

      React.useEffect(() => {
        if (state.data === null) return
        setPicked(state.data.current || '')
      }, [state.data])

      if (state.data === null) {
        if (state.error === '') return null
        return h('div', { className: 'qbg-card' }, h('p', { className: 'qbg-title' }, '人格卡'), h('p', { className: 'qbg-err' }, state.error))
      }
      const roles = state.data.roles || []
      // 空目录别画一个空下拉框和一句「roles/.md」：新用户看到的是残的。
      if (roles.length === 0) {
        return h(
          'div',
          { className: 'qbg-card' },
          h('p', { className: 'qbg-title' }, '人格卡'),
          h('p', { className: 'qbg-note' }, '还没有角色文件：qq-bridge\\roles\\ 是空的。'),
          h('p', { className: 'qbg-note' }, '放一个 <名字>.md 进去，重启桥接后这里就能切换和编辑。安装包里的 qq-bridge\\roles\\ 自带几份。')
        )
      }
      const editing = draft !== null

      const openEditor = (name) => {
        setLoading(true)
        setMsg('')
        fetch(BASE + '/role/edit?name=' + encodeURIComponent(name), { cache: 'no-store' })
          .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => null) }))
          .then((payload) => {
            if (payload.ok && payload.data && payload.data.ok !== false) {
              setDraft({ name: payload.data.name, content: payload.data.content, limit: payload.data.limit })
            } else {
              setMsg('打不开：' + ((payload.data && payload.data.error) || '未知错误'))
            }
          })
          .catch((error) => setMsg('打不开：' + String(error && error.message ? error.message : error)))
          .finally(() => setLoading(false))
      }

      const saveEditor = () => {
        setBusy(true)
        setMsg('')
        post(BASE + '/role/edit', { name: draft.name, content: draft.content })
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setMsg('已保存「' + draft.name + '」：' + result.data.chars + ' 字符 / ' + result.data.bytes + ' B，下一条消息生效。旧版备份在 qq-bridge/backups/。')
              setDraft(null)
              reload()
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(false))
      }

      const chars = draft === null ? 0 : Array.from(draft.content).length
      const over = draft !== null && chars > draft.limit

      return h(
        'div',
        { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '人格卡'),
        editing
          ? h('div', null,
              h('div', { className: 'qbg-row', style: { marginBottom: '6px', justifyContent: 'space-between' } },
                h('b', { style: { fontSize: '12px' } }, draft.name + '.md'),
                h('span', { className: over ? 'qbg-err' : 'qbg-note', style: { fontSize: '11px' } },
                  chars + ' / ' + draft.limit + ' 字符' + (over ? '（超出会被截断）' : ''))
              ),
              h('textarea', {
                value: draft.content,
                spellCheck: false,
                onChange: (event) => setDraft({ ...draft, content: event.target.value }),
                style: {
                  width: '100%',
                  minHeight: '320px',
                  resize: 'vertical',
                  background: 'transparent',
                  color: 'inherit',
                  border: '1px solid var(--dsh-border, #2a2f3a)',
                  borderRadius: '10px',
                  padding: '10px',
                  fontFamily: 'ui-monospace, Consolas, monospace',
                  fontSize: '12px',
                  lineHeight: '1.7'
                }
              }),
              h('div', { className: 'qbg-row', style: { marginTop: '8px' } },
                h('button', { className: 'qbg-btn qbg-primary', disabled: busy, onClick: saveEditor }, busy ? '保存中…' : '保存'),
                h('button', { className: 'qbg-btn', disabled: busy, onClick: () => { setDraft(null); setMsg('') } }, '取消'),
                h('span', { className: 'qbg-note', style: { marginLeft: 'auto' } }, '保存前自动备份')
              )
            )
          : h('div', null,
              h('div', { className: 'qbg-row' },
                h('select', {
                  className: 'qbg-input',
                  value: picked,
                  onChange: (event) => setPicked(event.target.value)
                }, roles.map((item) => h('option', { key: item.name, value: item.name }, item.name + '（' + item.bytes + ' B）'))),
                h('button', {
                  className: 'qbg-btn qbg-primary',
                  disabled: busy || picked === '' || picked === (state.data.current || ''),
                  onClick: () => {
                    setBusy(true)
                    setMsg('')
                    post(BASE + '/role', { role: picked })
                      .then((result) => {
                        if (result.ok && result.data && result.data.ok !== false) {
                          setMsg('已切换到「' + picked + '」，下一条消息生效。')
                        } else {
                          setMsg('失败：' + ((result.data && result.data.error) || result.status))
                        }
                      })
                      .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
                      .finally(() => setBusy(false))
                  }
                }, busy ? '切换中…' : '切换'),
                h('button', { className: 'qbg-btn', disabled: loading || picked === '', onClick: () => openEditor(picked) }, loading ? '读取中…' : '编辑内容')
              ),
              h('p', { className: 'qbg-note' }, '改的是 qq-bridge/roles/<名字>.md，保存即生效，不用重启。')
            ),
        msg !== '' ? h('p', { className: msg.startsWith('失败') || msg.startsWith('打不开') ? 'qbg-err' : 'qbg-note' }, msg) : null
      )
    }

    /**
     * 检查更新 / 一键打补丁。
     *
     * 只更新「设置页插件」自己（lib + 文档），不碰桥接本体和她的数据 ——
     * 那种大更新仍然走安装包。装完要重启 DSH 生效。
     */
    /**
     * 备份：config / 人格卡 / 提示词。
     * 每次保存都会自动留一份（分别在不同地方），这里只负责列出来和还原。
     */
    function BackupsCard() {
      const [state, reload] = useJson(BASE + '/backups')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const data = state.data

      const restore = (kind, name) => {
        if (!window.confirm('用这个备份覆盖当前的吗？\n' + name)) return
        setBusy(kind + ':' + name)
        setMsg('')
        post(BASE + '/backups', { kind, name })
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setMsg('已还原：' + name + (result.data.restartRequired ? '。重启桥接后生效。' : '（下一条消息生效）。'))
              reload()
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      const kb = (size) => (size >= 1024 ? Math.round(size / 1024) + ' KB' : size + ' B')
      const when = (mtime) => {
        try {
          return new Date(mtime).toLocaleString('zh-CN')
        } catch (error) {
          return ''
        }
      }
      const kinds = [
        { key: 'config', label: '配置文件', hint: '在设置里每次保存 config 都会留一份' },
        { key: 'role', label: '人格卡', hint: '每次编辑角色正文都会留一份' },
        { key: 'prompt', label: '仿真提示词', hint: '每次保存提示词都会留一份' }
      ]

      return h(
        'div',
        { className: 'qbg-card' },
        h('div', { className: 'qbg-row', style: { justifyContent: 'space-between', marginBottom: '8px' } },
          h('p', { className: 'qbg-title', style: { margin: 0 } }, '备份'),
          h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: reload }, '刷新')
        ),
        state.error !== '' ? h('p', { className: 'qbg-err' }, state.error) : null,
        data === null
          ? h('p', { className: 'qbg-note' }, '读取中…')
          : kinds.map((kind) => {
              const list = Array.isArray(data[kind.key]) ? data[kind.key] : []
              return h('div', { key: kind.key, style: { marginTop: '8px' } },
                h('div', { style: { fontSize: '11px', fontWeight: 600, marginBottom: '4px' } }, kind.label + '（' + list.length + '）'),
                h('p', { className: 'qbg-note', style: { margin: '0 0 4px' } }, kind.hint),
                list.length === 0
                  ? h('p', { className: 'qbg-note' }, '（还没有备份）')
                  : list.slice(0, 6).map((item) => h('div', { className: 'qbg-backup', key: item.name },
                      h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }, title: item.name }, item.name),
                      h('span', { style: { opacity: 0.6, whiteSpace: 'nowrap' } }, kb(item.size)),
                      h('button', {
                        className: 'qbg-btn',
                        disabled: busy !== '',
                        onClick: () => restore(kind.key, item.name)
                      }, busy === kind.key + ':' + item.name ? '还原中…' : '还原')
                    ))
              )
            }),
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null
      )
    }

    function UpdateCard(props) {
      const [state, setState] = React.useState({ loading: true, data: null, error: '' })
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [repoDraft, setRepoDraft] = React.useState('')
      const [editingRepo, setEditingRepo] = React.useState(false)
      // 在「系统」页才去查更新：省得每次打开设置都去敲 GitHub。
      const active = !props || props.active !== false

      const load = (refresh) => {
        setState((previous) => ({ loading: true, data: previous.data, error: '' }))
        fetch(BASE + '/update' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' })
          .then(async (response) => ({ ok: response.ok, status: response.status, data: await response.json().catch(() => null) }))
          .then((payload) => {
            if (payload.ok && payload.data && payload.data.ok !== false) {
              setState({ loading: false, data: payload.data, error: '' })
            } else {
              setState({ loading: false, data: null, error: (payload.data && payload.data.error) || '读不到 ' + payload.status })
            }
          })
          .catch((error) => setState({ loading: false, data: null, error: String(error && error.message ? error.message : error) }))
      }

      React.useEffect(() => {
        if (active) load(false)
      }, [active])

      if (!active) return null

      const saveRepo = () => {
        if (repoDraft.trim() === '' && repo !== '') {
          if (!window.confirm('清空更新仓库？之后就不再检查更新了。')) return
        }
        setBusy('repo')
        setMsg('')
        post(BASE + '/update', { action: 'set-repo', repo: repoDraft })
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setEditingRepo(false)
              if (result.data.configured === false) {
                setMsg('已清空更新仓库，之后不再检查更新。')
                setState({ loading: false, data: null, error: '' })
                load(false)
              } else {
                setMsg('记住了：' + result.data.repo)
                setState({ loading: false, data: null, error: '' })
                load(true)
              }
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      const install = () => {
        setBusy('apply')
        setMsg('')
        post(BASE + '/update', { action: 'apply' })
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setMsg('装好了：' + result.data.from + ' → ' + result.data.to + '。重启 DSH 生效。旧版本备份在 ' + result.data.backup)
              setState({ loading: false, data: null, error: '' })
              load(true)
            } else {
              setMsg('失败：' + ((result.data && result.data.error) || result.status))
            }
          })
          .catch((error) => setMsg('失败：' + String(error && error.message ? error.message : error)))
          .finally(() => setBusy(''))
      }

      const data = state.data
      const current = (data && data.current) || ''
      const latest = data && typeof data.latest === 'string' ? data.latest : ''
      const behind = Boolean(data && data.behind === true)
      const repo = (data && typeof data.repo === 'string' && data.repo !== '') ? data.repo : ''
      // 没配仓库、或者用户点了「改仓库」，就显示输入框。
      const askRepo = editingRepo || (data !== null && data.configured === false)

      const repoForm = h('div', null,
        h('p', { className: 'qbg-note' }, '检查更新要去 GitHub 上找发布包，先告诉我在哪个仓库：'),
        h('div', { className: 'qbg-row' },
          h('input', {
            className: 'qbg-input',
            style: { flex: '1 1 200px' },
            placeholder: '用户名/仓库名，比如 yourname/qq-bridge',
            value: repoDraft,
            onChange: (event) => setRepoDraft(event.target.value)
          }),
          h('button', { className: 'qbg-btn qbg-primary', disabled: busy !== '', onClick: saveRepo }, busy === 'repo' ? '保存中…' : '保存并检查')
        ),
        h('p', { className: 'qbg-note' }, '填了才会去查；填错也没关系，检查的时候会告诉我找不到。')
      )

      return h(
        'div',
        { className: 'qbg-card' },
        h('div', { className: 'qbg-row', style: { justifyContent: 'space-between', marginBottom: '8px' } },
          h('p', { className: 'qbg-title', style: { margin: 0 } }, '检查更新'),
          h('button', { className: 'qbg-btn', disabled: busy !== '', onClick: () => { setMsg(''); load(true) } }, state.loading ? '检查中…' : '重新检查')
        ),
        state.error !== '' ? h('p', { className: 'qbg-err' }, state.error) : null,
        askRepo
          ? repoForm
          : h('div', null,
              data !== null
                ? h('div', null,
                    h('div', { className: 'qbg-kv' }, h('span', null, '当前版本'), h('span', null, current || '—')),
                    h('div', { className: 'qbg-kv' }, h('span', null, '最新版本'), h('span', null, latest || '—')),
                    repo !== '' ? h('div', { className: 'qbg-kv' }, h('span', null, '仓库'), h('span', { style: { fontSize: '11px' } }, repo)) : null,
                    behind
                      ? h('button', { className: 'qbg-btn qbg-primary', style: { marginTop: '8px' }, disabled: busy !== '', onClick: install }, busy === 'apply' ? '安装中…' : '一键更新到 ' + latest)
                      : latest !== ''
                        ? h('p', { className: 'qbg-note' }, '已经是最新版。')
                        : h('p', { className: 'qbg-note' }, data.checked === true ? '那边还没有发过补丁包。' : '暂时查不到（没网或者被限流了），过一会儿再试。')
                  )
                : null,
              h('button', {
                className: 'qbg-btn',
                style: { marginTop: '8px' },
                onClick: () => { setRepoDraft(repo); setEditingRepo(true); setMsg('') }
              }, repo === '' ? '填仓库' : '改仓库')
            ),
        data !== null && data.notes !== undefined && data.notes !== '' && behind && askRepo === false
          ? h('pre', { style: { margin: '8px 0 0', maxHeight: '120px', overflow: 'auto', fontSize: '11px', lineHeight: '1.6', whiteSpace: 'pre-wrap', opacity: 0.78 } }, data.notes)
          : null,
        msg !== '' ? h('p', { className: msg.startsWith('失败') ? 'qbg-err' : 'qbg-note' }, msg) : null,
        h('p', { className: 'qbg-note' }, '只更新设置页插件；桥接本体和她的数据不动，大更新还是用安装包。')
      )
    }

    /**
     * 扩展区：把别人注册进 CARD_SLOT 的卡片画在最后。
     * 槽位没声明（比如旧版 client 抢先注册了这一页）或者某张卡片当场抛了，
     * 都只让这个位置空着/报一行，绝不让整页跟着崩。
     */
    function ExtCards(props) {
      if (!props || typeof props.renderSlot !== 'function') return null
      let rendered = null
      try {
        rendered = props.renderSlot(CARD_SLOT, { base: BASE, version: PLUGIN_VERSION })
      } catch (error) {
        return h('p', { className: 'qbg-err' }, '扩展卡片渲染失败：' + String(error && error.message ? error.message : error))
      }
      if (rendered === null || rendered === undefined || rendered === false) return null
      return h('div', { className: 'qbg-ext' }, rendered)
    }

    /**
     * 新用户第一屏：桥接程序还没放好时，除了「引导 + 状态」，别的卡片都没有意义
     * （白名单、人格卡、黑话、星图全在桥接目录里，读不到只会是一屏「找不到」）。
     * 所以先收起来，等程序放好、页面下次轮询看到 exists 再自动展开。
     */
    function isFirstRun(data) {
      return Boolean(data && data.exists === false)
    }

    const BRAND = '灵犀'
    const BRAND_EN = 'LINGXI · QQ BRIDGE'
    const TAB_KEY = 'dsh-qq-bridge:tab'
    const TABS = [
      { id: 'home', label: '总览', en: 'OVERVIEW' },
      { id: 'link', label: '连接', en: 'ACCESS' },
      { id: 'soul', label: '灵魂', en: 'PERSONA' },
      { id: 'mind', label: '记忆', en: 'MEMORY' },
      { id: 'read', label: '读书', en: 'READING' },
      { id: 'sys', label: '系统', en: 'SYSTEM' }
    ]

    function readTab() {
      try {
        const saved = window.localStorage.getItem(TAB_KEY)
        if (TABS.some((tab) => tab.id === saved)) return saved
      } catch (error) {
        /* 没有存储就用默认 */
      }
      return 'home'
    }

    /**
     * 同机插件：这一页不假装自己是一切的入口。
     *
     * 只报事实（谁装了、什么版本），不替别人解释自己；读不到就整张卡不出现。
     * 想给这里一个中文名，插件自己的 package.json 顶层写 "dshLabel" 就行。
     */
    function PeersCard() {
      const [state] = useJson(BASE + '/peer')
      const peers = state.data !== null && Array.isArray(state.data.peers) ? state.data.peers : []
      if (peers.length === 0) return null
      return h('div', { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '同机插件'),
        h('div', { className: 'qbg-row' },
          peers.map((peer) => h('span', { key: peer.name, className: 'qbg-chip', title: peer.description || peer.name },
            peer.label,
            peer.version !== '' ? h('small', { style: { opacity: 0.55, marginLeft: '4px' } }, 'v' + peer.version) : null
          ))
        ),
        h('p', { className: 'qbg-note' }, '它们各有自己的设置分区。别家插件也可以往本页插卡片——「系统」标签最下面那块是留给它们的。')
      )
    }

    /** 顶部名片：名字 + 一句话 + 实时状态胶囊。只读 status，不额外请求。 */
    function Hero(props) {
      const data = props.data
      const exists = Boolean(data && data.exists)
      const listening = Boolean(data && data.listening)
      const tone = data === null || data === undefined ? '' : exists && listening ? 'is-ok' : exists ? 'is-bad' : 'is-warn'
      const text = data === null || data === undefined ? '感应中…' : exists && listening ? '她在线' : exists ? '桥接没在跑' : '等待安装'
      return h('div', { className: 'qbg-hero' },
        h('div', { className: 'qbg-mark', 'aria-hidden': true }, h('i'), h('i')),
        h('div', { className: 'qbg-hero-text' },
          h('div', { className: 'qbg-eyebrow' }, BRAND_EN),
          h('h2', { className: 'qbg-name' }, BRAND),
          h('p', { className: 'qbg-tag' }, '心有灵犀 · 把她接进 QQ 的那根线')
        ),
        h('span', { className: 'qbg-pill ' + tone, role: 'status' }, h('span', { className: 'qbg-pill-dot' }), text)
      )
    }

    function Tabs(props) {
      const index = Math.max(0, TABS.findIndex((tab) => tab.id === props.value))
      const onKey = (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
        props.onChange(next.id)
        const target = event.currentTarget.querySelector('[data-tab="' + next.id + '"]')
        if (target) target.focus()
      }
      return h('div', { className: 'qbg-tabs', role: 'tablist', onKeyDown: onKey, style: { '--n': TABS.length, '--i': index } },
        TABS.map((tab) => h('button', {
          key: tab.id,
          type: 'button',
          role: 'tab',
          'data-tab': tab.id,
          'aria-selected': tab.id === props.value,
          tabIndex: tab.id === props.value ? 0 : -1,
          className: 'qbg-tab',
          onClick: () => props.onChange(tab.id)
        }, tab.label, h('small', null, tab.en)))
      )
    }

    function section(on, ...children) {
      return h('div', { className: 'qbg-sec' + (on ? ' is-on' : ''), role: 'tabpanel', 'aria-hidden': !on }, ...children)
    }

    /**
     * 读书：数据由 dsh-reading 插件写在同一批 JSON 里，这里只读、只显示。
     * 找不到那个插件时给一句人话，而不是空白。
     */
    function ReadingCard() {
      const [ov] = useJson('/dsh-reading/overview')
      const [list, setList] = React.useState(null)
      React.useEffect(() => {
        fetch('/dsh-reading/books', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d) => setList(d && d.ok ? d.books : []))
          .catch(() => setList([]))
      }, [])
      const chip = (label, value) =>
        h('span', { key: label, className: 'qbg-chip' }, label, h('small', { style: { opacity: 0.6, marginLeft: '4px' } }, value))
      const chars = (n) => {
        const v = Number(n) || 0
        return v >= 10000 ? (v / 10000).toFixed(1) + ' 万' : String(v)
      }
      if (ov.data === null && ov.error) {
        return h('div', { className: 'qbg-card' },
          h('p', { className: 'qbg-title' }, '读书'),
          h('p', { className: 'qbg-note' }, '没找到「读书」插件：装好 dsh-reading 之后，这里会自动出现书架和阅读记录。'))
      }
      const d = ov.data || {}
      const books = (list || []).filter((b) => b.updatedAt > 0 || b.notes > 0)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      const notes = Array.isArray(d.recentNotes) ? d.recentNotes : []
      return h('div', { className: 'qbg-card' },
        h('p', { className: 'qbg-title' }, '读书', h('small', { style: { opacity: 0.5, marginLeft: '6px' } }, 'READING')),
        h('div', { className: 'qbg-row' },
          chip('今天', chars(d.todayChars) + ' 字'),
          chip('连续', (d.streak || 0) + ' 天'),
          chip('在读', (d.reading || 0) + ' 本'),
          chip('笔记', (d.notes || 0) + ' 条')),
        books.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' } },
              books.slice(0, 4).map((b, i) => h('div', { key: b.id, style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
                h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  (i === 0 ? '📖 手上 · ' : '') + b.title),
                h('span', { style: { opacity: 0.6, fontSize: '12px', flex: '0 0 auto' } },
                  '第 ' + (b.chapter + 1) + '/' + b.chapters + ' 章 · ' + b.progress + '%'))))
          : h('p', { className: 'qbg-note' }, '还没开始读。到「设置 → 读书」挑一本，或者把书丢进 ~/.dsh/reading/books/。'),
        notes.length
          ? h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('p', { style: { margin: 0, opacity: 0.55, fontSize: '12px' } }, '最近的笔记'),
              notes.slice(0, 3).map((n) => h('div', { key: n.id, style: { fontSize: '12px', opacity: 0.85 } },
                '「' + String(n.quote || n.note || '').slice(0, 40) + '」',
                h('span', { style: { opacity: 0.55, marginLeft: '6px' } }, n.bookTitle || ''))))
          : null
      )
    }

    function QQBridgePage(props) {
      ensureStyle()
      const [tab, setTabState] = React.useState(readTab)
      const setTab = (id) => {
        setTabState(id)
        try { window.localStorage.setItem(TAB_KEY, id) } catch (error) { /* 忽略 */ }
      }
      const [state, reload] = useJson(BASE + '/status')
      React.useEffect(() => {
        const timer = setInterval(reload, STATUS_MS)
        const recheck = () => reload()
        const hasEvents = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        if (hasEvents) window.addEventListener('qbg-recheck', recheck)
        return () => {
          clearInterval(timer)
          if (hasEvents) window.removeEventListener('qbg-recheck', recheck)
        }
      }, [reload])
      const ext = h(ExtCards, props === undefined ? {} : props)
      const hero = h(Hero, { data: state.data })
      if (isFirstRun(state.data)) {
        return h('div', { className: 'qbg-page' },
          hero,
          h('div', { className: 'qbg-sec is-on' },
            h(GuideCard),
            h(StatusCard),
            h('p', { className: 'qbg-note' }, '桥接程序还没装好：上面几步做完，这一页会自动展开白名单、人格卡、黑话、表情、星图等面板，不用刷新。'),
            h(UpdateCard),
            ext))
      }
      // 各分页一直挂着（只是隐藏），切换时不重新请求、填了一半的输入框也不丢。
      return h('div', { className: 'qbg-page' },
        hero,
        h(Tabs, { value: tab, onChange: setTab }),
        section(tab === 'home', h(GuideCard), h(StatusCard, { status: state }), h(SpaceCard), h(Actions, { status: state }), h(PeersCard)),
        section(tab === 'link', h(AccessCard), h(ModeAndFlagsCard)),
        section(tab === 'soul', h(RoleCard), h(SlangCard), h(StickerCard), h(PromptCard)),
        section(tab === 'mind', h(MemoryCard, { active: tab === 'mind' }), h(SocialCard), h(DigestCard)),
        section(tab === 'read', h(ReadingCard)),
        section(tab === 'sys', h(UpdateCard, { active: tab === 'sys' }), h(BackupsCard), h(LogsCard), ext))
    }

    // 输入框工具栏里的「她的家」快钮：点一下开独立 3D 面板，不占对话。
    // 用内联样式而不是设置页的 qbg-btn，原因是 composer 的样式作用域和设置页不同，
    // 借用那边的类名在这里会掉样式。
    function SpaceQuickButton() {
      const [busy, setBusy] = React.useState(false)
      const open = () => {
        if (busy) return
        setBusy(true)
        post(BASE + '/action', { action: 'open-space' })
          .catch(() => {})
          .finally(() => setBusy(false))
      }
      return h('button', {
        type: 'button',
        title: '打开她的家（3D 面板）',
        'aria-label': '打开她的家',
        onClick: open,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '26px', height: '26px', padding: 0, margin: '0 2px',
          borderRadius: '7px', border: '1px solid rgba(140,170,220,.28)',
          background: 'transparent', color: '#9db4d6', cursor: busy ? 'default' : 'pointer',
          fontSize: '13px', lineHeight: 1, opacity: busy ? 0.5 : 1,
          transition: 'background .15s, border-color .15s'
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(120,160,220,.14)'; e.currentTarget.style.borderColor = 'rgba(140,180,255,.5)' },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(140,170,220,.28)' }
      }, '⌂')
    }

    function apply(ctx) {
      // 先挂输入栏快钮（下面的设置页注册会 return，必须放在它前面）。
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          const disposeQuick = ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
            { name: 'conversation.input.left', id: 'qq-space-quick', order: 40, label: () => '她的家' },
            SpaceQuickButton
          ))
          if (typeof disposeQuick === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => disposeQuick, 'qq-bridge: 输入栏「她的家」快钮')
          }
        }
      } catch (error) {
        console.warn('[dsh-qq-bridge] 输入栏快钮没挂上（旧版 DSH？）', error)
      }

      // 正常路径带子槽位注册（别的插件才能往页面里加卡片）；
      // 万一这版 DSH 不认 children，就退回不带槽位的注册 —— 页面本身绝不能丢。
      const plain = { name: 'settings.section', id: 'qq-bridge', order: 27, label: () => BRAND + ' · QQ 桥接' }
      const withSlot = Object.assign({}, plain, { children: Object.assign({}, CHILD_SLOTS) })
      for (const option of [withSlot, plain]) {
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register(option, QQBridgePage))
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
              ctx.effect(() => dispose, 'qq-bridge: settings section')
            }
            return
          }
          ctx.slots.register(option, QQBridgePage)
          return
        } catch (error) {
          console.warn('[dsh-qq-bridge] 设置页没挂上（' + (option.children ? '带扩展槽' : '不带扩展槽') + '）', error)
        }
      }
      console.warn('[dsh-qq-bridge] 设置槽位不可用，跳过设置页')
    }

    exports.name = 'qq-bridge'
    exports.inject = ['slots']
    exports.apply = apply
    exports.__page = QQBridgePage
    exports.__slot = CARD_SLOT
    exports.__firstRun = isFirstRun
    return module.exports
  }
})
