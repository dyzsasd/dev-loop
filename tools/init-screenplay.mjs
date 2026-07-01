#!/usr/bin/env node
// init-screenplay — one-shot bootstrap for a short-drama (竖屏短剧) dev-loop project.
//
// Does all the MECHANICAL setup the getting-started guide used to make you do by hand:
//   1. scaffold the series dir from templates (bible / characters / grid / episodes/)
//   2. write (merge, non-destructive) the projects.json entry — backend, devSplit,
//      agentFamily:"screenwriting", repoPath, strategyDoc, dramalint test command
//   3. seed the per-project lessons.md (with the reflect redirect rule)
//   4. print a readiness checklist + the exact next commands (incl. the Codex run)
//
// It does NOT fill the bible (that's your creative 立项 work) and NOT provision a
// service board (that's `dev-loop init-service`, printed for you when --backend service).
// Idempotent + non-destructive: never overwrites an existing bible / characters / grid /
// projects.json entry / lessons.md — it scaffolds only what's missing.
//
// Usage:
//   node tools/init-screenplay.mjs <key> "<Show Name>" <PREFIX> <seriesDir> [--backend local|service] [--data <dir>]
//   node tools/init-screenplay.mjs --self-check
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATES = join(PLUGIN_ROOT, 'templates', 'screenwriting');
const DRAMALINT = join(PLUGIN_ROOT, 'tools', 'dramalint.mjs');

// Copy a template file into dest only if dest is missing. Returns "created" | "kept".
function copyIfAbsent(srcName, destPath) {
  if (existsSync(destPath)) return 'kept';
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(join(TEMPLATES, srcName), destPath);
  return 'created';
}

// Core, pure-ish bootstrap. Returns a summary object (no console output) so --self-check can assert.
export function scaffold({ key, name, prefix, seriesDir, backend = 'local', dataDir }) {
  const out = { key, name, prefix, seriesDir: resolve(seriesDir), backend, dataDir, notes: [] };

  // 1. series dir
  mkdirSync(out.seriesDir, { recursive: true });
  mkdirSync(join(out.seriesDir, 'episodes'), { recursive: true });
  out.bible = copyIfAbsent('bible.md', join(out.seriesDir, 'bible.md'));
  out.characters = copyIfAbsent('characters.csv', join(out.seriesDir, 'characters.csv'));
  out.grid = copyIfAbsent('grid.csv', join(out.seriesDir, 'grid.csv'));
  copyIfAbsent('episode-TEMPLATE.md', join(out.seriesDir, 'episode-TEMPLATE.md'));

  // 2. projects.json (merge, never clobber an existing key or sibling projects)
  const projectsPath = join(dataDir, 'projects.json');
  let cfg = { projects: {} };
  if (existsSync(projectsPath)) {
    try { cfg = JSON.parse(readFileSync(projectsPath, 'utf8')); } catch { /* leave default; we won't clobber below */ }
    if (!cfg.projects) cfg.projects = {};
  }
  if (cfg.projects[key]) {
    out.project = 'kept';
    out.notes.push(`projects.json already has '${key}' — left untouched.`);
  } else {
    const entry = {
      backend,
      devSplit: true,
      agentFamily: 'screenwriting',
      ticketPrefix: prefix,
      repoPath: out.seriesDir,
      strategyDoc: 'bible.md',
      mode: 'dry-run',
      autonomy: 'ask',
      testEnv: {
        testCommand: `node ${DRAMALINT} ${out.seriesDir}`,
        notes: '无 web surface；测一集 = dramalint 结构门。品味归人类监制（pm 队列）。',
      },
    };
    if (backend === 'service') entry.hub = { db: null, docs: false, transport: 'daemon' };
    cfg.projects[key] = entry;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(projectsPath, JSON.stringify(cfg, null, 2) + '\n');
    out.project = 'created';
  }
  out.projectsPath = projectsPath;

  // 3. seed lessons.md (reflect redirect rule + writer sections)
  const lessonsPath = join(dataDir, key, 'lessons.md');
  out.lessons = copyIfAbsent('lessons.md', lessonsPath);
  out.lessonsPath = lessonsPath;

  return out;
}

