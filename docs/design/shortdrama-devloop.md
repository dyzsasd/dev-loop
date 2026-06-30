# 短剧创作 Dev-Loop 系统设计

> 把 dev-loop 的多智能体闭环改皮成一套**工程化的竖屏短剧创作系统**。基于两部样本剧本（*The Hidden Heir Takes Over* / *Alpha's Fated Bride*）读出的结构 DNA，复用 dev-loop 全部原语，唯一新代码是一个 lint 脚本。

---

## 0. 定位：这是「地板机器」，不是「爆款机器」（最重要的前提）

承接上一轮结论——**人是在环品味预言机（in-loop oracle），系统是一台 taste-ratchet（品味棘轮）**。它的「赢」是 *每出一集合格戏所需的人力随时间下降*，不是「无人值守出爆款」。

- **系统保证的**：不缺钩、不烂尾、不连戏崩、双供给（解气×甜宠）不断档、付费卡点有硬切——即体裁地板。
- **系统不保证的**：爆款的灵气（反派弧光、男主非占位式价值观自白、主题克制度）。这层是复发门抓不到、也生成不出的一次性手艺，**归人**，主要砸在前 6 集。
- **唯一真客观裁判是市场**（完播率/付费率），只能靠投放测出，接通后**凌驾**责编口味。投放前，系统优化的是「责编口味盲区」，不是市场留存——这个 gap 要明确接受。

---

## 1. 从两部样本读出的结构 DNA

两部剧本是同一套「注意力工程」的两个皮肤，共性远大于差异：

| 维度 | The Hidden Heir Takes Over | Alpha's Fated Bride |
|---|---|---|
| 体量 | 50 集 / 60–120s | 40 集 / 90–120s（分镜编号制 23-1/23-2/23-3） |
| 题材 | 身世反转·隐藏大佬·复仇逆袭+霸总甜宠 | 先婚后爱·狼人命定·隐婚生子 |
| 开场 | 0 铺垫直切**羞辱顶点**（晚宴窃稿+当众离婚+毁稿五连击） | 0 铺垫直切**最暧昧+最危险瞬间**（药物一夜情+掐颈+狼耳浮现） |
| 卡点 | ~ep8–12（第一爽点簇后，资产清算/抄袭实锤） | ~ep10–11（DNA 99.9%+「只有我能治」+逼婚） |
| 核心榨取 | 身份枪**双轨**：对观众 ep2–3 早揭，对反派 ep37/ep42 晚爆 | 月亮胎记当「情感真伪计量器」，只在真情时显形，跨全剧收口 |

**两部都验证的可模板化骨架**（= 生成器的靶子）：

1. **开场公式**：`首镜直进最高张力 → 旁白≤1句 → 3秒内抛≥2个待解悬念 → 加害者零愧疚反问("So what if I did?") → 多重打击五连击`。
   - 实证：Rowan「So what if I did? What can you do?」紧接抢话筒离婚+婆婆撕稿。
2. **集末钩三选一插槽**（零场景成本，全是台词级）：① 新灾难砸反派（加密短信/新闻大屏/慌张报信下属）② 新人物入场（"The X has arrived!"）③ 男主秘密被来电打断（跨集悬置）。
   - 实证：ep2 末「The heir seal has been removed. Welcome home, Miss Gray.」；ep10 末「检测匹配度 99.9%……立刻查她们母子位置。」
3. **打脸四拍节律**：`反派嚣张 → 实锤(录音笔/U盘/DNA) → 围观群众倒戈(先捧后踩，最常被略过) → 主角淡然一句收尾`。
   - 实证：茶室 Serena「So what if I did?」→ Lila 摇录音笔「thanks for the confession」。
4. **双供给硬约束**：滚动窗口内「复仇打脸轴」与「甜宠轴」**两轴都须命中**（女频两类核心需求），任一集至少命中一种。
5. **契诃夫枪早埋—延迟兑现**：身份枪、信物刻字双关（星形手链「you are your own light」→ 大结局拆坠饰「I'll be the sky beside you」）、外婆遗物回收「二十年欠账」。
6. **执行器副官状态汇报**：首席律师/Rick 用「指令已执行/已查实」把场外资本权力变成可听见的台词，零场景演大佬感。

**一次性手艺（归人，模板抓不到）**：渣男赎罪交证的反派弧光、男主「理性人生唯独对你失控」的自白、把「你本身就是光」贯穿手链/誓词/刻字的主题统一。这层是区别于流水线的真 craft。

---

## 2. 工程化产物模型：剧本 = 一套被工程化的产物集

