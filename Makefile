# opencode-mcp-pr — fork release Makefile
#
# Single entry point for building + publishing a fork release to MinIO.
# Deterministic: no manual steps, no missed cache purges, no stale-sha mismatches.
#
# Usage:
#   make release          # build + publish a bug-fix RC republish (auto next RC)
#   make release-clean    # build + publish a clean upstream release (needs UPSTREAM=vX.Y.Z)
#   make release VERSION=1.17.13-RC3   # build + publish an explicit version
#   make release-dry      # print what release would do (no build, no upload)
#
# Prereqs (checked at start): bun, mc (MinIO client), sha256sum, curl, gh, git.
# Branch must be fork/main and the tree must be clean (committed) before publishing.
#
# What it does, in order, atomically (halts on first failure):
#   1. resolve version (auto next RC from manifest, or UPSTREAM=, or VERSION=)
#   2. build the linux-x64 binary stamped with OPENCODE_VERSION=<version>
#   3. package: version-stable tarball + versioned archive + sha256 sidecars
#   4. upload to MinIO with Cache-Control:no-cache,must-revalidate (defeats the
#      Cloudflare edge cache bug that previously served stale RC tarballs)
#   5. write + upload manifest.json; flip install.sh DEFAULT_SHA256
#   6. verify: re-fetch each object, confirm sha matches manifest + install.sh
#   7. self-test: fresh curl of install.sh | sh in a temp PREFIX (smoke)
#   8. push fork/main; write .release-monitor-state
#
# No step is skipped. If verify (step 6) fails, the Makefile exits non-zero
# BEFORE pushing or updating state — so a broken publish never records as done.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help
.STOP_ON_ERROR :=

# --- config (constants) -----------------------------------------------------
REMOTE       := casonatto
BUCKET_PATH  := shared/opencode-custom
BASE_URL     := https://s3.casonatto.dev/shared/opencode-custom
STABLE_KEY   := opencode-custom-linux-x64.tar.gz
MANIFEST_KEY := manifest.json
INSTALL_KEY  := install.sh
STATE_FILE   := .release-monitor-state

PKG_DIR      := packages/opencode
BUILD_BIN    := $(PKG_DIR)/dist/opencode-linux-x64/bin/opencode
STAGE        := /tmp/opencode-release-stage

# --- colors ----------------------------------------------------------------
R := $(shell tput setaf 1 2>/dev/null || true)
G := $(shell tput setaf 2 2>/dev/null || true)
Y := $(shell tput setaf 3 2>/dev/null || true)
B := $(shell tput setaf 4 2>/dev/null || true)
N := $(shell tput sgr0 2>/dev/null || true)

.PHONY: help release release-clean release-dry check-env resolve-version build package upload flip-manifest verify selftest push record purge-cache

help: ## show this help
	@awk 'BEGIN{FS=":.*##";printf "$(B)opencode fork release targets$(N)\n"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  $(G)%-16s$(N) %s\n",$$1,$$2}' $(MAKEFILE_LIST)

# --- prerequisite checks ----------------------------------------------------
check-env:
	@for tool in bun mc sha256sum curl gh git; do \
	  command -v $$tool >/dev/null 2>&1 || { echo "$(R)missing required tool: $$tool$(N)"; exit 1; }; \
	done
	@[ "$$(git branch --show-current)" = "fork/main" ] || { echo "$(R)must be on fork/main (now: $$(git branch --show-current))$(N)"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "$(R)working tree must be clean (commit first)$(N)"; git status --short; exit 1; }
	@mc ls $(REMOTE)/$(BUCKET_PATH) >/dev/null 2>&1 || { echo "$(R)mc alias '$(REMOTE)' not configured or bucket unreachable$(N)"; exit 1; }
	@echo "$(G)prereqs ok$(N)"

