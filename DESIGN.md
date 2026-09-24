# DSH 模型代理插件（dsh-model-proxy）设计方案

> **实现状态（2025-08）**：§6.1–6.3 的 M0 路径已全部落地，离线测试 32 例覆盖（`pnpm test`）。
> 相对本文的演进：① undici `ProxyAgent` 对 http/https 目标统一走 CONNECT 隧道（实测）；② 因
> cordis-plugin-hmr 不等旧 fiber dispose 即重放，fetch 包装采用"链式包装 + 仅外层恢复"策略；
③ settings schema 中 rule.id 为可选（该 schemastery fork 的 `.default(fn)` 会抛异常）。
> **P3 已实现**：model 前缀通配 `"muse-*"`、可选 `purpose` 过滤（compaction/session-title 分流）、
> `credentialRef`（软依赖 `ctx.get('credentials')`，后台异步刷新 + 决策路径同步读缓存，
> dispatcher 缓存键使用组合后 URL）、配置变更时对新代理自动探测连通性。
> **§6.4 forwardMode 已正式否决**（见 §6.4）。迁移触发器：当 DSH 落地 `TODO(http)` Cordis
> HTTP service（llm-deepseek/src/adapter.ts:602）时应迁移至官方 transport seam。

> 目标：让 **某个 provider 的某个模型** 可以按需走某个代理（SOCKS5 / HTTP / HTTPS），无需手动起本地转发脚本并改 baseURL。
>
> 背景：部分上游模型必须经代理访问，而常见的过渡做法是在本地起一个 OpenAI 兼容转发脚本、再把 `provider.baseURL` 指向它——全局生效且污染端点配置。本文设计一个**一等 DSH 插件**替代之（旧过渡脚本已移出仓库，见 git 历史）。

---

## 1. 背景与现状

### 1.1 为什么需要“模型级代理”

* 某些模型（如 `muse-spark-1.2-contributor`）对部分地区直连 IP 返回 `403 RegionError`，必须走代理才能用。
* 同一 provider 下不同模型、甚至同一模型的不同用途（对话 vs. compaction vs. title 生成）可能有不同网络可达性。
* 更常见诉求：**公司内网模型走直连 / 海外模型走 SOCKS5 / 自建网关走 HTTPS 代理**，按模型粒度可控。

### 1.2 现有解法的痛点

| 维度 | 旧本地转发脚本（已移出仓库，见 git 历史） |
|---|---|
| 启动 | 手动起后台进程；忘记启动即 502 |
| 配置 | 需手动把 DSH provider.baseURL 改为本地转发地址，污染真实上游配置 |
| 粒度 | 全局：只要切到该 provider 全部模型都走代理，无法做到“仅 muse-spark 走代理，其他直连” |
| 协议 | 仅 `CONNECT 127.0.0.1:1080` 一种，零依赖但不支持 `socks5://`、带认证的 `https://`、PAC 等 |
| 生命周期 | 独立进程，日志/端口/崩溃自愈都需自己管；多 DSH 窗口/容器共享困难 |
| 可观测 | 无事件、无指标，失败只在 `502 + upstream error` |

### 1.3 为什么不能直接用环境变量

* DSH **host 进程** 往往拿不到 `HTTPS_PROXY / ALL_PROXY`（GUI 启动、沙箱启动、systemd 环境隔离）。
* `undici` / `pi-ai` 对 `socks5://` 支持不完整或根本不识别。
* 环境变量是**进程级全局**，无法表达“provider A model X 走代理，model Y 不走”。

---

## 2. 需求提炼

### 2.1 功能性需求

