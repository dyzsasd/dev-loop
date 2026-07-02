# dev-loop 全库审计 + 短剧 loop 改进路线图（2026-07）

> 方法：8-agent 审计——4 个并行读者（hub 架构 / 宪法+SKILL 体系 / git 演进史 / 短剧变体现状）→ 3 个改进视角（制片人-留存 / 系统-机制复用 / 首次活跑对抗推演）→ 综合去重。★ = 独立收敛的视角数（3/3 为最强信号）。

---

## 一、这个代码库是什么

一台**以工单状态机为唯一协调总线的自治多 agent 生产线**：PM/QA/Dev（或 senior/junior 分层）/Sweep/Reflect 内向 + Ops/Architect/Communication 外向，互相只通过票据状态交接（conventions.md §1）；每次 fire 全新会话，状态只信 backend/git/磁盘（§0）。宪法 conventions.md（2167 行，§0–§26）压倒一切 SKILL，规则几乎全部由实战失败反推固化。

**五层架构（hub/src）**：
- **L0 SoR**：node:sqlite + WAL 单文件 `~/.dev-loop/hub.db`；tickets/comments/**events（追加式审计账本）**/documents（版本化，design 类多实例）/channels/mirror_map；8 态状态机单源生成 CHECK（db.ts:29-33）。
- **L1 策略层**：23 工具 22 op 唯一定义在 agentops.ts，stdio 与 daemon 双传输共用 agentOp() 且有差分奇偶测试防漂移；写路径归口 ticketwrite.updateTicketRow，内嵌 **DL-77 verify 门（In Progress→Done 无条件拒绝，Done 必须经 In Review 由 owner 验收，ticketwrite.ts:82-86）**——MCP 与网页共用一个咽喉。
- **L2 传输**：stdio server.ts（身份 G1/幽灵项目 G2 门）、shim 瘦客户端、daemon op-API（默认休眠）。
- **L3 daemon**：127.0.0.1-only SSR 看板/roadmap/activity/reports；读连接 query_only 结构只读；Human-Blocked 提醒、无进展断路器、WAL checkpoint 定时器。
- **L4 调度器 run-agents.ts**：自持节奏 shell 出 `claude -p`/`codex exec`，MCP 内联注入，每 fire 带 DEVLOOP_ACTOR；**agentFamily 重映射（:375-386）是编剧变体唯一 hub 侧钩子**——只换 SKILL 正文，actor 身份/assignee 路由/split 检测原样不动。

**核心赌注**：① 票据状态机 + 确定性门（build/test 或 dramalint）+ 人类验收咽喉（DL-77），足以把任意「设计→实现→检验」生产线跑成自治环——编剧是第一个非代码 agentFamily，零新 actor，唯一新代码是 227 行 dramalint；② 品味裁决权**结构性**留给人（operator 唯一发布权威 docstore.ts:90；编剧环 pm 位由人类 showrunner 亲任）；③ 自进化走 §17 亮线（Reflect 只可自主改 lessons.md，其余提案制）。已知治理软肋：**DEVLOOP_ACTOR 缺省静默回退 operator**（resolve-project.ts:54），漏配即获发布/晋升权。

## 二、17 天 248 commit 的六段演进弧

全部历史 2026-06-14→07-01，双峰 52 commit/天。CHANGELOG 自述：规则多来自 live-loop 实战失败——观察到失败→固化成门。

1. **弧一（06-14~16）Linear 插件起点**：首提交 825 行纯 markdown。48 小时 9 个补丁全是实战翻车（查询漏 project 作用域、Dev 声称拆分却从不建票）。
2. **弧二（06-17~20）借鉴 jinko-brain + 扩编**：autonomy-first 移植；Sweep（owner 标签缺失票永久搁浅）、Reflect、本地板、外向三 agent；事故 CIT-562 催生 webhook 通知。
3. **弧三（06-22~23）hub 自建 SoR**：核心动机是 Linear 给不了的**逐 agent 身份**；跨模型对抗评审抓出 3 个 HIGH 并全修。
4. **弧四（06-23~29）dogfood 自举 + npm 独立化**：loop 在 hub 上开发自己（98 票 95 Done）；从 Claude 插件重定位为 standalone daemon+多 CLI；敢做减法（删 Director+讨论板 净-921 行——「多 agent 审议实为单模型角色扮演」）。
5. **弧五（06-27）split-dev 双层**：**上线即翻车**——两个新 agent 靠历史*推断* split 状态而静默 no-op ~100min；修复原则「唯一权威 devSplit:true，agent 永不推断；空 slice 是正常空转」。这是编剧变体最该记住的前车之鉴。
6. **弧六（06-30~07-01）竖屏短剧变体**：一天四连发（dramalint→三 craft SKILL→agentFamily→交互 init）。三条历史矢量：插件→免插件 CLI/daemon；持续减法+成本分层；从软件泛化到任意「设计→实现→检验」生产线。

