# 从零开始：用 Codex 跑短剧创作 dev-loop

一步步：**从源码装 dev-loop → 用 Codex 作为 agent → 用 dev-loop 自己的调度器（`dev-loop run`）控制 loop → 创作一部短剧**。

> 关键认知：你要的「用 Codex 作为 AI agent」+「dev-loop 自己的 loop 控制」= **Mode B 调度器 + `--cli codex`**。
> （`codex-integration.md` 里那个 `codex:{}` 配置块是另一回事——让 Claude agent 调用 Codex 做 review/出图，不是本文要的。）
> 另一个关键认知：短剧 loop **不是无人值守**——producing agent（主笔/编剧/编辑）在 Codex 上自动跑，但**人类监制必须在设计门和品味门上拍板**（品味裁判按设计就是人）。

---

## 0. 前置（一次性）

```bash
# Node ≥ 23.6（dev-loop 的 engines 要求）。建议用 nvm：
nvm install 23 && nvm use 23
node --version            # v23.6+   （低于此版本可能跑不起 CLI）

# Codex CLI，安装并登录：
npm install -g @openai/codex
codex login               # ChatGPT 登录 或 API key
codex --version           # 确认在 PATH 上
```

> Codex 用量计入你的 ChatGPT/Codex 额度。

---

## 1. 从源码安装 dev-loop

```bash
git clone git@github.com:dyzsasd/dev-loop.git
cd dev-loop && export DL=$(pwd)
git checkout feat/shortdrama-devloop      # 短剧变体所在分支（合并到 main 后用 main）

# 若装过旧的全局版，先卸掉，免得它盖住源码版（你之前的报错就有它的影子）：
npm rm -g @dyzsasd/dev-loop 2>/dev/null

cd hub
npm install
npm run build                 # 编译 dist（现在会 chmod +x bin —— 修过了，不会再 permission denied）
npm link                      # 把全局 `dev-loop` / `dev-loop-hub` 指向这份源码

# 验证用的就是这份源码（不是旧全局）：
which dev-loop                # → 你的 npm 全局 bin，符号链接进 $DL/hub/dist/cli.js
dev-loop --version
dev-loop doctor               # 健康检查，应打印 DOCTOR_OK
```

> `$DL` = checkout 的绝对路径（上面已 `export`）。下面所有命令直接用全局 `dev-loop`。
> 之前 `permission denied`：你的 checkout 在我修 build 之前 clone 的——`git pull` 拉到 chmod 修复后，`npm run build && npm link` 即正常。
> 短剧的三个 agent SKILL 在 `$DL/skills/{story-architect,screenwriter,screenplay-editor}-agent/`。
> 跑调度器时加 `--root $DL`，它就直接读这份**活的源码** skills（改了 SKILL 不必重 build）。

---

## 2. 更新（拉最新）

```bash
cd $DL && git pull
cd hub && npm install && npm run build       # 重建 dist + 重新物化 skills 镜像
# npm link 是符号链接，指向 dist，build 后自动生效，无需重 link。
```

- 用 `--root $DL` 跑时，**SKILL 改动 `git pull` 即生效**（调度器读源码 skills），只有 hub CLI/代码变了才必须 `npm run build`。

---

## 2.5 选你的 AI：要不要装 plugin？（关键澄清）

**真正跑 loop 用的是调度器 `dev-loop run`——Codex 和 Claude 都一样、都不需要装 plugin**（调度器自己把 SKILL 当 prompt 注入、hub MCP 用内联配置注入）。插件**只**是 Claude Code 的交互式额外选项。

| | **Codex** | **Claude Code** |
|---|---|---|
| 装 plugin？ | **不需要**（Codex 没有 dev-loop 插件；它被调度器驱动） | **可选**——只为交互式 `/dev-loop:*`；跑调度器同样不需要 |
| 装什么 | `npm i -g @openai/codex && codex login` | Claude Code 本体；插件按需（见下，**必须源码版**） |
| init 一部剧 | `node $DL/tools/init-screenplay.mjs …`（终端，与 AI 无关） | 同左（终端）；通用软件 init 才用 `/dev-loop:init` |
| 跑 loop | `dev-loop run --cli codex …` | `dev-loop run --cli claude …`（同一套），或交互 `/dev-loop:*` + `/loop` |
| `agentFamily` | 调度器需要（actor→编剧 SKILL 重映射） | 调度器需要；交互直接点名 `/dev-loop:story-architect-agent` 则不经 family |