| ID | 需求 | 优先级 |
|---|---|---|
| F1 | **按规则代理**：`(provider, model)` → `proxyUrl`；支持通配 `model="*"`、按顺序最精确匹配 | P0 |
| F2 | **多协议**：`http://` / `https://`（CONNECT）、`socks5://` / `socks5h://`；带用户名密码的 URL | P0 |
| F3 | **零 baseURL 篡改**：上游 baseURL 保持真实值，代理在传输层解决，不改 DSH 配置中的 endpoint | P0 |
| F4 | **零手动守护进程**：随 DSH 插件生命周期自动起停，不额外占端口（除非配置本地转发模式） | P0 |
| F5 | **即时生效**：改规则无需重启 DSH，下一条 `llm/stream` 即生效；进行中的流不受影响 | P0 |
| F6 | **范围控制**：支持同时配置多条规则，多 provider/多模型独立 | P0 |
| F7 | **显式禁用**：`proxyUrl=""` / `enabled:false` 表示直连，用于在全局代理下对某模型豁免 | P1 |
| F8 | **可观测**：日志与 `providerRetryAfter` / `requestId` 透传；可选 debug 日志哪条请求走了哪个代理 | P1 |
| F9 | **GUI/文件配置**：settings 页面可视化编辑；volatile Config 字段即 profile patch 中该 entry 的 `config`，手写同样生效且热更新 | P1 |
| F10 | **测试旁路**：提供 `probe` 能力（类似“检测连接”）不发真实模型请求即可校验代理可达 | P2 |

### 2.2 非功能性需求

* **零侵入**：不 fork `dsh-llm` / `dsh-llm-pi-ai` / `dsh-llm-deepseek`，可与官方包共存。
* **可组合**：与 `dsh-llm-retry`、`agent-loop`、compaction、subagent、重放（replay）正交。
* **安全**：代理认证信息不落明文日志；`credentialRef` 复用现有 credentials seam（可选）。
* **可移植**：纯 Node，无 native 编译；`socks` 依赖为可选 peer。
* **性能**：无代理的请求零额外开销（fast-path 直接走原 `fetch`）；有代理的请求仅多一次 CONNECT/握手。

### 2.3 非目标

* 不做全局系统代理管理器（不改 OS 代理、不写 PAC）。
* 不做请求内容改写（不改 headers/body，仅传输层代理）。
* 首版不做“按工具/按 session”代理（可扩展点预留）。

---

## 3. 约束与可复用机制（DSH 侧）

| 机制 | 说明 | 本插件如何复用 |
|---|---|---|
| **Cordis 插件模型** | 每个能力都是可装卸的 Service；`ctx.effect / ctx.on` 保证逆序卸载 | 插件 `apply(ctx)` 中注册所有能力，卸载时自动清理 fetch 包装 |
| **`ctx.llm` + `llm/stream` waterfall** | 发起模型请求前唯一可编程拦截点；`next()` 继续下层，适配器最终执行 `adapter.stream()` | **主拦截点**：在 waterfall 中识别 `options.provider/model`，决定本次调用的 proxy，并把决策注入 AsyncLocalStorage 供 fetch 层读取 |
| **`ctx.settings` / `zod` schema** | 声明式 settings namespace + 校验，写入时即拒绝不可服务配置 | 定义 `model-proxy` namespace，`resolveProfiles()` 式校验规则，写入失败直接回 `settings-rejected` 并在 UI 标红 |
| **`ctx.credentials`** | 凭据引用（`credentialRef`），与 settings 解耦，支持 `apiKeyEnv` 风格 | 代理若需认证，可支持 `proxyUrl` 内联 `user:pass` 或 `proxyCredentialRef` 另存，避免 URL 明文密码进 settings |
| **`undici` + Node `fetch`** | `DeepSeekAdapter` 直接 `fetch(url, {signal})`；`PiAiAdapter` 经 `pi-ai` 内部 `fetch` | **统一传输拦截**：包装 `globalThis.fetch`，检测是否处于 `llm/stream` 上下文，命中规则则按决策注入 `dispatcher`（代理路径改走 `undici.fetch`，因 Node 原生 fetch 不认自定义 dispatcher） |
| **`AsyncLocalStorage`** | Node 异步上下文透传 | 解决 waterfall 决策 → fetch 执行跨栈传递，不靠全局变量，不污染并发请求 |
| **`attributionHeaders()`** | 每次模型请求必带归因头 | 包装层透传，不剥离、不伪造 |

