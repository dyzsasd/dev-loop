# dev-loop

[English](README.md) · **中文** · [Français](README.fr.md)

**一个文件夹里的自主开发团队。** 九个可以直接启动的 agent（PM、QA、senior/junior Dev、
Sweep、Reflect、Ops、Architect、Communication）会围绕工单状态协作，帮你构建、测试、
发布、监控软件，并说明进展。后端可以接 Linear，也可以用内置的本地 hub。你只需要把目标写进
strategy doc，每天读一条 digest；其余工作交给团队推进。

你是 **director**，不是 reviewer：所有工作都先交给 PM，不直接派给 dev；涉及权限、支付、
PII、密钥或数据迁移的敏感改动，先由 senior 出设计；验收由独立角色完成，不依赖实现者的自述。
团队的动作都会沉淀成报告和指标，让你每天用一条消息掌握全局。

> 想了解内部机制，包括分层、协议、后端和自我演进，请看
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。这份 README 只讲**怎么使用**。

---

## 快速开始

三条命令，零配置——默认的 **service** backend（内置的本地 sqlite hub + web 看板）不依赖任何
外部服务，也不需要安装 plugin 或配置 MCP：

```bash
npm i -g @dyzsasd/dev-loop        # Node ≥ 23.6；安装 `dev-loop` CLI
dev-loop init                     # 引导式初始化——一路回车接受默认值（或用 --yes）
dev-loop run                      # 一个 scheduler 驱动整支团队；按 ^C 停止全部任务
```

`init` 会创建 workspace 和你的第一个 project（hub 看板行自动 seed），并提议注册第一个
repo（`--detect` 直接从 clone 里读取 build/CI 事实），最后打印 doctor 结论和一行 `NEXT:`，
指出当前最需要做的一步。你会得到：

- 一块 **web 看板**：`dev-loop hub start` → `http://127.0.0.1:8787`（`dev-loop run`
  也会自动启动它；用 `dev-loop hub status` 查看状态）；
- agent 直接通过 `dev-loop` CLI 访问看板——在 service backend 上配合 Claude Code，
  不需要再安装任何东西；
- 安全的默认值：`mode: dry-run`（用 `dev-loop run --once --dry-run` 预览，用
  `dev-loop team set team.mode live` 切换）、`prod` 部署保持手动、autonomy 为 guarded——
  随时可以用 `dev-loop doctor` 重新打印结论和 `NEXT:` 行。

一个 **workspace** 就是一个目录、一支团队、一个 backend（本地 hub 或一个 Linear team），
以及一份 `dev-loop.json`。repo 是 workspace 里的真实代码 clone；project 是对 repo 的虚拟
分组。所有状态都放在 `<workspace>/.dev-loop/` 下，所以**复制整个文件夹就能搬到另一台机器**。

### 使用 Linear 作为 backend

`dev-loop init --backend linear` 会询问 Linear team 的名字（也可以先跳过，之后用
`dev-loop team set team.linearTeam "My Team"` 补上）。Linear 的 onboarding 在 Claude Code
里进行，因此这个 backend 需要两项一次性配置：

- 把 **Linear MCP** 配在 Claude Code 的 **user scope** 下（如果 steward 无法访问看板，
  doctor 会提示 `W05`）。
- 注册 npm 版 plugin marketplace 以获得 `/dev-loop:*` slash command，然后把 CLI 打印出的
  两条 `/plugin ...` 命令粘到 Claude Code 里执行：

```bash
dev-loop install-claude-plugin
```

之后在 Claude Code 里运行：`/dev-loop:add-project`（查找或创建 Linear project、label 和
strategy doc）和 `/dev-loop:add-repo`（clone repo + 检测 build/CI 检查 + 询问 deploy 与
health probe）。检查和运行的方式与上面完全相同：`dev-loop doctor`、
`dev-loop run --once --dry-run`、`dev-loop run`。

### 换到另一台机器

```bash
dev-loop hub stop                 # 仅 service team 需要；会对 WAL 做 checkpoint
rsync -a ~/work/my-team/ newhost:~/work/my-team/
# 在新机器上：安装 CLI 和你的 coding CLI，完成 gh auth，并 export 所需环境变量
cd ~/work/my-team && dev-loop team repair && dev-loop doctor && dev-loop run
```

