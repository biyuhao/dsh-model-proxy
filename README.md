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

## Features

- **Per-rule routing**: `{provider, model, proxyUrl, enabled}` — specificity: exact model > prefix `muse-*` > `*`.
- **Purpose filter**: optional per-rule `purpose` (e.g. `compaction`) so chat goes through the proxy while background calls stay direct.
- **credentialRef**: keep proxy passwords in the DSH credentials service instead of the profile config; rules reference them by name (`user:password` entries). Soft dependency — installs without it keep working.
- **Auto probe**: newly configured proxies are connectivity-tested once (CONNECT/socks handshake, no model quota); results go to the host log.
- **Protocols**: `http://`, `https://` (CONNECT via `undici.ProxyAgent`), `socks5://` / `socks5h://` (via optional `socks`, tunnelled by undici `Agent` + custom connect).
- **Zero baseURL mutation** — keep the real upstream.
- **Live**: change rules → next `llm/stream` uses them; in-flight streams unaffected.
- **UI**: `Settings → Plugins → Model Proxy` card; edits commit live to the profile patch (hand-written yaml works too — see "Via file").
- **Provider picker**: dropdown groups user-configured providers first (derived from `llm.providers` × settings mirror, same semantics as the built-in Models page); bare directory routes follow, and "Custom…" accepts anything — hand-written yaml rules, wildcards, gateways the catalog doesn't know. Provider and model fields are dropdowns fed by the live host catalog (`llm.providers` / `llm.models`, refreshed on `llm/adapters-updated`); a "Custom…" entry keeps free text for wildcards (`muse-*`, `*`) or not-yet-installed providers.
- **Batch & grouped management**: adding rules checks multiple models for one provider at once — one rule each, sharing proxy/purpose/credential; the list groups cards by provider with group-level apply-proxy, enable/disable-all, and delete (cross-provider grouping never affects match order).

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
    defaultProxy: ""  # fallback when no rule matches
    rules:
      - provider: opencode
        model: muse-spark-1.2-contributor
        proxyUrl: socks5://127.0.0.1:1080
        enabled: true
      - provider: opencode
        model: "*"
        proxyUrl: ""  # direct for the rest of this provider
```

`proxyUrl: ""` means **direct (exempt)**. `socks5h://` resolves DNS at the proxy.
Field changes commit live (volatile Config) without restarting the profile.

## How it works (non-invasive)

1. The plugin's volatile Config fields are the `model-proxy` settings section (the loader entry id); edits commit live.
2. Wraps `globalThis.fetch` reversibly.
3. Listens on `llm/stream` waterfall, resolves `proxyUrl` for `(provider, model)` via `AsyncLocalStorage`, then injects a `dispatcher` into the adapter's `fetch` — for proxied requests it routes through `undici.fetch` (Node's native global fetch ignores custom dispatchers), with `undici.ProxyAgent` for `http(s)` and an undici `Agent` + socks `connect` (with TLS) for `socks5/h`.
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