> 关键洞察：两个适配器最终都走 `fetch`，因此**在 fetch 层注入 dispatcher 是唯一能同时覆盖 `deepseek` 与 `pi-ai` 的单点**。若只在某个 adapter 上做包装，另一条路径会漏。

---

## 4. 总体架构

### 4.1 逻辑视图

```mermaid
flowchart LR
  subgraph Settings["Settings (model-proxy)"]
    Rules["proxyRules[]\n{provider, model, proxyUrl, enabled}"]
    Defaults["defaultProxy?"]
  end

  subgraph LLM["LLM 调用链"]
    AgentLoop["agent-loop\nprepareCall()"]
    Waterfall["llm/stream\nwaterfall listener"]
    AdapterDeepseek["DeepSeekAdapter\nfetch()"]
    AdapterPiAi["PiAiAdapter\npi-ai Models.streamSimple()\n→ fetch()"]
  end

  subgraph Transport["传输层"]
    FetchWrap["fetch 包装层\n(AsyncLocalStorage)"]
    DispatcherHTTP["ProxyAgent\n(http/https)"]
    DispatcherSOCKS["undici Agent + socks connect\n(socks5/h)"]
    Direct["直连"]
  end

  Rules --> Waterfall
  Defaults --> Waterfall
  AgentLoop --> Waterfall --> AdapterDeepseek & AdapterPiAi
  AdapterDeepseek & AdapterPiAi --> FetchWrap
  FetchWrap -->|匹配规则| DispatcherHTTP & DispatcherSOCKS
  FetchWrap -->|无匹配| Direct
```

### 4.2 数据流（一次对话请求）

```
用户 prompt
  → agent-loop 组装 GenerateOptions{provider="opencode", model="muse-spark-1.2-contributor", ...}
  → ctx.waterfall('llm/stream', options, next)
      ① 插件 listener：resolveProxy(options) → {proxyUrl:"socks5://127.0.0.1:1080", ruleId}
         存入 ALS: {proxyUrl, provider, model}
         调用 next() 进入适配器
  → DeepSeekAdapter / PiAiAdapter 内部 fetch("https://upstream.example.com/v1/chat/completions", {signal, headers, body})
  → 被包装的 global fetch 拦截：
      ② 从 ALS 取出 proxyUrl
      ③ 按 scheme 创建/复用 Dispatcher
         - http/https → undici.ProxyAgent
         - socks5/h  → undici Agent + 自定义 connect（socks 隧道，https 自包 TLS）
      ④ 命中代理时改走 undici.fetch(url, {...init, dispatcher})（Node 原生全局
         fetch 不认自定义 dispatcher，必须用 undici 的 fetch）；直连仍走原 fetch
  → 上游返回 SSE → translate → StreamChunk → assistant/chunk
```

> 进行中的流已捕获的 dispatcher 不变；改规则仅影响下一次 `llm/stream` 的决策。

---

## 5. 方案对比与决策

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. llm/stream + fetch 包装（推荐）** | waterfall 做路由决策，ALS 透传，fetch 包装层注入 dispatcher | 单点覆盖双适配器；保持 baseURL 真实；按模型精确；无需端口 | 需包装 global fetch（可逆）；socks 需额外依赖 | **采纳为 P0** |
| B. 适配器装饰器 | `registerAdapter` 替换为 proxy-aware adapter | 逻辑集中，不碰全局 fetch | 只能覆盖注册时已知 provider；pi-ai 的 Models 集合多态难装饰 | 作为 A 的补充可选 |
| C. 托管本地转发（现脚本的插件化） | 插件内起 `http.createServer`，动态重写 provider.baseURL | 完全兼容现脚本；协议支持靠内部 CONNECT 复用 | 需占端口、改 baseURL、额外一跳延迟；粒度仍需“虚拟 provider” | **否决**（见 §6.4） |
| D. 环境变量 + undici EnvHttpProxyAgent | 设 `HTTP_PROXY` 并用 `setGlobalDispatcher(new EnvHttpProxyAgent())` | 零代码 | 进程级全局，无法按模型区分；socks5 不支持 | 不采纳 |