### Codex —— 不需要 dev-loop 插件（但支持 Agent Skills）
```bash
npm i -g @openai/codex && codex login && codex --version
# 跑 loop 用调度器（§5，dev-loop run --cli codex），不需要任何插件/skill。
```

**可选：把短剧 skill 装进 Codex（交互式调用，尤其 `$init-screenplay`）。** Codex 0.142+ 支持 Agent Skills（`~/.codex/skills/<name>/SKILL.md`，用 `$name` 调用，`/skills` 浏览）。我们的 SKILL 格式与之一致，一条命令装好（把 `${CLAUDE_PLUGIN_ROOT}` 路径 token 换成你的 checkout，skill 才能解析到脚本）：
```bash
export DL=/Users/shuai/workspace/dev-loop
for s in init-screenplay story-architect-agent screenwriter-agent screenplay-editor-agent; do
  mkdir -p ~/.codex/skills/"$s"
  sed "s#\${CLAUDE_PLUGIN_ROOT}#$DL#g" "$DL/skills/$s/SKILL.md" > ~/.codex/skills/"$s"/SKILL.md
done
# 重启 codex → 会话里 $init-screenplay（访谈式 init），或 /skills 浏览。
```
> 这是**拷贝**（路径已 bake 进去）——`git pull` 更新 skill 后重跑这段刷新。写文件时交互式 Codex 会问你批准，approve 即可。
> 跑 loop 仍建议用调度器（actor 身份更干净）；这些 skill 主要是给交互式 init/临时调用用的。

### Claude Code —— 装**源码版**插件（仅交互式需要）
released 的 npm 插件**没有**短剧三个 agent（它们在本分支、未合并），所以要从**源码 checkout** 装：
```bash
# 最简：直接用源码目录起 Claude Code（插件即时生效）
claude --plugin-dir $DL
#   装好后 /dev-loop: 下出现 story-architect-agent / screenwriter-agent / screenplay-editor-agent + 通用 /dev-loop:init
#   （持久化：在 ~/.claude/settings.json 配一个 source:"local" 指向 $DL 的 marketplace → /plugin install dev-loop@local）
```
> 不要用 `dev-loop install-claude-plugin`——它登记的是 **npm released** 版（无短剧 agent）。源码版必须走 `--plugin-dir $DL` 或 `source:"local"`。
> `git pull` 更新源码后，`--plugin-dir` 方式重启 Claude Code 即生效；marketplace 方式用 `/plugin update`。

---

## 3. init 一部剧

像 coding loop 的 `/dev-loop:init` 一样，init **不只是搭目录**——它先**跟你聊一轮**，把你对这部剧的要求问清楚（题材/平台/受众/集数/付费卡点/主角人设/爽点偏好/基调/禁区），把答案写进 **bible（北极星）**，再搭好工程骨架 + 配置 + 看板，最后**停下来等你启动 loop**。两层：

### 3a. 交互式 init（推荐）—— `/dev-loop:init-screenplay`

一个**操作者在场的访谈技能**。它会：① 引导式问你 11 项立项需求（带样例剧的智能建议）；② 把答案填进 `bible.md`（立项书 / Vision / 爽点配方 / `gate-config` 阈值）+ seed `characters.csv` 主角行（声纹 / 契诃夫枪）；③ 在底层跑 §3b 的脚本搭骨架 + 写 `projects.json` + seed `lessons.md`；④ （service）起看板；⑤ 打印就绪清单 + **启动命令**——但**不替你启动**。绝不设计 arc/grid、不写 episode、不开 loop。幂等：已填的 bible 不覆盖。

> **在哪跑这个交互 init？** 它是一次性、人在场的步骤。
> - **Claude Code**（装了源码插件，§2.5）：直接 `/dev-loop:init-screenplay`。
> - **纯 Codex 用户**：Codex 不加载插件，所以这一步在 Claude Code 里做，**或**直接让任意对话助手按 `skills/init-screenplay/SKILL.md` 的访谈问你、帮你填好 bible。产出（填好的 bible + 配好的项目）才是关键;之后 Codex 调度器跑 loop。

### 3b. 机械脚本（交互 init 在底层调用它；也可单独用）

