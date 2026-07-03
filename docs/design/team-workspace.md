# Team / Workspace — dev-loop v-next 设计与改进方案

> 状态:**proposal**(操作者已确认四个关键取向,见 §0.2)。2026-07-03。
> 起点:0.29.0(landing:pr / autoMerge / release-pr / per-repo overrides / reports sink 均已落地)。

---

## 0. 结论摘要

引入 **team** 作为顶层配置单元,与一个 **workspace(具体目录)** 一一对应;workspace 内含多个
**project**,每个 project 由多个 **repo** 组成。三层直接对应 Linear 的 team → project,以及
GitHub 的 repo。操作流:选定 workspace → `init-team` 生成 team 配置(backend、部署策略、文档
系统) → 用 skill 逐个 `add-project` / `add-repo` → loop 开跑。

**一条不变式贯穿全设计:agent fire 仍以 project 为原子单位。** team 是配置、调度与 intake
路由层,不是新的 agent 作用域——全部现有 SKILL 状态机(§3/§4/§12b/§12c/验收/报告)原样复用,
这是本方案最主要的去风险手段。

### 0.1 一图流

```
team (= workspace 目录, = Linear team, 一个 backend)
 ├─ dev-loop.json                ← team 配置(机器本地,不提交)
 ├─ docs/                        ← team 级文档(docSystem=local 时)
 ├─ <project-A>/                 ← project(= Linear project)
 │   ├─ <repo-1>/                ← git clone(= GitHub repo)
 │   └─ <repo-2>/
 └─ <project-B>/
     └─ <repo-3>/
```

### 0.2 操作者已确认的四个取向

| 问题 | 决定 |
|---|---|
| repo 物理位置 | **全部克隆在 workspace 内**,配置用 workspace 相对路径 |
| 配置共享 | **机器本地**(workspace 不做 meta-repo;不排除未来升级,见 §12) |
| backend 层级 | **严格 team 级**;现有 backoffice(service)与 devplatform(linear)拆为两个 team |
| 跨 project 协作 | **要**:team 级 intake 拆分为各 project 子票(§8) |

---

## 1. 动机:现状痛点

1. **配置是机器全局平面**。`~/.dev-loop/projects.json` 一个文件装所有 project,绝对路径绑定
   机器;加一个 repo 要人肉编辑全局文件(0.28.0 的 per-repo overrides 已把字段准备好,但入口
   仍是散的)。
2. **Linear 映射靠约定**。`linearTeam` 逐 project 重复填写;label 逐 team 提供但由每次 init
   重复对账;没有一个"这组 project 属于同一个团队"的一等概念。
3. **多 project 无调度关系**。两个 project 就要起两套 Agent View / 两个 `dev-loop run`;
   没有 team 级的开关、权重、公共策略(如 "prod 永远手动")。
4. **跨 project 的需求没有入口**。一个横跨 devplatform + backoffice 的功能,今天只能操作者
   手工拆成两个 intake。
5. **文档系统位置逐 project 各自为政**(repo 文件 / Linear 文档 / hub 文档),没有 team 级
   默认;也没有 team 级的"组合愿景"文档层。

---

## 2. 概念模型与不变式

| 概念 | 对应 | 说明 |
|---|---|---|
| **team** | workspace 目录;Linear team;(service)hub 的 team 行 | 顶层配置单元;**一个 team 一个 backend** |
| **project** | workspace 内的一个分组;Linear project;hub project | loop 的运行单元(fire 的原子作用域,不变) |
| **repo** | `<workspace>/<project>/<repo>/` 的 git clone;GitHub repo | 代码单元;0.28.0 的 per-repo overrides 原样适用 |

**不变式(设计约束,实现必须保持):**

- **I1 — fire 原子性**:每次 agent fire 恰好作用于一个 project。team 只出现在配置解析、调度
  器与 intake 路由里,不出现在 PM/QA/Dev 的工作循环语义里。
- **I2 — repo 归属唯一**:一个 repo 恰好属于一个 project(禁止共享;共享代码应自成 project)。
- **I3 — 一个 team 一个 backend**:linear 或 service,不混。跨 backend 的协作不存在(两个
  team 之间没有自动协作,见 §8 边界)。
- **I4 — 配置只加不破**:legacy `projects.json`(schema v1)永远可读;v2 是叠加层
  (read-side 兼容,§10)。