**决策**：**A 为主路径**。C（forwardMode）曾作为可选兼容开关保留，后经 §6.4 的分析正式否决并从配置形状中移除；B/D 不单独推进。

---

## 6. 详细设计

### 6.1 Settings Schema

命名空间：`model-proxy`（与 `llm-pi-ai` / `deepseek` 平级，避免耦合）。

```ts
// packages/model-proxy/src/config.ts
export interface ProxyRule {
  /** Provider 路由，如 "opencode"、"deepseek-official"、"acme-gateway" */
  provider: string
  /** 模型 id：精确值 | 前缀通配 "muse-*" | 全通配 "*" */
  model: string              // "*" | "muse-*" | "muse-spark-1.2-contributor"
  /** 代理 URL，空字符串表示直连（豁免） */
  proxyUrl: string           // "socks5://127.0.0.1:1080" | "http://127.0.0.1:7890" | ""
  /** 是否启用；false 等同直连但保留 URL 供一键再启用 */
  enabled?: boolean          // default true
  /** UI 卡片键；手写 yaml 规则可省略，客户端负责补齐 */
  id?: string
  /** 可选用途过滤：设置后仅匹配 GenerateOptions.purpose 相同的调用 */
  purpose?: string
  /** credentials 服务条目名（user:password），设置后覆盖 proxyUrl 内联 userinfo */
  credentialRef?: string
}

export interface ModelProxyConfig {
  /** 按序匹配；首个命中即用；建议 UI 按 provider 分组展示 */
  rules: ProxyRule[]
  /** 可选默认兜底代理；无匹配时使用 */
  defaultProxy?: string      // "" 为直连
  /** 调试：为每次请求打印 [model-proxy] provider/model → proxy */
  debug?: boolean
}
```

校验（`assertServiceable`）：

* `provider` 非空；`model` 非空；`proxyUrl` 为空或可被 `new URL()` 解析且 scheme ∈ {`http:`,`https:`,`socks5:`,`socks5h:`}；`socks5h` 表示远端 DNS。
* 重复 `provider+model` 拒绝并指明行号。
* `socks5://` 需可选依赖可用，否则校验阶段给 warning（不硬拒绝，运行时再 `LlmError` 提示安装 `socks`）。

存储示例（`~/.dsh/profiles/<name>/cordis.patch.yml` 中该 entry 的 `config`，volatile 字段改动热提交、无需重启）：

```yaml
- id: model-proxy
  config:
    rules:
      - provider: opencode
        model: muse-spark-1.2-contributor
        proxyUrl: socks5://127.0.0.1:1080
      - provider: opencode
        model: "*"
        proxyUrl: ""           # 该 provider 其余模型直连
      - provider: acme-gateway
        model: "*"
        proxyUrl: http://127.0.0.1:7890
    debug: false
```

settings UI 的编辑也写回同一行，两种途径共享一份持久化。

### 6.2 路由匹配

```ts
function resolveProxy(
  rules: readonly ProxyRule[],
  defaultProxy: string | undefined,
  provider: string,
  model: string,
): string | undefined {
  for (const r of rules) {
    if (!r.enabled === false && r.provider === provider
        && (r.model === model || r.model === "*")) {
      return r.proxyUrl || undefined  // "" → 直连
    }
  }
  return defaultProxy || undefined
}
```

* 精确 `model` 优于 `"*"`：要求 UI/校验建议把精确规则排在通配前，或匹配时先找精确再找通配（实现可做两轮扫描避免顺序陷阱）。
* 前缀通配 `"muse-*"` 与全通配 `"*"` 已随 P3 落地（见顶部状态横幅）。

### 6.3 传输拦截层

#### 6.3.1 AsyncLocalStorage 透传

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
type ProxyCtx = { proxyUrl?: string; provider: string; model: string }
const als = new AsyncLocalStorage<ProxyCtx>()