> 核心等式：**一部短剧 = 1 份治理文档（bible，含立项书）+ 2 张脊柱 CSV + N 个分集草稿 + 1 套反馈/课程层**。全部落在 hub doc-base + git + markdown/CSV 上，零新基建。

### 2.1 产物注册表

| 产物 | 载体 | 格式 | 产出 | publish 门? |
|---|---|---|---|---|
| 立项书 | `bible.md §立项书` | md | 主创(人) | **是** |
| 系列圣经（北极星） | `bible.md` / hub `kind:strategy slug:bible` | md | 主创(人) | **是** |
| 人物表 | `characters.csv` | csv | 主笔(senior) | **是**（name∈表硬门依赖） |
| 分集表 | `grid.csv` / hub `kind:roadmap` | csv | 主笔(senior) | **是**（季级签字） |
| 弧/beat-sheet | hub `kind:design slug:beats-<arc>` | md | 主笔(senior) | 否（design 级，save 即活） |
| 分集草稿 | `episodes/epNNNN.md` | md+YAML | 编剧(junior) | 否（git=代码轴，In Review 人审） |
| script-note | hub 工单 | issue | 责编(人) | n/a |
| lessons | `lessons.md`（**复用 dev-loop，非新文件**） | md | 复盘(reflect)·**自动管** | 无（人可查询/手改，不 ack） |

**两级结构**：被门控的脊柱（bible/人物表/分集表，operator 签字，给硬门提供权威事实）+ 其下不门控的工作层（beat-sheet/草稿，save 即活，不卡流）。

### 2.2 `bible.md`（含立项书；operator-publish-gated）

固定 verbatim 章节：
`## 立项书`（题材/平台/受众/卡点/禁区）· `## Vision`（logline+双供给配比 如 复仇:甜=6:4）· `## Goals`（留存/转化北极星）· `## Non-goals`（不降维拯救/不烂尾/不破人设/不写过渡集）· `## World rules`（世界观硬规则=连戏法律来源）· `## 爽点配方`（类型轮转+密度+双供给配比）· `## 钩子模板`（集末三选一）· `## 契诃夫枪台账` · `## recurring devices`（桥段库）· `## 付费卡点工程` · `## 禁区红线`

结尾必带**机器可读 `gate-config` 围栏块**（lint 只读它，阈值不写死在代码里）：

```yaml gate-config
length_sec: {min: 60, max: 120}
payoff_density: {window_eps: 3, min_per_window: 4}   # flag-only 监控
double_supply: {axes: [复仇, 甜], window_eps: 5}      # flag-only
paywall: {boundary_ep: 11, must_have_hook: true}     # 硬门只检"有钩落末拍"
opening_protected_eps: [1,2,3,4,5,6]                  # 前6集走高门槛产物
free_eps: [1..10]
```

### 2.3 `characters.csv`（name∈表是硬门，故是治理产物）

`id, name, aliases(竖线分隔，喂 name 门), archetype, faction, voice_signature(声纹金句/收尾句式), first_ep, function, secret_setup(携带的契诃夫枪), status(active/written-out/superseded-by)`

### 2.4 `grid.csv`（分集表 = roadmap，一集一行，计划层权威）

`ep, arc, act_fn(冷开/卷入/反转升级/危机/高潮/收尾), logline, sock_type(打脸/逆袭/身份反转/甜/bridge), sock_density, hook_type(三选一), hook_payload, hook_strength_advisory(自评,不喂硬门), setup_ref, payoff_ref, paywall_flag(Y/N), length_target_sec, characters_present, draft_status, draft(指针)`

> **MVP 折叠**：钩子台词原文先进草稿正文；hook-ledger / setup-payoff / continuity **不单独建表**，用 grid 的 `hook_type/setup_ref/payoff_ref` 三列承载最小钩-伏关系。**每张额外的表都要由一次真实的复发漏点来支付它的存在。**

### 2.5 `episodes/epNNNN.md`（=「代码」轴）

YAML front-matter（lint 契约 + 人审仪表盘）+ 剧本正文：

```yaml
---
ep: 7
arc: 1
length_sec: 105                  # length-bounds 硬门
hook_out: 集末"新灾难砸反派"      # hook-present 硬门
payoffs: [{type: 打脸}, {type: 甜}]   # 仅喂 flag-only 密度监控
setups_planted: [G-004]
payoffs_fired: [G-001]
characters: [Lila, Rowan, Winnie]    # 须 ⊆ characters.csv，硬门
paywall: false
---
```
正文规范：分镜编号 `7-1/7-2/7-3`；`△`动作/镜头行；`角色：台词`；集末钩用 `【钩子】` 标注。

### 2.6 交叉引用不变量（lint 三层对账：bible.gate-config × grid × 草稿 front-matter）

