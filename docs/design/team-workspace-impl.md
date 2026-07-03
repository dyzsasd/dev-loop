# Team / Workspace 1.0 — 详细设计稿 + 开发/测试任务

> 上游:`team-workspace.md`(proposal v3,§ 引用均指向它与 `references/conventions.md`)。
> 本稿是**工程级**:模块落点、类型定义、算法、命令规格、skill 规格,以及按里程碑切好的
> 开发任务(**D-x.y**)与测试任务(**T-x.y**)。规模标记:S ≤ 半天,M ≈ 1 天,L ≈ 2–3 天。
> 评审修订(同日):**M3/M4 重排**(steward team 化与 SKILL/op-API 同批,消除里程碑倒挂)、
> E11 命名校验、import 事件重键、`next-project` 共享轮换 picker、fires.jsonl 账本。

---

## 0. 两个设计细化(相对 proposal 的显式偏差)

- **R1 状态目录形状**:proposal §3.3 画的是 `.dev-loop/state/<project>/` + `.dev-loop/reports/<project>/`。
  实现取**整体平移**:今天 `~/.dev-loop/<project>/…` 的全部内部结构(pm-state.json、reports/、
  runner-logs/、scheduler-gate.json)原样搬进 `<ws>/.dev-loop/<project>/…`;team 级 agent 用
  `<ws>/.dev-loop/team/…`。理由:M1 零 SKILL 改动(SKILL 里的路径全部经 `${DEVLOOP_DATA_DIR}`
  替换,只换根即可),import = 一次 `mv`。
- **R2 doctor 只读契约不破**:proposal §10.3 说 doctor 做 worktree repair —— 但 doctor 的既有
  契约是 READ-ONLY(DL-54:绝不 create/修复,防止把毁掉的 SoR 洗绿)。修复动作全部归到新命令
  **`dev-loop team repair`**(worktree repair、索引重登记、WAL checkpoint);doctor 只检测报告。

---

## 1. 代码落点总览

| 文件 | 动作 | 里程碑 | 内容 |
|---|---|---|---|
| `hub/src/team-config.ts` | 新增 | M1 | schema v2 类型 + 解析/校验(E-codes)+ 三级解析 + 兼容视图 |
| `hub/src/workspace.ts` | 新增 | M1 | workspace 发现(cwd 爬升)、状态路径 API、`workspaces.json` 索引自愈 |
| `hub/src/paths.ts` | 改造 | M1 | workspace 感知的 dataDir/hubDb;**删除** v1 候选链(breaking) |
| `hub/src/resolve-project.ts` | 改造 | M1 | DL-13 匹配器喂 registry;`inferProjectForRepo`;`resolveIdentity` 走 v2 |
| `hub/src/team-init.ts` | 新增 | M1 | `dev-loop team init`(交互 + 非交互 flags) |
| `hub/src/team-import.ts` | 新增 | M1 | v1 → workspace 一次性转换(--dry-run 计划) |
| `hub/src/team-repair.ts` | 新增 | M1 | worktree repair / 索引登记 / WAL checkpoint(R2) |
| `hub/src/doctor.ts` | 改造 | M1 | workspace 模式检查(只读):E-codes、上限、路径、预算 |
| `hub/src/cli.ts` | 改造 | M1/M3/M4/M5 | 路由:`team …`、`with-repo-lock`、`notify`、`hub …` |
| `hub/src/run-agents.ts` | 改造 | M1(读 v2)/ M3(team 调度) | 兼容视图接入;WRR 轮换、enabled/weight、team 锁、`--plan` |
| `hub/src/locks.ts` | 新增 | M3 | 从 daemon-lifecycle 抽出 O_EXCL+stale 锁;`with-repo-lock` 用 |
| `hub/src/rotation.ts` | 新增 | M3 | 平滑 WRR + cursor 持久化 + `next-project` CLI(run 与 Agent View 共用) |
| `hub/src/lessons.ts` | 新增 | M4 | lessons 库路径 + 预算检查(doctor 消费) |
| `hub/src/comms.ts` | 新增 | M4 | slack/lark webhook 适配器 + `dev-loop notify` |
| `hub/src/daemon-lifecycle.ts` | 改造 | M5 | workspace 化:`.dev-loop/daemon.json` 单运行文件、`hub start/stop/status` |
| `hub/src/agentops.ts` / `tooldefs.ts` | 改造 | M4 | steward actor 的显式 project 覆盖(op-API;评审修订:自 M5 提前,steward team 化的硬依赖) |
| `hub/src/daemonviews.ts` | 改造 | M5 | web UI team 总览页 |
| `hub/src/export-desktop-skill.ts` | 改造 | M2 | `--team` 渲染 team 上下文 |
| `skills/{add-project,add-repo,sync-project,sync-repo}/SKILL.md` | 新增 | M2 | 操作 skill(§10) |
| `skills/*-agent/SKILL.md` | 改造 | M4/M5 | lessons 路径、vision 装载、ops/reflect/sweep/communication team 化、intake |
| `references/conventions.md` / `config-schema.md` | 改造 | 每里程碑 | §25 team、§19 重写、§7/§12c 路径、§9b intake、schema v2 |

---

## 2. `team-config.ts`:类型、校验、解析

### 2.1 类型(实际 TS 定义)