// waterfall listener
ctx.on('llm/stream', async (options: GenerateOptions, next) => {
  const proxyUrl = resolveProxy(currentRules, defaultProxy, options.provider, options.model)
  return als.run({ proxyUrl, provider: options.provider, model: options.model },
    () => next())
})
```

* `als.run` 包裹 `next()`，保证适配器内所有 `await fetch` 都在同一上下文。
* 并发安全：不同请求的上下文不串扰。

#### 6.3.2 fetch 包装

```ts
import { fetch as undiciFetch } from 'undici'

const originalFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => {
  const store = als.getStore()
  if (!store?.proxyUrl) return originalFetch(input as any, init as any)

  // 仅拦截模型上游请求：可通过 URL 白名单或“处于 ALS 上下文即拦截”两种策略
  // 策略1最稳：只要在 llm/stream 上下文里，就走代理（避免误代理其他 fetch）
  const dispatcher = getOrCreateDispatcher(store.proxyUrl)
  // 注意：Node 原生全局 fetch 不认自定义 dispatcher（连 undici.ProxyAgent 都拒，
  // 报 "invalid onError method"），因此命中代理时必须改走 undici 自身的 fetch，
  // 它才完整支持 `dispatcher`（含下方 socks Agent）。直连仍走 originalFetch，行为不变。
  return undiciFetch(input as any, { ...init, dispatcher } as any)
}
```

* **卸载**：`ctx.effect` 返回 disposer 时恢复 `globalThis.fetch = originalFetch`。
* **双适配器覆盖**：`DeepSeekAdapter` 与 `PiAiAdapter`（经 `pi-ai`）最终都走此 `fetch`。
* **非模型 fetch 不受影响**：不在 ALS 上下文中的 `fetch`（如下载、telemetry）直接走原路径。
* **为什么代理路径用 `undiciFetch` 而非 `originalFetch`**：Node（≥20 内置 fetch、含 26 原生 fetch）对 `init.dispatcher` 的支持不可靠——即使传的是合法的 undici `ProxyAgent` 也会抛 `invalid onError method`；而 `original` 若是 Node 内置 fetch 则直接忽略该选项。落地验证中 `undici.fetch` 是唯一能稳定承载自定义 dispatcher 的 fetch 实现。

#### 6.3.3 Dispatcher 工厂

```ts
import { ProxyAgent, Agent } from 'undici'   // 仅 undici
import { createRequire } from 'node:module'
import tls from 'node:tls'

// 可选依赖：pnpm add socks（socks5 / socks5h 需要）
const require = createRequire(import.meta.url)
const { SocksClient } = require('socks')

const cache = new Map<string, unknown>() // proxyUrl → dispatcher

function buildSocksDispatcher(proxyUrl: string) {
  const proxyHost = new URL(proxyUrl).hostname
  const proxyPort = Number(new URL(proxyUrl).port)
  // undici 的 connect 回调需返回“最终 socket”（https 需自包 TLS，undici 不会代做）
  const connect = (opts, cb) => {
    const host = opts.hostname ?? opts.host
    const port = opts.port ? Number(opts.port) : (opts.protocol === 'http:' ? 80 : 443)
    SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: 5 },
      command: 'connect',
      destination: { host, port },
    }).then(({ socket }) => {
      if (opts.protocol === 'https:' || port === 443) {
        const secure = tls.connect({ socket, servername: opts.servername ?? host, host, port })
        secure.once('secureConnect', () => cb(null, secure))
        secure.once('error', cb)
      } else {
        cb(null, socket)
      }
    }).catch(cb)
  }
  return new Agent({ connect })
}