function printReadiness(s) {
  const mark = (st) => (st === 'created' ? '✓ 新建' : '• 已存在(保留)');
  console.log(`\nshort-drama init — project '${s.key}' (${s.name})  backend=${s.backend}\n`);
  console.log(`${mark(s.bible)}  series:   ${s.seriesDir}`);
  console.log(`            bible.md / characters.csv / grid.csv / episodes/`);
  console.log(`${mark(s.project)}  config:   ${s.projectsPath}  → projects.${s.key} (mode:dry-run, agentFamily:screenwriting)`);
  console.log(`${mark(s.lessons)}  lessons:  ${s.lessonsPath}  (reflect 重定向规则已 seed)`);
  s.notes.forEach((n) => console.log(`   note: ${n}`));

  console.log(`\n下一步：`);
  console.log(`  1) 填创意（人的活）：编辑 ${join(s.seriesDir, 'bible.md')} 的每个 <…> 占位 + gate-config 阈值；`);
  console.log(`     在 ${join(s.seriesDir, 'characters.csv')} 填主角行（voice_signature / secret_setup）。`);
  console.log(`  2) git：  cd ${s.seriesDir} && git init && git add -A && git commit -m "init series"`);
  if (s.backend === 'service') {
    console.log(`  3) 起看板（service）：  dev-loop init-service ${s.key} "${s.name}" ${s.prefix}  &&  dev-loop daemon up`);
  } else {
    console.log(`  3) 本地后端无需起看板（board 自动建在 ${join(s.dataDir, s.key, 'board')}）。`);
  }
  const DL = PLUGIN_ROOT;
  console.log(`  4) 预览（Codex，dry-run，不动看板）：`);
  console.log(`     node ${join(DL, 'hub/src/run-agents.ts')} --cli codex --once --dry-run --codex-safe \\`);
  console.log(`       --agents senior-dev,junior-dev,qa --dev-split --project ${s.key} --root ${DL}`);
  console.log(`     期望看到 skill=story-architect-agent / screenwriter-agent / screenplay-editor-agent`);
  console.log(`  5) 把 ${s.projectsPath} 里 '${s.key}' 的 mode 改成 "live"，然后逐步：`);
  console.log(`     senior-dev(设计) → 监制过设计门 → junior-dev(写集) → 监制过品味门 → qa(机检/抽取)`);
  console.log(`\n地板机器，不是爆款机器：人是唯一品味裁判。`);
}

function selfCheck() {
  const assert = (c, m) => { if (!c) { console.error('SELF-CHECK FAIL:', m); process.exit(1); } };
  const root = mkdtempSync(join(tmpdir(), 'init-screenplay-'));
  const seriesDir = join(root, 'series-test');
  const dataDir = join(root, 'data');

  const s = scaffold({ key: 'testshow', name: 'Test Show', prefix: 'TS', seriesDir, dataDir, backend: 'local' });
  assert(existsSync(join(seriesDir, 'bible.md')), 'bible scaffolded');
  assert(existsSync(join(seriesDir, 'characters.csv')) && existsSync(join(seriesDir, 'grid.csv')), 'csvs scaffolded');
  assert(existsSync(join(seriesDir, 'episodes')), 'episodes dir');
  const cfg = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8'));
  assert(cfg.projects.testshow.agentFamily === 'screenwriting', 'agentFamily set');
  assert(cfg.projects.testshow.repoPath === resolve(seriesDir), 'repoPath absolute');
  assert(cfg.projects.testshow.backend === 'local' && cfg.projects.testshow.devSplit === true, 'backend/devSplit');
  assert(readFileSync(join(dataDir, 'testshow', 'lessons.md'), 'utf8').includes('## screenwriter'), 'lessons seeded with writer section');

  // idempotent + non-destructive: edit bible + add a sibling project, re-run, assert nothing clobbered
  writeFileSync(join(seriesDir, 'bible.md'), 'MY EDITED BIBLE\n');
  const cfg2 = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8'));
  cfg2.projects.othershow = { backend: 'local' };
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify(cfg2, null, 2));
  const s2 = scaffold({ key: 'testshow', name: 'Test Show', prefix: 'TS', seriesDir, dataDir, backend: 'local' });
  assert(s2.bible === 'kept' && s2.project === 'kept', 're-run keeps existing bible + project');
  assert(readFileSync(join(seriesDir, 'bible.md'), 'utf8') === 'MY EDITED BIBLE\n', 'edited bible NOT clobbered');
  const cfg3 = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8'));
  assert(cfg3.projects.othershow && cfg3.projects.testshow, 'sibling project preserved on merge');

  console.log('✓ init-screenplay self-check passed');
}

// ---- dispatch ----
const argv = process.argv.slice(2);
if (argv[0] === '--self-check') {
  selfCheck();
} else {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backend') flags.backend = argv[++i];
    else if (argv[i] === '--data') flags.data = argv[++i];
    else pos.push(argv[i]);
  }
  const [key, name, prefix, seriesDir] = pos;
  if (!key || !name || !prefix || !seriesDir) {
    console.error('usage: node tools/init-screenplay.mjs <key> "<Show Name>" <PREFIX> <seriesDir> [--backend local|service] [--data <dir>]');
    console.error('       node tools/init-screenplay.mjs --self-check');
    process.exit(2);
  }
  const backend = flags.backend ?? 'local';
  if (!['local', 'service'].includes(backend)) { console.error(`--backend must be local|service (got ${backend})`); process.exit(2); }
  const dataDir = flags.data ?? process.env.DEVLOOP_DATA_DIR ?? join(homedir(), '.dev-loop');
  printReadiness(scaffold({ key, name, prefix, seriesDir, backend, dataDir }));
}
