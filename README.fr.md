# dev-loop

[English](README.md) · [中文](README.zh-CN.md) · **Français**

**Dix agents activables qui construisent, améliorent, surveillent et racontent un logiciel en faisant avancer les tickets dans une machine à états partagée.** Vous écrivez l'intention dans un document de stratégie, puis vous relisez le résultat. Les agents proposent le travail, l'implémentent, le vérifient, le livrent, et réinjectent ce qu'ils ont appris dans le tour suivant. C'est le *loop engineering* : moins de prompts à la main, davantage d'un système qui sait continuer à avancer.

Les agents ne s'appellent pas entre eux. **Le tableau est l'unique canal** : chaque agent lit et écrit l'état des tickets, ainsi que git, ce qui permet aux exécutions de se faire dans n'importe quel ordre, voire en parallèle. Les labels portent les faits opérationnels : éligibilité, propriétaire, routage et niveau de dev.

```
        PM ──proposes feature──┐                 ┌──QA proposes bug──┐
                               ▼                 ▼                   │
   strategy doc ──►  [Todo] ◄────────── grooming / unblock ─────────┘
                       │
        Dev claims ────┼──► [In Progress] ──ships──► [In Review]
                       │                                  │
            (dup/blocked)                    owner verifies (PM↔feature, QA↔bug)
                       ▼                          │            │
                 [Canceled/Duplicate]          pass▼        fail▼
                                               [Done]    back to [Todo]
```

---

## Table des matières