function getOrCreateDispatcher(proxyUrl: string) {
  if (cache.has(proxyUrl)) return cache.get(proxyUrl)
  const u = new URL(proxyUrl)
  let d: unknown
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    d = new ProxyAgent(proxyUrl)        // undici 原生支持
  } else if (u.protocol === 'socks5:' || u.protocol === 'socks5h:' || u.protocol === 'socks:') {
    d = buildSocksDispatcher(proxyUrl)  // 见上
  } else {
    throw new LlmError(`unsupported proxy protocol: ${u.protocol}`, 'INVALID_PROXY')
  }
  cache.set(proxyUrl, d)
  return d
}
```

* **为什么不能直接用 `SocksProxyAgent`**：`socks-proxy-agent` 导出的是 Node 的 `http.Agent`，而 undici `fetch` 的 `dispatcher` 选项要求 undici `Dispatcher` 接口。把 `SocksProxyAgent` 传进去会报 `agent.dispatch is not a function` → 表现为 `Connection error`。因此 socks 用 undici `Agent` + 自定义 `connect` 自建：`connect` 经 socks 隧道连到目标，https 目标再把 raw socket 用 `tls.connect` 包一层后交回。
* **连接池与复用**：`ProxyAgent` / `Agent` 自带连接池，按 `proxyUrl` 缓存即可；池参数相对 undici 默认调高（`PROXY_POOL_DEFAULTS`：`keepAliveTimeout 30s`、`connections 20`/`origin`），`pipelining` 保持默认 1（SSE 不 pipeline）。
* **认证**：URL 中的 `user:pass` 自动生效；也支持后续扩展 `proxyCredentialRef` 另存，运行时拼到 URL。
* **`socks5` vs `socks5h`**：两者在同一实现下都将目标 hostname 交给代理解析（等效 `socks5h` 语义，规避本地 DNS 污染）；插件透传即可。

> 若用户环境无 `socks` 依赖且配了 `socks5://`，运行时抛 `LlmError("socks proxy requires 'socks'")` 并在 UI 提示安装。

#### 6.3.4 为什么不用 `setGlobalDispatcher`

`setGlobalDispatcher(new ProxyAgent(...))` 是**全局**的，会把**所有** fetch 都走代理，且无法按模型区分。本设计用**每请求 dispatcher**，仅对命中规则的请求注入。

### 6.4 已否决：本机转发模式（原"兼容转发模式"）

> **否决（2025-08）**。原方案为兼容 `model_proxy.mjs` 而在插件内起 `http.createServer`
> 并内存重写 provider.baseURL，现不再规划，理由：
>
> 1. CONNECT 隧道 dispatcher 模式已完整覆盖旧脚本场景（本地 CONNECT 转发 + 真实上游），
>    且无需端口、无需改 baseURL——实测验证过完整链路。
> 2. forwardMode 引入三条额外维护面/攻击面：监听端口的生命周期管理、baseURL 的
>    运行时视图与落盘视图不一致、按 Host 还原真实上游的映射逻辑。
> 3. "不想改配置的老用户"的真实成本只是删掉一条 baseURL 覆盖，一次性动作。
>
> 历史方案存档见 git 历史（本文档 b867533 之前的版本）。

### 6.5 配置变更与热重载

* 监听 `settings` 的 `model-proxy` 段变更（`ctx.settings.on('change')` 或轮询 `resolveProfiles`），更新内存中的 `rules`。
* 进行中的流已捕获 `als` 内的 `proxyUrl`，不受影响；下一条流读取新规则。
* 失效的 dispatcher（proxyUrl 被删除）延迟淘汰：简单 `cache.delete(oldUrl)` 即可，存量连接自然超时。

### 6.6 可观测性与排障

* `debug:true` 时，每次 `llm/stream` 打印：`[model-proxy] opencode/muse-spark-1.2-contributor → socks5://127.0.0.1:1080 (rule #0)`；直连则打印 `→ direct`。
* 失败时保留原始 `LlmError` 的 `cause` 链（`errorChain`），并附加 `proxyUrl` 到 message：`"request via socks5://127.0.0.1:1080 failed: CONNECT ..."`。
* 可选 `probe` 命令：`POST /api/model-proxy/probe {provider, model, proxyUrl}` 在 host 侧用 `fetch("https://1.1.1.1/cdn-cgi/trace", {dispatcher})` 测连通，不消耗模型额度。

### 6.7 安全

* `proxyUrl` 中的密码在日志中脱敏：`socks5://user:***@host:port`。
* 若引入 `proxyCredentialRef`，密码走 `ctx.credentials`，settings 中仅存引用名，与 `apiKeyEnv` 同模型。
* 插件不读取/不转发模型 `Authorization` 以外的敏感头；代理只需 CONNECT，不做 MITM。