# --- version resolution -----------------------------------------------------
# Resolves VERSION in this priority: explicit VERSION=, then UPSTREAM= (clean), then auto next RC.
resolve-version:
ifeq ($(strip $(VERSION)),)
ifeq ($(strip $(UPSTREAM)),)
	@V=$$(mc cat $(REMOTE)/$(BUCKET_PATH)/$(MANIFEST_KEY) 2>/dev/null | sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p'); \
	if [ -z "$$V" ]; then echo "$(R)could not read current version from manifest; pass VERSION=$(N)"; exit 1; fi; \
	base=$${V%%-RC*}; rc=$${V##*-RC}; \
	if [ "$$base" = "$$V" ]; then next="$$base-RC1"; else next="$$base-RC$$((rc+1))"; fi; \
	echo "$(B)auto-resolved version: $$next$(N)"; \
	echo "RESOLVED_VERSION=$$next" > .release-version.env
else
	@echo "$(B)clean upstream release: $(UPSTREAM)$(N)"; \
	echo "RESOLVED_VERSION=$$(echo $(UPSTREAM) | sed 's/^v//')" > .release-version.env
endif
else
	@echo "$(B)explicit version: $(VERSION)$(N)"; echo "RESOLVED_VERSION=$(VERSION)" > .release-version.env
endif

# --- dry run ---------------------------------------------------------------
release-dry: check-env resolve-version
	@V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	echo "$(B)=== DRY RUN (no build, no upload) ===$(N)"; \
	echo "version:    $$V"; \
	echo "binary:     $(BUILD_BIN)"; \
	echo "stable key: $(REMOTE)/$(BUCKET_PATH)/$(STABLE_KEY)"; \
	echo "manifest:   $(BASE_URL)/$(MANIFEST_KEY)"; \
	echo "install.sh: $(BASE_URL)/$(INSTALL_KEY)"; \
	echo "stage dir:  $(STAGE)-$$V"; \
	rm -f .release-version.env

# --- the real target --------------------------------------------------------
release: check-env resolve-version build package upload flip-manifest verify selftest push record
	@V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	echo "$(G)=== RELEASE $$V PUBLISHED ===$(N)"; \
	rm -f .release-version.env

# release-clean: clean upstream release build (version matches latest upstream stable).
# Implemented as a recursive `make release UPSTREAM=<tag>` so UPSTREAM reaches the
# parse-time `ifeq` in resolve-version. A target-specific UPSTREAM assignment would NOT
# be visible at parse time (Make evaluates `ifeq` during the first parse, before
# target-specific variables apply), which would silently route to the auto-RC branch
# and publish <last_manifest_version>-RCn instead of a clean upstream release.
release-clean:
	@$(MAKE) release UPSTREAM=$(shell gh release list --repo anomalyco/opencode --limit 20 2>/dev/null | awk '{print $$3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$$' | sort -V | tail -1)

# --- step 2: build ---------------------------------------------------------
build:
	@V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	echo "$(B)=== building $$V ===$(N)"; \
	cd $(PKG_DIR) && OPENCODE_VERSION="$$V" bun script/build.ts --single --skip-embed-web-ui --skip-install; \
	out=$$(dist/opencode-linux-x64/bin/opencode --version); \
	[ "$$out" = "$$V" ] || { echo "$(R)smoke fail: binary reports '$$out' expected '$$V'$(N)"; exit 1; }; \
	echo "$(G)build + smoke ok: $$out$(N)"

# --- step 3: package -------------------------------------------------------
# CRITICAL: the manifest URL points at the VERSIONED object key, not the
# version-stable key. Each release gets a brand-new URL, so the Cloudflare edge
# can never serve a previous RC's cached tarball (the stale-cache bug that bit
# us before). The version-stable key is still uploaded for backward compat
# with old install.sh copies, but new installs always hit the versioned URL.
package:
	@V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	stage=$(STAGE)-$$V; rm -rf "$$stage"; mkdir -p "$$stage"; \
	cp $(BUILD_BIN) "$$stage/opencode"; \
	cd "$$stage" && tar -czf $(STABLE_KEY) opencode && tar -czf opencode-custom-$$V-linux-x64.tar.gz opencode; \
	( cd "$$stage" && \
	  sha256sum $(STABLE_KEY) | awk '{print $$1}' > $(STABLE_KEY).sha256 && \
	  sha256sum opencode-custom-$$V-linux-x64.tar.gz | awk '{print $$1}' > opencode-custom-$$V-linux-x64.tar.gz.sha256 ); \
	stable_sha=$$(<"$$stage/$(STABLE_KEY).sha256"); \
	ver_sha=$$(<"$$stage/opencode-custom-$$V-linux-x64.tar.gz.sha256"); \
	[ "$$stable_sha" = "$$ver_sha" ] || { echo "$(R)internal sha mismatch$(N)"; exit 1; }; \
	printf '{"version":"%s","url":"%s/opencode-custom-%s-linux-x64.tar.gz","sha256":"%s"}\n' "$$V" "$(BASE_URL)" "$$V" "$$ver_sha" > "$$stage/$(MANIFEST_KEY)"; \
	echo "$(G)package ok: sha=$$stable_sha$(N)"

# --- step 4: upload (Cache-Control defeats the Cloudflare cache bug) --------
upload:
	@set -o pipefail; \
	V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	stage=$(STAGE)-$$V; \
	cf="Cache-Control=max-age=0,must-revalidate"; \
	echo "$(B)=== uploading $$V (Cache-Control: no-cache) ===$(N)"; \
	mc cp --attr "$$cf" "$$stage/$(STABLE_KEY)"            $(REMOTE)/$(BUCKET_PATH)/$(STABLE_KEY)            | tail -1; \
	mc cp --attr "$$cf" "$$stage/$(STABLE_KEY).sha256"     $(REMOTE)/$(BUCKET_PATH)/$(STABLE_KEY).sha256     | tail -1; \
	mc cp --attr "$$cf" "$$stage/opencode-custom-$$V-linux-x64.tar.gz"          $(REMOTE)/$(BUCKET_PATH)/opencode-custom-$$V-linux-x64.tar.gz          | tail -1; \
	mc cp --attr "$$cf" "$$stage/opencode-custom-$$V-linux-x64.tar.gz.sha256"  $(REMOTE)/$(BUCKET_PATH)/opencode-custom-$$V-linux-x64.tar.gz.sha256  | tail -1; \
	mc cp --attr "$$cf" "$$stage/$(MANIFEST_KEY)"          $(REMOTE)/$(BUCKET_PATH)/$(MANIFEST_KEY)          | tail -1; \
	echo "$(G)upload ok$(N)"

# --- step 5: flip install.sh (url + sha point at the versioned key) ---------
flip-manifest:
	@set -o pipefail; \
	V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	stage=$(STAGE)-$$V; \
	ver_sha=$$(<"$$stage/opencode-custom-$$V-linux-x64.tar.gz.sha256"); \
	mc cat $(REMOTE)/$(BUCKET_PATH)/$(INSTALL_KEY) > "$$stage/install.sh.cur"; \
	sed -i "s|^DEFAULT_URL=.*|DEFAULT_URL=\"$(BASE_URL)/opencode-custom-$$V-linux-x64.tar.gz\"|" "$$stage/install.sh.cur"; \
	sed -i "s|^DEFAULT_SHA256=.*|DEFAULT_SHA256=\"$$ver_sha\"|" "$$stage/install.sh.cur"; \
	mc cp --attr "Cache-Control=max-age=0,must-revalidate" "$$stage/install.sh.cur" $(REMOTE)/$(BUCKET_PATH)/$(INSTALL_KEY) | tail -1; \
	echo "$(G)install.sh flipped to versioned url + sha=$$ver_sha$(N)"

# --- step 6: verify (re-fetch + compare; halts before push on mismatch) -----
verify:
	@V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	stage=$(STAGE)-$$V; \
	expected=$$(sed -nE 's/.*"sha256"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$$stage/$(MANIFEST_KEY)"); \
	remote_sha=$$(mc cat $(REMOTE)/$(BUCKET_PATH)/opencode-custom-$$V-linux-x64.tar.gz | sha256sum | awk '{print $$1}'); \
	manifest_sha=$$(mc cat $(REMOTE)/$(BUCKET_PATH)/$(MANIFEST_KEY) | sed -nE 's/.*"sha256"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p'); \
	install_sha=$$(mc cat $(REMOTE)/$(BUCKET_PATH)/$(INSTALL_KEY) | sed -nE 's/^DEFAULT_SHA256="([^"]+)".*/\1/p'); \
	install_url=$$(mc cat $(REMOTE)/$(BUCKET_PATH)/$(INSTALL_KEY) | sed -nE 's/^DEFAULT_URL="([^"]+)".*/\1/p'); \
	echo "  tarball  sha: $$remote_sha"; \
	echo "  manifest sha: $$manifest_sha"; \
	echo "  install  sha: $$install_sha"; \
	echo "  install  url: $$install_url"; \
	[ "$$remote_sha" = "$$expected" ] && [ "$$manifest_sha" = "$$expected" ] && [ "$$install_sha" = "$$expected" ] || { \
	  echo "$(R)VERIFY FAILED — shas do not all match expected=$$expected$(N)"; exit 1; }; \
	case "$$install_url" in *opencode-custom-$$V-linux-x64.tar.gz) ;; *) echo "$(R)VERIFY FAILED — install.sh DEFAULT_URL does not point at the versioned key$(N)"; exit 1 ;; esac; \
	echo "$(G)verify ok$(N)"

# --- step 7: self-test (fresh install.sh in a throwaway PREFIX) ------------
selftest:
	@V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	tmp_prefix="/tmp/och-selftest-$$V-$$$$"; \
	echo "$(B)=== self-test: install.sh into $$tmp_prefix ===$(N)"; \
	mc cat $(REMOTE)/$(BUCKET_PATH)/$(INSTALL_KEY) > /tmp/och-selftest-install.sh 2>/dev/null; \
	export OPENCODE_CUSTOM_PREFIX="$$tmp_prefix"; \
	sh /tmp/och-selftest-install.sh >/tmp/och-selftest.log 2>&1 && { \
	  v=$$("$$tmp_prefix/lib/opencode-custom/opencode" --version 2>/dev/null); \
	  [ "$$v" = "$$V" ] && echo "$(G)self-test ok: installed binary reports $$V$(N)" || { echo "$(R)self-test version mismatch: got '$$v' expected '$$V'$(N)"; rtk read /tmp/och-selftest.log; exit 1; }; \
	} || { echo "$(R)self-test install failed$(N)"; rtk read /tmp/och-selftest.log; exit 1; }; \
	rm -rf "$$tmp_prefix" /tmp/och-selftest.log /tmp/och-selftest-install.sh

# --- step 8: push ----------------------------------------------------------
push:
	@set -o pipefail; \
	git push origin fork/main | tail -2; \
	echo "$(G)push ok$(N)"

# --- step 9: record state --------------------------------------------------
record:
	@V=$$(sed 's/RESOLVED_VERSION=//' .release-version.env); \
	echo "$$V" > $(STATE_FILE); \
	echo "$(G)recorded $(STATE_FILE)=$$V$(N)"

# --- optional: purge Cloudflare cache for the tarball (needs CF creds) ------
.PHONY: purge-cache
purge-cache:
	@: $$( \
	  : "Purge Cloudflare edge cache for the version-stable tarball." : ; \
	  : "Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID env vars." : ; \
	)
	@[ -n "$$CLOUDFLARE_API_TOKEN" ] && [ -n "$$CLOUDFLARE_ZONE_ID" ] || { echo "$(R)set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID to purge$(N)"; exit 1; }; \
	rtk curl -sX POST "https://api.cloudflare.com/client/v4/zones/$$CLOUDFLARE_ZONE_ID/purge_cache" \
	  -H "Authorization: Bearer $$CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
	  -d "{\"files\":[\"$(BASE_URL)/$(STABLE_KEY)\",\"$(BASE_URL)/$(MANIFEST_KEY)\",\"$(BASE_URL)/$(INSTALL_KEY)\"]}" \
	  | sed -n 's/.*"success":\([a-z]*\).*/cf purge success=\1/p'; \
	echo "$(G)cache purged$(N)"