- **INV1（硬）** `characters ⊆ characters.csv`
- **INV2（硬）** 每集有 `hook_out` 且落末拍
- **INV3（硬）** `length_sec ∈ [min,max]`
- **INV4（硬）** paywall 集 `hook_out` 非空且落末拍
- **INV5（flag）** 滚动密度 ≥ min 且双供给两轴命中——**必要非充分，Goodhart 哨兵，绝不当可发信号**
- **INV6（flag）** setup-payoff orphan（埋而不收/收而未埋）——直击烂尾，MVP 仅 warn
- **INV7（flag）** 连戏：不违 World rules，角色不用 known_by 之外信息（守信息差永动机）

### 2.7 目录布局

```
series-<slug>/
  bible.md                 # 治理·含立项书·北极星·gate-config
  characters.csv           # 脊柱(operator-gated)
  grid.csv                 # 脊柱(operator-gated)
  episodes/epNNNN.md       # 草稿(git=代码轴)
  lessons.md               # 课程层(复用 dev-loop·reflect 自动管·人可查询手改)
  hub: kind:design slug:beats-<arc>   # 弧 beat-sheet(design 级)
```

---

## 3. 智能体编制 + 状态机

短剧角色映射到 dev-loop agent。**注意：机制复用是真的，但「写作≠编程」的手艺体是新写的 SKILL，不是给 dev 套层皮**（见 §3.0）。复用 §21a 两层 dev 切分、§3 状态机、§9 block、§2 防火墙标签、§17 recurrence-gate。

### 3.0 智能体定义的管理：三层两家（按「变化速率 × 作用域」分家）

| 层 | 是什么 | 领域相关 | 剧目相关 | 形态 | 家 | 复用/新写 |
|---|---|---|---|---|---|---|
| **L1 宪法/机制** | 状态机/防火墙/supersede/block/设计门/recurrence-gate；**无手艺体的 agent**（reflect/sweep） | ❌ | ❌ | `conventions.md §` + 现有 SKILL | repo（两 family 共用） | 逐字复用 |
| **L0 工具** | lint 机械门 | 半 | ❌ | 确定性脚本 + bible.gate-config | repo `tools/` | 新写脚本（**不是 agent，不能 LLM**） |
| **L2 角色手艺** | 主笔/编剧/剧本医生「怎么写短剧」 | ✅ | ❌ | **新 SKILL 文件** | repo 编剧 family | **新写** |
| **L3 本剧手艺** | bible/grid/characters/lessons | ✅ | ✅ | 文档/表 | doc-base/git（每剧一个） | loop 管，非 agent 定义 |

- **reflect 能白嫖** 是因为它在 L1：无手艺体，只做「数已关闭 note 的复发 → 自动结晶/管理 lesson」的纯机制，唯一剧目差异是 config delta（复发阈值 + 指向本剧 `lessons.md`），不是重写。**真·原样复用**。sweep 同理。
- **主笔/编剧必须新写** 是因为它们在 L2：loop 机制（领票→读设计→产出→自检→In Review→缺料 block）和 dev 一样，但手艺体（开场公式/打脸四拍/钩子三选一/声纹）完全不同。
- **lint ≠ 剧本医生**：lint 是 L0 确定性脚本（其价值正在于不是 LLM）；剧本医生是 L2 真 agent = 主笔的 `kind:escalation` direct-rewrite 模式（频繁了再拆独立 SKILL）。

**管理收敛**：不按剧目管理 agent 定义——每部剧共享**同一套 L2 技能**，只靠 L3 文档区分。新开一部剧 = init 写一份 `projects.json`（`agentFamily:"screenwriting"` + `strategyDoc→bible` + `lessons→lessons.md`）+ 一套空 doc-base，**零新 agent 定义**。一个 repo 靠每 project 选 family，可同时跑编程 loop 和编剧 loop。

**不变量（保持简单的全部原因）**：*技能(L2)装通用手艺，绝不装本剧事实；本剧事实(L3)全在文档里*。SKILL 里写死「女主叫 Lila」=L3 泄漏进 L2，该技能从此只能写一部剧。技能=引擎，bible=燃料（即 dev-loop 既有的 strategy-doc 模式）。

**ponytail 取舍**：编剧 family 先放进 dev-loop 同一 repo（共享一份 conventions.md），用 `agentFamily` 区分；**不**现在开第二个 plugin（两份会漂移的 conventions + 两套发版）。需独立发版节奏了再拆。

