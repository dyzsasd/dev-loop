#!/usr/bin/env node
// dramalint — deterministic structural gate for vertical short-drama (竖屏短剧) episodes.
//
// The ONLY new code in the screenwriting dev-loop. It is NOT an LLM and never judges
// "is this good" — it checks mechanical facts an LLM cannot fake (hook present, episode
// length, name∈table, paywall hooked). Quality stays with the human oracle (design §0/§7).
//
// Reads a series dir: bible.md (with a ```yaml gate-config fenced block) + characters.csv
// + episodes/*.md (YAML front-matter). 4 HARD gates (exit 1 on any fail) + flag-only warns.
//
// ponytail: flat-YAML subset parser (no dependency); checks are pure functions so
//           `--self-check` runs the full assertion suite without touching the filesystem.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------- flat-YAML subset parser (scalars + flat [a, b] lists only) ----------
function parseScalar(s) {
  s = s.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}
function parseValue(s) {
  s = s.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map(parseScalar).filter((x) => x !== '');
  }
  return parseScalar(s);
}
export function parseFlatYaml(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, ''); // strip ` # comment` (space-hash; keeps mid-word '#')
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (m) out[m[1]] = parseValue(m[2]);
  }
  return out;
}

// ---------- extractors ----------
function extractFrontMatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}
function bodyAfterFrontMatter(md) {
  const first = md.indexOf('---');
  const second = md.indexOf('---', first + 3);
  return second < 0 ? md : md.slice(second + 3);
}
export function extractGateConfig(bible) {
  const m = bible.match(/```yaml gate-config\n([\s\S]*?)```/);
  return m ? parseFlatYaml(m[1]) : null;
}
export function parseCharacters(csv) {
  const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
  const set = new Set();
  if (!lines.length) return set;
  const header = lines[0].split(',').map((s) => s.trim());
  const ni = header.indexOf('name');
  const ai = header.indexOf('aliases');
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    if (ni >= 0 && cols[ni]) set.add(cols[ni].trim());
    if (ai >= 0 && cols[ai]) cols[ai].split('|').forEach((a) => a.trim() && set.add(a.trim()));
  }
  return set;
}

// ---------- body helpers ----------
const HOOK = '【钩子】';
function hookInLastBeats(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const idx = lines.findIndex((l) => l.includes(HOOK));
  return idx >= 0 && idx >= Math.floor(lines.length * 0.75);
}
// ponytail: revenge axis = a small builtin set; 甜 axis = type contains '甜'. Override path:
//   add a `revenge_types` key to gate-config later if a show needs different mapping.
const REVENGE = new Set(['打脸', '逆袭', '身份反转', '复仇']);
function axisHit(types, axis) {
  return types.some(
    (t) => t === axis || (axis === '复仇' && REVENGE.has(t)) || (axis === '甜' && String(t).includes('甜')),
  );
}
const asArr = (v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]);

// ---------- pure per-episode checks (4 hard gates, minus the season-level paywall one) ----------
export function lintEpisode(fm, body, gate, nameSet) {
  const hard = [], warn = [];
  const hook = (typeof fm.hook_out === 'string' ? fm.hook_out : '').trim();
  const hasMarker = body.includes(HOOK);
  if (!hook || !hasMarker) {
    hard.push(`hook-present: hook_out=${hook ? '有' : '空'} / 正文${HOOK}=${hasMarker ? '有' : '无'}`);
  } else if (!hookInLastBeats(body)) {
    warn.push('钩子未落末拍');
  }
  const len = fm.length_sec;
  if (typeof len !== 'number' || len < gate.length_min || len > gate.length_max) {
    hard.push(`length-bounds: length_sec=${len} 不在 [${gate.length_min},${gate.length_max}]`);
  }
  const missing = asArr(fm.characters).filter((c) => !nameSet.has(c));
  if (missing.length) hard.push(`name∈表: 表外人物 ${missing.join('/')}`);
  return { ep: fm.ep, hard, warn };
}

