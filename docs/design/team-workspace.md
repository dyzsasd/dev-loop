# Team / Workspace — dev-loop 1.0 设计记录

> **状态注记（1.0.0 定稿）：** 本文是设计记录，保留提出方案时的结构和计划。实际交付与下文的差异：
> ① 没有按 0.30–0.34 分版发布，M1–M5 在 rc.1→1.0.0 期间一次性交付；
> ② 0.x 配置回退期已经结束，1.0.0 彻底移除了 legacy `init` skill 和 `init-config` 命令；
> ③ `doctor` 保持只读，修复动作归到 `dev-loop team repair`；
> ④ hub op-API 的 steward project 覆盖（D4.2）与 web team 总览（D5.3）延至 1.1；
> ⑤ 最终交付状态以 [`team-workspace-GA.md`](team-workspace-GA.md) 与
> [`CHANGELOG.md`](../../CHANGELOG.md) 为准。

> 原始状态：**proposal v3.1**（三轮操作者反馈 + 设计评审修订：M3/M4 里程碑重排、命名校验、
> import 事件重键、`next-project` 共享 rotation picker）。2026-07-03。
> 工程级细化（模块、类型、算法、任务分解）：[`team-workspace-impl.md`](team-workspace-impl.md)。
> 起点：0.29.0。目标发行版本：**1.0.0 GA**。

---

## 0. 结论摘要

引入 **team** 作为顶层配置单元，与一个 **workspace（具体目录）** 一一对应；一个 team 对应一个
Linear team 和一个 backend。workspace 内的物理单元只有 **repo**（git clone 目录）；**project 是虚拟概念**，
只是配置里的一个条目，用来把若干 repo 的*引用*组合成一个交付面（也就是一个 Linear project）。
**一个 repo 可被多个 project 引用。**

操作流：`dev-loop team init`（纯 CLI，不调用 LLM）→ 在 coding CLI（Claude Code / Codex）里逐个运行
`/dev-loop:add-project`、`/dev-loop:add-repo`（添加时同步 backend）→ 在 workspace 层级启动
**唯一一个 loop**。调度器在已启用的 project 之间轮换。workspace 目录**自足**：配置、状态、
报告、lessons、hub 数据库都在里面，所以**复制目录即可迁移机器**。

**不变式重述：delivery agent（PM/QA/Dev）的 fire 仍以 project 为原子单位；stewardship
agent（reflect/ops/communication/sweep）升为 team 作用域。** 现有 SKILL 状态机
（§3/§4/§12b/§12c/验收/报告）在 project 作用域内原样复用。

### 0.1 一图流

```
team (= workspace 目录，= Linear team，一个 backend)
 ├─ dev-loop.json            ← team 配置（唯一权威文件；project 只是其中的条目）
 ├─ docs/                    ← team 级文档（docSystem=local 时）
 ├─ .dev-loop/               ← 全部运行状态：state/ reports/ lessons/ wt/ hub.db
 ├─ jinko-dev-platform/      ← repo = git clone（物理单元，= GitHub repo）
 ├─ mcp-bff/
 └─ shared-lib/

project（虚拟，只存在于配置）:
  devplatform = { jinko-dev-platform(primary), shared-lib }
  agent-api   = { mcp-bff(primary),            shared-lib }   ← shared-lib 被两个 project 引用
```

### 0.2 操作者已确认的取向(三轮反馈合并)