```ts
export interface TeamFile {
  schemaVersion: 2;
  team: TeamBlock;
  repos: Record<string, RepoEntry>;        // ref → 物理注册(I2:注册唯一)
  projects: Record<string, ProjectEntry>;  // key → 虚拟单元
}

export interface TeamBlock {
  key: string;                              // ^[a-z0-9-]{2,32}$
  backend: "linear" | "service";
  linearTeam?: string;                      // linear 必填(E09)
  linearTeamId?: string | null;             // 首次 add-project 对账落盘
  deployPolicy?: Record<string, "auto" | "manual">;   // env 名 → 上限(§4.3)
  docSystem?: "local" | "backend";          // 默认 "backend"
  docs?: { vision?: DocRef | null; lessons?: { mirror?: boolean } };
  autonomy?: "full" | "guarded";            // team 默认,project 可覆盖
  mode?: "live" | "dry-run";
  comms?: { provider: "slack" | "lark"; webhookEnv: string };  // I5:存 env 名
  reports?: unknown;                        // §22/§23 形状原样(team 默认)
  agents?: Record<string, AgentLaunchConfig & { cadence?: string }>;  // steward 的 team 级 launch
  defaultCodingAgent?: string;
  codingAgentDefaults?: Record<string, { model?: string; effort?: string }>;
}

export interface RepoEntry {
  path: string;                             // workspace 相对路径(E03 防逃逸)
  remote?: string;                          // clone-if-missing / 溯源
  owner?: string;                           // 被 >1 project 引用时必填(E05)
  landing?: "pr" | "direct"; autoMerge?: boolean; mergeChecks?: string[];
  build?: { typecheck?: string; build?: string };
  deploy?: { style?: string; environments?: Record<string, { auto?: boolean; deployPrPrefix?: string; command?: string }> };
  ops?: { checks?: string[] };
}

export interface ProjectEntry {
  enabled?: boolean;                        // 默认 true
  weight?: number;                          // 默认 1;0 = 调度暂停
  linearProject?: string; linearProjectId?: string | null;
  strategyDoc?: DocRef; testEnv?: { baseUrl?: string; authConstraint?: string };
  devSplit?: boolean;
  agents?: unknown; models?: unknown; efforts?: unknown;   // delivery launch 配置,形状不变
  reports?: unknown; mode?: string; autonomy?: string; docSystem?: string;  // 行为覆盖(§4.2)
  repos: Array<{ ref: string; role?: string }>;            // 引用边(E04)
}

export type DocRef = string | { linearDocument: string } | { hubDoc: string } | { path: string };
```

### 2.2 校验错误码(`validateTeamFile` 产出 `WsError { code, path, message }[]`)

| code | 条件 |
|---|---|
| E01 | `schemaVersion !== 2` |
| E02 | `team.key` 不匹配 `^[a-z0-9-]{2,32}$` 或 backend 非 linear/service |
| E03 | `repos.*.path` 缺失 / 绝对路径 / 归一化后含 `..` 逃出 workspace |
| E04 | `projects.*.repos[].ref` 指向未注册 repo |
| E05 | repo 被 >1 个 project 引用但无 `owner`;或 `owner` 不在引用者之列(**不看 enabled** —— 校验结果不得随开关翻转,I2 原文) |
| E06 | deployPolicy 上限违规:`deployPolicy[env]=manual` 而某 repo `deploy.environments[env].auto=true` |
| E07 | `comms.provider` 非 slack/lark;或 `webhookEnv` 不匹配 `^[A-Z][A-Z0-9_]*$`(值里出现 `://` 一律拒 —— I5 防呆,防止有人把 URL 写进配置) |
| E08 | `weight` 非有限数或 <0;`enabled` 非布尔 |
| E09 | backend=linear 而 `team.linearTeam` 缺失 |
| E10 | 两个 ref 归一化后指向同一 `path`;或两个 project 声明同一 `linearProjectId` |
| E11 | project key / repo ref 不匹配 `^[a-z0-9][a-z0-9._-]{0,31}$`,或撞保留名 `team`/`lessons`/`wt`/`locks`/`_team`/`hub.db`/`daemon.json`(它们与 `.dev-loop/` 目录、锁文件共享命名空间) |

Warning(doctor 报告、不 fail):W01 project 零 repos;W02 repo 未被任何 project 引用;
W03 lessons 超预算(§7);W04 上次 sync 过旧(M2 起,读 `linearProjectId` 旁的 `syncedAt`);
W05 backend=linear 时提示 **Linear MCP 须在 user scope 可用**(steward fire 的 cwd 是
workspace 根,repo 级 `.mcp.json` 覆盖不到它);W06 workspace 根位于某个 git work-tree 内
(`.dev-loop/` 状态与报告有被误提交的风险,I5 邻域)。

### 2.3 解析 API

```ts
export interface Workspace { root: string; file: TeamFile; filePath: string }

export function loadWorkspace(root: string): Workspace;          // 读 + validate,E-codes 抛 WsErrorList
export function effectiveProject(ws, key): ResolvedProject;      // 行为字段:project ∥ team(§4.2)
export function effectiveRepo(ws, ref): ResolvedRepo;            // 物理字段仅 registry;附 absPath = join(root, path)
export function reposOfProject(ws, key): Array<{ ref, role, absPath }>;
export function primaryRepo(ws, key): string | null;             // role=primary ∥ 首个 —— fire 的 cwd
export function referencingProjects(ws, ref): string[];
export function inferProjectForRepo(ws, ref):
  | { kind: "unique"; key: string }
  | { kind: "ambiguous"; candidates: string[] }                  // 调用方必须报错要求 --project
  | { kind: "none" };
export function ownerOf(ws, ref): string;                        // owner ∥ 唯一引用者(E05 保证可解;零引用(W02)→ throw)
```

