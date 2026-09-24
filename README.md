# dsh-plugin-model-proxy

Community DSH plugin: route **specific provider/model pairs** through specific proxies (`http://`, `https://`, `socks5://`, `socks5h://`) — with a **Settings UI**.

## Why

Some model endpoints are only reachable through a proxy while their siblings
connect fine — for instance `opencode/muse-spark-1.2-contributor` may answer
`403 RegionError` to direct connections that other models from the same
provider never see. The coarse fixes don't help: process-wide proxy
environment variables drag every request through the tunnel, and swapping a
whole provider's `baseURL` hides the real upstream. This plugin routes
**specific provider/model pairs** at the transport layer instead — everything
else stays direct, and the configured endpoint is never rewritten.

## 中文说明

### 用途

这个插件用于按 `provider + model` 维度选择 HTTP、HTTPS 或 SOCKS5 代理。它只改变请求经过的传输通道，不修改模型适配器，也不改写上游 `baseURL`；没有匹配到规则的请求仍然可以保持直连。

配置界面位于：

```text
Settings → Plugins → Model Proxy
```

规则按照以下优先级匹配：

```text
精确模型 > 模型前缀通配（例如 muse-*）> * 通配
```

### 代理主机与直连

代理地址在下方“代理主机”区域统一维护。规则只需要从下拉框选择一个主机，或选择 `Direct（直连）`。多个规则可以复用同一个代理主机，代理密码可以通过 `credentialRef` 引用 DSH credentials 服务，而不必写入 profile。

选择 `Direct` 时不会创建代理 Dispatcher，但规则中配置的固定 Header 仍会发送，因此“直连”和“添加 Header”可以同时使用。

### 添加固定 Header

每条规则都支持添加请求 Header，并可以为每个 Header 选择固定值或请求上下文中的内置变量。Header 按规则保存，同一个代理主机下的不同规则可以发送不同的 Header。

以 OpenCode 实际使用的会话 Header 为例：

```yaml
- provider: opencode-go
  model: "*"
  proxyHostId: local-socks
  enabled: true
  headerValueSources:
    x-opencode-session: sessionId
```

上面的配置会在每次匹配请求时读取 `GenerateOptions.sessionId`，将当前会话 ID 写入 `x-opencode-session`。其他内置变量还包括：

- `provider`：当前 Provider；
- `model`：当前模型；
- `purpose`：当前请求用途，例如 `compaction` 或 `session-title`。

也可以在同一规则中组合使用：

```yaml
headerValueSources:
  x-opencode-session: sessionId
  x-provider-name: provider
  x-model-name: model
  x-request-purpose: purpose
```

如果上游要求一个固定值，则使用传统写法：

```yaml
headers:
  x-opencode-session: "fixed-session-value"
```

`x-opencode-session` 的值应替换为当前 OpenCode 会话或上游中继要求的实际值。它是附加 Header，不是 API Token；不要把 `Authorization` 或 `Proxy-Authorization` 写进规则，认证信息应由适配器或凭据服务管理。

Header 规则如下：

- Header 值可以是固定字符串，也可以选择当前请求的 `Session ID`、`Provider`、`Model` 或 `Purpose`；没有对应上下文值时不会注入该 Header；
- 固定 Header 值必须是单行字符串，不能包含 CR/LF；
- Header 名称必须符合 HTTP token 规则；
- 每条规则最多添加 10 个 Header；
- 请求中已经存在的同名 Header 优先，规则值不会覆盖适配器生成的值；
- Header 值不会写入调试日志，日志只显示 Header 名称；
- Header 会在代理模式和直连模式下发送。

在设置界面中，可以点击 `Headers → ＋ x-opencode-session` 快速添加 OpenCode 会话 Header，再选择 `Current session ID`；也可以选择 `Current provider`、`Current model` 或 `Current purpose`。如果需要固定值，则选择 `Fixed value` 并填写实际内容。

## Features

