# 不夜港：最后一班船

一个由服务器担任唯一裁判、支持多个 AI Agent 通过 MCP 共同游玩的三人公开货运市场策略游戏。

核心原则是：**公开事实，隐藏动机。** 货运市场、余额、库存、航运委托、行动顺序和日志全部公开；唯一对其他玩家隐藏的信息是每个席位自行选择的隐藏成就。

当前版本完成了：

- 配置化的 6 种港口货物、18 张固定航运委托、12 张价格事件与 10 个隐藏成就；
- 三轮完整规则引擎、跨轮价格、轮内缺格补货、换轮整盘刷新；
- AI-only 建房、三席入座、创建者开局与私有席位令牌；
- 带乐观并发控制的 `stateVersion`；
- 海关查验货的下一轮首购权与第三轮紧急核销券；
- 服务器持久化快照与完整事件日志；
- 9 个 MCP 工具；
- 单一 authoritative `GameStore`、Streamable HTTP MCP 与无状态 STDIO 代理；
- 本地只读观战页面；
- 22 项自动化规则测试、双客户端并发集成测试和一条真实 MCP 烟测。

## 快速开始

要求 Node.js 20 或以上。

```powershell
pnpm install
pnpm test
pnpm start
```

`pnpm start` 启动唯一权威服务。它在同一个进程中持有唯一可写 `GameStore`，并同时提供：

- Streamable HTTP MCP：`http://127.0.0.1:3188/mcp`
- 观战页面与只读 Web API：`http://127.0.0.1:3188/`

不要为不同玩家分别启动权威服务；多个客户端必须指向同一个 `/mcp`。

### 观战页面

浏览器打开：

```text
http://127.0.0.1:3188/
```

服务默认只绑定 `127.0.0.1`。如需改端口，可设置：

```powershell
$env:NIGHT_PORT_PORT = "3189"
pnpm start
```

生成一局用于查看布局的本地样例：

```powershell
pnpm demo:seed
```

样例存档名为 `night-port-demo`。它只用于本地观战页，不包含在版本控制中。

## MCP 工具

| 工具 | 类型 | 用途 |
|---|---|---|
| `create_game` | 写 | 仅 AI 创建房间并自动占据首席；返回私有 `playerToken` |
| `join_game` | 写 | AI、真人或混合控制席位加入房间 |
| `start_game` | 写 | 仅创建房间的 AI 在三席满员后开局 |
| `choose_achievement` | 写 | 从本席位的 3 个候选中秘密锁定 1 个 |
| `game_state` | 读 | 返回完整公开状态、简要摘要和当前合法操作范围 |
| `private_state` | 私有读 | 只凭正确 `playerToken` 返回本席位隐藏信息 |
| `take_turn` | 写 | 原子提交 0–3 个货运市场位置、普通核销和可选紧急第二核销 |
| `vote_carryover` | 写 | 货运市场满盘三方 Pass 后对未完成航运委托进行一致结转投票 |
| `game_log` | 读 | 分页读取完整公开裁定日志 |

所有写工具（创建房间除外）都要求调用方提交最新的 `expectedStateVersion`。版本不匹配时，服务器返回 `STATE_VERSION_CONFLICT`、当前版本和最新合法操作范围，且不会产生任何部分写入。

### 一个行动如何表达

`take_turn` 是原子操作，不存在“买到一半被另一位玩家抢单”的中间状态。

购买两格并核销一单：

```json
{
  "gameId": "game-1",
  "playerId": "guild-a",
  "playerToken": "该席位创建或加入时获得的私有令牌",
  "expectedStateVersion": 12,
  "marketPositions": [4, 11],
  "orderId": "7"
}
```

**0 购买直接核销已有库存**：

```json
{
  "gameId": "game-1",
  "playerId": "guild-a",
  "playerToken": "该席位私有令牌",
  "expectedStateVersion": 13,
  "marketPositions": [],
  "orderId": "3"
}
```

这属于有效行动，不会进入停手链。

真正的 Pass：

```json
{
  "gameId": "game-1",
  "playerId": "guild-a",
  "playerToken": "该席位私有令牌",
  "expectedStateVersion": 14,
  "marketPositions": []
}
```

## 接入 Codex / ChatGPT

先运行 `pnpm start`。ChatGPT 使用权威服务的 Streamable HTTP `/mcp`，Codex 可以直接使用同一 URL，也可以保留原有 STDIO 启动方式。STDIO 进程现在只是协议代理：它没有 `GameStore`，所有工具调用都会转发到 `NIGHT_PORT_MCP_URL`。

远程 ChatGPT 连接要求该 Streamable HTTP MCP endpoint 对 ChatGPT 可达；本机 `127.0.0.1` 只适合本机客户端，远程使用时应通过受控 HTTPS 入口或 Secure MCP Tunnel 暴露同一个权威进程。官方说明见 [OpenAI MCP and Connectors documentation](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)。

Codex 的本地 STDIO 代理配置如下：

```toml
[mcp_servers.night_port]
command = "C:\\Users\\jclra\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe"
args = ["--import", "tsx", "C:\\Users\\jclra\\Documents\\Codex\\2026-08-26\\chat\\src\\mcp-server.ts"]
cwd = "C:\\Users\\jclra\\Documents\\Codex\\2026-08-26\\chat"
required = true
default_tools_approval_mode = "writes"

[mcp_servers.night_port.env]
NIGHT_PORT_MCP_URL = "http://127.0.0.1:3188/mcp"
```

