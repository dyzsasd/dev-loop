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

```bash
npm i -g @dyzsasd/dev-loop        # Node ≥ 23.6；安装 `dev-loop` CLI
```

一个 **workspace** 就是一个目录、一支团队、一个 Linear team（或一个本地 hub），以及一份
`dev-loop.json`。repo 是 workspace 里的真实代码 clone；project 是对 repo 的虚拟分组。
所有状态都放在 `<workspace>/.dev-loop/` 下，所以**复制整个文件夹就能迁移到另一台机器**。

```bash
# 1. 创建 workspace（纯 CLI，不调用 LLM，也不访问后端）
dev-loop team init --dir ~/work/my-team --key my-team \
  --backend linear --linear-team "My Team" --deploy dev=auto,prod=manual --comms lark
cd ~/work/my-team

# 2. 在 coding CLI（Claude Code / Codex）里创建并同步 project，然后添加 repo
#      /dev-loop:add-project      — 查找或创建 Linear/hub project、label 和 strategy doc
#      /dev-loop:add-repo         — clone repo，检测 build/CI 检查，并询问 deploy 与 health probe

# 3. 检查、预览、运行
dev-loop doctor                   # 只读健康检查
dev-loop run --once --dry-run     # 预览每个 agent 的完整命令，包括各自的 model + effort
dev-loop run                      # 一个 scheduler 驱动整支团队；按 ^C 停止全部任务
```

使用 **linear** backend 时，请把 Linear MCP 配在 Claude Code 的 **user scope** 下；如果 steward
无法访问看板，`dev-loop doctor` 会提示 `W05`。使用 **service** backend 时，`dev-loop run`
会自动启动本地 hub，可用 `dev-loop hub status` 查看状态。

### 从 v1（`~/.dev-loop/projects.json`）迁移

1.0 runtime **不会读取 v1 配置**。只需要迁移一次：

```bash
dev-loop team init --dir <workspace> --key <team> --backend <linear|service> ...
cd <workspace> && dev-loop team import      # 合并 project，搬迁 state，拆分 lessons
dev-loop doctor
```

### 迁移到另一台机器

```bash
dev-loop hub stop                 # 仅 service team 需要；会对 WAL 做 checkpoint
rsync -a ~/work/my-team/ newhost:~/work/my-team/
# 在新机器上：安装 CLI 和你的 coding CLI，完成 gh auth，并 export 所需环境变量
cd ~/work/my-team && dev-loop team repair && dev-loop doctor && dev-loop run
```

secret 不会写进 workspace；配置里只保存环境变量的**名字**。因此 workspace 文件夹可以安全复制。

## 环境要求

- **Node ≥ 23.6**，并且 `PATH` 上有 coding CLI：`claude`（Claude Code）和/或 `codex`。
- 已登录的 **`gh` CLI**，供 Dev 创建和合并 PR。
- 一个 backend：可以是 **Linear**（Linear MCP 配在 Claude Code user scope），也可以什么外部服务都不用，
  直接使用内置的 **service hub**(本地 sqlite + web UI)。
- 每个 project 需要：一个 git repo、一份 strategy doc、一个 test environment URL。

## 配置

所有配置都在 workspace 的 **`dev-loop.json`**（schema v2）里。它由 `team init` 和带校验的
mutator 写入，通常不需要手动编辑：

- `team` — backend、deploy policy 上限（`prod` 默认保持 manual，除非你明确允许自动化）、
  `comms`（Slack/Lark channel，对应环境变量名），以及各 agent 的 cadence。
- `repos` — 物理 repo 注册表：路径、build/typecheck 命令、PR merge check、deploy 形态、
  health probe。
- `projects` — 引用 repo 的交付单元：strategy doc、test environment、`intake.todoDepthCap`
  （PM 维持的已承诺队列深度，默认 10），以及各 agent 的启动覆盖项
  (`agents.pm = { model, effort, cadence }` 等)。

完整字段参考：[`references/config-schema.md`](references/config-schema.md)("Schema v2")。
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
dev-loop run --once --dry-run             # 打印解析后的命令，不启动 agent
```

如果你更喜欢 Claude Code 的 Agent View，每一行 `/loop` 都会先调用
`dev-loop next-project --agent <a>`。Agent View 和 scheduler 共用同一个 rotation cursor，
因此不会重复触发同一个 slot。

### 命令速查

| 命令 | 作用 |
|---|---|
| `dev-loop team init / import / repair` | 创建 workspace / 执行一次性 v1 迁移 / 换机后修复 |
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

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 分层、工作流、backend、安全和自我演进。
- [`references/conventions.md`](references/conventions.md) — agent spec，包括 state machine、label 和所有 protocol。
- [`references/config-schema.md`](references/config-schema.md) — `dev-loop.json` 字段参考。
- [`docs/design/`](docs/design/) — 1.0 team/workspace 线的设计记录，包括 proposal、engineering spec 和 GA checklist。
- [`docs/RUNNING.md`](docs/RUNNING.md) · [`docs/PORTABILITY.md`](docs/PORTABILITY.md) · [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md) · [`docs/DAEMON.md`](docs/DAEMON.md) — 运行、可移植性和 service hub 的运维说明。
- [`CHANGELOG.md`](CHANGELOG.md) — 版本历史。

## 发布

release 由 `main` 分支上的 **Release npm package** GitHub Actions workflow 完成：写入版本号、
跑测试、带 provenance 发布并打 tag。详情见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 许可

[MIT](LICENSE)。
