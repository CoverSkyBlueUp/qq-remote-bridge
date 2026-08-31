# QQ 开放平台机器人 API 速查（实战验证）

> 本文件基于 qq-remote-bridge 实际接入过程中验证过的接口与协议整理。
> 一手文档：https://bot.qq.com/wiki/develop/api-v2/

## 0. 从零接入（获取 appId / clientSecret / user_openid）

**Step 1 — 创建机器人，拿 appId 与 clientSecret**
1. 登录 [QQ 开放平台管理端](https://q.qq.com/) → 「机器人」→「创建机器人」（或进入已有机器人）
2. 在「开发设置」页面找到 **AppID**（数字）与 **AppSecret**（保密字符串）
3. 记下这两个值，即 `appId` / `clientSecret`。AppSecret 请妥善保管，勿写入公开文档。

**Step 2 — 获取你的 user_openid**
1. 把机器人添加到你的 QQ（单聊私聊；若是群机器人则拉进群）
2. 用你的 QQ 给机器人**私聊任意一条消息**（如「1」）
3. 此时机器人会通过 WebSocket 收到一条 `C2C_MESSAGE_CREATE` 事件，事件里 `d.author.user_openid` **就是你的 `user_openid`**（一个 32 位十六进制字符串）
4. 把该 openid 填入配置的 `authorizedOpenids`（只有这个 openid 的指令才会被执行）

> 提示：也可用本 skill 的 daemon 以 `intents=33554432` 订阅该事件，或临时用任意 WebSocket 客户端连接网关并打印收到的事件来读取 `user_openid`。

**Step 3 — 可选：配置 IP 白名单**
- `getAppAccessToken` 无 IP 限制；但**数据接口**（`/users/@me`、发消息等）默认要求来源 IP 在白名单。若不配置，会报 `11298 接口访问源IP不在白名单`
- 处理方式二选一：到后台「开发设置 → IP 白名单」添加你的出口公网 IP；或直接移除白名单设置（默认空即不限制，实测可用）

## 1. 获取访问令牌

```
POST https://bots.qq.com/app/getAppAccessToken
Content-Type: application/json

{"appId":"<APPID>","clientSecret":"<SECRET>"}
```

响应（HTTP 200）：
```json
{"access_token":"...","expires_in":"7200"}
```

要点：
- token 生命周期 7200s；到期前 60s 内重新请求会拿到新 token，旧 token 60s 内仍有效
- **令牌接口无 IP 白名单限制**（实测可从任意出口调用）
- 注意：官方 API 调用指南页的 URL 写 `https://api.bot.qq.com/app/getAppAccessToken`，但实测 `bots.qq.com` 亦可（本 skill 用 `bots.qq.com`）

## 2. 数据接口鉴权

统一基础域名：`https://api.bot.qq.com`（旧文档也出现过 `api.sgroup.qq.com`，二者都通）

**请求头**：`Authorization: QQBot <access_token>`（不是 `Bot appid.token`！）

验证接口：`GET /users/@me` → 200 返回机器人 id/username/bot 标识。

## 3. WebSocket 事件接入

- 网关地址：`GET /gateway` → `{"url":"wss://api.sgroup.qq.com/websocket"}`
- 建连后首帧：`op:10 Hello {"d":{"heartbeat_interval":41250}}`
- 发 `op:2 Identify`：
```json
{"op":2,"d":{"token":"QQBot <access_token>","intents":33554432,"shard":[0,1],"properties":{"$os":"windows","$browser":"x","$device":"x"}}}
```
- 成功后收到 `op:0 t:"READY"`（含 session_id、user.id、user.username、shard）
- 心跳：按 heartbeat_interval 周期发 `{"op":1,"d":<最新s>}`，服务端回 `op:11`

### intents 位（按需订阅）
| 位 | 值 | 事件 |
|----|-----|------|
| GUILDS | 1 | 频道基础事件 |
| GUILD_MEMBERS | 2 | 频道成员 |
| GUILD_MESSAGES | 512 (1<<9) | 私域频道消息 |
| GUILD_MESSAGE_REACTIONS | 1024 (1<<10) | 频道消息表情 |
| DIRECT_MESSAGE | 4096 (1<<12) | 频道私信 |
| **GROUP_AND_C2C_EVENT** | **33554432 (1<<25)** | `C2C_MESSAGE_CREATE`（单聊）、`GROUP_AT_MESSAGE_CREATE`（群@）、`GROUP_MSG_RECEIVE` |
| INTERACTION | 67108864 (1<<26) | 互动事件 |
| MESSAGE_AUDIT | 134217728 (1<<27) | 消息审核 |
| FORUMS_EVENT | 268435456 (1<<28) | 论坛事件（私域） |
| AUDIO_ACTION | 536870912 (1<<29) | 音频 |
| PUBLIC_GUILD_MESSAGES | 1073741824 (1<<30) | 公域频道消息 |

### C2C_MESSAGE_CREATE 事件结构（单聊消息）
```json
{"op":0,"s":2,"t":"C2C_MESSAGE_CREATE","d":{
  "author":{"bot":false,"id":"<USER_OPENID>","union_openid":"","user_openid":"<USER_OPENID>","username":""},
  "content":"1",
  "id":"ROBOT1.0_xxxxxxxx...!",
  "message_scene":{"ext":["msg_idx=REFIDX_..."],"source":"default"},
  "message_type":0,
  "timestamp":"2026-08-31T17:56:05+08:00"
}}
```
关键字段：`d.author.user_openid`（回复目标）、`d.id`（被动回复 msg_id）、`d.content`（指令内容）。

## 4. 发送消息

### 单聊消息（C2C / 私聊）
```
POST /v2/users/{user_openid}/messages
Authorization: QQBot <token>

{"msg_type":0,"content":"你好，世界","msg_id":"ROBOT1.0_...","msg_seq":1}
```
- `msg_type`：0=文本(content)、2=Markdown(markdown)、6=输入中(input_notify)、7=富媒体(media)
- 被动回复必须携带事件里的 `msg_id`（单聊有效期 60 分钟，每消息最多回 4 次；群聊 5 分钟 5 次）
- `msg_seq` 递增可避免相同 msg_id 重复回复被去重
- 主动消息不带 msg_id（但受频控与用户「允许主动发送」开关约束）
- 成功响应：`{"id":"ROBOT1.0_...","timestamp":"...","ext_info":{"ref_idx":"REFIDX_..."}}`

### 群聊消息
```
POST /v2/groups/{group_openid}/messages
```
参数同单聊；群被动有效期 5 分钟、5 次。

### 撤回
- 单聊：`DELETE /v2/users/{user_openid}/messages/{message_id}`
- 群聊：`DELETE /v2/groups/{group_openid}/messages/{message_id}`
- 发送超 2 分钟不可撤回

## 5. 常见错误码

| 码 | 含义 | 处理 |
|----|------|------|
| 11243 | Token 错误 | 检查鉴权头格式是否为 `QQBot <token>` |
| 11298 | 接口访问源 IP 不在白名单 | 后台移除/加白该出口 IP（或改用已授权出口） |
| 11001 | 不支持的调用 | 该能力未开通（如群机器人调频道接口） |
| 40034101 / 40054003 | 机器人非群成员 | 先把机器人拉进群 |
| 40054004 | 无好友关系 | 单聊主动消息需先加好友 |
| 40054013 | 用户拒收主动消息 | 用户关闭了「允许主动发送」 |
| 40034006 | 消息内容违规 | 修改内容 |
| 40054005 | 消息被去重 | 递增 msg_seq |
| 40034100 | 主动消息超频控 | 降频等待配额 |
| 40054016 | 机器人已下线 | 检查机器人状态 |

## 6. 本机实测记录（2026-08-31）

- 取 token：`bots.qq.com` 200 OK
- `/users/@me`：`api.bot.qq.com` 200，`{"id":"1833684139695563459","username":"远程操控电脑","bot":true}`
- `/gateway`：`wss://api.sgroup.qq.com/websocket`
- WS 链路：OPEN → HELLO(41250) → Identify(intents=33554432) → READY
- 收 `C2C_MESSAGE_CREATE`（content="1"）→ 被动回复「你好，世界」HTTP 200
- 常驻 daemon 收到 `help` → 执行 powershell → 回复 HTTP 200
- 自然语言（如「帮我看看 D:\... 目录下有哪些文件」）→ headless 会话处理 → 结论回推 HTTP 200

## 7. 中文编码排障（重要）

**症状**：白名单命令（`ipconfig`、`systeminfo` 等原生 exe）的输出中文乱码（`��̫��`）。

**根因**：中文 Windows 上原生命令向 stdout 输出 **GBK(cp936) 字节**；`execFile(..., {encoding:"utf8"})` 按 UTF-8 解码导致乱码。PowerShell 的 `[Console]::OutputEncoding=UTF8` **不能转换原生程序直写管道的字节流**，无效。

**修复（daemon 已采用）**：`execFile` 用 `encoding:"buffer"` 收集原始字节 → `decodeAuto()`：先按 UTF-8 严格解码，若含 `\uFFFD` 替换符则用 `new TextDecoder("gbk")` 回退解码。已验证：
- GBK 字节 → 正确还原中文
- UTF-8 字节 → 原样通过
- Node 24 的 `TextDecoder("gbk")` 需 ICU 支持（本机 OK）

**教训**：daemon 内部日志写 UTF-8 文件，用 **Node 以 UTF-8 读取**才见真面目；pwsh 的 `Get-Content` 默认按 GBK 读 UTF-8 文件，会显示乱码造成误判（曾误以为是 WS 解码问题）。
