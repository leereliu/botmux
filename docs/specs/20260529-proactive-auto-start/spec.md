# 主动开工（Proactive Auto-Start）Spec

## Overview

为 botmux 增加两种「主动开工」能力，均可在 dashboard bot 配置页按 bot 开关、默认关闭：

1. **被拉进新群自动开工**：bot 被加入一个群且群内存在至少一个该 bot 的 allowedUser 时，自动拉起一个 CLI 会话（工作目录取 bot 默认目录；没配则降级弹 repo 选择卡）。支持可选的预置 prompt；未配则以空 user_message 触发首轮，靠模型自读群上下文。
2. **话题群新话题自动开工**：在话题群（topic 模式）里，任意人开启的新话题首条消息无需 @ 即自动拉起会话；沿用已有「默认角色」prompt + 用户首条消息，不另设 prompt。

关闭开关时，行为与现状完全一致（仍需 @mention / oncall 才触发）。

## User Stories

### Story 1：被拉进新群，bot 主动开工
- **Acceptance**：在 dashboard 为某 bot 开启「被拉进新群自动开工」后，把该 bot 拉进一个含 allowedUser 成员的新群 → daemon 收到 `im.chat.member.bot.added_v1` → 自动 spawn 一个会话；若配置了预置 prompt，则首轮以该 prompt 启动，否则以空 user_message 启动。把该 bot 拉进一个**不含**任何 allowedUser 的群 → 不 spawn。开关关闭时 → 任何拉群都不 spawn。
- **Technical implementation**：
  - `src/im/lark/event-dispatcher.ts` — `EventDispatcher.register({...})` 新增 `im.chat.member.bot.added_v1` 回调；`EventHandlers` 接口新增 `handleBotAdded`。
  - `src/daemon.ts` — 新增 `handleBotAdded(chatId, operatorId, larkAppId)`：校验开关 → 查群成员判断 allowedUser 是否在群 → 解析工作目录 → 创建 session + `forkWorker`（或在无默认目录时走 repo 选择卡分支）。
  - 群成员判定复用 `src/im/lark/`（`getGroupStats` 同源的成员拉取）。
  - 工作目录解析复用 bot 默认目录逻辑（`getSessionWorkingDir` / `defaultWorkingDir`）。

### Story 2：话题群新话题，bot 自动接入
- **Acceptance**：在 dashboard 为某 bot 开启「话题群新话题自动开工」后，在一个**话题群**里开启新话题（首条消息，未 @bot）→ 自动 spawn 该话题的会话，prompt = 用户首条消息（叠加已有默认角色）。在**普通群**里发新消息（未 @）→ 不 spawn。开关关闭 → 话题群新话题未 @ 时不 spawn（维持现状）。
- **Technical implementation**：
  - `src/im/lark/event-dispatcher.ts` — 在新话题 seed 判定 + 权限门处（`checkGroupMessageAccess` 调用点附近，event-dispatcher 约 line 564 / 966）：当开关开启、`decideRouting` 判为话题群 thread seed（topic 模式、首条）时，免 @ 放行交给 `handleNewTopic`。
  - 复用现有 `getChatMode`（区分 topic / group）与 `decideRouting`。

### Story 3：dashboard 配置两个开关 + 场景①预置 prompt
- **Acceptance**：dashboard bot 配置页出现两个开关：`被拉进新群自动开工`（含一个预置 prompt 文本框）、`话题群新话题自动开工`。修改后 PUT 写入 `bots.json` 并热生效（无需重启 daemon），刷新页面后状态保持。
- **Technical implementation**：
  - `src/bot-registry.ts` — `BotConfig` 接口新增 `autoStartOnGroupJoin?: boolean`、`autoStartOnGroupJoinPrompt?: string`、`autoStartOnNewTopic?: boolean`；`parseBotConfigsFromText()` 解析。
  - `src/services/card-prefs-store.ts` — `BotCardPrefs` + `getBotCardPrefs` + `updateBotCardPrefs` 纳入三个新字段。
  - `src/core/dashboard-ipc-server.ts` — `GET /api/bot-default-oncall` 返回新字段；`PUT /api/bot-card-prefs` 透传（已是通用 partial PATCH）。
  - `src/dashboard.ts` — `/api/bots` 汇总返回 + 透传 PUT。
  - `src/dashboard/web/bot-defaults.ts` — 新增勾选框 + prompt 文本框 + change 事件 → `putCardPref`。
  - `src/i18n/zh.ts` / `en.ts` — 新增文案 key。

### Story 4：缺权限自检与提示
- **Acceptance**：daemon 启动时若检测到 `im.chat.member.bot.added_v1` 所需权限/事件未开通（且至少一个 bot 开启了场景①），向该 bot 的 admin 私信提示需在飞书后台订阅事件并开权限；不崩溃、其余功能正常。
- **Technical implementation**：参照现有 `REQUIRED_BOT_AT_SCOPE` 自检模式（event-dispatcher.ts line 100-180），扩展或新增一条 scope/事件检查 + `dmAdmin` 提示。