- **I5 — 秘密不落盘**:team 配置沿用 §16(env-var 名,不存字面量)。

---

## 3. Workspace 布局与解析

### 3.1 目录约定

```
<workspace>/
  dev-loop.json          # team 配置(schema v2;机器本地,workspace 不是 git repo)
  docs/                  # team 级文档(docSystem=local 时;可选)
  <project-key>/<repo-name>/   # 推荐脚手架;不强制 —— 配置里的相对路径才是权威
```

- 配置中的 `repos[].path` 一律 **workspace 相对路径**。`<project>/<repo>` 是 `add-repo` 的
  默认脚手架,不是硬规则(迁移期一个已有 repo 直接躺在 workspace 根下也合法,见 §10)。
- workspace 本身**不是** git repo(操作者选择);`dev-loop.json` 天然机器本地。子 repo 各自
  是独立 git clone。

### 3.2 解析(precedence,自上而下)

1. `DEVLOOP_TEAM` + `DEVLOOP_PROJECT` 显式指定(空串视为未设,同 DL-13);
2. **cwd 向上爬找 `dev-loop.json`** → team;再用 cwd 匹配 `repos[].path`(realpath、段边界
   安全、最近祖先优先,复用 DL-13 匹配器)→ project;
3. 全局索引 `~/.dev-loop/workspaces.json`(`{"<team-key>": "<abs workspace path>"}`,由
   `init-team` 写入)→ 供 workspace 之外的启动(cron/launchd)用 `--team <key>` 解析;
4. legacy `projects.json`(v1)兜底 —— 老项目完全不感知新层。

### 3.3 机器本地状态布局

```
~/.dev-loop/
  workspaces.json                       # team 索引(新)
  <team>/<project>/pm-state.json        # 状态文件下沉一层
  <team>/<project>/qa-state.json
  <team>/<project>/lessons.md
  <team>/<project>/reports/<agent>/…
  <team>/<project>/wt/<ticket-id>/      # §12c per-ticket worktree
  hub.db                                # service:单库,加 team 维度(§7.2)
```

读侧兼容:找不到 `<team>/<project>/X` 时回落 `<project>/X`(现状路径),再回落根级
legacy 文件(§14 既有规则)。

---

## 4. 配置模型(schema v2)

### 4.1 `dev-loop.json`(workspace 根)

```jsonc
{
  "schemaVersion": 2,
  "team": {
    "key":        "jinko-platform",       // team 短名(状态目录、索引键)
    "backend":    "linear",               // "linear" | "service" —— 严格 team 级(I3)
    "linearTeam": "Loop-1",               // linear:Linear team 名(labels 按 team 提供一次)
    "hub":        { "db": null },          // service:hub 配置(linear 时忽略)
    "deployPolicy": {                      // 部署策略【上限】(§4.3):project/repo 只能更保守
      "dev":  "auto",                      // "auto"(允许 loop 自动部署 dev)| "manual"
      "prod": "manual"                     // prod 永远 manual 是推荐默认
    },
    "docSystem":  "backend",              // team 级文档系统默认:"local"(workspace/docs 或 repo 文件)
                                           //   | "backend"(Linear 文档 / hub doc)。project 可覆盖。
    "teamDoc":    null,                    // 可选:team 级组合文档(愿景/portfolio)。local → 相对路径;
                                           //   backend → Linear 文档 URL / {"hubDoc":"team-strategy"}
    "autonomy":   "full",                  // team 默认;project 可覆盖(不受上限约束——上限只管部署)
    "mode":       "live",                  // team 默认;project 可覆盖
    "notify":     { "type": "lark", "webhookEnv": "DEVLOOP_NOTIFY_WEBHOOK" },  // team 级一份
    "reports":    { "sink": "files" }      // team 默认;project 可覆盖(§23 护栏不变)
  },
  "projects": {
    "<project-key>": {
      "linearProject": "Jinko DevPlatform",   // = Linear project(service 时为 hub project 名)
      "strategyDoc":   { "linearDocument": "…" },  // 不变(repo 文件 | Linear 文档 | hub doc)
      "testEnv":       { "baseUrl": "…", "authConstraint": "…" },
      "devSplit":      true,
      "weight":        1,                   // 调度权重(§6);0 = 暂停该 project
      "enabled":       true,
      "agents":        { /* 现有两级 launch 配置,不变 */ },
      "repos": [                            // 0.28.0 的 per-repo 字段原样;path 改为 workspace 相对
        { "name": "portal", "path": "devplatform/jinko-dev-platform", "role": "primary",
          "landing": "pr", "autoMerge": true,
          "mergeChecks": ["Validate PR Title", "Verify Worker Route Contract", "Lint & Build", "Build Docker Image"],
          "build": { "typecheck": "npx tsc --noEmit", "build": "npm run build" },
          "deploy": { "style": "release-pr", "environments": {
            "dev":  { "auto": true,  "deployPrPrefix": "deploy/dev/" },
            "prod": { "auto": false, "deployPrPrefix": "deploy/prod/" } } } }
      ]
    }
  }
}
```

