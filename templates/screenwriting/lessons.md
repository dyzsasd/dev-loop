# lessons.md · <剧名>

> 复用 dev-loop 的 lessons.md（§14）。reflect 自动管理：从**人写的、已关闭的 script-note 工单**复发
> 结晶（≥3 集复现），无人 ack（信任边界在 note，不在 lesson）。人可查询、手改/删。写手起草每集前读自己那节。
> 每条 = 规则（写成 DO）+ Why + How to apply + added/last-seen + 证据(工单 id)；范例是链接不内联。预算 ≤~6/节。

## Shared

## story-architect

## screenwriter
<!-- 例：
- 每个打脸走满四拍：反派嚣张 → 实锤 → **围观倒戈** → 主角淡然一句；倒戈拍最常被略过。
  - Why: 倒戈把情绪外包给路人，主角只需"淡然一句"就显高级。
  - How: 反派崩溃前插 ≥2 行群体转向，守 length_sec。
  - 范例: examples/series-hidden-heir/episodes/ep0003.md (3-1 全员鞠躬)
  - added: <date> · last-seen: <date> · 证据: <note ids>
-->

## screenplay-editor

## Reflect
<!-- reflect 重定向规则（必留）：reflect-agent 的 lessons 落点是写死的代码角色枚举，不认识本项目。
     这条规则 reflect 每 fire 都会读并应用，把它的结晶导向正确的小节。若被 §14 expire 阀裁掉（note 静默 >2 周），按 runbook 重新 seed。 -->
- 规则：本项目是剧本创作 loop，真正运行的写作 agent 是 screenwriter / story-architect；showrunner 的反馈 = 已关闭的 `note:*` Improvement 工单（owner=`pm`）。某 `note:*` 主题在窗口内复发 ≥2 次时，按 §14 形态（原则 + Why + How to apply）结晶到 `## screenwriter` 或 `## story-architect`（取决纠正哪一档），**不要**写进 `## PM`。
  - Why：写作 agent 只读各自同名小节，落到 `## PM` 它们永远读不到，结晶流会断。
  - How to apply：Job1 把已关闭 `note:*` 按主题聚类当复发信号；Job2 ADD 落点改用这两个小节。
  - added: 2026-06-30 · last-seen: 2026-06-30