## Functional Requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| FR-1 | 当 `autoStartOnGroupJoin` 开启、且 bot 被加入的群成员中存在至少一个该 bot 的 allowedUser 时，系统必须自动 spawn 一个会话。 | 单测：模拟 `bot.added_v1` 事件 + mock 群成员含 allowedUser → 断言调用 `forkWorker`/创建 session。 |
| FR-2 | 当 `autoStartOnGroupJoin` 开启、但群成员中**不含**任何该 bot 的 allowedUser 时，系统不得 spawn 会话。 | 单测：mock 群成员不含 allowedUser → 断言不创建 session。 |
| FR-3 | 当 `autoStartOnGroupJoin` 关闭时，收到 `bot.added_v1` 事件不得 spawn 会话。 | 单测：开关关 → 断言事件被忽略。 |
| FR-4 | 场景①触发时，工作目录取 bot 默认工作目录；若 bot 未配默认目录，则不直接 spawn，而是走 repo 选择卡流程（与现有新话题无 pinnedDir 行为一致）。 | 单测：配默认目录 → 直接 fork；无默认目录 → 进入 `pendingRepo` 卡分支。 |
| FR-5 | 场景①触发时，若配置了 `autoStartOnGroupJoinPrompt`，首轮 prompt 必须为该文本；否则首轮以空 user_message 触发。 | 单测：配 prompt → 断言 prompt 透传；未配 → 断言空 prompt 路径（含 FR-11 的降级口径）。 |
| FR-6 | 当 `autoStartOnNewTopic` 开启、消息被 `decideRouting` 判为话题群（topic 模式）新话题 seed 时，即使未 @bot，系统也必须放行进入 `handleNewTopic`。 | 单测：mock topic 群 + 新话题 seed + 未 @ + 开关开 → 断言 access 放行 / 走 handleNewTopic。 |
| FR-7 | 当 `autoStartOnNewTopic` 开启但群为**普通群**（非 topic）时，未 @ 的新消息不得因本特性被放行。 | 单测：mock 普通群 + 未 @ + 开关开 → 断言仍 ignore。 |
| FR-8 | 当 `autoStartOnNewTopic` 关闭时，话题群新话题未 @ 时不得被放行（维持现状）。 | 单测：topic 群 + 新话题 + 未 @ + 开关关 → 断言 ignore。 |
| FR-9 | dashboard 对三个新字段（两开关 + 场景①prompt）的 PUT 必须原子写入 `bots.json` 并即时同步内存 `bot.config`（热生效，无需重启）。 | 单测：调用 `updateBotCardPrefs` patch 新字段 → 断言落盘 + `getBot().config` 同步更新。 |
| FR-10 | dashboard `GET /api/bots`（及 IPC `GET /api/bot-default-oncall`）必须回显三个新字段的当前值。 | 单测/手测：GET 返回体含新字段。 |
| FR-11 | 当场景①以空 user_message 启动会导致 CLI 首轮无法可靠启动时，系统必须降级为注入一句极简种子 prompt（提示模型用 botmux-history 读群上下文），且该降级仅在空 prompt 路径生效。 | 实现阶段在 worker/adapter 验证空 prompt 行为；据结果固化「空串」或「极简种子」并补单测。 |
| FR-12 | 当至少一个 bot 开启场景①、而飞书后台未订阅 `bot.added_v1` 事件/缺群成员读取权限时，daemon 必须不崩溃并向 admin 私信提示。 | 手测/单测：mock 自检失败 → 断言 `dmAdmin` 被调用且 daemon 继续运行。 |
| FR-13 | 同一个 chatId 的 `bot.added_v1` 在短时间内重复到达时，不得重复 spawn（按已存在会话/活动会话去重）。 | 单测：连发两次同 chatId 事件 → 断言只创建一个 session。 |

## Success Criteria
1. 开启场景①后，把 bot 拉进含 allowedUser 的新群即可零 @ 自动起会话；拉进无 allowedUser 的群不起。
2. 开启场景②后，话题群里每个新话题首条消息零 @ 自动起会话；普通群不受影响。
3. 两个开关均可在 dashboard 即时开关、热生效，默认关闭时行为与现状完全一致。
4. 场景①支持预置 prompt，未配时以空（或降级极简种子）启动且模型能读到群上下文。
5. 缺事件订阅/权限时 daemon 不崩溃且能主动提示 admin 去开通。
6. 全部新增逻辑有单测覆盖，`pnpm build` 通过。

## Key Entities
- `BotConfig`：bot 级配置，新增三字段；`src/bot-registry.ts`。
- `BotCardPrefs` / card-prefs-store：开关/prompt 的读写与原子持久化；`src/services/card-prefs-store.ts`。
- `EventHandlers` / event-dispatcher：飞书事件注册与放行门；`src/im/lark/event-dispatcher.ts`。
- `handleBotAdded` / `handleNewTopic`：会话创建编排；`src/daemon.ts`。
- bot-defaults 页：dashboard 配置 UI；`src/dashboard/web/bot-defaults.ts`。

## Assumptions
- bot 已具备接收群内非 @ 消息的能力（现状：非 @ 消息走 `checkGroupMessageAccess` 的 ignore 分支，说明已能收到）——场景②据此成立。
- allowedUser 以 open_id 形式可解析（`resolvedAllowedUsers`），可与群成员列表求交集。
- 飞书提供按 chatId 拉取群成员的 API，且与现有 `getGroupStats` 同源可复用。
- 场景①的事件订阅与权限需用户在飞书开发者后台开通（代码外前置）。

## Clarifications
- Q：场景②是否需要独立 prompt？A：否，沿用已有「默认角色」+用户首条消息。
- Q：场景①触发条件？A：群里存在至少一个 allowedUser 即可，不要求拉群操作者本人是 allowedUser。
- Q：场景①无默认目录怎么办？A：降级为弹 repo 选择卡，不硬开工。
- Q：场景①无预置 prompt 怎么办？A：以空 user_message 触发，靠模型自读群；若空 prompt 不可行则降级极简种子（FR-11）。

## Out of Scope
- `bot.deleted` / 被踢出群、`user.added` 用户入群欢迎逻辑。
- 普通群（非话题群）新消息自动开工。
- 场景②的发起人白名单（当前不限发起人，后续如需再开 brainstorm）。
- 发版/灰度策略，按常规 master 流程。
