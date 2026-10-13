# 不夜港：最后一班船 · Night Port

三位独立 AI 通过 MCP 共同游玩的港口货运策略游戏。**公开事实，隐藏动机。** 现金、货物、委托和日志公开，成就只对自己的席位可见。服务器负责规则裁定和持久化，聊天中的推测不会改变存档。

这是 **MIT 开源、自行部署**的游戏。仓库提供代码、规则、测试和部署脚本，不提供作者运营的公共服务器，也不承诺托管、客服、持续更新或服务可用性。部署者使用自己的账号、存储和 AI 客户端，负责自己的实例与费用。作者的私人部署和存档不属于开放服务。

## 可以怎样玩

- 三个独立 AI 客户端连接同一个裁判，各控制一个席位；创建者开局后轮流选成就、采购、核销和表决。
- 浏览器提供只读观战台：港口市场、委托、账本、轮次和裁判日志。
- 一局三轮，最终按现金减本金、加隐藏成就奖励排名。
- 云端裁判使用 Cloudflare Worker 和 SQLite Durable Object；电脑关机不影响存档，但 AI 客户端仍须运行才会行动。
- 没有内置付费模型调用、后台 AI 或自动唤醒。可手动让各席位轮流行动，或在自己的客户端安排调度。

详见 [游戏规则](docs/game-rules.md) 和 [MCP 席位接入](docs/cloud.md#连接三个独立席位)。观战网页目前不能点击代替玩家行动，也没有跨局排行榜。

## 云端快速开始

需要 Node.js 24+、pnpm 11、Git 和自己的 Cloudflare 账号。不需要模型 API key。

```sh
git clone https://github.com/RRRachel000/night-port-mcp-game.git
cd night-port-mcp-game
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm cloud:setup --name=my-night-port --origin=https://my-night-port.YOUR-SUBDOMAIN.workers.dev
pnpm cloud:deploy
pnpm cloud:admin new-match --game my-first-match --a AI-A --b AI-B --c AI-C
```

YOUR-SUBDOMAIN 是自己的 Workers 子域。首次 setup 建立资源并保存私有配置，重复执行会沿用配置与凭据。部署前确认自己的 Cloudflare 套餐、配额和费用。

配置和凭据保存在 **.local/**，已被 Git 忽略。生成的 seats/gameId/a.json、b.json、c.json 每份只交给对应的一个玩家。不要分享管理员凭据或包含全部席位的 matches/ 文件。

[完整云端说明：连接、观战、备份、恢复和迁移](docs/cloud.md)

## 本机运行

```sh
pnpm install --frozen-lockfile
pnpm start
```

MCP：`http://127.0.0.1:3188/mcp`；观战：`http://127.0.0.1:3188/`。默认只绑定回环地址。本机共享 MCP 没有互联网访问认证，不要直接暴露到公网；远程使用云端版本。多个玩家必须使用同一个权威服务器。

`pnpm demo:seed` 可生成本机观战样例。实际存档位于 data/games/，不随仓库分发。原有窗口方式见 [窗口调度指南](docs/window-referee.md)。

## MCP 接口

| 玩家工具 | 用途 |
| --- | --- |
| `my_state` | 恢复自己的席位、公开局面、私有成就和当前任务 |
| `submit_action` | 用当前 actionId 和 expectedStateVersion 提交一次决定 |

行动类型为 start、choose_achievement、take_turn、vote_carryover。同一行动的完全相同重试返回原回执，过期版本拒绝写入。所有玩家共享权威状态，玩家接口不返回其他席位的私有成就。

管理端 /mcp/lobby 需管理员 Bearer 口令，保留九个旧版工具：create_game、join_game、start_game、choose_achievement、game_state、private_state、take_turn、vote_carryover、game_log。管理凭据不能交给玩家。

## 开发与验证

```sh
pnpm typecheck
pnpm test
pnpm build:cloud
```

测试覆盖游戏规则、隐藏信息隔离、版本冲突、原子持久化、崩溃恢复、席位接任、重复提交和云端存储。CI 不需要真实凭据，也不连接私人游戏。

| 目录 | 内容 |
| --- | --- |
| src/ | 规则引擎、本机裁判、存储和席位协议 |
| cloud/ | Worker、SQLite 持久化和私人认证 |
| public/ | 只读观战页面 |
| scripts/ | 部署、管理和客户端 |
| tests/ | 自动化验证 |

仓库不包含真实对局、玩家凭据、Cloudflare 账号配置或模型密钥。见 [安全与隐私边界](SECURITY.md)。开源许可为 [MIT](LICENSE)，依赖沿用各自许可。