不想聊、想直接搭骨架自己手填 bible？直接跑脚本：
```bash
node $DL/tools/init-screenplay.mjs myshow "My Show" SD ~/series-myshow --backend service
#                                   key   显示名      前缀 series目录             local(默认)|service
```
它生成 `~/series-myshow/`（bible/characters/grid/episodes 骨架）、写 `~/.dev-loop/projects.json`（`agentFamily:"screenwriting"`、绝对 `repoPath`、`mode:"dry-run"`、**不写 models→Codex 用 gpt-5.5**）、seed `lessons.md`，并打印下一步。**只搭不填**——bible 的创意内容由你（或交互 init）填。

### 收尾（两种方式都一样）
```bash
cd ~/series-myshow && git init && git add -A && git commit -m "init series"
# service 后端才需要起看板（监制拍板的 Web 工作台）：
dev-loop init-service myshow "My Show" SD && dev-loop daemon up
```
> 标签（`note:*`、`opening:protected` 等）免播种，agent 首次用即生效。想重置某项？删掉对应文件/条目再跑一次 init（只补缺失）。

---

## 5. 用 Codex 跑 loop（dev-loop 自己的调度器）

### 先 dry-run 预览（不调用 Codex、不动看板，只打印它会干什么）

```bash
dev-loop run --cli codex --once --dry-run --codex-safe \
  --agents senior-dev,junior-dev,qa --dev-split \
  --project myshow --root $DL
```

你应看到三行 `codex exec --model gpt-5.5 …`，且 `skill=story-architect-agent / screenwriter-agent / screenplay-editor-agent`、`DEVLOOP_ACTOR` 仍是 senior-dev/junior-dev/qa。对了就往下。

### 真跑：先把 `mode` 改成 `"live"`，然后**一步一步 + 人在门上拍板**

短剧不能一把无人值守跑完——按这个节奏：

```bash
# ① 主笔设计第一弧（读 bible → 写 beat-sheet + 填 grid + 派每集子票 → 设计父票进 In Review）
dev-loop run --cli codex --once --agents senior-dev --project myshow --root $DL
```
→ **去 Web 看板（监制拍板·设计门）**：读 beat-sheet + grid，通过就把设计父票移 `Done`、把每集子票从 `Backlog` 提到 `Todo`；不通过就 `Canceled` + 让它重设计。
（可在 series 目录跑 `node $DL/tools/dramalint.mjs $SERIES` 看 orphan/密度 warn 辅助判断。）

```bash
# ② 编剧逐集写（取 Todo 子票 → 先读 Design → 写 episodes/epNNNN.md → 跑 dramalint → 进 In Review）
dev-loop run --cli codex --once --agents junior-dev --project myshow --root $DL

# ③（可选）编辑机检 + 抽取（重跑 dramalint；硬失败自己打回重写、不烦你；硬过就贴 advisory 证据给你）
dev-loop run --cli codex --once --agents qa --project myshow --root $DL
```
→ **去 Web 看板（监制拍板·品味门）**：读草稿。行 → 移 `Done`（锁 canon）；不行 → 开 typed `note:*` 工单 + `Canceled` 该集让它重写（结构性问题升级给主笔直写）。

```bash
# ④ 让它持续转（按 cadence：senior@5m, junior@5m, qa@5m），你只需周期性回看板拍板。
#    --max-fires 封顶成本，避免烧太多 Codex 额度。
dev-loop run --cli codex --agents senior-dev,junior-dev,qa --dev-split \
  --project myshow --root $DL --max-fires 20
```

> `autonomy:"ask"` 时 agent 不会越权——遇到要人定的就 block 到看板等你，不会自作主张。
> 前 6 集（`opening:protected`）走主笔直写 + ≥3 版 A/B，由你在 ③ 选。

---

## 6. 日常节奏与成本

- **节奏**：`主笔设计 → 你过设计门 → 编剧写一弧 → 你过品味门 → reflect 把你反复提的 note 结晶成课程（写手下次自动读）`。人均纠正负荷（NPE）随时间下降 = 棘轮在起效。
- **成本**：`--max-fires N` 封顶每次 run 的 fire 数；`--once` 手动逐步跑最省、最可控。Codex 用量看你的额度。
- **reflect/sweep**：攒够已关闭 `note:*` 工单后，把 `reflect` 加进 `--agents`（它自动结晶课程，无需你 ack）；票搁浅了再加 `sweep`。

---

## 7. 排错