secret 不会写进 workspace；配置里只保存环境变量的**名字**。因此 workspace 文件夹可以安全复制。

## 环境要求

- **Node ≥ 23.6**，并且 `PATH` 上有 coding CLI：`claude`（Claude Code）和/或 `codex`。
- 若要在 Claude Code 中使用 slash command：先运行 `dev-loop install-claude-plugin`，
  再在 Claude Code 里执行它打印出的 `/plugin marketplace add ...` 和 `/plugin install ...`。
- 已登录的 **`gh` CLI**，供 Dev 创建和合并 PR。
- 一个 backend：可以是 **Linear**（Linear MCP 配在 Claude Code user scope），也可以什么外部服务都不用，
  直接使用内置的 **service hub**(本地 sqlite + web UI)。
- 每个 project 需要：一个 git repo、一份 strategy doc、一个 test environment URL。

## 配置

所有配置都在 workspace 的 **`dev-loop.json`**（1.x workspace schema）里。它由 `team init` 和带校验的
mutator 写入，通常不需要手动编辑：

- `team` — backend、deploy policy 上限（`prod` 默认保持 manual，除非你明确允许自动化）、
  `comms`（Slack/Lark channel，对应环境变量名），以及各 agent 的 cadence。
- `repos` — 物理 repo 注册表：路径、build/typecheck 命令、PR merge check、deploy 形态、
  health probe。
- `projects` — 引用 repo 的交付单元：strategy doc、test environment、`intake.mode`
  （默认 `autonomous`；`passive` = PM 不再自主发起工作，只响应显式的 `needs-pm`
  请求——验证与 grooming 照常进行）、`intake.todoDepthCap`
  （PM 维持的已承诺队列深度，默认 10），以及各 agent 的启动覆盖项
  (`agents.pm = { model, effort, cadence }` 等)。

完整字段参考：[`references/config-schema.md`](references/config-schema.md)。
agent 行为规范：[`references/conventions.md`](references/conventions.md)。

## 运行 loop

一条 `dev-loop run` 会驱动整支团队：delivery agent 在已启用的 project 之间按权重轮换；
stewardship agent（sweep/ops/reflect/communication）在 team scope 运行；每个 agent 都使用配置中
自己的 model 和 reasoning effort。

```bash
dev-loop run                              # 运行全部 agent，使用默认 cadence
dev-loop run --agents core,ops            # 只运行指定 agent/分组（core = pm,qa,senior,junior,sweep）
dev-loop run --plan 8 --agents pm         # 预览接下来 8 次 project 选择，不实际触发
dev-loop run --interval pm=2m --max-fires 50   # 覆盖 cadence，并设置成本上限
dev-loop run --change-gate --fire-timeout 45m  # 安静时跳过 fire，并杀掉卡住的 fire
dev-loop run --once --dry-run             # 打印解析后的命令，不启动 agent
```

如果你更喜欢 Claude Code 的 Agent View，每一行 `/loop` 都会先调用
`dev-loop next-project --agent <a>`。Agent View 和 scheduler 共用同一个 rotation cursor，
因此不会重复触发同一个 slot。

### 命令速查

| 命令 | 作用 |
|---|---|
| `dev-loop init [--dir d] [--yes]` | 引导式 onboarding：workspace + 第一个 project/repo，以 doctor 的 `NEXT:` 行收尾 |
| `dev-loop install-claude-plugin` | 注册 npm 版 Claude Code plugin marketplace，并打印两条 `/plugin` 命令 |
| `dev-loop team init / repair` | 创建 workspace / 换机后修复 |
| `dev-loop team add-project / add-repo` | 带校验的配置写入（`/dev-loop:*` skill 会调用这些命令） |
| `/dev-loop:add-project` · `/dev-loop:add-repo` · `/dev-loop:sync-project` · `/dev-loop:sync-repo` | coding CLI skill：同步 backend、clone 并检测 repo、修正 drift |
| `dev-loop run [--plan n] [--project k] [--once] [--dry-run]` | team scheduler |
| `dev-loop doctor` | 只读健康检查，覆盖配置校验、probe 和 fire success |
| `dev-loop metrics [--window 7d] [--json]` | team KPI：fire success、throughput、accept rate、QA escape ratio |
| `dev-loop notify [--level info\|warn\|error] [--title t] <text>` | 推送消息到 team 的 Slack/Lark channel |
| `dev-loop hub start\|stop\|status\|ensure` | 本地 hub daemon（service backend；`stop` 会对 WAL 做 checkpoint） |
| `dev-loop next-project --agent <a>` | Agent View `/loop` 行使用的共享 rotation picker |
| `dev-loop with-repo-lock <ref> -- <cmd>` | 串行化共享 repo 上的 base-clone 操作 |
| `dev-loop export-desktop-skill <agent> --project <k> [--team]` | 渲染自包含的 Claude Desktop skill |