- [Qu'est-ce que c'est](#quest-ce-que-cest) · [Architecture](#architecture--trois-couches) · [Comment ça fonctionne](#comment-ça-fonctionne)
- [Les agents](#les-agents) — l'effectif au complet
- [Les workflows](#les-workflows) — comment les agents se combinent réellement
- [Cas d'usage](#cas-dusage) — quand (et quand ne pas) y recourir
- [Démarrage rapide](#démarrage-rapide) · [Prérequis](#prérequis) · [Installation](#installation) · [Configuration](#configuration)
- [Configurer un projet](#configurer-un-projet) · [Lancer la boucle](#lancer-la-boucle)
- [Backends](#backends) · [Périmètre de sécurité](#périmètre-de-sécurité) · [Auto-évolution](#auto-évolution)
- [Rapports et revue de l'opérateur (点评)](#rapports-et-revue-de-lopérateur-点评) · [Codex (optionnel)](#intégration-codex-optionnelle)
- [Publication](#publication) · [Documentation approfondie](#documentation-approfondie) · [Statut](#statut)

---

## Qu'est-ce que c'est

dev-loop est un **plugin Claude Code** composé d'agents spécialisés par rôle : Product Manager, QA, Développeur(s), et quelques coordinateurs. Avec un petit jeu de conventions, ils peuvent dérouler un cycle de développement logiciel complet **sans humain dans la boucle interne**. Vous fournissez le produit, le document de stratégie et les réglages d'autonomie ; la boucle transforme cela en incréments livrés, vérifiés, puis consigne ce qu'elle a appris.

Elle est volontairement **agnostique vis-à-vis du substrat**. La coordination peut passer par **Linear** par défaut, par un **tableau sur fichiers local à la machine**, ou par un **hub local** : un système de référence MCP au-dessus de `node:sqlite`, avec identité par agent et web UI en localhost. Les agents et les protocoles restent les mêmes.

Trois règles restent vraies partout :
- **Le tableau est le canal** — les agents se passent le relais par l'état des tickets, pas par des appels directs.
- **Chaque exécution repart du réel** — les agents sont sans état ; ils relisent le tableau, git et le disque à chaque fois, donc un crash, un redémarrage ou une compaction du contexte ne corrompt pas la boucle.
- **L'autonomie repose sur des garde-fous, pas sur des prompts** — sous `autonomy:"full"`, les agents décident et agissent, mais un build rouge n'est jamais livré, un déploiement raté déclenche un rollback, et une décision réellement réservée à l'humain reste consignée sur le ticket au lieu de devenir un prompt interactif.

## Architecture — trois couches

dev-loop, c'est trois couches ; le paquet `npm i -g @dyzsasd/dev-loop` les livre toutes les trois :

1. **Interface — la CLI `dev-loop` + le MCP.** La surface d'opération. La commande `dev-loop` (`serve` · `run` · `daemon` · `doctor` · `init-service` · `mcp-merge` · `seed` · …) est la façon dont *vous* pilotez la configuration et la planification ; le serveur **MCP** `dev-loop-hub` est la façon dont les *agents* lisent et écrivent. Les deux sont de simples clients légers au-dessus du hub.
2. **Hub — le service backend.** Un système de référence local au-dessus de `node:sqlite` (le backend `service`) qui alimente le **système de tickets** et le **système de documents** (stratégie/feuille de route/design, versionnés), et maintient l'**espace de noms par projet** — le tableau, les acteurs et les documents de chaque projet sont isolés. Il tourne comme un démon localhost avec une web UI en lecture seule. *(Linear ou un tableau sur fichiers local à la machine sont des backends de tickets alternatifs ; le hub est celui qui ajoute l'identité par agent, le système de documents et l'espace de noms.)*
3. **Agents — skills + plugin + scheduler.** Les agents spécialisés par rôle sont un ensemble de **SKILLs** (empaquetés en tant que **plugin** Claude) plus le **scheduler** (`dev-loop run`). Vous démarrez la boucle de deux façons : le scheduler `dev-loop run` (**Mode B**), ou la propre commande de boucle de Claude/Codex contre le plugin installé (**Mode A**, par ex. `/loop 5m /dev-loop:pm-agent`). Voir [Installation](#installation).

## Comment ça fonctionne

- **Les labels de propriétaire routent le travail.** `pm` possède les Features et `qa` possède les Bugs. Le **propriétaire dépose et vérifie** ; Dev implémente les tickets des deux côtés. C'est ainsi qu'un build terminé revient à la personne qui doit le valider.
- **Un seul label fait office de pare-feu.** Les agents ne touchent **qu'**aux tickets portant le label `dev-loop`, circonscrits au projet configuré — jamais à votre backlog humain.
- **La boucle s'améliore prudemment.** `reflect-agent` étudie le comportement de la boucle et entretient un `lessons.md` par opérateur, lu par chaque agent à l'exécution suivante. Il peut éditer ce fichier de façon autonome, mais ne réécrit **jamais** les instructions des agents eux-mêmes ; les changements structurels sont proposés à un humain.
- **Vous pilotez par la revue.** Les agents écrivent des rapports quotidiens, hebdomadaires et mensuels. Ajoutez un **点评 (revue/critique de l'opérateur)** à côté de l'un d'eux, et l'agent le distille en une règle `lessons.md` qu'il respecte ensuite.

---

## Les agents

Cinq agents **internes** (tournés vers la construction), un **Dev à deux niveaux** activé par défaut, trois agents **externes**, et une commande de **setup** ponctuelle. Chaque agent lit d'abord [`references/conventions.md`](references/conventions.md) — la machine à états complète, la taxonomie des labels, les modèles de tickets et les protocoles.

### Interne — la boucle de construction

| Agent | Rôle |
|---|---|
| **`pm-agent`** | Lit le document de stratégie, met à l'épreuve le produit réel, dépose des tickets **Feature**, propose des améliorations de façon proactive, **vérifie** les fonctionnalités qui atteignent `In Review`, débloque ses propres tickets bloqués, et maintient le document de stratégie à jour. Route chaque ticket vers un niveau de dev lorsque le Dev à deux niveaux est activé. |
| **`qa-agent`** | Exécute des tests de chemin nominal + cas limites dans l'environnement de test configuré, dépose des tickets **Bug** (et `drift` → Improvement), **re-teste** les bugs en `In Review`, route chaque ticket déposé vers un niveau de dev, et lève les blocages pour manque d'information au profit de Dev. |
| **`dev-agent`** | Repli historique en Dev unique. Tire les tickets `Todo`, implémente, conditionne au build/test, relit son diff, livre selon la config et passe le relais en `In Review`. À utiliser seulement avec `devSplit:false` / `--agents legacy`; la boucle `core` par défaut utilise senior-dev + junior-dev. |
| **`sweep-agent`** | Agent d'entretien du cycle de vie (cadence plus lente). Répare les fissures : labels de propriétaire ou de **dev-tier** manquants/erronés (invisibles à toute requête → à l'abandon), `In Progress` orphelins issus d'exécutions plantées, signaux périmés, rapports de santé du tableau. Sur le backend hub, il exécute aussi le push optionnel du **miroir Linear unidirectionnel**. Hygiène uniquement. |
| **`reflect-agent`** | Rétrospective + auto-évolution (quotidien). Étudie le comportement **propre** de la boucle et entretient `lessons.md` à partir de motifs récurrents, étayés par des preuves. Observe + entretient uniquement ; ne peut éditer de façon autonome que `lessons.md` — les changements structurels sont rédigés sous forme de propositions, jamais appliqués automatiquement. |

### Dev à deux niveaux — par défaut

Le Dev unique est scindé en un responsable de conception et un implémenteur, afin que le modèle coûteux se concentre sur l'architecture et que le moins cher fasse le gros du code. `dev-loop run --agents core` lance cette paire par défaut ; utilisez `--agents legacy` seulement pour l'ancienne boucle à Dev unique.

| Agent | Rôle |
|---|---|
| **`senior-dev-agent`** | **Niveau senior (opus, effort max).** Deux modes : **design-and-delegate** — pour un nouveau module/une nouvelle fonctionnalité, rédige un **design doc** vivant, propre au module, engendre des tickets enfants placés en attente dans `Backlog` et assignés à junior-dev (chacun portant un pointeur `Design:`), et fait passer le ticket parent de conception → `In Review` pour validation par PM ; et **direct-code** — lorsqu'on lui remonte un véritable échec de vérification côté junior, implémente → garde-fou → livre lui-même. |
| **`junior-dev-agent`** | **Niveau junior (sonnet, effort high).** Prend les tickets `Todo` routés vers le junior, **lit le pointeur `Design:` associé avant de coder**, implémente conformément au design, exécute les mêmes garde-fous / flux de livraison que dev-agent, passe le relais en `In Review`. Abandonne (info-needed) face à une spec ambiguë plutôt que de deviner. |

### Externe — observer et raconter

| Agent | Rôle |
|---|---|
| **`ops-agent`** | Surveille la **prod en fonctionnement** (cadence serrée, ~10–15 min). Interroge les health checks + l'URL de base + d'éventuels routes/logs critiques et, sur une dégradation **confirmée et répétée** (re-vérification anti-rebond d'abord), dépose/rafraîchit un Bug `incident` (Urgent quand la prod est tombée). Observe-et-dépose — ne fait jamais de rollback. |
| **`architect-agent`** | **Auditeur de santé technique** sur l'ensemble de la base de code (lent, quasi quotidien). Audite une dimension **tournante** (dérive / duplication / code mort / obsolescence des dépendances + CVE / cohérence / abstractions manquantes), avec garde-fou par SHA, et dépose des Improvement `tech-debt`. Lecture seule sur le code — n'implémente jamais. |
| **`communication-agent`** | Responsable communication / médias. Lit la stratégie, la feuille de route, le travail livré et les faits produit publiables, puis rédige un article public par cadence (quotidien par défaut). Brouillon uniquement : ne publie pas, ne commit/push/déploie pas, ne vérifie pas. Peut tourner dans Codex avec `DEVLOOP_ACTOR=communication`. |

### Setup — pas un agent de boucle

| Commande | Rôle |
|---|---|
| **`/dev-loop:init`** | Setup ponctuel, idempotent, en présence de l'opérateur. Exécute **DETECT → MAP → ASSEMBLE → LOAD** : détecte la forme du projet (greenfield / brownfield / adoption ; mono- ou multi-repo), cartographie en lecture seule une base de code brownfield dans la base documentaire de PM, recueille la config, s'assure des labels + du projet, échafaude le document de stratégie + les fichiers runtime, adopte éventuellement des tickets humains nommés (confirmation ticket par ticket), et affiche une checklist de mise en route. Ne dépose jamais de tickets, ne vérifie ni ne livre. |

---

## Les workflows

Les agents sont volontairement simples. La valeur vient des **workflows** : des agents qui réagissent à l'état des tickets sans orchestrateur central.

### 1. La boucle de construction centrale
PM (depuis le document de stratégie) et QA (depuis les tests) déposent des tickets `Todo` → Dev les réclame par ordre de priorité → `In Progress` → livre → `In Review` → le **propriétaire** vérifie (PM pour une Feature, QA pour un Bug). **Réussite → `Done`. Échec → clôture + dépôt d'un suivi** (un incrément raté est *remplacé, jamais rouvert en douce*, de sorte que l'historique distingue ce qui a été livré-mais-échoué de ce qui est en file d'attente).

### 2. Dev à deux niveaux — design-and-delegate *(à activer)*
Pour un **nouveau module ou une nouvelle fonctionnalité**, PM route le ticket vers **senior-dev**. Senior rédige un **design doc** vivant, le décompose en tickets enfants concrets **mis en attente dans `Backlog`** (non sélectionnables), chacun portant un pointeur `Design:`, et fait passer le ticket parent de conception → `In Review`. **PM valide le design** (vous signez pour les gros modules) ; en cas de réussite, les enfants **passent de `Backlog` → `Todo`** et **junior-dev** les prend, lit le design, et implémente. Le modèle coûteux conçoit une seule fois ; le modèle bon marché code les morceaux.

### 3. Escalade — junior → senior → humain
Lorsque le travail de **junior-dev** échoue à la vérification sur un **vrai** manquement aux critères d'acceptation (et non un aléa intermittent/d'infra — celui-là ne fait que relancer un essai), le vérificateur (PM pour une Feature/Improvement, QA pour un Bug) l'annule et dépose un suivi **senior-dev direct-code** ; senior le code lui-même. Si le correctif du senior échoue *lui aussi* → `fix-exhausted` → **`Human-Blocked`** (vous). Le niveau bon marché tente en premier ; le niveau coûteux est le filet de sécurité ; vous êtes le dernier recours.

### 4. Onboarding — `init` (DETECT → MAP → ASSEMBLE → LOAD)
Branchez un produit dans la boucle une bonne fois : détectez sa forme, cartographiez une base de code brownfield dans la base documentaire de PM (ou menez un entretien pour un projet greenfield), provisionnez les labels/le projet, échafaudez le document de stratégie + les fichiers runtime, et affichez une checklist de mise en route — avant de basculer `mode:"live"`.

### 5. Auto-évolution — rapport → 点评 → leçon → comportement
Chaque agent écrit des rapports ; Reflect distille les motifs récurrents dans `lessons.md` ; vous déposez un **点评** à côté de n'importe quel rapport et l'agent transforme votre critique en une règle `lessons.md` qu'il respecte ensuite. La boucle s'améliore sans que personne n'édite de fichiers skill — et ne réécrit **jamais** ses propres instructions fondamentales de façon autonome (celles-ci sont proposées à un humain).

### 6. Surveillance externe — santé, code et communication produit
**Ops** surveille la prod en fonctionnement et dépose un Bug `incident` sur une dégradation confirmée (qui réintègre la boucle centrale en tant que Bug). **Architect** audite une tranche tournante de la base de code et dépose des Improvement `tech-debt`. **Communication** rédige l'article produit quotidien à partir de faits vérifiés et publiables. Aucun n'implémente ni ne publie à l'extérieur.

### 7. Mise en attente humaine et notification
Un blocage réellement réservé à l'humain (un identifiant, une validation juridique, un prérequis externe) met le ticket en attente — `Human-Blocked` sur le hub, ou `blocked`+`needs-pm` sur Linear/local — et un **webhook Slack/Lark** optionnel vous alerte hors-bande afin qu'il ne reste jamais inaperçu.

### 8. Miroir — hub → Linear *(backend hub)*
Le hub peut pousser ses tickets de façon unidirectionnelle vers Linear pour une visibilité humaine (idempotent, incrémental, anti-split-brain garanti — Linear n'est jamais relu comme source de vérité). Faites tourner la boucle sur le hub local rapide, observez-la dans Linear.

### 9. Observer — la web UI en localhost *(backend hub)*
Un démon localhost persistant sert un tableau en lecture seule, le détail des tickets, l'éditeur de feuille de route, les rapports, et une vue activité/débit au-dessus du même système de référence — pour que vous *observiez* la boucle sans y toucher. Les agents restent sans démon (ils se coordonnent via MCP, pas via la web UI).

---

## Cas d'usage

**Utilisez dev-loop quand** le travail revient souvent, que le « terminé » peut être vérifié par une machine, et que le résultat vaut les tokens dépensés. En pratique :

- **Un produit maintenu en continu.** Pointez PM sur un document de stratégie et laissez la boucle livrer des fonctionnalités, corriger les bugs que QA trouve, et garder la prod en bonne santé — vous relisez, vous ne codez pas à la main.
- **Un backlog sur lequel vous prenez sans cesse du retard.** Échecs CI, montées de version de dépendances, une catégorie de bug récurrente, nettoyage de dérive — déposez-les (ou laissez QA/Architect les trouver) et la boucle vide la file pendant que vous dormez.
- **Un nouveau module ou une grosse fonctionnalité.** Activez le Dev à deux niveaux : senior-dev le conçoit et le décompose ; junior-dev en construit les morceaux ; vous validez le design et relisez le résultat.
- **Durcissement de toute la base de code.** Laissez Architect auditer une dimension tournante chaque jour et déposer la dette technique ; la boucle la rembourse un incrément vérifié à la fois.
- **Surveillance permanente de la prod.** Ops transforme une dégradation confirmée en un Bug `incident` qui réintègre la boucle — une supervision qui *agit*, pas qui se contente d'alerter.
- **Produits multi-repo.** Un produit, plusieurs repos : les tickets ciblent un repo via un label, avec build/branche/déploiement par repo.

**Ne l'utilisez pas** quand le « terminé » est surtout subjectif, quand la tâche est ponctuelle, ou quand le résultat ne peut pas être rejeté automatiquement. Sans vraie vérification, une boucle produit surtout plus de travail douteux, plus vite.

> **Le coût est réel.** Les tokens sont le coût de fonctionnement, et la *fréquence* le domine souvent. Une cadence serrée, beaucoup d'agents et le modèle le plus puissant font vite monter l'addition. Utilisez des **models/efforts** adaptés aux rôles mécaniques, choisissez une cadence raisonnable, et surveillez le **taux d'acceptation** (vérifiés ÷ déposés) : sous ~50 %, la boucle crée du travail de revue au lieu de vous en épargner.

---

## Démarrage rapide

```bash
# Installez le runtime CLI/hub. Cela suffit pour le chemin scheduler.
npm i -g @dyzsasd/dev-loop
```

Sur macOS, l'installation npm globale tente aussi d'installer un LaunchAgent qui lance
`dev-loop daemon up-all` à la connexion. Définissez `DEVLOOP_SKIP_AUTOSTART=1` avant l'installation
pour refuser cette étape, ou réparez-la plus tard avec `dev-loop daemon install-autostart`.

Choisissez ensuite le chemin d'onboarding adapté à votre usage.

**Chemin A — sans plugin Claude, avec `dev-loop run` :**

```bash
# Créez et renseignez la config par projet.
dev-loop init-config
$EDITOR ~/.dev-loop/projects.json

# Lancez une passe dry-run depuis le repo produit configuré.
cd /path/to/product-repo
dev-loop run --cli codex --agents core --once --dry-run

# Passez ensuite à mode:"live" dans projects.json et laissez la boucle tourner.
dev-loop run --cli codex --agents core,communication
```

**Chemin B — onboarding par skill de plugin Claude :**

```bash
dev-loop install-claude-plugin
# Dans Claude Code, exécutez les deux commandes /plugin imprimées par l'installeur, puis :
/dev-loop:init

# Une fois ~/.dev-loop/projects.json écrit par init, la boucle quotidienne reste dev-loop run.
cd /path/to/product-repo
dev-loop run --cli codex --agents core --once --dry-run
```

## Prérequis

- **Claude Code** avec ce plugin installé pour les skills de plugin `/dev-loop:*` / Agent View ; pour le scheduler,
  la CLI exécutrice choisie (`claude`, `codex`, ou opencode une fois vérifiée) doit être dans le `PATH`.
- Un **backend de coordination** : le **Linear MCP** (`mcp__linear-server__*`) par défaut, ou rien de plus pour le tableau sur fichiers local / le hub.
- La **CLI `gh`** authentifiée — Dev l'utilise pour git/déploiement.
- Un **repo git** pour le produit et (pour Linear) une **équipe + un projet** que la boucle peut administrer.
- Par rôle : `repoPath` (Dev), `strategyDoc` (PM), `testEnv` (QA).
- Pour le backend hub : **Node ≥ 23.6** (`node:sqlite` intégré, zéro dépendance native). Si le
  `node` par défaut est trop ancien, définissez `DEVLOOP_NODE=/absolute/path/to/node` ; la CLI et
  le hook empaquetés l'utiliseront.

## Installation

dev-loop fonctionne selon **deux modes** — choisissez selon la façon dont vous voulez piloter les
agents. Les deux partent du paquet npm (aucun clone GitHub requis) :

```bash
npm i -g @dyzsasd/dev-loop          # installe les CLI `dev-loop` + `dev-loop-hub` (Node ≥ 23.6)
```

| | **Mode A — Plugin** (interactif) | **Mode B — Scheduler** (sans surveillance, par défaut) |
|---|---|---|
| Qui lance la CLI | vous (Claude Code interactif) | `dev-loop run` (sans surveillance) |
| CLI | Claude Code | Claude **ou** Codex |
| Installation supplémentaire | `dev-loop install-claude-plugin` → `/plugin install` | rien — le paquet npm suffit |
| Besoin du plugin ? | oui | **non** |
| Skills + hub MCP | depuis le plugin installé | le scheduler les injecte lui-même |

### Mode A — Plugin (interactif, Claude Code)
Vous lancez Claude Code vous-même et pilotez les agents avec les skills de plugin `/dev-loop:*` + `/loop`.
Enregistrez le plugin **depuis npm** (sans GitHub) :

```bash
dev-loop install-claude-plugin       # écrit un marketplace local à source npm + affiche les 2 commandes ci-dessous
/plugin marketplace add ~/.claude/plugins/marketplaces/dev-loop-npm
/plugin install dev-loop@dev-loop-npm
```

Les skills apparaissent sous `/dev-loop:pm-agent` … `/dev-loop:communication-agent`,
les `/dev-loop:senior-dev-agent` + `/dev-loop:junior-dev-agent`
à activer, et `/dev-loop:init`. Pilotez-les avec `/loop` (voir [Lancer la boucle](#lancer-la-boucle)).
*(Installation de développement depuis un checkout source : `claude --plugin-dir /path/to/dev-loop`,
ou un marketplace `source:"local"` dans `~/.claude/settings.json` →
`/plugin install dev-loop@local`.)*

### Mode B — Scheduler (sans surveillance, par défaut — Claude **ou** Codex)
Le scheduler `dev-loop run` garde la cadence et invoque `claude -p` / `codex exec` une fois par
déclenchement. **Aucun plugin requis** : il injecte le SKILL de chaque agent comme prompt (depuis le
paquet embarqué) et **enregistre lui-même le MCP `dev-loop-hub`** — claude via un `--mcp-config`
inline, codex via des overrides `-c` — de sorte qu'aucune config `.mcp.json` ni
`~/.codex/config.toml` n'est nécessaire.

```bash
dev-loop run --cli claude --agents core          # ou : --cli codex --agents core,communication
```

Ne nécessite que le paquet npm + la CLI de votre choix (`claude` ou `codex`) dans le `PATH`. Pour
`--agents`, la cadence et le plafond de coût `--max-fires`, voir [Lancer la boucle](#lancer-la-boucle).

## Configuration

Les réglages par projet résident dans le répertoire de config propre à dev-loop :
`${DEVLOOP_PROJECTS_JSON}` s'il est défini, sinon `~/.dev-loop/projects.json`
(`DEVLOOP_DATA_DIR` change ce répertoire de base). Créez un starter vide, puis ajoutez votre
propre projet :

```bash
dev-loop init-config
# Associez ensuite chaque projet à son repo, document de stratégie, environnement de test et flags git/deploy.
```

Les réglages (tous par projet) :
- **`mode`** — `"dry-run"` (analyse + affichage, aucune écriture) vs `"live"` (crée/fait transiter les tickets et, pour Dev, commit/push/déploie selon `git`/`deploy`).
- **`autonomy`** — `"ask"` (escalade les décisions réservées à l'humain) vs `"full"` (décide et agit).
- **`backend`** — `"linear"` (par défaut) / `"local"` (tableau sur fichiers) / `"service"` (le hub). Voir [Backends](#backends).
- **`models` / `efforts`** — overrides optionnels par agent au lancement. `dev-loop run` a déjà des profils par rôle : senior/PM/architect/reflect utilisent un raisonnement plus fort ; junior/QA/sweep/ops/communication utilisent des profils moins coûteux pour le travail répété.
- **`repos[]`** *(optionnel)* — un produit, plusieurs repos (sinon mono-repo, 100 % inchangé).
- **`reports.sink`** *(optionnel)* — `"files"` (par défaut) vs `"linear"` (héberge les rapports + 点评 dans Linear pour un runtime cloud/distant).
- **`notify`** *(optionnel)* — webhook Slack/Lark pour vous alerter quand un ticket est mis en attente humaine.
- **`communication`** *(optionnel)* — active les brouillons d'articles publics, sans publication externe.

Référence complète : [`references/config-schema.md`](references/config-schema.md).

## Configurer un projet

Deux chemins sont pris en charge :

- **Avec le plugin Claude :** lancez `/dev-loop:init` une fois. Il échafaude tout et affiche une
  checklist de mise en route avant le passage en live ; il ne crée que ce qui manque et n'écrase rien.
- **Sans plugin :** créez un `~/.dev-loop/projects.json` vide avec `dev-loop init-config`,
  puis renseignez la clé projet, `repoPath` ou `repos[]`,
  `strategyDoc`, `testEnv`, le backend, et gardez `mode:"dry-run"`. Pour un backend `service`, lancez
  `dev-loop init-service <key> "<name>" <PREFIX> --dry-run` pour prévisualiser le bootstrap du hub,
  puis sans `--dry-run` lorsque la config est correcte.

Les installations existantes qui ont encore `~/.claude/plugins/data/dev-loop/projects.json`
sont lues comme fallback de compatibilité ; les nouveaux projets doivent être déclarés dans
`~/.dev-loop/projects.json`.

Pour `backend:"service"`, `init-service` démarre le daemon localhost une fois. Sur macOS,
l'installation npm globale installe aussi l'élément de connexion lorsque les scripts sont autorisés ;
si vous avez ignoré les scripts ou devez le réparer, lancez `dev-loop daemon install-autostart`.
Le port par défaut de la web UI est `8787` et le daemon cherche le port libre suivant s'il est occupé.

Par sécurité, les agents de la boucle réappliquent aussi les vérifications de labels/projet lors de
la première exécution `live`.

## Lancer la boucle

La commande principale de boucle est `dev-loop run`. C'est un processus long vivant ordinaire :
dev-loop garde la cadence, charge les skills d'agents embarquées dans le paquet npm, puis appelle
la CLI exécutrice choisie une fois par déclenchement d'agent. L'exécuteur peut être Claude ou Codex :

```bash
# Depuis un repo produit configuré ; le projet est déduit du cwd.
cd /path/to/product-repo
dev-loop run --cli claude
dev-loop run --cli codex --agents core,communication

# Une passe dry-run avant de le laisser tourner sans surveillance.
dev-loop run --cli codex --agents core,communication --once --dry-run

# Ancienne boucle à Dev unique, seulement si vous la voulez explicitement.
dev-loop run --cli claude --agents legacy

# Garde-fou de coût : arrêt après N déclenchements au total (illimité par défaut).
dev-loop run --cli claude --agents core --max-fires 50
```

Le scheduler **enregistre lui-même le MCP `dev-loop-hub`** pour l'exécuteur (claude : `--mcp-config`
inline ; codex : overrides `-c`), de sorte que le Mode B ne requiert ni plugin ni config
`.mcp.json` / `~/.codex/config.toml`. Les tokens sont le coût de fonctionnement — `--max-fires`
plafonne un processus long vivant, et les `models` / `efforts` par agent gardent les agents mécaniques bon marché.

`--agents core` signifie `pm,qa,senior-dev,junior-dev,sweep`. Ajoutez `reflect`, `outward`, ou des agents
individuels : `--agents core,reflect,ops,communication`. La détection du projet est automatique
quand la commande démarre dans un `repoPath` ou `repos[].path` configuré ; utilisez
`--project <key>` seulement depuis l'extérieur du repo, depuis cron/systemd avec un cwd fixe, ou pour
remplacer cette détection. Si aucun projet explicite n'est défini et que le cwd ne correspond à aucun
repo configuré, le scheduler s'arrête au lieu de retomber sur `demo` ou un autre projet. Plusieurs
produits sur la même machine sont un cas normal : ajoutez-les dans `projects.json`, puis lancez un
processus `dev-loop run` par produit.

Claude Agent View reste disponible quand vous voulez l'interface native de Claude : installez le
plugin Claude, ouvrez `claude agents`, puis lancez `/loop 5m /dev-loop:pm-agent`,
`/loop 5m /dev-loop:qa-agent`, `/loop 5m /dev-loop:senior-dev-agent`,
`/loop 5m /dev-loop:junior-dev-agent` et les agents externes optionnels.

**Cadence** (ils s'auto-régulent, donc les déclenchements à vide sont des no-op bon marché) : PM/QA/Senior-Dev/Junior-Dev ~5 min, Sweep
~30 min, Reflect quotidien ; Ops ~10 min, Architect/Communication quotidien/à la demande.

**La reprise est une opération normale** : les agents sont sans état à chaque exécution. Après un arrêt, un crash ou un redémarrage, relancez-les ; chacun relit la réalité de terrain et continue.

> ⚠️ **`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = commits, pushes et
> déploiements en prod sans surveillance, sans aucun garde-fou humain.** C'est l'effet recherché,
> mais essayez d'abord `mode:"dry-run"` (ou `dev-loop run --once --dry-run`) pour voir ce qu'il ferait.

📖 Guide complet — onboarding, méthodes de lancement, modèles, reprise, arrêt : [`docs/RUNNING.md`](docs/RUNNING.md).

## Backends

La coordination est enfichable ; les agents et les protocoles sont identiques pour les trois.

| Backend | Description | Ce que ça vous apporte |
|---|---|---|
| **`linear`** *(par défaut)* | Coordination via le Linear MCP | Cloud, visible par l'équipe, l'application Linear comme UI |
| **`local`** | Un tableau sur fichiers markdown, local à la machine, dans le répertoire de données | Zéro cloud, minimal, sans Linear |
| **`service`** | Un **hub** local — un système de référence MCP au-dessus de `node:sqlite` | **Véritable identité propre à chaque agent**, une **web UI** en localhost, des documents versionnés publiés par l'opérateur, le miroir Linear unidirectionnel, la portabilité entre CLI |

Le **plan de travail** (états, transitions, responsabilités et boucle d'agents) est identique d'un backend à l'autre ; le **plan de surface** (identité par agent, web UI) s'étend selon le backend. Voir [conventions §18](references/conventions.md) +
[`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md).

## Périmètre de sécurité

Les agents n'opèrent **que** sur les tickets portant le label **`dev-loop`**, circonscrits au projet configuré. Ils ne lisent, ne font transiter ni ne commentent jamais aucun autre ticket. Ce label unique est le pare-feu entre la boucle et votre backlog humain ; considérez-le comme une partie du modèle de sécurité.

## Auto-évolution

`reflect-agent` est ce qui permet à la boucle de s'améliorer sans sombrer dans le chaos :
- Il lit la production **propre** de la boucle et distille les motifs **récurrents** (≥2 occurrences, chacune citant des ID de ticket / des SHA de commit) dans `lessons.md` — la couche de surcharge par opérateur que chaque agent lit en tête de chaque exécution.
- **La limite stricte** ([conventions §17](references/conventions.md)) : Reflect peut éditer `lessons.md` de façon autonome (local, réversible, jamais commité), mais **ne doit pas** réécrire automatiquement les SKILL ou `conventions.md`. Les changements structurels sont **rédigés sous forme de propositions** que l'opérateur applique par git commit. L'auto-modification du cœur est *exposée, pas exécutée* — l'unique exception de principe au « décider et agir ».

## Rapports et revue de l'opérateur (点评)

Vous pilotez la boucle en relisant sa trace, pas en modifiant le code à l'intérieur de la boucle.
- **Rapports.** Chaque agent écrit un journal quotidien, agrégé par semaine/mois sous `${DEVLOOP_DATA_DIR:-~/.dev-loop}/<project-key>/reports/<agent>/` — local à la machine, jamais commité, sans secret/PII. Un déclenchement no-op n'écrit rien.
- **点评.** Déposez un `<report>.review.md` voisin avec du texte libre ; à son exécution suivante, l'agent distille votre critique en une règle `lessons.md` placée dans sa propre section, et la respecte ensuite. La boucle complète : **rapport → votre 点评 → leçon → comportement modifié.**
- **Cloud/distant ?** Mettez `reports.sink:"linear"` et les rapports deviennent des documents Linear par agent avec le 点评 en commentaire — à lire et critiquer depuis un navigateur/téléphone (même pare-feu, garde-fous §16).

## Intégration Codex (optionnelle)

La boucle peut utiliser **OpenAI Codex** comme outil de renfort via le compagnon
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) + la CLI `codex`.
**À activer explicitement ; sans lui, le comportement ne change pas.** Elle ajoute, avec des garde-fous indépendants, une **revue indépendante par un second modèle** (Dev étape 5.5 + Architect ; consultative, ne touche jamais au tableau), la **génération d'images** (maquettes PM + assets de production Dev — la seule chose que la boucle ne peut pas faire elle-même), et un **sauvetage** ponctuel avant un blocage `fix-exhausted`. Voir
[conventions §24](references/conventions.md) + [`references/codex-integration.md`](references/codex-integration.md).

Séparément, le hub `service` permet de lancer les agents eux-mêmes depuis Codex (Mode B) ; voir
[`docs/PORTABILITY.md`](docs/PORTABILITY.md). Lancez n'importe quel agent ainsi, par ex.
`dev-loop run --cli codex --agents communication` — le scheduler injecte lui-même l'override
acteur/MCP `dev-loop-hub` par agent, aucune config Codex manuelle n'est donc nécessaire.

## Publication

Les releases du paquet passent par le workflow GitHub Actions manuel **Release npm package**. Il
synchronise la version partagée, lance la suite de tests du hub, publie `hub/` sur npm avec
`NPM_TOKEN`, puis pousse le tag `v<version>`. Voir [`docs/RELEASING.md`](docs/RELEASING.md).

## Documentation approfondie

- [`references/conventions.md`](references/conventions.md) — la spécification de référence (machine à états, labels, chaque protocole). Chaque agent la lit en premier.
- [`references/config-schema.md`](references/config-schema.md) — la référence complète des champs de `projects.json`.
- [`docs/RUNNING.md`](docs/RUNNING.md) — onboarding, méthodes de lancement, modèles, reprise.
- [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md) — le hub local / le backend `service`.
- [`docs/DAEMON.md`](docs/DAEMON.md) — la web UI en localhost + le démon.
- [`docs/PORTABILITY.md`](docs/PORTABILITY.md) — faire tourner la boucle sur un second CLI (Codex / opencode).
- [`docs/RELEASING.md`](docs/RELEASING.md) — le chemin GitHub Actions pour publier npm + tags.
- [`docs/design/`](docs/design/) — les dossiers de conception (choix du backend, repositionnement du démon, le découpage du Dev à deux niveaux).
- [`CHANGELOG.md`](CHANGELOG.md) — l'historique complet des versions.

## Statut

**v0.23.3.** Dix agents activables — cinq internes (**PM / QA / Dev / Sweep / Reflect**) et trois externes (**Ops / Architect / Communication**), avec un **senior-dev / junior-dev** à deux niveaux par défaut — plus la commande d'onboarding `init`. La coordination est enfichable par backend : **Linear** (par défaut), un **tableau sur fichiers local**, ou le **hub local** (système de référence `node:sqlite` avec identité par agent + une web UI en localhost + des documents versionnés + un miroir Linear unidirectionnel + la portabilité entre CLI). Récemment : dev-loop utilise par défaut son propre répertoire `~/.dev-loop` pour la configuration et les données au lieu du dossier de plugin Claude ; le runner refuse désormais de deviner un projet si `--project` et le repo courant ne l'identifient pas ; et le daemon du hub peut être installé comme LaunchAgent macOS avec un port localhost stable. Validé de bout en bout et éprouvé au combat sur de longues exécutions en live ; l'autonomie (push/déploiement) est à activer par projet et conditionnée à un build vert. Historique complet dans [`CHANGELOG.md`](CHANGELOG.md).