### 4.2 三级解析规则(§19 的直接扩展)

任一可覆盖字段的生效值 = **repo 值 ∥ project 值 ∥ team 值**(就近优先)。字段归属:

| 层 | 独占字段 | 可被下层覆盖的默认 |
|---|---|---|
| team | `backend`、`linearTeam`/`hub`、`deployPolicy`、`teamDoc`、`notify` | `mode`、`autonomy`、`docSystem`、`reports` |
| project | `linearProject`、`strategyDoc`、`testEnv`、`devSplit`、`weight`、`agents` | `landing`/`autoMerge`/`mergeChecks`/`build`/`deploy`(作为 repo 的默认) |
| repo | `path`、`name`、`role` | —(最末层) |

### 4.3 deployPolicy 是【上限】,不是默认

语义:`deployPolicy.<env> = "manual"` ⇒ 该 team 内**任何** repo 的 `deploy.environments.<env>`
解析后必须 `auto:false`;违反 = 配置错误(doctor/`init` 报错,agent 运行时二次校验并拒绝执行
自动部署)。`"auto"` 只表示"允许",repo 仍可自行选择 manual。环境名按 key 匹配
(`dev`/`prod`/自定义)。这把"这个团队 prod 永远人工"从逐 repo 约定升级为一条机器可校验的
治理规则。

---

## 5. 文档体系(三层)

| 层 | 文档 | 维护者 | 位置(docSystem) |
|---|---|---|---|
| team | `teamDoc`:组合愿景 / 各 project 定位 / 跨项目原则 | 操作者为主,PM 只读引用 | local → `workspace/docs/…`;backend → Linear 文档 / hub doc |
| project | `strategyDoc`(§20,不变) | PM(现状机制:docWatch、Decisions log、append-only) | 不变 |
| module | 设计文档(§21a,不变) | senior-dev | 不变 |

变化只有一条:**PM boot 时若 `teamDoc` 存在则加载为上游北极星**——project 的 Goals 与 team
方向冲突时,PM 在 Decisions log 里记录并以 team 文档为准(或 park 给操作者)。teamDoc 缺省
为空,一切照旧。

---

## 6. 调度与运行模型

- `dev-loop run --team <key>`(或 cwd 在 workspace 内):**一个调度进程跑整个 team** ——
  对每个 `enabled` 的 project,按现有 per-agent cadence 生成 fire 计划,**交错(stagger)+
  round-robin** 执行;`weight` 决定同一 agent 在多 project 间的相对频率(weight 2 = 两倍
  fire)。`--project <key>` 仍可只跑一个。
- **每次 fire 的命令与今天完全一致**(I1):解析到的仍是"一个 project 的一次 agent 调用",
  MCP 按 team 的 backend 接线(0.28.0 的 backend-gated 注入,linear team 不注 hub)。
- Agent View 路线不变:每行一个 `/loop`,`--cwd` 指到 workspace 内任一位置即可解析。
- 状态文件、reports、worktrees 全部落 `~/.dev-loop/<team>/<project>/…`(§3.3)。
- **token 成本控制**:R1 change-gate(service)与 PM/QA 的 SHA 门(两 backend 通用)照常
  生效;一个静止的 project 的 fire 是廉价 no-op。`weight:0` 可整体暂停一个 project。

---

## 7. Backend 映射

### 7.1 linear

- `linearTeam` 上收到 team 级;**label 集按 team 提供一次**(labels 本就是 Linear team 作用
  域,现状 init 逐 project 对账的重复劳动消失)。
