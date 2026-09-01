// Loaded via `node --import` by cli.ts for EVERY spawned entry — ONE install site at the dispatch
// boundary rather than a copy of the same catch in each entry file (LOOP-283 AC3). Two jobs, both
// strictly presentation: no verb's behaviour, exit code, or stdout changes because this ran.
//
// 1. LOOP-44 — the runtime's own ExperimentalWarning noise. Every `dev-loop` invocation opened with
//    "SQLite is an experimental feature and might change at any time" on stderr, so the CLI's
//    documented agent contract ("JSON on stdout, errors as JSON on stderr") was false on every
//    SUCCESSFUL call: `if (stderr) parse_error(stderr)` is the natural reader and it was always
//    wrong. Only the two warnings about Node's own infrastructure are dropped, by exact text —
//    a deprecation or any other warning still reaches stderr untouched.
//
// 2. LOOP-283 — a missing/broken workspace reached the operator as a 6-frame stack dump on six
//    verbs (`metrics`, `next-project`, `hub status`, `team repair`, `doc-land`, `secret list`).
//    The guidance string is already correct inside the thrown message; only the framing was lost.
//
// The error handler is deliberately NARROW: anything that is not a workspace-resolution error is
// re-thrown after de-registering, which reproduces Node's default fatal output byte-for-byte —
// stack, blank line and `Node.js v<ver>` trailer included. Swallowing a genuine internal error into
// a one-liner would be a worse regression than the bug this fixes (LOOP-283 AC4).

// ── 1. warning filter (LOOP-44) ────────────────────────────────────────────────────────────────
// Set DEVLOOP_NODE_WARNINGS=1 to restore the raw stream when diagnosing the runtime itself.
const SILENCED_WARNINGS = [
  /SQLite is an experimental feature/i, // node:sqlite — the hub's system-of-record, on every verb
  /Type Stripping is an experimental feature/i, // zero-build .ts entries — dev/source runs only
];

if (process.env.DEVLOOP_NODE_WARNINGS !== "1") {
  const originalEmitWarning = process.emitWarning.bind(process);
  type EmitWarning = typeof process.emitWarning;
  (process as { emitWarning: EmitWarning }).emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : ((warning as Error | null)?.message ?? "");
    if (SILENCED_WARNINGS.some((re) => re.test(text))) return;
    return (originalEmitWarning as unknown as (...a: unknown[]) => void)(warning, ...rest);
  }) as EmitWarning;
}

// ── 2. workspace-error framing (LOOP-283) ──────────────────────────────────────────────────────
// Matched by `name`, not `instanceof`: this module must not import workspace.ts / team-config.ts
// (they pull in node:sqlite and the whole config schema) merely to classify an error. Both classes
// set `this.name` in their constructor, and both are ours.
const WORKSPACE_ERROR_NAMES = new Set(["WsNotFound", "WsValidationError"]);

function isWorkspaceError(e: unknown): e is Error {
  return WORKSPACE_ERROR_NAMES.has((e as Error | null)?.name ?? "");
}

// `dev-loop metrics: no dev-loop.json found from <cwd> upward. Run `dev-loop team init` …`
// The verb comes from cli.ts (DEVLOOP_CLI_VERB) so the line names the command the operator typed,
// matching the shape `team import` / `worktree reap` already print.
function reportWorkspaceError(e: Error): never {
  const verb = process.env.DEVLOOP_CLI_VERB?.trim();
  console.error(`dev-loop${verb ? ` ${verb}` : ""}: ${e.message}`);
  process.exit(1);
}

// An escape that is NOT a workspace error still has to land inside the documented exit-code contract
// (0 ok · 1 domain · 2 usage · 3 doc CAS · 4 identity · 5 hub unavailable — README, `--help`, and the
// `op --help` table the cheat-sheet generator parses).
//
// Re-throwing from inside the handler did reproduce Node's fatal OUTPUT, which is what the original AC
// asked for, and it silently changed the exit code: Node answers "a handler threw" with **7**, not with
// the 1 an unhandled throw gives on its own. Measured — `node -e 'throw new RangeError()'` exits 1, the
// same script under this module exits 7 — and setting process.exitCode first does not override it. Every
// unconverged error path in the CLI therefore surfaced as a code outside the contract, which reads to a
// caller branching on exit status as a distinct KIND of failure rather than as a bug. It has cost a fix
// once already (the `conventions` verb, archived 2026-08).
//
// So the stack is printed here and the process exits 1. LOOP-283 AC4 requires that a non-workspace error
// keep its stack AND the `Node.js v…` trailer — nothing swallowed — and that is not in tension with the
// exit code: both are reproduced, so the reader loses nothing and the caller gets a code it can branch on.
// (Treating this as a trade between the two was the wrong read; only the source-line echo, which repeats
// what the stack's first frame already says, is gone.)
function reportEscape(e: unknown): never {
  console.error(e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));
  console.error(`\nNode.js ${process.version}`);
  process.exit(1);
}

const onUncaught = (e: unknown): void => {
  if (isWorkspaceError(e)) reportWorkspaceError(e);
  process.removeListener("uncaughtException", onUncaught);
  reportEscape(e);
};

const onRejection = (reason: unknown): void => {
  if (isWorkspaceError(reason)) reportWorkspaceError(reason);
  process.removeListener("unhandledRejection", onRejection);
  reportEscape(reason);
};

process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onRejection);