## 三、短剧变体的诚实现状

- **已建且机器验证（薄层，全是确定性代码）**：dramalint 自检+样例实跑 exit 0、已挂 npm test；init-screenplay 幂等自检过；agentFamily 路由有 dry-run 回归测试锁定。
- **仅是写出来的（零机器验证）**：4 个 SKILL **一次真 fire 都没跑过**；整条工单编舞（season-design→staged 子票→人促 Todo→写集→In Review→editor→人 Done）在任何后端都没跑过一次；NPE/market-oracle/复发聚类零实现。
- **已确认的活跑阻断（代码级实证）**：见下表 P0 全部六项。
- **信任面弱于 spec 声称**：四硬门里两个靠自报字段（length_sec、characters），grid.csv 完全不被 lint 读——「三层对账」缺一层；spec 的嵌套 gate-config 会让扁平解析器**静默跳过全部门**。

**结论：确定性外壳是真的，人机交接的每个关节还是纸上的；离能跑一次活闭环差 3-4 个小修，没有一个是结构性返工。**

## 四、改进路线图

### P0 —— 首次活跑前必修（第一天就断级别）

| # | 问题 | 提案 | 成本 | 收敛 |
|---|------|------|------|------|
| 1 | **dramalint H4 增量死锁**：卡点=ep11 时 ep1-10 期间每次 lint 必红且编剧修不了 → fix-exhausted 死循环（dramalint.mjs:114-116；样例靠卡点=3 侥幸掩盖） | lintSeason 仅当 `max(ep) ≥ paywall_boundary_ep` 才硬查卡点；未写到降 info。--self-check 加断言。~5 行 | S | ★★★ |
| 2 | **编程 pm-agent 会篡夺人类品味门**：FAMILY_SKILLS 不含 pm，默认 core 组含 pm@5m → 不带 --agents 跑会让机器验收集稿标 Done | agentFamily=screenwriting 时剔除 pm 并打日志；显式 --agents pm 则 die。+1 条 dry-run 测试。~10 行 | S | ★★★ |
| 3 | **showrunner 的门开箱不可用**：humanWrite 默认关且无 CLI 可开（daemon.ts:206-216）、Web 建票 labels:[] 对全部 agent 不可见（ticketwrite.ts:148）、看板无标签编辑而 note:*/must-fix 全是标签操作——**反馈棘轮的心脏没接血管** | init-screenplay 对 service seed humanWrite.enabled=true；Web 建票默认带 dev-loop+owner 标签；票详情页加白名单标签 checkbox（走既有咽喉，DL-38/77 自动生效） | M | ★★★ |
| 4 | **Claude 路径 fire 无权限旗标**：非交互写 episodes/epNNNN.md 会被拒；codex 路径反而零沙箱，文档零提及 | claude 分支加 `--permission-mode acceptEdits`（+--add-dir）；dry-run 测试锁定；文档补两种 CLI 权限模型对照 | S | ★ |
| 5 | **占位符 bible 不 block**：刚 scaffold 的 bible 满是 `<…>` 但可读 → story-architect 可能对 `<TODO>` 设计第一弧派 17 张子票；service docs 配置三方互斥 | 确定性判据：bible 含未替换占位符即 BLOCK info-needed；readiness 加检查；Tier-0 统一 repo-file bible，修齐三处文档 | S | ★★★ |
| 6 | **整条编舞零真 fire** + `--max-fires` 的 stop() 对活跃子进程发 SIGINT，最后一发被打断产出半截集（run-agents.ts:543-549） | 先修 stop() 为真 drain；再跑 15-20 集**彩排季**（service 后端全 junior 档）：含一次设计门提升、一次 taste-fail supersede、一次 lint 硬失败 re-queue | M | ★ + spec 自认 |

### P1 —— 首季跑起来后立刻要的（棘轮与兜底）