- project = Linear project(现状);reports sink、strategyDoc=Linear 文档等机制不变。
- **team intake 的载体**:Linear 原生支持"无 project 的 team issue" —— 一张
  `dev-loop`+`needs-pm` 且**不属于任何 project** 的 team issue 即 team 级 intake(§8)。

### 7.2 service(hub)

- 单一 `hub.db` 增加 `teams` 表 + `projects.team_id`(迁移脚本;旧行归入自动生成的
  single-project team)。
- **daemon 按 team 起一个**(一个端口服务全 team):web UI 增加 team 总览(各 project 看板
  + team intake 谱系视图);`daemon-<team>.json` 运行文件。旧 per-project daemon 兼容运行。
- mirror(P7)按 project 配置不变;`_team` 保留 project 承载 team intake(§8)。

---

## 8. 跨项目协作:team intake(本版纳入)

复用并递归 §9a 的 W3 机制,**不新增状态机**:

1. **入口**:操作者在 team 层面提一张 intake ——
   linear:team issue(无 project)+ `dev-loop`+`pm`+`needs-pm`;
   service:保留 project `_team` 里的一张 `needs-pm` 票。
2. **拆分(任意 project 的 PM fire 皆可认领)**:PM 的 Job B `needs-pm` 扫描扩展到 team 层。
   发现 team intake → 按各 project 的职责把它拆成 **每 project 一张普通 W3 子 intake**
   (child `relatedTo` parent,parent 反链 + 评论子票 ID —— §9a 原机制),然后 parent →
   **`In Review`**(注意:不同于单 project W3 的立即 Done —— 跨项目需要端到端跟踪)。
3. **各 project 正常消化**自己的子 intake(方向→改文档+发 Feature;构建→拆 Dev 子票),
   完全是现有 §9a 行为。
4. **收口(Sweep 新增 team job)**:Sweep 每轮检查 `In Review` 的 team intake —— 其全部子
   intake `Done` ⇒ parent → `Done`(附各子票结果汇总评论);任一子票 park ⇒ parent 保持
   In Review 并在评论里指出堵点。
5. **边界**:同 team(=同 backend)内有效;跨 team 不自动协作(I3),操作者手工分发。

风险控制:拆分是幂等的(parent 上有子票反链即视为已拆,重复 fire 直接跳过);PM 拆分只做
"按 project 分工",不做深方案设计(那是各 project PM/senior-dev 的事)。

---

## 9. 操作者体验:skill 分解

现有单体 `init` 分解为四个操作者在场(operator-present)的 skill,全部幂等:

| skill | 职责 |
|---|---|
| **`/dev-loop:init-team`** | 在当前目录(或指定目录)创建 workspace:生成 `dev-loop.json`(backend / deployPolicy / docSystem / notify / reports 面试),写 `workspaces.json` 索引;linear → 按 team 提供 label 集;service → hub team 播种 + daemon。**不建任何 project。** |
| **`/dev-loop:add-project`** | 向 team 加一个 project:Linear project(或 hub project)创建/复用、strategyDoc 脚手架(§20 headings)、testEnv/devSplit/agents 面试、状态文件。 |
| **`/dev-loop:add-repo`** | **一遍到位加 repo**:`git clone` 进 `<workspace>/<project>/`(或登记已有相对路径)→ 自动侦测 build 命令 + 从 PR workflow 派生 `mergeChecks`(0.28.0 P2-10)→ 部署面试(release-pr/command,受 deployPolicy 上限校验)→ 写入 `repos[]` → 提供 `repo:<name>` label(该 project 第二个 repo 起)→ mini-MAP + 对抗校验(P2-11)把 repo 现状追加进 strategyDoc Current state。 |
| **`/dev-loop:init`(legacy)** | 保留:单 project 旧流程,产出 v1 配置(I4)。提示可用 `migrate-workspace` 升级。 |
| `dev-loop migrate-workspace`(CLI) | v1 → v2 辅助:生成 `dev-loop.json` 草稿、移动状态目录、(可选)把 repo 移入 workspace,并打印 diff 供确认。 |

`dev-loop export-desktop-skill` 增加 `--team`(渲染 team 上下文);`dev-loop doctor` 增加
schema v2 校验(deployPolicy 上限、路径存在性、索引一致性)。

---

