# dev-loop

[English](README.md) · **中文** · [Français](README.fr.md)

**十一个可启动的智能体，通过同一套工单状态机构建、改进、观察并讲述软件。** 你把意图写进策略文档，然后审阅结果；智能体负责提出工作、实现、验证、交付，并把学到的东西带入下一轮。这就是*循环工程*（loop engineering）：少一些逐条手动提示，多运行一套能持续向前推进的系统。

智能体之间不相互调用。**看板是唯一的通道**：每个智能体都读写工单状态和 git，所以它们可以按任意顺序运行，甚至并发运行。工单标签承载运行所需的事实：是否可处理、归属方、路由去向和开发层级。

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

## 目录

- [这是什么](#这是什么) · [工作原理](#工作原理)
- [智能体](#智能体) — 完整阵容
- [工作流](#工作流) — 智能体如何真正组合协作
- [使用场景](#使用场景) — 何时（以及何时不）使用它
- [快速开始](#快速开始) · [环境要求](#环境要求) · [安装](#安装) · [配置](#配置)
- [接入一个项目](#接入一个项目) · [运行循环](#运行循环)
- [后端](#后端) · [安全边界](#安全边界) · [自我进化](#自我进化)
- [报告与操作者评审（点评）](#报告与操作者评审点评) · [Codex（可选）](#codex-集成可选)
- [深入文档](#深入文档) · [状态](#状态)

---

## 这是什么

dev-loop 是一个 **Claude Code 插件**，由一组角色专精的智能体组成：产品经理、QA、开发者，以及几个协调者。配合一小套约定，它们可以在**内层循环无需人工介入**的情况下，跑完完整的软件开发生命周期。你提供产品、策略文档和自治设置；循环把这些输入转化为已交付、经验证的增量，并记录学到的经验。

它刻意做到**不绑定底层平台**。协调可以走默认的 **Linear**，也可以走**机器本地的文件看板**，或者走**本地 hub**：一个基于 `node:sqlite` 的 MCP 记录系统，带每智能体身份和本地 web UI。智能体和协议保持不变。

有三条规则在任何后端下都成立：
- **看板即通道**——智能体通过工单状态交接，而不是直接互相调用。
- **每次运行都从真实状态开始**——智能体无状态；每次都会重新读取看板、git 和磁盘，所以崩溃、重启或上下文压缩不会污染循环。
- **自治靠门禁，不靠提示**——在 `autonomy:"full"` 下智能体可以自行决策并行动，但红色构建绝不交付，部署失败会回滚，真正只能由人处理的决策会作为事实停在工单上，而不是变成交互式提示。

## 工作原理

- **归属标签负责路由工作。** `pm` 拥有 Feature，`qa` 拥有 Bug；**归属方负责提单与验证**，Dev 实现双方的工单。完成的构建正是靠这个规则回到负责签字的人手中。
- **一个标签就是防火墙。** 智能体**只**触碰带有 `dev-loop` 标签、且限定在所配置项目内的工单——绝不碰你的人工待办。
- **循环会谨慎地自我改进。** `reflect-agent` 研究循环自身的行为，并维护一份按操作者区分的 `lessons.md`，每个智能体下次运行都会读取它。它可以自主编辑这份文件，但**绝不**改写智能体自身指令；结构性改动只会提案给人类应用。
- **你通过审阅来掌舵。** 智能体会写日报、周报和月报；在某份报告旁留下一条 **点评**，智能体就会把它提炼成一条 `lessons.md` 规则，并在之后遵守。

---

## 智能体

五个**对内**（面向构建）的智能体、一个可选的**双层 Dev**、四个**对外**智能体，以及一个一次性的**初始化**命令。每个智能体都会先读 [`references/conventions.md`](references/conventions.md)——其中包含完整的状态机、标签分类法、工单模板和各项协议。

### 对内 — 构建循环

| 智能体 | 职责 |
|---|---|
| **`pm-agent`** | 读取策略文档，实际体验产品，提交 **Feature** 工单，主动提出改进，**验证**进入 `In Review` 的功能，解除自己被阻塞的工单，并保持策略文档常新。当双层 Dev 开启时，为每张工单路由到对应的开发层级。 |
| **`qa-agent`** | 在所配置的测试环境中运行正常路径 + 边界用例测试，提交 **Bug** 工单（以及 `drift` → Improvement），对处于 `In Review` 的 Bug 进行**复测**，为每张提交的工单路由开发层级，并为 Dev 清除信息阻塞。 |
| **`dev-agent`** | 按优先级顺序拉取 `Todo` 工单，进行梳理（信息够吗？是否重复？是否已完成？），实现，在构建/测试上设门禁，**自审 diff**，按配置交付，**对生产环境做冒烟检查（出问题即自动回滚）**，交接到 `In Review`。遇阻则阻塞，绝不靠猜。它是默认的单一 Dev；当双层拆分关闭时，作为回退方案保持启用。 |
| **`sweep-agent`** | 生命周期清道夫（节奏较慢）。修补缝隙：缺失/错误的归属或 **dev-tier** 标签（对所有查询不可见 → 被搁浅）、崩溃运行遗留的孤儿 `In Progress`、过期信号、看板健康报告。在 hub 后端上，它还运行可选的**单向 Linear 镜像**推送。仅做清理。 |
| **`reflect-agent`** | 复盘 + 自我进化（每日）。研究循环**自身**的行为，并从反复出现、有证据佐证的模式中提炼 `lessons.md`。仅观察 + 维护；只能自主编辑 `lessons.md`——结构性改动以提案形式起草，绝不自动应用。 |

### 双层 Dev — 可选（按项目选择性启用）

把单一 Dev 拆分为一位设计负责人和一位实现者，让昂贵的模型专注于架构、便宜的模型完成大量编码。在启动器上用 `DEV_SPLIT=1` 启用；传统的单一 `dev` 仍是默认，因此不拆分的项目不受影响。

| 智能体 | 职责 |
|---|---|
| **`senior-dev-agent`** | **高级层 (opus, effort max)。** 两种模式：**design-and-delegate（设计并委派）**——为新模块/功能撰写一份持续演进的、按模块划分的**设计文档**，派生出暂存在 `Backlog`、指派给 junior-dev 的子工单（每张都带有 `Design:` 指针），并把设计父工单移到 `In Review` 交由 PM 把关；以及 **direct-code（直接编码）**——当被升级处理一个真实的 junior 验证失败时，自己实现 → 设门禁 → 交付。 |
| **`junior-dev-agent`** | **初级层 (sonnet, effort high)。** 领取路由给 junior 的 `Todo` 工单，**编码前先读取关联的 `Design:` 指针**，依据设计实现，运行与 dev-agent 相同的门禁/交付流程，交接到 `In Review`。遇到含糊的规格便退出（标记需要信息），而不是靠猜。 |

### 对外 — 观察、协调、定向

| 智能体 | 职责 |
|---|---|
| **`ops-agent`** | 监视**运行中的生产环境**（紧凑节奏，约 10–15 分钟）。轮询健康检查 + 基础 URL + 可选的关键路由/日志，并在**确认且反复出现**的劣化时（先做防抖动复检），提交/刷新一张 `incident` Bug（生产宕机时为 Urgent）。只观察并提单——绝不回滚。 |
| **`architect-agent`** | 全代码库的**技术健康审计员**（慢节奏，大致每日）。审计一个**轮换的**维度（漂移 / 重复 / 死代码 / 依赖陈旧 + CVE / 一致性 / 缺失的抽象），以 SHA 为门禁，并提交 `tech-debt` Improvement。对代码只读——绝不实现。 |
| **`director-agent`** | 面向人类的**方向协调者**（hub 后端；每日/按需）。主持一个跨智能体的**讨论板**（开启议题 → 角色视角智能体每轮发言 → 综合 → 形成**决策**），并**起草**由**操作者发布**的路线图；通过可选的**双向 Lark/Slack 频道**，操作者可与它对话。协调 + 起草——绝不实现/交付/验证。没有 `director` 配置 ⇒ 优雅地空操作（策略由 PM 负责）。 |
| **`communication-agent`** | 公关/媒体负责人。读取策略、路线图、已交付工作和可公开的产品事实，按节奏（默认每日）起草一篇面向外部的产品文章。只写草稿：不对外发布、不提交/推送/部署、不验证工单。可在 Codex 中以 `DEVLOOP_ACTOR=communication` 启动。 |

### 初始化 — 并非循环智能体

| 命令 | 职责 |
|---|---|
| **`/dev-loop:init`** | 一次性、幂等、需操作者在场的初始化。运行 **DETECT → MAP → ASSEMBLE → LOAD**：检测项目形态（全新 / 既有 / 采纳；单仓或多仓），以只读方式把既有代码库映射进 PM 文档库，收集配置，确保标签 + 项目就绪，生成策略文档 + 运行时文件，可选地采纳指定的人工工单（逐张确认），并打印就绪检查清单。绝不提交工单、验证或交付。 |

---

## 工作流

智能体本身刻意保持简单；价值主要来自**工作流**。每个工作流都是智能体对工单状态做出反应，不需要中央编排器。

### 1. 核心构建循环
PM（依据策略文档）和 QA（依据测试）提交 `Todo` 工单 → Dev 按优先级顺序认领 → `In Progress` → 交付 → `In Review` → 由**归属方**验证（Feature 由 PM，Bug 由 QA）。**通过 → `Done`。失败 → 关闭并提交后续工单**（失败的增量会被*取代，而非悄悄重开*，因此历史能区分"已交付但失败"与"排队中"）。

### 2. 双层 Dev — 设计并委派 *（选择性启用）*
对于**新模块或新功能**，PM 把工单路由给 **senior-dev**。Senior 撰写一份持续演进的**设计文档**，将其拆解为具体的子工单、**暂存在 `Backlog`**（不可领取），每张都带有 `Design:` 指针，并把设计父工单移到 `In Review`。**PM 为设计把关**（大模块由你签字）；通过后，子工单**从 `Backlog` 提升为 `Todo`**，由 **junior-dev** 领取、阅读设计并实现。昂贵的模型只设计一次；便宜的模型编写各个部分。

### 3. 升级 — junior → senior → 人类
当 **junior-dev** 的工作因**真实的**验收标准未达成而验证失败时（并非偶发/基础设施抖动——那种只会重试），验证方（Feature/Improvement 由 PM，Bug 由 QA）将其取消，并提交一张 **senior-dev 直接编码**的后续工单；由 senior 亲自编码。若 senior 的修复*也*失败 → `fix-exhausted` → **`Human-Blocked`**（你）。便宜的层级先尝试；昂贵的层级是安全网；你是最终兜底。

### 4. 接入 — `init`（DETECT → MAP → ASSEMBLE → LOAD）
把产品一次性接入循环：检测其形态，把既有代码库映射进 PM 文档库（或对全新项目做访谈），配置标签/项目，生成策略文档 + 运行时文件，并打印就绪检查清单——这一切都在你切到 `mode:"live"` 之前完成。

### 5. 自我进化 — 报告 → 点评 → 经验 → 行为
每个智能体都会写报告；Reflect 把反复出现的模式提炼进 `lessons.md`；你在任意报告旁留下一条 **点评**，智能体便把你的评语转化为一条 `lessons.md` 规则，并自此遵守。循环无需任何人编辑 skill 文件就能变得更好——而且**绝不**自主改写自己的核心指令（那些只会提案给人类）。

### 6. 方向 — 讨论板与路线图 *（hub 后端）*
**Director** 开启一个**议题**，角色视角智能体每轮发表一个观点，Director **综合出一个决策**并**起草**路线图；再由**操作者发布**。操作者还可选择通过**双向 Lark/Slack 频道**与 Director 对话。策略由此成为经过审议、由操作者把关的产物，而非某个智能体的臆测。

### 7. 对外监控 — 生产与代码库健康
**Ops** 监视运行中的生产环境，在确认劣化时提交一张 `incident` Bug（它会作为 Bug 重新进入核心循环）。**Architect** 审计代码库中轮换的一个切片，提交 `tech-debt` Improvement。**Communication** 基于已验证、可公开的事实起草每日产品文章。它们都不实现，也不对外发布。

### 8. 人工停泊与通知
真正只能由人处理的阻塞（一份凭据、一次法务签字、一个外部前置条件）会停泊该工单——在 hub 上为 `Human-Blocked`，在 Linear/local 上为 `blocked`+`needs-pm`——并通过一个可选的 **Slack/Lark webhook** 带外提醒你，使它绝不会无人问津。

### 9. 镜像 — hub → Linear *（hub 后端）*
hub 可以把它的工单单向推送到 Linear 以便人类查看（幂等、增量、强制防脑裂——绝不把 Linear 反读为真相）。在快速的本地 hub 上运行循环，在 Linear 中观看。

### 10. 观察 — 本地 web UI *（hub 后端）*
一个常驻的本地守护进程基于同一套记录系统提供只读看板、工单详情、路线图编辑器、报告，以及活动/吞吐视图——让你*观看*循环而不触碰它。智能体则不依赖守护进程（它们通过 MCP 协调，而非 web UI）。

---

## 使用场景

**在以下情况使用 dev-loop**：工作会反复出现，"完成"可以由机器检查，而且产出值得消耗这些 token。具体来说：

- **一个需要持续维护的产品。** 让 PM 对准一份策略文档，让循环交付功能、修复 QA 发现的 bug、保持生产环境健康——你审阅，而不手写代码。
- **一个你总是赶不上的待办积压。** CI 失败、依赖升级、某一类反复出现的 bug、漂移清理——把它们提单（或让 QA/Architect 去发现），循环会在你睡觉时把队列清空。
- **一个新模块或大型功能。** 开启双层 Dev：senior-dev 设计并拆解；junior-dev 构建各个部分；你为设计把关并审阅结果。
- **全代码库加固。** 让 Architect 每日审计一个轮换维度并提交技术债；循环以一次一个、经验证的增量逐步偿还。
- **始终在线的生产监视。** Ops 把确认的劣化转化为一张重新进入循环的 `incident` Bug——这是会*行动*的监控，而不只是告警。
- **多仓库产品。** 一个产品、多个仓库：工单通过标签指向某个仓库，并按仓库分别构建/分支/部署。

**不要**在以下情况使用它："完成"主要靠主观判断、任务只是一次性的，或者产出无法被自动否决。没有真实验证的循环，只会以更高频率产出更多可疑结果。

> **成本是真实的。** token 是运行成本，而*频率*通常是主导因素。很多智能体、很紧的节奏、再加上最强模型，成本会很快累积。把机械性角色的 **models** 调低，选一个合理节奏，并关注**验收率**（已验证 ÷ 已提单）：低于约 50% 时，循环是在制造审阅工作，而不是替你省事。

---

## 快速开始

```bash
# 1. 安装运行时 CLI/hub；MCP、Codex/opencode 和 scheduler 都用它。
npm i -g @dyzsasd/dev-loop

# 2. 如果需要 Claude slash command，再从源码 checkout 安装插件。
claude --plugin-dir /path/to/dev-loop

# 3. 接入一个产品。该步骤需要操作者在场，且可重复运行。
/dev-loop:init

# 4. 先 dry-run：只看它会做什么，不写入。
#    在 projects.json 中设置 mode:"dry-run"，然后跑一轮：
/dev-loop:pm-agent      /dev-loop:qa-agent      /dev-loop:dev-agent

# 5. 切到 mode:"live"，再让智能体循环运行。
#    可以用 Agent View，也可以让 dev-loop 控制节奏并调用 Claude/Codex：
cd /path/to/product-repo && dev-loop run --cli codex --agents core,communication
```

## 环境要求

- 使用 slash command / Agent View 时，需要 **Claude Code** 并安装本插件；使用 scheduler 时，
  被调用的执行器 CLI（`claude`、`codex`，或验证后的 opencode）需要在 `PATH` 上。
- 一个**协调后端**：默认使用 **Linear MCP**（`mcp__linear-server__*`），本地文件看板 / hub 则无需额外组件。
- 已认证的 **`gh` CLI**——Dev 用它做 git/部署。
- 产品的一个 **git 仓库**，以及（对 Linear 而言）一个可供循环管辖的**团队 + 项目**。
- 各角色所需：`repoPath`（Dev）、`strategyDoc`（PM）、`testEnv`（QA）。
- hub 后端需要：**Node ≥ 23.6**（内置 `node:sqlite`，零原生依赖）。

## 安装

dev-loop 现在有两个安装面：

1. **运行时 CLI / hub（推荐所有环境都装）。** 它安装 `dev-loop` 和 `dev-loop-hub`，
   供 `service` 后端、MCP 配置、daemon、doctor 和内置 scheduler 使用：

```bash
npm i -g @dyzsasd/dev-loop
```

安装后，MCP 配置可以直接使用 `command:"dev-loop", args:["serve"]`，不再需要写
`node /path/to/dev-loop/hub/src/server.ts` 这种绝对源码路径。

2. **Claude Code 插件（只在需要 Claude slash command 时安装）。** 当你想使用
   `/dev-loop:pm-agent`、`/dev-loop:init`、Agent View 等 Claude 原生插件体验时，安装这一层。

**从源码 checkout 快速 / 开发安装（仅限本次会话）：**
```bash
claude --plugin-dir /path/to/dev-loop
```

**个人、持久** — 在 `~/.claude/settings.json` 中添加一个本地 marketplace：
```json
{
  "extraKnownMarketplaces": {
    "local": { "source": { "source": "local", "path": "/path/to/parent-of-dev-loop" } }
  }
}
```
然后执行 `/plugin install dev-loop@local`。这些 skill 会显示为 `/dev-loop:pm-agent`、
`/dev-loop:qa-agent`、`/dev-loop:dev-agent`、`/dev-loop:sweep-agent`、
`/dev-loop:reflect-agent`、`/dev-loop:ops-agent`、`/dev-loop:architect-agent`、
`/dev-loop:director-agent`、`/dev-loop:communication-agent`、可选启用的 `/dev-loop:senior-dev-agent` +
`/dev-loop:junior-dev-agent`，以及 `/dev-loop:init`。

对于 Codex/opencode，npm 包已经包含 `dev-loop run` 所需的 agent skills 和共享规范；仅为了定时运行
agent，不需要额外安装 Claude 插件 checkout。

## 配置

每个项目的设置存放在 `${CLAUDE_PLUGIN_DATA}/projects.json`
（`~/.claude/plugins/data/dev-loop/projects.json`）。从示例文件初始化：

```bash
mkdir -p ~/.claude/plugins/data/dev-loop
cp config/projects.example.json ~/.claude/plugins/data/dev-loop/projects.json
# 然后把每个项目映射到 repo、策略文档、测试环境和 git/deploy 标志。
```

各个档位（均为按项目设置）：
- **`mode`** — `"dry-run"`（分析 + 打印，不写入）对比 `"live"`（创建/流转工单，且对 Dev 而言，按 `git`/`deploy` 进行提交/推送/部署）。
- **`autonomy`** — `"ask"`（升级只能由人做的决策）对比 `"full"`（自行决策并行动）。
- **`backend`** — `"linear"`（默认）/ `"local"`（文件看板）/ `"service"`（hub）。参见 [后端](#后端)。
- **`models`** — 启动时每个智能体使用的模型；**默认为 `opus`**。把机械性/高频的智能体调低（`sonnet`/`haiku`）。双层 Dev 默认 senior=opus、junior=sonnet。
- **`repos[]`** *（可选）* — 一个产品、多个仓库（否则为单仓，100% 不变）。
- **`reports.sink`** *（可选）* — `"files"`（默认）对比 `"linear"`（把报告 + 点评 托管在 Linear，以适配云端/远程运行时）。
- **`notify`** *（可选）* — Slack/Lark webhook，在工单被人工停泊时提醒你。
- **`director`** *（可选，hub）* — 启用讨论板 + 路线图 + 双向频道。
- **`communication`** *（可选）* — 启用每日文章草稿；只产出草稿，可写到数据目录或仓库 docs 目录。

完整参考：[`references/config-schema.md`](references/config-schema.md)。

## 接入一个项目

**运行一次 `/dev-loop:init`**（见上）——它会搭建好一切，并在你上线前打印就绪检查清单。它只创建缺失的部分，绝不覆盖任何已有内容。作为兜底，循环智能体也会在首次 `live` 运行时重新执行标签/项目检查。

## 运行循环

你可以按自己的环境选择启动方式：

- **Agent View**（原生）——`claude agents`，然后把每个智能体作为自循环会话派发：
  `/loop 5m /dev-loop:pm-agent`、`/loop 5m /dev-loop:qa-agent`、`/loop 5m /dev-loop:dev-agent`、
  `/loop 30m /dev-loop:sweep-agent`、`/loop 24h /dev-loop:reflect-agent`，再加上可选启用的
  对外智能体（`ops`、`architect`、`director`、`communication`）。
- **内置 scheduler**——在已配置的项目 repo 里运行 `dev-loop run --cli claude`，或
  `dev-loop run --cli codex --agents core,communication`。节奏由 dev-loop 自己控制；
  Claude/Codex 只负责每次执行一个 agent fire。只有从 repo 外启动、或要覆盖 cwd 自动识别时才需要
  `--project <key>`。
- **一个本地 tmux 启动器**——每个智能体一个窗格，一条命令指定各智能体的模型。设置
  `DEV_SPLIT=1` 即可运行双层 Dev（senior-dev + junior-dev 两个窗格），而非单个 `dev`。
- **手动**——一次一轮，跑单次。

**节奏**（它们会自我节流，因此空转触发是廉价的空操作）：PM/QA/Dev 约 5 分钟，Sweep
约 30 分钟，Reflect 每日；Ops 约 10 分钟，Architect/Director/Communication 每日/按需。

**恢复是普通操作**，因为智能体每次运行都是无状态的。停止、崩溃或重启之后，重新启动即可；每个智能体都会重新读取真实状态并继续。

> ⚠️ **`mode:"live"` + `autonomy:"full"` + `autoPush`/`autoDeploy` = 无人值守的提交、推送和生产部署，没有任何人工门禁。** 这正是设计目标，但请先用 `mode:"dry-run"`（或 `dev-loop run --once --dry-run`）跑一遍，看看它会做什么。

📖 完整指南——接入、启动方式、模型、恢复、停止：[`docs/RUNNING.md`](docs/RUNNING.md)。

## 后端

协调是可插拔的；三种后端下智能体与协议完全一致。

| 后端 | 它是什么 | 为你提供 |
|---|---|---|
| **`linear`** *（默认）* | 通过 Linear MCP 协调 | 云端、团队可见、以 Linear 应用作为 UI |
| **`local`** | 数据目录中一个机器本地的 markdown 文件看板 | 零云端、极简、无需 Linear |
| **`service`** | 一个本地 **hub**——基于 `node:sqlite` 的 MCP 记录系统 | **真实的每智能体独立身份**、本地 **web UI**、带版本的操作者发布文档、讨论板 + Director、双向频道、单向 Linear 镜像、CLI 可移植性 |

**工作面**（状态、流转、职责和智能体循环）在各后端间完全一致；**表层面**（每智能体身份、web UI、看板/Director）则随后端扩展。参见 [conventions §18](references/conventions.md) +
[`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md)。

## 安全边界

智能体**只**操作带有 **`dev-loop`** 标签、且限定在所配置项目内的工单。它们绝不读取、流转或评论任何其他工单。这个唯一的标签就是循环与你的人工待办之间的防火墙；请把它当作安全模型的一部分。

## 自我进化

`reflect-agent` 正是让循环在改进的同时不至于陷入混乱的关键：
- 它读取循环**自身**的产出，把**反复出现**的模式（≥2 次出现，每次都引用工单 ID / 提交 SHA）提炼进 `lessons.md`——这是每个智能体在每次运行开头都会读取的、按操作者区分的覆盖层。
- **硬性边界**（[conventions §17](references/conventions.md)）：Reflect 可以自主编辑 `lessons.md`（本地、可逆、绝不提交），但**绝不能**自动改写各 SKILL 或 `conventions.md`。结构性改动会**以提案形式起草**，交由操作者通过 git 提交来应用。对核心的自我修改是*被呈现，而非被执行*——这是"自行决策并行动"原则的唯一例外。

## 报告与操作者评审（点评）

你通过审阅循环留下的轨迹来掌舵，而不是在循环里改代码。
- **报告。** 每个智能体都会写一份日志，按周/月汇总到 `${CLAUDE_PLUGIN_DATA}/<project-key>/reports/<agent>/` 下——机器本地、绝不提交、对密钥/PII 安全。空操作的触发不写任何东西。
- **点评。** 在同级放一个 `<report>.review.md`，写上自由格式的文字；在下一次运行时，智能体会把你的评语提炼成一条放在它自己分区下的 `lessons.md` 规则，并自此遵守。整个循环就是：**报告 → 你的 点评 → 经验 → 行为改变。**
- **云端/远程？** 设置 `reports.sink:"linear"`，报告就会变成每个智能体各自的 Linear 文档，点评作为评论——可从浏览器/手机阅读与点评（同样的防火墙、§16 护栏）。

## Codex 集成（可选）

循环可以通过 [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 配套 + `codex` CLI，把 **OpenAI Codex** 当作增强工具来用。**需手动启用；不启用则行为不变。** 它增加了几项彼此独立的能力：一次**独立的第二模型评审**（Dev 第 5.5 步 + Architect；仅供参考，绝不触碰看板）、**图像生成**（PM 原型图 + Dev 生产素材——这是循环自身唯一做不到的事），以及在 `fix-exhausted` 阻塞之前的一次性**救援**。参见
[conventions §24](references/conventions.md) + [`references/codex-integration.md`](references/codex-integration.md)。

另一条路径是由 `service` hub 让各个智能体直接在 Codex 中启动；见
[`docs/PORTABILITY.md`](docs/PORTABILITY.md)。Communication 窗口使用
`DEVLOOP_ACTOR=communication` 搭配 `/dev-loop:communication-agent`。

## 深入文档

- [`references/conventions.md`](references/conventions.md) — 权威规范（状态机、标签、每一项协议）。每个智能体都会先读它。
- [`references/config-schema.md`](references/config-schema.md) — 完整的 `projects.json` 字段参考。
- [`docs/RUNNING.md`](docs/RUNNING.md) — 接入、启动方式、模型、恢复。
- [`docs/HUB-ARCHITECTURE.md`](docs/HUB-ARCHITECTURE.md) — 本地 hub / `service` 后端。
- [`docs/DAEMON.md`](docs/DAEMON.md) — 本地 web UI + 守护进程。
- [`docs/PORTABILITY.md`](docs/PORTABILITY.md) — 在第二个 CLI 上运行循环（Codex / opencode）。
- [`docs/design/`](docs/design/) — 设计记录（后端选型、守护进程重新定位、双层 Dev 拆分）。
- [`CHANGELOG.md`](CHANGELOG.md) — 完整版本历史。

## 状态

**v0.22.1。** 十一个可启动智能体——五个对内（**PM / QA / Dev / Sweep / Reflect**）、四个对外（**Ops / Architect / Director / Communication**），以及可选启用的双层 **senior-dev / junior-dev** Dev 分层——再加上 `init` 接入命令。协调可按后端插拔：**Linear**（默认）、一个**本地文件看板**，或**本地 hub**（`node:sqlite` 记录系统，具备每智能体独立身份 + 本地 web UI + 带版本的文档 + 讨论板/Director + 双向 Lark/Slack 频道 + 单向 Linear 镜像 + CLI 可移植性）。近期：**双层 Dev**（senior 设计 / junior 实现，可选启用，向后兼容）；**独立 npm 打包**（`npm i -g @dyzsasd/dev-loop`），已内置 scheduler 运行所需的 agent skills，并配有经 Codex 认证的多 CLI 路径；以及**循环成本治理**（失控/无进展的熔断器、一个验收率指标）。已端到端验证，并在长时间的实时运行中经受实战检验；自治（推送/部署）按项目选择性启用，且以构建通过为门禁。完整历史见 [`CHANGELOG.md`](CHANGELOG.md)。