// ---------- pure season-level checks (paywall hard gate + flag-only warns) ----------
export function lintSeason(eps, gate) {
  const hard = [], warn = [];
  const sorted = [...eps].sort((a, b) => a.fm.ep - b.fm.ep);

  // H4 卡点有钩: the paywall boundary episode must exist and carry a hook.
  if (typeof gate.paywall_boundary_ep === 'number') {
    const pw = sorted.find((e) => e.fm.ep === gate.paywall_boundary_ep);
    if (!pw) hard.push(`卡点有钩: 缺付费卡点集 ep=${gate.paywall_boundary_ep}`);
    else if (!(typeof pw.fm.hook_out === 'string' && pw.fm.hook_out.trim())) {
      hard.push(`卡点有钩: 卡点集 ep${pw.fm.ep} 无 hook_out`);
    }
  }

  // W1 爽点密度 (flag-only)
  const w = gate.payoff_window_eps, need = gate.payoff_min_per_window;
  if (w && need) {
    for (let i = 0; i + w <= sorted.length; i++) {
      const win = sorted.slice(i, i + w);
      const total = win.reduce((n, e) => n + asArr(e.fm.payoff_types).length, 0);
      if (total < need) warn.push(`爽点密度: ep${win[0].fm.ep}–${win[w - 1].fm.ep} 仅 ${total}<${need}`);
    }
  }

  // W2 双供给两轴 (flag-only)
  const axes = asArr(gate.double_supply_axes), dw = gate.double_supply_window_eps;
  if (axes.length && dw) {
    for (let i = 0; i + dw <= sorted.length; i++) {
      const win = sorted.slice(i, i + dw);
      const types = win.flatMap((e) => asArr(e.fm.payoff_types));
      const miss = axes.filter((a) => !axisHit(types, a));
      if (miss.length) warn.push(`双供给: ep${win[0].fm.ep}–${win[dw - 1].fm.ep} 缺轴 ${miss.join('/')}`);
    }
  }

  // W3 伏笔/爽点 orphan (flag-only)
  const planted = new Map(), fired = new Map();
  for (const e of sorted) {
    asArr(e.fm.setups_planted).forEach((id) => planted.set(id, e.fm.ep));
    asArr(e.fm.payoffs_fired).forEach((id) => fired.set(id, e.fm.ep));
  }
  for (const [id, ep] of planted) if (!fired.has(id)) warn.push(`伏笔埋而未收: ${id} (埋于 ep${ep})`);
  for (const [id, ep] of fired) if (!planted.has(id)) warn.push(`爽点收而未埋: ${id} (收于 ep${ep})`);

  return { hard, warn };
}

// ---------- filesystem driver ----------
function runDir(dir) {
  const bible = readFileSync(join(dir, 'bible.md'), 'utf8');
  const gate = extractGateConfig(bible);
  if (!gate) { console.error('FAIL: bible.md 缺 ```yaml gate-config 块'); process.exit(1); }
  const nameSet = parseCharacters(readFileSync(join(dir, 'characters.csv'), 'utf8'));
  const epDir = join(dir, 'episodes');
  const files = existsSync(epDir) ? readdirSync(epDir).filter((f) => f.endsWith('.md')).sort() : [];

  const eps = [];
  let hardCount = 0;
  for (const f of files) {
    const md = readFileSync(join(epDir, f), 'utf8');
    const fmText = extractFrontMatter(md);
    if (!fmText) { console.log(`FAIL ${f}: 缺 front-matter`); hardCount++; continue; }
    const fm = parseFlatYaml(fmText);
    const r = lintEpisode(fm, bodyAfterFrontMatter(md), gate, nameSet);
    eps.push({ ep: fm.ep, fm });
    r.hard.forEach((h) => { console.log(`FAIL ep${r.ep} [${f}]: ${h}`); hardCount++; });
    r.warn.forEach((wn) => console.log(`warn ep${r.ep} [${f}]: ${wn}`));
  }
  const s = lintSeason(eps, gate);
  s.hard.forEach((h) => { console.log(`FAIL season: ${h}`); hardCount++; });
  s.warn.forEach((wn) => console.log(`warn season: ${wn}`));

  console.log(hardCount ? `\n✗ dramalint: ${hardCount} 硬门失败` : `\n✓ dramalint: 硬门全过 (${eps.length} 集)`);
  process.exit(hardCount ? 1 : 0);
}