### 2.4 兼容视图 `toLegacyView(ws): ProjectsConfig` —— M1 的去风险核心

M1 要求"运行时只读 v2"但**对 fire 行为零变化**。做法:所有既有消费者
(run-agents / daemon / server / shim / doctor / init-service)不改自己的读取形状,统一改从

```ts
export function toLegacyView(ws: Workspace): ProjectsConfig   // 旧 ProjectsConfig 形状
```

拿配置:`projects.<key> = { backend: team.backend, repoPath: abs(primary), repos: [{path: abs, role}],
devSplit, agents, models, efforts, defaultCodingAgent, codingAgentDefaults(project ∥ team),
strategyDoc, testEnv, reports(project ∥ team), … }`。路径全部绝对化。这样 M1 的 diff 面 =
"配置从哪来",而不是"配置长什么样";M3/M5 再把消费者逐个升级到富 API。回退 = revert 一个 loader。

---

## 3. `workspace.ts`:发现、路径、索引

### 3.1 发现(precedence)

```ts
export function resolveWorkspace(cwd = process.cwd()): Workspace
// 1. DEVLOOP_WORKSPACE(绝对路径;不存在/非法 → 硬错,不回落)
// 2. DEVLOOP_TEAM(key)→ ~/.dev-loop/workspaces.json 索引 → 路径(缺失 → 硬错,提示 cd 进 workspace 跑一次自愈)
// 3. cwd realpath 向上爬:首个含合法 dev-loop.json(schemaVersion:2)的目录;爬到 / 为止
// 找不到 → WsNotFound(各命令自带指引文案)
```

repo 定位沿用 DL-13 匹配器(realpath、段边界、最近祖先、tie→null),候选集换成
`Object.entries(ws.file.repos)`。project 定位:显式(`--project`/`DEVLOOP_PROJECT`)>
`inferProjectForRepo`(unique 才推断;ambiguous 报错列候选 —— proposal §3.2)。

### 3.2 状态路径 API(R1 形状)

```ts
wsStateRoot(ws)            // <root>/.dev-loop
wsProjectDir(ws, key)      // <root>/.dev-loop/<key>          ← 今天 ~/.dev-loop/<key> 的整体平移
wsTeamDir(ws)              // <root>/.dev-loop/team            ← steward 状态/报告
wsLessonsDir(ws)           // <root>/.dev-loop/lessons
wsWorktree(ws, ticket, ref)// <root>/.dev-loop/wt/<ticket>/<ref>
wsLockPath(ws, name)       // <root>/.dev-loop/locks/<name>.lock
wsHubDb(ws)                // <root>/.dev-loop/hub.db
wsDaemonRunfile(ws)        // <root>/.dev-loop/daemon.json
wsFireLedger(ws)           // <root>/.dev-loop/team/fires.jsonl(§5.4,backend 无关账本)
```

Worktree 路径分两步(评审修订):M1–M2 沿用整树平移后的 `.dev-loop/<project>/wt/<ticket>`
(conventions §7 现行文本经 `${DEVLOOP_DATA_DIR}` 换根即成立,零改动);**M3 随
with-repo-lock 一起迁到顶层 `wsWorktree`**(共享 repo 需要 ticket+ref 复合键),
conventions §7/§12c 同批更新。

`paths.ts` 改造:`devloopDataDir()` → workspace 命中时返回 `wsStateRoot`(`DEVLOOP_DATA_DIR`
显式覆盖仍最高优,测试用);`hubDbPath()` 同理(`DEVLOOP_HUB_DB` 仍最高优);
`projectConfigCandidates()` / `legacyClaudeDataDir()` **删除**(breaking,M1)。

### 3.3 索引自愈

`~/.dev-loop/workspaces.json = { "<team-key>": "<abs root>" }`。任何一次 `loadWorkspace`
成功后 best-effort upsert(tmp+rename 原子写,失败静默 —— 索引非权威);`team repair`
强制重登记。索引**不参与迁移**(I4)。

---

## 4. CLI 规格(M1)

### 4.1 `dev-loop team init`

```
dev-loop team init [--dir <path>] --key <k> --backend linear|service
  [--linear-team <Name>] [--deploy dev=auto,prod=manual] [--doc-system backend|local]
  [--comms lark|slack[:ENV_NAME]]        # 默认 ENV 名 DEVLOOP_COMMS_WEBHOOK
  [--reports files|linear|hub] [--mode live|dry-run] [--autonomy full|guarded]
  [--yes] [--force]
```

- TTY 且缺 flag → readline 面试;`--yes` = 未指明项取默认。**纯 CLI、零 LLM、零 backend
  调用**(§9.1);产出:`dev-loop.json` + `.dev-loop/{team,lessons,wt,locks}/` 脚手架 +
  (service)`openDb(wsHubDb)` 初始化 + seed `_team` project(prefix `TEAM`)。
- 已存在 `dev-loop.json` 且无 `--force` → exit 0 提示编辑(幂等);`--force` 覆盖前打印 diff。
- 收尾打印 next steps:在 coding CLI 里跑 `/dev-loop:add-project`。
- exit:0 成功/幂等;1 运行错误;2 用法错误(沿用 `die` 约定)。

### 4.2 `dev-loop team import`

```
dev-loop team import [--from ~/.dev-loop/projects.json] [--project <key>]...
  [--rename <old>=<new>]... [--hub-db <old-hub.db>] [--dry-run]
```