---

## 7. 插件形态与目录结构

建议作为**独立 npm 包**，可在本仓 `dsh-model-proxy` 目录先以本地包开发，再发布为 `@deepseek-ai/dsh-model-proxy` 或社区包 `dsh-plugin-model-proxy`。

```
dsh-model-proxy/
├── package.json              # name, dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml          # bundle 层：insert 一条 host loader 行（name: 字段）
├── src/
│   ├── host/
│   │   ├── index.ts          # apply(ctx): 注册 settings schema + llm/stream 拦截 + fetch 包装
│   │   ├── config.ts         # schema / assertServiceable / resolveProxy
│   │   ├── dispatcher.ts     # getOrCreateDispatcher + 缓存 + 协议分发
│   │   ├── fetch-wrap.ts     # global fetch 包装与恢复
│   │   ├── credentials.ts    # credentialRef 组合与 credentials 服务软依赖
│   │   └── probe.ts          # 新代理连通性自动探测
│   └── client/
│       ├── index.ts          # settings 卡片注册（可选首版可无）
│       ├── catalog.ts        # provider/model 目录 store：llm.providers/llm.models + 事件刷新
│       └── ModelProxyCard.tsx # 规则卡片：批量勾选建规则 + 按 provider 分组管理 + 下拉（Custom 兜底）
└── DESIGN.md                 # 本文
```

`cordis.patch.yml`（bundle 清单）示例——只声明 Host 半；client 半由 `dsh.client`
自动发现，加载行说明符字段是 `name:`：

```yaml
- insert:
    - id: model-proxy
      name: dsh-plugin-model-proxy
      config: {}
```

或直接复用宿主包的 `package.json#dsh.bundle`。

### 7.1 Host 插件伪代码

```ts
export function apply(ctx: Context, config: unknown) {
  const rules = ref<ModelProxyConfig>({ rules: [] })

  // 1. 注册 settings 命名空间
  ctx.effect(() => {
    const handle = ctx.settings.register('model-proxy', ModelProxySchema, {
      assertServiceable,
      defaultValue: { rules: [] },
    })
    const dispose = ctx.settings.watch('model-proxy', (next) => { rules.value = next })
    return () => { dispose(); handle.dispose() }
  })

  // 2. fetch 包装（可逆）
  const als = new AsyncLocalStorage<ProxyCtx>()
  ctx.effect(() => {
    const orig = globalThis.fetch
    globalThis.fetch = wrapFetch(orig, als, () => rules.value)
    return () => { globalThis.fetch = orig }
  })

  // 3. llm/stream 路由决策
  ctx.on('llm/stream', async (opts, next) => {
    const proxyUrl = resolveProxy(rules.value.rules, rules.value.defaultProxy, opts.provider, opts.model)
    if (rules.value.debug) ctx.logger.info(`[model-proxy] ${opts.provider}/${opts.model} → ${proxyUrl ?? 'direct'}`)
    return als.run({ proxyUrl, provider: opts.provider, model: opts.model }, () => next())
  })

  // 4. 可选 probe 能力：注册为 ctx.commands 或 host API
  ctx.effect(() => ctx.commands.register('model-proxy:probe', probeHandler))
}
```

### 7.2 Client 插件（可选首版）

* 在 `ui-settings-models` 旁新增一个 `ui-settings` 的 section，或在现有 provider 卡片上加一个“代理”下拉。
* 简化首版：**仅 host 插件 + 手写 settings**，二期再补 GUI。

---

## 8. 与现有脚本的迁移

| 场景 | 操作 |
|---|---|
| 已用旧本地转发脚本 | ① 安装本插件 ② 在 `model-proxy.rules` 中配原先的 `opencode/muse-spark → socks5://127.0.0.1:1080` ③ 把 provider.baseURL 改回真实上游地址 ④ 停掉旧脚本进程 |
| 新用户 | 直接配规则即可，无需任何脚本 |

