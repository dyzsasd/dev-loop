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

Trois commandes, rien à configurer — le backend **service** par défaut (un hub sqlite local
intégré + un board web) ne dépend d'aucun service externe et ne demande ni plugin ni MCP :

```bash
npm i -g @dyzsasd/dev-loop        # Node ≥ 23.6 ; installe le CLI `dev-loop`
dev-loop init                     # setup guidé — Entrée accepte chaque défaut (ou --yes)
dev-loop run                      # un scheduler pilote toute l'équipe ; ^C arrête tout
```

Vous préférez tout configurer **en discutant** ? `dev-loop up` échafaude le workspace et vous place
directement dans une console-opérateur conversationnelle (Claude Code ou opencode) qui exécute les
verbes de setup pour vous — le même verbe déploie à distance (`up --bundle`, une archive chiffrée
config+secrets+board) et pilote une instance distante depuis votre machine (`dev-loop attach <url>`).
Voir `docs/RUNNING.md` → One-click et `deploy/` (Docker/Kubernetes/systemd).

`init` crée le workspace et votre premier project (la ligne du board hub est auto-seedée),
propose d'enregistrer votre premier repo (`--detect` lit les faits build/CI directement dans
le clone), puis se termine par le verdict du doctor et une ligne `NEXT:` qui nomme l'étape la
plus bloquante. Ce que vous obtenez :