- **Per-rule routing**: `{provider, model, proxyHostId, enabled}` — specificity: exact model > prefix `muse-*` > `*`.
- **Reusable proxy hosts**: maintain named HTTP/HTTPS/SOCKS5 host profiles once; rules select a profile from a dropdown. `Direct` skips the proxy without disabling the rule.
- **Header value strategies**: per-rule `headers` can use fixed values or `headerValueSources` to select `sessionId`, `provider`, `model`, or `purpose`; sent in both direct and proxied modes; existing headers always win.
- **Purpose filter**: optional per-rule `purpose` (e.g. `compaction`) so chat goes through the proxy while background calls stay direct.
- **credentialRef**: keep proxy passwords in the DSH credentials service instead of the profile config; reusable proxy hosts reference them by name (`user:password` entries). Soft dependency — installs without it keep working.
- **Auto probe**: newly configured proxies are connectivity-tested once (CONNECT/socks handshake, no model quota); results go to the host log.
- **Protocols**: `http://`, `https://` (CONNECT via `undici.ProxyAgent`), `socks5://` / `socks5h://` (via optional `socks`, tunnelled by undici `Agent` + custom connect).
- **Zero baseURL mutation** — keep the real upstream.
- **Live**: change rules → next `llm/stream` uses them; in-flight streams unaffected.
- **UI**: `Settings → Plugins → Model Proxy` card; edits commit live to the profile patch (hand-written yaml works too — see "Via file").
- **Provider picker**: dropdown groups user-configured providers first (derived from `llm.providers` × settings mirror, same semantics as the built-in Models page); bare directory routes follow, and "Custom…" accepts anything — hand-written yaml rules, wildcards, gateways the catalog doesn't know. Provider and model fields are dropdowns fed by the live host catalog (`llm.providers` / `llm.models`, refreshed on `llm/adapters-updated`); a "Custom…" entry keeps free text for wildcards (`muse-*`, `*`) or not-yet-installed providers.
- **Batch & grouped management**: adding rules checks multiple models for one provider at once — one rule each, sharing the selected proxy host/purpose; the list groups cards by provider with group-level host selection, enable/disable-all, and delete (cross-provider grouping never affects match order).

## Install

### Recommended: profile-managed (bundle)

The package declares a `dsh.bundle` layer, so the DSH CLI links the dependency
**and** appends the activation row in one step:

```bash
dsh plugin --profile <name> add dsh-plugin-model-proxy
# optional SOCKS support:
dsh plugin --profile <name> add socks
```

Verify the composed layer without booting, then run:

```bash
dsh --profile <name> --dump-config   # shows a "# == dsh-plugin-model-proxy" layer
dsh --profile <name>
```

Uninstall removes both the dependency and the layer:

```bash
dsh plugin --profile <name> remove dsh-plugin-model-proxy
```

Installing from GitHub (`dsh plugin --profile <name> add github:<user>/dsh-plugin-model-proxy#<sha>`)
fetches sources; pnpm ≥10 asks you to allowlist the `prepare` build — copy the
package key it prints into the profile's `pnpm-workspace.yaml` under
`allowBuilds:`, then re-run the `add`. Pin a commit so later pushes cannot
change what runs on your machine.

### Manual: hand-written patch

If you manage compositions by hand, install the dependency into the **profile
directory** first (`dsh plugin --profile <name> add ./` from a checkout works;
module resolution anchors at the profile). Then insert exactly ONE loader row:

```yaml
# ~/.dsh/cordis.patch.yml  (or a --patch overlay)
- insert:
    - id: model-proxy
      name: dsh-plugin-model-proxy
      config: {}
```

Patch-file rules that trip people up:

- The file must parse as a **top-level YAML array** of patch entries. Comments
  are fine; a file of only comments (no `- …` rows and no `[]`) fails to parse
  and breaks every boot/dump that reads it.
- The loader-entry specifier field is **`name:`** (the package name), not `module:`.
- New rows must be nested under **`insert:`** — a bare `- id:` row means "patch an existing entry".
- Only the **host** half is a loader entry. The browser half is discovered automatically
  from the package's `dsh.client` declaration and served at
  `/plugins/dsh-plugin-model-proxy/client.js`. Do NOT add a `model-proxy/client`
  row — it would run browser code inside the Node process.
