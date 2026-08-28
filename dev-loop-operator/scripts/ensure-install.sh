#!/usr/bin/env bash
# dev-loop environment bootstrap — idempotent, harness-neutral (any agent that can run a shell).
# node ≥ 23.6 → a coding CLI → install the engine (3-tier source) → source-integrity check when a
# source tree is at hand → PATH hint → `dev-loop doctor` → "环境就绪 ✔ / ready".
#
# Environment:
#   DEVLOOP_NODE            absolute path to a node ≥ 23.6 (used for the check AND exported for dev-loop)
#   DEVLOOP_PKG             npm package name            (default @dyzsasd/dev-loop)
#   DEVLOOP_VERSION         npm version/dist-tag pin    (default latest)
#   DEVLOOP_INSTALL_SOURCE  tier 1: a tarball path/URL, or a git checkout dir (repo root or its hub/)
#   DEVLOOP_GIT             tier 3: git repo to clone   (default https://github.com/dyzsasd/dev-loop.git)
#   DEVLOOP_FORCE_INSTALL=1 reinstall even when dev-loop is already on PATH (the §6 upgrade path)
#   DEVLOOP_REQUIRE_CLI=0   downgrade "no coding CLI found" from a failure to a warning
#   DEVLOOP_SOURCE_TREE     run the integrity check against this checkout (auto-set for tiers 1-dir/3)
# Every npm invocation passes --ignore-scripts (supply-chain posture: no lifecycle script ever runs here).
set -euo pipefail

PKG="${DEVLOOP_PKG:-@dyzsasd/dev-loop}"
VER="${DEVLOOP_VERSION:-latest}"
GIT_URL="${DEVLOOP_GIT:-https://github.com/dyzsasd/dev-loop.git}"
MIN_NODE_MAJOR=23
MIN_NODE_MINOR=6
SOURCE_TREE="${DEVLOOP_SOURCE_TREE:-}"

say()  { printf '[ensure-install] %s\n' "$*"; }
warn() { printf '[ensure-install] WARN: %s\n' "$*" >&2; }
fail() { printf '[ensure-install] FAIL: %s\n' "$*" >&2; exit 1; }

# ── ① node ≥ 23.6 (node:sqlite + type-stripping floor) ───────────────────────────────────────────
NODE_HINT="get one via nvm (nvm install 24), fnm, your package manager, or https://nodejs.org — or point DEVLOOP_NODE=/absolute/path/to/node at an existing one."
if [ -n "${DEVLOOP_NODE:-}" ]; then
  [ -x "$DEVLOOP_NODE" ] || fail "DEVLOOP_NODE=$DEVLOOP_NODE is not an executable; $NODE_HINT"
  NODE_BIN="$DEVLOOP_NODE"
  PATH="$(dirname "$DEVLOOP_NODE"):$PATH"; export PATH DEVLOOP_NODE
else
  command -v node >/dev/null 2>&1 || fail "node not found (need ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}); $NODE_HINT"
  NODE_BIN="$(command -v node)"
fi
NODE_V="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
NODE_MAJ="${NODE_V%%.*}"; rest="${NODE_V#*.}"; NODE_MIN="${rest%%.*}"
case "$NODE_MAJ$NODE_MIN" in *[!0-9]*|"") fail "could not parse node version '$NODE_V' from $NODE_BIN";; esac
if [ "$NODE_MAJ" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJ" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MIN" -lt "$MIN_NODE_MINOR" ]; }; then
  fail "node $NODE_V is too old — dev-loop needs node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}; $NODE_HINT"
fi
say "node $NODE_V OK ($NODE_BIN)"
command -v npm >/dev/null 2>&1 || fail "npm not found next to node ($NODE_BIN); install node with npm, or add its bin dir to PATH."

# ── ② a coding CLI (the fire lane) ────────────────────────────────────────────────────────────────
FOUND_CLI=""
for cli in claude codex opencode; do
  if command -v "$cli" >/dev/null 2>&1; then
    FOUND_CLI="$FOUND_CLI $cli"
    say "coding CLI: $cli OK ($("$cli" --version 2>/dev/null | head -1 || echo 'version unknown'))"
  fi
done
if [ -z "$FOUND_CLI" ]; then
  msg="no coding CLI on PATH (need one of claude | codex | opencode). Install: npm i -g @anthropic-ai/claude-code | npm i -g @openai/codex | npm i -g opencode-ai — then log in once as the operator."
  if [ "${DEVLOOP_REQUIRE_CLI:-1}" = "0" ]; then warn "$msg"; else fail "$msg (set DEVLOOP_REQUIRE_CLI=0 to continue without one)"; fi
else
  say "login is interactive and cannot be scripted — if this machine never logged in, run once:$(printf ' %s' "$FOUND_CLI") (claude → \`claude\`; codex → \`codex login\`; opencode → \`opencode auth login\`)."
fi