| # | 问题 | 决定 |
|---|---|---|
| 1 | repo 物理位置 | 全部 clone 在 workspace 内，默认平铺在根目录；配置使用 workspace 相对路径 |
| 2 | backend 层级 | 严格 team 级；backoffice（service）与 devplatform（linear）是两个 team |
| 3 | 跨 project 协作 | 需要：team 级 intake 会拆分为各 project 子票（§8） |
| 4 | 配置共享 | 机器本地；workspace 不做 meta-repo。自足目录已覆盖迁移诉求，见 #11 |
| 5 | project 的本体 | **虚拟概念**，不对应目录；repo 才是目录；一个 repo 可被多个 project 引用 |
| 6 | backend 对齐 | team 内的 project 必须与 backend project 对应，**add 时即同步**，另有 sync 命令对账 |
| 7 | 工具入口 | add/sync project/repo 走 coding CLI skill；**init team 不需要 coding CLI**（§9.1） |
| 8 | 对外交流管道 | 与 backend 无关，使用 **team 级 comms**，支持 Slack / Lark（§6.1） |
| 9 | loop 启动层级 | **始终在 team workspace 层级启动**；调度器跨 project 轮换；team 配置可 enable/disable project |
| 10 | lessons / reflect / ops | lessons 在 team 层积累；reflect 是 team 作用域；ops 按 repo registry 去重巡检、按 owner 路由（§6.2） |
| 11 | 兼容性 | **不保留运行时兼容**：1.x clean break，运行时不读 0.x 全局配置 |
| 12 | 跨机器迁移 | 目标是**只复制 workspace 文件夹**；全部状态进入 workspace（§10.3） |
| 13 | hub 数据库 | **放入 workspace**：`.dev-loop/hub.db`，一库一 team，daemon 按 workspace 启动（§7.2） |
| 14 | 跨 team 协作 | **不设计自动跨 team 协作**（I3） |
| 15 | 发行版本 | 该方案最终作为 1.0.0 GA 交付 |
| 16 | team 文档层 | team 需要一等 doc 概念：文档库（vision + lessons 库）；lessons 膨胀治理纳入 1.x（§5） |
| 17 | hub 生命周期 | hub 数据在 workspace 中；`dev-loop hub start / stop / status` 按 workspace 管理 daemon，`run` 自动 ensure（§7.2） |

---

## 1. 动机:现状痛点

1. **配置是机器全局平面**。0.x 配置把所有 project 放在一层,绝对路径绑定
   机器;加一个 repo 要人肉编辑全局配置。
2. **project 与目录耦合**。今天 repoPath 指哪都行但没有结构;一份共享代码库想同时服务两个
   交付面,只能二选一或复制配置。
3. **Linear 映射靠约定**。`linearTeam` 逐 project 重复填写;config 里的 project 与 Linear
   project 没有机器可校验的对应(改名/归档后悄悄漂移)。
4. **多 project 无调度关系**。两个 project 要起两套 loop;没有 team 级的开关、权重、公共
   策略(如 "prod 永远手动")。
5. **状态散落 `~/.dev-loop/`**。换电脑 = 手工搬配置 + 状态 + 重建 hub 库,极易丢报告与
   lessons。
6. **lessons / reflect / ops 各自为政**。每个 project 一份 lessons,跨项目的教训无法沉淀;
   ops 对共享基础设施重复巡检。
7. **对外通知(lark webhook)埋在 project 配置里**,与 backend 混在一起,换 backend 就要
   重配。

---

## 2. 概念模型与不变式

| 概念 | 对应 | 本体 |
|---|---|---|
| **team** | workspace 目录;Linear team;(service)一个 hub 库 | 顶层配置单元;**一个 team 一个 backend** |
| **repo** | `<workspace>/<相对路径>/` 的 git clone;GitHub repo | **物理单元**:构建/部署/CI 事实的挂载点(registry 注册一次) |
| **project** | 配置条目;Linear project(或 hub project) | **虚拟单元**:repo 引用的组合 + 交付面语义(strategyDoc/testEnv/agents);delivery fire 的原子作用域 |

**不变式(设计约束,实现必须保持):**

- **I1 — fire 作用域分层**:delivery agent(PM/QA/senior-dev/junior-dev)每次 fire 恰好作用
  于一个 project(现有 SKILL 语义不变);stewardship agent(sweep/ops/reflect/communication)
  每次 fire 作用于整个 team,内部按 project/repo 迭代或路由。
- **I2 — repo 注册唯一、引用多重**:一个 repo 在 team 的 registry 里恰好注册一次(物理事实
  单点维护);可被任意多个 project 引用;被 >1 个 project 引用时必须显式声明 `owner`
  (运维/告警路由归属,§6.2)。
- **I3 — 一个 team 一个 backend;无跨 team 协作**:linear 或 service,不混;两个 team 之间
  不存在任何自动协作,永不设计。
- **I4 — workspace 自足**:配置、状态、报告、lessons、worktrees、hub 库全部位于 workspace
  目录内,路径一律相对;**复制目录到新机器 = 完成迁移**(仅 env 变量与凭据随机器,§10.3)。
- **I5 — 秘密不落盘**:沿用 §16 —— 配置只存 env-var *名字*(comms webhook、token 等),
  字面量永不进 workspace;这也是 I4 成立的前提(目录可以随便拷,不带密钥)。