// ---------- runnable self-check (ponytail: the one check the parser+gates must pass) ----------
function assert(cond, msg) { if (!cond) { console.error('SELF-CHECK FAIL:', msg); process.exit(1); } }
function selfCheck() {
  const p = parseFlatYaml('ep: 7\nlength_sec: 105\nhook_out: 集末"砸反派" # c\ncharacters: [A, B]\npaywall: false');
  assert(p.ep === 7 && p.length_sec === 105 && p.paywall === false, 'scalar parse');
  assert(Array.isArray(p.characters) && p.characters.length === 2 && p.hook_out === '集末"砸反派"', 'list/string parse');

  const gate = {
    length_min: 60, length_max: 120, payoff_window_eps: 2, payoff_min_per_window: 3,
    double_supply_axes: ['复仇', '甜'], double_supply_window_eps: 2, paywall_boundary_ep: 3,
  };
  const nameSet = parseCharacters('id,name,aliases\n1,Lila,Lila Gray|Miss Gray\n2,Rowan,');
  assert(nameSet.has('Lila') && nameSet.has('Miss Gray') && nameSet.has('Rowan'), 'character aliases');

  const goodBody = '7-1\n△ ...\nLila：...\n7-2\nWelcome\n' + HOOK + ' 来电';
  const good = lintEpisode({ ep: 7, length_sec: 100, hook_out: '集末来电', characters: ['Lila'] }, goodBody, gate, nameSet);
  assert(good.hard.length === 0, 'good episode should pass: ' + JSON.stringify(good.hard));

  const bad = lintEpisode({ ep: 8, length_sec: 200, hook_out: '', characters: ['Zoe'] }, '7-1\n△ no hook', gate, nameSet);
  assert(bad.hard.some((h) => h.includes('hook-present')), 'flag missing hook');
  assert(bad.hard.some((h) => h.includes('length-bounds')), 'flag bad length');
  assert(bad.hard.some((h) => h.includes('name∈表')), 'flag out-of-table name');

  const noPaywall = lintSeason([{ ep: 1, fm: { ep: 1, payoff_types: ['打脸'] } }], gate);
  assert(noPaywall.hard.some((h) => h.includes('缺付费卡点集')), 'flag missing paywall episode');

  const season = lintSeason([
    { ep: 1, fm: { ep: 1, payoff_types: ['打脸'], setups_planted: ['G1'] } },
    { ep: 2, fm: { ep: 2, payoff_types: ['逆袭'], payoffs_fired: ['G2'] } },
    { ep: 3, fm: { ep: 3, hook_out: 'x', payoff_types: ['甜'] } },
  ], gate);
  assert(season.hard.length === 0, 'paywall ep3 present+hooked → no hard: ' + JSON.stringify(season.hard));
  assert(season.warn.some((w) => w.includes('双供给')), 'warn double-supply (ep1-2 missing 甜)');
  assert(season.warn.some((w) => w.includes('伏笔埋而未收')), 'warn orphan setup G1');
  assert(season.warn.some((w) => w.includes('爽点收而未埋')), 'warn orphan payoff G2');

  console.log('✓ dramalint self-check passed');
}

// ---------- dispatch ----------
const arg = process.argv[2];
if (arg === '--self-check') selfCheck();
else if (arg) runDir(arg);
else { console.error('usage: dramalint <series-dir> | --self-check'); process.exit(2); }