# ── ③ the engine: DEVLOOP_INSTALL_SOURCE → npm registry → git clone + build ──────────────────────
install_from_tree() {  # $1 = checkout root (or its hub/)
  local root="$1" hub
  if [ -f "$root/hub/package.json" ]; then hub="$root/hub"; elif [ -f "$root/package.json" ]; then hub="$root"; root="$(cd "$root/.." && pwd)"; else return 1; fi
  say "building from source tree $hub (npm ci --ignore-scripts → npm run build → npm i -g)"
  ( cd "$hub" && npm ci --ignore-scripts && npm run build && npm install -g . --ignore-scripts ) || return 1
  SOURCE_TREE="$root"
}
install_engine() {
  local src="${DEVLOOP_INSTALL_SOURCE:-}"
  if [ -n "$src" ]; then
    say "tier 1: DEVLOOP_INSTALL_SOURCE=$src"
    if [ -d "$src" ]; then
      install_from_tree "$src" || fail "install from source tree $src failed (needs hub/package.json)"
    elif [ -f "$src" ] || case "$src" in http://*|https://*) true;; *) false;; esac; then
      npm install -g "$src" --ignore-scripts || fail "npm install -g $src failed"
    else
      fail "DEVLOOP_INSTALL_SOURCE=$src is neither a tarball path/URL nor a checkout directory"
    fi
    return 0
  fi
  say "tier 2: npm install -g $PKG@$VER --ignore-scripts"
  if npm install -g "$PKG@$VER" --ignore-scripts; then return 0; fi
  warn "npm registry install failed — tier 3: git clone $GIT_URL (build takes a few minutes)"
  local tmp; tmp="$(mktemp -d)"
  git clone --depth 1 "$GIT_URL" "$tmp/dev-loop" || fail "all three install sources failed. Manual: npm i -g $PKG@$VER --ignore-scripts; or DEVLOOP_INSTALL_SOURCE=<tarball|checkout>; or check that $GIT_URL is reachable."
  install_from_tree "$tmp/dev-loop" || fail "git-source build failed in $tmp/dev-loop (see output above)"
}

need_install=1
if command -v dev-loop >/dev/null 2>&1 && [ "${DEVLOOP_FORCE_INSTALL:-0}" != "1" ]; then
  have="$(dev-loop version 2>/dev/null | head -1 || true)"
  if [ "$VER" = "latest" ] || [ "$have" = "$VER" ] || [ -n "${DEVLOOP_INSTALL_SOURCE:-}" ]; then
    say "dev-loop already installed (v${have:-?}) — skipping install (DEVLOOP_FORCE_INSTALL=1 to reinstall)"
    need_install=0
  else
    say "dev-loop v${have:-?} installed, pin is $VER — reinstalling"
  fi
fi
[ "$need_install" -eq 0 ] || install_engine

# ── ④ npm global bin on PATH? ────────────────────────────────────────────────────────────────────
if ! command -v dev-loop >/dev/null 2>&1; then
  NPMBIN="$(npm prefix -g 2>/dev/null)/bin"
  if [ -x "$NPMBIN/dev-loop" ]; then
    say "installed to $NPMBIN, which is NOT on PATH — add this line to your shell profile and reopen the session:"
    say "  export PATH=\"$NPMBIN:\$PATH\""
    PATH="$NPMBIN:$PATH"; export PATH
  else
    fail "dev-loop is not on PATH after install (npm global bin $NPMBIN has no dev-loop either)"
  fi
fi
say "dev-loop = $(command -v dev-loop) (v$(dev-loop version 2>/dev/null | head -1 || echo '?'))"

# ── ⑤ source integrity (only meaningful against a source tree) ───────────────────────────────────
if [ -n "$SOURCE_TREE" ] && [ -f "$SOURCE_TREE/security/source_integrity.py" ]; then
  if command -v python3 >/dev/null 2>&1; then
    say "source integrity: python3 security/source_integrity.py --whole-tree (in $SOURCE_TREE)"
    ( cd "$SOURCE_TREE" && python3 security/source_integrity.py --whole-tree ) || fail "source integrity check FAILED in $SOURCE_TREE — do not run this build"
    say "source integrity OK"
  else
    warn "source integrity check SKIPPED: python3 not found (tree: $SOURCE_TREE)"
  fi
else
  say "source integrity check skipped: no source tree at hand (registry/tarball install; set DEVLOOP_SOURCE_TREE=<checkout> to run it)"
fi

# ── ⑥ doctor + the ready line ────────────────────────────────────────────────────────────────────
say "running dev-loop doctor …"
if out="$(dev-loop doctor 2>&1)"; then
  printf '%s\n' "$out" | tail -3
  printf '%s\n' "$out" | grep -q "DOCTOR_OK" && say "doctor: DOCTOR_OK" || say "doctor exited 0 without the DOCTOR_OK marker — read the output above"
else
  printf '%s\n' "$out" | tail -5
  say "doctor is not green — expected on a machine with no workspace yet (next: SKILL.md §2 \`dev-loop init\`); otherwise fix its NEXT: line"
fi
say "环境就绪 ✔ / ready — next: SKILL.md §2 (workspace init) or §3 (daemon & scheduler)"