| 短剧角色 | dev-loop agent | 职责 | 模式 | 模型档 |
|---|---|---|---|---|
| **主创/监制** | 人 / `operator` | 唯一品味裁判；发布 bible/人物表/grid；每弧序列审；发分型分级 note；可查询/手改 `lessons.md`（**不 ack**）；**唯一能设 must-fix** | human-gate | 人 |
| **主笔 story-architect** | `senior-dev` 重立宪 | **本 loop 的 PM**：写圣经/人物表/弧切分/grid（=队列）/beat-sheet；派 per-episode 子票（带 `Design:` 指针）；保持 bible 现行+提结构改进；**前 6 集亲写**；难集 `direct-code`（=剧本医生模式） | write + human-gate | opus/max |
| **编剧 episode-writer** | `junior-dev` 重立宪 | 领已晋级 episode 票 → **先读 Design 指针** → 写草稿 → 跑 lint 自检 → In Review；缺角色/断指针/矛盾 → **BLOCK** | write | sonnet/high |
| **lint 机械门** | `dramalint` 脚本 | 纯机械 pass/fail（hook 在场/集长/name∈表/卡点有钩）；其余 flag-only | verify（确定性） | 无 |
| **编辑读者**（可选） | `qa` 重立宪「抽取非裁决」 | 复跑 lint + 按 rubric 抽取**建议性** note；机检 PASS 挂 `needs-showrunner`。**绝不下终判，绝不自设 must-fix** | observe-and-file | sonnet/high（刻意不用最强档，避流畅度偏置） |
| **复盘 reflect** | `reflect` 原样 | 扫已关闭 note → 复发≥3集 → **自动**结晶/管理 `lessons.md`（原则+正例，**无人 ack**；信任边界在 note）→ 打印 NPE | curate | xhigh |
| **清扫 sweep** | `sweep` 原样 | 生命周期卫生：缺标签/孤儿 In Progress/残留子票 | hygiene | high |

### 状态机（复用 §3 六态，零新状态）

工单类型（恰好一个 `kind:*`）：`kind:season-design`（季弧+grid 设计父票，senior）· `kind:episode`（写一集，junior，主力产能）· `kind:escalation`（senior 直写难集）· `kind:note`（分型分级反馈，喂 recurrence-gate）。

标签：防火墙 `ai-draft`（载重，agent 只能读/碰带它的票，人手写 canon 不可见）· dev-tier 路由 `assignee:senior-dev/junior-dev` · `episode:SxxEyy` · `note:structure/voice/pacing(MVP 3 个)` · 分级 `must-fix`(仅人设)/`preference`。

| 状态 | 短剧语义 | 谁移入 |
|---|---|---|
| Backlog | grid 拆出未过设计门的子票 | 主笔/reflect |
| Todo | 已晋级可写 | **主笔**（仅晋级人-Done 父票之子）/监制 |
| In Progress | 编剧/主笔在写 | claim |
| In Review | 草稿完成待验 | 编剧/主笔 |
| Done | **人批准**，成 canon | **监制(人)** |
| Canceled | 被 supersede/废弃 | 任一 agent + 注明原因 |
| Human-Blocked | 真 block（仅人可决/商业决策） | daemon 逐票 ping |

**两条不变量**：① 设计门——**仅当父票人-Done，主笔才批量晋级子票 Backlog→Todo**（绕过人=设计门失效，sweep 抽查）。② supersede-don't-mutate——口味 fail 的草稿被 supersede 开新票，**绝不静默 reopen/原地改**，历史看得出「曾交付但 fail」vs「现在排队」。

### 3.1 谁是 PM？循环如何自主

dev-loop 的 PM 在短剧里**拆成三份**（PM 的「验收」恰有客观+主观两半）：

| PM 职责 | 谁接 | 自主 |
|---|---|---|
| 提需求/填队列 + 保持北极星 + 提改进 | **主笔**（grid=backlog，自动派票/更新 bible） | ✅ |
| 验收·结构契约（hook/爽点/长度/人名） | lint + 编辑读者 | ✅ |
| 验收·品味（这集行不行） | **人** | ❌ 唯一不能自主 |

PM 和 senior-dev 合成主笔，是因为短剧里**提案本身就是设计**（没法提「写第23集」而不设计它）。所以没有独立 PM agent——**主笔即 PM**。

**循环在「生产」上自主，只在「验收」上有人门**：主笔按 cadence fire，队列低且有未设计的弧 → 设计下一弧+派票 → **队列永不空**；编剧→lint→编辑分诊，全程无人值守地把草稿堆进 In Review。人离开几天，loop 照样堆出结构合格的草稿；人回来按弧批量验收。硬停只有两处（bible 改要人 publish、撞创作缺口 BLOCK）。**自主度随时间涨**：棘轮（NPE↓，人每集要提的 note 变少）+ 上线后市场 oracle（完播/付费数据是第二个不需要人的裁判）。

