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
cd dev-loop
git checkout feat/shortdrama-devloop      # 短剧变体所在分支（合并到 main 后用 main）

cd hub
npm install
npm run build                 # 编译 dist + 把 skills/references/config 物化进 hub（scheduler 用）
npm link                      # 把 `dev-loop` / `dev-loop-hub` 两个命令全局指向这份源码

# 验证：
dev-loop --version
dev-loop doctor               # 健康检查，应打印 DOCTOR_OK
```

> 记下 checkout 的绝对路径，下面叫 `$DL`（例如 `export DL=~/dev-loop`）。
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
- 如果你**也**用交互式 Mode A 插件（Claude Code 里的 `/dev-loop:*`）：在 Claude Code 内 `/plugin update`，或重跑 `dev-loop install-claude-plugin` 重新登记本地 marketplace。

---

## 3. 立一部剧（series 目录 = 工程化产物集）

```bash
export SERIES=~/series-myshow
cp -r $DL/templates/screenwriting $SERIES
cd $SERIES
mkdir -p episodes
git init && git add -A && git commit -m "init series skeleton"
```

然后**填两份东西**（这是人的活——主创的北极星）：

1. **`bible.md`**：把每个 `<…>` 占位填实——立项书（题材/平台/受众/卡点集/禁区）、Vision（logline + 双供给配比）、爽点配方、`gate-config` 围栏块的阈值（集长上下限、付费卡点集号、密度目标）。
2. **`characters.csv`**：填主角行，重点是 `voice_signature`（声纹金句）和 `secret_setup`（携带的契诃夫枪）。

> 可对照 `$DL/examples/series-hidden-heir/`（一个 lint 通过的样例切片）照着填。
> `grid.csv` 和 `episodes/` 先留空——主笔 agent 会填 grid、编剧 agent 会写 episodes。
> `lessons.md`（含 reflect 重定向规则）保持原样，下面会拷到运行时目录。

---

## 4. 配 project + 起 board（service 后端，给人类一个 Web UI 来拍板）

短剧的「人在门上拍板」用 hub 的 **Web 看板**最顺手，所以推荐 `backend:"service"`。剧本文件仍在磁盘（`repoPath`），看板在 hub。

```bash
# 4a. 在 hub 建项目 + 标签 + actors（含 senior-dev/junior-dev/qa）：
dev-loop init-service myshow "My Show" SD          # key=myshow, 显示名, ticket 前缀=SD
# 它会建项目、起一次 daemon、打印看板 Web URL。

# 4b. 写 projects.json（默认位置 ~/.dev-loop/projects.json）：
mkdir -p ~/.dev-loop
cat > ~/.dev-loop/projects.json <<JSON
{ "projects": {
  "myshow": {
    "backend": "service",
    "devSplit": true,
    "agentFamily": "screenwriting",
    "ticketPrefix": "SD",
    "repoPath": "$SERIES",
    "strategyDoc": "bible.md",
    "hub": { "db": null, "docs": false, "transport": "daemon" },
    "mode": "dry-run",
    "autonomy": "ask",
    "testEnv": {
      "testCommand": "node $DL/tools/dramalint.mjs $SERIES",
      "notes": "无 web surface；测一集 = dramalint 结构门。品味归人类监制。"
    }
  }
} }
JSON

# 4c. seed reflect 的 lessons.md（让复发反馈结晶到编剧小节，不是 ## PM）：
mkdir -p ~/.dev-loop/myshow
cp $DL/templates/screenwriting/lessons.md ~/.dev-loop/myshow/lessons.md

# 4d. 起看板 Web UI（人类在这里 review/拍板）：
dev-loop daemon up
# 打开它打印的 URL（形如 http://127.0.0.1:<port>），这就是监制的工作台。
```

> 关键点：
> - **不要在 `projects.json` 里写 `models`/`efforts`**——省略它们，调度器自动用 Codex 默认（senior-dev=gpt-5.5/xhigh，junior-dev/qa=gpt-5.5/high）。写 Claude 的 model id 反而会喂错 Codex。
> - 标签（`note:*`、`must-fix`、`opening:protected` 等）**免播种**，agent 首次用即生效。
> - 先 `mode:"dry-run"` 验证，确认无误再改成 `"live"`。
> - 想零云、纯本地？把 `backend` 换成 `"local"`、删掉 `hub` 块即可——但那样人类拍板要改 ticket 文件（没 Web UI），不如 service 顺手。

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

# 立剧
cp -r $DL/templates/screenwriting ~/series-myshow && cd ~/series-myshow && mkdir -p episodes && git init && git add -A && git commit -m init
#  → 填 bible.md + characters.csv

# 配 + 起看板
dev-loop init-service myshow "My Show" SD
#  → 写 ~/.dev-loop/projects.json（backend:service, agentFamily:screenwriting, repoPath, 省略 models）
cp $DL/templates/screenwriting/lessons.md ~/.dev-loop/myshow/lessons.md
dev-loop daemon up                      # 打开 Web 看板

# 跑（Codex）+ 人在门上拍板
dev-loop run --cli codex --once --dry-run --codex-safe --agents senior-dev,junior-dev,qa --dev-split --project myshow --root $DL   # 预览
#  → mode 改 live，然后 --once 逐步：senior-dev → 设计门 → junior-dev → 品味门 → qa → …
```
