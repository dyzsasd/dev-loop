# dev-loop

[English](README.md) · **中文** · [Français](README.fr.md)

**装在一个文件夹里的自主开发团队。** 九个可启动的 agent(PM、QA、senior/junior 双层 Dev、
Sweep、Reflect、Ops、Architect、Communication)负责构建、测试、发布、监控和汇报,完全通过
工单状态协作(Linear,或内置的本地 hub)。你把意图写进战略文档,每天读一条摘要;剩下的交给
团队。

你是 **director**,不是 reviewer:所有工作经由 PM 进入(永远不直接派给 dev)、敏感改动先由
senior 出设计、验收独立于实现者的自述,团队做的一切都沉淀为你一条消息就能读完的报告和指标。

> 内部机制(分层、协议、后端、自我进化)见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
> 本 README 只讲**怎么用**。

---

## 快速开始

```bash
npm i -g @dyzsasd/dev-loop        # Node ≥ 23.6;安装 `dev-loop` CLI
```

一个 **workspace** = 一个目录 = 一个团队 = 一个 Linear team(或一个本地 hub)= 一份
`dev-loop.json`。repo 是其中的真实 clone;project 是 repo 的虚拟分组。全部状态都在
`<workspace>/.dev-loop/` 下,所以**复制文件夹 = 迁移机器**。

```bash
# 1. 创建 workspace(纯 CLI —— 无 LLM、不触碰后端)
dev-loop team init --dir ~/work/my-team --key my-team \
  --backend linear --linear-team "My Team" --deploy dev=auto,prod=manual --comms lark
cd ~/work/my-team

# 2. 在 coding CLI(Claude Code / Codex)里:建项目并同步后端,然后加 repo
#      /dev-loop:add-project      — find-or-create Linear/hub 项目、标签、战略文档
#      /dev-loop:add-repo         — clone + 侦测构建/CI 检查 + 部署与健康探针面试

# 3. 校验、预览、跑
dev-loop doctor                   # 只读健康裁定
dev-loop run --once --dry-run     # 预览每个 agent 的完整命令(各自的 model + effort)
dev-loop run                      # 一个调度器驱动整个团队;^C 全停
```

**linear** 团队需把 Linear MCP 配在 Claude Code 的 **user scope**(缺失时 doctor 报
`W05`)。**service** 团队的本地 hub 由 `dev-loop run` 自动拉起(`dev-loop hub status`
查看)。

### 从 v1(`~/.dev-loop/projects.json`)迁移

1.0 运行时**不再读取 v1 配置**。一次性迁移:

```bash
dev-loop team init --dir <workspace> --key <team> --backend <linear|service> ...
cd <workspace> && dev-loop team import      # 折叠项目、搬迁状态、拆分 lessons
dev-loop doctor
```

### 换电脑

```bash
dev-loop hub stop                 # 仅 service 团队(checkpoint WAL)
rsync -a ~/work/my-team/ newhost:~/work/my-team/
# 新机器上:装 CLI + coding CLI、gh auth、export 环境变量
cd ~/work/my-team && dev-loop team repair && dev-loop doctor && dev-loop run
```

密钥从不进 workspace(配置只存环境变量的**名字**),文件夹可以放心复制。

## 环境要求

- **Node ≥ 23.6**,PATH 上有 coding CLI:`claude`(Claude Code)和/或 `codex`。
- 已认证的 **`gh` CLI**(Dev 用它开/合 PR)。
- 一个后端:**Linear**(Linear MCP 配在 user scope),或什么都不用 —— 内置 **service hub**
  (本地 sqlite + web UI)零外部依赖。
- 每个项目:一个 git repo、一份战略文档、一个测试环境 URL。

## 配置

一切都在 workspace 的 **`dev-loop.json`**(schema v2)里,由 `team init` 和带校验的
mutator 写入,基本不用手改:

- `team` — 后端、部署上限(`prod` 默认永远手动)、`comms`(Slack/Lark 通道,存环境变量名)、
  各 agent 节奏。
- `repos` — 物理注册表:路径、构建/typecheck 命令、PR 合并检查、部署形态、健康探针。
- `projects` — 引用 repo 的虚拟交付单元:战略文档、测试环境、`intake.todoDepthCap`
  (PM 维持的待办队列深度,默认 10)、各 agent 的 model/effort/cadence 覆盖。

完整字段参考:[`references/config-schema.md`](references/config-schema.md)("Schema v2")。
agent 行为规范:[`references/conventions.md`](references/conventions.md)。

## 跑循环

一条 `dev-loop run` 驱动整个团队:delivery agent 在启用的项目间加权轮换,stewardship
agent(sweep/ops/reflect/communication)以 team 为作用域,每个 agent 用自己配置的
model + effort。