---

## 4. INIT：如何起一个短剧（需要哪些信息）

operator ≡ 人类品味裁判 ≡ 主创（同一人）。复用 dev-loop `init` 骨架，**绝不发明方向**（选填留空，必填答不出标 ✗ 并指明阻断谁）。

### 必填问卷（11 项，缺一不可 live）

| 字段 | 写入 | 下游驱动 |
|---|---|---|
| 题材/genre | bible.立项书 | 人物原型+爽点配方 |
| 平台（ReelShort/DramaBox/红果） | bible.立项书 | 时长/卡点惯例+合规 |
| 目标受众（女频/男频,地区） | bible.立项书 | 双供给侧重 |
| 语言（中/英/双语） | bible.立项书 | 嗓音+命名 |
| 集数 × 单集时长 | bible+grid 行数+gate-config | grid 维度 |
| **付费卡点位**（免费集区间+卡点集号） | gate-config.paywall | 单一最重商业杠杆 |
| 核心卖点+logline+招牌钩 | bible.Vision | 北极星钩子 |
| 主角人设（女主+男主 archetype+声纹） | bible+characters.csv | 人物表 |
| 爽点类型偏好+权重 | bible.爽点配方 | 密度/双供给目标 |
| 基调（爽/虐/甜比） | bible.Vision 配比 | 配比 |
| **禁区/合规**（涉政/血腥/未成年/价值观） | bible.禁区红线 | 机械门/人审输入 |

**选填**（不阻断）：对标剧（DNA 种子，如本任务两例）、多季意图、指定信物、角色名库、地区细分、制作成本上限（→偏台词级反转载体）、卡司约束。

### init 产出（只造空壳，不填内容、不发布、不建工单）

1. bible 骨架（固定标题 + 部分回填问卷 + gate-config 围栏，**单一治理文档单道 publish 门**）
2. `characters.csv` 仅表头
3. `grid.csv` 表头 + N 空行，卡点集预置 `paywall_flag=Y`，前 6 集打 `opening:protected`
4. 空 `episodes/` + 空 `lessons.md`
5. 项目/标签/配置：`dev-loop init-service <key> "<剧名>" SD`，seed actors + 标签集，`projects.json`：`backend:service`、`devSplit:true`、`mode:dry-run`

完成后打印**逐项就绪报告**（必填齐 ✓/缺 ✗+阻断谁），operator 审后手动翻 `mode:live`。

---

## 5. 自动开发 Workflow

`立项 → 圣经 → 人物 → 主线 → 分集表 → 分场 → 初稿 → 机械门 → 人审序列门`。复用 PM→senior/junior-dev→QA 生产环，改皮。

- **F0 init**（operator 在场，一次性）：问卷 → 骨架 → 就绪报告 → 翻 live。
- **F1 立项+圣经**：主笔补全 bible 草稿 →【publish 门①】operator `doc_publish`。**未发布前 senior 一律 BLOCK**（读不到 current 即 block info-needed，绝不 fluently 编世界观）。
- **F2 人物表+嗓音**：主笔写 `characters.csv`（声纹金句+携带的契诃夫枪）→【设计门 a】监制验 name 唯一/声纹互异/反派有「嚣张句」靶子 → Done。
- **F3+F4 主线+分集表+beat-sheet**（design-and-delegate 核心）：写弧切分/卡点落位/契诃夫枪 → 填 grid 每行命中爽点配方 → 派 per-episode 子票（staged Backlog，带 `Design:` 指针+ACs=grid 行契约）→【设计门 b·季级 operator 签字】监制验连贯/密度/**卡点位在好奇心负债最高点（人裁，非 LLM 自评）**/契诃夫枪无悬空 → Pass 后**才**批量晋级子票 Todo。
- **F4.5 前 6 集保护通道**（最重修正）：开场是唯一值得砸人力的资产（完播率死亡都在前几集）。前 6 集**不走普通 junior 通道**——主笔/主创亲写，强制 **≥3 个开场版本 A/B**，过**专属 opening rubric**（3 秒内进最高张力？第 1 集给终点级痛感？旁白≤1句？3 秒内≥2悬念？）。**人力不省。**
- **F5 单集初稿**（junior）：取 Todo → **先读 Design**（beat-sheet+grid 行+声纹+人物表+ `lessons.md`，MVP 整文件注入、大了再按场景过滤）→ 写草稿 → 跑 lint 自检（FAIL 改，retry≤2，第 3 次 BLOCK fix-exhausted）→ In Review。**BLOCK 而非臆造**：指针断/grid 点名 character∉表（不许自创角色）/ACs 矛盾。
- **F6 机械校验+顾问编辑**（QA 可选）：复跑 lint（防自检漏，机检 fail 自动退 Todo，不惊动人）+ LLM 编辑**只抽取/分诊**（弱钩/嗓音漂移/缺倒戈拍 → advisory 评论）。**绝不下 pass/fail 终判，绝不自设 must-fix。**
- **F7 人审序列门**（人类唯一终判）：**整弧**（非逐集——序列才能评跨集节奏/总爆点）推给人 → 人产**分型/分级 script-note**（severity 由人设）→ 弧通过该弧集 Done；有 note → 相关集 Cancel 超代 + 重写票。**人绝不把直接改稿当门**（不复利）——手改是 `lessons.md` 的正例样本。