## 10. 迁移与兼容(以现有两个项目为例)

**原则(I4)**:v1 `projects.json` 永远可读;所有 agent 的配置装载走同一个解析器,v2 命中则
用 v2,否则回落 v1。**不做自动改写**(§19 既有铁律的延伸)。

**devplatform → team `jinko-devplatform`(linear)**
1. `/dev-loop:init-team`(workspace = `/Users/shuai/workspace/loop/`,backend=linear,
   linearTeam=Loop-1,deployPolicy `{dev:auto, prod:manual}`);
2. `migrate-workspace`:把现 `projects.devplatform` 平移进 `dev-loop.json`
   (repoPath → 相对路径 `jinko-dev-platform`;可留在 workspace 根,或移入
   `devplatform/` 项目目录 —— 相对路径是权威,目录约定不强制);
3. 状态目录 `~/.dev-loop/devplatform/` → `~/.dev-loop/jinko-devplatform/devplatform/`
   (migrate 命令代劳;读侧本就有回落,不迁也能跑)。

**jinko-backoffice → team `jinko-backoffice`(service)**:同样一次 `init-team`(backend=
service)+ 平移;hub 迁移脚本把既有 project 行挂到新 team 行下。它成为独立 team,与
devplatform 互不影响 —— 正是"两个 team、backend 严格 team 级"的选择。

**加新 repo(如 mcp-bff)从此 = 一条命令**:`/dev-loop:add-repo mcp-bff --project devplatform
--from git@github.com:jinkoso/mcp-bff.git` —— clone、侦测、面试、写配置、label、文档,一遍
完成(0.28.0 已把 per-repo 字段与派生逻辑备齐,本版补上入口与物理布局)。

---

## 11. 分阶段实施

| 里程碑 | 内容 | 交付物 | 版本 |
|---|---|---|---|
| **M1 配置与解析** | schema v2 + 三级解析 + deployPolicy 上限校验 + `workspaces.json` 索引 + cwd 爬升解析 + v1 回落;doctor 校验 | 解析器(hub/src 共享)+ conventions §25(team 层)+ config-schema v2 节;**对 v1 零行为变化** | 0.30.0 |
| **M2 操作技能** | `init-team` / `add-project` / `add-repo` / `migrate-workspace`;export-desktop-skill `--team` | 四个 skill + CLI;devplatform 实际迁移作为验收 | 0.31.0 |
| **M3 team 调度** | `dev-loop run --team`(多 project 交错 + weight)+ 状态目录下沉 `<team>/<project>/` | run-agents team 模式 + 读侧回落;Agent View 文档更新 | 0.32.0 |
| **M4 service team 化** | hub `teams` 表 + 迁移脚本 + per-team daemon + web UI team 总览 | hub schema v(n+1) + daemon/webui;backoffice 迁移作为验收 | 0.33.0 |
| **M5 team intake** | §8:linear team-issue / hub `_team` 入口 + PM 拆分 job + Sweep 收口 job + 谱系视图 | pm/sweep SKILL 扩展 + conventions §9b | 0.34.0 |

每个里程碑独立可发布、可回退;M1/M3 有完整测试面(解析器与调度器都是纯代码);M2/M5 以
devplatform/backoffice 的真实迁移与一张真实跨项目 intake 做端到端验收。

## 12. 风险与开放问题

1. **token 成本随 project 数线性增长**:靠 change-gate/SHA 门 + `weight:0` 暂停缓解;M3 可加
   "team 静默窗口"(全 team 无变更时拉长所有 cadence)。
2. **workspace 迁移/改名**:索引失效 → doctor 检测 + `migrate-workspace --relocate` 修复。
3. **配置共享的后门**:本版机器本地;若未来要共享,v2 schema 已是相对路径,升级成 meta-repo
   只是"把 dev-loop.json 纳入 git"一步(secrets 已按 §16 隔离),不需要 schema 变更。
4. **hub 单库多 team 的隔离**:沿用 project 隔离测试面,新增 team 维度用例;不做多库。
5. **跨 team 协作**:明确不做(I3);出现真实需求时再评估"联邦 intake"。
6. **PM 拆分 team intake 的判界**("哪个 project 负责什么"):依赖 teamDoc 里的 project 定位
   描述;teamDoc 缺失时 PM park 回操作者,不猜。