（脚本已移出仓库；需要时从 git 历史取回。）

---

## 9. 边界与异常

* **无匹配规则**：直连，不注入 dispatcher。
* **proxyUrl 不可达**：`fetch` 抛 `LlmError(TRANSPORT, cause)`，`llm-retry` 按既有策略重试；UI 显示 “via proxyUrl failed: …” 便于定位是代理而非上游。
* **socks 依赖缺失**：首次命中 `socks5://` 时抛 `LlmError("socks proxy requires 'socks'")`，日志提示 `pnpm add socks`。
* **并发与 HMR**：规则更新不影响已在途的流；插件热重载恢复 `globalThis.fetch` 再重包装，无泄漏。
* **重放消息**：`LlmRuntime.forAdapter` 已剥离跨 adapter 的 `replayState`，代理层不感知重放，无需特殊处理。

---

## 10. 测试策略

* **单测**：`resolveProxy` 的精确/通配/禁用/默认兜底；`dispatcher` 缓存；`wrapFetch` 在/不在 ALS 上下文的行为；socks/http 分支。
* **集成**：起本地 `http` 上游 + `http` 代理（`node:http` 的 CONNECT），验证 `DeepSeekAdapter` 与 `PiAiAdapter` 的流式 SSE 经代理可达；直连对照。
* **E2E**：`settings.mutate` 后下一条 `session.prompt` 即走新代理；改回直连即不走。
* **故障注入**：代理端口不可达、认证失败、DNS 失败的错误码与 message。
* **快照**：沿用 `scripts/snapshots` 模式，确保 `settings.describe` 暴露新 namespace。

---

## 11. 迭代路线

* **M0（本周）**：host 插件 + `llm/stream` + ALS + `fetch` 包装（代理路径走 undici.fetch）+ `ProxyAgent`（http/https）+ undici `Agent`+socks `connect`（socks5/h，https 自包 TLS）；手写 `settings.yaml` 配置；`debug` 日志。
* **M1**：`proxyCredentialRef`、脱敏日志、`probe` 命令、README 与示例 `cordis.patch.yml`。
* **M2**：Client 卡片（`ui-settings` section），支持增删改规则、测试连接按钮；`model: "prefix*"`。
* **M3**：按 `purpose`（compaction/title）细分、按 session 覆盖（`ctx.agentTeams` 场景）、指标埋点。

---

## 12. 附录

### A. 参考实现依赖

```json
{
  "dependencies": {
    "undici": "^6"
  },
  "optionalDependencies": {
    "socks": "^2.8"
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-settings": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^"
  }
}
```

### B. 为什么 ALS 而非全局变量

全局变量在并发请求下会互相覆盖：请求 A 设 `globalProxy=socks` 后、请求 B 设 `globalProxy=direct`，A 的 `fetch` 可能读到 B 的值。`AsyncLocalStorage` 绑定到异步调用链，天然隔离。

### C. 备选：decorator 模式的不适用性

`ctx.llm.registerAdapter` 的 `replace()` 要求同 adapter 实例；插件若用新 adapter 包旧 adapter，需在启动时枚举所有 provider 并重注册，复杂度高且与 `pi-ai` 的 `Models` 集合动态性冲突。fetch 包装是更薄、更稳的切面。

### D. 现脚本复用

（历史记录）曾考虑将旧脚本的 `ConnectProxyAgent` 作为 forwardMode 实现参考。forwardMode 已否决（§6.4），脚本亦已移出仓库，此路径关闭。

---

## 13. 决策与下一步

* **采纳**：方案 A（waterfall + ALS + fetch dispatcher）为默认路径。
* **下一步**：在 `dsh-model-proxy` 目录按 §7 结构初始化插件包，先以 `pnpm --filter dsh-model-proxy run build` + 本地 `cordis.patch.yml` 自测，再补单测与 GUI。

> 如需，我可直接在此目录按本设计初始化最小可跑的 M0 插件骨架（host 插件 + 配置 + 单测），你只需 `pnpm install && dsh --patch ./cordis.patch.yml` 即可体验“某模型走代理”。