---

## 6. 用户反馈 Workflow + Lessons 棘轮

> 零新代码：复用 §3 状态机 + supersede + 标签 + 模板。**三个 LLM 触碰 note（triage/编辑/reflect）都不判「好」——人是唯一验收者。**

### 6.1 script-note 工单（一等可关闭单元，不是评论）

复发门要「扫已关闭 note 工单」，故 note 必须可关闭（评论无类型、扫不出复发）。
- `Type=Improvement`（手艺打磨）；机械客观 fail 走 `Bug`，编剧在责编看到草稿**之前**修掉——责编稀缺注意力只花手艺。
- `Owner=editor`（结构上锁死 LLM 不能下「好」判决）。
- `kind`（MVP 3 个：structure/voice/pacing，复发逼出再拆到 7 个）。
- `severity`（**仅人设**）：`must-fix`=客观手艺失败，阻断 Done；`preference`=主观口味，不阻断，可带理由婉拒。皆无 ⇒ 默认 preference。

```markdown
## Note  EP07 第3拍打脸跳过"围观倒戈"，反派直接崩溃，路人没"先捧后踩"。
## Craft axis  note:payoff（打脸四拍）
## Severity  must-fix    <!-- 仅责编填 -->
## Anchor  Episode:EP07 · Scene:07-3 lines41-52 · bible#recurringDevices"围观倒戈"
## Want  Winnie 崩溃前插 2 行群体转向，守 ≤120s。
## Exemplar  见 EP03 07-2"Welcome back, Miss Gray"全员鞠躬。
```

### 6.2 领取 → 改写(supersede) → 人验收

EP 票是父，note 是子（`relatedTo`）。责编读草稿（在环预言机）：**接受** → EP Done 锁 canon + 记人工时；**有 note** → 落 N 张 typed note 子票 + **Cancel** EP 票 + 开新 episode 票（同 Design 指针）。编剧领 note → 先读 `lessons.md` → 改那一场 → In Review。**preference 可带理由婉拒；must-fix 不可婉拒（只能真矛盾时 block）。** EP Done ⟺ 所有 must-fix 子 note Done **且**责编接受装配后草稿。

### 6.3 复发门（recurrence-gate）—— 棘轮心脏

输入：窗口内全部 Done/Canceled 的 `note:*` 工单（reflect 经 `list_events` 只读拉取）。逻辑（慢节奏每 fire）：
1. 按 `note:<kind>`+objection 语义簇分组（in-context 聚类，**不建向量库**）。
2. **复发阈值=门**：仅当一簇**跨 ≥3 不同集**复现才结晶（N=3，严于 dev-loop 默认 ≥2——单条手艺 note 常是该集特定口味；3 集复现才证明是写手习惯）。单条亮眼 note **报告、不入册**。
3. **自动结晶、自动管理**（写进 `lessons.md`，**无人 ack**——见 6.4 信任边界）。

### 6.4 结晶形态：原则 + 正向范例（不是 banlist）

- **PRINCIPLE** = 复发 objection 的可迁移规则，写成 **DO**：「每个打脸走满四拍：嚣张→实锤→**围观倒戈**→淡然一句；倒戈拍最常被略过」。
- **POSITIVE EXEMPLAR** = 一个做对了的场景链接（取自责编点赞 Done 的集）：「范例：EP03 07-2'全员鞠躬'即倒戈拍标杆」。
- **context-tag 防冲突**：每条盖 `@character/@arc/@beat/@genre-lane`，**最具体 tag 胜**；文件里不许两条活的矛盾。写手按场景 tag 过滤——甜点 lesson 绝不误触打脸场景。

