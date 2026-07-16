# Model provider routing for agent fires — opencode-first

Status: **proposed** (design review — no code yet). Target: **1.3.0**. Date: 2026-07-16 (rev 3).

Decision trail (operator, 2026-07-16):
1. ZCode/GLM research ran; Track A ("agents on GLM") accepted — **not GLM-only**, provider must be
   operator-selectable (OpenRouter etc. first-class).
2. The registry belongs in **team-level** config; the API-based long tail should ride **opencode**.
3. Final: the goal is *other model providers*, and **opencode is the vehicle**. ZCode is dropped from the
   1.3.0 goal (upstream watch-list only — re-evaluate if it ships a headless CLI). The claude-runner
   env-injection route is **deferred** to Appendix A (its verified research is preserved there).

## Problem

The launch system is two-level (`hub/src/run-agents.ts:41`): level 1 picks the coding agent
(`claude`/`codex`/`opencode`), level 2 picks model + effort. The model *endpoint* is implicit — claude
fires hit Anthropic, codex fires hit OpenAI. There is no way to point an agent at GLM, OpenRouter, DeepSeek,
a local model, or any OpenAI-compatible API, short of global env exports that flatten every fire.

opencode already solves the provider axis natively: 75+ providers via AI SDK + models.dev (incl. Zhipu/GLM
Coding Plan, OpenRouter, DeepSeek, Moonshot, MiniMax, Ollama/local), custom OpenAI-compatible endpoints via
one config block, `{env:VAR}` key indirection, and model strings that carry the provider
(`provider-id/model-id`). dev-loop already recognizes opencode as a runner (`run-agents.ts:33`) and passes
`--model` (`:623`) — but the lane is uncertified (PORTABILITY §5), effort is not passed (`:619`), custom
providers have no story, and unattended permissions are unsolved. 1.3.0 closes exactly that gap.

**Key simplification** (vs rev 2): on opencode the model string *is* the provider selection —
`"openrouter/moonshotai/kimi-k2.5"` — so multi-provider needs **no new selection field** in launch config.
The existing per-agent `codingAgent`/`model`/`effort` config already expresses everything; what's missing
is runway, not schema.

## What 1.3.0 ships

### 0. Certification (the gate — Phase 0)

The P8-style ceremony (PORTABILITY §3/§7, template: the Codex §4 certification of 2026-07-11) on a pinned
opencode version — local install is `1.2.24` (`~/.opencode/bin/opencode`):

- identity through the spawned shell (`dev-loop identity-check` inside a fire-shaped `opencode run`) —
  passing flips `hub.agentInterface.opencode` default from `"mcp"` to `"cli"`, mirroring codex P8;
- `OPENCODE_PERMISSION` coverage: does the injected permission JSON alone make a fire fully unattended,
  or is `--auto` also required?
- dry-run fire renders correctly; read-only board call succeeds.

Everything below ships behind this certification; PORTABILITY §5 is rewritten as a certified section.

### 1. Team-level registry for custom endpoints

`team.providers{}` in `<workspace>/dev-loop.json`, next to `team.codingAgentDefaults`
(`hub/src/team-config.ts:36`). Providers are team infrastructure — same class as `team.backend` and
`team.comms`, and the repo-registry philosophy: registered once, referenced by many projects. Projects
select models; they never define endpoints.

**Built-in opencode providers need no registry entry** — OpenRouter, Zhipu/GLM Coding Plan (dedicated
connect option), DeepSeek, Moonshot etc. just need auth (key in `<workspace>/.dev-loop/secrets.env` or
`opencode auth login`) plus the model string. The registry exists for **custom OpenAI-compatible
endpoints** (LiteLLM, Synthetic-style gateways, self-hosted):

```jsonc
// <workspace>/dev-loop.json
{
  "team": {
    "providers": {
      "synthetic": {
        "kind": "openai-compatible",
        "baseUrl": "https://api.synthetic.new/v1",
        "authTokenEnv": "SYNTHETIC_KEY",                 // name only; value in secrets.env (PORTABILITY §1)
        "models": ["hf:zai-org/GLM-5", "hf:deepseek-ai/DeepSeek-V4"]
      }
    }
  },
  "projects": {
    "web": {
      "agents": {
        "pm":         { "codingAgent": "claude" },                                        // unchanged
        "senior-dev": { "codingAgent": "opencode", "model": "zhipuai/glm-5.2", "effort": "max" },
        "junior-dev": { "codingAgent": "opencode", "model": "openrouter/moonshotai/kimi-k2.5" },
        "qa":         { "codingAgent": "opencode", "model": "synthetic/hf:zai-org/GLM-5" }
      }
    }
  }
}
```