| 症状 | 处理 |
|---|---|
| `permission denied: dev-loop` | 旧 build 没给 bin 加可执行位。`cd $DL && git pull && cd hub && npm run build && npm link`（build 已修为 chmod +x）；急用先 `chmod +x $DL/hub/dist/*.js` |
| `dev-loop` 跑的是旧全局版（没有 `agentFamily`） | `npm rm -g @dyzsasd/dev-loop` 卸旧版 → 在 `$DL/hub` 重 `npm link`；`which dev-loop` 确认指向源码 |
| `dev-loop` 命令找不到 / 报 node 版本 | `nvm use 23`；或 `DEVLOOP_NODE=$(which node) dev-loop …` 指定 node |
| 调度器找不到短剧 SKILL | 确认带了 `--root $DL`（指向 checkout，其 `skills/` 有三个 agent）；或 `cd $DL/hub && npm run build` 刷新镜像 |
| `codex exec` 卡住 / 要 stdin | 调度器已用 `< /dev/null` 形式；确认 `codex login` 过、`codex --version` 正常 |
| 喂给 Codex 的 model 不对 | 删掉 `projects.json` 里的 `models`/`efforts`，用调度器的 Codex 默认（gpt-5.5） |
| dramalint 报硬门失败 | 看输出修：每集 `hook_out` 非空 + 正文末拍有 `【钩子】`；`length_sec∈[min,max]`；人名∈`characters.csv`；卡点集有钩 |
| 自检 | `node $DL/tools/dramalint.mjs --self-check` 应打印 `✓ passed` |

---

## 一页速查

```bash
# 装（源码）
nvm use 23 && npm i -g @openai/codex && codex login
git clone …/dev-loop && cd dev-loop/hub && npm install && npm run build && npm link
export DL=$(cd .. && pwd)

# init 一部剧（一条命令：series 骨架 + projects.json + lessons seed）
node $DL/tools/init-screenplay.mjs myshow "My Show" SD ~/series-myshow --backend service
#  → 填 bible.md + characters.csv，然后 cd ~/series-myshow && git init && git add -A && git commit -m init

# service 后端才需要：起看板
dev-loop init-service myshow "My Show" SD && dev-loop daemon up    # 打开 Web 看板

# 跑（Codex）+ 人在门上拍板
dev-loop run --cli codex --once --dry-run --codex-safe --agents senior-dev,junior-dev,qa --dev-split --project myshow --root $DL   # 预览
#  → mode 改 live，然后 --once 逐步：senior-dev → 设计门 → junior-dev → 品味门 → qa → …
```

---

## 卸载 / 清理

三个层级，按需选。

### A. 只删一部剧（保留 dev-loop）
```bash
dev-loop daemon down                            # 停该项目的看板 daemon（从 series 目录跑，或带 --project myshow）
#  从 ~/.dev-loop/projects.json 删掉 "myshow": {...} 这个条目
rm -rf ~/.dev-loop/myshow                        # 删该项目的运行时数据（lessons / 本地 board / reports）
rm -rf ~/series-myshow                           # 删剧本文件（你的 bible/episodes——确认后再删）
#  service 后端：init-service 把 dev-loop-hub 合并进了 series repo 的 .mcp.json——删掉那个 block 或删整个 repo。
```
> ⚠️ service 后端：hub.db 里该项目的工单**不会**被上面删除——**没有** delete-project CLI。要么留着（已 scoped，和别的项目无害共存），要么走 C 删整个 hub.db。

### B. 卸载 dev-loop 本体（保留剧本文件）
```bash
dev-loop daemon down                             # 停 daemon
dev-loop daemon uninstall-autostart              # 移除开机自启（macOS LaunchAgent com.dev-loop.daemon）
npm rm -g @dyzsasd/dev-loop                       # 解除全局命令（源码 npm link 或旧的全局安装都用这个）
which -a dev-loop                                 # 确认没有残留（你可能装过两份）
rm -rf $DL                                         # 删源码 checkout（若 export 过 DL，也从 ~/.zshrc 删掉那行）
```

### C. 彻底清掉所有 dev-loop 数据（⚠️ 含别的项目）
```bash
rm -rf ~/.dev-loop      # ⚠️ 不可逆：删掉 hub.db（所有项目+工单，含你那个 98 票的 dogfood）、所有 lessons/reports/board
```

### Claude 插件（若装过）
- marketplace 装的：Claude Code 里 `/plugin uninstall dev-loop@...` + 移除 marketplace。
- `claude --plugin-dir $DL` 起的：不持久，关掉 Claude Code 即无。

### Codex（你自己的工具，通常保留）
```bash
codex logout && npm rm -g @openai/codex          # 真要卸载才跑
```