| v1 字段 | v2 落点 |
|---|---|
| `backend` / `linearTeam` / `notify` / `reports`(全局性) | `team.*`(notify → `team.comms`) |
| `repoPath` / `repos[]` + `landing/autoMerge/mergeChecks/build/deploy/ops` | `repos.<ref>`(registry;path 相对化) |
| `strategyDoc/testEnv/devSplit/agents/models/efforts/linearProject` | `projects.<key>.*` |
| `~/.dev-loop/<key>/…` 状态目录 | `mv` → `.dev-loop/<key>/…`(R1) |
| `~/.dev-loop/<key>/lessons.md` | → `.dev-loop/lessons/<key>.md`(分片;INDEX 留给 reflect 蒸馏) |
| 旧 hub.db 中该 project 的行 | `--hub-db`:ATTACH + 按 project_id 拷贝 projects/tickets/documents/actors/events |

- repo 在 workspace 外 → 写入 config 假定目标 `<ws>/<name>`,打印**准确的 `mv` 命令**,
  以 exit 1 收尾(操作者搬完 → `dev-loop doctor` 转绿)。不自动移动 repo。
- **hub 行拷贝的重键规则**(评审修订):`events.id` 是 AUTOINCREMENT —— 按原 id 排序
  **不带 id 重插**(次序保持、id 重派,`sqlite_sequence` 不搬);tickets/documents/actors/
  projects 是 TEXT id,原样拷贝(prefix 唯一性由 doctor 既有检查守护)。与 `_team` 播种的
  先后无关,皆无冲突(T1.4 断言)。
- **升级须知(写进 CHANGELOG,D1.10)**:装上 0.30 后运行时不再读 v1 —— 必须立即
  `team init` + `team import`,否则一切命令以 WsNotFound 指引收场。
