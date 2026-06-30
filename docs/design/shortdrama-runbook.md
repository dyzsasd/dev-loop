# 短剧 dev-loop 运行手册（Runbook）

如何用 dev-loop 立项并跑通一部竖屏短剧。配套设计见 [`shortdrama-devloop.md`](./shortdrama-devloop.md)。

## 角色映射（短剧 → dev-loop）

| 短剧角色 | dev-loop 身份 | 形态 |
|---|---|---|
| 主笔 / 设计 | `story-architect-agent`（= `senior-dev` 层） | 新 SKILL |
| 编剧 / 写集 | `screenwriter-agent`（= `junior-dev` 层） | 新 SKILL |
| 剧本医生 | story-architect 的 `Mode: direct-code` | 同一 SKILL 的升级模式 |
| 监制 / 主创（品味裁判） | **人** = `pm` owner 队列 + `operator`（发布 bible） | 人 |
| 编辑（机检+抽取，可选） | `screenplay-editor-agent`（= `qa` 层改皮） | 新 SKILL（Tier-1） |
| 机械门 | `tools/dramalint.mjs` | 脚本，非 agent |
| 复盘 / 课程 | `reflect-agent` 原样 | 复用（Tier-1 起用） |
| 卫生 | `sweep-agent` 原样 | 复用 |

> **零新 actor**：三个新 SKILL 复用现成的 `senior-dev`/`junior-dev`/`qa` 层身份做路由（craft 体不同，身份不变）。

## 怎么跑：手动 vs 调度器

- **手动（Tier-0，零配置）**：直接调 `/story-architect-agent`、`/screenwriter-agent`、`/screenplay-editor-agent`，或用 `/loop` 定时手动跑。
- **调度器（`dev-loop run`）**：在 project 配置加一行 `"agentFamily": "screenwriting"`（见 example）。它把 `senior-dev/junior-dev/qa` 三个**身份**的 SKILL 体重映射到 `story-architect/screenwriter/screenplay-editor`——**actor 身份不变**（`DEVLOOP_ACTOR`、`assignee:senior-dev` 派单、§21a split 检测全不动）。然后 `dev-loop run --agents senior-dev,junior-dev,qa --dev-split`。首次需 `cd hub && npm run build` 把新 SKILL 物化进 scheduler 的 skills 根（`hub/skills` 是 gitignored 构建产物，不进仓）。

## 标签与 reflect 的 seed（一次性）

- **标签免播种**：`note:structure/voice/pacing`、`must-fix`、`preference`、`opening:protected`、`needs-showrunner` 都是自由字符串，local/service 两端**首次写入 ticket 即生效**，不要加进 `hub/src/seed.ts` 全局 LABELS（会污染所有项目）。
- **reflect seed**：在 `~/.dev-loop/<key>/lessons.md` 预建空标题 `## screenwriter` / `## story-architect` / `## screenplay-editor`，并在 `## Reflect` 下放一条「把 `note:*` 复发结晶导向这两个写作小节、别写进 `## PM`」的重定向规则（模板 `templates/screenwriting/lessons.md` 已含）。原因：reflect 的 lessons 落点是写死的代码角色枚举，不认识编剧小节；这条规则是不改 governing SKILL 的唯一合法纠偏通道。若该规则因 note 静默 >2 周被 §14 expire 阀裁掉，重新 seed 即可（空标题不受影响）。

## 一次性：立一部剧

1. **建剧目目录**（series dir），从模板拷贝骨架：
   ```
   cp -r templates/screenwriting /abs/path/to/series-<slug>
   cd /abs/path/to/series-<slug> && mv episode-TEMPLATE.md episodes/ 2>/dev/null; mkdir -p episodes
   git init   # episodes/ 走 git = "代码轴"
   ```
2. **填 `bible.md`**：把每个 `<…>` 占位填实（立项书 / Vision / 爽点配方 / 钩子模板 / `gate-config` 阈值）。这是人的活（主创的北极星）。
3. **种子人物**：在 `characters.csv` 填主角行（含 `voice_signature` 声纹金句、`secret_setup` 契诃夫枪）。
4. **建看板**（board）：
   - `local` 后端（Tier-0 推荐）：在 `projects.json` 配 `backend:"local"` + `ticketPrefix` 即可，board 自动建在 `~/.dev-loop/<key>/board/`。
   - `service` 后端：`dev-loop init-service <key> "<剧名>" SD`（建 project + 标签 + actors + hub）。