**用 dev-loop 现成 `lessons.md`，非新文件。** 分区：`## 结构 / ## 声口(按角色) / ## 节奏 / ## 钩子 / ## 爽点 / ## 台词 / ## 房子风格 / ## 范例库`。预算 ≤~6 原则/区、≤150 行，范例是链接不内联。**EXPIRE**（写手内化了）/ **PROMOTE**（实为圣经事实 → 升 bible；或可机械检 → 毕业进 lint 建议性检查 → 人彻底停提这条：*人类品味 → 复发 note → 手艺原则 → 机械闸 → 零人类成本*）。

**信任边界在 note，不在 lesson（所以无需 ack）**：reflect 只从**人写的已关闭 note**（+上线后市场数据）结晶，绝不从自己读草稿的审美判断造 lesson——人的判断早在写 note 时就进了系统，lesson 只是机械压缩，再 ack 是重复设防。**不变量**：reflect 只从可信外部信号（人 note / 市场数据）结晶，从不凭自己的品味提炼；否则 LLM 审美就泄漏了。

**坏 lesson 的三道兜底（替代预审）**：① 人可查询、手改/删（可逆，像 dev-loop 编 `lessons.md`）；② lesson 功效追踪（加入后对应 note 簇不降 → 自动 supersede）；③ 每弧人 taste-gate 兜底（坏 lesson 只影响人仍要审的草稿，写差了人就看见、回去改）。

**渐进结构化**（各由一次真实的疼支付，非 MVP 一次性）：MVP = 自由文本 + 整文件注入 + 全人写（reflect 不跑）；reflect 启动 → 每条加 `kind/scope` tag；整文件注入开始污染 → 按 scope 过滤注入；store 大到难维护 → 才拆独立文件（很晚，可能永远不）。

### 6.5 量化「赢」：NPE + 反自欺

核心指标 = **NPE（notes-per-accepted-episode）**= 每张 Done 的 EP 的子 note 数（人类纠正负荷），滚动均值。从工单台账现算，零新基建。
- 棘轮有效 ⟺ **NPE↓ 而接受率不降**。
- **反自欺判据**：NPE↓ 必须**同时配 首过接受率↑ 且 must-fix 率↓** 才算赢——否则是「人疲了停提 note」的假胜。
- 目标形态：NPE ~6/集(冷启) → ~1.5(稳态)，首过接受率 10%→50%，集数与门槛不变。

### 6.6 market-oracle 接口（最致命的修正）

责编是**品味预言机**，不是**市场预言机**。一旦该剧投放：完播曲线/付费断点回灌成 `platform-performance` note **凌驾**责编口味；`lessons.md` **优先从「投放差的集」结晶**。诚实承认 **NPE↓ ≠ 市场表现↑**。

---

## 7. 质量门：机械硬门 vs 顾问建议（清晰分离）

唯一新代码 = lint 脚本 `dramalint`，读 `bible.gate-config + grid.csv + characters.csv + 草稿 front-matter`，trivial 解析。

**A. 机械硬门（genuinely pass/fail，可阻断）—— MVP 只此 4 项**

| 门 | 判据 |
|---|---|
| hook-present | 每集 `hook_out` 非空且正文末拍有 `【钩子】` |
| length-bounds | `length_sec ∈ [min,max]` |
| name∈表 | `characters ⊆ characters.csv(canonical∪aliases)` |
| 卡点有钩 | paywall 集 `hook_out` 非空且落末拍 |

这 4 项是「在场/格式/边界」类客观事实，**LLM 无法靠自评作弊**（hook 在不在、集长几页、名字在不在表，都是正文可机判的，不是「写得好不好」）。

**B. flag-only 监控（warn 不阻断，Goodhart 哨兵）**：爽点密度 / 双供给两轴 / setup-payoff orphan / 连戏矛盾 / front-matter 漂移。这些数的是 LLM 自标 type 计数——测的是「格子里写了 3」不是「观众划不走」，**必要非充分，绝不当可发信号**。

**C. 刻意移出机械门的伪硬门**（两份 critique 一致点名）：① hook `strength` 自评——由写正文的同一 LLM 自填，**降 advisory/人审字段**，「够不够狠」归人裁或独立二次 pass。② 删 `_payoff-density.gen.csv` 制品——密度是 lint 的 stdout，不写盘。

**D. 顾问 rubric**（advisory，永不 pass/fail）：LLM 编辑按 rubric 抽取候选连续性断点/嗓音漂移/弱钩/缺倒戈拍，挂评论。刻意用 sonnet 非最强档，避流畅度偏置当裁判。

**E. 前 6 集专属 opening rubric**（人审清单，非 LLM 终判）+ 强制 ≥3 版本 A/B。

**红线**：永不把人口味闸塌缩进机械闸；永不把「机检全绿」当「这集好」。

---

## 8. 懒人 MVP：先证「单弧成环」

