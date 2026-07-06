# Development

This repository publishes the `@dyzsasd/dev-loop` npm package from the `hub/` package directory, while the root holds the canonical README, docs, skills, references, hooks, and plugin metadata.

## Prerequisites

- Node.js **23.6 or newer**. CI runs Node `23.6.0` and `24`.
- `npm`.
- `rg` is recommended for local search.

## Local Setup

```bash
cd hub
npm ci
```

Most commands run from `hub/`:

```bash
npm run typecheck
npm test
npm run build
```

`npm run build` compiles `hub/src` into `hub/dist` and copies the root plugin payload (`.claude-plugin/`, `skills/`, `references/`, `hooks/`, `config/`) into `hub/` for packaging. Those copied trees are build output; edit the root copies, then rebuild.

## Common Checks

```bash
cd hub
npm run typecheck
npm test
node dist/cli.js --help
node dist/cli.js run --help
```

The full test chain is intentionally broad. For a focused doc or packaging change, at minimum run the touched focused suite plus `npm run typecheck`; before release or broad docs/CLI changes, run full `npm test`.

## Documentation Rules

- Root `README.md`, `README.zh-CN.md`, `README.fr.md`, and `hub/README.md` should stay aligned on the public quick start.
- `docs/RUNNING.md` is the current operational guide.
- `docs/DAEMON.md` documents the low-level daemon surface; normal workspace users should see `dev-loop hub start|stop|status|ensure`.
- `docs/HUB-ARCHITECTURE.md` and most files under `docs/design/` are design records. Preserve them as history, but add status notes when current commands or guarantees moved.

## Release Flow

Do not publish from a local terminal. Use the GitHub Actions workflow documented in [`RELEASING.md`](RELEASING.md).
