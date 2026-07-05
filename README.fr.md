# dev-loop

[English](README.md) · [中文](README.zh-CN.md) · **Français**

> La traduction française n'est plus maintenue depuis la ligne 1.0 (modèle team/workspace).
> Veuillez consulter le [README anglais](README.md) — guide d'utilisation — et
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour l'architecture.

**En bref :** une équipe de développement autonome dans un dossier. Neuf agents (PM, QA,
Dev senior/junior, Sweep, Reflect, Ops, Architect, Communication) construisent, testent,
livrent et surveillent votre logiciel en se coordonnant par l'état des tickets (Linear ou un
hub local intégré).

```bash
npm i -g @dyzsasd/dev-loop
dev-loop team init --dir ~/work/mon-equipe --key mon-equipe --backend linear --linear-team "Mon Équipe"
cd ~/work/mon-equipe
# dans Claude Code : /dev-loop:add-project puis /dev-loop:add-repo
dev-loop doctor && dev-loop run
```