ChatGPT 与 Codex 各自使用自己加入席位时返回的 `playerToken`。服务器按 `playerId + playerToken` 验证 `private_state`；不能用一方 token 读取另一方隐藏成就。保存 Codex 配置后重启客户端，再用 `/mcp` 查看连接状态。这里没有自动修改全局配置，避免连带改动用户已有的 MCP 设置。

## 规则实现说明

### 货运市场与轮次

- 每轮开始重新生成 18 个货运市场格，并随机指定其中 1 格为海关查验货；
- 同一轮内只填补空格，未被购买的格完全保持原样；
- 轮内货运市场全部售空时立即补满普通货，不再生成第二件海关查验货；
- 玩家库存跨行动、跨轮保留；
- 三方连续 Pass 且货运市场有空格时，只补空格，由停手链第一位先行动；
- 三方连续 Pass 且货运市场满格时，第一、二轮进入一致结转表决，第三轮直接终局。

### 价格与航运委托

- 冷链货（海产、鲜花、热带果）基础价格 4，常温货（茶叶、香料、木料）基础价格 2；
- 每轮抽取两张不同事件；不同轮之间允许事件重复；
- 价格在上一轮结果上累积，限制在 1–8；
- 18 张航运委托开局洗牌，三轮各引入 6 张，因此新委托不重复；
- 遗留航运委托原酬劳结转，不自动增值，也暂不限制遗留数量；
- 同一张航运委托只能被一个席位核销。

### 海关查验货与终局

- 第一、二轮的海关查验货正常扣款但不进普通库存，购买者获得下一轮首购权；
- 第三轮的海关查验货改为紧急核销券；
- 紧急券只有在三名玩家都完成至少一次第三轮行动后才能使用；
- 紧急券必须附着在一次正常核销之后，额外核销第二张航运委托；
- 第三轮每个席位默认拥有 **4 次**行动机会，值在 `src/config.ts` 中配置；
- 最终死库存不退款，也不再次扣采购成本。

### 隐藏成就与现金隔离

- 开局每个席位随机获得 3 个候选并秘密选择 1 个；
- 公开状态、公开日志和观战 Web API 都不返回候选或已选成就；
- 私有状态要求匹配 `playerId + playerToken`；
- 成就达成奖励统一为 3 分，只加入终局 `finalScore`；
- 成就奖励不进入实时 `cash`，因此不能改变局中购买能力。

### 确定性细节

库存中存在多件同类货、但购入轮次不同时，核销会优先消耗库存数组中较早的匹配项。当前引擎按购入顺序追加库存，因此这等价于“同类货先进先出”，使跨轮成就的判定可重复、可测试。

随机结果使用可持久化的 seed 与随机数状态。每次成功写操作后，快照会写入：

```text
data/games/<gameId>.json
```

服务重启后会从快照继续，而不是要求 Agent 从聊天历史重建状态。

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm smoke:mcp
```

规则测试覆盖至少以下门槛：

1. 轮内缺 3 补 3，原 15 格不变；
2. 新轮整盘刷新、玩家库存保留；
3. 0 购买直接核销合法且不算 Pass；
4. 0 购买、0 核销才算 Pass；
5. 有效操作重置停手链；
6. 第一、二轮海关查验货授予首购权；
7. 第三轮海关查验货授予紧急券；
8. 紧急券的全员首动解锁门槛；
9. 已核销航运委托不能重复核销；
10. 遗留航运委托不涨酬劳；
11. 价格跨轮累积并执行上下限；
12. 死库存不退款；
13. 公开接口不泄露隐藏成就；
14. 终局不重复扣库存成本；
15. 成就奖励与实时现金隔离；
16. 真人/混合控制者不能建房；
17. AI 创建者自动占席且令牌不公开；
18. 非创建者无 start 权限；
19. 三席未满不能 start；
20. 过期 `stateVersion` 写入冲突；
21. 非法操作包含失败原因、最新版本与合法范围；
22. 第三轮默认 4 次行动且保持配置化。

## 项目结构

```text
src/config.ts        固定经济配置
src/engine.ts        唯一裁判与状态机
src/store.ts         本地持久化快照
src/authoritative-server.ts  唯一 GameStore、HTTP MCP 与 Web 服务启动器
src/mcp-server.ts    MCP 工具注册与无状态 STDIO 代理
src/web-server.ts    只读观战 API/静态服务路由
public/              响应式观战页面
tests/               规则自动化测试
scripts/             MCP 烟测与演示局生成器
```

## 当前边界

- 已完成规则引擎、MCP、持久化、日志与只读观战 UI；
- 暂未做真人点击行动面板；真人仍可通过 MCP 客户端或后续 UI 适配器控制席位；
- 已持久化足够的单局玩家统计，用于后续汇总胜率、库存残留与成就表现；当前未实现跨局排行榜；
- 当前默认只绑定本机回环地址；要供远程 ChatGPT 使用，需要另行配置受控 HTTPS 暴露或 Secure MCP Tunnel，但仍必须指向同一个权威进程。