Entry fields: `kind` (`"openai-compatible"`; `"anthropic"` reserved for Appendix A), `baseUrl`,
`authTokenEnv`, `models` (catalog rendered into opencode's provider block), `extraOptions` (escape hatch →
opencode `options`), `effortMode` (`"passthrough"` default / `"strip"`).

### 1a. Choosing a provider and model (operator reference)

Where to browse what's available — these are the ids that go into `agents{}.model`:

- **[models.dev](https://models.dev)** — the canonical catalog opencode resolves ids from: every provider
  and model id, with context windows and pricing. Start here to pick.
- **[opencode.ai/docs/providers](https://opencode.ai/docs/providers/)** — per-provider setup/auth
  specifics (OpenRouter, Zhipu/GLM Coding Plan, DeepSeek, Moonshot, local Ollama/LM Studio, …).
- **[opencode.ai/docs/models](https://opencode.ai/docs/models/)** — model-selection mechanics
  (`provider/model` format, variants).
- Locally (verified on 1.2.24): **`opencode models`** prints every id usable with the current
  auth/config — exactly the strings `agents{}.model` accepts; **`opencode auth list`** shows which
  providers have credentials (stored or via env). These two commands + the registry are the whole
  selection workflow. (The docs sweep carries this list into RUNNING.md.)

### 2. Config generation: `dev-loop team sync-opencode`

Renders registry entries into the **workspace** `opencode.json` `provider` block (opencode: project config
merges over global): `{ npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey: "{env:VAR}" },
models: {…} }` — `authTokenEnv` maps 1:1 to opencode's `{env:VAR}` indirection. Create-or-merge, never
clobber (posture of `provisionClaudePermissions`, `hub/src/team-init.ts:179`); the existing MCP template
(`config/mcp.opencode.json.example`) folds into the same merge. **Never** touch the operator's global
`~/.config/opencode/opencode.json` — real installs carry personal setups (oh-my-opencode etc.).
Run by `team init`/`add-project` when registry entries exist; drift re-sync surfaced by doctor.

### 3. Effort: `--variant`

`opencode run --variant <effort>` when the resolved profile has one — replacing the 1.2.0 "effort is NOT
auto-passed" caveat (`run-agents.ts:619`). Values pass through raw (variant semantics are model-specific;
`normalizeEffort`'s codex clamp does not apply). `effortMode:"strip"` opts a provider out. Empirical
per-provider behavior lands during certification.

### 4. Unattended permissions: `OPENCODE_PERMISSION`

Per-fire env injection of the rendered allowlist — the scheduler-injectable analogue of the
`.claude/settings.json` `Bash(dev-loop *)` provisioning:

```json
{ "bash": { "dev-loop *": "allow", "git *": "allow", "gh *": "allow", "*": "ask" }, "edit": "allow" }
```

Exact policy is operator-tunable (team block), default assembled from the same permission set the claude
provisioning grants. `--auto` is the codex-bypass analogue if certification shows the env alone is
insufficient. Note: opencode denies `.env` reads by default — irrelevant here, `secrets.env` is read by the
`dev-loop` CLI process, never by the agent.

### 5. Doctor + metrics

- Doctor (next free W-slots, W12 pattern): opencode binary present + version matches the certified pin;
  every registry `authTokenEnv` resolvable (secrets.env / process env); workspace `opencode.json` in sync
  with the registry (offer `sync-opencode`); referencing an unknown provider prefix in an opencode agent's
  model string ⇒ warn (built-in providers can't be enumerated statically — the dry-run fire is the real
  check).
- Pre-spawn fail: a fire whose registry provider's env var is unresolvable writes ledger error
  `provider-env-missing` and never spawns — zero tokens, visible on the board digest.
- Metrics: fire-ledger + `fires.jsonl` records gain `provider` (parsed from the opencode model-string
  prefix; `anthropic`/`openai` natively for claude/codex) — `dev-loop metrics --context` groups the bill
  by provider, giving the pending CLI-first step-7 measurement its cost dimension.

## Back-compat, security, testing

- No opencode agents configured ⇒ rendered commands and env **byte-identical** to 1.2.0 (parity snapshot
  test).
- Secrets: env-name indirection only; `dev-loop.json` never holds a secret (PORTABILITY §6 unchanged);
  injection scopes to the fire's child process.
- `test/provider-routing.ts`: registry validation, `opencode.json` render + create-or-merge idempotence
  (incl. never-touch-global), `--variant` command assembly, `OPENCODE_PERMISSION` rendering, model-string
  provider parse for metrics, pre-spawn fail path, dry-run rendering, doctor checks, 1.2.0-parity snapshot.
- Docs: config-schema.md team table (+`providers`), RUNNING.md launch resolution (~:236), PORTABILITY §5
  certified rewrite, conventions §11 pointer.

## Rollout

1. **Phase 0** — certification on opencode `1.2.24` (installed locally); flip
   `hub.agentInterface.opencode` per result; record the ceremony in PORTABILITY like Codex P8.
2. **Phase 1** — registry + `sync-opencode` + `--variant` + `OPENCODE_PERMISSION` + doctor + metrics +
   tests + docs.
3. **Phase 2 (deferred, optional)** — Appendix A claude-runner injection (zai/openrouter presets,
   verified); codex `model_providers` rendering.

Acceptance for 1.3.0: one real project runs ≥2 opencode-routed providers (e.g. GLM Coding Plan +
OpenRouter) for a week; `fires.jsonl` cost report by provider vs the anthropic baseline.

## Out of scope

- ZCode as a runner or plugin target — watch-list only (headless CLI, Bot-Channel webhook, scheduled
  goals, project-level subagents, plugin manifest spec; see the 2026-07-16 research notes).
- Bundling/managing proxies; per-provider failover/rate limiting; opencode `serve`/`--attach` server mode.

## Open questions — certification results (2026-07-16, opencode 1.2.24)

Phase 0 ran; see PORTABILITY §5 for the full ceremony record.

1. ~~`--variant` flag~~ — **accepted on 1.2.24** (exit 0); per-model semantics still vary — `effortMode`
   stays per-provider config.
2. ~~`OPENCODE_PERMISSION` sufficiency~~ — **honored on 1.2.24**, and 1.2.24 has no `--auto`; the injected
   policy MUST be **wildcard-deny based** (`{"*":"deny", …explicit allows}`): a narrow `{"bash":…}` overlay
   was escaped by an operator-installed `interactive_bash` (tmux) tool which ALSO dropped the identity env.
   `OPENCODE_CONFIG` does NOT isolate from global agent overlays — permission env is the isolation
   mechanism; prompt-surface overlays remain an operator caveat.
3. GLM Coding Plan's exact opencode provider id + endpoint — still open; verify with a real plan key
   before documenting it as the GLM recipe.
4. ~~Flip `hub.agentInterface.opencode` default~~ — **yes**: identity certified through the bash tool;
   Phase 1 flips the default to `"cli"` (mcp stays as the rollback setting).

---

## Appendix A (deferred): claude-runner Anthropic-compatible injection

Preserved from rev 2 — verified research, shippable later as Phase 2 without redesign. Swaps the endpoint
under the unchanged Claude Code harness via per-fire env injection in `runAgent()` (`run-agents.ts:744`,
after the `...process.env` spread), for `kind:"anthropic"` registry entries:
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (from `authTokenEnv`; missing ⇒ pre-spawn fail),
`ANTHROPIC_API_KEY=""` when `blankApiKey`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` backstops,
`API_TIMEOUT_MS`. A `modelAliases` map translates resolved model strings (incl. the full Claude IDs the
built-in role defaults pin — `claude-opus-4-8` → `glm-5.2`). Selection would add `provider?` to
`AgentLaunchConfig`/`LaunchProfile` on the existing precedence chain. Verified presets:
`zai` (`https://api.z.ai/api/anthropic`, tier-mapping envs documented) and `openrouter`
(`https://openrouter.ai/api` Anthropic Skin + blank `ANTHROPIC_API_KEY`; thinking + native tool use pass
through). Candidates to verify: `zai-cn` (`open.bigmodel.cn`), `kimi`, `deepseek`, `minimax`.
`--effort` passes through (`:588`); per-endpoint behavior empirical.
