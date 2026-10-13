# 私人云端部署与接入

本项目采用“每位部署者运营自己的副本”的方式。你可以分享仓库链接；这不会让别人使用你的服务器。作者不代管第三方账号、承担第三方账单或保证公共服务。

## 初次部署

需要 Node.js 24+、pnpm 11、Git 和自己的 Cloudflare 账号。

```sh
git clone https://github.com/RRRachel000/night-port-mcp-game.git
cd night-port-mcp-game
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm cloud:setup --name=my-night-port --origin=https://my-night-port.YOUR-SUBDOMAIN.workers.dev
pnpm cloud:deploy
```

`YOUR-SUBDOMAIN` 是自己账号的 Workers 子域，可在 Cloudflare 控制台 Workers & Pages 查看。`--name` 与地址中的 Worker 名须相同。

`cloud:setup` 首次创建一个 KV 命名空间，生成 `.local/cloud/wrangler.jsonc` 和私人凭据，将管理员及观战口令的 SHA-256 写入 Worker Secrets。再次执行会沿用配置及凭据。`cloud:deploy` 上传程序，游戏数据保留在一个 SQLite Durable Object 中，后续部署不会重新创建对局。

`cloud/wrangler.jsonc` 是公开模板，`.local/cloud/wrangler.jsonc` 才是自己的实际配置。不要直接部署包含占位 KV ID 的模板。

使用 Workers、SQLite Durable Objects 和 Workers KV 的配额与费用取决于自己的账户，部署前查看 [官方定价](https://developers.cloudflare.com/workers/platform/pricing/) 和 [Durable Objects 说明](https://developers.cloudflare.com/durable-objects/)。项目不会自动升级套餐。AI 客户端及模型由玩家自行提供，没有内置付费模型调用。

## 创建一局

```sh
pnpm cloud:admin new-match --game unique-game-id --a AI-A --b AI-B --c AI-C
```

脚本配置三个 AI 席位，不替玩家作游戏决定。每局使用新的 game ID。中断后 `.local/cloud/matches/<gameId>.json` 标记 `creating` 的初始化可继续；若绑定请求丢失响应，应先检查管理员状态，不要盲目接任或创建同名房间。

- `.local/cloud/seats/<gameId>/a.json` 是 A 的连接；B、C 同理。每份只交给对应的一个玩家。
- `.local/cloud/matches/<gameId>.json` 是包含全部席位的管理恢复材料，不能交给某一玩家。
- `.local/cloud/viewer-connection.txt` 是私人观战口令。
- `.local/cloud/credentials.json` 含管理员凭据，不可交给玩家。

## 连接三个独立席位

### 通用远程 MCP 客户端

每个玩家从自己的 JSON 读取 `mcpUrl` 和 `bearerToken`，将地址作为 Streamable HTTP 端点，并配置 `Authorization: Bearer <自己的 bearerToken>`。连接文件就是私人能力凭据。

只把一个席位交给一个独立客户端。让 AI 读取 `my_state`，按当前任务行动即可。服务不会主动唤醒 AI 或向聊天发消息；可手动让各席位轮流行动，或使用自己客户端的调度功能。

### 支持 OAuth 的客户端

添加自己实例的 `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp`，选择 OAuth。在同域授权页输入自己席位 JSON 中的 `bearerToken`。范围是读取与操作一个席位。

每个独立玩家账户应授权自己的席位。同一账户在多个聊天中使用同一插件，可能共享同一身份，不能据此认为三个玩家已经隔离。

OAuth access token 有效期一小时，支持 refresh token。席位接任后旧 key 失效，旧 OAuth grant 也无法继续访问该席位。客户端名称是其自行声明的；核对回调域，口令只应输入自己部署的站点。

### 本机代理和 CLI

不支持远程 HTTP 配置时，从仓库启动无状态 STDIO 代理，并设置 `NIGHT_PORT_CONNECTION_FILE` 为自己的绝对 JSON 路径：

```sh
node --import tsx src/mcp-server.ts
```

代理转发到云端，不持有可写存档。也可以直接使用玩家 CLI：

```sh
pnpm exec tsx scripts/window-player.ts state --connection-file /absolute/path/a.json
pnpm exec tsx scripts/window-player.ts submit --connection-file /absolute/path/a.json --action-file /absolute/path/action.json
```

决定格式：

```json
{"actionId":"来自 my_state.task 的 UUID","expectedStateVersion":7,"action":{"type":"take_turn","marketPositions":[]}}
```

每次先读 `my_state`，确认任务属于自己且未暂停。不要从聊天历史猜版本或替下一席位行动。网络不确定时可完全相同地重试；不同决定须重新读取当前任务。

## 观战

打开 Worker 首页，用 `viewer-connection.txt` 中的口令登录。它只能看公开内容，不能操作玩家或导出私有快照。网页显示本实例的对局；登录 cookie 一天后失效。

## 备份与管理

```sh
pnpm cloud:admin status
pnpm cloud:admin export --out .local/cloud/my-backup.json
pnpm cloud:admin import --file .local/cloud/my-backup.json
```

导出包含玩家令牌、隐藏成就和调度记录，须按凭据保管。一个导入批次在事务内完成；相同快照可以重试，不覆盖已有不同内容的同名对局。跨实例恢复前暂停原实例写入，避免两个裁判裁定同一局。

原 referee CLI 可通过环境变量 `NIGHT_PORT_AUTHORITY_URL=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev` 使用云端，operator key 必须与部署一致。通知玩家的主控仍由自己的客户端运行。

## 迁移本机存档

1. 停止本机裁判及自动重启器，备份 `data/games/` 和 `.local/players/`。
2. 将完整快照打包为 `{"schemaVersion":1,"games":[完整快照...]}`，通过管理员 import 上传到自己的云端。
3. export 回读并逐份比对全部内容，再把席位连接改为云端 `/mcp/seat` 和原 key。不要重新 bind 已有席位；bind 会旋转凭据并推进版本。
4. 创建 `.local/cloud/cutover.json`，内容为 `{"dataDirectory":"原数据目录的绝对路径"}`。本机启动器将拒绝写这个已迁移目录。旧源文件作为回退材料保留。

退回本机时，先暂停云端写入，导出最新快照，验证并恢复到本机。确认没有云端写入方后，才移除 cutover 标记并启动本机。旧备份只代表迁移时刻，不能覆盖后续行动。

## 更新与退出

保留 `.local/`，更新代码、运行测试，再 `pnpm cloud:deploy`。停止使用前先导出备份，再通过自己的 Cloudflare 控制台管理相关资源。是否维护、何时更新由部署者决定，没有强制订阅或服务承诺。
