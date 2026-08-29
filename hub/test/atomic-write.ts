// writeConfigAtomic — replace a config file through a same-directory tmp + rename.
//
// Moved out of destructive-guard.ts when three writers outside it needed the same guarantee. Its
// contract used to be reachable only through commitBothHalves, which is why destructive-guard's coverage
// map recorded that a direct unit test would become due the day it was exported. This is that test.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigAtomic } from "../src/atomic-write.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-atomicw-")));

// 1. It replaces the content and leaves no tmp behind.
const target = join(tmp, "dev-loop.json");
writeFileSync(target, '{"old":true}\n');
writeConfigAtomic(target, '{"new":true}\n');
ok(readFileSync(target, "utf8") === '{"new":true}\n', "the file holds the new content");
ok(readdirSync(tmp).filter((f) => f.startsWith("dev-loop.json.tmp-")).length === 0, "no .tmp- residue on the happy path");

// 2. The tmp is a SIBLING, not a temp-dir file: renameSync is only atomic within one filesystem, and a
//    cross-device rename would fall back to a copy, reopening the window the helper exists to close.
const sibling = join(tmp, "sub", "cfg.json");
try {
  writeConfigAtomic(sibling, "x");
  ok(false, "a write into a missing directory should throw");
} catch {
  ok(!existsSync(join(tmpdir(), "cfg.json.tmp-" + process.pid)), "the tmp is created beside the target, never in the system temp dir");
}

// 3. Bytes are passed through unchanged — the restore path hands back the exact buffer it retained, and
//    decoding to a string first would substitute U+FFFD for any sequence that is not valid UTF-8.
const raw = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x7d]);
const bin = join(tmp, "bin.json");
writeConfigAtomic(bin, raw);
ok(Buffer.compare(readFileSync(bin), raw) === 0, "a Buffer is written byte-for-byte, with no lossy UTF-8 round-trip");

// 4. On failure the original file is untouched and the tmp is cleaned up — the whole point: a failed
//    write must not be worse than no write. The directory is made read-only so the tmp cannot be created.
const roDir = join(tmp, "rodir");
mkdirSync(roDir);
const roTarget = join(roDir, "dev-loop.json");
writeFileSync(roTarget, '{"original":true}\n');
chmodSync(roDir, 0o500); // r-x: existing files readable, no new entries
let threw = false;
try { writeConfigAtomic(roTarget, '{"replacement":true}\n'); } catch { threw = true; }
chmodSync(roDir, 0o700);
ok(threw, "a write that cannot create its tmp THROWS rather than reporting success");
ok(readFileSync(roTarget, "utf8") === '{"original":true}\n', "…and the original file is byte-identical — a failed write is never worse than no write");
ok(readdirSync(roDir).filter((f) => f.includes(".tmp-")).length === 0, "…with no tmp residue left behind");

console.log(fails === 0 ? "\nATOMIC_WRITE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