`dev-loop daemon ...`、`seed`、`init-service`、`serve`、`mcp-merge` 等底层兼容/调试命令仍然存在。
新的 1.x workspace 用户通常应该从 `team`、`hub` 和 `run` 这组命令开始。

## 日常会看到什么

- **新工作先进入 `Backlog`**。PM 会整理、去重，并在深度上限内提升到 `Todo`，避免看板被淹没。
  你自己的需求也应该建成带有 `dev-loop`、`pm`、`needs-pm` label 的 `Backlog` ticket，由 PM 接手；
  不要直接给 dev 建任务。
- **敏感改动**（auth、payments、PII、secret、data migration）一律先经过 senior design，再进入实现；
  这个流程会自动完成，不会要求你反复确认。
- **daily digest** 会发到你的 Slack/Lark channel，包含 team KPI（来自 `dev-loop metrics`）、QA 质量、
  board flow、north-star delta，以及一个 "needs the director" 小节。正常情况下，这一节应该是空的。
  incident 会立即通知；恢复后会再补一条闭环消息。
- **report** 会按 agent 累积，可以落在文件里，也可以通过 `reports.sink` 写入 Linear docs。
  Reflect 会每周产出 team retrospective。

## Agents

| Agent | 职责 | 触发节奏 |
|---|---|---|
| **PM** | 从 strategy doc 生成 ticket；整理并提升 Backlog；验收 feature | 5m，按 project |
| **QA** | 测试产品、提交 bug、复测修复 | 5m，按 project |
| **senior-dev** | 设计模块和敏感改动；分派工作；处理升级 | 5m，按 project |
| **junior-dev** | 实现已设计、已圈定范围的 ticket | 5m，按 project |
| **Sweep** | 看板卫生、生命周期修复、tracker 维护 | 30m，team scope |
| **Ops** | 轮询 prod health，确认 incident 后建单并通知 | 10m，team scope |
| **Reflect** | retrospective、lessons library、north-star delta | 每日，team scope |
| **Architect** | 全代码库 tech-debt audit | 每日，按 project |
| **Communication** | daily director digest 和文章草稿 | 每日，team scope |

完整角色契约和协议见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) +
[`references/conventions.md`](references/conventions.md)。

## 文档

- [`docs/INDEX.md`](docs/INDEX.md) — 区分当前指南和历史设计记录。
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — contributor 本地开发、测试、构建和文档规则。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 分层、工作流、backend、安全和自我演进。
- [`references/conventions.md`](references/conventions.md) — agent spec，包括 state machine、label 和所有 protocol。
- [`references/config-schema.md`](references/config-schema.md) — `dev-loop.json` 字段参考。
- [`docs/design/`](docs/design/) — 1.0 team/workspace 线的设计记录，包括 proposal、engineering spec 和 GA checklist。
- [`docs/RUNNING.md`](docs/RUNNING.md) · [`docs/PORTABILITY.md`](docs/PORTABILITY.md) · [`docs/DAEMON.md`](docs/DAEMON.md) — 运行、可移植性和 service hub 的运维说明。
- [`CHANGELOG.md`](CHANGELOG.md) — 版本历史。

## 发布

release 由 `main` 分支上的 **Release npm package** GitHub Actions workflow 完成：写入版本号、
跑测试、带 provenance 发布并打 tag。详情见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 许可

[MIT](LICENSE)。
