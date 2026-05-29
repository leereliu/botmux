# 主动开工（Proactive Auto-Start）Brainstorm

## Background

botmux 当前是**完全被动**的：bot 只有在被 @mention（或 1:1 群里唯一人类）时才会拉起 CLI 会话。两个真实场景下用户希望 bot 能**主动开工**，省去每次手动 @：

1. **被拉进新群** —— bot 刚被加入一个群，期望它直接上手（读群上下文、自我介绍/开始干活），而不是干等第一条 @。
2. **话题群有新话题** —— 在话题群（topic 模式）里每开一个新话题，期望 bot 自动接入该话题，无需 @。

两者都必须能在 **dashboard 的 bot 配置页**按 bot 开关，默认关闭——避免影响现有被动行为和成本。

## Goals & End State

- **Goal**：让 bot 在「被拉进新群」和「话题群新话题」两种时机下，按 dashboard 配置主动拉起 CLI 会话。
- **End State**：
  - dashboard bot 配置页新增两个开关：`被拉进新群自动开工`、`话题群新话题自动开工`；前者附带一个可选的「预置 prompt」文本框。
  - 开关写入 `bots.json`（复用现有 card-prefs 原子写套路），热生效免重启。
  - 两个开关默认关闭；关闭时行为与现状完全一致。
  - daemon 新增对 `im.chat.member.bot.added_v1` 事件的订阅与处理。

## Key Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | 配置载体 | dashboard bot 配置页两个开关 + 场景①一个可选 prompt 文本框，落 `bots.json` | 复用现有 card-prefs / bot-defaults 套路，原子写、热生效 |
| D2 | 默认值 | 两个开关默认 **关闭** | 不改变现有被动行为，避免意外烧 token |
| D3 | 场景②（新话题）prompt | **不**单设 prompt 配置，沿用已有「默认角色」+ 用户首条消息作为 prompt | 默认角色已是系统级 prompt 注入，新话题首条消息天然是 user prompt，无需重复造 |
| D4 | 场景②触发范围 | 仅限**话题群（topic 模式）**；该群内任意新话题首条消息即触发（不限发起人） | 用户明确「不限定范围，但一定是话题群」 |
| D5 | 场景②实现钩子 | 在新话题路由的权限门（`checkGroupMessageAccess`/新话题 seed 判定）处：开关开启且为话题群新话题 seed 时免 @ 放行 | bot 已能收到群内全部消息（非 @ 走 ignore），只需放宽放行条件 |
| D6 | 场景①工作目录 | 用该 bot 的**默认工作目录**直接起会话；若该 bot 未配默认目录，则降级为先弹 repo 选择卡（不硬开工） | 用户选定；兼顾「直接开始」与无默认目录 bot 的安全降级 |
| D7 | 场景①触发条件 | bot 被加入群时，**群成员里存在至少一个该 bot 的 allowedUser** 即触发（不要求拉群操作者本人是 allowedUser） | 用户选定；防陌生人随意拉群刷成本，同时不卡正常拉群人 |
| D8 | 场景① prompt | 配了预置 prompt → 作为首轮 user_message；未配 → 以**空 user_message** 触发首轮，靠模型自行读群上下文（botmux-history 等） | 用户选定的最小干预方案 |
| D9 | 事件机制 | 新增订阅 `im.chat.member.bot.added_v1`（WSClient EventDispatcher 注册新 handler）+ daemon `handleBotAdded` | 当前完全无此事件处理，需新增 |

## Out of Scope

- 「被踢出群 / bot 被移除」事件处理（`bot.deleted`）——本次不做。
- 「用户被加入群」`user.added` 的欢迎逻辑——本次不做。
- 普通群（非话题群）的新消息自动开工——场景②仅限话题群；普通群仍走现有 @ / oncall 机制。
- 重复/灰度发版策略——按常规 master 发版，不在本设计内。

## Risks & Mitigations

- **Risk**：场景①需在飞书开发者后台**订阅 `im.chat.member.bot.added_v1` 事件**并开通对应权限（`im:chat` 读取群成员），这是代码外的控制台配置。Mitigation：实现里做能力自检/日志提示（参照现有 `REQUIRED_BOT_AT_SCOPE` 自检模式），缺权限时私信 admin。
- **Risk**：场景① 空 user_message 可能导致 CLI 首轮不启动或只发泛泛问候、不读群上下文。Mitigation：实现阶段验证；若空 prompt 无法可靠启动首轮，降级为注入一句极简种子（提示模型用 botmux-history 读群上下文），保持「靠模型自决」的语义。
- **Risk**：场景② 不限发起人 → 任意人开新话题都 spawn 会话，存在噪音/成本放大。Mitigation：开关默认关闭，由 owner 知情开启；后续若需要可加发起人白名单（留待后续 brainstorm）。
- **Risk**：场景① bot-added 事件可能短时重复（重复拉群/抖动）导致重复 spawn。Mitigation：按 chatId 去重（已有 activeSessions / 会话存在性判断可复用）。
- **Risk**：查询群成员判断 allowedUser 是否在群，增加一次 API 调用。Mitigation：复用现有 `getGroupStats`/成员拉取与缓存。
