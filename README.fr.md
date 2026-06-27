# dev-loop

[English](README.md) · [中文](README.zh-CN.md) · **Français**

**Dix agents autonomes qui construisent et améliorent des logiciels par eux-mêmes, coordonnés entièrement par l'état des tickets.** Vous écrivez l'intention (un document de stratégie) et vous relisez le résultat ; les agents proposent, implémentent, vérifient, livrent et apprennent — en boucle. C'est du *loop engineering* (ingénierie de boucle) : vous cessez de prompter manuellement un agent de code et faites tourner à la place un système qui se prompte lui-même.

Les agents ne s'appellent jamais entre eux. **Le tableau est l'unique canal** — chaque agent lit et écrit l'état des tickets (ainsi que git), si bien que n'importe quel agent peut s'exécuter à tout moment, dans n'importe quel ordre, voire en parallèle. Les labels d'un ticket portent tout : éligibilité, propriétaire, routage, niveau de dev.

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

- [Qu'est-ce que c'est](#quest-ce-que-cest) · [Comment ça fonctionne](#comment-ça-fonctionne)
- [Les agents](#les-agents) — l'effectif au complet
- [Les workflows](#les-workflows) — comment les agents se combinent réellement
- [Cas d'usage](#cas-dusage) — quand (et quand ne pas) y recourir
- [Démarrage rapide](#démarrage-rapide) · [Prérequis](#prérequis) · [Installation](#installation) · [Configuration](#configuration)
- [Configurer un projet](#configurer-un-projet) · [Lancer la boucle](#lancer-la-boucle)
- [Backends](#backends) · [Périmètre de sécurité](#périmètre-de-sécurité) · [Auto-évolution](#auto-évolution)
- [Rapports et revue de l'opérateur (点评)](#rapports-et-revue-de-lopérateur-点评) · [Codex (optionnel)](#intégration-codex-optionnelle)
- [Documentation approfondie](#documentation-approfondie) · [Statut](#statut)

---

## Qu'est-ce que c'est

dev-loop est un **plugin Claude Code** : un ensemble d'agents spécialisés par rôle (Product Manager, QA, Développeur(s) et plusieurs coordinateurs), plus un petit corpus de conventions qui leur permet de dérouler un cycle de développement logiciel complet **sans humain dans la boucle interne**. Vous fournissez un produit, un document de stratégie et les réglages d'autonomie ; la boucle transforme l'intention en incréments livrés et vérifiés, et consigne en retour ce qu'elle a appris.

Elle est délibérément **agnostique vis-à-vis du substrat** : la coordination passe par **Linear** (par défaut), un **tableau sur fichiers, local à la machine**, ou un **hub local** (un système de référence MCP au-dessus de `node:sqlite`, avec une véritable identité propre à chaque agent + une web UI en localhost). Mêmes agents, mêmes protocoles.

Trois choses restent vraies partout :
- **Le tableau est le canal** — aucun agent n'en appelle un autre ; ils se passent le relais via l'état des tickets.
- **Chaque déclenchement repart de zéro** — les agents sont sans état à chaque exécution ; ils relisent la réalité de terrain (tableau + git + disque) à chaque fois, si bien qu'un crash, un redémarrage ou une compaction du contexte en plein milieu d'une tâche n'a aucune conséquence.
- **L'autonomie, ce sont des garde-fous, pas des prompts** — sous `autonomy:"full"`, les agents décident et agissent ; un build rouge n'est jamais livré, un déploiement raté déclenche un rollback automatique, et une décision réellement réservée à l'humain est *épinglée sur le ticket comme un fait*, jamais sous forme de prompt interactif.

## Comment ça fonctionne

- **Les labels de propriétaire routent le travail.** `pm` possède les Features, `qa` possède les Bugs ; le **propriétaire dépose et vérifie**, Dev implémente les tickets de tout le monde. C'est ainsi qu'un build terminé retrouve son chemin vers celui qui le valide.
- **Un seul label fait office de pare-feu.** Les agents ne touchent **qu'**aux tickets portant le label `dev-loop`, circonscrits au projet configuré — jamais à votre backlog humain.
- **La boucle s'améliore elle-même.** `reflect-agent` étudie le comportement de la boucle elle-même et entretient un `lessons.md` propre à chaque opérateur, que chaque agent respecte à l'exécution suivante. Sa limite stricte : il peut éditer `lessons.md` de façon autonome, mais ne réécrit **jamais** les instructions des agents eux-mêmes — les changements structurels sont *proposés* à un humain, jamais appliqués automatiquement.
- **Vous pilotez en relisant, pas en éditant le code.** Chaque agent écrit des rapports quotidiens / hebdomadaires / mensuels ; déposez un **点评 (revue/critique de l'opérateur)** à côté de l'un d'eux et l'agent le distille en une règle `lessons.md` qu'il respecte ensuite.

---

## Les agents

Cinq agents **internes** (tournés vers la construction), un **Dev à deux niveaux** optionnel, trois agents **externes**, et une commande de **setup** ponctuelle. Chaque agent lit d'abord [`references/conventions.md`](references/conventions.md) — la machine à états complète, la taxonomie des labels, les modèles de tickets et les protocoles.

### Interne — la boucle de construction

| Agent | Rôle |
|---|---|
| **`pm-agent`** | Lit le document de stratégie, met à l'épreuve le produit réel, dépose des tickets **Feature**, propose des améliorations de façon proactive, **vérifie** les fonctionnalités qui atteignent `In Review`, débloque ses propres tickets bloqués, et maintient le document de stratégie à jour. Route chaque ticket vers un niveau de dev lorsque le Dev à deux niveaux est activé. |
| **`qa-agent`** | Exécute des tests de chemin nominal + cas limites dans l'environnement de test configuré, dépose des tickets **Bug** (et `drift` → Improvement), **re-teste** les bugs en `In Review`, route chaque ticket déposé vers un niveau de dev, et lève les blocages pour manque d'information au profit de Dev. |
| **`dev-agent`** | Tire les tickets `Todo` par ordre de priorité, les prépare (assez d'infos ? doublon ? déjà fait ?), implémente, conditionne au build/test, **relit son propre diff**, livre selon la config, **fait un smoke-test de la prod (rollback auto en cas de casse)**, passe le relais en `In Review`. Bloque plutôt que de deviner. C'est le Dev unique par défaut ; il reste actif comme solution de repli quand le découpage à deux niveaux est désactivé. |

### Dev à deux niveaux — optionnel (à activer par projet)

Scindez le Dev unique en un responsable de conception et un implémenteur, afin que le modèle coûteux se concentre sur l'architecture et que le moins cher fasse le gros du code. Activez-le avec `DEV_SPLIT=1` sur le lanceur ; le `dev` unique historique reste la valeur par défaut, de sorte que les projets non scindés ne sont pas affectés.

| Agent | Rôle |
|---|---|
| **`senior-dev-agent`** | **Niveau senior (opus, effort max).** Deux modes : **design-and-delegate** — pour un nouveau module/une nouvelle fonctionnalité, rédige un **design doc** vivant, propre au module, engendre des tickets enfants placés en attente dans `Backlog` et assignés à junior-dev (chacun portant un pointeur `Design:`), et fait passer le ticket parent de conception → `In Review` pour validation par PM ; et **direct-code** — lorsqu'on lui remonte un véritable échec de vérification côté junior, implémente → garde-fou → livre lui-même. |
| **`junior-dev-agent`** | **Niveau junior (sonnet, effort high).** Prend les tickets `Todo` routés vers le junior, **lit le pointeur `Design:` associé avant de coder**, implémente conformément au design, exécute les mêmes garde-fous / flux de livraison que dev-agent, passe le relais en `In Review`. Abandonne (info-needed) face à une spec ambiguë plutôt que de deviner. |

### Externe — observer, coordonner, orienter

| Agent | Rôle |
|---|---|
| **`sweep-agent`** | Agent d'entretien du cycle de vie (cadence plus lente). Répare les fissures : labels de propriétaire ou de **dev-tier** manquants/erronés (invisibles à toute requête → à l'abandon), `In Progress` orphelins issus d'exécutions plantées, signaux périmés, rapports de santé du tableau. Sur le backend hub, il exécute aussi le push optionnel du **miroir Linear unidirectionnel**. Hygiène uniquement. |
| **`reflect-agent`** | Rétrospective + auto-évolution (quotidien). Étudie le comportement **propre** de la boucle et entretient `lessons.md` à partir de motifs récurrents, étayés par des preuves. Observe + entretient uniquement ; ne peut éditer de façon autonome que `lessons.md` — les changements structurels sont rédigés sous forme de propositions, jamais appliqués automatiquement. |
| **`ops-agent`** | Surveille la **prod en fonctionnement** (cadence serrée, ~10–15 min). Interroge les health checks + l'URL de base + d'éventuels routes/logs critiques et, sur une dégradation **confirmée et répétée** (re-vérification anti-rebond d'abord), dépose/rafraîchit un Bug `incident` (Urgent quand la prod est tombée). Observe-et-dépose — ne fait jamais de rollback. |
| **`architect-agent`** | **Auditeur de santé technique** sur l'ensemble de la base de code (lent, quasi quotidien). Audite une dimension **tournante** (dérive / duplication / code mort / obsolescence des dépendances + CVE / cohérence / abstractions manquantes), avec garde-fou par SHA, et dépose des Improvement `tech-debt`. Lecture seule sur le code — n'implémente jamais. |
| **`director-agent`** | Le **coordinateur de la DIRECTION** tourné vers l'humain (backend hub ; quotidien/à la demande). Préside un **tableau de discussion** inter-agents (ouvre des sujets → chaque agent y apporte le prisme de son rôle à chaque tour → synthétise → une **décision**) et **rédige** la feuille de route que l'**opérateur publie** ; via un **canal Lark/Slack bidirectionnel** optionnel, l'opérateur discute avec lui. Coordonne + rédige — n'implémente/livre/vérifie jamais. Pas de config `director` ⇒ no-op silencieux (la stratégie revient à PM). |

### Setup — pas un agent de boucle

| Commande | Rôle |
|---|---|
| **`/dev-loop:init`** | Setup ponctuel, idempotent, en présence de l'opérateur. Exécute **DETECT → MAP → ASSEMBLE → LOAD** : détecte la forme du projet (greenfield / brownfield / adoption ; mono- ou multi-repo), cartographie en lecture seule une base de code brownfield dans la base documentaire de PM, recueille la config, s'assure des labels + du projet, échafaude le document de stratégie + les fichiers runtime, adopte éventuellement des tickets humains nommés (confirmation ticket par ticket), et affiche une checklist de mise en route. Ne dépose jamais de tickets, ne vérifie ni ne livre. |

---

## Les workflows

Les agents sont simples ; la valeur réside dans les **workflows**. Chacun n'est qu'une réaction d'agents à l'état des tickets — sans orchestrateur.

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

### 6. Direction — le tableau de discussion et la feuille de route *(backend hub)*
Le **Director** ouvre un **sujet**, les agents apportent, chacun selon le prisme de son rôle, une perspective à chaque tour, le Director **synthétise une décision** et **rédige** la feuille de route ; l'**opérateur la publie**. En option, l'opérateur discute avec le Director via un **canal Lark/Slack bidirectionnel**. La stratégie devient un artefact délibéré et validé par l'opérateur, plutôt que la conjecture d'un seul agent.

### 7. Surveillance externe — santé de la prod et de la base de code
**Ops** surveille la prod en fonctionnement et dépose un Bug `incident` sur une dégradation confirmée (qui réintègre la boucle centrale en tant que Bug). **Architect** audite une tranche tournante de la base de code et dépose des Improvement `tech-debt`. Tous deux observent-et-déposent ; aucun n'implémente.

### 8. Mise en attente humaine et notification
Un blocage réellement réservé à l'humain (un identifiant, une validation juridique, un prérequis externe) met le ticket en attente — `Human-Blocked` sur le hub, ou `blocked`+`needs-pm` sur Linear/local — et un **webhook Slack/Lark** optionnel vous alerte hors-bande afin qu'il ne reste jamais inaperçu.

### 9. Miroir — hub → Linear *(backend hub)*
Le hub peut pousser ses tickets de façon unidirectionnelle vers Linear pour une visibilité humaine (idempotent, incrémental, anti-split-brain garanti — Linear n'est jamais relu comme source de vérité). Faites tourner la boucle sur le hub local rapide, observez-la dans Linear.

### 10. Observer — la web UI en localhost *(backend hub)*
Un démon localhost persistant sert un tableau en lecture seule, le détail des tickets, l'éditeur de feuille de route, les rapports, et une vue activité/débit au-dessus du même système de référence — pour que vous *observiez* la boucle sans y toucher. Les agents restent sans démon (ils se coordonnent via MCP, pas via la web UI).

---

## Cas d'usage

**Recourez à dev-loop quand** le travail est répétable, que son « terminé » est vérifiable par la machine, et que le résultat vaut les tokens — les trois filtres du loop engineering. Concrètement :

- **Un produit maintenu en continu.** Pointez PM sur un document de stratégie et laissez la boucle livrer des fonctionnalités, corriger les bugs que QA trouve, et garder la prod en bonne santé — vous relisez, vous ne codez pas à la main.
- **Un backlog sur lequel vous prenez sans cesse du retard.** Échecs CI, montées de version de dépendances, une catégorie de bug récurrente, nettoyage de dérive — déposez-les (ou laissez QA/Architect les trouver) et la boucle vide la file pendant que vous dormez.
- **Un nouveau module ou une grosse fonctionnalité.** Activez le Dev à deux niveaux : senior-dev le conçoit et le décompose ; junior-dev en construit les morceaux ; vous validez le design et relisez le résultat.
- **Durcissement de toute la base de code.** Laissez Architect auditer une dimension tournante chaque jour et déposer la dette technique ; la boucle la rembourse un incrément vérifié à la fois.
- **Surveillance permanente de la prod.** Ops transforme une dégradation confirmée en un Bug `incident` qui réintègre la boucle — une supervision qui *agit*, pas qui se contente d'alerter.
- **Produits multi-repo.** Un produit, plusieurs repos : les tickets ciblent un repo via un label, avec build/branche/déploiement par repo.

**N'y recourez pas** quand le « terminé » est subjectif (purs choix de design/de goût), que la tâche est ponctuelle (un bon prompt unique coûte moins cher qu'une boucle), ou que le résultat ne peut pas être rejeté automatiquement — une boucle sans vérification réelle ne fait que produire plus vite davantage de ce que vous ne devriez pas livrer.

> **Le coût est réel.** Les tokens sont le coût de fonctionnement, et c'est la *fréquence* qui le domine — une cadence serrée × de nombreux agents × le modèle le plus puissant, ça s'additionne. Réglez les **models** par agent à la baisse pour les rôles mécaniques, choisissez une cadence raisonnable, et surveillez le **taux d'acceptation** (vérifiés ÷ déposés) : en dessous de ~50 %, la boucle fait votre travail de relecture au lieu de vous l'épargner.

---

## Démarrage rapide

```bash
# 1. install the plugin (see Install for the persistent route)
claude --plugin-dir /path/to/dev-loop

# 2. onboard a product (operator-present, idempotent)
/dev-loop:init

# 3. dry-run first — see what it WOULD do, no writes
#    (set mode:"dry-run" in projects.json), then launch one pass:
/dev-loop:pm-agent      /dev-loop:qa-agent      /dev-loop:dev-agent

# 4. flip mode:"live" and run them on a loop (Agent View or the tmux launcher)
```

## Prérequis

- **Claude Code** avec ce plugin installé.
- Un **backend de coordination** : le **Linear MCP** (`mcp__linear-server__*`) par défaut, ou rien de plus pour le tableau sur fichiers local / le hub.
- La **CLI `gh`** authentifiée — Dev l'utilise pour git/déploiement.
- Un **repo git** pour le produit et (pour Linear) une **équipe + un projet** que la boucle peut administrer.
- Par rôle : `repoPath` (Dev), `strategyDoc` (PM), `testEnv` (QA).
- Pour le backend hub : **Node ≥ 23.6** (`node:sqlite` intégré, zéro dépendance native).

## Installation

**Rapide / dev (cette session uniquement) :**
```bash
claude --plugin-dir /path/to/dev-loop
```

**Personnel, persistant** — ajoutez un marketplace local dans `~/.claude/settings.json` :
```json
{
  "extraKnownMarketplaces": {
    "local": { "source": { "source": "local", "path": "/path/to/parent-of-dev-loop" } }
  }
}
```
puis `/plugin install dev-loop@local`. Les skills apparaissent sous les noms `/dev-loop:pm-agent`,
`/dev-loop:qa-agent`, `/dev-loop:dev-agent`, `/dev-loop:sweep-agent`,
`/dev-loop:reflect-agent`, `/dev-loop:ops-agent`, `/dev-loop:architect-agent`,
`/dev-loop:director-agent`, les `/dev-loop:senior-dev-agent` +
`/dev-loop:junior-dev-agent` à activer, et `/dev-loop:init`.

Hub autonome (indépendant de Claude, pour les CLI non-Claude) : `npm i -g dev-loop` fournit la
CLI `dev-loop` (`serve`, `shim`, `daemon up|down|status`, `doctor`, …).

## Configuration

Les réglages par projet résident dans `${CLAUDE_PLUGIN_DATA}/projects.json`
(`~/.claude/plugins/data/dev-loop/projects.json`). Initialisez depuis l'exemple :

```bash
mkdir -p ~/.claude/plugins/data/dev-loop
cp config/projects.example.json ~/.claude/plugins/data/dev-loop/projects.json
# then map each project → repo, strategy doc, test env, git/deploy flags
```

Les réglages (tous par projet) :
- **`mode`** — `"dry-run"` (analyse + affichage, aucune écriture) vs `"live"` (crée/fait transiter les tickets et, pour Dev, commit/push/déploie selon `git`/`deploy`).
- **`autonomy`** — `"ask"` (escalade les décisions réservées à l'humain) vs `"full"` (décide et agit).
- **`backend`** — `"linear"` (par défaut) / `"local"` (tableau sur fichiers) / `"service"` (le hub). Voir [Backends](#backends).
- **`models`** — modèle par agent au lancement ; **`opus` par défaut**. Réglez à la baisse les agents mécaniques/à haute fréquence (`sonnet`/`haiku`). Le Dev à deux niveaux a pour défauts senior=opus, junior=sonnet.
- **`repos[]`** *(optionnel)* — un produit, plusieurs repos (sinon mono-repo, 100 % inchangé).
- **`reports.sink`** *(optionnel)* — `"files"` (par défaut) vs `"linear"` (héberge les rapports + 点评 dans Linear pour un runtime cloud/distant).
- **`notify`** *(optionnel)* — webhook Slack/Lark pour vous alerter quand un ticket est mis en attente humaine.
- **`director`** *(optionnel, hub)* — active le tableau de discussion + la feuille de route + le canal bidirectionnel.

Référence complète : [`references/config-schema.md`](references/config-schema.md).

## Configurer un projet

**Lancez `/dev-loop:init` une fois** (ci-dessus) — il échafaude tout et affiche une checklist de mise en route avant votre passage en live. Il ne crée que ce qui manque et n'écrase rien. Par sécurité, les agents de la boucle réappliquent aussi les vérifications de labels/projet lors de la première exécution `live`.

## Lancer la boucle

Le plugin **ne fournit aucun harnais** — choisissez comment déclencher les agents :

- **Agent View** (natif) — `claude agents`, puis lancez chacun comme une session auto-bouclée :
  `/loop 5m /dev-loop:pm-agent`, `/loop 5m /dev-loop:qa-agent`, `/loop 5m /dev-loop:dev-agent`,
  `/loop 30m /dev-loop:sweep-agent`, `/loop 24h /dev-loop:reflect-agent`, plus les agents
  externes à activer (`ops`, `architect`, `director`).
- **Un lanceur tmux local** — un volet par agent, les modèles de chaque agent en une seule commande. Mettez
  `DEV_SPLIT=1` pour exécuter le Dev à deux niveaux (volets senior-dev + junior-dev) au lieu d'un seul `dev`.
- **Manuellement**, un tour à la fois, pour une passe unique.

**Cadence** (ils s'auto-régulent, donc les déclenchements à vide sont des no-op bon marché) : PM/QA/Dev ~5 min, Sweep
~30 min, Reflect quotidien ; Ops ~10 min, Architect/Director quotidien/à la demande.

**La reprise est un non-événement** — les agents sont sans état à chaque déclenchement. Après un arrêt, un crash ou un redémarrage, relancez-les simplement ; chacun relit la réalité de terrain et continue.

> ⚠️ **`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = commits, pushes et
> déploiements en prod sans surveillance, sans aucun garde-fou humain.** C'est la puissance
> recherchée — mais essayez d'abord `mode:"dry-run"` (ou une unique passe `MODE=once`) pour voir ce qu'il ferait.

📖 Guide complet — onboarding, méthodes de lancement, modèles, reprise, arrêt : [`docs/RUNNING.md`](docs/RUNNING.md).

## Backends

La coordination est enfichable ; les agents et les protocoles sont identiques pour les trois.

| Backend | Description | Ce que ça vous apporte |
|---|---|---|
| **`linear`** *(par défaut)* | Coordination via le Linear MCP | Cloud, visible par l'équipe, l'application Linear comme UI |
| **`local`** | Un tableau sur fichiers markdown, local à la machine, dans le répertoire de données | Zéro cloud, minimal, sans Linear |
| **`service`** | Un **hub** local — un système de référence MCP au-dessus de `node:sqlite` | **Véritable identité propre à chaque agent**, une **web UI** en localhost, des documents versionnés publiés par l'opérateur, le tableau de discussion + Director, le canal bidirectionnel, le miroir Linear unidirectionnel, la portabilité entre CLI |

Le **plan de travail** (états, transitions, qui-fait-quoi, la boucle d'agents) est identique d'un backend à l'autre ; le **plan de surface** (identité par agent, web UI, tableau/Director) est un sur-ensemble délibéré, propre à chaque backend. Voir [conventions §18](references/conventions.md) +
[`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md).

## Périmètre de sécurité

Les agents n'opèrent **que** sur les tickets portant le label **`dev-loop`**, circonscrits au projet configuré. Ils ne lisent, ne font transiter ni ne commentent jamais aucun autre ticket. Ce label unique est le pare-feu entre la boucle et votre backlog humain — considérez-le comme porteur.

## Auto-évolution

`reflect-agent` est ce qui permet à la boucle de s'améliorer sans sombrer dans le chaos :
- Il lit la production **propre** de la boucle et distille les motifs **récurrents** (≥2 occurrences, chacune citant des ID de ticket / des SHA de commit) dans `lessons.md` — la couche de surcharge par opérateur que chaque agent lit en tête de chaque exécution.
- **La limite stricte** ([conventions §17](references/conventions.md)) : Reflect peut éditer `lessons.md` de façon autonome (local, réversible, jamais commité), mais **ne doit pas** réécrire automatiquement les SKILL ou `conventions.md`. Les changements structurels sont **rédigés sous forme de propositions** que l'opérateur applique par git commit. L'auto-modification du cœur est *exposée, pas exécutée* — l'unique exception de principe au « décider et agir ».

## Rapports et revue de l'opérateur (点评)

Vous pilotez la boucle en relisant sa trace — sans modifier de code.
- **Rapports.** Chaque agent écrit un journal quotidien, agrégé par semaine/mois sous `${CLAUDE_PLUGIN_DATA}/<project-key>/reports/<agent>/` — local à la machine, jamais commité, sans secret/PII. Un déclenchement no-op n'écrit rien.
- **点评.** Déposez un `<report>.review.md` voisin avec du texte libre ; à son exécution suivante, l'agent distille votre critique en une règle `lessons.md` placée dans sa propre section, et la respecte ensuite. La boucle complète : **rapport → votre 点评 → leçon → comportement modifié.**
- **Cloud/distant ?** Mettez `reports.sink:"linear"` et les rapports deviennent des documents Linear par agent avec le 点评 en commentaire — à lire et critiquer depuis un navigateur/téléphone (même pare-feu, garde-fous §16).

## Intégration Codex (optionnelle)

La boucle peut utiliser **OpenAI Codex** comme outil de renfort via le compagnon
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) + la CLI `codex`.
**À activer ; absent ⇒ 100 % inchangé.** Elle ajoute (chacun avec son propre garde-fou indépendant) : une **revue indépendante par un second modèle** (Dev étape 5.5 + Architect ; consultative, ne touche jamais au tableau), la **génération d'images** (maquettes PM + assets de production Dev — la seule chose que la boucle ne peut pas faire elle-même), et un **sauvetage** ponctuel avant un blocage `fix-exhausted`. Voir
[conventions §24](references/conventions.md) + [`references/codex-integration.md`](references/codex-integration.md).

## Documentation approfondie

- [`references/conventions.md`](references/conventions.md) — la spécification de référence (machine à états, labels, chaque protocole). Chaque agent la lit en premier.
- [`references/config-schema.md`](references/config-schema.md) — la référence complète des champs de `projects.json`.
- [`docs/RUNNING.md`](docs/RUNNING.md) — onboarding, méthodes de lancement, modèles, reprise.
- [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md) — le hub local / le backend `service`.
- [`docs/DAEMON.md`](docs/DAEMON.md) — la web UI en localhost + le démon.
- [`docs/PORTABILITY.md`](docs/PORTABILITY.md) — faire tourner la boucle sur un second CLI (Codex / opencode).
- [`docs/design/`](docs/design/) — les dossiers de conception (choix du backend, repositionnement du démon, le découpage du Dev à deux niveaux).
- [`CHANGELOG.md`](CHANGELOG.md) — l'historique complet des versions.

## Statut

**v0.22.0.** Dix agents — cinq internes (**PM / QA / Dev**, plus le **senior-dev / junior-dev** à deux niveaux, à activer) et trois externes (**Ops / Architect / Director**) — plus l'agent d'entretien **Sweep**, l'agent d'auto-évolution **Reflect**, et la commande d'onboarding `init`. La coordination est enfichable par backend : **Linear** (par défaut), un **tableau sur fichiers local**, ou le **hub local** (système de référence `node:sqlite` avec identité par agent + une web UI en localhost + des documents versionnés + le tableau de discussion/Director + un canal Lark/Slack bidirectionnel + un miroir Linear unidirectionnel + la portabilité entre CLI). Récemment : le **Dev à deux niveaux** (senior conçoit / junior implémente, à activer, rétrocompatible) ; le **packaging npm autonome** (`npm i -g dev-loop`) avec un parcours multi-CLI certifié Codex ; et la **gouvernance du coût de boucle** (un coupe-circuit en cas d'emballement/d'absence de progrès, une métrique de taux d'acceptation). Validé de bout en bout et éprouvé au combat sur de longues exécutions en live ; l'autonomie (push/déploiement) est à activer par projet et conditionnée à un build vert. Historique complet dans [`CHANGELOG.md`](CHANGELOG.md).