| # | 问题 | 提案 | 成本 | 收敛 |
|---|------|------|------|------|
| 7 | pm 位=人却**无任何 ping**，showrunner 缺席数日整环静默停摆 | init-screenplay 照抄 coding init 的 channel_register 访谈；daemon 提醒附带 In Review+needs-showrunner 票数（同一去重账本 ~20 行） | M | ★★ |
| 8 | **note→lesson 棘轮收口悬空**：reflect 不认识 note:*，section 白名单硬编码编码环节名（reflect SKILL:176），阈值 spec=3 vs seed=2 矛盾 | reflect 加编剧证据体（只从人写已关闭 note:* 聚类结晶）；section 以 lessons.md 实存节为准；统一阈值；彩排季投喂 3 张假 note 验证 | M | ★★★ |
| 9 | 两硬门靠**自报字段**，正文不解析；lint 不读 grid | 纯规则反作弊：正文 `角色：` 说话人对账入硬门；已写 ep 必须有 grid 行（不一致先 warn）；台词字数估时长（偏差>30% 仅 warn）；修 CSV 引号 | M | ★★ |
| 10 | spec 的嵌套 gate-config → 扁平解析器**静默全跳过所有门**（假绿灯） | 检测到缩进子键即 FAIL「必须扁平键」；spec 示例改一致 | S | ★ |
| 11 | 设计门 pass 后**子票提升全靠人逐票手工**（编码环由 PM-agent 做），漏一票 junior 静默饿死 | sweep 加一条编剧 Job：Backlog 且父票已 Done → 批量促 Todo（纯机械不碰品味） | S | ★★ |
| 12 | senior 默认 5m 一发 opus/max = 一天 288 发，多数空转重读同一 bible；**成本引擎** | runbook 统一推荐节奏（senior 30m-1h / junior 15m / qa 15-30m）；projects.json 加 intervals 覆盖（~15 行+测试） | S | ★★ |
| 13 | 整个变体在长寿分支上，main 持续发版拿不到；分支内已有文档/命令漂移 | 修漂移（打印命令、非原子写→tmp+rename、spec §8）后 rebase 合回 main（agentFamily 缺省为空即零侵入） | M | ★★ |
| 14 | 编舞跨 DL-77/DL-24/Backlog-staging 三道门却**零测试**；上次 split 上线就是未演练编舞停摆 100min | 新增 hub/test/screenwriting-board.ts：不动 LLM，多 actor 调 agentOp 模拟全编舞并断言每步状态/门拒绝 | M | ★ |
| 15 | screenwriter 孤儿判据=「文件存在」→ 崩掉的 fire 留下 lint 红半截稿可能直接交 In Review | SKILL 一句话：artifact 判据 = dramalint 绿 AND 已 commit | S | ★ |

### P2 —— 首季数据/摩擦出现后再付费

| # | 提案 | 成本 |
|---|------|------|
| 16 | daemon 加 /review 视图：In Review 按弧分组、内联 lint+editor 摘取、整弧批量促票（**等彩排季实测摩擦再建**） | M |
| 17 | 付费卡点集划入保护通道：senior 交付 ≥3 个候选 hook_out 随 In Review 给人**选**（LLM 不排序不推荐） | S |
| 18 | screenwriter retry 梯加 codex rescue 一试（产物仍过 dramalint+人门，无机器 verdict） | S |
| 19 | market-oracle 最小落地：人从平台后台导出 retention.csv → reflect 读它，完播断崖集自动立 `note:platform-performance`。**不做 API 不做 ops 皮套** | M |

### 排序理由
P0 六项全部是「第一次活跑第一天就断」级别，其中 #1/#2/#3/#5 三视角独立收敛（最强信号）；#6 彩排是其余一切验证的前置门。P1 是棘轮闭环（#7 通知、#8 reflect）与机械兜底（#11 sweep、#15 孤儿）——正是编码环 17 天历史里每次翻车后补的同类门。P2 全部遵守「真实疼痛出现再付费」。

## 五、明确不要建的（反建议）

1. **任何 LLM 质量评分/排序/推荐**——违反「人是唯一品味 oracle」；editor 的 extraction-not-verdict 是刻意设计，不是缺口。
2. **dramalint warn 自动晋升硬门 / 参与 auto-pass**——lint-promotion 必须走 §17 提案+人裁；时长估算做硬门也不行（估算有噪声，硬门必须不可争辩）。
3. **为编剧建新 actor/新表/新 agent**——全部有现成载体；零新 actor 是这个变体最干净的设计决定。
4. **给 pm 位造代理人自动验收**——正确解法是通知+批量视图降低人的成本，不是替换人。
5. **自动化前 6 集生成通道**——opening:protected 是人主导保护区；自动 A/B 评测是 hit-machine 幻觉。
6. **换顶级模型做剧本 review**——editor 故意用非顶配防 fluency bias，换 opus 是反向优化。
7. **多语/出海管线**——第一部真出海剧的疼痛出现前连约定文档都不用写。
8. **NPE 仪表盘/市场数据 API 对接**——P2#19 的一个 CSV 就是全部该付的成本。
9. **hub docs 承载 bible（Tier-0）**——repo-file+占位符判据够用，现在开只增加配置矛盾。
10. **看板 SPA 化**——SSR+POST 已覆盖全部写路径且被门保护；/review 也应同风格。
11. **channel 双向/mirror 默认接入编剧项目**——纯闲置。
12. **为 DEVLOOP_ACTOR 回退建认证体系**——单机信任模型下是为不存在的威胁付费；正确成本是 identity-check --expect 进 readiness 清单一行。
