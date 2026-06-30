# Benchmark: external one-shot scheduler vs. in-session `/loop` — token/context

This benchmark substantiates the headline claim behind **0.24.0** (External headless
scheduler as the one canonical way to run the loop):

> The loop runs as external, headless, one-shot fires — **never** an in-session
> `/loop` cadence, which accumulates conversation context and burns tokens.

## What it measures

Each agent "fire" is run two ways, with the same prompt and MCP stripped for low variance:

| Arm | How a fire runs | Models the… |
|-----|-----------------|-------------|
| **oneshot** | a fresh `claude -p` process every fire | OS-scheduler model (`dev-loop service` → `run --once`) |
| **loop** | `--resume` the same session every fire | in-session `/loop` cadence |

Headline metric is **CONTEXT** = `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` — the total token volume the model must process on that
fire. Caching changes the dollars you pay, but **not** this volume, and it is this
volume that fills the finite context window (after which the loop is forced into
lossy compaction/truncation — the exact failure mode the design avoids).

## Reproducing

```bash
bash hub/bench/loop-vs-oneshot-tokens.sh 8     # live; needs an authenticated claude CLI + jq
```

It is a **live, paid** benchmark and is deliberately not part of `npm test`.

## Measured result (N=8, claude 2.1.181, MCP stripped, ~1.1k-token replies)

```
fire#  oneshot_ctx  loop_ctx   oneshot_out  loop_out
   1        72970     72970         1309      1309
   2        72970     74397         1214      1154
   3        72970     75677         1189      1067
   4        72970     76870         1272      1028
   5        72970     78024         1236      1050
   6        72970     79200         1143      1103
   7        72970     80429         1105      1080
   8        72970     81635         1239      1061
----
oneshot context drift over 8 fires: 72970 -> 72970  (delta +0)
loop    context drift over 8 fires: 72970 -> 81635  (delta +8665, ~1237 tokens/fire)
extrapolated context on fire #50 (same slope): oneshot 72970 | loop ~133583
```

## Reading the result

- **One-shot is perfectly flat** — every fire processes the same 72,970-token
  footprint, because each fire is a brand-new stateless process. Context never
  accumulates, so it can run indefinitely.
- **In-session loop grows monotonically and without bound** — ~1,237 tokens/fire
  *even though each reply was capped at ~1.1k tokens*. Extrapolated to fire #50 the
  loop is processing ~134k tokens — ~1.8× the one-shot, and climbing.

### Caveats (read these before quoting numbers)

1. The large constant base (~73k) is the ambient Claude Code system prompt + tools,
   identical in both arms, so it cancels out of the *slope*. A real `dev-loop run`
   fire (one agent skill + the hub MCP) has a much smaller base.
2. **The slope here is a floor, not a ceiling.** Replies were capped at ~1.1k
   tokens. A real agent fire reads tickets, reads/edits files, and runs builds —
   often 5k–30k tokens of accumulated transcript per fire. At ~10k/fire the
   in-session loop exhausts the window in a handful of iterations; the one-shot
   stays flat regardless.
3. **Dollar cost is cache-confounded** and is *not* the clean signal — a warm
   resumed session can even be cheaper per fire. The robust, workload-independent
   signal is context volume, which one-shot bounds and the loop does not.

**Verdict:** the optimization does what it claims. Context per fire is constant and
bounded under the external one-shot scheduler, and grows without bound under an
in-session `/loop`. The token-cost win is workload-dependent but compounds in the
long-running, heavy-fire conditions dev-loop actually runs in.
