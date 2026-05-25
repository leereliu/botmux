# 跨部署联邦协作设计（Federation）

> 目标：让**独立的多套 botmux 部署**（同一飞书租户、各自单 owner）组成一个共享协作团队——
> 互相发现对方的 bot + 能力，并最终把跨部署的 bot 拉进同一个飞书群协作。
>
> 三方共识（申晗 / Claude / Codex）。本文是 [[platform-design]] 的跨部署扩展。

## 前提（已确认）

1. **同一飞书租户**：`union_id` 跨部署稳定、不同部署的 bot 能进同一个飞书群、能互相 @。
2. **网络可达**：spoke 能通过 HTTP 访问 hub（公司内网）。方向以 **spoke → hub** 为主，spoke 不需要对外暴露端口。
3. **一套部署 = 一个 owner = 一个团队成员**。单 daemon 单 owner，不存在多人共操作同一 dashboard，因此**跨部署不需要 /pair**——每个人在自己的 dashboard 里本就是已认证的 owner（dashboard token 即代表他）。

## 核心洞察

真正的协作发生在**飞书群**里：不同部署的 bot 本就能共处一个飞书群，botmux 已支持多 bot @（observed-bots 交叉引用）。
所以「跨部署」要解决的只有两件事：

- **发现**：看到彼此的 bot + 能力（聚合花名册）
- **建群**：把跨部署选中的 bot 拉进同一个飞书群（唯一的跨部署「写」）

## 拓扑：Hub + Spoke，各用各的 dashboard

- 每个人的 dashboard 仍然**只管自己本机的 daemon/bot**（localhost IPC 代理不变）——不把任何人的 daemon 暴露给别人。
- **Hub** = 建队的那套部署，持有团队 / 成员 / 聚合花名册。
- **Spoke** = 用邀请码加入某个 hub 团队的部署。
- 团队相关的数据走 hub 的联邦 API；各方在**自己的 dashboard**「团队」板块里读写。

```
  申晗 dashboard ──(本机IPC)── 申晗的 daemon/bot
       │
       │  /api/federation/*  (注册/同步/拉聚合花名册)
       ▼
  ┌─────────── Hub（申晗这套）持有 team + 联邦 bot ───────────┐
       ▲
       │  /api/federation/*  (spoke 主动 → hub)
       │
  别人 dashboard ──(本机IPC)── 别人的 daemon/bot
```

## 身份与信任

- **部署身份**：每套部署生成一次性 `deploymentId`（`{dataDir}/deployment-identity.json`，uuid）+ 一个可读 `name`（owner 自己填，默认机器名/owner 名）。
- **加入凭证**：复用现有**邀请码**（[[invite-store]]，单次/24h）。spoke 用邀请码向 hub 注册一次，hub 换发一个**长期 `syncToken`**（每 spoke 一个）用于后续同步/拉花名册。
- **信任边界仍是「团队」**：团队内互信，不做逐操作鉴权。邀请码=部署级准入；syncToken=该 spoke 的持续凭证。

## 数据模型

### Hub 侧：`federation-store.ts` → `{dataDir}/federations.json`
按 teamId 存已加入的远端部署：
```ts
interface FederatedDeployment {
  deploymentId: string;
  name: string;            // 展示用（owner/部署名）
  syncToken: string;       // 该 spoke 的持续凭证（高熵，不外泄）
  bots: FederatedBot[];    // 最近一次同步推上来的 bot
  joinedAt: number;
  lastSeenAt: number;      // 心跳
}
interface FederatedBot {
  larkAppId: string; botName: string; cliId: string;
  botUnionId?: string;     // 租户稳定，P2 拉群按此加 bot
  capability?: string; hasTeamRole?: boolean;
}
```

### Spoke 侧：`federation-membership-store.ts` → `{dataDir}/federation-memberships.json`
本部署加入了哪些远端团队：
```ts
interface RemoteMembership {
  hubUrl: string; teamId: string; teamName: string;
  syncToken: string; deploymentId: string; joinedAt: number;
}
```

## API

### Hub 侧（挂在 dashboard，**在 token 网关之前**，跨部署可达；用邀请码/syncToken 自鉴权）
- `POST /api/federation/join` — `{ inviteCode, deployment:{deploymentId,name,bots[]} }`
  → 校验并消费邀请码（→teamId）；记录该部署；换发 `syncToken`；回 `{ ok, teamId, teamName, syncToken }`。
- `POST /api/federation/sync` — `{ syncToken, bots[] }` → 刷新该部署 bot + `lastSeenAt`；回 `{ ok }`。
- `GET /api/federation/roster?syncToken=…` → 聚合花名册（hub 本地 bot + 各 spoke 的 bot，按部署分组），供 spoke 在自己 dashboard 展示。

### Spoke 侧（挂在 dashboard，**dashboard token 鉴权**，owner 操作）
- `POST /api/team/join-remote` — `{ hubUrl, inviteCode }`
  → 收集本机 bot（bots-info + 能力 + 尽力解析 botUnionId）→ 调 `hubUrl/api/federation/join` → 存 `RemoteMembership` → 回结果。
- `GET /api/team/remote-roster` → 对每个已加入的 hub 拉 `/api/federation/roster`，汇总展示。
- 周期同步：spoke 定时（dashboard 进程内 timer 或 daemon）向各 hub `POST /api/federation/sync` 推 bot + 心跳。

## 聚合花名册

Hub 的团队花名册 = 本地 bot（[[team-roster]]，按 bots.json 顺序）+ 各 spoke 的 `FederatedBot`，
每条带 `deployment: { id, name } | 'local'`，按部署分组展示（本地置顶，远端按 name）。

## 拉群（跨部署，P2）

加 bot 进飞书群必须由「控制该 bot 的 daemon」来做：
- **路 1（首选）**：同租户下建群 bot 用 **union_id** 直接把对方 bot 加进群——一步到位，不碰对方 daemon。
  ⚠️ **待验证**：飞书 `im/v1/chats/:chat_id/members` 是否支持 `member_id_type=union_id` 且能加「另一个 app 的 bot」成员。
- **路 2（回退）**：若飞书不允许跨 app 直接加，则 hub 把「加入群 X」挂成任务，**对方 dashboard/daemon 轮询**拉取后由它自己的 bot 加入（spoke 主动拉，无需对外暴露端口）。

## 分期

- **P1（本次）**：联邦基础——部署身份 + 邀请注册 + 同步/心跳 + 聚合花名册 + spoke 加入/拉花名册 API。先让大家「看到彼此的 bot」。
- **P2**：跨部署拉群（按上面两条路，先验证飞书 union_id 加 bot）。
- **P3**：跨部署共享 connector / 团队角色（按需）。

## 与现有代码的关系

- 复用：`invite-store`（邀请码）、`team-store`（团队/teamId）、`team-roster`（本地花名册）、`bot-profile-store`（能力）。
- 新增：`deployment-identity`、`federation-store`（hub）、`federation-membership-store`（spoke）、`dashboard/federation-api`（hub 端点）、`dashboard/team-routes` 增 spoke 端点。
- `/pair` + 单部署多用户那条线在联邦模型下非主路径；本次不删除，后续按需退役。
