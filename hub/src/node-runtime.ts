import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const MIN_NODE_VERSION = "23.6.0";

export function nodeVersionOk(v = process.versions.node): boolean {
  const [maj = 0, min = 0, patch = 0] = v.split(".").map((x) => Number(x));
  return maj > 23 || (maj === 23 && (min > 6 || (min === 6 && patch >= 0)));
}

function probeNode(bin: string): { bin: string; version: string } | null {
  const r = spawnSync(bin, ["-p", "process.versions.node"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const version = (r.stdout ?? "").trim();
  return r.status === 0 && version && nodeVersionOk(version) ? { bin, version } : null;
}

function pathCandidates(names: string[]): string[] {
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

export function findCompatibleNode(extra: Array<string | undefined> = []): string | null {
  const candidates = [
    process.env.DEVLOOP_NODE,
    ...extra,
    process.execPath,
    ...pathCandidates(["node", "node24", "node23"]),
    "/opt/homebrew/opt/node@24/bin/node",
    "/opt/homebrew/opt/node@23/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/opt/node@24/bin/node",
    "/usr/local/opt/node@23/bin/node",
    "/usr/local/bin/node",
  ].filter((x): x is string => !!x);

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const ok = probeNode(c);
    if (ok) return ok.bin;
  }
  return null;
}