```bash
dev-loop run                              # 全量,默认节奏
dev-loop run --agents core,ops            # 挑 agent/组(core = pm,qa,senior,junior,sweep)
dev-loop run --plan 8 --agents pm         # 预览接下来 8 次项目轮换(不触发)
dev-loop run --interval pm=2m --max-fires 50   # 节奏覆盖 + 成本上限
dev-loop run --once --dry-run             # 打印全部解析后的命令,不启动
```

喜欢 Claude Code 的 Agent View?每个 `/loop` 行先调 `dev-loop next-project --agent <a>` ——
与调度器共享同一份轮换 cursor,不重不漏。

### 命令速查

| 命令 | 作用 |
|---|---|
| `dev-loop team init / import / repair` | 建 workspace / v1 一次性迁移 / 换机后修复 |
| `dev-loop team add-project / add-repo` | 带校验的配置写入(`/dev-loop:*` skill 调用) |
| `/dev-loop:add-project` 等四个 skill | coding-CLI:后端同步、clone+侦测、漂移对账 |
| `dev-loop run [--plan n] [--project k] [--once] [--dry-run]` | 团队调度器 |
| `dev-loop doctor` | 只读健康裁定(配置校验、探针、fire 成功率) |
| `dev-loop metrics [--window 7d] [--json]` | 团队 KPI:fire 成功率、吞吐、accept rate、QA 逃逸率 |
| `dev-loop notify [--level info\|warn\|error] [--title t] <text>` | 推送到团队 Slack/Lark 通道 |
| `dev-loop hub start\|stop\|status\|ensure` | 本地 hub daemon(service 后端;stop 会 checkpoint WAL) |
| `dev-loop next-project --agent <a>` | Agent-View `/loop` 行的共享轮换 picker |
| `dev-loop with-repo-lock <ref> -- <cmd>` | 串行化共享 repo 的 base-clone 操作 |
| `dev-loop export-desktop-skill <agent> --project <k> [--team]` | 渲染自包含的 Claude Desktop skill |

## 日常你会看到什么

- **新工作先进 `Backlog`**;PM 整理、去重、按深度上限提升到 `Todo` —— 看板永不淹没。你自己
  的需求也发成 `Backlog` 工单(标 `dev-loop`+`pm`+`needs-pm`),PM 会接手(永远不要直接给
  dev 建工单)。
- **敏感改动**(登录/权限、支付、PII、密钥、数据迁移)一律先由 senior 出设计再动代码 ——
  全自主,没有确认弹窗。
- **每日摘要**推到你的 Slack/Lark:团队 KPI(来自 `dev-loop metrics`)、QA 质量、看板流动、
  north-star 进展,以及一节"需要 director"—— 空着才是好日子。事故即时推送,恢复时补一条
  闭环消息。
- **报告**按 agent 累积(文件,或经 `reports.sink` 存 Linear 文档),Reflect 每周产出团队
  级回顾。

## 团队成员

| Agent | 职责 | 节奏 |
|---|---|---|
| **PM** | 战略文档 → 工单;整理并提升 Backlog;验收 feature | 5m,按项目 |
| **QA** | 测产品、报 bug、复测修复 | 5m,按项目 |
| **senior-dev** | 模块与敏感工作的设计;委派;接升级 | 5m,按项目 |
| **junior-dev** | 实现已设计/已圈定的工单 | 5m,按项目 |
| **Sweep** | 看板卫生、生命周期修复、tracker 维护 | 30m,team 级 |
| **Ops** | 轮询 prod 健康,确认事故即报 + 推送 | 10m,team 级 |
| **Reflect** | 回顾、lessons 库、north-star 进展 | 每日,team 级 |
| **Architect** | 全库技术债审计 | 每日,按项目 |
| **Communication** | 每日 director 摘要 + 文章草稿 | 每日,team 级 |

完整角色契约与协议:[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) +
[`references/conventions.md`](references/conventions.md)。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 分层、工作流、后端、安全、自我进化。
- [`references/conventions.md`](references/conventions.md) — agent 规范(状态机、标签、全部协议)。
- [`references/config-schema.md`](references/config-schema.md) — `dev-loop.json` 字段参考。
- [`docs/design/`](docs/design/) — 1.0 team/workspace 线的设计记录(提案、工程稿、GA 清单)。
- [`CHANGELOG.md`](CHANGELOG.md) — 版本历史。

## 发布与许可

发布经由 GitHub Actions 的 **Release npm package** 工作流(见
[`docs/RELEASING.md`](docs/RELEASING.md))。许可:[MIT](LICENSE)。