> 新代码总量 = lint 脚本 + projects.json。其余全是字符串（标签+模板+空骨架）。

**要创建的 agent / 工具（按层 §3.0）**：

| 阶段 | 创建 | 说明 |
|---|---|---|
| **Tier 0**（证环） | **1 个 writer SKILL** + **dramalint 脚本** | `devSplit:false` 单写手把 grid+初稿一把抓；lint 是脚本不是 agent，带 1 个 assert 自检 |
| **Tier 1**（转正） | 拆成 **主笔 + 编剧** 两个 SKILL；主笔加 `escalation`=剧本医生模式 | 翻 `devSplit:true` |
| 复用·不创建 | reflect / sweep / conventions.md / 状态机 / 防火墙 / supersede | L1，原样；reflect 攒够 note 语料再激活 |
| 不是 agent | dramalint（确定性脚本）、监制（人） | — |

**先建**（证一弧闭环：谷底→翻身三集引子+卡点能产出）：
1. INIT 问卷 = 11 必填字段做成**一个 markdown 表单**（非定制 UI）。
2. **单一治理文档** bible 含 `## 立项书`，单道 publish 门。
3. **两张脊柱 CSV**（characters/grid），手写，operator commit 即门。**钩子账/伏笔表/连戏表/密度表都不单独建**。
4. 草稿 front-matter 契约（lint 全部输入）+ 空 `lessons.md`（复用 dev-loop，非新文件）。
5. 跑**第一弧**（≤17 集，如 Thorne 复仇弧）：F1 bible→publish、F3 只填第一弧 grid+一个 beat-sheet、F5 编剧逐集初稿、F7 人审整弧。
6. 机械门 = 4 项硬检，其余 flag-only warning。
7. 人审序列门 + script-note（先用带 `note:type` 的 Improvement 工单 + 一行模板）。
8. 角色 = 监制+主笔+编剧+lint+reflect+sweep，**全靠 prompt 重立宪 + 改防火墙标签为 `ai-draft`**。

**显式延后（YAGNI，由一次真实复发/瓶颈支付）**：

| 延后项 | 触发条件 |
|---|---|
| 独立 hook-ledger.csv | 跨弧长线钩 >2 条，grid 三列说不清错峰兑现 |
| setup-payoff 双轨列 | 出现「对观众早揭/对反派晚爆」 |
| continuity.csv | 连戏 bug 进了 note 且复发 |
| senior/junior 拆分 | MVP 可先 `devSplit:false` 单写手验环，再翻 true |
| 每弧独立 beat-sheet | MVP 折进 grid 的 `beat_summary` 列 |
| triage LLM | 责编 note 填写成本成瓶颈 |
| reflect 启动 | 攒够 note 语料（第一弧无复发） |
| sweep | 一人+一弧不需要 |
| note kind 7 个 | MVP 3 个，复发逼出再拆 |
| lesson→机械闸 PROMOTE | 先人工手搬一条给 lint |

**保留不偷懒（trust boundary，省不得）**：必填问卷校验、operator-publish 门、block-rather-than-guess、supersede CAS、人是唯一 Done 权威、severity 只人设、**前 6 集高门槛通道**。

---

## 9. 需要你拍板的开放决策

1. **定位的诚实承诺**（最重要）：接受「地板机器」（合格地平庸）+ 爆款靠人写前 6 集，还是期望「无人值守出爆款」（→本设计不交付，应停建）？
2. **市场 oracle 何时接入、权重多大**：投放前明确接受「优化责编口味盲区 ≠ 市场留存」的 gap。
3. **前 6 集投多少人力**：≥3 版本 A/B 成本谁出？主笔 vs 主创亲写？
4. **付费卡点**：bible 写死集号，还是「好奇心负债最高点」启发式+人审+数据微调？（建议后者）
5. **后端选型**：`backend:service`（daemon 自动 ping/design 承载 beat-sheet/list_events 给 reflect）vs `linear`/`local` 退化版？
6. **lessons 信任来源**（已决，记此为约束）：reflect 自动管 `lessons.md`、无人 ack；信任边界锁在 note。要守的不变量是「reflect 只从人写 note / 市场数据结晶，绝不凭自己读草稿的品味」——确认接受。
7. **note kind 起步数量**：3 个还是直接 7 个？
8. **多季/二充点工程**：全延后到第一季验通？
9. **devSplit 首发开关**：先证环（单写手）还是先省钱（拆分）？

---

*本设计基于 dev-loop §0–§21a 现有原语改皮，唯一新代码是 `dramalint`。结构 DNA 取自 The Hidden Heir Takes Over / Alpha's Fated Bride 全本通读。*