---

## 3. Workspace 布局与解析

### 3.1 目录约定

```
<workspace>/
  dev-loop.json                # team 配置(1.x workspace schema;唯一权威)
  docs/                        # team 级文档(docSystem=local 时;可选)
  .dev-loop/                   # 全部运行状态(见 3.3)
  <repo-dir>/                  # git clone;默认平铺在根下,registry 的相对路径是权威
```

- `repos.<name>.path` 一律 **workspace 相对路径**;`add-repo` 默认 clone 到
  `<workspace>/<name>/`,已有目录也可直接登记。
- workspace 本身**不是** git repo;子 repo 各自是独立 clone。
- 不再有 `<project>/<repo>` 的嵌套脚手架 —— project 不是目录(#5)。

### 3.2 解析(precedence,自上而下)

1. `DEVLOOP_TEAM` + `DEVLOOP_PROJECT` 显式指定(空串视为未设,同 DL-13);
2. **cwd 向上爬找 `dev-loop.json`** → team;repo 定位:cwd realpath 匹配 registry path
   (段边界安全、最近祖先优先,复用 DL-13 匹配器);**project 定位**:显式 `--project` 或
   fire 上下文;缺省时若该 repo 仅被一个 project 引用则推断,被多引用则报错要求显式
   (共享 repo 的必然代价,报错信息列出候选);
3. `~/.dev-loop/workspaces.json` **便捷索引**(`{"<team-key>": "<abs path>"}`):供 workspace
   之外的启动(cron/launchd)用 `--team <key>` 解析。**非权威、自愈**:任何一次在 workspace
   内的 dev-loop 运行都会登记 cwd;丢失可重建;**不参与迁移**。

0.x 全局配置运行时**不读**(#11)。

### 3.3 运行状态布局(全部入 workspace,I4)

```
<workspace>/.dev-loop/
  <project>/…                           # delivery 状态+报告:今天 ~/.dev-loop/<project>/ 的整树平移
                                        #   (pm-state.json、reports/、runner-logs/ 内部结构不变 —— 实施细化 R1)
  team/…                                # stewardship 状态/报告 + 轮换 cursor + fires.jsonl 账本
  lessons/                              # team 级 lessons 库:INDEX.md + project 分片 + archive(§5.1)
  wt/<ticket>/<repo>/                   # §12c per-ticket worktree(M3 起顶层化;M1–M2 暂居 <project>/wt/)
  locks/<repo>.lock                     # base clone 变更操作的 advisory lock(§6.4)
  hub.db                                # service backend(#13;linear 时不存在)
  daemon.json                           # service daemon 运行文件(pid/port,瞬态)
```

`~/.dev-loop/` 只剩 `workspaces.json` 便捷索引 —— 可整目录删除而不丢任何数据。

---

## 4. 配置模型(1.x workspace schema)

### 4.1 `dev-loop.json`(workspace 根)

```jsonc
{
  "schemaVersion": 2,
  "team": {
    "key":          "jinko-devplatform",
    "backend":      "linear",              // "linear" | "service" —— 严格 team 级(I3)
    "linearTeam":   "Loop-1",              // linear:team 名;首次 add-project 对账后落 ID ↓
    "linearTeamId": null,
    "deployPolicy": { "dev": "auto", "prod": "manual" },   // 部署策略【上限】(§4.3)
    "docSystem":    "backend",             // team 默认:"local" | "backend";project 可覆盖
    "docs": {                              // team 文档库注册表(§5)—— 一等概念,种类可扩展
      "vision":  null,                     //   组合愿景(原 teamDoc):local 路径 | Linear 文档 | hub doc
      "lessons": { "mirror": false }       //   lessons 库权威固定在 .dev-loop/lessons/(§5.1);
    },                                     //   mirror=true → reflect 把 INDEX 镜像成 backend 文档(仅供人读)
    "autonomy":     "full",                // team 默认;project 可覆盖
    "mode":         "live",                // team 默认;project 可覆盖
    "comms": {                             // 对外交流管道(#8,§6.1)—— 与 backend 正交
      "provider":   "lark",                // "slack" | "lark"
      "webhookEnv": "DEVLOOP_COMMS_WEBHOOK"  // env-var 名(I5),不存字面量
    },
    "reports":      { "sink": "linear" },  // team 默认;project 可覆盖(§23 护栏不变)
    "agents": {                            // stewardship agent 的 team 级 launch 配置(I1)
      "sweep":  { "cadence": "30m" },      //   cadence = 时长字面量(ms/s/m/h/d),直接喂调度 interval
      "ops":    { "cadence": "1h" },
      "reflect": { "cadence": "1d" },
      "communication": { "cadence": "1d" }
    }
  },

  "repos": {                               // ★ 物理 registry:一个 repo 注册一次(I2)
    "portal": {
      "path":   "jinko-dev-platform",      // workspace 相对路径
      "remote": "git@github.com:jinkoso/jinko-dev-platform.git",
      "owner":  "devplatform",             // 运维/告警路由归属;单引用时可省(推断)
      "landing": "pr", "autoMerge": true,
      "mergeChecks": ["Validate PR Title", "Verify Worker Route Contract", "Lint & Build", "Build Docker Image"],
      "build":  { "typecheck": "npx tsc --noEmit", "build": "npm run build" },
      "deploy": { "style": "release-pr", "environments": {
        "dev":  { "auto": true,  "deployPrPrefix": "deploy/dev/" },
        "prod": { "auto": false, "deployPrPrefix": "deploy/prod/" } } },
      "ops":    { "checks": ["https://dev.builders.gojinko.com/api/health"] }
    }
  },

  "projects": {                            // ★ 虚拟单元:引用 repo,不拥有目录(#5)
    "devplatform": {
      "enabled":  true,                    // team 级开关(#9);false = delivery 全停
      "weight":   1,                       // 调度权重(§6);影响轮换频率
      "linearProject":   "Jinko DevPlatform",
      "linearProjectId": "ce2951dd-…",     // add-project 同步时落盘(#6),sync-project 对账
      "strategyDoc": { "linearDocument": "…" },
      "testEnv":  { "baseUrl": "…", "authConstraint": "…" },
      "devSplit": true,
      "agents":   { /* delivery agent 的两级 launch 配置,不变 */ },
      "repos": [                           // 引用 + 每-membership 角色
        { "ref": "portal", "role": "primary" }
      ]
    }
  }
}
```

### 4.2 解析规则

- **行为字段**(`mode` / `autonomy` / `docSystem` / `reports`):project 值 ∥ team 值(就近
  优先),同 §19。
- **物理字段**(`landing` / `autoMerge` / `mergeChecks` / `build` / `deploy` / `ops.checks`):
  **只在 repo registry 一处**。project 不得覆盖 —— 共享 repo 若允许每 project 一套部署
  语义,同一 clone 会出现互相矛盾的事实(这是把 I2 从"禁止共享"翻转为"注册唯一"的代价
  与收益:物理事实单点维护)。
- **membership 字段**(`role`):属于 project→repo 的引用边,每条引用各自声明。

### 4.3 deployPolicy 是【上限】,不是默认

语义不变:`deployPolicy.<env> = "manual"` ⇒ registry 中**任何** repo 的
`deploy.environments.<env>` 解析后必须 `auto:false`;违反 = 配置错误(doctor / `add-repo`
报错,agent 运行时二次校验并拒绝执行自动部署)。`"auto"` 只表示"允许"。

---

## 5. Team 文档库(一等概念,#16)

team 拥有自己的文档层 —— 不是"一个 teamDoc 字段",而是一个**文档库**:`team.docs` 注册表
声明文档种类;`docSystem` 决定人读文档的物理归宿(local → `<workspace>/docs/…`;backend →
Linear team 文档 / hub doc)。种类可扩展(未来如 ops runbook),1.x 内建两种:

| 种类 | 内容 | 维护者 | 物理归宿 |
|---|---|---|---|
| `vision` | 组合愿景 / 各 project 定位 / 跨项目原则(§8 拆分判界的依据) | 操作者为主,PM 只读引用 | 随 docSystem(local 或 backend) |
| `lessons` | 团队运行经验库(§5.1) | **reflect 独占写** | **固定 workspace 文件**(热路径装载成本 + I4);可选 backend 镜像供人读 |

三层全景:team 文档库(本节)→ project `strategyDoc`(§20,不变)→ module 设计文档
(§21a,不变)。PM boot 时若 `docs.vision` 存在则加载为上游北极星;缺省为空,一切照旧。

### 5.1 lessons 库:结构、装载预算与膨胀治理(#16,纳入 1.x)

单文件 lessons 会随 team 生长而膨胀,而它是**每次 fire 都装载的热路径** —— 所以结构与
预算是设计的一部分,不是预留后手:

```
<workspace>/.dev-loop/lessons/
  INDEX.md          # team 级精选:所有 agent 每次 fire 装载;硬上限(行数/字节)
  <project>.md      # project 分片:仅该 project 的 delivery fire 附加装载
  archive.md        # 冷存:不装载;下沉的历史条目(可检索,供 reflect 回溯)
```

- **装载预算固定**:任一 fire 的 lessons 注入 = `INDEX.md`(≤ 上限)+ 本 project 分片
  (≤ 上限)。token 成本是常数,与 team 规模、project 数、历史长度无关;stewardship
  agent 只装载 INDEX,不装载分片。
- **写入流(reflect 独占)**:新教训 → 判定作用域 —— team 共性进 INDEX,单 project 专属
  进对应分片;INDEX 触顶 → 低频/过时条目下沉到分片或 archive(**修剪即下沉,不丢历史**)。
- **镜像(可选)**:`docs.lessons.mirror=true` 时,reflect 每次维护后把 INDEX 单向发布为
  backend 文档(Linear 文档 / hub doc)—— 人读走 backend,机器读走文件;**权威永远是
  workspace 文件**(I4:迁移不依赖 backend)。

---

## 6. 调度与运行模型(loop 只在 team 层级启动,#9)

`dev-loop run`(cwd 在 workspace 内)或 `dev-loop run --team <key>`:**一个调度进程跑整个
team**。不再存在 per-project 的启动入口(调试用 `--project` 过滤保留,但那只是过滤,不是
另一种部署形态)。

| agent | fire 作用域(I1) | 跨 project 方式 |
|---|---|---|
| pm / qa / senior-dev / junior-dev | project | 调度器轮换:对每个 agent 种类,按 cadence 触发,在 `enabled` 的 project 间 **round-robin**,`weight` 决定相对频率(weight 2 = 两倍占比);fire 本身与今天完全一致 |
| sweep | team | 一次 fire 内部逐 enabled project 做板面清理,外加 team intake 收口 job(§8) |
| ops | team | 见 §6.2:按 repo registry **去重**巡检,按 `owner` 路由告警 |
| reflect | team | 见 §6.3:汇总全 team 报告,维护 team lessons 库(§5.1) |
| communication | team | 经 comms 管道对外播报(§6.1) |

- `enabled:false` 的 project:delivery 不 fire、sweep 跳过;其**独占** repo 的 ops 巡检
  同停;**共享** repo 因另一启用 project 而继续。`weight:0` 温和一档:只暂停 delivery
  轮换,steward 照常(维护模式)。
- Agent View 路线:每行一个 `/loop`,`--cwd` 指到 workspace 根 —— 行数 = agent 种类数,
  不再随 project 数增长。行模板先调 `dev-loop next-project --agent <a>` 拿本 fire 的
  project:**与 `dev-loop run` 共用同一份轮换 cursor**,两种跑法不重不漏。
- **token 成本**:change-gate(service)与 PM/QA 的 SHA 门(两 backend 通用)照常;静止
  project 的 fire 是廉价 no-op(gate skip 同 tick 轮到下一候选,安静 project 不吞 fire
  槽);`enabled:false` 整体暂停。

### 6.1 对外交流管道(comms,#8)

- team 级一份,**与 backend 完全正交**(linear team 也可以用 lark 通知,service team 也可以
  用 slack)。
- `provider: "slack" | "lark"`,两者都走 incoming-webhook,差异仅在消息 payload 适配器
  (slack blocks / lark interactive card)。`webhookEnv` 存 env-var 名(I5)。
- 消费方:communication agent(日报/周报)、escalation(needs-human/park)、可选的 landing
  通知。report sink(§22)照旧独立配置 —— comms 是"推送",sink 是"归档"。

### 6.2 ops 的跨 project 语义(#10)

一次 team fire:遍历 registry 中**至少被一个 enabled project 引用**的 repo(共享 repo 只查
一次 —— registry 带来的去重收益),对每个 repo 跑 `ops.checks` + 环境健康;发现问题 →
按该 repo 的 `owner` project 在 backend 建告警票(共享 repo 的告警只进 owner 的看板,不
重复建票)。报告落 `reports/team/ops/`。

### 6.3 lessons 与 reflect(#10)

- **lessons 在 team 层积累**,库结构与装载预算见 §5.1(INDEX + project 分片 + archive)。
- **reflect 是 team 作用域**:读全 team 的 reports(delivery + stewardship)与近史,按
  §5.1 写入流蒸馏 —— 跨 project 的共性教训(如 "release-pr 轮询要先 fetch")进 INDEX,
  单 project 专属进分片;INDEX 触顶即下沉。reflect 是 lessons 库的唯一写者。

### 6.4 共享 repo 的并发安全

- agent 的全部改动都在 per-ticket worktree(§12c)里,base clone 对 agent 只读;
- base clone 的变更操作(fetch / worktree add / prune)持 `locks/<repo>.lock` advisory 锁;
- 两个 project 同时改同一 repo → 天然收敛为普通 PR 竞争(autoMerge 轮询 checks,后到者
  rebase),无需新机制。

---

## 7. Backend 映射

### 7.1 linear

- `linearTeam` 收在 team 级。**首次 `add-project` 做 team 对账**:验证 team 存在、确保
  label 集(`dev-loop`、`needs-pm`、`repo:*`……)幂等存在、`linearTeamId` 落盘。init-team
  本身不碰 Linear(§9.1)。
- **project 与 Linear project 强对应(#6)**:`add-project` 当场 find-or-create Linear
  project 并落 `linearProjectId`;`sync-project` 对账改名/归档/labels/strategyDoc 漂移。
- team intake 载体:`dev-loop`+`needs-pm` 且不属于任何 project 的 team issue(§8)。
- **steward fire 的 MCP 作用域**:steward 以 workspace 根为 cwd 启动,repo 级 `.mcp.json`
  覆盖不到 —— Linear MCP 必须配置在 **user scope**(doctor 以 W05 提醒;delivery fire 的
  cwd 在 repo 内,不受影响)。

### 7.2 service(hub)

- **一库一 team**:`<workspace>/.dev-loop/hub.db`(#13)。不做多 team 单库、不加 teams 表
  —— workspace 即租户边界,schema 反而比早期草案更简单。
- **daemon 生命周期随 workspace(#17)**:hub 数据在 workspace 内,启停也必须以 workspace
  为单位 —— `dev-loop hub start`(cwd 解析 workspace,拉起 daemon,写 `.dev-loop/daemon.json`
  pid/port,幂等)/ `dev-loop hub stop`(优雅停 + WAL checkpoint,**复制 workspace 前必跑**)/
  `dev-loop hub status`(pid/port/库大小/上次 checkpoint)。service team 的 `dev-loop run`
  启动时**自动 ensure** hub 已起,操作者无需记两步。
- web UI 增加 team 总览(各 project 看板 + team intake 谱系视图)。
- mirror(P7)按 project 配置不变;保留 `_team` project 承载 team intake(§8)。
- sqlite 走 WAL:`doctor` 提供 checkpoint;复制 workspace 前停 daemon(§10.3)。

---

## 8. 跨项目协作:team intake(同 team 内;跨 team 永不做,#14)

复用并递归 §9a 的 W3 机制,不新增状态机:

1. **入口**:操作者提 team 级 intake —— linear:team issue(无 project)+
   `dev-loop`+`pm`+`needs-pm`;service:`_team` project 里的 `needs-pm` 票。
2. **拆分**(任意 project 的 PM fire 皆可认领):PM 的 Job B `needs-pm` 扫描扩展到 team 层。
   发现 team intake → 按各 project 职责(依据 vision 文档的定位描述,§5)拆成**每 project 一张
   普通 W3 子 intake**(child `relatedTo` parent,parent 反链 + 评论子票 ID),parent →
   `In Review`。
3. **各 project 正常消化**自己的子 intake(现有 §9a 行为)。
4. **收口**(sweep 的 team job):全部子 intake `Done` ⇒ parent → `Done`(附汇总评论);
   任一子票 park ⇒ parent 保持 In Review 并评论指出堵点。
5. 拆分幂等(parent 有子票反链即视为已拆);PM 只做"按 project 分工",不做深方案设计。

---

## 9. 操作者体验:工具入口(#7)

### 9.1 为什么 `init team` 不需要 coding CLI

`init-team` 的全部输入都是**操作者已知的事实**(team key、backend、Linear team 名、
deployPolicy、comms provider + webhookEnv、reports sink),没有任何需要读代码或访问 backend
的判断;它的产出是确定性脚手架(`dev-loop.json` + `.dev-loop/` 目录 + service 时初始化
hub.db)。因此做成**纯 CLI 交互命令**:`dev-loop team init` —— 快、可脚本化、不烧 token、
不依赖 MCP。backend 侧的写操作与对账(验证 Linear team、label 集、创建 project)全部推迟到
第一次 `add-project` —— 它天然运行在带 MCP 的 coding CLI 里。这也保持 hub 对 backend 零
依赖(hub 从不直连 Linear)。

反之 add/sync 系列**必须**在 coding CLI 里跑:需要仓库理解(侦测构建命令、从 PR workflow
派生 mergeChecks)、backend MCP 写操作(project/label/文档)、以及对抗校验式的判断 —— 正是
LLM 面。

### 9.2 命令与 skill 清单(全部幂等)

| 入口 | 形态 | 职责 |
|---|---|---|
| `dev-loop team init` | **纯 CLI** | 创建 workspace:面试 backend / linearTeam / deployPolicy / docSystem / comms / reports → 写 `dev-loop.json` + `.dev-loop/` 脚手架;service → 初始化 hub.db。**不建任何 project,不碰 backend。** |
| `/dev-loop:add-project` | coding CLI skill | 加 project:**当场同步 backend**(find-or-create Linear/hub project,落 ID;首次顺带 team 对账 + label 集)、strategyDoc 脚手架(§20 headings)、testEnv/devSplit/agents 面试、状态目录。 |
| `/dev-loop:add-repo` | coding CLI skill | 一遍到位加 repo:clone 进 `<workspace>/<name>/`(或登记已有)→ 侦测 build + 从 PR workflow 派生 mergeChecks → 部署面试(受 deployPolicy 上限校验)→ 写 registry + project 引用(`ref`/`role`,共享时要求 `owner`)→ `repo:<name>` label → mini-MAP + 对抗校验把 repo 现状追加进 strategyDoc。 |
| `/dev-loop:sync-project` | coding CLI skill | 对账 config ↔ backend project:改名/归档/labels/strategyDoc 漂移 → 出 diff → 确认写回。 |
| `/dev-loop:sync-repo` | coding CLI skill | 重侦测 build/mergeChecks/deploy 与 remote 漂移;clone-if-missing;`git worktree repair` + prune。 |
| `dev-loop doctor` | 纯 CLI | 只读检查：schema 校验、deployPolicy 上限、路径存在性、probe、Linear MCP 可达性、运行健康。修复动作由 `dev-loop team repair` 执行。 |
| `dev-loop hub start / stop / status` | 纯 CLI | service:按 workspace 管理 hub daemon(#17)—— start 幂等拉起(`.dev-loop/hub.db` + `daemon.json`);stop 优雅停 + WAL checkpoint;status 报 pid/port/库健康。`dev-loop run` 对 service team 自动 ensure。 |

`dev-loop export-desktop-skill` 增加 `--team`(渲染 team 上下文)。

---

## 10. 换机与落地演练

### 10.1 devplatform team `jinko-devplatform`(linear)

1. `dev-loop team init`(workspace = `/Users/shuai/workspace/loop/`,backend=linear,
   linearTeam=Loop-1,deployPolicy `{dev:auto, prod:manual}`,comms=lark);
2. 在 coding CLI 中运行 `/dev-loop:add-project` 写入 project 条目并同步 backend;
3. 运行 `/dev-loop:add-repo` 登记 repo registry;repo clone 已在 workspace 内,登记相对路径即可;
4. 首次 `/dev-loop:sync-project` 补 `linearProjectId` / `linearTeamId` 对账。

### 10.2 jinko-backoffice → team `jinko-backoffice`(service)

同样 `team init`(backend=service,初始化 `.dev-loop/hub.db`)，再用 add/sync skill 补齐 project
与 repo;它成为独立 team,与 devplatform 互不影响。

### 10.3 跨机器迁移(#12):复制文件夹即可

1. (service)`dev-loop hub stop`(优雅停 + WAL checkpoint);等 fires 空窗;
2. **复制 workspace 目录**到新机器(配置/状态/报告/lessons/hub.db/repo clones 全在内,I4);
3. 新机器一次性环境:装 dev-loop CLI + coding CLI、`gh auth`、设 env 变量(comms webhook、
   token —— 名字在配置里,值随机器,I5);
4. `cd <workspace> && dev-loop doctor`:worktree repair(git worktree 内嵌绝对路径,repair
   修复)、索引自愈登记、WAL checkpoint 校验;
5. 起 loop。没有第 6 步。

---

## 11. 分阶段实施(0.30–0.34 递进,完成后发 1.0 GA,#15)

| 里程碑 | 版本 | 内容 | 验收 |
|---|---|---|---|
| **M1 配置内核** | 0.30.0 | 1.x workspace schema(registry + 虚拟 project)+ 解析器(含共享 repo 的 project 推断/报错)+ 状态入 workspace + `team init` / doctor。**breaking:运行时不再读 0.x 全局配置**(断裂发生在 0.x 线内,合规) | 解析器/上限校验/推断歧义全测试面;两个 team 的 workspace 干跑 diff |
| **M2 操作技能** | 0.31.0 | `add-project` / `add-repo` / `sync-project` / `sync-repo`(backend 同步即时化,#6) | devplatform 实迁 + 用 `add-repo` 真实加一个新 repo(如 mcp-bff)一遍过 |
| **M3 team 调度** | 0.32.0 | team 级唯一 loop:轮换 + weight + enabled + 共享 picker(`next-project`,Agent View 同源);**全 agent 本版仍 per-project fire**;`--project` 降级为过滤器 | 双 project 轮换烟测;`enabled:false` 全停验证 |
| **M4 stewardship + 文档库** | 0.33.0 | sweep/ops/reflect/communication 升 team 作用域(**含 hub op-API 的 steward project 覆盖,自 M5 提前** —— 与 SKILL 重写同批,消除倒挂);**lessons 库(§5.1:INDEX/分片/archive + 装载预算 + 可选镜像)**;comms(slack/lark)适配器 | ops 去重巡检 + owner 路由 + op-API 覆盖用例;INDEX 触顶下沉用例;lark 真实推送 |
| **M5 service team 化 + intake** | 0.34.0 | hub-in-workspace daemon + **`dev-loop hub start/stop/status` + run 自动 ensure(#17)** + web team 总览;team intake(§8) | backoffice 实迁;一张真实跨 project intake 端到端 |
| **GA** | **1.0.0** | **无新功能**:全里程碑完成 + 两个真实 team 稳定运行 ≥1 周 + conventions/config-schema 全量对齐 → 打稳定契约的标(#15) | 迁移清单 §10.3 在第二台机器完整演练一遍 |

每个里程碑独立可发布;M1/M3 是纯代码 + 完整测试面;M2/M4/M5 以两个真实 team 的迁移与运行
作端到端验收;**1.0.0 是毕业发布,不夹带新功能** —— 它宣告 team 模型成为稳定契约。

---

## 12. 风险与开放问题

1. **共享 repo 的并发**:worktree 隔离 + advisory 锁 + PR 竞争收敛(§6.4);监控点是
   autoMerge 轮询在竞争下的重试上限。
2. **可迁移性的边角**:git worktree 的绝对路径(doctor repair 兜底)、sqlite WAL(迁移前
   checkpoint)、node_modules 跨平台不可靠 —— 无所谓,§12c 已确立 PR CI 是构建门,本地
   产物皆可弃。
3. **backend 漂移**:Linear 侧改名/归档不通知我们 → `sync-project` 对账 + doctor 提示
   上次 sync 时间。
4. **project 推断歧义**:共享 repo 下 cwd 无法唯一定位 project → 一律显式(§3.2),宁可
   烦一点不可猜。
5. **token 成本随 project 数增长**:SHA/change 门 + `enabled`/`weight`;必要时 M3 加
   "team 静默窗口"(全 team 无变更拉长 cadence)。
6. **PM 拆分 team intake 的判界**:依赖 vision 文档的 project 定位描述;缺失时 park 回
   操作者,不猜。
7. **lessons 库的精选质量**:膨胀本身已由 §5.1 的结构治理(纳入 1.x);残余风险是 reflect
   "什么进 INDEX"的判断 —— 触顶下沉 + archive 不丢历史兜底,坏判断可回捞。