- une **web UI multi-project** : `dev-loop hub start` → `http://127.0.0.1:8787` — un index
  des projects à `/`, et pour chaque project les pages board, détail de ticket, activity et
  docs sous `/p/<key>/` (`dev-loop run` le démarre aussi automatiquement ;
  `dev-loop hub status` pour l'inspecter) ;
- des agents qui atteignent le board directement via le CLI `dev-loop` — avec Claude Code
  ou Codex sur le backend service, il n'y a rien d'autre à installer (`hub.agentInterface`
  est l'interrupteur par coding agent ; `"mcp"` restaure le câblage MCP injecté) ;
- des défauts sûrs : `mode: dry-run` (prévisualisez avec `dev-loop run --once --dry-run`,
  basculez avec `dev-loop team set team.mode live`), les déploiements `prod` restent
  manuels, autonomy guarded — `dev-loop doctor` réimprime à tout moment le verdict et la
  ligne `NEXT:`.

Un **workspace** est à la fois un dossier, une équipe, un backend (le hub local, ou une
Linear team) et un fichier `dev-loop.json`. Les repos sont de vrais clones dans ce dossier ;
les projects sont des regroupements virtuels de repos. Tout l'état vit dans
`<workspace>/.dev-loop/`, donc **copier le dossier permet de changer de machine**.

### Utiliser Linear comme backend

`dev-loop init --backend linear` demande le nom de la Linear team (ou le diffère — remplissez
plus tard avec `dev-loop team set team.linearTeam "My Team"`). L'onboarding Linear se fait
dans Claude Code, donc deux configurations uniques s'appliquent à ce backend :

- Configurez le **Linear MCP** dans le **user scope** de Claude Code (`dev-loop doctor`
  signale `W05` si les stewards n'arrivent pas à lire le board).
- Enregistrez le marketplace plugin basé sur npm pour les commandes slash `/dev-loop:*`,
  puis lancez dans Claude Code les deux commandes `/plugin ...` affichées par le CLI :

```bash
dev-loop install-claude-plugin
```

Ensuite, dans Claude Code : `/dev-loop:add-project` (trouve ou crée le project Linear, les
labels et le strategy doc) et `/dev-loop:add-repo` (clone le repo + détecte build/CI + demande
deploy et health probe). Vérifiez et lancez exactement comme ci-dessus : `dev-loop doctor`,
`dev-loop run --once --dry-run`, `dev-loop run`.

### Passer sur une autre machine

```bash
dev-loop hub stop                 # seulement pour les équipes service ; effectue un checkpoint du WAL
rsync -a ~/work/my-team/ newhost:~/work/my-team/
# sur la nouvelle machine : installez le CLI et votre coding CLI, gh auth
cd ~/work/my-team && dev-loop team repair && dev-loop doctor && dev-loop run
```

`dev-loop.json` ne garde que les **noms** des variables d'environnement — jamais une valeur
secrète, la configuration reste donc partageable. Les valeurs vivent dans
`.dev-loop/secrets.env` (ou dans l'environnement du shell, qui a priorité), et ce fichier
voyage avec le dossier : les notifications fonctionnent sur la nouvelle machine sans aucune
configuration shell. Gardez le canal de transfert privé, ou excluez le fichier
(`rsync --exclude .dev-loop/secrets.env`) et recréez-le sur place.

## Prérequis

- **Node ≥ 23.6** et un coding CLI dans le `PATH` : `claude` (Claude Code), `codex` et/ou
  `opencode` (opencode atteint n'importe lequel de ses 75+ fournisseurs de modèles via des
  chaînes `provider/model-id` — voir `docs/RUNNING.md`).
- Un backend : rien — le **service hub** intégré (sqlite local + web UI, le défaut) ne
  dépend d'aucun service externe — ou **Linear** (le Linear MCP configuré dans le user
  scope de Claude Code).
- **Backend Linear uniquement** (ou si vous voulez les commandes slash `/dev-loop:*` dans
  Claude Code) : exécutez `dev-loop install-claude-plugin`, puis, dans Claude Code, les
  commandes `/plugin marketplace add ...` et `/plugin install ...` qu'il affiche. Sur le
  backend service, les agents atteignent le board via le CLI `dev-loop` lui-même — aucun
  plugin ni MCP à configurer.
- Le CLI **`gh`** authentifié, pour les repos qui atterrissent via des PR (`landing:"pr"` —
  la forme par défaut d'`add-repo` ; Dev ouvre et merge les PR avec). Les repos
  `landing:"direct"` n'en ont pas besoin.
- Par project : un git repo, un strategy doc et une test environment URL.

## Configuration

Toute la configuration vit dans **`dev-loop.json`** (schéma workspace 1.x) à la racine du workspace.
Elle est écrite par `team init` et par des mutators validés ; en pratique, vous la modifiez
rarement à la main. Le chemin d'édition est
**`dev-loop team set <path> <value>`**, un mutator mono-champ à liste blanche
(`team.mode`, `team.comms.*`, `projects.<k>.intake.mode`, `projects.<k>.communication.*` …) :

- `workspaceId` — une empreinte que `team init` frappe une seule fois ; sur Linear, elle
  marque le project, ce qui permet de détecter deux workspaces pilotant en double la même
  Linear team.
- `team` — backend, plafond de deploy policy (`prod` reste manual sauf instruction explicite),
  `comms` (channel Slack/Lark stocké comme *nom* de variable d'environnement ; sa présence
  est aussi ce qui active le digest quotidien du director), les défauts `intake` au niveau
  team (les projects les surchargent champ par champ), `hub.agentInterface` (backend
  service : comment les fires atteignent le board du hub — `"cli"` par défaut pour Claude
  Code, Codex et opencode ; `"mcp"` est l'interrupteur de rollback) et la cadence par agent.
- `repos` — registre physique : chemin, commandes build/typecheck, PR merge checks,
  forme du deploy, health probes.
- `projects` — unités de livraison virtuelles qui référencent des repos : strategy doc,
  test environment, `weight` (`0` = rotation delivery en pause, les stewards continuent de
  couvrir le project), `intake.mode` (`autonomous` par défaut ; `passive` = le PM n'origine
  plus rien et ne répond qu'aux demandes explicites `needs-pm` — vérification et grooming
  continuent), `intake.todoDepthCap` (profondeur de la file engagée que le PM maintient,
  10 par défaut), overrides de lancement par agent (`agents.pm = { model, effort, cadence }`,
  etc.), plus les blocs optionnels strictement validés `communication` (rédaction d'articles)
  et `notify` (override de webhook par project). Ne déclarez pas de project `_team` :
  l'intake de team ne vit que sur le hub, et le chargeur de config rejette l'entrée (`E11`).

Référence complète des champs : [`references/config-schema.md`](references/config-schema.md).
Spécification du comportement des agents :
[`references/conventions.md`](references/conventions.md).

## Lancer la loop

Un seul `dev-loop run` pilote toute l'équipe : les delivery agents tournent entre les projects
activés (weighted round-robin ; `weight: 0` met en pause la rotation delivery d'un project
pendant que les stewards continuent de le couvrir), les stewardship agents
(sweep/ops/reflect/communication) se déclenchent au niveau team, et chaque agent utilise son
propre model et son propre reasoning effort.

```bash
dev-loop run                              # tous les agents, cadences par défaut
dev-loop run --agents core,ops            # choisir des agents/groupes (core = pm,qa,senior-dev,junior-dev,sweep)
dev-loop run --plan 8 --agents pm         # prévisualiser les 8 prochains choix de project, sans déclencher
dev-loop run --interval pm=2m --max-fires 50   # override de cadence + plafond de coût
dev-loop run --change-gate --fire-timeout 45m  # éviter les fires silencieux + tuer les fires bloqués
dev-loop run --once --dry-run             # imprimer les commandes résolues, sans lancer
```

`--change-gate` (backend service) saute un fire inward quand ni le HEAD d'aucun repo ni le
board n'ont bougé depuis son dernier run — sauf pm/qa, dont le travail de review/couverture
est à son meilleur sur un board calme : un board inchangé ne fait que les *différer*, et après
`--change-gate-ttl` (4h par défaut) ils tournent quand même une fois. Les tiers dev +
architect gardent le gate pur.

Vous préférez l'Agent View de Claude Code ? Chaque ligne `/loop` appelle d'abord
`dev-loop next-project --agent <a>`. Les lignes `/loop` et le scheduler partagent le même
rotation cursor, ce qui évite les déclenchements en double.

### Référence rapide des commandes

| Commande | Rôle |
|---|---|
| `dev-loop init [--dir d] [--backend service\|linear] [--yes]` | onboarding guidé : workspace + premier project/repo, se termine sur la ligne `NEXT:` du doctor |
| `dev-loop install-claude-plugin` | enregistre le marketplace plugin Claude Code basé sur npm et affiche les deux commandes `/plugin` |
| `dev-loop team init / import / repair` | créer un workspace / migrer une config v1 / réparer après un changement de machine |
| `dev-loop team set <path> <value>` | l'édition de config mono-champ à liste blanche (p. ex. `team.mode live`) |
| `dev-loop team add-project / add-repo [--detect]` | écritures de config validées ; `--detect` lit les faits build/CI directement dans le clone |
| `/dev-loop:add-project` · `/dev-loop:add-repo` · `/dev-loop:sync-project` · `/dev-loop:sync-repo` | skills de coding CLI : sync backend, clone + détection, correction de drift |
| `dev-loop run [--plan n] [--project k] [--once] [--dry-run]` | team scheduler |
| `dev-loop doctor` | diagnostic en lecture seule (validation de config, probes, fire success) + la ligne `NEXT:` |
| `dev-loop metrics [--window 7d] [--json] [--context]` | KPI de team : fire success, throughput, accept rate, QA escape ratio ; `--context` = la facture de contexte par agent et par fire |
| `dev-loop notify [--level info\|warn\|error] [--title t] <text>` | envoie un message au channel Slack/Lark de l'équipe |
| `dev-loop hub start\|stop\|status\|ensure` | daemon du hub local (backend service ; `stop` effectue un checkpoint du WAL) |
| `dev-loop next-project --agent <a>` | sélecteur partagé de rotation pour les lignes `/loop` dans Agent View |
| `dev-loop with-repo-lock <ref> -- <cmd>` | sérialise les opérations base-clone sur un repo partagé |
| `dev-loop export-desktop-skill <agent> --project <k> [--team]` | génère un skill Claude Desktop autonome |

Le **hub write layer** — les mêmes verbes que les agents utilisent sur le backend service
(`hub.agentInterface: "cli"`) ; pratique aussi pour scripter le board vous-même :

| Commande | Rôle |
|---|---|
| `dev-loop tickets [--state S] [--label L] [--q TEXT] [--json] …` | liste du board en lecture seule (flags de filtre ; `--json` = sortie au format op) |
| `dev-loop ticket <id> [--json]` | détail d'un ticket en lecture seule + commentaires |
| `dev-loop ticket create\|update …` | sucre d'écriture (attention : `--labels` REMPLACE l'ensemble complet ; `--related-to` est append-only) |
| `dev-loop comment add <id>` · `comments <id>` | commenter un ticket / lister ses commentaires |
| `dev-loop labels` · `label create <name> [--kind K]` | lister / créer des labels |
| `dev-loop project` · `events [--since ISO]` | le project actif en JSON / les événements d'attribution |
| `dev-loop doc list\|get\|history\|diff\|save\|publish\|archive` | la famille doc (`save` = CAS optimiste ; `publish` réservé à l'operator ; `archive` masque un design doc retiré, sans jamais supprimer) |
| `dev-loop mirror push\|poll\|status` | le mirror Linear à sens unique ; `poll` convertit les commentaires humains sur les docs mirrorés en intake `needs-pm` |
| `dev-loop op <op-name> [--args-json '<JSON>']` | dispatche N'IMPORTE QUEL op du hub via le même point de passage `agentOp()` (identity + guards inclus) |

Codes de sortie du write layer : `0` ok · `1` erreur de domaine · `2` usage · `3` conflit
CAS de doc · `4` identity/guard · `5` hub indisponible. Les commandes bas
niveau/compatibilité comme `dev-loop daemon ...`, `seed`, `init-service`, `serve`, `shim` et
`mcp-merge` existent encore. Pour un nouveau workspace 1.x, commencez normalement par
`init`, `team`, `hub` et `run`.

## Au quotidien

- **Le nouveau travail arrive dans `Backlog`**. Le PM trie, déduplique et promeut vers `Todo`
  en respectant le plafond de profondeur, pour éviter de noyer le board. Vos propres demandes
  doivent aussi être créées comme tickets `Backlog` avec les labels `dev-loop`, `pm` et `needs-pm` —
  depuis le formulaire de ticket de la web UI du hub, le CLI ou Linear ; le PM les prendra en
  charge. N'envoyez pas le travail directement à un dev.
- **Les changements de direction passent par le protocole d'investigation** : ajoutez le label
  `investigation` à votre demande `needs-pm` et le PM enquête d'abord, poste ses conclusions,
  propose le changement de doc (un brouillon de doc hub + une ligne `Proposes:`, ou un unified
  diff sur le ticket) et gare le ticket en `In Review` pour vous — votre publish lié à la
  version (ou votre commentaire d'approbation) EST l'approbation ; rien ne change avant.
- **Les changements sensibles** (auth, paiements, PII, secrets, migrations de données) passent
  toujours par un design senior avant le code. C'est automatique et sans demande de confirmation.
- **Quand l'équipe se gare sur vous** (`Human-Blocked`), le hub vous relance sur votre channel —
  toutes les 24h par défaut une fois comms configuré — en nommant la commande exacte de reprise.
  Les brouillons de doc en attente apparaissent comme un chip d'en-tête dans la web UI ; un
  brouillon qui attend votre publish depuis plus de 24h reçoit aussi une ligne comms dédupliquée.
- **Un digest quotidien** arrive sur Slack/Lark : KPI de team (depuis `dev-loop metrics`), qualité QA,
  flux du board, north-star delta, propositions d'investigation en attente et section
  "needs the director". Les bons jours, cette section est vide. Les incidents sont envoyés
  immédiatement ; la récupération ferme ensuite la boucle.
- **Les reports** s'accumulent par agent, en fichiers ou dans Linear docs via `reports.sink`.
  Reflect produit aussi une retrospective d'équipe chaque semaine.

## Les agents

| Agent | Mission | Cadence |
|---|---|---|
| **PM** | strategy doc → tickets ; trie et promeut le Backlog ; vérifie les features | 5m, par project |
| **QA** | teste le produit, ouvre des bugs, reteste les corrections | 5m, par project |
| **senior-dev** | conçoit les modules et les changements sensibles ; délègue ; prend les escalades | 5m, par project |
| **junior-dev** | implémente les tickets déjà conçus et cadrés | 5m, par project |
| **Sweep** | hygiène du board, réparations de cycle de vie, pilote le mirror Linear optionnel | 30m, niveau team |
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
- [`docs/design/`](docs/design/) — design records : la ligne 1.0 team/workspace (proposition, spec engineering, checklist GA), le [registre des décisions de la review 2026-07](docs/design/2026-07-review-decisions.md) derrière la 1.2.0 et le [template de SKILL](docs/design/skill-template.md).
- [`docs/RUNNING.md`](docs/RUNNING.md) · [`docs/PORTABILITY.md`](docs/PORTABILITY.md) · [`docs/DAEMON.md`](docs/DAEMON.md) — notes d'exploitation pour l'exécution, la portabilité et le service hub.
- [`CHANGELOG.md`](CHANGELOG.md) — historique des versions.

## Release

Les releases sont publiées depuis `main` par le workflow GitHub Actions **Release npm package** :
il écrit la version, lance la suite de tests, publie avec provenance et crée le tag. Voir
[`docs/RELEASING.md`](docs/RELEASING.md).

## Licence

[MIT](LICENSE).