- **Never mix this path with the profile-managed install above.** Once the
  dependency declares `dsh.bundle.patch`, `dsh plugin add` injects the host row
  automatically; keeping a hand-written copy in `~/.dsh/cordis.patch.yml`
  inserts the same loader id twice and the composition collides at boot.

Uninstall = remove the inserted rows + `pnpm remove dsh-plugin-model-proxy`
from the profile.

## Configure

### Via UI

`Settings → Plugins → Model Proxy`

### Via file

The entry's `config` in the active profile patch (`~/.dsh/profiles/<name>/cordis.patch.yml`;
the settings UI writes edits to the same row):

```yaml
- id: model-proxy
  config:
    enabled: true
    debug: false
    # Named connection profiles are managed once and reused by rules.
    proxyHosts:
      - id: local-socks
        name: Local SOCKS
        proxyUrl: socks5://127.0.0.1:1080
        credentialRef: local-proxy-auth  # optional credentials-service entry
      - id: office-http
        name: Office HTTP
        proxyUrl: http://127.0.0.1:7890
    defaultProxyHostId: ""  # fallback when no rule matches; empty = direct
    defaultProxy: ""         # legacy inline fallback, kept for compatibility
    rules:
      - provider: opencode
        model: muse-spark-1.2-contributor
        proxyHostId: local-socks
        enabled: true
      - provider: opencode-go
        model: "*"
        proxyHostId: office-http
        enabled: true
        headers:
          x-opencode-session: <fixed-value>  # fixed mode
        # Or use the current request session ID:
        # headerValueSources:
        #   x-opencode-session: sessionId
      - provider: opencode
        model: "*"
        # no proxyHostId / proxyUrl = Direct
        enabled: true
```

`proxyHostId` references an entry in `proxyHosts`; omitting it selects direct
mode. `proxyUrl` and per-rule `credentialRef` remain accepted for legacy
hand-written rules and are migrated into named hosts when the card is saved.
`socks5h://` resolves DNS at the proxy. Field changes commit live (volatile
Config) without restarting the profile.

Per-rule `headers` hold fixed extra request headers. A `headerValueSources` map
can select `sessionId`, `provider`, `model`, or `purpose` for a header name; the
value is read from the current request context. Both forms are sent whether the
selected route is proxied or direct. A header already present on the outgoing
request (e.g. `Authorization`, attribution `user-agent`) always wins and is never
overwritten. `Authorization` / `Proxy-Authorization` cannot be set via rules.
Header values never appear in logs (debug prints names only).

## How it works (non-invasive)

1. The plugin's volatile Config fields are the `model-proxy` settings section (the loader entry id); edits commit live.
2. Wraps `globalThis.fetch` reversibly.
3. Listens on `llm/stream` waterfall, resolves the selected reusable host for `(provider, model)` via `AsyncLocalStorage`, then injects a `dispatcher` into the adapter's `fetch` — for proxied requests it routes through `undici.fetch` (Node's native global fetch ignores custom dispatchers), with `undici.ProxyAgent` for `http(s)` and an undici `Agent` + socks `connect` (with TLS) for `socks5/h`. Direct rules still receive their fixed headers through the native fetch path.
4. Browser registers `settings.plugin.item` with key `model-proxy` — automatically paired by the Plugins tab (`served ∩ registered`).

No Adapter fork, no `baseURL` rewrite. See `DESIGN.md` for full design and invasiveness analysis.

## Invasiveness

| Check | Result |
|---|---|
| Modifies `packages/*` | No |
| Requires fork of `dsh-llm` | No |
| Global side effect reversible | Yes (`ctx.effect` dispose restores `fetch`) |
| Client bundle purity gate | Passes (only type-only slot import) |

## Building

```bash
pnpm install
pnpm run build
```

## Testing

Fully offline (local origin + CONNECT-capable toy proxy; no real network or proxy needed):

```bash
pnpm test        # builds host + client, then runs node --test tests/
pnpm run typecheck
```

## License

MIT
