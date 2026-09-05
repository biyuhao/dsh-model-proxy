# dsh-plugin-model-proxy — 本地开发与发布
# 用法:
#   make sync              # 本地构建后用 file: 覆盖已安装到 dsh 的插件（验证当前代码）
#   make sync PROFILE=tui  # 覆盖到指定 profile，默认 web
#   make publish           # npm publish 到官方源（先检查登录与 registry）
#   make build / make test / make clean

PROFILE ?= web
DSH_HOME ?= $(HOME)/.dsh
REGISTRY := https://registry.npmjs.org/
PKG_DIR  := $(CURDIR)
PNPM_DIR := $(DSH_HOME)/profiles/$(PROFILE)

SHELL := /bin/bash
.PHONY: help build test typecheck clean sync install publish publish-dry ensure-login ensure-registry login

help: ## 显示帮助
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

build: ## tsc + esbuild 构建 lib/host + lib/client.js
	npm run build

typecheck: ## 仅类型检查
	npm run typecheck

test: ## 构建并跑 node --test
	npm run test

clean: ## 清理 lib
	npm run clean

# 1) 本地代码替换 dsh 中已安装的插件
#    原理：dsh plugin --profile <name> add file:<path> 把本目录写成该 profile 的 file: 依赖。
#    pnpm（hoisted nodeLinker）把源码文件硬链接进 profile/node_modules（isolated 则是符号链接），
#    node_modules 就是当前源码的实时视图——spec 已是 file: 时 pnpm 短路也不影响内容同步；
#    sync 真正要做的是：重新构建、把 spec 收敛为 file:（覆盖旧 registry 版本）、
#    校验 bundles 层与链接身份，防止"装了但没被加载 / 加载的是旧拷贝"。
sync: build ## 构建后用本地 file: 覆盖到 dsh profile（默认 PROFILE=web）
	@echo "==> sync $(PKG_DIR) -> dsh profile [$(PROFILE)] ($(PNPM_DIR))"
	@test -f "$(PKG_DIR)/package.json" || (echo "package.json not found in $(PKG_DIR)"; exit 1)
	@test -d "$(PNPM_DIR)" || (echo "profile dir not found: $(PNPM_DIR)"; echo "请先 dsh --profile $(PROFILE) --dump-config 或 dsh plugin --profile $(PROFILE) add dsh-plugin-model-proxy 创建"; exit 1)
	# 防遮蔽：bundle 按 [dsh 安装锚点, profile] 顺序解析，全局 npm i -g 的副本会优先于本地 file: 版被加载
	@if [ -f "$$(npm prefix -g)/node_modules/dsh-plugin-model-proxy/package.json" ]; then \
		echo "!! 检测到全局副本 $$(npm prefix -g)/node_modules/dsh-plugin-model-proxy，会遮蔽本地版本，请先: npm rm -g dsh-plugin-model-proxy"; \
		exit 1; \
	fi
	# 必须先 remove 再 add，否则 pnpm 用缓存 lockfile 不会重新解析文件列表（新增文件不被链接）
	@echo "-> dsh plugin --profile $(PROFILE) remove + add file:$(PKG_DIR)"
	@dsh plugin --profile $(PROFILE) remove dsh-plugin-model-proxy >/dev/null 2>&1 || true
	@dsh plugin --profile $(PROFILE) add "file:$(PKG_DIR)"
	@echo "  ✓ dsh plugin install 完成"
	# 机制级校验 1：spec 必须指向当前目录
	@if grep -q '"dsh-plugin-model-proxy": "file:$(PKG_DIR)"' "$(PNPM_DIR)/package.json"; then \
		echo "  ✓ spec: file:$(PKG_DIR)"; \
	else \
		echo "  ! spec 未指向当前目录，请检查 pnpm add 结果"; \
	fi
	# 机制级校验 2：node_modules 产物与源码同 inode（硬链接）或经符号链接指向源码，而不是旧拷贝
	@if [ -f "$(PNPM_DIR)/node_modules/dsh-plugin-model-proxy/lib/client.js" ] && [ "$$(stat -f %i '$(PKG_DIR)/lib/client.js')" = "$$(stat -f %i '$(PNPM_DIR)/node_modules/dsh-plugin-model-proxy/lib/client.js')" ]; then \
		echo "  ✓ 已与当前源码建立链接（同 inode）"; \
	else \
		echo "  ! 未与源码建立链接，node_modules 是旧拷贝——检查 nodeLinker 与残留缓存"; \
		exit 1; \
	fi
	# 机制级校验 3：插件名必须在 dsh.profile.bundles 层，否则不会被加载
	@if grep -A8 '"bundles"' "$(PNPM_DIR)/package.json" | grep -q '"dsh-plugin-model-proxy"'; then \
		echo "  ✓ dsh.profile.bundles 已包含 dsh-plugin-model-proxy"; \
	else \
		echo "  ! bundles 层未包含该插件——检查 dsh plugin add 的 reconcile 结果"; \
	fi
	@echo "完成。生效方式：host 侧（lib/host）改动需重启 dsh web；client 侧在 http://127.0.0.1:3080 硬刷新 (Cmd+Shift+R)"
	@echo "  若仍为旧版本：1) 检查是否有多个 profile（tui/web）2) 是否有全局副本遮蔽 3) 回退线上版: dsh plugin --profile $(PROFILE) add dsh-plugin-model-proxy@latest"

install: sync ## alias of sync

login: ensure-login ## 仅执行 npm login（官方源）

ensure-registry: ## 确保 registry 指向官方源
	@echo "==> registry $(REGISTRY)"
	@npm config set registry $(REGISTRY)
	@npm config get registry

ensure-login: ensure-registry ## 确保已 npm login（官方源）
	@echo "==> 检查 npm 登录状态"
	@if npm whoami --registry $(REGISTRY) >/dev/null 2>&1; then \
		echo "  已登录: $$(npm whoami --registry $(REGISTRY)) @ $(REGISTRY)"; \
	else \
		echo "  未登录，执行 npm login --registry $(REGISTRY)"; \
		npm login --registry $(REGISTRY); \
	fi

# 2) 发布到 npm 官方源
#    步骤：ensure-login（内部会 ensure-registry + whoami/login）-> npm publish
publish: build test ensure-login ## 发布到官方 npm（先 whoami/login + 强制 --registry）
	@echo "==> npm publish --registry $(REGISTRY)"
	npm publish --registry $(REGISTRY)
	@echo "✓ 已发布 $$(node -p 'require("./package.json").version') 到 $(REGISTRY)"

publish-dry: build ## 预演发布（不实际推送）
	npm publish --dry-run --registry $(REGISTRY)
