# 剧集圣经 · <剧名>

> 治理文档（operator-publish-gated）：立项书 + 圣经合一。story-architect 起草，showrunner 发布。
> 机器只读结尾的 `gate-config` 围栏块；正文给人和 agent 读。填完每个 <…> 占位再发布。

## 立项书
- 题材：<genre>
- 平台：<ReelShort/DramaBox/红果…>
- 受众：<女频/男频 + 地区>
- 语言：<中/英/双语>
- 集数 × 时长：<N> 集 × <60–120>s
- 付费卡点：免费 <1–M>，卡点集 <ep>
- 核心卖点：<one line>
- 禁区：<涉政/血腥/未成年/价值观红线>

## Vision
- logline：<一句话梗概>
- 双供给配比：复仇打脸 : 甜宠 = <6 : 4>

## Goals
- 北极星：完播率（前几集定生死）+ 付费转化（卡点集）

## Non-goals
- 不降维拯救 · 不烂尾 · 不破人设 · 不写过渡集

## World rules
- <世界观硬规则 = 连戏的法律来源>

## 爽点配方
- 类型轮转：打脸 / 逆袭 / 身份反转 / 甜
- 密度目标：滚动窗口（<3> 集）≥<4> 个爽点；双供给（复仇/甜）两轴每 <3> 集都须命中
- 打脸四拍：反派嚣张 → 实锤 → 围观倒戈 → 主角淡然一句

## 钩子模板（集末三选一）
1. 新灾难砸反派（加密短信 / 新闻大屏 / 慌张报信下属）
2. 新人物入场（"The X has arrived!"）
3. 男主秘密被来电打断（跨集悬置）

## 契诃夫枪台账
- <G-ID>：<设定>。埋 ep<x> → 对观众 ep<y> 揭 → 对反派 ep<z> 爆 / 兑现。  <!-- 状态由 story-architect 维护 -->

## recurring devices
- 执行器副官状态汇报 · 围观歌队倒戈 · 即时通讯反转载体 · 信物双关首尾呼应 · 淡然金句收尾

## 付费卡点工程
- 卡点落在「好奇心负债最高点」；卡点集集末须硬切 cliffhanger。

## Decisions (running log)
- <date> — <方向决策>  <!-- dated, append-only -->

## 禁区红线
- 见立项书禁区。

```yaml gate-config
length_min: 60
length_max: 120
payoff_window_eps: 3
payoff_min_per_window: 4
double_supply_axes: [复仇, 甜]
double_supply_window_eps: 5
paywall_boundary_ep: 11
opening_protected_eps: [1, 2, 3, 4, 5, 6]
free_eps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
```