- `--dry-run` 打印完整计划(逐文件/逐行动);默认执行。运行时**从不**读 v1(#11)。

### 4.3 `dev-loop doctor`(workspace 模式)+ `dev-loop team repair`

- doctor:workspace 命中时先跑 v2 检查(E-codes 全量、W01–W04、repo path 存在且是 git repo、
  worktree gitdir 指向有效、索引一致、hub.db(service)完整性沿用现检),再跑既有 DB 检查。
  **只读不修**(R2)。
- `team repair`:`git worktree repair` + prune(逐 registry repo)、索引重登记、
  (service)`PRAGMA wal_checkpoint(TRUNCATE)`。幂等;打印修了什么。

---

## 5. 调度器 team 化(M3,`run-agents.ts`)

### 5.1 Options 与解析变化

- 新增 `--team <key>`、`--plan <n>`(打印接下来 n 次 (agent,project) 选择后退出 —— 轮换的
  确定性测试钩子,不 spawn);`--project` 降级为**过滤器**(只跑该 project 的 delivery fire)。
- 启动:`resolveWorkspace` → `toLegacyView`;`opts.dataDir = wsStateRoot`;run 锁从
  `run-<project>.lock` 改为 **`wsLockPath(ws,"run")`**(一个 team 一个调度进程,#9)。
- `dev-loop.json` **mtime 热重载**:每 tick 比对 mtime,变了就重读(enabled/weight 生效
  无需重启;解析失败 → 保留旧配置 + console.error,绝不带病换挡)。

### 5.2 slot 模型

```
delivery slot(pm/qa/senior-dev/junior-dev/dev)  = 每 agent 一个 slot,cadence 不变;
  fire 时用 WRR 选 project(见 5.3),cwd = primaryRepo(project),env 注入该 project。
steward slot(sweep/ops/reflect/communication)   = 分两步走(评审修订,消除里程碑倒挂):
  M3(0.32):与 delivery 相同 —— 按 WRR 选 project fire,行为与今天逐字节一致
    (sweep/ops 的 SKILL 本就是 project 作用域,team 化必须与 SKILL 重写同批);
  M4(0.33):切 team 作用域 —— env DEVLOOP_TEAM_SCOPE=1、DEVLOOP_PROJECT="_team"
    (service)/ ""(linear)、cwd = ws root、prompt 附 enabled projects 清单;
    与 SKILL 重写(D4.4–D4.6)+ op-API steward 覆盖(D4.2)同版本交付。
  全 team disabled → skip。
```

### 5.3 加权轮换:平滑 WRR(nginx 算法,确定性)

```
状态(每 delivery agent 一份,持久化 .dev-loop/team/scheduler.json):cur[projectKey] = 0
pick(agent):
  enabled = projects.filter(p => p.enabled !== false && weight(p) > 0)
  for p of enabled: cur[p] += weight(p)
  best = argmax(cur)(平手 → key 字典序,保证确定性)
  cur[best] -= sum(weights);return best
```

weight 2:1 的两 project → 序列 `A A B A A B …`;`--plan 6` 必须精确打印它(T3.1)。
`--once` = 每个选中 agent 各 fire 一次(project 由 WRR 选出;要专扫某 project 用
`--project` 过滤器)。

- **实现载体 `rotation.ts`**:WRR + cursor 持久化(`.dev-loop/team/scheduler.json`,
  tmp+rename 原子写,写入持 `locks.ts` 锁)+ CLI **`dev-loop next-project --agent <a>`**。
  run-agents 与 **Agent View `/loop` 行共用同一 picker**:/loop 行模板先调 `next-project`
  拿本 fire 的 project 再进 SKILL —— 两种跑法一份轮换状态,不重不漏(没有它,/loop 行在
  team 模式下根本无从选 project —— 这正是 linear team 的主跑法)。
- **change-gate × WRR**:gate 在 pick **之后**评估;skip 同样推进 cursor,且同一 tick 内
  继续尝试下一候选(至多一整轮)—— 安静 project 不吞噬 fire 槽,活跃 project 不被邻居的
  静默拖慢。键 = `"<agent>:<project>"`(仍 service-only、fail-open)。
- **热重载时 cursor 修剪**:project 增删/权重变化 → 丢弃未知键、新键置 0,防陈旧 cursor
  扭曲 argmax。

### 5.4 fire 环境与 prompt

- env 追加:`DEVLOOP_WORKSPACE=<root>`、`DEVLOOP_TEAM=<key>`、`DEVLOOP_LESSONS_DIR`。
- `readPrompt` 替换变量追加 `${DEVLOOP_WORKSPACE}`、`${DEVLOOP_LESSONS_DIR}`;Scheduler
  context 增加 `team:`、steward fire 的 `enabled projects:` 行。
- MCP 注入规则不变(backend-gated,0.28.0);service 的 hub db = `wsHubDb`。
- **fires.jsonl 账本(backend 无关)**:每次 fire 结束 append 一行
  `{ts, agent, project, codingAgent, model, effort, durationMs, exitCode, timedOut}` 到
  `wsFireLedger`(service 仍写 hub `fire.completed` 事件)。现 `recordFire` 对非 hub
  project 静默跳过 —— 没有这行,GA soak 的成功率指标对 linear team **无数据源**。

---

## 6. `with-repo-lock`(M3)与锁的抽取

- **D3.3 先抽库**:把 `daemon-lifecycle.ts` 的 `lcAcquireLock`(O_EXCL + stale 判定 +
  break-mutex,DL-46/DL-51)提炼为 `locks.ts` 的 `acquireLock(path, {totalMs, staleMs})`;
  daemon-lifecycle 改为消费方(行为逐字节不变,由 lifecycle-race 既有测试守护)。
- `dev-loop with-repo-lock <ref> [--wait 60s] -- <cmd…>`:锁文件
  `wsLockPath(ws, "repo-<ref>")`,持锁 spawn cmd(stdio inherit),退出码透传。
- conventions §7/§12c 更新:base clone 的 `git fetch` / `worktree add` / `worktree prune`
  必须经它包裹;worktree 内的一切操作**不**需要锁(worktree 互不干扰)。

---

## 7. lessons 库(M4,`lessons.ts`)

文件格式(条目 = 单行 bullet,`[scope] date lesson (evidence)`):

```
# Team lessons — curated INDEX
<!-- writer: reflect ONLY · budget: ≤120 lines / ≤8 KB · overflow ⇒ demote to shard/archive -->
- [team] 2026-07-03 release-pr merge 前必须先 `git fetch`(evidence: devplatform DEV-123)
- [devplatform] … (仅跨项目/高频条目进 INDEX;project 专属住分片)
```

- 预算常量:`INDEX ≤ 120 行 / 8 KB;分片 ≤ 200 行 / 16 KB`(`lessons.ts` 导出,doctor 引用)。
- `lessons.ts`:`lessonsPaths(ws)`、`checkBudgets(ws): Warning[]`(W03)。**不做写 API** ——
  写入流是 reflect agent 的 SKILL 行为(判定 scope → 写 INDEX/分片;触顶下沉 archive;
  `docs.lessons.mirror=true` 时把 INDEX 经 backend MCP 发布为文档)。
- 装载:delivery SKILL boot 读 `INDEX.md` + `<project>.md`;steward 只读 INDEX(§5.1 提案)。

---

## 8. comms 适配器 + `dev-loop notify`(M4,`comms.ts`)

```
dev-loop notify [--title <T>] [--level info|warn|error] <text…>
```

- 读 `team.comms`;`process.env[webhookEnv]` 取 URL;未设 → exit 3
  `comms env DEVLOOP_COMMS_WEBHOOK is not set`(agent 视作可 park 的环境问题)。
- payload(v1 纯文本级,卡片升级留后):
  slack `{ "text": "*[level] T*\n<text>" }`;lark `{ "msg_type": "text", "content": { "text": "[level] T\n<text>" } }`。
- 5s 超时;非 2xx → exit 1 + 响应体前 200 字。**`DEVLOOP_COMMS_DRYRUN=1`** → 不发网络,
  打印 `{provider, env: <名字>, payload}` 后 exit 0(镜像 channel 测试的 DRYRUN 约定;
  URL 值永不打印 —— I5)。
- 消费方:communication agent(日报/周报推送)、pm/ops SKILL 的 escalation
  (needs-human/park → `notify --level warn`)。与 reports sink 正交(§6.1 提案)。

---

## 9. hub-in-workspace(M5)

- `daemon-lifecycle.ts`:db = `wsHubDb(ws)`;runfile 从 `daemon-<key>.json` 改为
  **`wsDaemonRunfile(ws)`(一 team 一个)**;冷启动锁 → `wsLockPath(ws,"daemon")`;
  health body `{ok, team, version}`。
- 路由 `hub`:`start`(= 现 `daemon up` 语义,幂等)/ `stop`(down;进程退出后
  `openDb → PRAGMA wal_checkpoint(TRUNCATE) → close`)/ `status`(runfile + health 探针 +
  db/wal 尺寸)。旧 `daemon` 路由保留为 `hub` 的别名一版,0.34 移除。
- `run` 自动 ensure:backend=service 且非 dry-run → 循环前先走 `hub start` 的 ensure 路径。
- **op-API steward 覆盖**:hub 工具新增可选 `project` 参数,仅当
  `DEVLOOP_ACTOR ∈ {ops, reflect, communication, sweep}` 时生效(否则 E_FORBIDDEN)——
  steward 以 `_team` 身份连接、按需对具体 project 建票/读板(ops 的 owner 路由落地机制)。
  **评审修订:此项提前到 M4(D4.2)** —— 它是 steward team 化的硬依赖,不能晚一个版本;
  本节其余(lifecycle/webui)仍在 M5。
- `daemonviews.ts`:`/` 变 team 总览(project 卡片 + intake 谱系),`/p/<key>` 项目板。

---

## 10. Skill 规格(M2;全部幂等,coding CLI 运行)

| skill | 步骤(编号即执行序) | 幂等键 / 失败面 |
|---|---|---|
| **add-project** | 1 resolveWorkspace + 读 config;2 面试 key/linearProject/testEnv/devSplit/agents;3 **backend 同步**:linear → find-or-create project、落 `linearProjectId`(+首轮 team 对账:验 team、ensure label 集、落 `linearTeamId`);service → `dev-loop seed <key> …`;4 strategyDoc 脚手架(§20 headings,按 docSystem);5 写 `projects.<key>`(repos 空);6 `dev-loop doctor` | 幂等键 = `linearProjectId` 已存在 ⇒ 跳建改核;Linear 无权限/重名 → 列候选让操作者选;绝不建重复 project |
| **add-repo** | 1 定位 project(参数/推断);2 clone `<ws>/<name>`(已有目录 → 登记);3 侦测 build(package.json scripts / tsconfig)+ 从 `.github/workflows` PR 触发的 job names 派生 `mergeChecks`(0.28.0 P2-10 规程);4 部署面试(release-pr/command;**E06 上限现场校验**);5 写 `repos.<ref>` + project 引用 `{ref, role}`;共享(引用数>1)⇒ 要求 `owner`;6 label `repo:<name>`(该 project 第 2 个 repo 起);7 mini-MAP + 对抗校验(P2-11)追加 strategyDoc Current state;8 `dev-loop doctor` | 幂等键 = registry 已有同 path ⇒ 转 sync-repo 语义;clone 失败/检测不出 build → 面试兜底,不猜 |
| **sync-project** | 1 读 config + backend project 实况;2 diff(改名/归档/label 缺失/strategyDoc 漂移);3 呈现 → 确认 → 写回(config 或 backend,方向逐项确认);4 落 `syncedAt` | 只读默认,写需确认;归档的 backend project → 建议 `enabled:false` |
| **sync-repo** | 1 重侦测 build/mergeChecks/deploy 与 remote 漂移 → diff → 确认写回;2 clone-if-missing(按 `remote`);3 `dev-loop team repair`(worktree) | 检测结果与人工配置冲突 → 呈现差异,不静默覆盖 |
| **init(legacy)** | 退役为指路壳:打印 team init / add-project / add-repo 三步指引后结束 | — |

**delivery/steward SKILL 改造点**(M4/M5):lessons 新路径(§7)、PM boot 装载
`docs.vision`、ops team 化(registry 去重巡检 + `ownerOf` 路由 + op-API project 参数)、
reflect 写入流、sweep 逐 project 循环 + team intake 收口(M5)、communication 走 `notify`。

---

## 11. 文档任务(随里程碑发布,不单列版本)

conventions:**§25 Team 模型**(新)、§19 重写(registry/三级解析/共享 repo)、§7+§12c
(worktree 路径 `.dev-loop/wt/<ticket>/<ref>` + with-repo-lock)、§9a→§9b(team intake,M5)、
§22(报告路径 R1 形状)、§16(comms env 名规则)。config-schema.md:v2 全量重写 +
E-code 附录。README:workspace quickstart。CHANGELOG:逐里程碑。

---

## 12. 开发任务清单

### M1 — 配置内核(0.30.0)

| ID | 任务 | 主要文件 | 规模 | 依赖 |
|---|---|---|---|---|
| D1.1 | schema v2 类型 + 解析/校验(E01–E10)+ effective*/infer/owner API | team-config.ts | L | — |
| D1.2 | workspace 发现(env>索引>爬升)+ 路径 API + 索引自愈 | workspace.ts | M | D1.1 |
| D1.3 | paths.ts workspace 感知;删 v1 候选链(breaking) | paths.ts | S | D1.2 |
| D1.4 | 兼容视图 toLegacyView + resolve-project 接 registry + inferProject | team-config.ts, resolve-project.ts | M | D1.1 |
| D1.5 | 消费者切换(run-agents/daemon/server/shim/doctor/init-service 读 toLegacyView;fire 行为零变化) | 各消费者 | M | D1.4 |
| D1.6 | `team init`(面试 + flags + service hub.db/_team 播种) | team-init.ts, cli.ts | M | D1.2 |
| D1.7 | `team import`(映射表 + 状态 mv + lessons 分片 + hub 行拷贝 + --dry-run) | team-import.ts | L | D1.6 |
| D1.8 | doctor workspace 检查(只读)+ `team repair` | doctor.ts, team-repair.ts | M | D1.2 |
| D1.9 | cli.ts 路由/usage;NEEDS_NODE_SQLITE 更新 | cli.ts | S | D1.6 |
| D1.10 | conventions §25/§19 + config-schema v2 + CHANGELOG | references/* | M | D1.1 |

### M2 — 操作技能(0.31.0)

| ID | 任务 | 规模 | 依赖 |
|---|---|---|---|
| D2.1 | add-project SKILL(§10 规格,含首轮 team 对账) | M | M1 |
| D2.2 | add-repo SKILL(侦测/面试/E06 现场校验/owner/label/mini-MAP) | L | M1 |
| D2.3 | sync-project + sync-repo SKILL | M | D2.1/D2.2 |
| D2.4 | legacy init 退役为指路壳 | S | D2.1 |
| D2.5 | export-desktop-skill `--team` | S | M1 |
| D2.6 | **devplatform 实迁**(init→import→sync-project 补 ID)+ 迁移 runbook | M | D2.1–D2.3 |

### M3 — team 调度(0.32.0)

| ID | 任务 | 规模 | 依赖 |
|---|---|---|---|
| D3.1 | rotation.ts(平滑 WRR + cursor 持久化/原子写/热重载修剪)+ run-agents team 模式(enabled/weight + team 锁 + `--plan`/`--once` 语义 + `--project` 过滤器化 + gate 键与 skip-advance) | L | M1 |
| D3.2 | `dev-loop next-project` CLI + Agent View `/loop` 行模板接入(与 run 共用轮换状态) | S | D3.1 |
| D3.3 | fires.jsonl 账本(backend 无关 fire 结果,GA 指标数据源) | S | D3.1 |
| D3.4 | locks.ts 抽取(daemon-lifecycle 复用)+ `with-repo-lock` + conventions §7/§12c(worktree 顶层化) | M | M1 |
| D3.5 | Agent View / RUNNING 文档更新(行数=agent 种类;`next-project` 行模板) | S | D3.2 |

> 注:本版 steward 仍 per-project fire(与今天一致);team 作用域化整体在 M4(D4.1)。

### M4 — stewardship + 文档库(0.33.0)

| ID | 任务 | 规模 | 依赖 |
|---|---|---|---|
| D4.1 | steward slot team 作用域化(TEAM_SCOPE env、cwd=root、`_team`/""、enabled 清单入 prompt)—— 自 M3 挪入,与 SKILL 同批 | M | M3 |
| D4.2 | op-API steward project 覆盖 + `_team` 语义(agentops/tooldefs)—— 自 M5 提前,D4.5 的硬依赖 | M | M1 |
| D4.3 | lessons.ts(路径+预算)+ doctor W03 | S | M1 |
| D4.4 | reflect SKILL 重写(写入流/下沉/mirror) | M | D4.1/D4.3 |
| D4.5 | ops SKILL team 化(registry 去重巡检 + ownerOf 路由,两 backend 同版齐活) | M | D4.1/D4.2 |
| D4.6 | sweep SKILL 逐 project 循环化 | S | D4.1 |
| D4.7 | comms.ts + `notify` + communication SKILL + escalation 接线(pm/ops) | M | M1 |
| D4.8 | delivery SKILL:lessons 新路径 + PM 装载 vision | S | D4.3 |

### M5 — service team 化 + intake(0.34.0)

| ID | 任务 | 规模 | 依赖 |
|---|---|---|---|
| D5.1 | daemon-lifecycle workspace 化 + `hub start/stop/status`(stop=checkpoint;autostart plist 迁移) | M | M1 |
| D5.2 | `run` 对 service 自动 ensure hub | S | D5.1 |
| D5.3 | web UI team 总览 + `/p/<key>` | M | D5.1 |
| D5.4 | team intake:pm 拆分 job + sweep 收口 job + conventions §9b | M | D4.6 |
| D5.5 | **backoffice 实迁**(hub 行拷贝含 events 重键全程验证) | M | D5.1–D5.3 |

### GA — 1.0.0(无新功能)

| ID | 任务 | 规模 |
|---|---|---|
| D6.1 | conventions/config-schema/README 全量对齐终审 + CHANGELOG 1.0 | M |
| D6.2 | release-version 1.0.0 + 插件 marketplace 发布 | S |

---

## 13. 测试任务清单

测试跟既有风格:独立脚本 + `ok()` 断言 + tmpdir fixture + `DEVLOOP_*` env 隔离
(`DEVLOOP_HOME` 隔离索引),逐个追加进 `npm test` 链与 scripts 别名。**每个 D 任务的
完成判据 = 对应 T 任务绿 + 全量 `npm test` 绿。**

### M1

| ID | 文件 | 覆盖 | 规模 |
|---|---|---|---|
| T1.1 | test/team-config.ts | E01–E11 逐码矩阵(含 `..` 逃逸、`://` 进 webhookEnv、E06 各 env、E05 owner 缺失/错列且**不随 enabled 翻转**、E11 保留名撞车);effectiveProject 覆盖顺序;inferProject unique/ambiguous/none;ownerOf(含零引用 throw);toLegacyView 字段逐一对拍(路径绝对化) | L |
| T1.2 | test/workspace.ts | 爬升(repo 深层目录→root)、symlink realpath、非 workspace → null、DEVLOOP_WORKSPACE/TEAM precedence、索引自愈写入(DEVLOOP_HOME=tmp)、损坏索引不致命 | M |
| T1.3 | test/team-init.ts | 非交互 flags → 文件树断言;重跑幂等;--force diff;service → hub.db 建 + `_team` 播种(openDb 只读验证);exit codes | M |
| T1.4 | test/team-import.ts | v1 双 project fixture(linear+service):--dry-run 计划文本;实跑 → dev-loop.json 逐字段映射断言、状态目录 mv、lessons→分片、repo 外置 → mv 指引+exit 1、--hub-db 行拷贝(计数对拍 + **events 重键无冲突、次序保持**) | L |
| T1.5 | test/doctor-workspace.ts | E-code 呈现;doctor 前后 workspace 文件 mtime/内容不变(只读契约);team repair 修坏 gitdir 的 worktree + WAL truncate + 索引重登记 | M |
| T1.6 | test/run-agents.ts **改造** | fixture 换 workspace 形态;既有 30+ 断言全绿(兼容视图证明);新增:workspace 内 cwd 推断、共享 repo cwd → ambiguous 报错文案 | M |
| T1.7 | npm test 链 + version-sync/build-artifact/consistency 适配 | 打包含新入口;dist chmod 断言沿用 | S |

### M2

| ID | 覆盖 | 规模 |
|---|---|---|
| T2.1 | export-desktop-skill --team 渲染(team 上下文段存在;无 --team 行为不变) | S |
| T2.2 | test/docs.ts 扩展:4 个新 SKILL frontmatter/路径引用/变量占位符齐全;conventions §25/§19 锚点存在 | S |
| T2.3 | 验收(人工,runbook 化):devplatform 实迁 + `add-repo` 真实加 mcp-bff 一遍过;记录进 PR | M |

### M3

| ID | 覆盖 | 规模 |
|---|---|---|
| T3.1 | `--plan`:weight 2:1 → 精确序列 `A A B A A B`;平手字典序;cursor 持久化(两次进程间续位);`next-project` 与 run 交替调用共享同一 cursor(不重不漏) | M |
| T3.2 | enabled:false / weight:0(delivery 停、steward 照常)→ 轮换排除;全 disabled → skip + 提示;热重载(mtime 变 → plan 变;坏 JSON → 保旧配置 + 报错;cursor 修剪) | M |
| T3.3 | gate 键 per (agent,project);A 静默 → **同 tick 轮到 B(skip-advance)**;A 变更不解 B 的门 | S |
| T3.4 | team run 锁:第二个 run 拒绝;stale 接管;fires.jsonl 行形状(两 backend 皆写) | S |
| T3.5 | with-repo-lock:并发两持有者串行(时间戳重叠断言);stale break;退出码透传;locks.ts 抽取后 lifecycle/lifecycle-race 既有测试不动全绿 | M |

### M4

| ID | 覆盖 | 规模 |
|---|---|---|
| T4.1 | steward slot env/cwd 断言(dry-run):TEAM_SCOPE、`_team` vs ""、cwd=ws 根、enabled 清单入 prompt | S |
| T4.2 | op-API project 覆盖:steward+project 参数生效;delivery actor 传 project → E_FORBIDDEN;`_team` 默认作用域 | M |
| T4.3 | test/notify.ts:DRYRUN 两 provider payload 形状;--title/--level;env 缺失 exit 3;非 2xx exit 1(本地 http 假服);URL 值不出现在任何输出 | M |
| T4.4 | test/lessons.ts:预算检查(超行/超字节→W03;边界值);路径 API | S |
| T4.5 | docs.ts 扩展:reflect/ops/sweep/communication SKILL 的新锚点与路径 | S |
| T4.6 | 验收(人工):lark 真实推送一条;reflect 干跑一轮产出 INDEX;ops 一轮去重巡检 + owner 路由建票 | S |

### M5

| ID | 覆盖 | 规模 |
|---|---|---|
| T5.1 | test/hub-lifecycle.ts:start 幂等(双起单实例)/status 字段/stop 后 wal 尺寸=0 且 runfile 清除;冷启动锁复用断言 | M |
| T5.2 | run 自动 ensure(dry-run 打印 ensure 行;linear 不 ensure) | S |
| T5.3 | webui team 总览 smoke(项目卡片数 = enabled 数) | S |
| T5.4 | intake e2e(hub fixture):team intake → PM 拆分幂等(反链去重)→ 子票 Done → sweep 收口 parent Done;单票 park → parent 留 In Review | M |

### GA

| ID | 覆盖 |
|---|---|
| T6.1 | 第二台机器迁移演练:§10.3 清单逐步执行 + `doctor` 全绿 + 一次真实 fire(记录 runbook) |
| T6.2 | 稳定性 soak 判据:两 team 连续 7 天,fire 成功率 ≥95%,零 P0 escalation,lessons/INDEX 未超预算 |

---

## 14. 验收映射(proposal §11 ↔ 本稿)

| 里程碑 | 发布判据 |
|---|---|
| M1/0.30.0 | T1.1–T1.7 全绿;`npm test` 全绿;两 team import --dry-run 计划人工核对通过 |
| M2/0.31.0 | T2.1–T2.2 绿;T2.3 runbook 完成(devplatform 在新 workspace 上真实跑通一轮 loop) |
| M3/0.32.0 | T3.1–T3.5 绿;双 project 轮换烟测(--plan + 一次 live --once;Agent View 行模板走 next-project) |
| M4/0.33.0 | T4.1–T4.5 绿;T4.6 lark 实推 + reflect/ops 实跑 |
| M5/0.34.0 | T5.1–T5.4 绿;backoffice 实迁后 web 总览可用、一张跨 project intake 端到端 |
| GA/1.0.0 | T6.1 演练通过 + T6.2 soak 达标;文档终审(D6.1)合入 |
