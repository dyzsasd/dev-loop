#!/usr/bin/env node
// Smooth weighted round-robin project rotation (design impl §5.3). One team-level scheduler fires each
// delivery agent on a cadence; THIS picks which enabled project that fire targets, weighted and fair.
// The same picker backs both `dev-loop run` and the Agent View `/loop` rows (via `dev-loop next-project`),
// so the two run modes share ONE cursor and never double-fire or starve a project.
//
// Algorithm = nginx's smooth WRR (deterministic): per fire, cur[k] += weight[k]; pick argmax(cur)
// (ties → lexicographically-least key); cur[pick] -= sum(weights). Weight 2:1 → A A B A A B …
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspace, wsScheduler } from "./workspace.ts";
import { deliveryProjects, isTeamProject, type Workspace } from "./team-config.ts";

export interface Candidate { key: string; weight: number }
export type CursorMap = Record<string, number>;       // projectKey → smooth-WRR current weight
export type SchedulerState = Record<string, CursorMap>; // agent → CursorMap

// The enabled, positively-weighted projects for delivery rotation, sorted by key for determinism.
export function rotationCandidates(ws: Workspace): Candidate[] {
  return Object.entries(ws.file.projects)
    .filter(([key, p]) => !isTeamProject(key) && p.enabled !== false && (p.weight ?? 1) > 0)
    .map(([key, p]) => ({ key, weight: p.weight ?? 1 }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// Steward coverage (T3.2): every ENABLED project at ANY weight, sorted. weight:0 is maintenance mode —
// delivery rotation pauses, but the stewards (sweep/ops/reflect/communication) keep covering the project;
// enabled:false removes it from both lists.
export function stewardProjects(ws: Workspace): string[] {
  return deliveryProjects(ws).filter((key) => ws.file.projects[key].enabled !== false).sort();
}

// One smooth-WRR step. Mutates + returns `cur` (pruned to the current candidate set) and the pick.
// Returns null pick when there are no candidates (caller skips the fire).
export function smoothWRRStep(candidates: Candidate[], curIn: CursorMap): { pick: string | null; cur: CursorMap } {
  if (!candidates.length) return { pick: null, cur: {} };
  // Sort by key so the argmax tie-break is deterministic regardless of the caller's input order.
  const cands = [...candidates].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  // Prune cursor entries to the current candidate set (hot-reload safety: a removed project's stale
  // cursor must not distort argmax).
  const cur: CursorMap = {};
  for (const c of cands) cur[c.key] = curIn[c.key] ?? 0;
  const total = cands.reduce((s, c) => s + c.weight, 0);
  for (const c of cands) cur[c.key] += c.weight;
  let pick = cands[0].key; // first (lexicographically least) is the tie-break winner
  for (const c of cands) if (cur[c.key] > cur[pick]) pick = c.key;
  cur[pick] -= total;
  return { pick, cur };
}

// ── cursor persistence (atomic; under <ws>/.dev-loop/team/scheduler.json) ─────
export function loadSchedulerState(ws: Workspace): SchedulerState {
  try { const j = JSON.parse(readFileSync(wsScheduler(ws), "utf8")); return j && typeof j === "object" ? j : {}; }
  catch { return {}; }
}
export function saveSchedulerState(ws: Workspace, state: SchedulerState): void {
  try {
    const f = wsScheduler(ws);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, f);
  } catch { /* a lost cursor write just means the next pick starts from 0 — never fatal */ }
}

// Pick the next project for one agent and PERSIST the advanced cursor. Pure pick is smoothWRRStep;
// this is the stateful wrapper both run-agents and `next-project` use so they share one cursor.
export function pickAndAdvance(ws: Workspace, agent: string, state: SchedulerState): string | null {
  const { pick, cur } = smoothWRRStep(rotationCandidates(ws), state[agent] ?? {});
  if (pick === null) return null;
  state[agent] = cur;
  saveSchedulerState(ws, state);
  return pick;
}

// ── `dev-loop next-project --agent <a>` — the Agent View /loop-row picker ─────
function nextProjectCli(argv: string[]): number {
  let agent = "pm";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") agent = argv[++i] ?? agent;
    else if (argv[i] === "--help" || argv[i] === "-h") { console.log("usage: dev-loop next-project --agent <agent>  # prints the next project for this agent's fire (advances the shared rotation cursor)"); return 0; }
  }
  const ws = resolveWorkspace();
  const state = loadSchedulerState(ws);
  const pick = pickAndAdvance(ws, agent, state);
  if (pick === null) { console.error("next-project: no enabled, positively-weighted project to fire"); return 1; }
  process.stdout.write(pick + "\n");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(nextProjectCli(process.argv.slice(2)));
}
