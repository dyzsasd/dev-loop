# dev-loop

[English](README.md) · [中文](README.zh-CN.md) · **Français**

**Une équipe de développement autonome dans un dossier.** Neuf agents que vous pouvez lancer
(PM, QA, un duo Dev senior/junior, Sweep, Reflect, Ops, Architect, Communication) construisent,
testent, livrent, surveillent et expliquent votre logiciel. Ils se coordonnent uniquement
par l'état des tickets, avec Linear ou avec le hub local intégré. Vous décrivez l'intention
dans un strategy doc et vous lisez un digest quotidien ; l'équipe s'occupe du reste.

Vous êtes le **director**, pas le reviewer : le travail arrive via le PM, jamais directement
par un dev ; les changements sensibles passent d'abord par un design senior ; la vérification
est indépendante de ce que dit l'agent qui a implémenté. Tout ce que fait l'équipe finit dans
des reports et des métriques que vous pouvez lire en un seul message par jour.

> Pour le fonctionnement interne (couches, protocoles, backends, auto-évolution), voir
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Ce README explique surtout **comment l'utiliser**.

---

## Démarrage rapide

```bash
npm i -g @dyzsasd/dev-loop        # Node ≥ 23.6 ; installe le CLI `dev-loop`
```

Pour obtenir les commandes slash `/dev-loop:*` dans Claude Code, enregistrez une fois le
marketplace plugin basé sur npm, puis lancez dans Claude Code les deux commandes `/plugin ...`
affichées par le CLI :

```bash
dev-loop install-claude-plugin
```

Un **workspace** est à la fois un dossier, une équipe, une Linear team (ou un hub local) et
un fichier `dev-loop.json`. Les repos sont de vrais clones dans ce dossier ; les projects sont
des regroupements virtuels de repos. Tout l'état vit dans `<workspace>/.dev-loop/`, donc
**copier le dossier permet de changer de machine**.

```bash
# 1. Créer le workspace (pur CLI : pas de LLM, pas d'appel backend)
dev-loop team init --dir ~/work/my-team --key my-team \
  --backend linear --linear-team "My Team" --deploy dev=auto,prod=manual --comms lark
cd ~/work/my-team

# 2. Dans Claude Code (plugin installé) ou un autre coding CLI où les skills dev-loop
#    sont disponibles : créer et synchroniser un project, puis ajouter les repos
#      /dev-loop:add-project      — trouve ou crée le project Linear/hub, les labels et le strategy doc
#      /dev-loop:add-repo         — clone le repo, détecte build/CI, puis demande deploy et health probe

# 3. Vérifier, prévisualiser, lancer
dev-loop doctor                   # diagnostic de santé en lecture seule
dev-loop run --once --dry-run     # prévisualise la commande exacte de chaque agent (model + effort)
dev-loop run                      # un scheduler pilote toute l'équipe ; ^C arrête tout
```

Pour une équipe **linear**, configurez le Linear MCP dans le **user scope** de Claude Code ;
`dev-loop doctor` signale `W05` si les stewards n'arrivent pas à lire le board. Pour une
équipe **service**, `dev-loop run` démarre automatiquement le hub local ; utilisez
`dev-loop hub status` pour l'inspecter.

### Passer sur une autre machine

```bash
dev-loop hub stop                 # seulement pour les équipes service ; effectue un checkpoint du WAL
rsync -a ~/work/my-team/ newhost:~/work/my-team/
# sur la nouvelle machine : installez le CLI et votre coding CLI, configurez gh auth,
# puis exportez les variables d'environnement nécessaires
cd ~/work/my-team && dev-loop team repair && dev-loop doctor && dev-loop run
```

Les secrets ne sont jamais écrits dans le workspace : la configuration ne garde que les
**noms** des variables d'environnement. Le dossier peut donc être copié sans embarquer les secrets.

## Prérequis