5. **配 `projects.json`**：照抄 [`config/projects.screenwriting.example.json`](../../config/projects.screenwriting.example.json)，改 `repoPath`（=series dir）、`strategyDoc:"bible.md"`、`testCommand`（dramalint 的绝对路径）。先留 `mode:"dry-run"` 验证，再翻 `"live"`。

## 每日循环

```
              ┌─────────────────────── 人（监制） ───────────────────────┐
立 season-design 票 → /story-architect-agent → 设计门(人验) → /screenwriter-agent → 品味门(人验) → Done
 (senior-dev 层)      beat-sheet+grid+派子票     促子票 Backlog→Todo   写集+dramalint     note 或 Done
```

1. **发布 bible**：`service` 用 `doc.publish`；`local`/repo 用 commit。**未发布前 story-architect 会 BLOCK**（不臆造世界观）。
2. **开一个 arc 设计**：建一张 `kind:season-design` 票，`assignee:senior-dev`（或 `senior-dev` 标签），`Todo`。
3. **跑主笔**：`/story-architect-agent` → 它读 bible，写 `docs/design/beats-<arc>.md`（或 hub design 文档），填 `grid.csv` 该 arc 的行，派每集子票（`junior-dev`、`Backlog` staged、带 `Design:` 指针 + grid 契约 ACs），把设计父票移 `In Review`。
4. **设计门（人）**：监制读 beat-sheet+grid（可跑 `node tools/dramalint.mjs <series>` 看 orphan/密度 warn 辅助），通过 → 把父票 `Done` + 把子票 `Backlog→Todo`；不通过 → `Canceled` + 重开设计票。
5. **跑编剧**：`/screenwriter-agent` → 取 `junior-dev` 的 `Todo` 子票，**先读 Design 指针**，写 `episodes/epNNNN.md`，跑 **dramalint 硬门**（红则修，≤2 次重试后 block），craft 自检，commit，移 `In Review`（owner `pm` = 监制队列）。
6. **品味门（人）**：监制读草稿。行 → `Done`（锁 canon）；不行 → 落 typed `note:*` 工单 + `Canceled` 该集（`review failed: …; superseded by <id>`）+ 重开重写票；结构性问题 → 升级 `Mode: direct-code` 给 story-architect（剧本医生）。
7. **前 6 集**：打 `opening:protected`，走 story-architect 直写（≥3 版 A/B + opening rubric），不走普通编剧通道。

## dramalint（机械门）

```
node tools/dramalint.mjs <series-dir>     # 4 项硬门 + flag-only warn；exit 1 = 有硬门失败
node tools/dramalint.mjs --self-check      # 自检（CI 可挂）
```
硬门：`hook-present`（集末有 `【钩子】` + `hook_out` 非空）/ `length-bounds` / `name∈表` / `卡点有钩`。
flag-only：爽点密度 / 双供给两轴 / 伏笔-爽点 orphan / 钩子未落末拍。**flag 不阻断、绝不当"这集好"信号**。

## Tier-0 → Tier-1

- **Tier-0（先证一弧成环）**：`devSplit:true`，跑 story-architect + screenwriter + dramalint + 人。第一弧 ≤17 集。reflect/sweep/editor 先不启。
- **Tier-1**：攒够已关闭 `note:*` 工单后**启 reflect**（自动结晶 `## screenwriter` 课程，无人 ack；需先 seed，见上）；票搁浅启 `sweep`；责编逐集抽 note 太累时**起用 `screenplay-editor-agent`**（已建——机检重跑 + advisory 抽取，绝不下裁决）。

## 诚实边界

这是**地板机器**（防烂尾/缺钩/连戏崩/双供给断档），不是爆款机器。爆款灵气靠人写前 6 集 + 一次性手艺。唯一客观裁判是市场（完播/付费），上线后回灌 `platform-performance` note，凌驾责编口味。
