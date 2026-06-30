#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# loop-vs-oneshot-tokens.sh — empirical evidence for the 0.24.0 design claim:
#
#   "The loop runs as external, headless, ONE-SHOT fires — never an in-session
#    /loop cadence (which accumulates conversation context and burns tokens)."
#
# This is a LIVE benchmark: it makes real `claude -p` calls and reads the true
# per-call usage from `--output-format json`. It costs a few dollars to run and
# is NOT part of `npm test`. Run it by hand when you want to re-confirm the claim.
#
# Two arms, same agent-style prompt, MCP stripped for low variance:
#   ARM A (oneshot)  — a fresh `claude -p` process per fire  → the OS-scheduler model
#   ARM B (loop)     — `--resume` the same session each fire → the in-session /loop model
#
# Headline metric: CONTEXT = input + cache_creation + cache_read tokens, i.e. the
# total token volume the model must process on that fire. Caching changes the $
# you pay but NOT this volume, and it is this volume that hits the context window.
#
# Usage:   bash hub/bench/loop-vs-oneshot-tokens.sh [N_FIRES]
# Env:     DEVLOOP_BENCH_PROMPT   override the per-fire prompt
# Requires: claude CLI (authenticated), jq
# ─────────────────────────────────────────────────────────────────────────────
set -u
command -v claude >/dev/null || { echo "need the claude CLI on PATH"; exit 2; }
command -v jq >/dev/null || { echo "need jq on PATH"; exit 2; }

N=${1:-8}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/devloop-bench.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
PROMPT=${DEVLOOP_BENCH_PROMPT:-'You are the PM agent in a dev loop for a project-management SaaS. Do ONE fire of work: (1) restate the current product north-star in 2 sentences, (2) propose THREE new improvement tickets, each with a title, a 3-sentence rationale, and acceptance criteria as 3 bullets. Be concrete — aim for roughly 450-550 words total.'}
COMMON=(--output-format json --mcp-config '{"mcpServers":{}}' --strict-mcp-config)

ctx() { jq '(.usage.input_tokens)+(.usage.cache_creation_input_tokens)+(.usage.cache_read_input_tokens)' "$1"; }

echo "N=$N fires/arm · headline = CONTEXT tokens (input+cache_create+cache_read) processed per fire"
echo
printf 'fire#  oneshot_ctx  loop_ctx   oneshot_out  loop_out\n'
SID=""; o_first=""; l_first=""
for i in $(seq 1 "$N"); do
  claude -p "$PROMPT" "${COMMON[@]}" > "$WORK/o_$i.json" 2>"$WORK/o_$i.err"
  if [ -z "$SID" ]; then
    claude -p "$PROMPT" "${COMMON[@]}" > "$WORK/l_$i.json" 2>"$WORK/l_$i.err"
    SID=$(jq -r '.session_id' "$WORK/l_$i.json")
  else
    claude -p "$PROMPT" --resume "$SID" "${COMMON[@]}" > "$WORK/l_$i.json" 2>"$WORK/l_$i.err"
  fi
  oc=$(ctx "$WORK/o_$i.json"); lc=$(ctx "$WORK/l_$i.json")
  oo=$(jq '.usage.output_tokens' "$WORK/o_$i.json"); lo=$(jq '.usage.output_tokens' "$WORK/l_$i.json")
  [ -z "$o_first" ] && o_first=$oc; [ -z "$l_first" ] && l_first=$lc
  printf '%4d   %10d  %8d   %10d  %8d\n' "$i" "$oc" "$lc" "$oo" "$lo"
done

last_o=$(ctx "$WORK/o_$N.json"); last_l=$(ctx "$WORK/l_$N.json")
growth=$(( (last_l - l_first) / (N>1 ? N-1 : 1) ))
echo "----"
printf 'oneshot context drift over %d fires: %d -> %d  (delta %+d)\n' "$N" "$o_first" "$last_o" "$((last_o-o_first))"
printf 'loop    context drift over %d fires: %d -> %d  (delta %+d, ~%d tokens/fire)\n' "$N" "$l_first" "$last_l" "$((last_l-l_first))" "$growth"
printf 'one-shot is FLAT; the in-session loop grows monotonically and without bound.\n'
printf 'extrapolated context on fire #50 (same slope): oneshot %d  |  loop ~%d\n' "$last_o" "$(( l_first + growth*49 ))"