- **Node ≥ 23.6** et un coding CLI dans le `PATH` : `claude` (Claude Code) et/ou `codex`.
- Pour les commandes slash dans Claude Code : exécutez `dev-loop install-claude-plugin`,
  puis les commandes `/plugin marketplace add ...` et `/plugin install ...` qu'il affiche.
- Le CLI **`gh`** authentifié, utilisé par Dev pour ouvrir et merger les PR.
- Un backend : **Linear** (Linear MCP configuré dans le user scope de Claude Code) ou aucun
  service externe, en utilisant le **service hub** intégré (sqlite local + web UI).
- Par project : un git repo, un strategy doc et une test environment URL.

## Configuration

Toute la configuration vit dans **`dev-loop.json`** (schéma workspace 1.x) à la racine du workspace.
Elle est écrite par `team init` et par des mutators validés ; en pratique, vous la modifiez
rarement à la main :

- `team` — backend, plafond de deploy policy (`prod` reste manual sauf instruction explicite),
  `comms` (channel Slack/Lark stocké comme nom de variable d'environnement) et cadence par agent.
- `repos` — registre physique : chemin, commandes build/typecheck, PR merge checks,
  forme du deploy, health probes.
- `projects` — unités de livraison qui référencent des repos : strategy doc, test environment,
  `intake.todoDepthCap` (profondeur de la file engagée que le PM maintient, 10 par défaut) et
  overrides de lancement par agent (`agents.pm = { model, effort, cadence }`, etc.).

Référence complète des champs : [`references/config-schema.md`](references/config-schema.md).
Spécification du comportement des agents :
[`references/conventions.md`](references/conventions.md).

## Lancer la loop

Un seul `dev-loop run` pilote toute l'équipe : les delivery agents tournent entre les projects
activés (weighted round-robin), les stewardship agents (sweep/ops/reflect/communication) se
déclenchent au niveau team, et chaque agent utilise son propre model et son propre reasoning effort.

```bash
dev-loop run                              # tous les agents, cadences par défaut
dev-loop run --agents core,ops            # choisir des agents/groupes (core = pm,qa,senior,junior,sweep)
dev-loop run --plan 8 --agents pm         # prévisualiser les 8 prochains choix de project, sans déclencher
dev-loop run --interval pm=2m --max-fires 50   # override de cadence + plafond de coût
dev-loop run --change-gate --fire-timeout 45m  # éviter les fires silencieux + tuer les fires bloqués
dev-loop run --once --dry-run             # imprimer les commandes résolues, sans lancer
```

Vous préférez l'Agent View de Claude Code ? Chaque ligne `/loop` appelle d'abord
`dev-loop next-project --agent <a>`. Les lignes `/loop` et le scheduler partagent le même
rotation cursor, ce qui évite les déclenchements en double.

### Référence rapide des commandes

| Commande | Rôle |
|---|---|
| `dev-loop install-claude-plugin` | enregistre le marketplace plugin Claude Code basé sur npm et affiche les deux commandes `/plugin` |
| `dev-loop team init / repair` | créer un workspace / réparer après un changement de machine |
| `dev-loop team add-project / add-repo` | écritures de config validées (appelées par les skills `/dev-loop:*`) |
| `/dev-loop:add-project` · `/dev-loop:add-repo` · `/dev-loop:sync-project` · `/dev-loop:sync-repo` | skills de coding CLI : sync backend, clone + détection, correction de drift |
| `dev-loop run [--plan n] [--project k] [--once] [--dry-run]` | team scheduler |
| `dev-loop doctor` | diagnostic en lecture seule : validation de config, probes, fire success |
| `dev-loop metrics [--window 7d] [--json]` | KPI de team : fire success, throughput, accept rate, QA escape ratio |
| `dev-loop notify [--level info\|warn\|error] [--title t] <text>` | envoie un message au channel Slack/Lark de l'équipe |
| `dev-loop hub start\|stop\|status\|ensure` | daemon du hub local (backend service ; `stop` effectue un checkpoint du WAL) |
| `dev-loop next-project --agent <a>` | sélecteur partagé de rotation pour les lignes `/loop` dans Agent View |
| `dev-loop with-repo-lock <ref> -- <cmd>` | sérialise les opérations base-clone sur un repo partagé |
| `dev-loop export-desktop-skill <agent> --project <k> [--team]` | génère un skill Claude Desktop autonome |

Les commandes bas niveau/compatibilité comme `dev-loop daemon ...`, `seed`, `init-service`,
`serve` et `mcp-merge` existent encore. Pour un nouveau workspace 1.x, commencez normalement par
`team`, `hub` et `run`.

## Au quotidien

- **Le nouveau travail arrive dans `Backlog`**. Le PM trie, déduplique et promeut vers `Todo`
  en respectant le plafond de profondeur, pour éviter de noyer le board. Vos propres demandes
  doivent aussi être créées comme tickets `Backlog` avec les labels `dev-loop`, `pm` et `needs-pm` ;
  le PM les prendra en charge. N'envoyez pas le travail directement à un dev.
- **Les changements sensibles** (auth, paiements, PII, secrets, migrations de données) passent
  toujours par un design senior avant le code. C'est automatique et sans demande de confirmation.
- **Un digest quotidien** arrive sur Slack/Lark : KPI de team (depuis `dev-loop metrics`), qualité QA,
  flux du board, north-star delta et section "needs the director". Les bons jours, cette section est
  vide. Les incidents sont envoyés immédiatement ; la récupération ferme ensuite la boucle.
- **Les reports** s'accumulent par agent, en fichiers ou dans Linear docs via `reports.sink`.
  Reflect produit aussi une retrospective d'équipe chaque semaine.

## Les agents

| Agent | Mission | Cadence |
|---|---|---|
| **PM** | strategy doc → tickets ; trie et promeut le Backlog ; vérifie les features | 5m, par project |
| **QA** | teste le produit, ouvre des bugs, reteste les corrections | 5m, par project |
| **senior-dev** | conçoit les modules et les changements sensibles ; délègue ; prend les escalades | 5m, par project |
| **junior-dev** | implémente les tickets déjà conçus et cadrés | 5m, par project |
| **Sweep** | hygiène du board, réparations de cycle de vie, suivi du tracker | 30m, niveau team |
| **Ops** | surveille prod health, crée les incidents confirmés et envoie les alertes | 10m, niveau team |
| **Reflect** | retrospectives, lessons library, north-star delta | quotidien, niveau team |
| **Architect** | audits de tech debt sur tout le codebase | quotidien, par project |
| **Communication** | digest quotidien pour le director et brouillons d'articles | quotidien, niveau team |

Contrats de rôle et protocoles complets : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) +
[`references/conventions.md`](references/conventions.md).

## Documentation

- [`docs/INDEX.md`](docs/INDEX.md) — distingue les guides actuels des design records historiques.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — développement local, tests, build et règles docs.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — couches, workflows, backends, sécurité, auto-évolution.
- [`references/conventions.md`](references/conventions.md) — agent spec : state machine, labels et tous les protocoles.
- [`references/config-schema.md`](references/config-schema.md) — référence des champs `dev-loop.json`.
- [`docs/design/`](docs/design/) — design records de la ligne 1.0 team/workspace : proposition, spec engineering, checklist GA.
- [`docs/RUNNING.md`](docs/RUNNING.md) · [`docs/PORTABILITY.md`](docs/PORTABILITY.md) · [`docs/DAEMON.md`](docs/DAEMON.md) — notes d'exploitation pour l'exécution, la portabilité et le service hub.
- [`CHANGELOG.md`](CHANGELOG.md) — historique des versions.

## Release

Les releases sont publiées depuis `main` par le workflow GitHub Actions **Release npm package** :
il écrit la version, lance la suite de tests, publie avec provenance et crée le tag. Voir
[`docs/RELEASING.md`](docs/RELEASING.md).

## Licence

[MIT](LICENSE).
